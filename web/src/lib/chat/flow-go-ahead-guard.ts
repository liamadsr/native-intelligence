/**
 * The same-turn go-ahead guard for chat's loop tools (A1b review, M1): an
 * interim SERVER check under the person's yes the loop tools take on the
 * model's word (src/lib/ai/tools/flows.ts): create_flow's `enabled: true`
 * (the person asked for this loop) and update_flow's `confirmed_with_user`.
 *
 * A loop the agent proposes on its own (or re-aims) is saved off and comes
 * back `awaiting_go_ahead` with its summary: the person hasn't seen it yet,
 * and their answer arrives as their next message, a NEW eve turn. So in a
 * turn where that came back, no create_flow may pass `enabled: true` and no
 * update_flow `confirmed_with_user: true` in that SAME turn, for that loop or
 * any other (a twin built on, or another loop re-aimed, would dodge a
 * per-loop check): a turn that asked can't answer for the person. The call is
 * refused with an error telling the model to show the summary and wait. A
 * later turn, the person's reply, runs as usual. A loop the person asked for
 * outright is saved on and arms nothing.
 *
 * Keyed like the repeat-failure breaker (./tool-repeat-breaker.ts): the
 * token's user, eve's session and turn ids. No session or turn id: no guard
 * (nothing to scope it by). ask_user resumes the SAME turn id, so a yes given
 * through the picker is refused too: the model asks in its reply instead.
 *
 * The same holds for a bulk inbox change (GEN-1166): update_email_thread on
 * more than ten threads comes back `awaiting_go_ahead` until the person says
 * yes in the chat, so no update_email_thread may pass `confirmed_with_user:
 * true` in that same turn. The ten count across the turn: the threads its
 * calls were given are added up, so ten-at-a-time calls past ten are asked
 * about too (and arm the turn). Its turns are tracked apart from the loops':
 * a mail ask never blocks a loop call, or the other way round.
 *
 * In memory, per server instance, bounded (LRU by last touch, plus a TTL).
 * A call that lands on another instance isn't stopped there: this weakens
 * the guard, it never breaks a call. The asks-first rule itself stays in the
 * tools; this only stops one turn from asking and answering for the person.
 */

import { BULK_THREAD_CONFIRM_OVER } from '@/lib/email/triage-limits'

/** The tools whose claim of the person's yes the guard watches. */
export const FLOW_GO_AHEAD_TOOLS: ReadonlySet<string> = new Set(['create_flow', 'update_flow'])
/** The inbox triage's bulk change (GEN-1166), watched the same way, apart from the loops. */
export const MAIL_GO_AHEAD_TOOLS: ReadonlySet<string> = new Set(['update_email_thread'])

/** What the model reads instead of a same-turn confirmed call. */
export const GO_AHEAD_SAME_TURN_ERROR =
  "Refused, nothing saved. In this turn a loop came back waiting for the person's yes (or a call was refused for want of it), and the person hasn't answered yet. Show them the summary, ask whether to switch it on and end your turn; switch it on (or build another loop on) only after they reply yes."

/** What the model reads instead of a same-turn confirmed bulk inbox change. */
export const MAIL_GO_AHEAD_SAME_TURN_ERROR =
  "Refused, nothing changed. In this turn a bulk inbox change came back waiting for the person's yes, and they haven't answered yet. Tell them how many threads and what they are, ask, and end your turn; make the change only after they reply yes."

const MAX_ENTRIES = 5000
const TTL_MS = 60 * 60 * 1000

/** Family and turn key → when a call last came back waiting in it (ms). Insertion order is recency. */
const asked = new Map<string, number>()
/** Turn key → the threads update_email_thread was given in that turn, and when last. Insertion order is recency. */
const mailThreads = new Map<string, { at: number; ids: Set<string> }>()
/** The most threads one turn's record holds (a call takes 100). */
const MAX_TURN_THREADS = 1000

/** Which watched family a tool is in (each tracks its turns apart), or null. */
function familyOf(toolName: string): 'flow' | 'mail' | null {
  return FLOW_GO_AHEAD_TOOLS.has(toolName) ? 'flow' : MAIL_GO_AHEAD_TOOLS.has(toolName) ? 'mail' : null
}

