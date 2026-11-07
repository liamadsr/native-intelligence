/**
 * POST /api/account/prospecting/runs/[id]/cancel — ask a live run to stop.
 *
 * Cancel is a REQUEST, not a settlement. The route flips the row to
 * `canceling` (the one status migration 248's member UPDATE policy exists for)
 * and emits `prospecting/run.cancel`; the engine's `cancelOn` matches
 * `data.runId`, stops between steps, and writes the terminal `canceled`
 * itself — **keeping every partial result**, which is the whole point of
 * cancelling a run that has already paid for two rounds.
 *
 * A run that settled in the gap since the read is a 409, never a resurrection:
 * flipping a completed run to `canceling` would have the engine finalize it as
 * `canceled` and clobber real results. The CAS guard lives in `requestCancel`.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, notFound, serverError } from '@/lib/api-errors'
import { requestCancel } from '@/lib/prospecting/runs'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const result = await requestCancel(supabase, { workspaceId, runId: id })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('Run not found')
    if (result.code === 'NOT_CANCELABLE') {
      return apiError(result.error, { status: 409, code: 'NOT_CANCELABLE' })
    }
    return serverError()
  }
  return NextResponse.json({ run: result.run, status: result.run.status })
}
