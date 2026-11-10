import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmailDrafts, MAX_DRAFTS_PER_PASS, REPLY_DRAFT_LABEL } from '@/lib/crm/email-drafts'
import { checkUsageLimits } from '@/lib/ai/auth'
import { readAgentPausedState } from '@/lib/work/agent-paused'
import { resolveMemberId } from '@/lib/work/agent-run-mirror'
import { startWork } from '@/lib/work/recorder'
import { emailPassTeammateId } from '@/lib/work/system-teammates'
import { WORK_KINDS } from '@/lib/work/types'

/**
 * Drafting replies to mail as it arrives: the ONE path for new mail is
 *   push → email-incremental-sync → triage (src/lib/email/triage.ts)
 *        → email-draft-replies (this file's draftRepliesToNewMail, gated)
 *        → agent events (src/lib/agent-events/email.ts recordDraftPassEvents).
 * The 05:00 cron (cron/email-management) is only the safety net: it drafts
 * what this path missed, through the same gates and the same daily cap.
 *
 * Every check here reads thread-index metadata and email_draft rows only,
 * never stored message bodies.
 */

/**
 * Most automatic drafts a person gets in a workspace in one UTC day, arrival
 * and the safety net together. Each draft is a model call; this bounds a
 * flood of mail. Drafts the person asks for count toward it but are never
 * blocked by it.
 */
export const AUTO_DRAFT_DAILY_CAP = 20

/**
 * How long one arrival pass may draft. It runs as ONE Inngest step
 * ('draft-replies', email-functions.ts) under the Inngest route's 600 s
 * maxDuration. generateEmailDrafts starts no thread after this, and the
 * reviewer only runs with REVIEW_MIN_REMAINING_MS left, so its work always
 * ends before it; a thread started just before it then needs at most its
 * unreviewed worst case (the reply gate, one 45 s write, the saves), which
 * fits in the remaining 180 s. At most MAX_REVIEWS_PER_PASS (3) drafts a pass
 * are reviewed.
 */
export const ARRIVAL_DRAFT_BUDGET_MS = 420_000

/**
 * The safety net leaves a thread alone until its newest message is this old.
 * Arrival normally drafts within a minute (push 17-20 s, then sync, triage and
 * one model call); the margin covers the slow cases arrival still handles on
 * its own: a per-person queue behind a flood of mail (one pass at a time,
 * up to 45 s a draft), its one retry after backoff, and a short Inngest or
 * provider outage. Two hours is far past all of those, and short enough that
 * mail arriving up to 03:00 UTC is still caught by that morning's pass.
 */
export const SAFETY_NET_MARGIN_MS = 2 * 60 * 60_000

/**
 * The safety net never reaches further back than this: a thread whose newest
 * message is older gets no automatic draft (Liam, 2026-10-18: it was working
 * through week-old mail, a reply about a dinner that had already passed). Two
 * days covers a missed daily run with room to spare, so no mail falls between
 * two mornings' passes. The person can still ask for a draft of anything.
 */
export const SAFETY_NET_LOOKBACK_MS = 48 * 60 * 60_000

/** Why a pass drafted nothing (templated; the needs_reply events' `reason`). */
export type AutoDraftBlock = 'paused' | 'dormant' | 'usage' | 'cap'

/**
 * A draft the pass wrote, as ids only: Inngest keeps a step's return value,
 * so nothing here may carry mail text (no subject).
 */
export type ArrivalDraft = {
  id: string
  /** email_thread_index id the draft answers. */
  email_thread_id: string | null
  created_at: string | null
}

export interface ArrivalDraftResult {
  drafts: ArrivalDraft[]
  /** Set when the pass was refused before drafting, or stopped by the cap. */
  blocked: AutoDraftBlock | null
  /** Threads the gate asks the person about instead of drafting (E3: Jev was unsure), by provider thread id. */
  asked?: string[]
  /**
   * Threads the gate turned away (no reply owed: the hard pre-filter, or
   * Jev's confident no), by provider thread id. They go to the agent's
   * understanding pass (E2) instead: mail that needs an action and not a
   * reply (accept an agreement, verify an address) becomes the agent's to
   * suggest (GEN-1164).
   */
  turnedAway?: string[]
}

/** The provider thread ids a pass asks the person about (its 'ask' skips). Pure. */
export function askedThreads(skipped: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(skipped ?? {}).filter(([, why]) => why === 'ask').map(([id]) => id)
}

/** The provider thread ids a pass turned away (its 'no_reply' skips). Pure. */
export function turnedAwayThreads(skipped: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(skipped ?? {}).filter(([, why]) => why === 'no_reply').map(([id]) => id)
}

