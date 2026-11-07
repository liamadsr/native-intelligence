import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/workspace/transfer-owner
 *
 * Transfers workspace ownership from the current owner to another member.
 * Only the workspace owner may call this.
 *
 * Body: { member_id: string }  — UUID of the target member row
 *
 * The target member is promoted to 'owner'. The current owner is demoted to
 * 'admin'. The two updates are sequential; if the second fails the workspace
 * will temporarily have two owners — the caller can retry to demote themselves.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  if (member.role !== 'owner') {
    return forbidden('Only the workspace owner can transfer ownership')
  }

  const body = await request.json()
  const targetMemberId: string | undefined = body.member_id

  if (!targetMemberId) {
    return badRequest('member_id is required')
  }

  if (targetMemberId === member.id) {
    return badRequest('You are already the owner')
  }

  // Verify the target is actually a member of this workspace.
  const { data: targetMember } = await supabase
    .from('member')
    .select('id, display_name, role')
    .eq('id', targetMemberId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!targetMember) {
    return notFound('Member not found in this workspace')
  }

  // Promote target to owner first so there is always at least one owner
  // during the transition.
  const { error: promoteError } = await supabase
    .from('member')
    .update({ role: 'owner' })
    .eq('id', targetMemberId)
    .eq('workspace_id', workspaceId)

  if (promoteError) return serverError(promoteError.message)

  // Demote the previous owner to admin.
  const { error: demoteError } = await supabase
    .from('member')
    .update({ role: 'admin' })
    .eq('id', member.id)
    .eq('workspace_id', workspaceId)

  if (demoteError) return serverError(demoteError.message)

  return NextResponse.json({ ok: true })
}
