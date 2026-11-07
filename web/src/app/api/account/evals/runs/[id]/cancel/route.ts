/**
 * POST /api/account/evals/runs/[id]/cancel — stop a run.
 *
 * Cancel keeps every partial result, which is the whole point of cancelling a
 * run that has already paid for six trials: the trials that completed keep
 * their traces and their checks, and the run settles as `cancelled` rather
 * than `failed`.
 *
 * `cancelEvalRun` is a CAS — its UPDATE is scoped to `status in
 * ('queued','running')` — and when it matches nothing it reads the row back
 * and returns it unchanged rather than throwing. That is the case this route
 * turns into a 409: a run that settled in the gap since the client's last poll
 * is not cancellable, and reporting it as cancelled would tell the user a
 * completed result was thrown away. The distinction is made on the returned
 * row's `status`, which is the only thing that can tell those apart.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { apiError, notFound, serverError } from '@/lib/api-errors'
import { cancelEvalRun, EvalRunError } from '@/lib/evals/start-run'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  // Read on the CALLER's client so membership decides whether this run is even
  // visible; the service-role cancel below inherits that decision.
  const { data: existing, error } = await supabase
    .from('eval_run')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error) {
    console.error('[evals] cancel run read failed:', error.message)
    return serverError()
  }
  if (!existing) return notFound('Run not found')

  try {
    const run = await cancelEvalRun(getServiceClient(), { workspaceId, runId: id })

    if (run.status !== 'cancelled') {
      return apiError('This run has already finished.', {
        status: 409,
        code: 'NOT_CANCELABLE',
        details: { status: run.status },
      })
    }

    return NextResponse.json({ run, status: run.status })
  } catch (err) {
    if (err instanceof EvalRunError && err.code === 'EVAL_RUN_NOT_FOUND') {
      return notFound('Run not found')
    }
    console.error('[evals] cancel run failed:', err)
    return serverError()
  }
}
