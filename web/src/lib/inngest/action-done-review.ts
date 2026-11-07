import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { resolveWorkForAction } from '@/lib/work/resolve'

// =====================================================================
// A person's Done is their review (decision 9, A4 slice 7)
//
// An agent's finish leaves the action in review and raises a needs_review job;
// the person's Reviewed marks the action Done. The other way round has to hold
// too: when the PERSON marks the action Done by hand (the board drag, the
// ticket's status, toggle_complete, or complete_action / update_action on their
// word in chat or over MCP), the job's review card must not stay open.
//
// It rides the shared `flow/entity.status_changed` event, like the Asana /
// Jira / Linear echoes: emitStatusChange (GEN-112) is the one place the PATCH
// route and the action tools both pass through, so this needs no edit in
// either. Gates, each a clean no-op:
//   - actions only;
//   - a person's write only (origin actor 'user'; an event from before the
//     loop guard has no origin and is a person's). An agent's moves are its
//     own finish (moveActionToReview never completes) or a loop's;
//   - a move INTO a completed-category state.
// The settle itself (resolve.ts resolveWorkForAction) is CAS-guarded on
// needs_review, so a replay, or the person's Reviewed racing it, settles once.
// =====================================================================

interface StatusChangedEventData {
  entity_type: string
  entity_id: string
  workspace_id: string
  to_status_id: string
  origin?: { actor?: unknown } | null
}

export const actionDoneSettlesReview = inngest.createFunction(
  {
    id: 'action-done-settles-review',
    retries: 2,
    concurrency: [{ limit: 5, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/entity.status_changed' }],
  },
  async ({ event, step }) => {
    const { entity_type, entity_id, workspace_id, to_status_id, origin } = event.data as StatusChangedEventData
    if (entity_type !== 'action') return { status: 'skipped' as const, reason: 'not_an_action' }
    const actor = origin && typeof origin === 'object' && typeof origin.actor === 'string' ? origin.actor : 'user'
    if (actor !== 'user') return { status: 'skipped' as const, reason: 'not_a_person' }

    const supabase = getServiceClient()
    const category = await step.run('state-category', async () => {
      const { data } = await supabase.from('workflow_state').select('category').eq('id', to_status_id).maybeSingle()
      return ((data as { category?: string } | null)?.category as string | undefined) ?? null
    })
    if (category !== 'completed') return { status: 'skipped' as const, reason: 'not_done' }

    const settled = await step.run('settle-reviews', () =>
      resolveWorkForAction(supabase, { actionId: entity_id, workspaceId: workspace_id }),
    )
    return { status: 'done' as const, settled }
  },
)
