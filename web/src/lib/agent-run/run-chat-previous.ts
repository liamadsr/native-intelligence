/**
 * A run chat's earlier sessions: once its eve session expired and the chat
 * reopened in a new one (run-chat-reopen.ts for a work run's,
 * loop-run-chat-reopen.ts for a loop run's), its state keeps each earlier
 * session's id and where its follow-up turns start, so the replay still shows
 * their turns and a later reopen still primes from them.
 *
 * Shared by the work run's `agent_run.session_state` (run-chat-dispatch.ts)
 * and the loop run's `tracked_job_session.session_state`
 * (skill-run-session.ts). No imports, so the loop's session record can parse
 * it without pulling in the eve client.
 */

/** One of a run chat's earlier sessions: its id, and where its follow-up turns start (its replay boundary). */
export interface RunChatPreviousSession {
  sessionId: string
  startIndex: number
}

/** How many earlier sessions a run chat keeps for its replay and its next primer: past it, the oldest goes. */
export const RUN_CHAT_MAX_PREVIOUS_SESSIONS = 4

/** The well-formed entries of a persisted `previous` list, the newest RUN_CHAT_MAX_PREVIOUS_SESSIONS. Pure. */
export function parsePreviousSessions(raw: unknown): RunChatPreviousSession[] {
  if (!Array.isArray(raw)) return []
  const out: RunChatPreviousSession[] = []
  for (const entry of raw) {
    const e = entry as { sessionId?: unknown; startIndex?: unknown } | null
    if (typeof e?.sessionId !== 'string' || !e.sessionId) continue
    if (typeof e.startIndex !== 'number' || !Number.isSafeInteger(e.startIndex) || e.startIndex < 0) continue
    out.push({ sessionId: e.sessionId, startIndex: e.startIndex })
  }
  return out.slice(-RUN_CHAT_MAX_PREVIOUS_SESSIONS)
}
