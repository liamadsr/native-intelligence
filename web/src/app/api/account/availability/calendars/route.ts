import { type NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { listCalendarChoices, saveCalendarChoice } from '@/lib/availability/calendar-choices'

/**
 * /api/account/availability/calendars — which of the caller's calendars
 * count as busy (calendar_sub_preference.counts_as_busy, 550), for Settings
 * > Availability. The accounts and calendars GET /api/calendar/calendars
 * lists, scoped to the current workspace as the busy read is.
 *
 *   GET → { accounts: [{ id, provider, account_email, error, calendars:
 *           [{ id, name, color, primary, counts, counts_by_default }] }] }
 *   PUT { account_id, calendar_id, counts } → { ok: true }
 *       Only on an account of the caller's own.
 */

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    const accounts = await listCalendarChoices(getServiceClient(), auth.user.id, auth.workspaceId)
    return NextResponse.json(
      {
        accounts: accounts.map((a) => ({
          id: a.id,
          provider: a.provider,
          account_email: a.accountEmail,
          error: a.error,
          calendars: a.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: c.primary, counts: c.counts, counts_by_default: c.countsByDefault })),
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read your calendars')
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  let body: { account_id?: unknown; calendar_id?: unknown; counts?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('Body must be JSON')
  }
  const { account_id, calendar_id, counts } = body ?? {}
  if (typeof account_id !== 'string' || !account_id || typeof calendar_id !== 'string' || !calendar_id || calendar_id.length > 1024 || typeof counts !== 'boolean') {
    return badRequest('account_id, calendar_id and counts (true or false) are required')
  }
  try {
    await saveCalendarChoice(getServiceClient(), auth.user.id, { accountId: account_id, calendarId: calendar_id, counts })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save'
    return message === 'Unknown calendar account' ? badRequest(message) : serverError(message)
  }
}
