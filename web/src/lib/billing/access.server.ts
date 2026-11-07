// Server-only: pulls in the service client + Resend via lib/admin. Never
// import from a client component — use ./access for constants and types.
import type { SupabaseClient } from '@supabase/supabase-js'
import { findSignupInviteForUser } from '@/lib/admin/signup-invites'
import type { SubscriptionRow } from '@/app/api/billing/status/pick-subscription'
import { classifyBillingAccess, isDial8Staff, type BillingAccess, type ChatGptPlanStatus } from './access'

/**
 * Load and classify. Uses the caller's client for `subscriptions` (RLS lets a
 * user read their own rows) and a service client for `signup_invite`, which
 * has no policies at all — pass one only when the admin-invite question
 * matters (the start-trial page); the layout gate can skip it.
 */
export async function getBillingAccess(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
  serviceClient?: SupabaseClient,
): Promise<BillingAccess> {
  if (isDial8Staff(user.email)) {
    return classifyBillingAccess(null, { invitedByAdmin: false, email: user.email })
  }
  const userId = user.id
  const [{ data: rows }, invited, chatgptPlan] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('status, stripe_subscription_id, stripe_customer_id, current_period_start, current_period_end, cancel_at_period_end, created_at')
      .eq('user_id', userId),
    serviceClient
      ? findSignupInviteForUser(serviceClient, user).then((row) => !!row && row.skip_payment !== false)
      : Promise.resolve(false),
    chatgptPlanStatus(supabase),
  ])
  return classifyBillingAccess(rows as SubscriptionRow[] | null, {
    invitedByAdmin: invited,
    email: user.email,
    chatgptPlan,
  })
}

/** The caller's ChatGPT plan status (migration 409's chatgpt_plan_status(),
 *  callable with the user's own client). Any failure reads as no plan: the
 *  trial wall then shows, never a free pass. */
async function chatgptPlanStatus(supabase: SupabaseClient): Promise<ChatGptPlanStatus> {
  try {
    const { data, error } = await supabase.rpc('chatgpt_plan_status')
    if (error) return null
    return data === 'active' || data === 'exhausted' || data === 'revoked' ? data : null
  } catch {
    return null
  }
}
