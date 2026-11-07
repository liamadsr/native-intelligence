/**
 * Idle-time compaction for chat-agent conversations
 * (docs/plans/always-on-agent.md §2, "summarize while you're away").
 *
 * The chat's turn-boundary compaction. Inside a turn, eve compacts only past
 * its in-turn threshold (agents/chat-agent/lib/compaction-window.ts
 * CHAT_MIDTURN_COMPACTION_TOKENS, 225K), so a working turn is rarely stopped
 * to summarize. Between turns, once a conversation whose last model call was
 * at least the chat's target (IDLE_COMPACTION_MIN_INPUT_TOKENS, 150K: the
 * agent's CHAT_COMPACTION_TARGET_TOKENS) has been quiet for
 * IDLE_COMPACTION_QUIET_MS (3 minutes: the person is reading, the provider's
 * prompt cache is still warm), the server asks eve to compact it, so the next
 * message starts from a short summary.
 *
 * Why 3 minutes, not the 10 it was (2026-10-15 PROD audit): a working
 * conversation's turns were a few minutes apart, so a 10-minute quiet never
 * came until the person left, and its calls ran at ~185K each until then. A
 * compaction takes well under a minute, and a send that arrives during one
 * waits behind it; eve compacting at the start of that turn instead would
 * make the send wait every time.
 *
 * The Inngest function (src/lib/inngest/chat-idle-compaction.ts) runs two
 * steps:
 *   1. checkIdleCompaction (database only, cheapest first): a chat_conversations
 *      row with a registered eve session, not a capture's; its person still a
 *      member of the workspace; the latest billed turn of that session
 *      (ai_usage_logs, feature 'ai_chat') big enough and not followed by a
 *      manual compaction row; no background work about to wake the agent
 *      there (backgroundWorkWaking: then the timer is re-armed); the person
 *      within their usage limits.
 *   2. compactIdleSession (eve): as the chat-agent channel's server principal
 *      (the chat internal secret plus a run token minted here for the
 *      conversation; agents/chat-agent/lib/auth.ts serverCompactionAuth, which
 *      admits only the stream read and `compact` on the session registered to
 *      that conversation), read the session's recent events, re-check from
 *      eve's own record (no open turn, quiet long enough, the last model
 *      call's input big enough, no compaction since), re-check that nothing
 *      arrived since (no newer billed row, no new stream event), then
 *      `compact()` and watch the outcome briefly (only to log it).
 * A run that finds a turn running, recent activity or no events looks once
 * more IDLE_COMPACTION_RECHECK_DELAY later, then stops (the Inngest function).
 * No user credential is stored anywhere: the activity event carries ids only.
 *
 * eve can't cancel a queued compaction: someone who sends while one runs
 * (about a minute) waits behind it. The pre-compact re-check keeps that
 * window as small as it can; a typing ping isn't visible to it (it lives only
 * in the debounce).
 *
 * ── Context size ────────────────────────────────────────────────────────────
 * ai_usage_logs keeps a turn's input SUMMED over its steps, which is at least
 * the largest step's input: a cheap upper bound that rules out small chats
 * with no eve call. A turn row also carries its last step's input
 * (`context_last_step_input_tokens`, chat-usage-meter.ts): when present, step
 * 1 judges by that instead (a 3-step turn at 60K sums to 180K but is no
 * compaction). The authoritative size is still the last `step.completed`
 * usage inputTokens in the session stream (cached input included): the
 * context the next turn starts from, re-checked in step 2.
 *
 * ── Billing ─────────────────────────────────────────────────────────────────
 * A manual compaction is billed by the chat-agent's usage meter
 * (agents/chat-agent/hooks/usage-meter.ts, `compaction=manual`). eve 0.66.3's
 * compact command carries no caller, so the meter bills under the session's
 * last turn's run token (expiry ignored for attribution), else the session's
 * owner: either way the conversation's own user and workspace, which the
 * channel checked against this run token (decision 8).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { Client, ClientError } from 'eve/client'
import type { ClientSession, MessageStreamEvent } from 'eve/client'
import { checkUsageLimits } from '@/lib/ai/auth'
import {
  CHAT_RUN_SECRET_HEADER,
  CHAT_RUN_TOKEN_HEADER,
  internalSecret,
  mintChatRunToken,
  type ChatRunTokenClaims,
} from '@/lib/chat/chat-run-token'
import { CHAT_USAGE_FEATURE } from '@/lib/chat/chat-usage-meter'
import { eveDispatchOrigin, protectionBypassHeaders } from '@/lib/eve/dispatch-origin'
import { isAreaKey } from '@/lib/packs/registry'
import type { ChatSessionActivityData } from '@/lib/chat/idle-compaction-signal'
import { TEAMMATE_REPORT_KIND } from '@/lib/chat/teammate-report'

/** Quiet this long before compacting: the turn is over and the person is reading; the provider's prompt cache is still warm. */
export const IDLE_COMPACTION_QUIET_MS = 3 * 60_000
/**
 * Compact only a context at least this big (the last model call's input):
 * below it the history is cheap to resend. Mirrors the chat-agent's
 * CHAT_COMPACTION_TARGET_TOKENS (agents/chat-agent/lib/compaction-window.ts;
 * its test pins the pair).
 */
