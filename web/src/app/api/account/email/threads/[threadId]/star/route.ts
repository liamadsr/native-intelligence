import { createClient } from '@/lib/supabase/server'
import { toggleThreadStar } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { threadId } = await params
  const body = await request.json()

  try {
    await toggleThreadStar(user.id, threadId, body.starred ?? true)
    return NextResponse.json({ success: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to toggle star'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
