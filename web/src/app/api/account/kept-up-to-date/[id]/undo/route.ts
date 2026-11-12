/**
 * POST /api/account/kept-up-to-date/[id]/undo — take back a change an email,
 * a meeting or a text made (src/lib/kept-up-to-date/engine.ts
 * undoKeptChange): the Undo on its message in the home thread
 * (components/kept-up-to-date/kept-chip.tsx). That source never changes the
 * record again, and no source sets it that way again.
 *
 *   → 200 { status }: 'reverted' (back as it was), 'changed' (changed since,
 *     left as it is), 'gone' (deleted since) or 'already' (undone before), so
 *     a retry is safe.
 *   → 403 the caller can no longer change that table.
 *   → 404 no such change for the caller in this workspace.
 *
 * The row is read for the caller and their workspace only; what goes back
 * comes from the row, never from the request.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { undoKeptChange } from '@/lib/kept-up-to-date/engine'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const { id } = await params
  if (!UUID.test(id)) return badRequest('Invalid id')

  const result = await undoKeptChange(getServiceClient(), { workspaceId, userId: user.id, recordId: id })
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound('No such change')
    if (result.reason === 'forbidden') return apiError('You can no longer change that table', { status: 403, code: 'FORBIDDEN' })
    if (result.reason === 'unavailable') return apiError('Keeping records up to date is not set up yet', { status: 503, code: 'UNAVAILABLE' })
    return serverError('Could not undo the change')
  }
  return NextResponse.json({ status: result.status })
}
