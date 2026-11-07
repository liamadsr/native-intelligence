import { isAgentRunLive } from '@/lib/agent-run/types'

/**
 * Whether the action detail panel's Cloud-run tab is offered for an action.
 *
 * Extracted into its own leaf module (no React / no heavy panel imports) so the
 * gate is unit-testable in the default node env without dragging in the panel's
 * transitive dependency tree.
 *
 * THREE independent signals, any of which means this action can carry a
 * server-side run:
 *   1. `assignedToAi`  — an AI assignee → the coding-run surface (repo → PR);
 *   2. `hasWorkRun`    — a workspace-kind (Loops v3) run exists. This is the
 *      DURABLE signal for a work-run action (which has NO AI assignee), so its
 *      Cloud tab stays reachable even AFTER the run completes;
 *   3. `agentRunStatus` is currently live/parked — a run just started (or parked
 *      on a question) before `hasWorkRun` resolved, so the tab is available on the
 *      very first render without waiting for the agent-runs fetch.
 */
export function canShowCloudRunTab(args: {
  assignedToAi: boolean
  hasWorkRun: boolean
  agentRunStatus: string
}): boolean {
  return args.assignedToAi || args.hasWorkRun || isAgentRunLive(args.agentRunStatus)
}

/** The trailing status marker on the Cloud-run tab, if any. */
export type CloudRunTabMarker = 'needs_input' | 'live' | 'failed' | null

/**
 * Which status marker the Cloud-run tab shows for a run status.
 *
 * Exactly one, in this precedence: a question the run is parked on, then a
 * run that is still going, then a failure. The first two describe what the run
 * is doing NOW, whereas 'failed' describes a run that already ended — so when
 * a new run starts after a failed one, the live spinner replaces the failure
 * marker rather than sitting beside it.
 *
 * A failed run used to be reported as a "Last run failed" note in the
 * properties sidebar. It reads better on the tab, because the tab is where the
 * logs explaining the failure actually live.
 */
export function cloudRunTabMarker(agentRunStatus: string): CloudRunTabMarker {
  if (agentRunStatus === 'needs_input') return 'needs_input'
  if (isAgentRunLive(agentRunStatus)) return 'live'
  if (agentRunStatus === 'failed') return 'failed'
  return null
}