/** The inbox reasons for asked threads: each one 'unsure' (event-turn.ts tells the agent to ask). Pure. */
export function unsureReasons(asked: readonly string[] | undefined): Record<string, string> | undefined {
  return asked?.length ? Object.fromEntries(asked.map((id) => [id, 'unsure'])) : undefined
}

/**
 * How many more automatic drafts today allows: the cap less every draft
 * written since UTC midnight. A sent or dismissed draft is deleted (the
 * holding pattern, src/lib/email/hold.ts), so email_draft alone undercounts:
 * today's drafts are the union of the `email.drafted` events recorded since
 * midnight (they outlive their drafts; only automatic paths record them) and
 * the AUTOMATIC email_draft rows still there (metadata.origin 'automatic': a
 * pass's drafts before its events are recorded). A draft the person asked for
 * (a chat, Mail's Generate) never counts. Either read failing throws.
 */
export async function remainingAutoDrafts(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const window = AUTO_DRAFT_DAILY_CAP * 4
  const [events, drafts] = await Promise.all([
    supabase
      .from('agent_event')
      .select('ref_id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('kind', 'email.drafted')
      .gte('created_at', midnight)
      .limit(window),
    supabase
      .from('email_draft')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('metadata->>origin', 'automatic')
      .gte('created_at', midnight)
      .limit(window),
  ])
  if (events.error) throw new Error(`Failed to count today's drafts: ${events.error.message}`)
  if (drafts.error) throw new Error(`Failed to count today's drafts: ${drafts.error.message}`)
  const today = new Set<string>()
  for (const r of (events.data ?? []) as Array<{ ref_id?: unknown }>) if (typeof r.ref_id === 'string') today.add(r.ref_id)
  for (const r of (drafts.data ?? []) as Array<{ id?: unknown }>) if (typeof r.id === 'string') today.add(r.id)
  return Math.max(0, AUTO_DRAFT_DAILY_CAP - today.size)
}

/**
 * generateEmailDrafts' `allowAnother`: re-counts today's drafts before each
 * model call and each insert, so arrival and the safety net, even running at
 * once, stop at the shared cap. A failed count stops the pass (it throws).
 */
export function dailyCapCheck(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  now: () => Date = () => new Date(),
): () => Promise<boolean> {
  return async () => (await remainingAutoDrafts(supabase, userId, workspaceId, now())) > 0
}

export interface DraftGateDeps {
  isDormant?: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  /** Resolves allowed/refused; throwing refuses (checkUsageLimits throws a Response when over). */
  checkUsage?: (userId: string) => Promise<{ allowed?: boolean } | undefined>
}

/**
 * The gates both drafting paths share, past the kill switch: a dormant
 * workspace (workspaceIsDormant, the loops' 14-day rule; a failed read is not
 * dormant, as for the digest and meeting prep) and the person's usage limit
 * (checkUsageLimits, as runDecision asks it: anything but an allowed row,
 * a failed check included, refuses).
 */
export async function draftingBlocked(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  deps: DraftGateDeps = {},
): Promise<'dormant' | 'usage' | null> {
  // Loaded here, not at the top: flow-functions pulls in the whole flow runner,
  // which neither drafting path otherwise needs.
  const isDormant = deps.isDormant ?? (async (db: SupabaseClient, ws: string) => {
    const { workspaceIsDormant } = await import('@/lib/inngest/flow-functions')
    return workspaceIsDormant(db as Parameters<typeof workspaceIsDormant>[0], ws)
  })
  if (await isDormant(supabase, workspaceId).catch(() => false)) return 'dormant'
  // Opted in to the ChatGPT free tier: a person on their own plan passes. Their
  // drafts (generateEmailDrafts) and their reply and arrival decisions
  // (runDecision's plan route) then run on their plan, never Native Intelligence's models.
  const checkUsage = deps.checkUsage ?? ((id: string) => checkUsageLimits(id, undefined, { chatgptPlan: true }))
  const allowance = await checkUsage(userId).catch(() => undefined)
  if (!allowance?.allowed) return 'usage'
  return null
}

/**
 * Every gate arrival drafting passes, in order: the kill switch (failing
 * closed), dormancy, usage, then today's cap. `remaining` is what the cap
 * still allows when nothing blocks. The held-thread refresh asks it too, so a
 * re-draft is gated exactly as a first draft is.
 */
export async function arrivalGate(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  now: Date = new Date(),
  deps: ArrivalDraftDeps = {},
): Promise<{ blocked: AutoDraftBlock | null; remaining: number }> {
  const switchState = await (deps.readPaused ?? readAgentPausedState)(supabase, workspaceId)
  if (switchState !== 'active') {
    console.info('[agent-paused] refused', { workspaceId, door: 'email_pass', path: 'arrival', state: switchState })
    return { blocked: 'paused', remaining: 0 }
  }
  const gated = await draftingBlocked(supabase, userId, workspaceId, deps)
  if (gated) return { blocked: gated, remaining: 0 }
  const remaining = await remainingAutoDrafts(supabase, userId, workspaceId, now)
  return remaining <= 0 ? { blocked: 'cap', remaining: 0 } : { blocked: null, remaining }
}

export interface ArrivalDraftDeps extends DraftGateDeps {
  readPaused?: typeof readAgentPausedState
  generate?: typeof generateEmailDrafts
}

/**
 * Draft replies on the threads triage handed over, past the gates and within
 * today's shared cap. The kill switch FAILS CLOSED here: a switch that can't be
 * read counts as paused, because this spends money, and a thread skipped this
 * way is still drafted by the safety net once the switch reads 'on'.
 * generateEmailDrafts applies the reply gate and email.trust
 * (shouldSkipAutomaticReply), wraps the mail as untrusted, and skips a thread
 * with an open draft (re-checked just before the insert).
 */
export async function draftRepliesToNewMail(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  threadIds: string[],
  now: Date = new Date(),
  deps: ArrivalDraftDeps = {},
): Promise<ArrivalDraftResult> {
  if (!threadIds.length) return { drafts: [], blocked: null }

  const gate = await arrivalGate(supabase, userId, workspaceId, now, deps)
  if (gate.blocked) return { drafts: [], blocked: gate.blocked }
  const remaining = gate.remaining

  const result = await (deps.generate ?? generateEmailDrafts)(userId, workspaceId, {
    thread_ids: threadIds,
    max_drafts: Math.min(remaining, threadIds.length),
    // No tone: the draft writes the way the person does (what Native Intelligence learned).
    replyIntent: 'automatic',
    allowAnother: dailyCapCheck(supabase, userId, workspaceId),
    // The 'draft-replies' step's own clock (see ARRIVAL_DRAFT_BUDGET_MS).
    deadlineAt: Date.now() + ARRIVAL_DRAFT_BUDGET_MS,
  })
  const drafts = result.drafts.map((draft) => ({
    id: String(draft.id),
    email_thread_id: typeof draft.email_thread_id === 'string' ? draft.email_thread_id : null,
    created_at: typeof draft.created_at === 'string' ? draft.created_at : null,
  }))
  // Threads left untried because the day's cap ran out are 'cap' (the cap
  // re-read refused, or max_drafts was the remaining allowance). The rest of
  // the not-drafted ones were passed over by the reply gate ('not_drafted').
  const capLimited = remaining < Math.min(threadIds.length, MAX_DRAFTS_PER_PASS)
  const capped = result.stoppedBy === 'allowance' || (result.stoppedBy === 'max' && capLimited)
  const asked = askedThreads(result.skipped)
  const turnedAway = turnedAwayThreads(result.skipped)
  return { drafts, blocked: capped ? 'cap' : null, ...(asked.length ? { asked } : {}), ...(turnedAway.length ? { turnedAway } : {}) }
}

/**
 * One Activity row for the drafts a push produced, written finished (no
 * review to wait on, so no notice), as the daily pass finishes its own. None
 * when nothing was drafted: a newsletter the gate passed over is not news.
 * `runKey` makes a retried run write the same row, not a second one.
 */
export async function recordArrivalDrafts(
  supabase: SupabaseClient,
  input: { userId: string; workspaceId: string; runKey: string; drafts: ArrivalDraft[] },
): Promise<void> {
  if (!input.drafts.length) return
  try {
    const memberId = await resolveMemberId(supabase, input.workspaceId, input.userId)
    if (!memberId) return
    const n = input.drafts.length
    await startWork(supabase, {
      workspaceId: input.workspaceId,
      memberId,
      aiTeamMemberId: await emailPassTeammateId(supabase, input.workspaceId),
      kind: WORK_KINDS.emailDrafts,
      actor: 'loop',
      title: n === 1 ? 'Reply draft for a new email' : `Reply drafts for ${n} new emails`,
      status: 'done',
      runKey: input.runKey,
      resultSummary: n === 1 ? '1 draft ready to review' : `${n} drafts ready to review`,
      deliverables: input.drafts.map((draft) => ({ type: 'email_draft', id: draft.id, label: REPLY_DRAFT_LABEL })),
    })
  } catch (err) {
    console.warn('[arrival-drafts] Activity row not written:', err instanceof Error ? err.message : err)
  }
}
