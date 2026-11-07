import { createClient } from '@/lib/supabase/server'
import { archiveThread } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { threadId } = await params

  try {
    await archiveThread(user.id, threadId)
    return NextResponse.json({ success: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to archive'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
