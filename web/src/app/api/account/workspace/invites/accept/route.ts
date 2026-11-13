import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { joinWorkspace, type JoinRole } from '@/lib/workspace-join/add-member'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST { token }: accept an emailed workspace invite. The member setup (row,
 * CRM contact, `invite_accepted`, workspace cookie) is the one every way in
 * shares (src/lib/workspace-join/add-member.ts), with joined_via 'invite'.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let token: unknown
  try {
    token = ((await request.json()) as { token?: unknown })?.token
  } catch {
    return badRequest('Invalid JSON')
  }
  if (!token || typeof token !== 'string') return badRequest('Token is required')

  // Use service client — the user is not yet a member so RLS would block
  const service = getServiceClient()

  const { data: invite, error } = await service
    .from('invite')
    .select('*')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error || !invite) {
    return apiError('Invalid or expired invite', { status: 400, code: 'INVITE_INVALID' })
  }

  // Verify email matches
  if (invite.email.toLowerCase() !== user.email?.toLowerCase()) {
    return forbidden('This invite was sent to a different email address')
  }

  const result = await joinWorkspace({
    service,
    user,
    workspaceId: invite.workspace_id,
    role: invite.role as JoinRole,
    via: 'invite',
    activate: 'always',
    inviteId: invite.id,
  })
  if (!result.ok) return serverError(result.error)

  // Mark invite as accepted (an already-member's too)
  await service
    .from('invite')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  if (result.alreadyMember) {
    return NextResponse.json({ workspace_id: invite.workspace_id, already_member: true })
  }
  return NextResponse.json({ workspace_id: invite.workspace_id })
}
