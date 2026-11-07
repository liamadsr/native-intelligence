import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const body = await request.json()
  const { visibility } = body

  if (!visibility || !['private', 'team', 'workspace'].includes(visibility)) {
    return NextResponse.json({ error: 'visibility must be private, team, or workspace' }, { status: 400 })
  }

  // RLS on contact UPDATE ensures only creator/admin/edit-shared can update
  const { data, error } = await supabase
    .from('contact')
    .update({ visibility, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, visibility')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ contact: data })
}
