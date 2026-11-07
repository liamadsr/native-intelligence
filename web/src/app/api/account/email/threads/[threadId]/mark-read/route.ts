import { createClient } from '@/lib/supabase/server'
import { toggleThreadRead } from '@/lib/crm/email-client'
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
    await toggleThreadRead(user.id, threadId, body.is_read ?? true)
    return NextResponse.json({ success: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to update read status'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
