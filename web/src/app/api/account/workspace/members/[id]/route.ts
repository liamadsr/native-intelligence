import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { requestTeamCallEjections } from '@/lib/team-calls/eject'
import { getServiceClient } from '@/lib/admin'
import { recordLeftWorkspace } from '@/lib/workspace-join/marks'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const { role } = await request.json()
  const validRoles = ['admin', 'member', 'guest']
  if (!validRoles.includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  // Verify caller is owner or admin
  const { data: caller } = await supabase
    .from('member')
    .select('id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single()

  if (!caller || !['owner', 'admin'].includes(caller.role)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  // Cannot change own role
  if (caller.id === id) {
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 })
  }

  // Admins cannot set someone to owner
  if (caller.role === 'admin' && role === 'owner') {
    return NextResponse.json({ error: 'Only owners can promote to owner' }, { status: 403 })
  }

  // The owner's role moves only through transfer-owner. Settings never offers
  // it, and the database refuses it from an admin too (migration 306).
  const { data: target } = await supabase
    .from('member')
    .select('id, role')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string; role: string }>()

  if (!target) {
    return notFound('Member not found in this workspace')
  }
  if (target.role === 'owner') {
    return forbidden("The owner's role changes only by transferring ownership")
  }

  const { data, error } = await supabase
    .from('member')
    .update({ role })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) {
    // 42501: the database's member guard (migration 306) refused the change.
    if (error.code === '42501') return forbidden('Insufficient permissions')
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ member: data })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  // Verify caller is owner
  const { data: caller } = await supabase
    .from('member')
    .select('id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single()

  if (!caller || caller.role !== 'owner') {
    return NextResponse.json({ error: 'Only owners can remove members' }, { status: 403 })
  }

  // Cannot remove self
  if (caller.id === id) {
    return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 })
  }

  // Remembered first, on the removed person's account, however they had
  // joined: join-by-email-domain never offers this workspace to them again
  // (src/lib/workspace-join/marks.ts). If that can't be written they stay in.
  // (The invite link still works for them; resetting it is the admin's call.)
  const { data: target } = await supabase
    .from('member')
    .select('id, user_id, role')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string; user_id?: string; role: string }>()
  if (target?.user_id && target.role !== 'owner') {
    try {
      await recordLeftWorkspace(getServiceClient(), target.user_id, workspaceId)
    } catch (err) {
      console.error('[members] removed mark failed:', err instanceof Error ? err.message : err)
      return serverError('Could not remove the member. Try again.')
    }
  }

  // What goes with them and what stays (their comments and drafts) is the
  // schema's (migration 320); before it, anyone who had applied a suggestion
  // couldn't be removed. Nothing deleted is a 404, never ok.
  const { data: removed, error } = await supabase
    .from('member')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .neq('role', 'owner')
    .select('id')

  if (error) return serverError(error.message)
  if (!removed || removed.length === 0) {
    return notFound('Member not found in this workspace')
  }

  // Out of any call of the workspace now (the database queued it; this drains it at once).
  await requestTeamCallEjections()
  return NextResponse.json({ ok: true })
}
