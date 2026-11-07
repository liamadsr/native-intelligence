/**
 * Per-session cap on the enrichment tools (`enrich_company`, `enrich_me`).
 *
 * Each call runs ONE Exa Deep Search inside the app, billed per request at
 * roughly 100x a plain search. A signup run needs exactly one company card and
 * one person card. The cap allows a second call per kind so the model can retry
 * when a lookup came back thin, and no more — an unattended loop must never keep
 * buying deep searches.
 *
 * Same process-local, session-keyed shape as web-fetch-cap.ts (see there for why
 * a per-instance counter is adequate abuse insurance). The key is
 * `${sessionId}:${kind}` so the two tools get independent budgets: burning the
 * company retry must not lock the user out of their own person lookup.
 */

export const ENRICH_CALL_PER_SESSION_LIMIT = 2

const MAX_TRACKED_SESSIONS = 5000

const counts = new Map<string, number>()

/** Which enrichment lane a call belongs to. */
export type EnrichKind = 'company' | 'self_contact'

/**
 * Record one enrichment call for a session+kind and report whether it is
 * allowed. A refused call is NOT counted, so the count settles at the limit.
 */
export function countEnrichCall(
  sessionId: string,
  kind: EnrichKind,
): { allowed: boolean; count: number; limit: number } {
  const key = `${sessionId}:${kind}`
  const prior = counts.get(key) ?? 0
  if (prior >= ENRICH_CALL_PER_SESSION_LIMIT) {
    return { allowed: false, count: prior, limit: ENRICH_CALL_PER_SESSION_LIMIT }
  }
  const next = prior + 1
  if (!counts.has(key) && counts.size >= MAX_TRACKED_SESSIONS) {
    const oldest = counts.keys().next().value
    if (oldest !== undefined) counts.delete(oldest)
  }
  counts.set(key, next)
  return { allowed: true, count: next, limit: ENRICH_CALL_PER_SESSION_LIMIT }
}

/**
 * Give back one recorded call the app refused before any search ran (the
 * route's 403: no research run in progress for this session), so a refusal
 * never spends the run's budget. Never goes below zero.
 */
export function refundEnrichCall(sessionId: string, kind: EnrichKind): void {
  const key = `${sessionId}:${kind}`
  const prior = counts.get(key) ?? 0
  if (prior <= 1) counts.delete(key)
  else counts.set(key, prior - 1)
}

/** Test-only reset of the in-process counter. */
export function __resetEnrichCallCap(): void {
  counts.clear()
}
