/**
 * POST /api/account/email/scheduled/[id]/cancel: Undo after scheduling, or
 * Cancel in the Scheduled folder. The message stays in the mailbox as a
 * normal draft. Only the caller's own row, and only while it is still
 * 'scheduled' (409 once it is being sent, sent or failed).
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, conflict, notFound } from '@/lib/api-errors'
import { cancelScheduledSend } from '@/lib/email/scheduled-send'
import { isUuid } from '@/lib/work/touch'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return badRequest('Invalid id')
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const result = await cancelScheduledSend(auth.user.id, auth.workspaceId, id.toLowerCase())
  if (result.ok) return NextResponse.json({ ok: true })
  return result.reason === 'not_found' ? notFound('Scheduled email not found') : conflict('It is already being sent, or was sent')
}
