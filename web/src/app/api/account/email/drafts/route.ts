import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { searchParams } = request.nextUrl
  const status = searchParams.get('status') || 'pending_review'
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)

  let query = supabase
    .from('email_draft')
    .select('*, email_thread:email_thread_id(from_email, provider_thread_id)')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)

  if (status !== 'all') {
    query = query.eq('status', status)
  }

  query = query
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ drafts: data || [] })
}
