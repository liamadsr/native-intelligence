import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { requestAgentRunCancel, RUN_CANCEL_TERMINAL_STATUSES } from '@/lib/agent-run/request-run-cancel'

/**
 * POST /api/account/actions/[id]/agent-runs/[runId]/cancel
 *
 * Stops a running cloud (Vercel Sandbox) agent run. Flips the run to
 * `canceling` for immediate UI feedback, then emits `agent/run.cancel` — which
 * cancels the Inngest execute function (via its cancelOn) and triggers
 * agentRunCancel to stop the sandbox + settle the run as `canceled`.
 *
 * Non-destructive: any branch/commits the agent already pushed are left intact.
 *
 * ── Auth + write model (Loops v3 Phase 3) ────────────────────────────────────
 * The cookie session authenticates + authorizes (membership of the run's
 * workspace, via the RLS-scoped read below). The interaction-control WRITE goes
 * through the SERVICE client: since Phase 3, member-wide UPDATE RLS on agent_run
 * is dropped (mig 200) so an ordinary member can't tamper the run's control state
 * (pending_input / session_state / status) via direct PostgREST — all agent_run
 * writes are service-role via API routes that do their OWN authorization.
 *
 * The `canceling` flip is CAS-guarded on a non-terminal status: a run that settled
 * (completed / failed / pr_open) in the gap since the read must NOT be resurrected
 * to `canceling` (which agentRunCancel would then finalize as `canceled`, clobbering
 * a real deliverable + its "ready for review" notification).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Load the run (workspace + action scoped) via the RLS-scoped cookie client — this
  // read IS the authorization: RLS confines it to runs in a workspace the caller is a
  // member of, and the action_id/workspace_id scoping confirms the run belongs here.
  const { data: run, error } = await supabase
    .from('agent_run')
    .select('id, status')
    .eq('id', runId)
    .eq('action_id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error || !run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  if ((RUN_CANCEL_TERMINAL_STATUSES as readonly string[]).includes(run.status as string)) {
    return NextResponse.json(
      { error: 'This run has already finished' },
      { status: 409 },
    )
  }

  // Optimistic `canceling` flip (service role, CAS on a non-terminal status) and
  // the cancel event — shared with the run-scoped route (request-run-cancel.ts).
  if (!(await requestAgentRunCancel({ runId, workspaceId }))) {
    // The run reached a terminal state in the gap — no cancel event was emitted
    // (it would settle a finished run canceled).
    return NextResponse.json(
      { error: 'This run has already finished' },
      { status: 409 },
    )
  }

  return NextResponse.json({ ok: true, status: 'canceling' })
}