export const IDLE_COMPACTION_MIN_INPUT_TOKENS = 150_000
/** The Inngest debounce period, the same quiet time. */
export const IDLE_COMPACTION_DEBOUNCE_PERIOD = `${IDLE_COMPACTION_QUIET_MS / 60_000}m`
/** Clock slack between the routes, Inngest and eve when re-checking the quiet time. */
export const IDLE_COMPACTION_CLOCK_SLACK_MS = 30_000
/** The server-minted run token only needs to cover the compaction. */
export const IDLE_COMPACTION_TOKEN_TTL_MS = 15 * 60_000
/** Recent session events read for the checks: the last turn's end is always inside it. */
export const IDLE_COMPACTION_TAIL_EVENTS = 200
/**
 * The wait for the tail read's first event: the stream's open (fetch, the
 * channel's auth, eve's attach and its storage replay) on an agent nothing
 * has touched for a few minutes.
 */
export const IDLE_COMPACTION_FIRST_EVENT_MS = 10_000
/** After the first event, a pause this long in the tail read means the durable tail was reached. */
export const IDLE_COMPACTION_TAIL_IDLE_MS = 1500
/** A tail read still streaming this long after its first event is a turn in progress. */
export const IDLE_COMPACTION_TAIL_MAX_MS = 15_000
/** Right before `compact()`, how long a new stream event (a send arriving) is waited for. */
export const IDLE_COMPACTION_RECHECK_MS = 250
/** How long to watch for the compaction's outcome: only to log it, so short (unseen: `requested`). */
export const IDLE_COMPACTION_WATCH_MS = 40_000
/** A run stopped by a running turn, recent activity or no events looks once more after this. */
export const IDLE_COMPACTION_RECHECK_DELAY = '5m'
/**
 * A compaction requested longer ago than this with no end in the window is
 * one a retired run left open, not one running (the transport's
 * COMPACTION_WAIT_MS): it no longer stops a new one.
 */
export const IDLE_COMPACTION_PENDING_MAX_MS = 5 * 60_000

/** The chat-agent's eve mount (next.config.mjs), as bot-relay.ts calls it. */
const CHAT_AGENT_MOUNT = '/eve/chat-agent'

/** The same set bot-relay.ts treats as the end of a turn. */
const TURN_BOUNDARIES: ReadonlySet<string> = new Set([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.waiting',
  'session.completed',
  'session.failed',
])

/** Why a run stopped before asking eve (step 1) or without compacting (step 2). */
export type IdleCompactionSkip =
  | 'bad_event'
  | 'no_conversation'
  /** A capture's conversation (`capture_id`): a meeting's own chat is never idle-compacted (or billed for it). */
  | 'capture_conversation'
  | 'guest_conversation'
  | 'no_session'
  /** The person is no longer a member of the conversation's workspace. */
  | 'not_member'
  | 'no_usage'
  | 'small_context'
  | 'already_compacted'
  | 'usage_limited'
  | 'usage_check_failed'
  /**
   * Background work is about to wake the agent here (a home turn claimed or
   * sending, a report waiting for one, a background helper running): its turn
   * would undo the compaction's saving, so the timer is re-armed instead
   * (the Inngest function sends a fresh activity signal).
   */
  | 'background_waking'
  | 'lookup_failed'
  | 'turn_running'
  /**
   * A compaction is already running on the session (a `compaction.requested`
   * with no end after it, younger than IDLE_COMPACTION_PENDING_MAX_MS): eve
   * would queue this one behind it and summarize the summary, billed again.
   */
  | 'compacting'
  | 'recent_activity'
  /** The tail read saw no event at all (a slow open, or an empty window): not proof of a turn. */
  | 'no_events'
  | 'no_recent_step'

