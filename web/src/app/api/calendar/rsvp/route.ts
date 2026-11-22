/**
 * /api/calendar/rsvp: the mail view's invitation card.
 *
 *   GET  ?uid=<iCalendar UID>          where the invitation's event is on the
 *                                      person's calendars in this workspace,
 *                                      and the answer the calendar holds
 *   POST { uid, response, which? }     answer it (accepted | declined |
 *                                      tentative) as the person; `which`:
 *                                      'series' (default) or 'occurrence',
 *                                      a repeating event's next one alone
 *
 * Both act on the signed-in person's own calendar accounts linked to the
 * current workspace (src/lib/integrations/calendar-rsvp.ts). A reply that
 * can't be given changes nothing and says why, with a `code` the card reads.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { RSVP_ANSWERS, RSVP_UID_MAX, RSVP_WHICH, RsvpError, invitationStatus, respondToInvitation, type RsvpAnswer, type RsvpErrorCode, type RsvpWhich } from '@/lib/integrations/calendar-rsvp'

export const maxDuration = 30

function validUid(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= RSVP_UID_MAX
}

const STATUS: Record<RsvpErrorCode, number> = {
  not_on_calendar: 404,
  no_calendar: 404,
  gone: 404,
  reconnect: 409,
  organizer: 409,
  not_invited: 409,
  cancelled: 409,
  unreadable: 502,
  provider: 502,
  no_occurrence: 409,
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const uid = request.nextUrl.searchParams.get('uid')
  if (!validUid(uid)) return badRequest('uid is required')
  try {
    return NextResponse.json(await invitationStatus({ userId: auth.user.id, workspaceId: auth.workspaceId }, uid), {
      headers: { 'Cache-Control': 'no-store, private' },
    })
  } catch (err) {
    console.error('[calendar-rsvp] status failed:', err instanceof Error ? err.message : 'unknown error')
    return serverError("Couldn't check your calendar")
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { uid?: unknown; response?: unknown; which?: unknown } | null
  if (!body || !validUid(body.uid)) return badRequest('uid is required')
  if (!RSVP_ANSWERS.includes(body.response as RsvpAnswer)) return badRequest('response must be accepted, declined or tentative')
  // A repeating event: every event (the default), or its next occurrence alone.
  const which = body.which === undefined ? 'series' : (body.which as RsvpWhich)
  if (!RSVP_WHICH.includes(which)) return badRequest('which must be series or occurrence')
  try {
    const status = await respondToInvitation({ userId: auth.user.id, workspaceId: auth.workspaceId }, body.uid, body.response as RsvpAnswer, which)
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (err) {
    if (err instanceof RsvpError) {
      return apiError(err.message, { status: STATUS[err.code], code: `RSVP_${err.code.toUpperCase()}`, ...(err.accountEmail ? { details: { accountEmail: err.accountEmail } } : {}) })
    }
    console.error('[calendar-rsvp] reply failed:', err instanceof Error ? err.message : 'unknown error')
    return serverError("Couldn't answer the invitation")
  }
}
