/**
 * POST /api/account/email/auto-archive/[id]/undo — put a morning tidy's batch
 * back in the inbox (src/lib/email/auto-archive.ts undoAutoArchive): the Undo
 * on its message in the home thread (components/email/email-triage-chip.tsx).
 * From then on, mail from the batch's senders stays in the inbox.
 *
 *   → 200 { restored, failed, gone }: what went back (a thread already back
 *     is not counted, so a retry is safe), what could not (worth a retry), and
 *     what was deleted or trashed since (nothing to put back).
 *   → 404 no such batch for the caller in this workspace.
 *
 * The row is read for the caller and their workspace only; the moves run in
 * the caller's own mailboxes (changeEmailThreads).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { undoAutoArchive } from '@/lib/email/auto-archive'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const { id } = await params
  if (!UUID.test(id)) return badRequest('Invalid batch id')

  const result = await undoAutoArchive(getServiceClient(), { workspaceId, userId: user.id, batchId: id })
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound('No such tidy')
    if (result.reason === 'unavailable') return apiError('The morning tidy is not set up yet', { status: 503, code: 'UNAVAILABLE' })
    return serverError('Could not read the tidy')
  }
  return NextResponse.json({ restored: result.restored, failed: result.failed, gone: result.gone })
}
