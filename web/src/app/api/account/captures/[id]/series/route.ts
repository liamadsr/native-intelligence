import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { buildSeriesHistory, type SeriesKey } from '@/lib/captures/series-history'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/captures/[id]/series
 *
 * The recurring-meeting history thread for a capture: every capture in this
 * workspace that belongs to the same meeting series (matched by series_key,
 * falling back to ical_uid and the raw calendar_event_id), grouped by
 * occurrence.
 *
 * Runs on the USER-scoped client so RLS enforces the visibility model
 * (mig 223): the caller sees their own captures plus workspace-shared ones —
 * never a teammate's private capture. That IS the product's history rule; do
 * not switch this to the service client.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params

  // User client: a capture the caller can't see (teammate's private) 404s here.
  const { data: anchor, error: anchorError } = await supabase
    .from('captures')
    .select('id, series_key, ical_uid, calendar_event_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (anchorError) return serverError()
  if (!anchor) return notFound('Capture not found')

  const keys: SeriesKey[] = []
  if (anchor.series_key) keys.push({ column: 'series_key', value: anchor.series_key })
  if (anchor.ical_uid) keys.push({ column: 'ical_uid', value: anchor.ical_uid })
  if (anchor.calendar_event_id) {
    keys.push({ column: 'calendar_event_id', value: anchor.calendar_event_id })
  }

  const occurrences = await buildSeriesHistory(supabase, {
    workspaceId,
    requesterUserId: user.id,
    keys,
    keepCaptureId: id,
  })

  return NextResponse.json({
    series_key: anchor.series_key || null,
    ical_uid: anchor.ical_uid || null,
    occurrences,
  })
}