/** The guard's key for one turn, or null without a usable session and turn id. */
export function goAheadTurnKey(scope: { userId?: string; sessionId?: unknown; turnId?: unknown }): string | null {
  const { sessionId, turnId } = scope
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return null
  if (typeof turnId !== 'string' || !turnId || turnId.length > 200) return null
  return JSON.stringify([scope.userId ?? '', sessionId, turnId])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The field a call claims the person's yes with: create_flow's `enabled`, update_flow's and update_email_thread's `confirmed_with_user`. */
function yesField(toolName: string): 'enabled' | 'confirmed_with_user' {
  return toolName === 'create_flow' ? 'enabled' : 'confirmed_with_user'
}

function arm(slot: string, now: number): void {
  asked.delete(slot)
  asked.set(slot, now)
  while (asked.size > MAX_ENTRIES) {
    const oldest = asked.keys().next().value
    if (oldest === undefined) break
    asked.delete(oldest)
  }
}

function threadIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()) : []
}

/** The threads this turn's update_email_thread calls were given (fresh within the TTL). */
function turnMailThreads(key: string, now: number): Set<string> {
  const entry = mailThreads.get(key)
  if (!entry || now - entry.at > TTL_MS) return new Set()
  return entry.ids
}

/** What the model reads when unconfirmed calls in one turn add up past the bulk limit. */
export interface MailBulkRefusal {
  success: false
  code: 'NEEDS_CONFIRMATION'
  awaiting_go_ahead: true
  thread_count: number
  error: string
}

/**
 * The refusal for a call that claims the person's yes (create_flow
 * `enabled: true`, update_flow and update_email_thread `confirmed_with_user:
 * true`) in a turn where one already came back waiting, or null when it may
 * run. An unconfirmed update_email_thread whose threads, with the ones this
 * turn's earlier calls were given, pass the bulk limit is asked about (and
 * arms the turn).
 */
export function sameTurnGoAheadRefusal(
  key: string | null,
  toolName: string,
  input: unknown,
  now = Date.now(),
): { success: false; code: 'GO_AHEAD_SAME_TURN'; field: 'enabled' | 'confirmed_with_user'; error: string } | MailBulkRefusal | null {
  const family = familyOf(toolName)
  if (!key || !family) return null
  const field = yesField(toolName)
  if (family === 'mail' && isRecord(input) && input[field] !== true) {
    const ids = new Set([...turnMailThreads(key, now), ...threadIdsOf(input.thread_ids)])
    if (ids.size <= BULK_THREAD_CONFIRM_OVER) return null
    arm(`${family}\n${key}`, now)
    return {
      success: false,
      code: 'NEEDS_CONFIRMATION',
      awaiting_go_ahead: true,
      thread_count: ids.size,
      error: `Nothing changed: with this call, this turn would change ${ids.size} threads. Tell the person how many and what they are, ask them in the chat and end your turn; after they reply yes, change them in one call with confirmed_with_user: true.`,
    }
  }
  if (!isRecord(input) || input[field] !== true) return null
  const slot = `${family}\n${key}`
  const at = asked.get(slot)
  if (at === undefined) return null
  if (now - at > TTL_MS) {
    asked.delete(slot)
    return null
  }
  return { success: false, code: 'GO_AHEAD_SAME_TURN', field, error: family === 'mail' ? MAIL_GO_AHEAD_SAME_TURN_ERROR : GO_AHEAD_SAME_TURN_ERROR }
}

/**
 * Record a loop-tool call's output: `awaiting_go_ahead` (a loop saved off with
 * a summary the person hasn't seen) marks the turn. A `needs_go_ahead` refusal
 * doesn't: it's the model forgetting its yes field after the person's
 * yes, and blocking the corrected retry would make them say yes twice (a
 * forged yes would pass the flag on the first try anyway). Anything else, or
 * another tool, changes nothing.
 */
export function recordGoAheadOutcome(key: string | null, toolName: string, output: unknown, now = Date.now()): void {
  const family = familyOf(toolName)
  if (!key || !family || !isRecord(output)) return
  // The threads an inbox change was given count toward the turn's bulk limit.
  if (family === 'mail' && Array.isArray(output.threads)) {
    const ids = threadIdsOf(output.threads.map((t) => (isRecord(t) ? t.thread_id : null)))
    const turn = new Set([...turnMailThreads(key, now), ...ids].slice(0, MAX_TURN_THREADS))
    mailThreads.delete(key)
    mailThreads.set(key, { at: now, ids: turn })
    while (mailThreads.size > MAX_ENTRIES) {
      const oldest = mailThreads.keys().next().value
      if (oldest === undefined) break
      mailThreads.delete(oldest)
    }
  }
  if (output.awaiting_go_ahead !== true) return
  arm(`${family}\n${key}`, now)
}

/** Tests only: forget every turn. */
export function resetGoAheadGuard(): void {
  asked.clear()
  mailThreads.clear()
}

/** Tests only: how many turns are tracked. */
export function goAheadGuardSize(): number {
  return asked.size
}

/** Tests only: the most turns tracked at once. */
export const GO_AHEAD_GUARD_MAX_ENTRIES = MAX_ENTRIES
