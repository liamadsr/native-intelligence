/**
 * GET /api/account/email/threads/[threadId]/invite?message=<id>&name=<file name>
 *
 * The invitation in a calendar file attached to one of the person's own
 * messages (an `.ics` with no `text/calendar` part beside it, as Outlook and
 * some booking tools send), read for the invitation card.
 *
 * The file is read live from the person's mailbox in this workspace
 * (readEmailAttachment), only when it is no larger than INVITE_MAX_BYTES (a
 * larger one is never downloaded), and is parsed by parseCalendarInvite: plain text in, plain fields out. Nothing
 * the file names (an ATTACH or image URL, a time-zone URL) is fetched, and
 * nothing is stored.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { readEmailAttachment } from '@/lib/email/email-read-service'
import { INVITE_MAX_BYTES, parseCalendarInvite } from '@/lib/email/calendar-invite'

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const name = request.nextUrl.searchParams.get('name') ?? ''
  if (!messageId || !name || messageId.length > 512 || name.length > 512) return badRequest('message and name are required')

  try {
    const file = await readEmailAttachment(user.id, messageId, name, workspaceId, INVITE_MAX_BYTES)
    if (!file) return notFound("Couldn't find that calendar file, or it is too large to read")
    // Not valid UTF-8: the stray bytes become U+FFFD and the parser reads what it can.
    const invite = parseCalendarInvite(new TextDecoder('utf-8').decode(file.bytes))
    if (!invite) return notFound('That file holds no event')
    return NextResponse.json({ invite }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (err) {
    console.error('[email] attached invitation read failed:', err instanceof Error ? err.message : 'unknown error')
    return serverError("Couldn't read that calendar file")
  }
}
