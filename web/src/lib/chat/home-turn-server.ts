/**
 * Server-written turns in the home thread, the server half (A4 slice 5,
 * docs/plans/always-on-agent.md §2 "A server-side turn writer"). The Inngest
 * consumer (src/lib/inngest/home-turn.ts) runs these as steps:
 *
 *   1. planHomeTurn: the conversation is the person's home thread (is_home);
 *      they're still a member; autonomy isn't off;
 *      they're within their usage limits; something new waits (for
 *      'helper_report': teammate reports no earlier home turn carried; for
 *      'digest', A6 slice 4: the undelivered agent_event rows the cron named
 *      or log lines since the last digest, keyed `digest:<local date>`; for
 *      'event': every undelivered row the router sorted `turn`, minus what
 *      settled since, keyed on their ids, agent-events/event-turn.ts; for
 *      'approval': the calls the person's yes ran in this thread that no
 *      approval turn carried, src/lib/safety/approval-turn.ts); and
 *      the session isn't parked on an open question or approval (a send
 *      would steer past the person's pending `ask_user` picker). A home
 *      thread with no live eve session (none registered yet, or the one it
 *      names is gone: expired, stranded, not found) gets one here
 *      (ensureHomeSession): a message-free session created as the server
 *      principal and registered with the mint route's conditional guard, so
 *      a session the person's own window registered first wins and the turn
 *      queues onto that one instead. A session with no events yet is primed:
 *      the plan carries the thread's history primer (the home primer, else
 *      the ordinary one), which the send appends to the update. It reads the
 *      session's tail as the server principal: the index the turn will start
 *      from (absolute, so the read never replays the whole session) and the
 *      recent events the park check reads. A skip leaves the report row and
 *      the next turn's Teammate updates section to deliver it; a skip with
 *      something to deliver records a `skipped` row.
 *   2. claimHomeTurn: insert the `home_turn` row (migration 333), unique on
 *      (conversation_id, dedupe_key), BEFORE anything is sent. A conflict is
 *      a duplicate unless the row went stale (no step touched it for
 *      HOME_TURN_RESUME_AFTER_MS: its run died), or failed before eve
 *      accepted anything (then it is claimed again).
 *   3. sendHomeTurn: move the row claimed → sent together with its start
 *      index (one conditional update: only one attempt ever sends, and a
 *      crash after the send still knows where to read), mint a chat-run token
 *      with `server: 'home_turn'` (no sealed user JWT), and send
 *      `{ message, turnPolicy: 'queue' }` as the chat-agent channel's server
 *      principal (agents/chat-agent/lib/auth.ts serverCompactionAuth admits
 *      exactly that, into an is_home session). Then read.
 *   4. continueHomeTurn: read the turn in budgeted steps, re-attaching from
 *      the cursor, through the reducer the browser runs
 *      (src/lib/chat/eve-turn-parts.ts). The turn is found by the delivery id
 *      the send returned (else by the tag on its message's first line);
 *      reading stops at its boundary, or at the first event carrying another
 *      delivery id (the person typed while it ran and their message folded
 *      in: from there the browser's own response renders and persists the
 *      rest, UI-2's attributeEvent rule). Each step touches the row (the
 *      lease a second run checks).
 *   5. finishHomeTurn: write the reply with persistEveMessage (id
 *      `home-turn:<row>`), unless the turn ended on no_reply or is empty; settle the
 *      row done; signalChatSessionActivity (the idle-compaction timer).
 *
 * The turn is read-only (the internal tool route's isServerTurnTool), except
 * that it may start a background helper that reads and writes drafts, within
 * the server-helper budget (start-helper.ts, kind 'home_turn'; Liam,
 * 2026-10-15), and billed as `ai_chat` to the person through the token
 * (decision 8).
 *
 * Reasons 'slack' (docs/plans/slack-connect.md, migration 413) and 'text'
 * (docs/plans/text-and-calling.md, migration 411) are the person messaging
 * from an outside channel (channelOfReason): the plan gathers every message of
 * theirs from that channel no earlier turn of it carried
 * (undeliveredChannelMessages), the message is their own words
 * (./channel-turn.ts), and the token is `server: 'channel_turn'` with the
 * channel's surface ('slack', 'sms'), which acts with the person's tools minus
 * the surface's exclusions instead of reading only. Each channel's consumer
 * (src/lib/inngest/slack-turn.ts, src/lib/inngest/text-turn.ts) sends the
 * reply back (src/lib/slack/turn.ts, ./text-turn-server.ts). After it, the consumer marks the agent_event rows it covered
 * delivered: a report turn's work items whatever it said, an event turn's
 * rows only once a reply was written.
 *
 * Reason 'check_in' (docs/plans/now-file.md "The check-in") is the one home
 * turn that never runs in the home thread's session: that session's history
 * holds mail, helpers' reports and other agents' words, and a check-in may
 * write the person's Now file. Its plan re-gathers what the note tracks
 * (src/lib/now/check-in.ts gatherCheckIn), then creates a FRESH,
 * message-free session as the home turn's server principal with the
 * check-in's token (createCheckInSession): no primer, no tail, nothing of
 * the thread. The claim registers that session on the check-in's own
 * home_turn row (eve_session_id), which is the only registration the
 * chat-agent's server entry accepts for a check-in token
 * (agents/chat-agent/lib/auth.ts), and only while the row is claimed or sent.
 * The send, the reads and the token are the same as every home turn's; the
 * reply, when there is one, is written into the home thread as text with
 * appendHomeMessage, the way ci-fix.ts posts "CI is still red".
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Client, ClientError } from 'eve/client'
import type { ClientSession, HandleMessageStreamEvent, MessageResponse } from 'eve/client'
import { checkUsageLimits } from '@/lib/ai/auth'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'
import {
  CHAT_RUN_SECRET_HEADER,
  CHAT_RUN_TOKEN_HEADER,
  internalSecret,
  isHomeTurnTokenReason,
  mintChatRunToken,
} from '@/lib/chat/chat-run-token'
import { persistEveMessage, type EveMessagePart } from '@/lib/chat/eve-message-writer'
import {
  applyEveTurnEvent,
  createEveTurnPartsState,
  eveTurnText,
  restoreEveTurnParts,
  snapshotEveTurnParts,
  type EveTurnPartsSnapshot,
  type EveTurnPartsState,
} from '@/lib/chat/eve-turn-parts'
import { signalChatSessionActivity } from '@/lib/chat/idle-compaction-signal'
import { TEAMMATE_REPORT_KIND, oneLine, parseTeammateReport, type TeammateReport } from '@/lib/chat/teammate-report'
import { MESSAGE_LABEL_KEY } from '@/lib/chat/message-time'
import { eveDispatchOrigin, protectionBypassHeaders } from '@/lib/eve/dispatch-origin'
import { readAgentPausedState } from '@/lib/work/agent-paused'
import {
  HOME_TURN_KIND,
  HOME_TURN_MAX_REPORTS,
  HOME_TURN_REASONS,
  buildHomeTurnBody,
  checkInTurnKey,
  digestTurnKey,
  homeTurnMessageId,
  homeTurnTag,
  isBackgroundUpdateText,
  endedWithNoReply,
  isNoReplyPart,
  isQuietReply,
  isUrgentPart,
  narrationBeforeNoReply,
  urgentByOfParts,
  type HomeTurnCheckIn,
  type HomeTurnApprovals,
  type HomeTurnDigest,
  type HomeTurnEvents,
  type HomeTurnReason,
  type HomeTurnRequestedData,
  type HomeTurnStatus,
} from '@/lib/chat/home-turn'
import { digestBody, gatherDigest } from '@/lib/agent-events/digest'
import { gatherCheckIn, type CheckInGather } from '@/lib/now/check-in'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { eventTurnBody, gatherEventTurn } from '@/lib/agent-events/event-turn'
import { gatherGuestAsks, type HomeTurnGuestAsks } from '@/lib/guests/guest-asks'
import { gatherAgentAnswers } from '@/lib/agent-links/exchange'
import { approvalsRanAfter, gatherApprovalTurn } from '@/lib/safety/approval-turn'
import type { HomeTurnAgentAnswers } from '@/lib/agent-links/answer-lines'
import { resolveMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { renderConversationPrimer, renderHomePrimer } from '@/lib/chat/conversation-history'
import { UNDEFINED_COLUMN } from '@/lib/chat/home-thread'
import {
  CALL_CHANNEL,
  CHANNEL_MESSAGE_KIND,
  callMessagePrefix,
  CHANNEL_TURN_MAX_MESSAGES,
  CHANNEL_TURN_WINDOW_MS,
  DIAL8_CHANNEL,
  LEGACY_TEXT_MESSAGE_KIND,
  SLACK_CHANNEL,
  SMS_CHANNEL,
  type MessageChannel,
  type PlannedChannelMessage,
} from '@/lib/chat/channel-turn'
import { approvalIdOfToolOutput } from '@/lib/attention/chat-asks'
import { replyTextOfParts } from '@/lib/chat/channel-reply'

/** The chat-agent's eve mount (next.config.mjs), as idle compaction calls it. */
const CHAT_AGENT_MOUNT = '/eve/chat-agent'

/** How long one read step reads before handing off (inside /api/inngest's 300 s), as work runs do. */
export const HOME_TURN_STEP_BUDGET_MS = 240_000
/** Read steps after the send: 15 × 240 s, one turn's hour (the work-run cap). */
export const HOME_TURN_MAX_READ_STEPS = 15
/**
 * After the turn, the window in which an idle compaction can still run on the
 * turn's token: the quiet time (idle-compaction.ts IDLE_COMPACTION_QUIET_MS,
 * 3 min), its one look-again (IDLE_COMPACTION_RECHECK_DELAY, 5 min) and the
 * compaction itself (a few minutes). eve's compact carries no caller, so
 * `auth.current` stays the last turn's: the profile recall at
 * `compaction.completed` posts THIS token, and an expired one may only replay.
 */
export const HOME_TURN_COMPACTION_WINDOW_MS = 20 * 60_000
/**
 * The token the SEND carries is the turn's for its whole life: every tool
 * call of the turn presents it, and so does a later idle compaction's profile
 * recall. So it covers the turn's cap (the send step plus every read step)
 * plus the compaction window: 64 + 20 = 84 min (mintChatRunToken lets only a
 * home or channel turn's server token past the 60-minute default).
 */
export const HOME_TURN_TOKEN_TTL_MS = HOME_TURN_STEP_BUDGET_MS * (HOME_TURN_MAX_READ_STEPS + 1) + HOME_TURN_COMPACTION_WINDOW_MS
/** A read step's (and the tail peek's) token covers only its own read: each step mints its own. */
export const HOME_TURN_READ_TOKEN_TTL_MS = 10 * 60_000
/** Reports older than this never start a server turn (the Teammate updates section still lists them). */
export const HOME_TURN_REPORT_WINDOW_MS = 24 * 60 * 60_000
/**
 * A claimed or sent row no step touched for this long belongs to a run that
 * died: another run may resume it. Below it, a conflict is a duplicate (two
 * runs never both read and persist one turn). 1.5 step budgets.
 */
