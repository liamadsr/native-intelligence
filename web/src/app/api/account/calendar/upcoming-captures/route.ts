import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getUpcomingCaptures } from '@/lib/integrations/calendar-sync'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  try {
    const captures = await getUpcomingCaptures(user.id, workspaceId)
    return NextResponse.json({ captures })
  } catch (error) {
    console.error('Upcoming captures error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch upcoming captures' },
      { status: 500 },
    )
  }
}
