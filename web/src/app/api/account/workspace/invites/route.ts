import { sendEmail, BASE_URL } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('invite')
    .select('id, email, role, expires_at, created_at, accepted_at')
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ invites: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { email, role, workspace_id: bodyWorkspaceId } = await request.json()

  // Accept an explicit workspace_id in the body (used by the create-workspace
  // wizard so invites go to the newly created workspace, not the old one still
  // stored in the cookie). Fall back to the cookie for all other callers.
  const workspaceId =
    (bodyWorkspaceId as string | undefined) || (await getCurrentWorkspaceId())
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const validRoles = ['admin', 'member', 'guest']
  if (role && !validRoles.includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  // Verify caller is owner or admin
  const { data: callerMember } = await supabase
    .from('member')
    .select('id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single()

  if (!callerMember || !['owner', 'admin'].includes(callerMember.role)) {
    return NextResponse.json(
      { error: 'Only owners and admins can invite' },
      { status: 403 },
    )
  }

  // Check if already a member (via service client to check all users)
  const { data: existingMembers } = await supabase
    .from('member')
    .select('id, user_id')
    .eq('workspace_id', workspaceId)

  // We can't easily check email → user_id mapping through RLS,
  // but we can check for duplicate pending invites
  const { data: existingInvite } = await supabase
    .from('invite')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', email.toLowerCase().trim())
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (existingInvite) {
    return NextResponse.json(
      { error: 'An invite is already pending for this email' },
      { status: 409 },
    )
  }

  const { data: invite, error } = await supabase
    .from('invite')
    .insert({
      workspace_id: workspaceId,
      email: email.toLowerCase().trim(),
      role: role || 'member',
      invited_by: callerMember.id,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

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
