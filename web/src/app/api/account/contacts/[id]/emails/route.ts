import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { HEADER_ROW_COLUMNS, withLiveHeaders, type HeaderRow } from '@/lib/email/thread-headers'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  // Get the contact's email
  const { data: contact } = await supabase
    .from('contact')
    .select('email')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!contact?.email) {
    return NextResponse.json({ email_threads: [] })
  }

  const { data, error } = await supabase
    .from('email_thread_index')
    .select(`${HEADER_ROW_COLUMNS}, from_email, last_message_at, needs_reply, auto_classified, message_count, is_unread`)
    .contains('participant_emails', [contact.email])
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .order('last_message_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Subjects and previews come live from the mailbox (no stored mail).
  const rows = (data ?? []) as unknown as HeaderRow[]
  const email_threads = await withLiveHeaders(getServiceClient(), { userId: user.id, workspaceId, rows })
  return NextResponse.json({ email_threads })
}
