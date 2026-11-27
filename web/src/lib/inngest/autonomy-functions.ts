/**
 * Earned autonomy's runner (docs/plans/earned-autonomy.md §5, phase 3): one
 * event per action the agent will take on its own, sent when its card is
 * raised (src/lib/autonomy/actions.ts scheduleAutonomousAction). It sleeps to
 * the end of the undo window, then runs the action, which re-checks
 * everything first (graduationFor) and goes through the card's own accept
 * path. Liam, 11-27, decision 1: the 5-minute undo window before each send.
 *
 * A retry is safe: the run claims its row (scheduled → running) before it
 * approves, and the approval itself runs at most once (approveToolCall's
 * compare-and-swap).
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { AUTONOMY_ACTION_EVENT, runAutonomousAction } from '@/lib/autonomy/actions'

export const autonomyActionRun = inngest.createFunction(
  {
    id: 'autonomy-action-run',
    retries: 2,
    triggers: [{ event: AUTONOMY_ACTION_EVENT }],
  },
  async ({ event, step }) => {
    const { action_id, run_at } = event.data as { action_id: string; run_at: string }
    const at = Date.parse(run_at)
    if (Number.isFinite(at)) await step.sleepUntil('undo-window', new Date(at))
    const outcome = await step.run('run-action', () => runAutonomousAction(getServiceClient(), action_id))
    return { action_id, outcome }
  },
)