export const HOME_TURN_RESUME_AFTER_MS = (HOME_TURN_STEP_BUDGET_MS * 3) / 2
/** A row still `claimed` (nothing sent) after this long failed: its reports get a turn. */
export const HOME_TURN_CLAIM_STALE_MS = 15 * 60_000
/** Recent session events the plan reads for an open question (and the tail index). */
export const HOME_TURN_TAIL_EVENTS = 1000
/** How long the tail read may take. */
export const HOME_TURN_TAIL_TIMEOUT_MS = 15_000
/** eve's response header carrying the stream's durable tail index (eve 0.66.3 protocol/message.js). */
export const EVE_STREAM_TAIL_INDEX_HEADER = 'x-eve-stream-tail-index'

/**
 * Failures recorded before eve accepted anything: such a row carried nothing
 * to the agent, so its reports are still undelivered and the claim may be
 * taken again. Anything else (`send_failed`: the POST may have landed) counts
 * as carried, so a report is never put to the agent twice.
 */
export function failedBeforeAccept(error: string | null | undefined): boolean {
  if (typeof error !== 'string') return false
  return (
    error.startsWith('send_refused_') ||
    error === 'claim_stale' ||
    error === 'server_auth_unavailable' ||
    error === 'empty_body' ||
    error === 'lease_busy'
  )
}

/** Why a home turn wasn't sent. */
export type HomeTurnSkip =
  | 'bad_event'
  | 'unsupported_reason'
  | 'no_conversation'
  | 'not_home'
  | 'no_session'
  | 'not_member'
  | 'autonomy_off'
  | 'usage_limited'
  | 'usage_check_failed'
  | 'nothing_new'
  /** The session is parked on a question or approval for the person: a send would steer past it. */
  | 'question_pending'
  | 'lookup_failed'
  | 'duplicate'

/** One report the turn delivers: its chat_messages id and what it says. */
export interface PlannedReport {
  messageId: string
  report: TeammateReport
}

export interface HomeTurnPlan {
  ok: true
  sessionId: string
  /** The absolute stream index the turn's read starts from (the tail just before the send). */
  fromIndex: number
  reports: PlannedReport[]
  workItemIds: string[]
  dedupeKey: string
  /** 'digest' (A6 slice 4): what the morning summary carries. */
  digest?: HomeTurnDigest
  /** 'event': the router's turn rows still worth a line. */
  events?: HomeTurnEvents
  /** 'guest_ask': the guests' asks no turn carried yet (src/lib/guests/guest-asks.ts). */
  guestAsks?: HomeTurnGuestAsks
  /** 'agent_answer': the linked agents' answers no turn carried yet (src/lib/agent-links/exchange.ts). */
  agentAnswers?: HomeTurnAgentAnswers
  /**
   * 'check_in': what is due in the person's Now file (src/lib/now/check-in.ts).
   * Its `sessionId` is a fresh session this plan created, never the thread's.
   */
  checkIn?: HomeTurnCheckIn
  /** 'approval': the calls the person's yes ran that no turn carried yet (src/lib/safety/approval-turn.ts). */
  approvals?: HomeTurnApprovals
  /** 'slack', 'text', 'agent_ask': the channel messages the turn carries, oldest first. */
  channelMessages?: PlannedChannelMessage[]
  /** 'slack': a DM (the home thread) or a channel thread (their own conversation for it). */
  channelPlace?: 'direct' | 'thread'
  /**
   * The thread's history, for a session with no events yet (one this plan
   * created, or a registered one nothing was ever sent into): the send
   * appends it to the update, as the browser's first send prepends its
   * primer. Absent for a session that already holds the conversation.
   */
  primer?: string
  /**
   * A channel turn's plan, as its plan step returns it: the primer was taken
   * out (it holds the person's words, and a step output is stored), and the
   * send step renders it again (./channel-turn-server.ts hydrateChannelPlan).
   */
  primerPending?: boolean
  /**
   * The person runs on their own ChatGPT plan (the free tier): the send's
   * token says so, as the browser mint's does, so the turn stays on their plan
   * even when the chat agent can't read its spec (chatGptPlanForTurn's
   * fallback), never Dial8's fallback model.
   */
  chatgptPlan?: true
}

export type HomeTurnPlanResult =
  | HomeTurnPlan
  | {
      ok: false
      reason: HomeTurnSkip
      /** Set when there was something to deliver: the consumer records a `skipped` row. */
      record?: {
        dedupeKey: string
        reports: PlannedReport[]
        workItemIds: string[]
        sessionId: string | null
        channelMessages?: PlannedChannelMessage[]
      }
    }

interface ConversationRow {
  id: string
  eve_session_id: string | null
  is_home: boolean | null
  /** Migration 414: a person's conversation for one Slack channel thread. */
  outside_channel?: string | null
  /** Migration 427: a guest's own thread (guest access), answered only by that guest's turns. */
  agent_guest_id?: string | null
}

/**
 * True when the turn's guest and the conversation's agree (guest access): a
 * guest's turn only in that guest's thread, and a guest's thread only by
 * that guest's turn, so a text from a guest never runs as the owner's own
 * turn, and the owner's never lands in a guest's thread.
 */
export function guestTurnConversationOk(conv: Pick<ConversationRow, 'agent_guest_id'>, data: Pick<HomeTurnRequestedData, 'guestId'>): boolean {
  return (conv.agent_guest_id ?? null) === (data.guestId ?? null)
}

/**
 * True when a server turn of this reason may run in this conversation: the
 * person's home thread, or, for a channel turn, their conversation marked
 * with that turn's own channel (a Slack channel thread, migration 414). A
 * guest's thread takes a channel turn by either channel (one thread per
 * guest, texting or on Slack: migration 434); guestTurnConversationOk binds
 * it to that guest's own turns. The chat-agent's server entry applies the
 * same rule.
 */
export function serverTurnConversationOk(conv: Pick<ConversationRow, 'is_home' | 'outside_channel' | 'agent_guest_id'>, reason: HomeTurnReason): boolean {
  const channel = channelOfReason(reason)
  // A linked agent's message only ever reaches a half's thread (guestTurnConversationOk binds which).
  if (channel === DIAL8_CHANNEL) return !!conv.agent_guest_id && conv.is_home !== true
  if (conv.is_home === true) return true
  if (conv.agent_guest_id) return channel === 'sms' || channel === 'slack'
  return channel !== null && conv.outside_channel === channel
}

/** The dedupe key of a turn delivering these report ids (stable whatever their order). */
export function homeTurnDedupeKey(reason: HomeTurnReason, reportIds: readonly string[]): string {
  const digest = createHash('sha256').update([...reportIds].sort().join('\n')).digest('hex').slice(0, 40)
  return `${reason}:${digest}`
}

interface CarryRow {
  id?: unknown
  report_message_ids?: unknown
  status?: unknown
  error?: unknown
  updated_at?: unknown
}

/**
 * The teammate reports in this conversation no earlier home turn carried,
 * newest HOME_TURN_MAX_REPORTS within the window, oldest first. A row carries
 * its reports unless it failed before eve accepted anything, or it has sat
 * `claimed` past HOME_TURN_CLAIM_STALE_MS (its run died before sending: it is
 * marked failed here, `claim_stale`, so its claim can be taken again).
 * Throws on a failed read.
 */
