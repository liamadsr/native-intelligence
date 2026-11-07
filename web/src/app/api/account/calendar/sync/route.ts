import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { syncCalendarToCaptures } from '@/lib/integrations/calendar-sync'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  try {
    const result = await syncCalendarToCaptures(user.id, workspaceId)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Calendar sync error:', error)
    return NextResponse.json(
      { error: 'Failed to sync calendar' },
      { status: 500 },
    )
  }
}
