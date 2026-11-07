import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string; labelId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { threadId: providerThreadId, labelId } = await params

  // Resolve internal thread ID
  const { data: thread } = await supabase
    .from('email_thread_index')
    .select('id')
    .eq('provider_thread_id', providerThreadId)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const { error } = await supabase
    .from('email_thread_label')
    .delete()
    .eq('thread_id', thread.id)
    .eq('label_id', labelId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
