/**
 * Per-session web_fetch abuse cap for the work-agent.
 *
 * Web access is ALWAYS ON for every Native Intelligence agent (no toggle — matching how
 * Anthropic's own agents browse). The founder waived cost concerns, so this cap
 * is NOT a budget knob: it's invisible, generous abuse insurance against a
 * runaway loop that fetches thousands of pages in one run. A normal run makes a
 * handful of fetches; the ceiling sits far above any legitimate use.
 *
 * SCOPE — web_fetch only. eve's web_search is provider-managed: its local
 * `execute` is a throwing stub (the provider injects the real search at step
 * time), so there is no client-side executor to hook a counter onto. Only
 * web_fetch has a real local execute, so the cap lives here. web_search stays
 * live and uncapped by this mechanism (bounded instead by the agent's own
 * per-session output-token limit).
 *
 * KEY — the eve session id (ctx.session.id). One run is one eve session, so the
 * counter is per-run exactly as intended. The map is process-local: a durable
 * session that resumes in a fresh instance restarts its count, which is fine for
 * abuse insurance (a runaway loop burns its budget within one instance's
 * lifetime; the reset only ever loosens, never tightens, an already-generous
 * ceiling). Kept unbounded-key-growth-safe by pruning on a soft ceiling of
 * tracked sessions.
 */

/** Generous ceiling — far above any legitimate run's fetch count. */
export const WEB_FETCH_PER_CONVERSATION_LIMIT = 60

/** Soft cap on tracked sessions before we evict the oldest to bound memory. */
const MAX_TRACKED_SESSIONS = 5000

const counts = new Map<string, number>()

/**
 * Record one web_fetch for a session and report whether it is allowed. Returns
 * `{ allowed:false }` once the session has reached the limit (the current call
 * is refused and NOT counted, so the count settles exactly at the limit).
 */
export function countWebFetch(sessionId: string): { allowed: boolean; count: number; limit: number } {
  const prior = counts.get(sessionId) ?? 0
  if (prior >= WEB_FETCH_PER_CONVERSATION_LIMIT) {
    return { allowed: false, count: prior, limit: WEB_FETCH_PER_CONVERSATION_LIMIT }
  }
  const next = prior + 1
  // Bound memory: if we're about to add a new key past the soft cap, drop the
  // oldest-inserted entry (Map preserves insertion order).
  if (!counts.has(sessionId) && counts.size >= MAX_TRACKED_SESSIONS) {
    const oldest = counts.keys().next().value
    if (oldest !== undefined) counts.delete(oldest)
  }
  counts.set(sessionId, next)
  return { allowed: true, count: next, limit: WEB_FETCH_PER_CONVERSATION_LIMIT }
}

/** Test-only reset of the in-process counter. */
export function __resetWebFetchCap(): void {
  counts.clear()
}
