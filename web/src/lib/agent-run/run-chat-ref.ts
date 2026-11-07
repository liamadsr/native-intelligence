/**
 * Which run a run chat is, and where its route is (bots v3 Phase 4).
 *
 * Every run-chat surface (useRunChat, RunChatTransport, the bubble, the
 * desktop relay, the teammate tab) keys a run chat by one string id. A work
 * run's is its agent_run id (/api/account/agent-runs/[id]/chat). A LOOP run's
 * is its ledger row's id with a `loop:` prefix
 * (/api/account/activity/[id]/chat: the parked session of the loop's skill
 * run). The prefix keeps the two apart everywhere without a second key, and it
 * passes every run-id check those surfaces make (/^[\w:.-]{1,128}$/).
 */

export const LOOP_RUN_CHAT_PREFIX = 'loop:'

/** The run-chat id of the loop run behind ledger row `workItemId`. */
export function loopRunChatId(workItemId: string): string {
  return `${LOOP_RUN_CHAT_PREFIX}${workItemId}`
}

/** The ledger row id behind a loop run's chat id, or null for a work run's. */
export function loopRunWorkItemId(runId: string): string | null {
  return runId.startsWith(LOOP_RUN_CHAT_PREFIX) ? runId.slice(LOOP_RUN_CHAT_PREFIX.length) || null : null
}

/** The chat route of a run-chat id (POST a turn, GET the replay). */
export function runChatRoute(runId: string): string {
  const workItemId = loopRunWorkItemId(runId)
  return workItemId
    ? `/api/account/activity/${encodeURIComponent(workItemId)}/chat`
    : `/api/account/agent-runs/${runId}/chat`
}
