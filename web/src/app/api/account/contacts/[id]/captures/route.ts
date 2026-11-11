import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

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

  // Verify contact belongs to this workspace
  const { data: contact } = await supabase
    .from('contact')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // From the captures side, newest meeting first, once each. capture_participant
  // has no created_at (it has joined_at): ordering by it failed every read.
  const { data, error } = await supabase
    .from('captures')
    .select('id, title, ai_summary, started_at, ended_at, status, ai_processed, cp:capture_participant!inner(contact_id)')
    .eq('workspace_id', workspaceId)
    .eq('cp.contact_id', id)
    // Eval captures (migration 252) are synthetic meetings that RLS doesn't hide.
    .neq('is_eval', true)
    // Archived meetings and auto-capture placeholders that never started stay out.
    .neq('status', 'archived')
    .not('started_at', 'is', null)
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const captures = (data || []).map(({ cp: _cp, ...capture }) => capture)

  return NextResponse.json({ captures })
}
