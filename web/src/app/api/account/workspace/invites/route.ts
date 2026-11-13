import { sendEmail, BASE_URL } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import { canManageJoining, decideInvite } from '@/lib/workspace-join/roles'
import { readMembersCanInvite } from '@/lib/workspace-join/settings'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('invite')
    .select('id, email, role, expires_at, created_at, accepted_at')
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  return NextResponse.json({ invites: data ?? [] })
}

/**
 * POST { email, role?, workspace_id? }: invite someone by email.
 *
 * Owners and admins invite as admin, member or guest. A member may invite
 * too while the workspace's "members can invite people" switch is on
 * (migration 644), as member or guest only; guests never can. The rule is
 * decideInvite (src/lib/workspace-join/roles.ts). A member's invite is
 * written with the service role, since invite RLS (028) lets only owners and
 * admins write; an owner's or admin's still goes through their own session.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  let body: { email?: unknown; role?: unknown; workspace_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON')
  }
  const { email, role, workspace_id: bodyWorkspaceId } = body

  // Accept an explicit workspace_id in the body (used by the create-workspace
  // wizard so invites go to the newly created workspace, not the old one still
  // stored in the cookie). Fall back to the resolved workspace for all other callers.
  let workspaceId = auth.workspaceId
  let caller: { id: string; role?: string | null } = auth.member
  if (typeof bodyWorkspaceId === 'string' && bodyWorkspaceId && bodyWorkspaceId !== workspaceId) {
    const { data: other } = await supabase
      .from('member')
      .select('id, role')
      .eq('workspace_id', bodyWorkspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!other) return forbidden('Only owners and admins can invite')
    workspaceId = bodyWorkspaceId
    caller = other
  }

  if (!email || typeof email !== 'string') return badRequest('Email is required')

  const managing = canManageJoining(caller.role)
  let membersCanInvite = false
  if (!managing && caller.role === 'member') {
    try {
      membersCanInvite = await readMembersCanInvite(getServiceClient(), workspaceId)
    } catch (err) {
      console.error('[invites] members-can-invite read failed:', err instanceof Error ? err.message : err)
      return serverError()
    }
  }
  const decision = decideInvite(caller.role, membersCanInvite, role)
  if (!decision.ok) {
    return decision.status === 400 ? badRequest(decision.message) : forbidden(decision.message)
  }

  // An owner's or admin's invite goes through their own session (invite RLS);
  // a member's, allowed above, through the service role.
  const db = managing ? supabase : getServiceClient()
  const address = email.toLowerCase().trim()

  // We can't easily check email → user_id mapping through RLS,
  // but we can check for duplicate pending invites
  const { data: existingInvite } = await db
    .from('invite')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', address)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (existingInvite) return conflict('An invite is already pending for this email')

  const { data: invite, error } = await db
    .from('invite')
    .insert({
      workspace_id: workspaceId,
      email: address,
      role: decision.role,
      invited_by: caller.id,
    })
    .select()
    .single()

  if (error || !invite) return serverError(error?.message)

  // Fetch workspace name for the email
  const { data: workspace } = await supabase
    .from('workspace')
    .select('name')
    .eq('id', workspaceId)
    .single()

  // Send invite email via Resend
  const inviteUrl = `${BASE_URL}/invite/${invite.token}`
  const workspaceName = workspace?.name ?? 'a workspace'
  // The name is owner-set free text: escape it for the HTML body (the subject
  // is plain text).
  const workspaceNameHtml = escapeHtml(workspaceName)

  // The Resend SDK reports a refused send in `error` rather than throwing, so
  // both paths land in emailSent = false.
  let emailSent = false
  try {
    const { error: sendError } = await sendEmail({
      to: invite.email,
      subject: `You've been invited to join ${workspaceName} on Native Intelligence`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="margin: 0 0 16px;">You're invited to ${workspaceNameHtml}</h2>
          <p style="color: #555; line-height: 1.6;">
            You've been invited to join <strong>${workspaceNameHtml}</strong> on Native Intelligence as a <strong>${invite.role}</strong>.
          </p>
          <a href="${inviteUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
            Accept Invite
          </a>
          <p style="color: #888; font-size: 13px; line-height: 1.5;">
            This invite expires in 7 days. If you didn't expect this email, you can ignore it.
          </p>
        </div>
      `,
    })
    if (sendError) console.error('Failed to send invite email:', sendError)
    else emailSent = true
  } catch (emailError) {
    console.error('Failed to send invite email:', emailError)
  }
  // Invite was created either way — don't fail the request; `email_sent`
  // tells the caller whether the invitee was actually emailed.

  // Virality: the top of the invite loop. Paired with `invite_accepted`, this
  // lets the dashboard compute the K-factor (accepted / sent) that turns linear
  // acquisition into exponential growth. Only a mail that left counts as sent.
  if (emailSent) {
    trackServerEvent('invite_sent', { userId: user.id, workspaceId, email: user.email }, {
      invite_id: invite.id,
      role: invite.role || 'member',
    })
  }

  return NextResponse.json({ invite, email_sent: emailSent }, { status: 201 })
}
