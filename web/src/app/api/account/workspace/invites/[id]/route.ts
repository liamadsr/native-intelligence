import { sendEmail, BASE_URL } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

/** Resend an existing invite email */
export async function POST(
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

  // RLS restricts to owner/admin
  const { data: invite, error } = await supabase
    .from('invite')
    .select('id, email, role, token, workspace_id, accepted_at, expires_at')
    .eq('id', id)
    .single()

  if (error || !invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  }

  if (invite.accepted_at) {
    return NextResponse.json({ error: 'Invite already accepted' }, { status: 400 })
  }

  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Invite has expired' }, { status: 400 })
  }

  const { data: workspace } = await supabase
    .from('workspace')
    .select('name')
    .eq('id', invite.workspace_id)
    .single()

  const inviteUrl = `${BASE_URL}/invite/${invite.token}`
  const workspaceName = workspace?.name ?? 'a workspace'
  // The name is owner-set free text: escape it for the HTML body (the subject
  // is plain text).
  const workspaceNameHtml = escapeHtml(workspaceName)

  try {
    // The Resend SDK reports a refused send in `error` rather than throwing.
    const { error: sendError } = await sendEmail({
      to: invite.email,
      subject: `Reminder: You've been invited to join ${workspaceName} on Native Intelligence`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="margin: 0 0 16px;">You're invited to ${workspaceNameHtml}</h2>
          <p style="color: #555; line-height: 1.6;">
            This is a reminder that you've been invited to join <strong>${workspaceNameHtml}</strong> on Native Intelligence as a <strong>${invite.role}</strong>.
          </p>
          <a href="${inviteUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
            Accept Invite
          </a>
          <p style="color: #888; font-size: 13px; line-height: 1.5;">
            This invite expires on ${new Date(invite.expires_at).toLocaleDateString()}. If you didn't expect this email, you can ignore it.
          </p>
        </div>
      `,
    })
    if (sendError) {
      console.error('Failed to resend invite email:', sendError)
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
    }
  } catch (emailError) {
    console.error('Failed to resend invite email:', emailError)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

/** Update the role on a pending invite */
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
  const { role } = await request.json()

  const validRoles = ['admin', 'member', 'guest']
  if (!role || !validRoles.includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  // RLS restricts to owner/admin
  const { data: invite, error } = await supabase
    .from('invite')
    .update({ role })
    .eq('id', id)
    .is('accepted_at', null)
    .select('id, email, role, expires_at, created_at, accepted_at')
    .single()

  if (error || !invite) {
    return NextResponse.json({ error: 'Invite not found or already accepted' }, { status: 404 })
  }

  return NextResponse.json({ invite })
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

  // RLS on invite table already restricts to owner/admin
  const { error } = await supabase.from('invite').delete().eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
