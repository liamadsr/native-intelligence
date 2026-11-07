import { requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { buildSeriesHistory, type SeriesKey } from '@/lib/captures/series-history'
import { parseGoogleSeriesFromInstanceId } from '@/lib/integrations/meeting-series'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/calendar/event-series
 *
 * Event-anchored variant of the capture series endpoint, for calendar
 * occurrences that have no capture yet (Google/Microsoft mint per-occurrence
 * event ids, so a fresh occurrence has no linked capture to anchor on while
 * the series may have months of history).
 *
 * Query params: series_master_id, ical_uid, calendar_event_id (any subset).
 * Same visibility rule as the capture-anchored route: user-scoped client, RLS
 * decides what the caller may see.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const url = new URL(request.url)
  const seriesMasterId = url.searchParams.get('series_master_id')?.trim() || null
  const icalUid = url.searchParams.get('ical_uid')?.trim() || null
  const calendarEventId = url.searchParams.get('calendar_event_id')?.trim() || null

  // A bare Google instance id still identifies its series via the id prefix.
  const seriesKey =
    seriesMasterId ||
    (calendarEventId ? parseGoogleSeriesFromInstanceId(calendarEventId) : null)

  const keys: SeriesKey[] = []
  if (seriesKey) keys.push({ column: 'series_key', value: seriesKey })
  if (icalUid) keys.push({ column: 'ical_uid', value: icalUid })
  if (calendarEventId) keys.push({ column: 'calendar_event_id', value: calendarEventId })

  if (keys.length === 0) {
    return badRequest('Provide series_master_id, ical_uid, or calendar_event_id')
  }

  const occurrences = await buildSeriesHistory(supabase, {
    workspaceId,
    requesterUserId: user.id,
    keys,
  })

  return NextResponse.json({ occurrences })
}
