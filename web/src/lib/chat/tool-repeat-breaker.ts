import { createHash } from 'node:crypto'

/**
 * The repeat-failure breaker for chat tool calls.
 *
 * A PROD chat on deepseek-v4-flash (2026-10-08) called settle_card 31 times in
 * one turn with the same input, and every call failed the same way
 * (INPUT_INVALID): about a million input tokens before the turn gave up. Nothing
 * stopped a call that could only fail again.
 *
 * So when the SAME tool is called with the SAME input (canonicalised: key order
 * does not matter) and fails the SAME way {@link REPEAT_FAILURE_LIMIT} times in
 * one eve turn, the next identical call is not run: it answers
 * {@link repeatedFailureOutput} instead. It never blocks
 *   - a different input (another key),
 *   - a call after a success (a success clears the count),
 *   - a new turn or another session (both are in the key),
 *   - a call that keeps succeeding (only failures count: a read that
 *     legitimately repeats with the same input is never touched),
 *   - a call with no eve turn or session id (nothing to scope it by),
 *   - a retry after a pause: a failure older than {@link REPEAT_WINDOW_MS}
 *     starts the count over. ask_user pauses a turn and resumes the SAME turn
 *     id, so after the person fixes what failed (opens the desktop app, say)
 *     the identical call must run again. The PROD loop fired within seconds;
 *     a person's answer takes longer.
 *
 * In memory, per server instance, bounded (LRU by last touch, plus a TTL).
 * Fluid compute reuses an instance across requests, so a turn's calls usually
 * land on one; a call that lands on another instance only starts its count
 * over there. A miss weakens the guard, it never breaks a call.
 */

/** Identical failures in one turn before the next identical call is refused. */
export const REPEAT_FAILURE_LIMIT = 3

/** What the model reads instead of a run of an identical call that already failed the limit. */
export const REPEATED_FAILURE_ERROR = `This exact call failed ${REPEAT_FAILURE_LIMIT} times. Stop retrying it: tell the person what failed and ask how to proceed, or change the input.`

/** An identical failure older than this starts the count over (a paused turn's retry). */
export const REPEAT_WINDOW_MS = 90 * 1000

const MAX_ENTRIES = 5000
const TTL_MS = 60 * 60 * 1000

interface Entry {
  /** How the call failed ({@link failureFingerprint}). */
  failure: string
  /** Consecutive identical failures. */
  count: number
  /** When it last failed, ms. */
  at: number
}

/** Insertion order is recency: a touch re-inserts, so the first key is the oldest. */
const entries = new Map<string, Entry>()

/** JSON with every object's keys sorted, so `{a, b}` and `{b, a}` are one input. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  // defineProperty, not assignment: an input key named `__proto__` stays an
  // own key (assignment would set the copy's prototype and drop it from the hash).
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(out, key, {
      value: sortKeys((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/**
 * The breaker's key for one call: the token's user + eve session + turn +
 * tool + a hash of the canonical input. Null (no breaker) without a usable
 * session and turn id.
 */
export function repeatKey(
  scope: { userId?: string; sessionId?: unknown; turnId?: unknown },
  toolName: string,
  input: unknown,
): string | null {
  const { sessionId, turnId } = scope
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return null
  if (typeof turnId !== 'string' || !turnId || turnId.length > 200) return null
  const hash = createHash('sha256').update(canonicalJson(input ?? {})).digest('hex')
  return JSON.stringify([scope.userId ?? '', sessionId, turnId, toolName, hash])
}

/**
 * How a tool's output failed, or null when it did not: `success: false` (or an
 * `error` string with no `success` at all) is a failure, told apart by its
 * `code` when it has one, else by its error text.
 */
export function failureFingerprint(output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  const o = output as Record<string, unknown>
  const failed = o.success === false || (o.success === undefined && typeof o.error === 'string' && o.error.length > 0)
  if (!failed) return null
  if (typeof o.code === 'string' || typeof o.code === 'number') return `code:${o.code}`
  if (typeof o.error === 'string') return `error:${o.error}`
  return 'failed'
}

function live(key: string, now: number): Entry | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  if (now - entry.at > TTL_MS) {
    entries.delete(key)
    return undefined
  }
  return entry
}

/** The entry while its last failure is recent enough to keep counting on. */
function counting(key: string, now: number): Entry | undefined {
  const entry = live(key, now)
  return entry && now - entry.at <= REPEAT_WINDOW_MS ? entry : undefined
}

/**
 * The refusal for a call that already failed the same way the limit's number
 * of times in this turn, or null when it may run.
 */
export function repeatedFailureOutput(
  key: string | null,
  now = Date.now(),
): { success: false; code: 'REPEATED_FAILURE'; error: string } | null {
  if (!key) return null
  const entry = counting(key, now)
  if (!entry || entry.count < REPEAT_FAILURE_LIMIT) return null
  return { success: false, code: 'REPEATED_FAILURE', error: REPEATED_FAILURE_ERROR }
}

/**
 * Record how a call ended: `failure` from {@link failureFingerprint} (or the
 * route's own error code), null for a success, which clears the count. A
 * failure unlike the last one, or one more than {@link REPEAT_WINDOW_MS} after
 * it, starts the count over. Only this call's own outcome moves its count.
 */
export function recordCallOutcome(key: string | null, failure: string | null, now = Date.now()): void {
  if (!key) return
  if (failure === null) {
    entries.delete(key)
    return
  }
  const entry = counting(key, now)
  const count = entry && entry.failure === failure ? entry.count + 1 : 1
  entries.delete(key)
  entries.set(key, { failure, count, at: now })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

/** Tests only: forget every count. */
export function resetRepeatBreaker(): void {
  entries.clear()
}

/** Tests only: how many calls are tracked. */
export function repeatBreakerSize(): number {
  return entries.size
}

/** Tests only: the most calls tracked at once. */
export const REPEAT_BREAKER_MAX_ENTRIES = MAX_ENTRIES