/** How a compaction request ended. */
export type IdleCompactionResult =
  /** compaction.completed, then session.waiting: the next message starts from the summary. */
  | 'compacted'
  /** session.waiting with no checkpoint: summarization failed or had nothing to do, eve kept the history. */
  | 'kept_history'
  /** A turn started first: eve runs the compaction when that turn settles. */
  | 'queued_behind_turn'
  /** Accepted, but no outcome seen within IDLE_COMPACTION_WATCH_MS (or the stream ended). */
  | 'requested'
  /** eve: the session is no longer active. */
  | 'session_inactive'
  /** No chat internal secret here, or the channel refused it (401): the app and the agent disagree. */
  | 'server_auth_failed'
  /** The channel refused the route, the run token or the session's ownership (403). */
  | 'forbidden'
  | 'error'

export type IdleCompactionOutcome = IdleCompactionSkip | IdleCompactionResult

/** Step 2 outcomes that may clear up soon: looked at once more, IDLE_COMPACTION_RECHECK_DELAY later. */
export const IDLE_COMPACTION_RECHECK_OUTCOMES: ReadonlySet<IdleCompactionOutcome> = new Set([
  'turn_running',
  'recent_activity',
  'no_events',
])

/** The conversation's routing facts, as a run token carries them. */
export type IdleCompactionClaims = Pick<
  ChatRunTokenClaims,
  'conversationId' | 'workspaceId' | 'userId' | 'teammateId' | 'focusArea'
>

export type IdleCompactionCheck =
  | {
      ok: true
      sessionId: string
      claims: IdleCompactionClaims
      /** The size step 1 judged by: the latest row's last-step input when it carries one, else its summed input. */
      billedInputTokens: number
      /** The latest billed row's time: anything newer before `compact()` is someone back. */
      latestUsageAt: string | null
    }
  | { ok: false; reason: IdleCompactionSkip; sessionId?: string; billedInputTokens?: number }

/** Parse the activity event (the last one the debounce kept). Null when malformed. */
export function parseActivityData(raw: unknown): ChatSessionActivityData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
  if (!id(d.conversationId) || !id(d.workspaceId) || !id(d.userId)) return null
  return {
    conversationId: d.conversationId,
    workspaceId: d.workspaceId,
    userId: d.userId,
    source: d.source === 'mint' || d.source === 'typing' ? d.source : 'turn',
  }
}

interface ConversationRow {
  id: string
  eve_session_id: string | null
  capture_id: string | null
  ai_team_member_id: string | null
  focus_area: string | null
  /** Migration 427: a guest's thread (guest access). */
  agent_guest_id?: string | null
}

/**
 * Step 1, database only. Every chat-agent conversation qualifies: the main
 * chat (focused or not) and a bot's own thread; each is one chat_conversations row with one eve
 * session, owned by one person. A device ask never signals (its row is
 * deleted when the ask ends). A capture's conversation is not idle-compacted.
 * Never throws: a failed read is `lookup_failed`.
 */
