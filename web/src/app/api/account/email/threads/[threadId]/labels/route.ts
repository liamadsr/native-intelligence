import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/** Resolve the internal thread UUID from a provider_thread_id */
async function resolveThreadId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  workspaceId: string,
  providerThreadId: string,
) {
  const { data } = await supabase
    .from('email_thread_index')
    .select('id')
    .eq('provider_thread_id', providerThreadId)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .single()
  return data?.id as string | undefined
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { threadId: providerThreadId } = await params
  const threadId = await resolveThreadId(supabase, user.id, workspaceId, providerThreadId)
  if (!threadId) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  try {
    const { data, error } = await supabase
      .from('email_thread_label')
      .select('label:label(id, name, color)')
      .eq('thread_id', threadId)

    if (error) return NextResponse.json({ labels: [] })

    const labels = (data || []).map((row) => row.label).filter(Boolean)
    return NextResponse.json({ labels })
  } catch {
    // Table may not exist yet
    return NextResponse.json({ labels: [] })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { threadId: providerThreadId } = await params
  const body = await request.json()

  if (!body.label_id) {
    return NextResponse.json({ error: 'label_id is required' }, { status: 400 })
  }

  const threadId = await resolveThreadId(supabase, user.id, workspaceId, providerThreadId)
  if (!threadId) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const { error } = await supabase
    .from('email_thread_label')
    .insert({ thread_id: threadId, label_id: body.label_id })

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Label already attached' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
