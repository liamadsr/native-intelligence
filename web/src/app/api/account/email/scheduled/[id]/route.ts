/**
 * DELETE /api/account/email/scheduled/[id]: dismiss a failed scheduled send
 * from the Scheduled folder (its draft, if any, stays in the mailbox). Only
 * the caller's own row, and only a failed one (409 otherwise).
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, conflict, notFound } from '@/lib/api-errors'
import { dismissScheduledSend } from '@/lib/email/scheduled-send'
import { isUuid } from '@/lib/work/touch'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return badRequest('Invalid id')
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const result = await dismissScheduledSend(auth.user.id, auth.workspaceId, id.toLowerCase())
  if (result.ok) return NextResponse.json({ ok: true })
  return result.reason === 'not_found' ? notFound('Scheduled email not found') : conflict('Only a send that failed can be dismissed')
}
