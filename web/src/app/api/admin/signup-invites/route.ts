import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import {
  normalizeInviteEmail,
  sendSignupInviteEmail,
  signupInviteUrl,
  upsertSignupInvite,
} from '@/lib/admin/signup-invites'

/** List signup invites, newest first. */
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('signup_invite')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ invites: data ?? [] })
}

/**
 * Create (or refresh) a signup invite for one address and email the link.
 * Body: { email: string, note?: string, send?: boolean, skip_payment?: boolean }
 * — `send` defaults to true (pass false to mint a link without emailing it);
 * `skip_payment` defaults to true (comp seat) — false means the invitee only
 * bypasses the business-email gate and still adds a card for the trial.
 */
export async function POST(request: Request) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { email?: unknown; note?: unknown; send?: unknown; skip_payment?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email = normalizeInviteEmail(body.email)
  if (!email) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  }
  const note =
    typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null
  const send = body.send !== false
  const skipPayment = body.skip_payment !== false

  const supabase = await getAdminServiceClient()
  const result = await upsertSignupInvite(supabase, { email, invitedBy: admin.id, note, skipPayment })

  if (!result.ok) {
    if (result.reason === 'already_used') {
      return NextResponse.json(
        { error: 'This address already signed up with its invite', invite: result.invite },
        { status: 409 },
      )
    }
    console.error('[signup-invites] db error:', result.message)
    return NextResponse.json({ error: 'Failed to save invite' }, { status: 500 })
  }

  let emailSent = false
  let emailError: string | null = null
  if (send) {
    try {
      await sendSignupInviteEmail(result.invite)
      emailSent = true
    } catch (err) {
      // The invite row exists and the link works; report the delivery
      // failure rather than failing the request so the admin can copy it.
      emailError = err instanceof Error ? err.message : 'send failed'
      console.error('[signup-invites] email failed:', emailError)
    }
  }

  return NextResponse.json(
    {
      invite: result.invite,
      url: signupInviteUrl(result.invite.token),
      refreshed: result.refreshed,
      email_sent: emailSent,
      email_error: emailError,
    },
    { status: result.refreshed ? 200 : 201 },
  )
}
