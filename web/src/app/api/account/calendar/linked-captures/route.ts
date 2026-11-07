import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getCapturesForCalendarEvents } from '@/lib/integrations/calendar-sync'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { event_ids } = await req.json()
  if (!Array.isArray(event_ids) || !event_ids.length) {
    return NextResponse.json({})
  }

  try {
    const result = await getCapturesForCalendarEvents(user.id, workspaceId, event_ids)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Linked captures error:', error)
    return NextResponse.json({})
  }
}
