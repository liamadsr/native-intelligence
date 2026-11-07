/**
 * The autonomy kill switch's Inngest side: `workspace/autonomy.off` cancels
 * every in-flight WORK run in the workspace (see
 * src/lib/agent-run/cancel-workspace-runs.ts). The per-run settle and the eve
 * session cancel happen in agentRunCancel, one event per run, so this function
 * only sweeps and fans out — a retry re-runs the sweep and finds nothing left
 * in flight.
 *
 * A5 slice 5 widens the fan-out (src/lib/work/agent-paused.ts): running loop
 * sessions stop at their next tool call (the skill-run tool route asks the
 * switch), and pending approvals expire with their cards
 * (stopPausedWorkspaceExtras → expirePendingApprovals in src/lib/safety/approvals.ts). New loop fires, the email
 * pass's drafting, helper starts and the router ask the switch themselves.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import {
  cancelInFlightWorkRuns,
  WORKSPACE_AUTONOMY_OFF_EVENT,
} from '@/lib/agent-run/cancel-workspace-runs'
import { stopPausedWorkspaceExtras } from '@/lib/work/agent-paused'

export const workspaceAutonomyOff = inngest.createFunction(
  {
    id: 'workspace-autonomy-off',
    retries: 2,
    triggers: [{ event: WORKSPACE_AUTONOMY_OFF_EVENT }],
  },
  async ({ event, step }) => {
    const { workspace_id, reason, origins } = event.data as {
      workspace_id: string
      reason?: string
      origins?: string[]
    }
    const workRuns = await step.run('cancel-in-flight-work-runs', () =>
      cancelInFlightWorkRuns(getServiceClient(), {
        workspaceId: workspace_id,
        reason,
        origins,
      }),
    )
    const extras = await step.run('stop-loops-and-approvals', () =>
      stopPausedWorkspaceExtras(getServiceClient(), workspace_id),
    )
    return { ...workRuns, ...extras }
  },
)
