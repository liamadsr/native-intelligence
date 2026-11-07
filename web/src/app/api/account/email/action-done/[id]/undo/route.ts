/**
 * POST /api/account/email/action-done/[id]/undo — reopen a to-do arriving
 * mail marked done (src/lib/email/action-done-from-mail.ts
 * undoActionDoneFromMail): the Undo on its message in the home thread
 * (components/email/action-done-chip.tsx). Mail never closes that to-do again.
 *
 *   → 200 { status }: 'reopened' (back where it was), 'changed' (moved since,
 *     left where the person put it), 'gone' (deleted since) or 'already'
 *     (undone before), so a retry is safe.
 *   → 404 no such close for the caller in this workspace.
 *
 * The row is read for the caller and their workspace only; what goes back
 * comes from the row, never from the request.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { undoActionDoneFromMail } from '@/lib/email/action-done-from-mail'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const { id } = await params
  if (!UUID.test(id)) return badRequest('Invalid id')

  const result = await undoActionDoneFromMail(getServiceClient(), { workspaceId, userId: user.id, recordId: id })
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound('No such to-do closed by mail')
    if (result.reason === 'unavailable') return apiError('Closing to-dos from mail is not set up yet', { status: 503, code: 'UNAVAILABLE' })
    return serverError('Could not reopen the to-do')
  }
  return NextResponse.json({ status: result.status })
}
