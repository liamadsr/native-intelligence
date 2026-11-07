import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/confirm-all-actions
 * Bulk confirms all suggested actions from a specific capture.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  // Verify the capture belongs to this user/workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  // Count how many will be confirmed
  const { count: suggestedCount } = await supabase
    .from('actions')
    .select('id', { count: 'exact', head: true })
    .eq('source_capture_id', id)
    .eq('workspace_id', workspaceId)
    .eq('confirmation', 'suggested')

  // Bulk update
  const { error } = await supabase
    .from('actions')
    .update({ confirmation: 'confirmed' })
    .eq('source_capture_id', id)
    .eq('workspace_id', workspaceId)
    .eq('confirmation', 'suggested')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ confirmed_count: suggestedCount || 0 })
}
