/**
 * POST /api/account/email/scheduled/[id]/send-now: send a scheduled message
 * now, from the Scheduled folder. The caller's own row only, while it is
 * still 'scheduled': it is taken to 'sending' in one conditional update (its
 * time moved to now), so its timed event and the sweep send nothing after.
 * `{ outcome: 'sent' }`; a send that fails is the row's 'failed' with its
 * reason (`{ outcome: 'failed', error }`, 502); 409 when it was no longer
 * waiting.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, conflict, notFound } from '@/lib/api-errors'
import { defaultScheduledSendDeps, ownScheduledSend, sendScheduledEmail } from '@/lib/email/scheduled-send'
import { isUuid } from '@/lib/work/touch'

export const maxDuration = 30

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params
  if (!isUuid(rawId)) return badRequest('Invalid id')
  const id = rawId.toLowerCase()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const own = await ownScheduledSend(defaultScheduledSendDeps, user.id, workspaceId, id)
  if (!own) return notFound('Scheduled email not found')
  if (own.status !== 'scheduled') return conflict('It is already being sent, or was sent')

  const outcome = await sendScheduledEmail(id, { userId: user.id, immediate: true })
  if (outcome === 'sent') return NextResponse.json({ outcome })
  if (outcome === 'skipped') return conflict('It is already being sent, or was sent')
  const after = await ownScheduledSend(defaultScheduledSendDeps, user.id, workspaceId, id)
  return apiError(after?.error ?? 'It was not sent', { status: 502, code: 'SEND_FAILED' })
}
