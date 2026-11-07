import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'

/**
 * DELETE /api/account/actions/[id]/prs/[prId] — Unlink a PR from an action.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; prId: string }> },
) {
  const { id: actionId, prId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { error } = await supabase
    .from('action_github_pr')
    .delete()
    .eq('id', prId)
    .eq('action_id', actionId)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
