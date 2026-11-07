import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

interface LocalEventInput {
  id: string
  title: string
  start: string
  end: string
  isAllDay?: boolean
  location?: string
  organizer?: string
  attendees?: string[]
  conferenceUrl?: string
  calendarName?: string
  calendarId?: string
  hasRecurrence?: boolean
  description?: string
}

/**
 * POST: Sync local Exchange calendar events from the desktop app.
 * The desktop pushes events here so the AI can see them server-side.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const events: LocalEventInput[] = body.events
  const timeMin: string | undefined = body.timeMin
  const timeMax: string | undefined = body.timeMax

  if (!Array.isArray(events)) {
    return badRequest('events array is required')
  }

  // Delete-and-replace: remove existing events in the synced time range
  // so cancelled/moved events don't linger in the cache.
  if (timeMin && timeMax) {
    const { error: deleteError } = await supabase
      .from('local_calendar_event')
      .delete()
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .gte('end_at', timeMin)
      .lte('start_at', timeMax)
    if (deleteError) {
      console.error('[local-events] delete error:', deleteError)
    }
  }

  // Deduplicate by external_id (recurring events can share the same EventKit ID)
  const seen = new Set<string>()
  const deduped = events.filter((e) => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })

  // Cap at 500 events per sync
  const batch = deduped.slice(0, 500)

  if (batch.length === 0) {
    return NextResponse.json({ synced: 0 })
  }

  const rows = batch.map((e) => ({
    user_id: user.id,
    workspace_id: workspaceId,
    external_id: e.id,
    title: e.title,
    start_at: e.start,
    end_at: e.end,
    is_all_day: e.isAllDay ?? false,
    location: e.location || null,
    organizer: e.organizer || null,
    attendees: e.attendees || [],
    conference_url: e.conferenceUrl || null,
    calendar_name: e.calendarName || null,
    calendar_id: e.calendarId || null,
    has_recurrence: e.hasRecurrence ?? false,
    description: e.description || null,
    source: 'local_exchange',
    synced_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('local_calendar_event')
    .upsert(rows, { onConflict: 'user_id,external_id' })

  if (error) {
    console.error('[local-events] upsert error:', error)
    return serverError(error.message)
  }

  return NextResponse.json({ synced: rows.length })
}