export async function checkIdleCompaction(
  supabase: SupabaseClient,
  data: ChatSessionActivityData,
): Promise<IdleCompactionCheck> {
  try {
    const { data: conv, error } = await supabase
      .from('chat_conversations')
      .select('id, eve_session_id, capture_id, ai_team_member_id, focus_area, agent_guest_id')
      .eq('id', data.conversationId)
      .eq('user_id', data.userId)
      .eq('workspace_id', data.workspaceId)
      .maybeSingle<ConversationRow>()
    if (error) return { ok: false, reason: 'lookup_failed' }
    if (!conv) return { ok: false, reason: 'no_conversation' }
    if (conv.capture_id) return { ok: false, reason: 'capture_conversation' }
    // A guest's thread (guest access): compacting it would run the owner's
    // spec over the guest's session. Its turns are short texts anyway.
    if (conv.agent_guest_id) return { ok: false, reason: 'guest_conversation' }
    const sessionId = conv.eve_session_id
    if (!sessionId) return { ok: false, reason: 'no_session' }

    // Still a member now: someone removed since their last turn is never compacted (or billed).
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', data.userId)
      .eq('workspace_id', data.workspaceId)
      .maybeSingle<{ id: string }>()
    if (memberError) return { ok: false, reason: 'lookup_failed', sessionId }
    if (!member) return { ok: false, reason: 'not_member', sessionId }

    const latest = await latestUsageRow(supabase, data.userId, sessionId)
    if (latest === 'error') return { ok: false, reason: 'lookup_failed', sessionId }
    if (!latest) return { ok: false, reason: 'no_usage', sessionId }
    if (latest.metadata?.compaction === true) return { ok: false, reason: 'already_compacted', sessionId }
    const billedInputTokens = contextSizeOf(latest)
    if (billedInputTokens < IDLE_COMPACTION_MIN_INPUT_TOKENS) {
      return { ok: false, reason: 'small_context', sessionId, billedInputTokens }
    }

    // Background work about to wake the agent here: compacting now would be
    // paid for and then undone by its turn. Re-armed instead (the function).
    const waking = await backgroundWorkWaking(supabase, data)
    if (waking === 'error') return { ok: false, reason: 'lookup_failed', sessionId, billedInputTokens }
    if (waking) return { ok: false, reason: 'background_waking', sessionId, billedInputTokens }

    // Compaction is billed to the person (decision 8): never past their limits.
    try {
      await checkUsageLimits(data.userId)
    } catch (err) {
      const reason = err instanceof Response && err.status === 429 ? 'usage_limited' : 'usage_check_failed'
      return { ok: false, reason, sessionId, billedInputTokens }
    }

    return { ok: true, sessionId, claims: claimsFor(data, conv), billedInputTokens, latestUsageAt: latest.created_at ?? null }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

interface UsageRow {
  input_tokens: number | null
  metadata: Record<string, unknown> | null
  created_at: string | null
}

/**
 * A usage row's context size for the step-1 check: its last step's input when
 * the row records one (a turn row from a meter that measures it), else the
 * input summed over its steps (an upper bound).
 */
export function contextSizeOf(row: Pick<UsageRow, 'input_tokens' | 'metadata'>): number {
  const last = row.metadata?.context_last_step_input_tokens
  if (typeof last === 'number' && Number.isFinite(last) && last > 0) return Math.floor(last)
  return Number(row.input_tokens) || 0
}

/** The session's latest billed row: a turn, or a manual compaction after it. */
async function latestUsageRow(supabase: SupabaseClient, userId: string, sessionId: string): Promise<UsageRow | null | 'error'> {
  const { data: rows, error } = await supabase
    .from('ai_usage_logs')
    .select('input_tokens, metadata, created_at')
    .eq('user_id', userId)
    .eq('feature', CHAT_USAGE_FEATURE)
    .eq('metadata->>eve_session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return 'error'
  return (rows as UsageRow[] | null)?.[0] ?? null
}

/**
 * The pre-compact presence re-check: still quiet when the session's latest
 * billed row is the one step 1 saw (a newer one is a turn that ended since).
 * False on any failed read: when unsure, don't compact.
 */
export async function idleCompactionStillQuiet(
  supabase: SupabaseClient,
  args: { userId: string; sessionId: string; latestUsageAt: string | null },
): Promise<boolean> {
  try {
    const usage = await latestUsageRow(supabase, args.userId, args.sessionId)
    if (usage === 'error') return false
    return (usage?.created_at ?? null) === args.latestUsageAt
  } catch {
    return false
  }
}

/** The run-token claims a turn in this conversation is minted with (eve-session/route.ts mintResponse). */
export function claimsFor(
  data: Pick<ChatSessionActivityData, 'conversationId' | 'workspaceId' | 'userId'>,
  conv: Pick<ConversationRow, 'ai_team_member_id' | 'focus_area'>,
): IdleCompactionClaims {
  const base = { conversationId: data.conversationId, workspaceId: data.workspaceId, userId: data.userId }
  if (conv.ai_team_member_id) return { ...base, teammateId: conv.ai_team_member_id }
  return isAreaKey(conv.focus_area) ? { ...base, focusArea: conv.focus_area } : base
}

/**
 * A home turn claimed or sending counts as waking while a step touched it
 * this recently (home-turn-server.ts HOME_TURN_RESUME_AFTER_MS: a staler one
 * belongs to a run that died).
 */
export const WAKING_HOME_TURN_FRESH_MS = 360_000
/**
 * A helper's report this recent that no home turn carried yet is waiting in
 * the home turn's debounce (90 s, at most HOME_TURN_DEBOUNCE_TIMEOUT 10 min),
 * plus slack.
 */
export const WAKING_REPORT_WINDOW_MS = 12 * 60_000
/** A background helper counts as running only this long after it was queued (a work run's cap is an hour). */
export const WAKING_HELPER_MAX_AGE_MS = 2 * 60 * 60_000

/** What background work is about to wake the agent in this conversation. */
export type BackgroundWaking = 'home_turn_running' | 'home_turn_pending' | 'helper_running'

/**
 * Whether background work is about to wake the agent in this conversation
 * (plan §2: "skipped when background work is about to wake the agent
 * anyway"), cheapest first:
 *   - a home turn claimed or sent, touched within WAKING_HOME_TURN_FRESH_MS;
 *   - a helper's report (a teammate-report message) from the last
 *     WAKING_REPORT_WINDOW_MS that no home turn row carried yet: its home
 *     turn is pending in the debounce;
 *   - a background helper of this conversation queued or running
 *     (agent_run, origin 'chat'), queued within WAKING_HELPER_MAX_AGE_MS.
 *     One waiting on the person (`needs_input`) wakes nothing on its own.
 * Each bound keeps a stuck row from holding compaction off for good.
 * 'error' on a failed read (when unsure, don't compact).
 */
export async function backgroundWorkWaking(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; workspaceId: string },
  now: number = Date.now(),
): Promise<BackgroundWaking | null | 'error'> {
  try {
    const turns = await supabase
      .from('home_turn')
      .select('status, report_message_ids, updated_at')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .gte('updated_at', new Date(now - WAKING_REPORT_WINDOW_MS - WAKING_HOME_TURN_FRESH_MS).toISOString())
      .order('updated_at', { ascending: false })
      .limit(50)
    if (turns.error) return 'error'
    const turnRows = (turns.data ?? []) as Array<{ status?: unknown; report_message_ids?: unknown; updated_at?: unknown }>
    const fresh = (at: unknown) => typeof at === 'string' && now - Date.parse(at) < WAKING_HOME_TURN_FRESH_MS
    if (turnRows.some((r) => (r.status === 'claimed' || r.status === 'sent') && fresh(r.updated_at))) return 'home_turn_running'

    const reports = await supabase
      .from('chat_messages')
      .select('ui_message')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('role', 'assistant')
      .eq('ui_message->metadata->>kind', TEAMMATE_REPORT_KIND)
      .gte('created_at', new Date(now - WAKING_REPORT_WINDOW_MS).toISOString())
      .limit(20)
    if (reports.error) return 'error'
    const carried = new Set<string>()
    for (const row of turnRows) if (Array.isArray(row.report_message_ids)) for (const id of row.report_message_ids) if (typeof id === 'string') carried.add(id)
    for (const row of (reports.data ?? []) as Array<{ ui_message?: { id?: unknown } | null }>) {
      const id = row.ui_message?.id
      if (typeof id === 'string' && !carried.has(id)) return 'home_turn_pending'
    }

    const helpers = await supabase
      .from('agent_run')
      .select('id')
      .eq('workspace_id', scope.workspaceId)
      .eq('origin', 'chat')
      .eq('chat_conversation_id', scope.conversationId)
      .in('status', ['queued', 'running'])
      .gte('created_at', new Date(now - WAKING_HELPER_MAX_AGE_MS).toISOString())
      .limit(1)
    if (helpers.error) return 'error'
    if ((helpers.data ?? []).length > 0) return 'helper_running'
    return null
  } catch {
    return 'error'
  }
}

/** What the session's recent events say. */
export interface SessionTailView {
  /** A turn started (or a message arrived) with no boundary after it, or the window shows neither. */
  openTurn: boolean
  /** The last step.completed's input tokens (the context size), null when none is in the window. */
  lastStepInputTokens: number | null
  /** A compaction.completed after the last step.completed. */
  compactedSinceLastStep: boolean
  /**
   * A compaction.requested with no compaction.completed, park or turn end
   * after it: one running now (a failed compact-only pass ends at the park).
   */
  compactionPending: boolean
  /** When that pending compaction was requested (epoch ms), null when unknown or none. */
  compactionRequestedAt: number | null
  /** The newest event's time (epoch ms), null when unknown. */
  lastEventAt: number | null
}

/** Read the checks off a window of recent session events. Pure. */
export function inspectSessionTail(events: readonly MessageStreamEvent[]): SessionTailView {
  let marker: 'open' | 'closed' | null = null
  let lastStepInputTokens: number | null = null
  let compactedSinceLastStep = false
  let compactionPending = false
  let compactionRequestedAt: number | null = null
  let lastEventAt: number | null = null
  for (const ev of events) {
    const type = (ev as { type?: unknown }).type
    const at = Date.parse((ev as { meta?: { at?: unknown } }).meta?.at as string)
    if (type === 'turn.started' || type === 'message.received') marker = 'open'
    else if (typeof type === 'string' && TURN_BOUNDARIES.has(type)) marker = 'closed'
    if (type === 'compaction.requested') {
      compactionPending = true
      compactionRequestedAt = Number.isFinite(at) ? at : null
    } else if (type === 'compaction.completed' || (typeof type === 'string' && TURN_BOUNDARIES.has(type))) {
      compactionPending = false
      compactionRequestedAt = null
    }
    if (type === 'step.completed') {
      const input = (ev as { data?: { usage?: { inputTokens?: unknown } } }).data?.usage?.inputTokens
      lastStepInputTokens = typeof input === 'number' && Number.isFinite(input) ? input : lastStepInputTokens
      compactedSinceLastStep = false
    } else if (type === 'compaction.completed') {
      compactedSinceLastStep = true
    }
    if (Number.isFinite(at)) lastEventAt = at
  }
  return { openTurn: marker !== 'closed', lastStepInputTokens, compactedSinceLastStep, compactionPending, compactionRequestedAt, lastEventAt }
}

/**
 * The chat-agent as its server principal: the chat internal secret and the
 * run token, no user credential. The channel takes the tenancy from the token.
 */
export function makeIdleCompactionClient(args: { secret: string; token: string }): Client {
  return new Client({
    host: `${eveDispatchOrigin()}${CHAT_AGENT_MOUNT}`,
    headers: {
      ...protectionBypassHeaders(),
      [CHAT_RUN_SECRET_HEADER]: args.secret,
      [CHAT_RUN_TOKEN_HEADER]: args.token,
    },
    // Never let the secret-bearing headers follow a redirect elsewhere.
    redirect: 'error',
  })
}

export interface CompactIdleSessionDeps {
  makeClient?: (args: { secret: string; token: string }) => Pick<Client, 'sessions'>
  now?: () => number
  /** Right before `compact()`: false when someone came back since step 1 (idleCompactionStillQuiet). */
  stillQuiet?: () => Promise<boolean>
  /** Timing overrides (tests). */
  timing?: Partial<{ firstEventMs: number; tailIdleMs: number; tailMaxMs: number; recheckMs: number; watchMs: number }>
}

export interface CompactIdleSessionResult {
  outcome: IdleCompactionOutcome
  /** The last model call's input from the session stream, when read. */
  inputTokens?: number
}

const IDLE = Symbol('idle')

/**
 * Who asked for the compaction: the idle timer (every check below), or the
 * person, on command (the side panel's Compact now, `/compact`:
 * manual-compaction.ts). On command, the quiet time and the minimum size are
 * the person's call and not checked; a turn running, nothing to compact (no
 * step yet) or nothing new since the last compaction still stop it.
 */
export type CompactionMode = 'idle' | 'manual'

/** Step 2 for the idle timer: compactChatSession with every check. */
export function compactIdleSession(
  input: { claims: IdleCompactionClaims; sessionId: string },
  deps: CompactIdleSessionDeps = {},
): Promise<CompactIdleSessionResult> {
  return compactChatSession({ ...input, mode: 'idle' }, deps)
}

/**
 * Step 2, eve. Never throws: every failure is an outcome. One stream serves
 * both halves: it is opened IDLE_COMPACTION_TAIL_EVENTS from the tail, read
 * until it pauses (the durable tail), checked, and then kept open to watch
 * the compaction the request queues.
 *
 * The first event gets its own, longer wait (the open is slow on a cold
 * agent); the pause that ends the read is timed only after it. eve's
 * `onCaughtUp` can't mark the tail here: open-stream compares a negative
 * start cursor to an absolute tail.
 *
 * The server's compaction principal (`server: 'idle_compaction'`) serves
 * both modes: it may only compact and read the stream, and the compaction
 * bills under the session's last turn's token either way (see Billing above).
 */
export async function compactChatSession(
  input: { claims: IdleCompactionClaims; sessionId: string; mode: CompactionMode },
  deps: CompactIdleSessionDeps = {},
): Promise<CompactIdleSessionResult> {
  const now = deps.now ?? Date.now
  const firstEventMs = deps.timing?.firstEventMs ?? IDLE_COMPACTION_FIRST_EVENT_MS
  const tailIdleMs = deps.timing?.tailIdleMs ?? IDLE_COMPACTION_TAIL_IDLE_MS
  const tailMaxMs = deps.timing?.tailMaxMs ?? IDLE_COMPACTION_TAIL_MAX_MS
  const recheckMs = deps.timing?.recheckMs ?? IDLE_COMPACTION_RECHECK_MS
  const watchMs = deps.timing?.watchMs ?? IDLE_COMPACTION_WATCH_MS
  const { claims, sessionId } = input
  const idle = input.mode === 'idle'

  // The server principal: without the chat secret there is neither a token nor a caller.
  const secret = internalSecret()
  if (!secret) return { outcome: 'server_auth_failed' }

  let session: ClientSession
  try {
    // Marked as the server's own (`server`): it reaches nothing more, and a
    // gate that needs the person in the chat (quick helpers) refuses it.
    const token = mintChatRunToken({ ...claims, server: 'idle_compaction' }, { ttlMs: IDLE_COMPACTION_TOKEN_TTL_MS })
    const client = (deps.makeClient ?? makeIdleCompactionClient)({ secret, token })
    session = client.sessions.attach(sessionId)
  } catch {
    return { outcome: 'error' }
  }

  const ac = new AbortController()
  const deadline = setTimeout(() => ac.abort(), firstEventMs + tailMaxMs + recheckMs + watchMs)
  let iterator: AsyncIterator<MessageStreamEvent> | null = null
  let pending: Promise<IteratorResult<MessageStreamEvent>> | null = null
  let inputTokens: number | undefined
  let compactSent = false
  const next = async (waitMs: number | null): Promise<IteratorResult<MessageStreamEvent> | typeof IDLE> => {
    pending ??= iterator!.next()
    if (waitMs === null) {
      const r = await pending
      pending = null
      return r
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), waitMs)
    })
    try {
      const r = await Promise.race([pending, idle])
      if (r !== IDLE) pending = null
      return r
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    iterator = session
      .stream({ startIndex: -IDLE_COMPACTION_TAIL_EVENTS, streamReconnectPolicy: { reconnect: false }, signal: ac.signal })
      [Symbol.asyncIterator]()

    // ── Read the tail: the first event, then until the stream pauses ──────────
    const tail: MessageStreamEvent[] = []
    const first = await next(firstEventMs)
    // Nothing at all: a slow open or an empty window, not a running turn.
    if (first === IDLE || first.done) return { outcome: 'no_events' }
    tail.push(first.value)
    // Elapsed wall time from the first event (the injected clock only stands in for "now" in the checks).
    const readStart = Date.now()
    let ended = false
    for (;;) {
      const r = await next(tailIdleMs)
      if (r === IDLE) break
      if (r.done) {
        ended = true
        break
      }
      tail.push(r.value)
      // Still streaming: a turn is producing events.
      if (Date.now() - readStart > tailMaxMs) return { outcome: 'turn_running' }
    }

    // ── Re-check from eve's own record ────────────────────────────────────────
    const view = inspectSessionTail(tail)
    if (view.lastStepInputTokens !== null) inputTokens = view.lastStepInputTokens
    if (view.openTurn) return { outcome: 'turn_running', inputTokens }
    // One already running (idle's, the person's, another tab's): never a second, billed, on top.
    if (view.compactionPending && (view.compactionRequestedAt === null || now() - view.compactionRequestedAt < IDLE_COMPACTION_PENDING_MAX_MS)) {
      return { outcome: 'compacting', inputTokens }
    }
    if (idle && view.lastEventAt !== null && now() - view.lastEventAt < IDLE_COMPACTION_QUIET_MS - IDLE_COMPACTION_CLOCK_SLACK_MS) {
      return { outcome: 'recent_activity', inputTokens }
    }
    if (view.lastStepInputTokens === null) return { outcome: 'no_recent_step' }
    if (view.compactedSinceLastStep) return { outcome: 'already_compacted', inputTokens }
    if (idle && view.lastStepInputTokens < IDLE_COMPACTION_MIN_INPUT_TOKENS) return { outcome: 'small_context', inputTokens }

    // ── Nothing arrived since? (eve queues a send behind a compaction) ────────
    if (deps.stillQuiet && !(await deps.stillQuiet())) return { outcome: 'recent_activity', inputTokens }
    if (!ended) {
      const r = await next(recheckMs)
      if (r !== IDLE) {
        if (!r.done) return { outcome: 'recent_activity', inputTokens }
        ended = true
      }
    }

    // ── Compact, then watch for the outcome ───────────────────────────────────
    compactSent = true
    const res = await session.compact()
    if (res.status !== 'accepted') return { outcome: 'session_inactive', inputTokens }
    if (ended) return { outcome: 'requested', inputTokens }
    let requested = false
    let completed = false
    for (;;) {
      const r = await next(null)
      if (r === IDLE || r.done) return { outcome: 'requested', inputTokens }
      const type = r.value.type
      if (type === 'compaction.requested') requested = true
      else if (type === 'compaction.completed') completed = true
      else if (type === 'session.waiting') return { outcome: completed ? 'compacted' : 'kept_history', inputTokens }
      else if ((type === 'turn.started' || type === 'message.received') && !requested) {
        return { outcome: 'queued_behind_turn', inputTokens }
      } else if (type === 'session.failed' || type === 'session.completed') return { outcome: 'error', inputTokens }
    }
  } catch (err) {
    // The watch deadline aborts the stream: the request stands, its outcome unseen.
    if (ac.signal.aborted && compactSent) return { outcome: 'requested', inputTokens }
    if (err instanceof ClientError && err.status === 401) return { outcome: 'server_auth_failed', inputTokens }
    if (err instanceof ClientError && err.status === 403) return { outcome: 'forbidden', inputTokens }
    return { outcome: 'error', inputTokens }
  } finally {
    clearTimeout(deadline)
    ac.abort()
    ;(pending as Promise<unknown> | null)?.catch(() => {})
    if (iterator?.return) iterator.return().catch(() => {})
  }
}

/** The one log line per run. Counts and ids only. */
export function idleCompactionLogLine(args: {
  conversationId: string
  sessionId?: string
  inputTokens?: number
  outcome: IdleCompactionOutcome
  /** The re-check run (IDLE_COMPACTION_RECHECK_DELAY after the first). */
  recheck?: boolean
}): string {
  return `[idle-compaction] conversation=${args.conversationId} session=${args.sessionId ?? '-'} input=${args.inputTokens ?? '-'} outcome=${args.outcome}${args.recheck ? ' recheck=1' : ''}`
}
