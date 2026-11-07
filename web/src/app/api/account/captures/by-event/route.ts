import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/captures/by-event?calendar_event_id=...
 *
 * Returns the capture linked to a given calendar event ID, if any.
 * Used by the tray "Start" button and calendar views to avoid duplicates.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const calendarEventId = request.nextUrl.searchParams.get('calendar_event_id')
  if (!calendarEventId) {
    return NextResponse.json({ error: 'calendar_event_id is required' }, { status: 400 })
  }

  const { data } = await supabase
    .from('captures')
    .select('id, title, status, ai_processed, started_at, ended_at')
    .eq('calendar_event_id', calendarEventId)
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .limit(1)
    .maybeSingle()

  return NextResponse.json({ capture: data || null })
}
