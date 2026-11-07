import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { requestAgentRunCancel, RUN_CANCEL_TERMINAL_STATUSES } from '@/lib/agent-run/request-run-cancel'

/**
 * POST /api/account/agent-runs/[id]/cancel
 *
 * Stop for a run that has NO tracked board action — an auto-attempted run
 * (Sequence step 3 anchors those to their source capture instead), or a
 * flow-origin run. Same contract as the action-scoped
 * `/api/account/actions/[id]/agent-runs/[runId]/cancel`: the RLS-scoped cookie
 * read of the run in the caller's current workspace IS the authorization, a
 * finished run answers 409, and the write (the `canceling` flip + the cancel
 * event) is the shared service-role helper.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data: run, error } = await supabase
    .from('agent_run')
    .select('id, status')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (error || !run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  if ((RUN_CANCEL_TERMINAL_STATUSES as readonly string[]).includes(run.status as string)) {
    return NextResponse.json({ error: 'This run has already finished' }, { status: 409 })
  }
  if (!(await requestAgentRunCancel({ runId: id, workspaceId }))) {
    return NextResponse.json({ error: 'This run has already finished' }, { status: 409 })
  }
  return NextResponse.json({ ok: true, status: 'canceling' })
}
