import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { classifyBillingAccess } from '@/lib/billing/access'
import { assignSubscriberPlan } from '@/lib/billing/subscription-sync'
import { findSignupInviteForUser } from '@/lib/admin/signup-invites'
import type { SubscriptionRow } from '@/app/api/billing/status/pick-subscription'

/**
 * "Continue without adding a card" — for people invited from the admin
 * console. Proof is the `signup_invite` row stamped with this user's id at
 * signup (migration 242); nobody else can call this successfully.
 *
 * Grants a complimentary subscription row (`granted_invite_…`, no period end)
 * exactly like an admin grant, so every downstream check — the trial wall,
 * check_ai_usage_limit, the billing page — sees a normal active seat. An
 * admin can end it later from /admin/users.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const service = getServiceClient()

  // Stamped at signup, or still pending for this email (accounts that
  // predate the invite never fire the signup trigger — see the helper).
  const [invite, { data: rows }] = await Promise.all([
    findSignupInviteForUser(service, user),
    service
      .from('subscriptions')
      .select('status, stripe_subscription_id, stripe_customer_id, current_period_start, current_period_end, cancel_at_period_end, created_at')
      .eq('user_id', user.id),
  ])

  if (!invite) {
    return NextResponse.json({ error: 'This account was not invited' }, { status: 403 })
  }
  if (invite.skip_payment === false) {
    return NextResponse.json({ error: 'This invite requires a card to start the trial' }, { status: 403 })
  }

  const access = classifyBillingAccess(rows as SubscriptionRow[] | null, { invitedByAdmin: true })
  if (access.allowed) {
    return NextResponse.json({ ok: true, already: true })
  }

  const { error } = await service.from('subscriptions').insert({
    user_id: user.id,
    stripe_subscription_id: `granted_invite_${Date.now()}`,
    stripe_customer_id: null,
    status: 'active',
    current_period_start: new Date().toISOString(),
    current_period_end: null,
    cancel_at_period_end: false,
  })
  if (error) {
    console.error('[invite-access] insert failed:', error.message)
    return NextResponse.json({ error: 'Failed to activate access' }, { status: 500 })
  }

  await assignSubscriberPlan(service, user.id)

  // An invite consumed by an existing account has no signup trigger to stamp
  // it — record the use here so the admin page shows who came in.
  if (!invite.used_by) {
    await service
      .from('signup_invite')
      .update({ used_at: new Date().toISOString(), used_by: user.id, updated_at: new Date().toISOString() })
      .eq('id', invite.id)
  }

  await service.from('analytics_events').insert({
    user_id: user.id,
    device_id: 'web',
    event: 'subscription_granted',
    properties: { granted_by: 'signup_invite', invite_id: invite.id },
    created_at: new Date().toISOString(),
  })

  return NextResponse.json({ ok: true })
}
