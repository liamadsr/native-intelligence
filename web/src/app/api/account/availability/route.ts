import { type NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { readWorkingHours, saveWorkingHours, type WorkingHours } from '@/lib/availability/schedule'
import { isAvailabilitySharing, readSharing, saveSharing, type AvailabilitySharing } from '@/lib/availability/sharing'

/**
 * /api/account/availability — Settings > Availability: the caller's working
 * hours (availability_schedule, 550; one row per person) and whether their
 * teammates in the current workspace may see when they are busy
 * (member.availability_sharing, 552).
 *
 *   GET → { hours, sharing }
 *   PUT { weekly?, clear_dates?, sharing? } → { hours, sharing }
 *       weekly: seven days, Sunday first, each a list of { start, end }
 *       HH:MM ranges (an empty day is a day off); clear_dates: dated
 *       changes to remove; sharing: 'busy_only' or 'none'.
 *
 * Only the service role writes either (the person's own row, fenced on the
 * caller here); the store refuses a bad value before writing anything.
 */

function hoursBody(hours: WorkingHours) {
  return { time_zone: hours.timeZone, follows_you: hours.zoneSource === 'member', weekly: hours.weekly, overrides: hours.overrides, saved: hours.saved }
}

async function answer(person: { userId: string; workspaceId: string }, sharing?: AvailabilitySharing) {
  const service = getServiceClient()
  const [hours, current] = await Promise.all([readWorkingHours(service, person), sharing ? Promise.resolve(sharing) : readSharing(service, person)])
  return NextResponse.json({ hours: hoursBody(hours), sharing: current }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return await answer({ userId: auth.user.id, workspaceId: auth.workspaceId })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read your availability')
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const person = { userId: auth.user.id, workspaceId: auth.workspaceId }
  let body: { weekly?: unknown; clear_dates?: unknown; sharing?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('Body must be JSON')
  }
  if (!body || typeof body !== 'object') return badRequest('Body must be an object')
  if (body.sharing !== undefined && !isAvailabilitySharing(body.sharing)) return badRequest("sharing is 'busy_only' or 'none'")
  if (body.clear_dates !== undefined && (!Array.isArray(body.clear_dates) || body.clear_dates.some((d) => typeof d !== 'string') || body.clear_dates.length > 400)) {
    return badRequest('clear_dates is a list of ISO dates')
  }
  const service = getServiceClient()
  try {
    if (body.weekly !== undefined || body.clear_dates !== undefined) {
      try {
        await saveWorkingHours(service, person, {
          ...(body.weekly !== undefined ? { weekly: body.weekly as WorkingHours['weekly'] } : {}),
          ...(body.clear_dates !== undefined ? { clearOverrides: body.clear_dates as string[] } : {}),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not save your hours'
        // A bad value is the caller's; a failed write is ours.
        return /could not be (saved|read)/i.test(message) ? serverError(message) : badRequest(message)
      }
    }
    const sharing = isAvailabilitySharing(body.sharing) ? await saveSharing(service, person, body.sharing) : undefined
    return await answer(person, sharing)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not save your availability')
  }
}