export async function undeliveredReports(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; workspaceId: string },
  now: number = Date.now(),
): Promise<PlannedReport[]> {
  const [reports, turns] = await Promise.all([
    supabase
      .from('chat_messages')
      .select('created_at, ui_message')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('role', 'assistant')
      .eq('ui_message->metadata->>kind', TEAMMATE_REPORT_KIND)
      .gte('created_at', new Date(now - HOME_TURN_REPORT_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(HOME_TURN_MAX_REPORTS * 3),
    supabase
      .from('home_turn')
      .select('id, report_message_ids, status, error, updated_at')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (reports.error) throw new Error(reports.error.message)
  if (turns.error) throw new Error(turns.error.message)
  const carried = new Set<string>()
  for (const row of (turns.data ?? []) as CarryRow[]) {
    if (row.status === 'failed' && failedBeforeAccept(row.error as string | null)) continue
    if (row.status === 'claimed' && isOlderThan(row.updated_at, HOME_TURN_CLAIM_STALE_MS, now)) {
      if (typeof row.id === 'string') await markClaimStale(supabase, row.id)
      continue
    }
    if (Array.isArray(row.report_message_ids)) for (const id of row.report_message_ids) if (typeof id === 'string') carried.add(id)
  }
  const out: PlannedReport[] = []
  for (const row of (reports.data ?? []) as Array<{ ui_message: { id?: unknown; metadata?: { teammate_report?: unknown } } | null }>) {
    const messageId = row.ui_message?.id
    if (typeof messageId !== 'string' || carried.has(messageId)) continue
    const report = parseTeammateReport(row.ui_message?.metadata?.teammate_report)
    if (!report) continue
    out.push({ messageId, report })
    if (out.length >= HOME_TURN_MAX_REPORTS) break
  }
  return out.reverse()
}

/** The outside channel a reason speaks for, or null for the server's own reasons. */
export function channelOfReason(reason: HomeTurnReason): MessageChannel | null {
  if (reason === 'slack') return SLACK_CHANNEL
  if (reason === 'text') return SMS_CHANNEL
  if (reason === 'agent_ask') return DIAL8_CHANNEL
  if (reason === 'call') return CALL_CHANNEL
  return null
}

/**
 * The text_message_ids column of a channel turn's row, and nothing for any
 * other reason. Migration 411 added it for texts; since 413 it holds every
 * channel's carried messages (one column, read per reason).
 */
function channelColumns(reason: HomeTurnReason, messages: readonly PlannedChannelMessage[] | undefined): { text_message_ids?: string[] } {
  return channelOfReason(reason) ? { text_message_ids: (messages ?? []).map((m) => m.messageId) } : {}
}

/**
 * The person's messages from `channel` in this home thread that no earlier
 * turn of that channel carried, the newest CHANNEL_TURN_MAX_MESSAGES within
 * CHANNEL_TURN_WINDOW_MS, oldest first. A row carries its messages unless it
 * failed before eve accepted anything, or sat `claimed` past
 * HOME_TURN_CLAIM_STALE_MS (as undeliveredReports). A `skipped` row carried
 * them: a message skipped while a question waited is answered by its notice
 * and never replayed later. Throws on a failed read.
 */
export async function undeliveredChannelMessages(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; workspaceId: string; callSessionId?: string },
  reason: HomeTurnReason,
  now: number = Date.now(),
): Promise<PlannedChannelMessage[]> {
  const channel = channelOfReason(reason)
  if (!channel) return []
  const [messages, turns] = await Promise.all([
    supabase
      .from('chat_messages')
      .select('created_at, ui_message')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('role', 'user')
      // A text Phase 1 SMS wrote (kind text_message) still counts, so one sent
      // just before the channels became one layer is still answered.
      .in('ui_message->metadata->>kind', channel === SMS_CHANNEL ? [CHANNEL_MESSAGE_KIND, LEGACY_TEXT_MESSAGE_KIND] : [CHANNEL_MESSAGE_KIND])
      .eq('ui_message->metadata->>channel', channel)
      .gte('created_at', new Date(now - CHANNEL_TURN_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(CHANNEL_TURN_MAX_MESSAGES * 2),
    supabase
      .from('home_turn')
      .select('id, text_message_ids, status, error, updated_at')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('reason', reason)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (messages.error) throw new Error(messages.error.message)
  if (turns.error) throw new Error(turns.error.message)
  const carried = new Set<string>()
  for (const row of (turns.data ?? []) as Array<CarryRow & { text_message_ids?: unknown }>) {
    if (row.status === 'failed' && failedBeforeAccept(row.error as string | null)) continue
    if (row.status === 'claimed' && isOlderThan(row.updated_at, HOME_TURN_CLAIM_STALE_MS, now)) {
      if (typeof row.id === 'string') await markClaimStale(supabase, row.id)
      continue
    }
    if (Array.isArray(row.text_message_ids)) for (const id of row.text_message_ids) if (typeof id === 'string') carried.add(id)
  }
  const out: PlannedChannelMessage[] = []
  // A call's turn carries only that call's words (HomeTurnRequestedData.callSessionId).
  const callPrefix = reason === 'call' && scope.callSessionId ? callMessagePrefix(scope.callSessionId) : null
  for (const row of (messages.data ?? []) as Array<{ ui_message: { id?: unknown; parts?: unknown } | null }>) {
    const messageId = row.ui_message?.id
    if (typeof messageId !== 'string' || carried.has(messageId)) continue
    if (callPrefix && !messageId.startsWith(callPrefix)) continue
    const text = textOfParts(row.ui_message?.parts)
    if (!text) continue
    out.push({ messageId, text })
    if (out.length >= CHANNEL_TURN_MAX_MESSAGES) break
  }
  return out.reverse()
}

/** The text parts of a stored message, joined. */
export function textOfParts(parts: unknown): string {
  return (Array.isArray(parts) ? (parts as Array<{ type?: unknown; text?: unknown }>) : [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim()
}

function isOlderThan(at: unknown, ms: number, now: number): boolean {
  const t = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(t) && now - t > ms
}

/** A stale claim (nothing was sent) becomes failed, `claim_stale`. Never throws. */
async function markClaimStale(supabase: SupabaseClient, rowId: string): Promise<void> {
  try {
    await supabase
      .from('home_turn')
      .update({ status: 'failed', error: 'claim_stale', updated_at: new Date().toISOString() })
      .eq('id', rowId)
      .eq('status', 'claimed')
  } catch {
    // Best-effort: the reports are planned anyway; a later claim retries the mark.
  }
}

// ── The session's tail ───────────────────────────────────────────────────────

/** What the plan reads from the session before anything is sent. */
export interface SessionTail {
  /** The absolute index of the session's last event (-1 when it has none). */
  tailIndex: number
  /** Up to HOME_TURN_TAIL_EVENTS of its newest events, oldest first. */
  events: HandleMessageStreamEvent[]
}

/** A refused tail read: eve's status, and its code / error words when the body carried them. */
export class SessionTailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly bodyError: string | null,
  ) {
    super(`home turn: tail read refused (${status}${code ? ` ${code}` : ''})`)
    this.name = 'SessionTailError'
  }
}

/** eve's words for a session id it has no run for (eve 0.79 session stream route: a 404 with no code). */
const EVE_SESSION_NOT_FOUND = 'Session not found.'

/**
 * True when the tail read says the session can never take a turn again, so
 * the home thread needs a new one: eve 0.79's 410 `session_expired` (its
 * history passed the World's retention), 409 `session_stranded` (another eve
 * version built it) or 404 "Session not found." (no run for that id). Never
 * a refusal of the caller (401 / 403), a 5xx, or a bare 404 without eve's
 * words (a mount that isn't there): those keep the registered session and
 * retry, so a misroute can never replace the person's live session.
 */
export function isSessionGoneError(err: unknown): boolean {
  if (!(err instanceof SessionTailError)) return false
  if (err.status === 410) return err.code === 'session_expired'
  if (err.status === 409) return err.code === 'session_stranded'
  return err.status === 404 && err.bodyError === EVE_SESSION_NOT_FOUND
}

/** Seams for the tests. */
export interface HomeTurnIo {
  makeClient?: (args: { secret: string; token: string }) => Pick<Client, 'sessions'>
  fetch?: typeof fetch
  budgetMs?: number
}

/**
 * The home turn's server token: the send's lives as long as its turn
 * (HOME_TURN_TOKEN_TTL_MS), a read's only for its read. A channel turn's is
 * the `channel_turn` principal with its channel's surface (the pair the
 * verifiers require together); every other reason's is `home_turn`.
 * `chatgptPlan`: the send's carries the free tier's claim
 * (HomeTurnPlan.chatgptPlan), a channel turn's too.
 */
export function homeTurnToken(data: HomeTurnRequestedData, use: 'send' | 'read' = 'read', chatgptPlan = false): string {
  const channel = channelOfReason(data.reason)
  // A home turn's token says why it was minted: only some background updates act on their own (chat-ceiling.ts serverTurnMayCall).
  const principal = channel
    ? ({ server: 'channel_turn', surface: channel } as const)
    : ({ server: 'home_turn', ...(isHomeTurnTokenReason(data.reason) ? { homeTurnReason: data.reason } : {}) } as const)
  return mintChatRunToken(
    {
      conversationId: data.conversationId,
      workspaceId: data.workspaceId,
      userId: data.userId,
      ...principal,
      // A guest's channel turn (428, 434): the guest's own thread, answered as their agent.
      ...(channel && data.guestId ? { guestId: data.guestId } : {}),
      ...(chatgptPlan ? { chatgptPlan: true as const } : {}),
    },
    { ttlMs: use === 'send' ? HOME_TURN_TOKEN_TTL_MS : HOME_TURN_READ_TOKEN_TTL_MS },
  )
}

/**
 * Read the session's tail as the home turn's server principal: one bounded
 * stream request (`startIndex=-HOME_TURN_TAIL_EVENTS&includeTailIndex=1`;
 * eve answers the durable tail's absolute index in EVE_STREAM_TAIL_INDEX_HEADER
 * and ends the body after those events). The client's own stream API can't
 * ask for the tail index (eve keeps requestTailIndex internal), hence the
 * plain request. Throws on any failure (the plan step retries).
 */
export async function peekSessionTail(data: HomeTurnRequestedData, sessionId: string, io: HomeTurnIo = {}): Promise<SessionTail> {
  const secret = internalSecret()
  if (!secret) throw new Error('home turn: no chat internal secret')
  const url = `${eveDispatchOrigin()}${CHAT_AGENT_MOUNT}/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=-${HOME_TURN_TAIL_EVENTS}&includeTailIndex=1`
  const res = await (io.fetch ?? fetch)(url, {
    method: 'GET',
    headers: { ...protectionBypassHeaders(), [CHAT_RUN_SECRET_HEADER]: secret, [CHAT_RUN_TOKEN_HEADER]: homeTurnToken(data) },
    // Never let the secret-bearing headers follow a redirect elsewhere.
    redirect: 'error',
    signal: AbortSignal.timeout(HOME_TURN_TAIL_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null
    throw new SessionTailError(res.status, typeof body?.code === 'string' ? body.code : null, typeof body?.error === 'string' ? body.error : null)
  }
  const raw = res.headers.get(EVE_STREAM_TAIL_INDEX_HEADER)
  const tailIndex = raw === null ? NaN : Number(raw)
  if (!Number.isSafeInteger(tailIndex) || tailIndex < -1) throw new Error('home turn: no tail index on the stream')
  const events: HandleMessageStreamEvent[] = []
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as { type?: unknown }
      if (ev && typeof ev.type === 'string') events.push(ev as HandleMessageStreamEvent)
    } catch {
      // A control line or a torn tail: not an event.
    }
  }
  return { tailIndex, events }
}

/**
 * Whether the session is parked on a question or approval nobody answered:
 * an `input.requested` in the window with no `input.resolved` /
 * `approval.settled` for it, and no cancellation or session end after it.
 * eve keeps such a request pending even while ordinary turns run past it, so
 * a server turn would land on top of the person's open `ask_user` picker.
 * A request older than the window is not seen (a bound, not a guarantee).
 *
 * A request asked before a turn the person started is not open either: they
 * moved on past the picker (typed instead of answering, or the picker was
 * skipped for a message already on its way, which eve ran as its own turn).
 * eve 0.79 cancels an approval the person steers past, but a request whose
 * settle never reached the stream (an older eve kept it pending; a
 * background task's question stays open by design) must not silence every
 * home turn after it. Only the opening message of a new turn counts: a
 * relayed answer is a mid-turn message.received, and a home turn's own
 * message (a background update) is not the person's.
 */
export function hasOpenInputRequest(events: readonly HandleMessageStreamEvent[]): boolean {
  const open = new Set<string>()
  /** Requests open when the current turn started, until its first message.received. */
  let beforeTurn: Set<string> | null = null
  for (const ev of events) {
    const data = (ev as { data?: Record<string, unknown> }).data ?? {}
    switch (ev.type) {
      case 'turn.started':
        // A new turn: what is open now was asked before it. Its first
        // message, if the person's, is them moving on past those questions.
        beforeTurn = new Set(open)
        break
      case 'message.received':
        // Only the opening message of a person's new turn drops them, and
        // only those asked before the turn: a relayed answer to a helper's
        // question (eve's receiveRelayedAnswer) also lands as
        // message.received mid-turn and must not clear the rest.
        if (beforeTurn && !isBackgroundUpdateText(data.message)) for (const id of beforeTurn) open.delete(id)
        beforeTurn = null
        break
      case 'input.requested':
        for (const r of Array.isArray(data.requests) ? data.requests : []) {
          const id = (r as { requestId?: unknown })?.requestId
          if (typeof id === 'string') open.add(id)
        }
        break
      case 'input.resolved':
        for (const r of Array.isArray(data.resolutions) ? data.resolutions : []) {
          const id = (r as { requestId?: unknown })?.requestId
          if (typeof id === 'string') open.delete(id)
        }
        break
      case 'approval.settled':
        if (typeof data.requestId === 'string') open.delete(data.requestId)
        break
      case 'turn.cancelled':
      case 'session.completed':
      case 'session.failed':
        open.clear()
        break
    }
  }
  return open.size > 0
}

/**
 * When the person last wrote into the session (a `message.received` that is
 * not a background update), as epoch ms; null when the tail holds none. An
 * approval turn drops the calls that ran before it (approvalsRanAfter): that
 * turn of theirs already had them in its context. Pure.
 */
export function lastPersonMessageAt(events: readonly HandleMessageStreamEvent[]): number | null {
  let last: number | null = null
  for (const ev of events) {
    if (ev.type !== 'message.received') continue
    const data = (ev as { data?: Record<string, unknown> }).data ?? {}
    if (isBackgroundUpdateText(data.message)) continue
    const at = Date.parse(String((ev as { meta?: { at?: unknown } }).meta?.at ?? ''))
    if (Number.isFinite(at) && (last === null || at > last)) last = at
  }
  return last
}

// ── A home thread with no live session ──────────────────────────────────────

/** What ensureHomeSession came to. */
export type EnsuredHomeSession =
  /** `created`: this call made the session (it holds nothing yet); else another caller's, registered first. */
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; reason: 'no_session' }

/** A value for a PostgREST filter: as is when plain (an eve session id is `wrun_…`), else quoted (the mint route's rule). */
function postgrestValue(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '')}"`
}

/**
 * Give a home thread a live eve session when it has none: no session
 * registered yet (`previous` null), or the one it names is gone (`previous`
 * that id, isSessionGoneError). Creates a MESSAGE-FREE session as the home
 * turn's server principal (eve parks it: no hooks, no model, nothing billed,
 * until the first send, which here is the home turn's own; the chat-agent's
 * server entry admits exactly this create for a home-turn token whose
 * conversation is a home thread), then registers it on the row with the mint
 * route's conditional guard: only while the row still holds nothing, or
 * `previous`. So it never races the person's own window: when their browser
 * registered a session first, that one wins, this parked one is left to
 * expire, and the turn queues onto theirs as any home turn does. Never
 * clears `eve_session_id`.
 *
 * `{ ok: false, reason: 'no_session' }` when no session can be had (no chat
 * secret here, or eve refused the create): the report shows on its own, as
 * before. Throws on a failed database write or an unexpected create failure
 * (the plan step retries; a session created before the throw only parks).
 */
export async function ensureHomeSession(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  args: { previous: string | null; /** A channel thread's conversation (414), not a home thread. */ channelThread?: boolean },
  io: HomeTurnIo = {},
): Promise<EnsuredHomeSession> {
  const secret = internalSecret()
  if (!secret) return { ok: false, reason: 'no_session' }
  let created: string
  try {
    const client = (io.makeClient ?? makeHomeTurnClient)({ secret, token: homeTurnToken(data) })
    // No `message` key: eve's client takes the message path for any object that has one.
    const { session } = await client.sessions.create({})
    created = session.state.sessionId
  } catch (err) {
    if (err instanceof ClientError) {
      console.warn(`[home-turn] session create refused (${err.status}${err.code ? ` ${err.code}` : ''}) for conversation ${data.conversationId}`)
      return { ok: false, reason: 'no_session' }
    }
    throw err
  }
  if (typeof created !== 'string' || !created) return { ok: false, reason: 'no_session' }

  const allowed = ['eve_session_id.is.null', ...(args.previous ? [`eve_session_id.eq.${postgrestValue(args.previous)}`] : [])]
  const channel = channelOfReason(data.reason)
  const scoped = supabase
    .from('chat_conversations')
    .update({ eve_session_id: created })
    .eq('id', data.conversationId)
    .eq('user_id', data.userId)
    .eq('workspace_id', data.workspaceId)
  // The kind the plan checked (serverTurnConversationOk), again on the write.
  const kind = !args.channelThread || !channel ? scoped.eq('is_home', true) : data.guestId ? scoped.eq('agent_guest_id', data.guestId) : scoped.eq('outside_channel', channel)
  const { data: won, error } = await kind
    .or(allowed.join(','))
    .select('id')
  if (error) throw new Error(`home turn: session register failed: ${error.message}`)
  if (Array.isArray(won) && won.length > 0) {
    console.info(`[home-turn] conversation=${data.conversationId} session=${args.previous ? 'replaced' : 'created'}`)
    return { ok: true, sessionId: created, created: true }
  }

  // Lost: someone registered a session first (the person's window, or a
  // racing run). Theirs is the thread's; this parked one expires unused.
  const { data: row, error: readError } = await supabase
    .from('chat_conversations')
    .select('eve_session_id')
    .eq('id', data.conversationId)
    .eq('user_id', data.userId)
    .eq('workspace_id', data.workspaceId)
    .maybeSingle<{ eve_session_id: string | null }>()
  if (readError) throw new Error(`home turn: session re-read failed: ${readError.message}`)
  const current = row?.eve_session_id ?? null
  if (current && current !== args.previous) return { ok: true, sessionId: current, created: false }
  return { ok: false, reason: 'no_session' }
}

/**
 * A check-in's own session (docs/plans/now-file.md "The check-in"): a fresh,
 * MESSAGE-FREE session created as the home turn's server principal with the
 * check-in's token (eve parks it: nothing runs or is billed until the send).
 * It is registered nowhere here: the claim puts its id on the check-in's
 * home_turn row, the only place the chat-agent's server entry looks for a
 * check-in token's session. Never the home thread's session, never a
 * primer. `{ ok: false }` when no session can be had (no chat secret here,
 * or eve refused the create); throws on an unexpected failure (the plan
 * step retries; a session created before the throw only parks).
 */
export async function createCheckInSession(data: HomeTurnRequestedData, io: HomeTurnIo = {}): Promise<{ ok: true; sessionId: string } | { ok: false }> {
  if (data.reason !== 'check_in') return { ok: false }
  const secret = internalSecret()
  if (!secret) return { ok: false }
  try {
    const client = (io.makeClient ?? makeHomeTurnClient)({ secret, token: homeTurnToken(data) })
    // No `message` key: eve's client takes the message path for any object that has one.
    const { session } = await client.sessions.create({})
    const id = session.state.sessionId
    return typeof id === 'string' && id ? { ok: true, sessionId: id } : { ok: false }
  } catch (err) {
    if (err instanceof ClientError) {
      console.warn(`[home-turn] check-in session create refused (${err.status}${err.code ? ` ${err.code}` : ''}) for conversation ${data.conversationId}`)
      return { ok: false }
    }
    throw err
  }
}

/**
 * The longest message a home turn may send: the chat-agent's server entry
 * refuses anything longer (agents/chat-agent/lib/auth.ts SERVER_SEND_MAX_CHARS).
 */
export const HOME_TURN_SEND_MAX_CHARS = 32_000
/** The most of that a primer may take (the ordinary primer's 24K plus its frame), leaving room for the update. */
export const HOME_TURN_PRIMER_MAX_CHARS = 25_000

/**
 * The history a fresh session's first message carries: the home primer (the
 * last checkpoint plus the messages since) when the thread has one that
 * fits, else the ordinary 40-message primer, the mint's own choice. Null when
 * there is nothing to carry or the read failed (the turn goes without it).
 */
export async function renderFreshSessionPrimer(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  /** The messages the turn carries itself (a channel turn's): never in its own history too. */
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  const ids = { conversationId: data.conversationId, userId: data.userId, workspaceId: data.workspaceId }
  const home = await renderHomePrimer(supabase, ids, exclude).catch(() => null)
  if (home && home.length <= HOME_TURN_PRIMER_MAX_CHARS) return home
  const plain = await renderConversationPrimer(supabase, ids, exclude).catch(() => null)
  return plain && plain.length <= HOME_TURN_PRIMER_MAX_CHARS ? plain : null
}

/**
 * The update with the fresh session's history after it. The update leads (it
 * must open the message: every reader of a background update matches its
 * first line), and the primer follows. Without the primer when the two
 * together would pass HOME_TURN_SEND_MAX_CHARS: the update matters more.
 */
export function withHomeTurnPrimer(body: string, primer: string | null | undefined, opts: { lead?: boolean } = {}): string {
  if (!primer) return body
  // A channel turn's message is the PERSON's words: the primer leads, so the
  // chat-agent's personText (which cuts a leading <conversation-so-far>
  // block) never counts the restored history as something they said, and
  // the primer's own words ("context for the message after this block") hold.
  const joined = opts.lead
    ? `${primer}\n\n${body}`
    : `${body}\n\nThis thread just moved to a new session. Its history, restored for context (not part of the update above):\n${primer}`
  return joined.length <= HOME_TURN_SEND_MAX_CHARS ? joined : body
}

/**
 * Step 1. Never throws for an expected stop (a failed database read is
 * `lookup_failed`); the session tail read throws, so the step retries.
 */
export async function planHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  deps: {
    checkUsage?: (userId: string) => Promise<unknown>
    now?: number
    peekTail?: (sessionId: string) => Promise<SessionTail>
    /** Give the thread a session (ensureHomeSession); `previous` is the gone one, null for none. */
    ensureSession?: (previous: string | null) => Promise<EnsuredHomeSession>
    /** The history a fresh session's first message carries (renderFreshSessionPrimer). */
    renderPrimer?: () => Promise<string | null>
    /** What a check-in carries (src/lib/now/check-in.ts gatherCheckIn). */
    gatherCheckIn?: (args: Parameters<typeof gatherCheckIn>[1]) => Promise<CheckInGather>
    /** A check-in's own fresh session (createCheckInSession). */
    createCheckInSession?: () => Promise<{ ok: true; sessionId: string } | { ok: false }>
  } = {},
): Promise<HomeTurnPlanResult> {
  let checked: {
    sessionId: string | null
    reports: PlannedReport[]
    workItemIds: string[]
    dedupeKey: string
    digest?: HomeTurnDigest
    events?: HomeTurnEvents
    guestAsks?: HomeTurnGuestAsks
    agentAnswers?: HomeTurnAgentAnswers
    checkIn?: HomeTurnCheckIn
    approvals?: HomeTurnApprovals
    channelMessages?: PlannedChannelMessage[]
    channelPlace?: 'direct' | 'thread'
    record: NonNullable<Extract<HomeTurnPlanResult, { ok: false }>['record']>
    chatgptPlan: boolean
  }
  // A channel turn in the person's own conversation for a Slack thread (414), not their home thread.
  let channelThread = false
  try {
    if (!(HOME_TURN_REASONS as readonly string[]).includes(data.reason)) {
      return { ok: false, reason: 'unsupported_reason' }
    }
    if (data.reason === 'digest' && !data.digestDate) return { ok: false, reason: 'bad_event' }
    if (data.reason === 'check_in' && !data.checkInSlot) return { ok: false, reason: 'bad_event' }

    const readConversation = (columns: string) =>
      supabase
        .from('chat_conversations')
        .select(columns)
        .eq('id', data.conversationId)
        .eq('user_id', data.userId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle<ConversationRow>()
    let { data: conv, error } = await readConversation('id, eve_session_id, is_home, outside_channel, agent_guest_id')
    // A database without migration 427 (no conversation is a guest's yet), or 414 (nor a channel's).
    if (error?.code === UNDEFINED_COLUMN) ({ data: conv, error } = await readConversation('id, eve_session_id, is_home, outside_channel'))
    if (error?.code === UNDEFINED_COLUMN) ({ data: conv, error } = await readConversation('id, eve_session_id, is_home'))
    if (error) return { ok: false, reason: 'lookup_failed' }
    if (!conv) return { ok: false, reason: 'no_conversation' }
    if (!serverTurnConversationOk(conv, data.reason)) return { ok: false, reason: 'not_home' }
    if (!guestTurnConversationOk(conv, data)) return { ok: false, reason: 'not_home' }
    channelThread = conv.is_home !== true

    // Still a member now: someone removed since the report is never sent a turn (or billed).
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', data.userId)
      .eq('workspace_id', data.workspaceId)
      .maybeSingle<{ id: string }>()
    if (memberError) return { ok: false, reason: 'lookup_failed' }
    if (!member) return { ok: false, reason: 'not_member' }

    let reports: PlannedReport[] = []
    let workItemIds: string[] = []
    let dedupeKey: string
    let digest: HomeTurnDigest | undefined
    let events: HomeTurnEvents | undefined
    let guestAsks: HomeTurnGuestAsks | undefined
    let agentAnswers: HomeTurnAgentAnswers | undefined
    let checkIn: HomeTurnCheckIn | undefined
    let approvals: HomeTurnApprovals | undefined
    let channelMessages: PlannedChannelMessage[] | undefined
    if (channelOfReason(data.reason)) {
      // The person's messages no earlier turn of the channel carried (never the payload's word for which).
      const pending = await undeliveredChannelMessages(supabase, data, data.reason, deps.now)
      if (pending.length === 0) return { ok: false, reason: 'nothing_new' }
      channelMessages = pending
      dedupeKey = homeTurnDedupeKey(data.reason, pending.map((m) => m.messageId))
    } else if (data.reason === 'event') {
      // The router's turn rows (never the payload's word for which): every
      // undelivered one, minus what settled since the router saw it.
      const rows = await gatherEventTurn(supabase, { workspaceId: data.workspaceId, userId: data.userId, nowMs: deps.now })
      // A meeting change names its times in the person's zone (the digest's chain); read only when one is here.
      let zone: string | null = null
      if (rows.some((r) => r.kind === 'meeting.changed')) {
        const { data: zoneRow } = await supabase.from('member').select('time_zone').eq('id', member.id).maybeSingle<{ time_zone: string | null }>()
        zone = (await resolveMemberTimeZone(supabase, { userId: data.userId, memberTimeZone: zoneRow?.time_zone })).timeZone
      }
      const body = eventTurnBody(rows, zone)
      if (!body) return { ok: false, reason: 'nothing_new' }
      events = body
      dedupeKey = homeTurnDedupeKey('event', body.eventIds)
    } else if (data.reason === 'guest_ask') {
      // The guests' asks no turn carried (never the payload's word for which).
      const gathered = await gatherGuestAsks(supabase, { userId: data.userId, workspaceId: data.workspaceId }, deps.now)
      if (!gathered) return { ok: false, reason: 'nothing_new' }
      guestAsks = gathered
      dedupeKey = homeTurnDedupeKey('guest_ask', gathered.askIds)
    } else if (data.reason === 'agent_answer') {
      // The linked agents' answers no turn carried (never the payload's word for which).
      const gathered = await gatherAgentAnswers(supabase, { userId: data.userId, workspaceId: data.workspaceId }, deps.now)
      if (!gathered) return { ok: false, reason: 'nothing_new' }
      agentAnswers = gathered
      dedupeKey = homeTurnDedupeKey('agent_answer', gathered.messageIds)
    } else if (data.reason === 'approval') {
      // The calls the person's yes ran here that no turn carried (never the payload's word for which).
      const gathered = await gatherApprovalTurn(supabase, { conversationId: data.conversationId, userId: data.userId, workspaceId: data.workspaceId }, deps.now)
      if (!gathered) return { ok: false, reason: 'nothing_new' }
      approvals = gathered
      dedupeKey = homeTurnDedupeKey('approval', gathered.approvalIds)
    } else if (data.reason === 'digest') {
      // The daily digest (A6 slice 4): re-read the rows the cron named (never
      // trusting the payload for what they say) and the log since the last one.
      const date = data.digestDate as string
      const { data: zoneRow } = await supabase.from('member').select('time_zone').eq('id', member.id).maybeSingle<{ time_zone: string | null }>()
      // The same zone chain the cron keyed the date on (pickTimeZone), so the
      // body's times read in the zone the digest was scheduled in.
      const { timeZone: zone } = await resolveMemberTimeZone(supabase, { userId: data.userId, memberTimeZone: zoneRow?.time_zone })
      const gathered = await gatherDigest(supabase, {
        workspaceId: data.workspaceId,
        userId: data.userId,
        conversationId: data.conversationId,
        date,
        nowMs: deps.now,
        eventIds: data.eventIds,
      })
      const body = digestBody(gathered, { date, timeZone: zone })
      if (!body) return { ok: false, reason: 'nothing_new' }
      digest = body
      dedupeKey = digestTurnKey(date)
    } else if (data.reason === 'check_in') {
      // The check-in (docs/plans/now-file.md): re-read the note and what is
      // due (never trusting the payload for which), in the zone the cron keyed
      // the slot on.
      const slot = data.checkInSlot as { date: string; hour: number }
      const { data: zoneRow } = await supabase.from('member').select('time_zone').eq('id', member.id).maybeSingle<{ time_zone: string | null }>()
      const { timeZone: zone } = await resolveMemberTimeZone(supabase, { userId: data.userId, memberTimeZone: zoneRow?.time_zone })
      const gathered = await (deps.gatherCheckIn ?? ((args: Parameters<typeof gatherCheckIn>[1]) => gatherCheckIn(supabase, args)))({
        workspaceId: data.workspaceId,
        userId: data.userId,
        memberId: member.id,
        conversationId: data.conversationId,
        date: slot.date,
        hour: slot.hour,
        timeZone: zone,
        nowMs: deps.now,
      })
      if (!gathered.ok) return { ok: false, reason: 'nothing_new' }
      checkIn = gathered.body
      dedupeKey = checkInTurnKey(slot.date, slot.hour)
    } else {
      reports = await undeliveredReports(supabase, data, deps.now)
      if (reports.length === 0) return { ok: false, reason: 'nothing_new' }
      workItemIds = [...new Set([...data.workItemIds, ...reports.map((r) => r.report.work_item_id)])].slice(0, 50)
      dedupeKey = homeTurnDedupeKey(data.reason, reports.map((r) => r.messageId))
    }
    // A check-in's row never names the home thread's session (it runs in one of its own).
    const record = { dedupeKey, reports, workItemIds, sessionId: checkIn ? null : conv.eve_session_id, ...(channelMessages ? { channelMessages } : {}) }

    // Autonomy off stops the agent acting on its own, the router included (§5).
    // FAILS CLOSED (A6 review): a turn spends money, so a switch that can't be
    // read is off; what it carried waits for the next turn and the away section.
    // A channel turn is the person speaking, not the agent acting on its own:
    // like their own chat, it runs whatever the switch says.
    if (!channelMessages && (await readAgentPausedState(supabase, data.workspaceId)) !== 'active') return { ok: false, reason: 'autonomy_off', record }

    // Billed to the person (decision 8): never past their limits. Opted in to
    // the ChatGPT free tier: a person on their own plan passes, and the turn's
    // rebuild runs it on their plan (chat-run-rebuild.ts), never Dial8's models.
    let chatgptPlan: boolean
    try {
      const usage = await (deps.checkUsage ?? ((userId: string) => checkUsageLimits(userId, undefined, { chatgptPlan: true })))(data.userId)
      chatgptPlan = isChatGptPlanUsage(usage as { reason?: string | null } | null | undefined)
    } catch (err) {
      if (err instanceof Response && err.status === 429) return { ok: false, reason: 'usage_limited', record }
      return { ok: false, reason: 'usage_check_failed' }
    }

    // No eve session yet is not a stop: the thread gets one below (ensureHomeSession).
    checked = {
      sessionId: conv.eve_session_id,
      reports,
      workItemIds,
      dedupeKey,
      ...(digest ? { digest } : {}),
      ...(events ? { events } : {}),
      ...(guestAsks ? { guestAsks } : {}),
      ...(agentAnswers ? { agentAnswers } : {}),
      ...(checkIn ? { checkIn } : {}),
      ...(approvals ? { approvals } : {}),
      ...(channelMessages ? { channelMessages, channelPlace: channelThread ? ('thread' as const) : ('direct' as const) } : {}),
      record,
      chatgptPlan,
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }

  // A check-in runs in a FRESH session of its own (see the header): never
  // the thread's session, its tail or its primer. The claim registers it on
  // the check-in's row; the read starts at its first event.
  if (checked.checkIn) {
    const created = await (deps.createCheckInSession ?? (() => createCheckInSession(data)))()
    if (!created.ok) return { ok: false, reason: 'no_session', record: checked.record }
    return {
      ok: true,
      sessionId: created.sessionId,
      fromIndex: 0,
      reports: [],
      workItemIds: [],
      dedupeKey: checked.dedupeKey,
      checkIn: checked.checkIn,
      ...(checked.chatgptPlan ? { chatgptPlan: true as const } : {}),
    }
  }

  // The session's tail (throws: the step retries). Parked on the person's
  // question: no turn now, the report waits for their next message. A
  // session that is gone, or none at all, is replaced by a fresh one
  // (ensureHomeSession), registered only where nothing newer stands.
  const peek = deps.peekTail ?? ((id: string) => peekSessionTail(data, id))
  let sessionId = checked.sessionId
  let tail: SessionTail | null = null
  let gone: string | null = null
  if (sessionId) {
    try {
      tail = await peek(sessionId)
    } catch (err) {
      if (!isSessionGoneError(err)) throw err
      gone = sessionId
      sessionId = null
    }
  }
  if (!sessionId) {
    const ensured = await (deps.ensureSession ?? ((previous: string | null) => ensureHomeSession(supabase, data, { previous, channelThread })))(gone)
    if (!ensured.ok) return { ok: false, reason: ensured.reason, record: checked.record }
    sessionId = ensured.sessionId
    // A session this run just created holds nothing yet; another caller's is read as any other.
    tail = ensured.created ? { tailIndex: -1, events: [] } : await peek(sessionId)
  }
  if (!tail) throw new Error('home turn: no session tail')
  if (hasOpenInputRequest(tail.events)) return { ok: false, reason: 'question_pending', record: { ...checked.record, sessionId } }
  // An approval turn: the person wrote after a call ran, so their own turn
  // already had its outcome and carried on from it. Only the rest is news.
  let approvals = checked.approvals
  let dedupeKey = checked.dedupeKey
  const personAt = approvals ? lastPersonMessageAt(tail.events) : null
  if (approvals && personAt !== null) {
    approvals = approvalsRanAfter(approvals, personAt) ?? undefined
    if (!approvals) return { ok: false, reason: 'nothing_new' }
    dedupeKey = homeTurnDedupeKey('approval', approvals.approvalIds)
  }
  // A session with no events yet knows nothing of the thread: its first
  // message carries the history (A3's re-prime), as the browser's would.
  // A channel turn's own messages are its body: never in its history too.
  const carried = checked.channelMessages ? new Set(checked.channelMessages.map((m) => m.messageId)) : undefined
  const primer = tail.tailIndex < 0 ? await (deps.renderPrimer ?? (() => renderFreshSessionPrimer(supabase, data, carried)))().catch(() => null) : null
  return {
    ok: true,
    sessionId,
    fromIndex: tail.tailIndex + 1,
    reports: checked.reports,
    workItemIds: checked.workItemIds,
    dedupeKey,
    ...(checked.digest ? { digest: checked.digest } : {}),
    ...(checked.events ? { events: checked.events } : {}),
    ...(checked.guestAsks ? { guestAsks: checked.guestAsks } : {}),
    ...(checked.agentAnswers ? { agentAnswers: checked.agentAnswers } : {}),
    ...(approvals ? { approvals } : {}),
    ...(checked.channelMessages ? { channelMessages: checked.channelMessages, channelPlace: checked.channelPlace ?? 'direct' } : {}),
    ...(primer ? { primer } : {}),
    ...(checked.chatgptPlan ? { chatgptPlan: true as const } : {}),
  }
}

/** The row as the steps carry it. */
export interface HomeTurnRow {
  id: string
  status: HomeTurnStatus
  eve_session_id: string | null
  eve_turn_id: string | null
  stream_position: number | null
  error?: string | null
  created_at?: string | null
  updated_at?: string | null
}

const ROW_SELECT = 'id, status, eve_session_id, eve_turn_id, stream_position, error, created_at, updated_at'

/** Record a skip that had something to deliver (best-effort; a duplicate is fine). */
export async function recordSkippedHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  skip: { reason: HomeTurnSkip; record: NonNullable<Extract<HomeTurnPlanResult, { ok: false }>['record']> },
): Promise<void> {
  try {
    await supabase.from('home_turn').insert({
      conversation_id: data.conversationId,
      user_id: data.userId,
      workspace_id: data.workspaceId,
      reason: data.reason,
      work_item_ids: skip.record.workItemIds,
      report_message_ids: skip.record.reports.map((r) => r.messageId),
      dedupe_key: skip.record.dedupeKey,
      status: 'skipped',
      eve_session_id: skip.record.sessionId,
      error: skip.reason,
      ...channelColumns(data.reason, skip.record.channelMessages),
    })
  } catch {
    // Best-effort: an unrecorded skip only means a later turn may mention the report.
  }
}

export type HomeTurnClaim =
  | { kind: 'claimed' | 'resumed'; row: HomeTurnRow }
  | { kind: 'duplicate'; status: HomeTurnStatus }
  /** Another home turn in this conversation holds the lease (claimed or sent, fresh): try again later. */
  | { kind: 'busy'; holder: string }

interface LeaseRow {
  id?: unknown
  dedupe_key?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

/**
 * The other home turns in this conversation that hold its lease: claimed or
 * sent, touched within HOME_TURN_RESUME_AFTER_MS (a staler one belongs to a
 * run that died), under another dedupe key (the same key is this turn's own
 * claim, handled by the unique index). Inngest's concurrency key limits
 * steps, not runs, so a digest and a helper's report could otherwise be
 * sent and read at once in one conversation. Throws on a failed read.
 */
async function leaseHolders(supabase: SupabaseClient, conversationId: string, dedupeKey: string, now: number): Promise<LeaseRow[]> {
  const { data, error } = await supabase
    .from('home_turn')
    .select('id, dedupe_key, status, created_at, updated_at')
    .eq('conversation_id', conversationId)
    .in('status', ['claimed', 'sent'])
    .order('created_at', { ascending: true })
    .limit(20)
  if (error) throw new Error(`home turn lease: ${error.message}`)
  return ((data as LeaseRow[] | null) ?? []).filter((r) => r.dedupe_key !== dedupeKey && !isOlderThan(r.updated_at, HOME_TURN_RESUME_AFTER_MS, now))
}

/** True when `a` was claimed before `b` (created_at, then id): the older claim keeps the lease. */
function claimedBefore(a: LeaseRow, b: { id: string; created_at?: unknown }): boolean {
  const ta = typeof a.created_at === 'string' ? Date.parse(a.created_at) : NaN
  const tb = typeof b.created_at === 'string' ? Date.parse(b.created_at) : NaN
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb
  return String(a.id) < b.id
}

/**
 * Step 2: insert the claim. A unique violation is this turn claimed before:
 *   - a `claimed` or `sent` row no step touched for HOME_TURN_RESUME_AFTER_MS
 *     belongs to a run that died: this run resumes it;
 *   - a fresher one is another run's, still going: a duplicate (two runs
 *     never both read and persist one turn);
 *   - a row that failed before eve accepted anything is claimed again;
 *   - anything else settled is a duplicate.
 * One home turn per conversation at a time (A6 review): while another turn
 * there holds the lease (claimed or sent, fresh), the answer is `busy` and
 * nothing is written; two claims that race past that check both insert, and
 * the newer one gives way (its row failed `lease_busy`, which carried nothing,
 * so it is claimed again later). Throws on anything else (nothing has been
 * sent).
 */
export async function claimHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  now: number = Date.now(),
): Promise<HomeTurnClaim> {
  const holders = await leaseHolders(supabase, data.conversationId, plan.dedupeKey, now)
  if (holders.length > 0) return { kind: 'busy', holder: String(holders[0].id) }
  const claim = await claimRow(supabase, data, plan, now)
  if (claim.kind !== 'claimed' && claim.kind !== 'resumed') return claim
  // A claim that raced past the check: the older one keeps the lease.
  const own = claim.row as HomeTurnRow & { created_at?: unknown }
  const racing = (await leaseHolders(supabase, data.conversationId, plan.dedupeKey, now)).filter((r) => claimedBefore(r, own))
  if (racing.length > 0 && claim.kind === 'claimed') {
    await updateRow(supabase, own.id, { status: 'failed', error: 'lease_busy' })
    return { kind: 'busy', holder: String(racing[0].id) }
  }
  return claim
}

async function claimRow(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  now: number,
): Promise<HomeTurnClaim> {
  const { data: inserted, error } = await supabase
    .from('home_turn')
    .insert({
      conversation_id: data.conversationId,
      user_id: data.userId,
      workspace_id: data.workspaceId,
      reason: data.reason,
      work_item_ids: plan.workItemIds,
      report_message_ids: plan.reports.map((r) => r.messageId),
      dedupe_key: plan.dedupeKey,
      status: 'claimed',
      eve_session_id: plan.sessionId,
      ...channelColumns(data.reason, plan.channelMessages),
    })
    .select(ROW_SELECT)
    .single<HomeTurnRow>()
  if (!error && inserted) return { kind: 'claimed', row: inserted }
  if (error?.code !== '23505') throw new Error(`home turn claim: ${error?.message ?? 'no row'}`)

  const { data: existing, error: readError } = await supabase
    .from('home_turn')
    .select(ROW_SELECT)
    .eq('conversation_id', data.conversationId)
    .eq('dedupe_key', plan.dedupeKey)
    .maybeSingle<HomeTurnRow>()
  if (readError) throw new Error(`home turn claim: ${readError.message}`)
  if (!existing) throw new Error('home turn claim: conflicting row not found')
  if (existing.status === 'claimed' || existing.status === 'sent') {
    // A check-in's row names the session ITS plan created, not this one's: a
    // check-in never resumes another run's (the next slot catches up instead).
    if (data.reason === 'check_in') return { kind: 'duplicate', status: existing.status }
    return isOlderThan(existing.updated_at, HOME_TURN_RESUME_AFTER_MS, now)
      ? { kind: 'resumed', row: existing }
      : { kind: 'duplicate', status: existing.status }
  }
  if (existing.status === 'failed' && failedBeforeAccept(existing.error)) {
    const { data: retaken, error: retakeError } = await supabase
      .from('home_turn')
      .update({
        status: 'claimed',
        error: null,
        stream_position: null,
        eve_session_id: plan.sessionId,
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', existing.id)
      .eq('status', 'failed')
      .select(ROW_SELECT)
    if (retakeError) throw new Error(`home turn claim: ${retakeError.message}`)
    const row = Array.isArray(retaken) ? (retaken[0] as HomeTurnRow | undefined) : undefined
    if (row) return { kind: 'claimed', row }
  }
  return { kind: 'duplicate', status: existing.status }
}

/** Settle or annotate a row (and touch its lease). Never throws. */
async function updateRow(supabase: SupabaseClient, rowId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('home_turn').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', rowId)
    if (error) console.warn('[home-turn] row update failed', rowId, error.message)
  } catch (err) {
    console.warn('[home-turn] row update failed', rowId, err instanceof Error ? err.message : String(err))
  }
}

// ── Reading the turn ─────────────────────────────────────────────────────────

/** Where the reading stands between steps (JSON: an Inngest step output). */
export interface HomeTurnReadState {
  nextIndex: number
  /** The delivery ids of this turn's own message: from the send, else from its message.received. */
  ownDeliveryIds: string[] | null
  /** Whether the turn's first own event was seen (events before it belong to earlier turns). */
  seenOwn: boolean
  eveTurnId: string | null
  parts: EveTurnPartsSnapshot
}

/** How a read ended. */
export type HomeTurnReadEnd =
  /** The turn completed (or parked: nobody can answer it, so the read ends there). */
  | 'completed'
  | 'cancelled'
  | 'failed'
  /** The person's message folded into this turn: the rest is theirs (the browser renders it). */
  | 'steered'
  /** The session ended before the turn did. */
  | 'session_ended'

export type HomeTurnReadResult =
  | { done: true; end: HomeTurnReadEnd; state: HomeTurnReadState }
  | { done: false; state: HomeTurnReadState }

const TURN_ENDS: ReadonlySet<string> = new Set(['turn.completed', 'turn.failed', 'turn.cancelled'])
const SESSION_ENDS: ReadonlySet<string> = new Set(['session.completed', 'session.failed'])

/** What one event is to this turn. */
export type HomeTurnAttribution = 'before' | 'own' | 'foreign'

/**
 * Attribute one event to the home turn (UI-2's attributeEvent, ported: the
 * server never adopts a foreign id).
 *
 * Until the turn's first own event, everything is 'before' (an earlier turn
 * it queued behind). That first event is the first one carrying the delivery
 * id the send returned; without it (a retried step that lost it), the
 * message.received whose text carries `tag`, which then teaches the ids. If
 * that first event already carries another delivery id too (the person's
 * message folded in from the start), it is 'foreign'.
 *
 * After it, an event whose ids are all the turn's own (or that carries none)
 * is 'own'; one carrying any other id is 'foreign': the person's message
 * folded in.
 */
export function attributeHomeTurnEvent(
  event: HandleMessageStreamEvent,
  tag: string,
  own: string[] | null,
  seenOwn: boolean,
): { verdict: HomeTurnAttribution; own: string[] | null; seenOwn: boolean } {
  const ids = (event as { meta?: { deliveryIds?: readonly string[] } }).meta?.deliveryIds ?? []
  if (!seenOwn) {
    if (own && own.length > 0) {
      if (!ids.some((id) => own.includes(id))) return { verdict: 'before', own, seenOwn }
      return { verdict: ids.every((id) => own.includes(id)) ? 'own' : 'foreign', own, seenOwn: true }
    }
    if (event.type !== 'message.received') return { verdict: 'before', own, seenOwn }
    const text = (event as { data?: { message?: unknown } }).data?.message
    if (typeof text !== 'string' || !text.includes(tag)) return { verdict: 'before', own, seenOwn }
    if (ids.length !== 1) return { verdict: 'foreign', own: [...ids], seenOwn: true }
    return { verdict: 'own', own: [...ids], seenOwn: true }
  }
  if (ids.length === 0 || (own !== null && ids.every((id) => own.includes(id)))) return { verdict: 'own', own, seenOwn }
  return { verdict: 'foreign', own, seenOwn }
}

/** A fresh read state for a home turn row (with the send's delivery id, when known). */
export function newHomeTurnReadState(rowId: string, fromIndex: number, deliveryId?: string | null): HomeTurnReadState {
  return {
    nextIndex: fromIndex,
    ownDeliveryIds: deliveryId ? [deliveryId] : null,
    seenOwn: false,
    eveTurnId: null,
    parts: snapshotEveTurnParts(createEveTurnPartsState(homeTurnMessageId(rowId))),
  }
}

/** eve's request id for a prompt on the lifetime INPUT budget (`…:limit:input:<used>`, harness/hitl/budget-request.js). */
const INPUT_BUDGET_REQUEST_RE = /:limit:input:\d+$/

/**
 * The input-budget prompts in an `input.requested` event: their request ids.
 * The main chat has no input budget (agents/chat-agent/agent.ts); a session
 * created before keeps eve's 40M default, and its prompt has one right answer.
 */
export function inputBudgetRequestIds(event: HandleMessageStreamEvent): string[] {
  if (event.type !== 'input.requested') return []
  const requests = (event.data as { requests?: unknown } | undefined)?.requests
  if (!Array.isArray(requests)) return []
  return requests
    .filter((r): r is { kind: string; requestId: string } => !!r && typeof r === 'object' && (r as { kind?: unknown }).kind === 'session-limit')
    .map((r) => r.requestId)
    .filter((id) => typeof id === 'string' && INPUT_BUDGET_REQUEST_RE.test(id))
}

/**
 * Read the turn from `state.nextIndex` until its boundary, a foreign event,
 * the end of the session, or the budget (then `done: false`, to continue in
 * the next step). Pure over the event source: the stream comes in, the
 * reduced parts and the cursor go out. When `signal` aborts (the step's
 * budget), the source throws: the read hands back the cursor and parts it
 * reached. Anything else the source throws is rethrown.
 *
 * `continueBudget` answers Continue on eve's input-budget prompt
 * (inputBudgetRequestIds) when the turn parks on one, once per request: the
 * turn then goes on and the read follows it on the same stream. A text or a
 * Slack message never waits on a button nobody can press there. A failed
 * answer leaves the turn parked, as before.
 */
export async function readHomeTurnEvents(
  events: AsyncIterable<HandleMessageStreamEvent>,
  rowId: string,
  start: HomeTurnReadState,
  signal?: AbortSignal,
  continueBudget?: (requestId: string) => Promise<void>,
): Promise<HomeTurnReadResult> {
  const tag = homeTurnTag(rowId)
  const parts: EveTurnPartsState = restoreEveTurnParts(start.parts)
  let own = start.ownDeliveryIds
  let seenOwn = start.seenOwn === true
  let eveTurnId = start.eveTurnId
  let nextIndex = start.nextIndex
  const sink = { emit: () => {} }
  const state = (): HomeTurnReadState => ({ nextIndex, ownDeliveryIds: own, seenOwn, eveTurnId, parts: snapshotEveTurnParts(parts) })

  try {
    for await (const event of events) {
      nextIndex += 1
      const a = attributeHomeTurnEvent(event, tag, own, seenOwn)
      own = a.own
      seenOwn = a.seenOwn
      if (a.verdict === 'before') continue
      if (a.verdict === 'foreign') return { done: true, end: 'steered', state: state() }
      const turnId = (event as { data?: { turnId?: unknown } }).data?.turnId
      if (!eveTurnId && typeof turnId === 'string' && turnId) eveTurnId = turnId
      applyEveTurnEvent(parts, event, sink)
      if (continueBudget) {
        for (const requestId of inputBudgetRequestIds(event)) {
          try {
            await continueBudget(requestId)
          } catch (err) {
            console.warn('[home-turn] input budget continue failed', { rowId, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      if (TURN_ENDS.has(event.type)) {
        const end: HomeTurnReadEnd = event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed'
        return { done: true, end, state: state() }
      }
      if (SESSION_ENDS.has(event.type)) return { done: true, end: 'session_ended', state: state() }
    }
  } catch (err) {
    if (signal?.aborted) return { done: false, state: state() }
    throw err
  }
  return { done: false, state: state() }
}

/** The chat-agent as the home turn's server principal: the chat secret and the run token, no user credential. */
export function makeHomeTurnClient(args: { secret: string; token: string }): Client {
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

/** The session, attached as the home turn's server principal with a fresh token (null: no chat secret here). */
function attachSession(
  data: HomeTurnRequestedData,
  sessionId: string,
  streamIndex: number,
  io: HomeTurnIo,
  use: 'send' | 'read' = 'read',
  chatgptPlan = false,
): ClientSession | null {
  const secret = internalSecret()
  if (!secret) return null
  return (io.makeClient ?? makeHomeTurnClient)({ secret, token: homeTurnToken(data, use, chatgptPlan) }).sessions.attach(sessionId, { streamIndex })
}

/**
 * The delivery id eve returned for an accepted send. eve 0.66.3 keeps it on
 * the MessageResponse under an own `Symbol('acceptedDeliveryId')` (its reader,
 * getMessageResponseDeliveryId, is internal to eve/client); a drift test pins
 * that shape. Null when it isn't there: the read falls back to the tag.
 */
export function acceptedDeliveryIdOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  for (const sym of Object.getOwnPropertySymbols(response)) {
    if (sym.description !== 'acceptedDeliveryId') continue
    const id = (response as Record<symbol, unknown>)[sym]
    return typeof id === 'string' && id.length > 0 ? id : null
  }
  return null
}

/** One budgeted read from the session's stream, from the state's cursor. */
/**
 * Continue on an input-budget prompt, through a session attached with the
 * turn's SEND token (null: no secret). Never the read token: eve leaves the
 * responder as the turn's auth when the answer is stale (a retried step
 * re-reading a prompt it already answered), and the read token is short and
 * carries no plan claim. Its response isn't read: the turn's events come on
 * the session stream.
 */
function budgetContinuer(sendSession: () => ClientSession | null): (requestId: string) => Promise<void> {
  return async (requestId) => {
    const session = sendSession()
    if (!session) throw new Error('server_auth_unavailable')
    await session.respond([{ requestId, optionId: 'continue' }])
  }
}

async function readBudgeted(
  session: ClientSession,
  rowId: string,
  start: HomeTurnReadState,
  budgetMs: number,
  continueBudget?: (requestId: string) => Promise<void>,
): Promise<HomeTurnReadResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), budgetMs)
  try {
    const events = session.stream({ startIndex: start.nextIndex, signal: ac.signal }) as AsyncIterable<HandleMessageStreamEvent>
    return await readHomeTurnEvents(events, rowId, start, ac.signal, continueBudget)
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}

/** What a send or read step hands the consumer. */
export type HomeTurnStepResult =
  | { kind: 'read'; result: HomeTurnReadResult }
  /** Nothing was sent (or the send can't be confirmed): the row is failed. */
  | { kind: 'failed'; error: string }

/**
 * Step 3: send the message (once), then read. The row moves claimed → sent
 * TOGETHER with the turn's start index (the plan's tail), in one conditional
 * update, before anything is sent: a retried step finds the row `sent` and
 * reads from that index instead of sending again, and a crash after the send
 * still knows where the turn is. A failed move fails the step (nothing sent).
 */
export async function sendHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: HomeTurnRow,
  io: HomeTurnIo = {},
): Promise<HomeTurnStepResult> {
  const budgetMs = io.budgetMs ?? HOME_TURN_STEP_BUDGET_MS
  const { data: moved, error: moveError } = await supabase
    .from('home_turn')
    .update({ status: 'sent', stream_position: plan.fromIndex, eve_session_id: plan.sessionId, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'claimed')
    .select('id')
  if (moveError) throw new Error(`home turn send: ${moveError.message}`)

  if (!Array.isArray(moved) || moved.length === 0) {
    // Already sent by an earlier attempt of this step: read from where its turn starts.
    const { data: current } = await supabase.from('home_turn').select(ROW_SELECT).eq('id', row.id).maybeSingle<HomeTurnRow>()
    if (current?.status !== 'sent' || current.stream_position == null) return { kind: 'failed', error: 'send_unconfirmed' }
    return continueHomeTurn(supabase, data, plan, row, newHomeTurnReadState(row.id, current.stream_position), io)
  }

  const update = buildHomeTurnBody(row.id, data.reason, {
    reports: plan.reports.map((r) => r.report),
    digest: plan.digest ?? null,
    events: plan.events ?? null,
    guestAsks: plan.guestAsks ?? null,
    agentAnswers: plan.agentAnswers ?? null,
    checkIn: plan.checkIn ?? null,
    approvals: plan.approvals ?? null,
    channelMessages: plan.channelMessages ?? [],
    channelPlace: plan.channelPlace,
  })
  const body = update ? withHomeTurnPrimer(update, plan.primer, { lead: channelOfReason(data.reason) !== null }) : null
  if (!body) {
    await updateRow(supabase, row.id, { status: 'failed', error: 'empty_body' })
    return { kind: 'failed', error: 'empty_body' }
  }

  let session: ClientSession | null
  try {
    session = attachSession(data, plan.sessionId, plan.fromIndex, io, 'send', plan.chatgptPlan === true)
  } catch {
    session = null
  }
  if (!session) {
    await updateRow(supabase, row.id, { status: 'failed', error: 'server_auth_unavailable' })
    return { kind: 'failed', error: 'server_auth_unavailable' }
  }

  let response: MessageResponse
  try {
    // The POST is accepted when this resolves; the response stream is not read
    // (the read below follows the session stream from the known start index).
    response = await session.send(body, { turnPolicy: 'queue' })
  } catch (err) {
    // A ClientError is eve's own refusal (nothing accepted); anything else may
    // have landed, so it counts as carried (send_failed).
    const error = err instanceof ClientError ? `send_refused_${err.status}${err.code ? `_${err.code}` : ''}` : 'send_failed'
    await updateRow(supabase, row.id, { status: 'failed', error: error.slice(0, 200) })
    return { kind: 'failed', error }
  }
  const start = newHomeTurnReadState(row.id, plan.fromIndex, acceptedDeliveryIdOf(response))
  const sendSession = session
  return { kind: 'read', result: await readBudgeted(session, row.id, start, budgetMs, budgetContinuer(() => sendSession)) }
}

/** Steps 4…n: re-attach from the cursor and read on, touching the row (its lease). */
export async function continueHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: Pick<HomeTurnRow, 'id'>,
  state: HomeTurnReadState,
  io: HomeTurnIo = {},
): Promise<HomeTurnStepResult> {
  await updateRow(supabase, row.id, {})
  const session = attachSession(data, plan.sessionId, state.nextIndex, io)
  if (!session) return { kind: 'read', result: { done: true, end: 'session_ended', state } }
  const continueBudget = budgetContinuer(() => attachSession(data, plan.sessionId, state.nextIndex, io, 'send', plan.chatgptPlan === true))
  const result = await readBudgeted(session, row.id, state, io.budgetMs ?? HOME_TURN_STEP_BUDGET_MS, continueBudget)
  // The row keeps the turn's START index until it is done (a retried send step
  // re-reads the whole turn from there); the cursor rides the step output.
  await updateRow(supabase, row.id, result.state.eveTurnId ? { eve_turn_id: result.state.eveTurnId } : {})
  return { kind: 'read', result }
}

/**
 * Parts a server turn can't keep: a HITL request nobody can answer from the
 * stored message, and any `no_reply` or `mark_urgent` call (control calls,
 * never something for the person to see, even on a turn that went on to
 * speak: the urgency rides the message's metadata instead).
 */
function persistableParts(parts: readonly EveMessagePart[]): EveMessagePart[] {
  return parts.filter(
    (p) => !isNoReplyPart(p) && !isUrgentPart(p) && !(p.type === 'dynamic-tool' && (p.state === 'input-available' || p.state === 'input-streaming')),
  )
}

/**
 * True when a call in these parts was held as the person's approval card. The
 * card draws from the written message (chat-message.tsx, the chat's own
 * reading): a turn that holds one is written even with no words, or the card
 * (and the router's text of its code) is lost.
 */
function holdsApproval(parts: readonly EveMessagePart[]): boolean {
  return parts.some((p) => p.type === 'dynamic-tool' && p.state === 'output-available' && typeof p.toolName === 'string' && approvalIdOfToolOutput(p.toolName, p.output) !== null)
}

/** How a home turn ended, for the log and the row. */
export type HomeTurnOutcome = 'written' | 'quiet' | 'steered_quiet' | 'watch_exhausted'

/** The longest label a home turn's line carries. */
const HOME_TURN_LABEL_CHARS = 48

/**
 * What a home turn is, named on the line above it in the thread (the chat's
 * day lines, src/lib/chat/message-time.ts): one report's title ("Evening
 * Brief"), "N updates" for more, "Daily digest", "Heads up". Pure.
 */
export function homeTurnLabel(plan: Pick<HomeTurnPlan, 'reports'>, reason: HomeTurnReason): string {
  if (reason === 'digest') return 'Daily digest'
  if (reason === 'check_in') return 'Check-in'
  if (reason === 'event') return 'Heads up'
  if (reason === 'guest_ask') return 'Asked by text'
  if (reason === 'agent_answer') return 'Their agent answered'
  if (reason === 'agent_ask') return 'Their agent asked'
  if (reason === 'approval') return 'After your approval'
  if (plan.reports.length === 1) return oneLine(plan.reports[0].report.title, HOME_TURN_LABEL_CHARS) || 'Update'
  return plan.reports.length > 1 ? `${plan.reports.length} updates` : 'Update'
}

/**
 * Step 5: write the reply (unless the turn ended on no_reply or said nothing
 * to the person), settle the
 * row, and tell the idle-compaction timer the conversation was used. Never
 * throws.
 */
export async function finishHomeTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: Pick<HomeTurnRow, 'id'>,
  read: HomeTurnReadResult,
  /** The line's name for it (homeTurnLabel), or none. */
  label?: string | null,
  opts: {
    /** A check-in's writer into the home thread (appendHomeMessage; a test passes its own). */
    tellHome?: typeof appendHomeMessage
    /**
     * A helper's report turn that carried only meeting preps: the message is
     * stamped `prep_only`, so the router gives it a banner and never a text
     * (src/lib/reach/route-policy.ts).
     */
    prepOnly?: boolean
  } = {},
): Promise<{ outcome: HomeTurnOutcome; written: boolean; narrationChars?: number; heldApproval?: true }> {
  const { state } = read
  // The quiet check reads the whole turn (the no_reply call included); what
  // is written leaves the control call out.
  const turnParts = restoreEveTurnParts(state.parts).parts
  const parts = persistableParts(turnParts)
  const text = eveTurnText(parts)
  // A held call has its card only on the written message: with no words (a
  // failed or quiet turn), it is still written, or the card is lost. Every
  // reason: a background update that held a card while nobody was looking
  // must still put it in front of the person (the router texts its code).
  const heldApproval = read.done && holdsApproval(parts)
  // A turn that ended quiet and is written only for its card: what it wrote
  // before no_reply was narration, so the router sends the card's code alone.
  const quietButHeld = heldApproval && (endedWithNoReply(turnParts) || isQuietReply(text))
  // The agent marked its message urgent (mark_urgent, part D): the router may
  // take it through quiet hours. Read from the whole turn; the call itself is
  // never stored.
  const urgent = urgentByOfParts(turnParts)
  const urgentMeta = urgent ? { urgent_by: urgent.by, ...(urgent.why ? { urgent_why: urgent.why } : {}) } : {}
  let written = false
  let outcome: HomeTurnOutcome
  // Text written before the no_reply that ended a quiet turn, for the log line.
  let narrationChars = 0
  if (!read.done) {
    // Still running after the read cap: nothing half-said is written.
    outcome = 'watch_exhausted'
  } else if (!heldApproval && (endedWithNoReply(turnParts) || isQuietReply(text))) {
    // The agent called no_reply (it ends only a home turn), or said nothing:
    // nothing is written, and the report chip already in the thread stands.
    narrationChars = narrationBeforeNoReply(turnParts)
    outcome = read.end === 'steered' ? 'steered_quiet' : 'quiet'
  } else if (data.reason === 'check_in' && !replyTextOfParts(parts)) {
    // A check-in whose only words came before a call that failed: that was
    // narration, and its final answer is nothing. Nothing is written.
    outcome = 'quiet'
  } else if (data.reason === 'check_in') {
    // A check-in ran in a session of its own, so its message is not part of
    // the home thread's eve history: it lands as text, the way ci-fix.ts
    // posts "CI is still red" (its tool rows stay in its own session; the
    // note's history shows what it changed). Only its final answer (the words
    // after its last tool call): the narration between its calls ("Let me
    // update the note...") stays in its own session, and the router texts
    // exactly what is stored.
    const replyText = replyTextOfParts(parts)
    const result = await (opts.tellHome ?? appendHomeMessage)(supabase, {
      userId: data.userId,
      workspaceId: data.workspaceId,
      messageId: homeTurnMessageId(row.id),
      parts: [{ type: 'text', text: replyText }],
      metadata: {
        kind: HOME_TURN_KIND,
        home_turn_id: row.id,
        reason: data.reason,
        ...(label ? { [MESSAGE_LABEL_KEY]: label } : {}),
        ...urgentMeta,
      },
    })
    written = result.written
    outcome = 'written'
    if (!result.written && result.reason) console.warn(`[home-turn] check-in reply not written (${result.reason}) for row ${row.id}`)
  } else {
    const result = await persistEveMessage(supabase, {
      conversationId: data.conversationId,
      userId: data.userId,
      workspaceId: data.workspaceId,
      role: 'assistant',
      parts,
      messageId: homeTurnMessageId(row.id),
      metadata: {
        kind: HOME_TURN_KIND,
        home_turn_id: row.id,
        reason: data.reason,
        // A channel turn's reply is posted back to the channel (src/lib/slack/turn.ts): the bubble says so.
        ...(channelOfReason(data.reason) ? { channel: channelOfReason(data.reason) } : {}),
        ...(label ? { [MESSAGE_LABEL_KEY]: label } : {}),
        ...(state.eveTurnId ? { eve_turn_id: state.eveTurnId } : {}),
        // What the router reads (src/lib/reach/route-policy.ts): a prep-only report banners, a quiet turn's card goes alone.
        ...(opts.prepOnly ? { prep_only: true } : {}),
        ...(quietButHeld ? { ended_quiet: true } : {}),
        ...urgentMeta,
      },
    })
    written = result.written
    outcome = 'written'
    if (!result.written && result.reason) console.warn(`[home-turn] reply not written (${result.reason}) for row ${row.id}`)
  }
  await updateRow(supabase, row.id, {
    status: 'done',
    message_written: written,
    stream_position: state.nextIndex,
    ...(state.eveTurnId ? { eve_turn_id: state.eveTurnId } : {}),
    error: read.done ? (read.end === 'completed' ? null : read.end) : 'watch_exhausted',
  })
  // A check-in never touched the home thread's session: nothing for its idle compaction.
  if (data.reason !== 'check_in') signalChatSessionActivity({ conversationId: data.conversationId, workspaceId: data.workspaceId, userId: data.userId, source: 'turn' })
  // Never the reply's words (an Inngest step output): a channel turn's post re-reads the stored reply.
  return { outcome, written, ...(narrationChars > 0 ? { narrationChars } : {}), ...(heldApproval ? { heldApproval: true as const } : {}) }
}

/** The one log line per run. Counts and ids only. */
export function homeTurnLogLine(args: {
  conversationId: string
  rowId?: string
  reports?: number
  outcome: string
  /** A quiet turn's text written before its no_reply, in characters (never the text). */
  narrationChars?: number
}): string {
  const narration = args.narrationChars ? ` narration=${args.narrationChars}` : ''
  return `[home-turn] conversation=${args.conversationId} row=${args.rowId ?? '-'} reports=${args.reports ?? '-'} outcome=${args.outcome}${narration}`
}
