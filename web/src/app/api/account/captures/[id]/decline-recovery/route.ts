import { requireWorkspace } from '@/lib/api-auth'
import { apiError, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { declineRecovery } from '@/lib/captures/abandoned'
import { CAPTURE_ABANDONED_EVENT } from '@/lib/inngest/capture-finalizer'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/decline-recovery
 *
 * The owner declined to resume a capture whose recorder died (the recovery
 * prompt's "End capture"). Stop's work, done on the server:
 *
 *   1. close the capture (`declineRecovery`): ended at its last write, the
 *      transcript locked by the `lock_transcript_on_end` trigger, and
 *      `metadata.finalized = { by: 'owner', reason: 'recovery_declined' }`;
 *   2. when it has a meeting in it, send the finalize event with
 *      `reason: 'recovery_declined'`, and the finalizer runs the end-of-meeting
 *      pass as the owner: the batch or the live record's close, which emits
 *      flow/capture.processed (→ Triage), then the title and the index.
 *
 * This replaces the prompt's bare PATCH of `ended_at`, which closed the capture
 * and ran nothing, so a declined meeting was never extracted or triaged.
 *
 * Only the capture's own owner can decline it (the recovery marker is theirs).
 * 200 `{ status: 'ended', processing }`, 200 `{ status: 'already_ended' }`,
 * 404 when it isn't the caller's, 409 when it was written between the read and
 * the close.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const { id } = await params

  const outcome = await declineRecovery(getServiceClient(), { captureId: id, workspaceId, userId: user.id })
  if (outcome.status === 'not_found') return notFound('Capture not found')
  if (outcome.status === 'changed') {
    return apiError('The capture changed while ending it; try again', { status: 409, code: 'CAPTURE_CHANGED' })
  }
  if (outcome.status === 'already_ended') return NextResponse.json({ status: 'already_ended' })

  let processing = false
  if (outcome.finish) {
    try {
      await inngest.send({
        name: CAPTURE_ABANDONED_EVENT,
        // One finish per close: a repeat send is dropped, but a capture that
        // was resumed and then declined again is finished again.
        id: `capture-declined:${id}:${outcome.endedAt}`,
        data: { capture_id: id, workspace_id: workspaceId, reason: 'recovery_declined' },
      })
      processing = true
    } catch (err) {
      // The capture is closed either way; without the event it waits for
      // Reprocess, as a declined capture always did before.
      console.error('[decline-recovery] finalize event failed:', id, err instanceof Error ? err.message : err)
    }
  }
  return NextResponse.json({ status: 'ended', processing })
}
