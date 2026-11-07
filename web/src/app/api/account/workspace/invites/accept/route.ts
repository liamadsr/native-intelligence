import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { WORKSPACE_COOKIE } from '@/lib/workspace'
import { ensureMemberContact } from '@/lib/crm/contacts'
import { trackServerEvent } from '@/lib/posthog'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { token } = await request.json()
  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 })
  }

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
    return NextResponse.json(
      { error: 'Invalid or expired invite' },
      { status: 400 },
    )
  }

  // Verify email matches
  if (invite.email.toLowerCase() !== user.email?.toLowerCase()) {
    return NextResponse.json(
      { error: 'This invite was sent to a different email address' },
      { status: 403 },
    )
  }

  // Check if already a member
  const { data: existingMember } = await service
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', invite.workspace_id)
    .single()

  if (existingMember) {
    // Mark invite as accepted anyway
    await service
      .from('invite')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)

    return NextResponse.json({
      workspace_id: invite.workspace_id,
      already_member: true,
    })
  }

  // Create member record — skip onboarding since user already has an account
  const { data: newMember, error: memberError } = await service.from('member').insert({
    user_id: user.id,
    workspace_id: invite.workspace_id,
    role: invite.role,
    display_name:
      user.user_metadata?.full_name ||
      user.email?.split('@')[0] ||
      'User',
    onboarding_completed_at: new Date().toISOString(),
  }).select('id').single()

  if (memberError) {
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  // Create CRM contact for the new member
  await ensureMemberContact(invite.workspace_id, newMember.id, user)

  // Mark invite as accepted
  await service
    .from('invite')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  // Virality: the bottom of the invite loop — a recipient actually joined.
  // Bucketed against `invite_sent` this is the K-factor numerator.
  trackServerEvent(
    'invite_accepted',
    { userId: user.id, workspaceId: invite.workspace_id, email: user.email },
    { invite_id: invite.id, role: invite.role },
  )

  // Set workspace cookie to the new workspace
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, invite.workspace_id, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  return NextResponse.json({ workspace_id: invite.workspace_id })
}
