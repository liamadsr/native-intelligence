import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getBillingAccess } from '@/lib/billing/access.server'
import { trialConversionDateLabel } from '@/lib/billing/access'
import { AuthSessionPinger } from '@/components/analytics/auth-session-pinger'
import { StartTrialView } from './start-trial-view'

export const metadata = {
  title: 'Start your trial – Dial8',
  robots: { index: false, follow: false },
}

/**
 * The trial wall. Every account without a trialing/active seat lands here
 * (from the dashboard layout and the onboarding page) and cannot go further
 * until Stripe holds a card — or, for people invited from the admin console,
 * until they choose to continue without one.
 */
export default async function StartTrialPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { session_id: sessionId } = await searchParams
  const access = await getBillingAccess(supabase, user, getServiceClient())

  // Already in: nothing to do here. (After Checkout the client confirms the
  // session first, then navigates, so a fresh trial also ends up on this path.)
  if (access.allowed && !sessionId) redirect('/account')

  // A new signup lands HERE first, before onboarding or the dashboard, so the
  // auth-session tracker has to fire here too — seconds after the account is
  // created rather than after Checkout. Two things depend on that timing:
  //   • persona-edition attribution, whose cookie and freshness gates are all
  //     one hour (lib/editions/attribution.ts): a signup that took longer
  //     than that over its card would otherwise land on `full`;
  //   • the signup-vs-login event, which only calls a session a signup inside
  //     60s of account creation (lib/posthog.ts).
  // Later surfaces re-ping harmlessly: the route dedups the event by cookie,
  // and the edition stamp is first-write-wins.
  return (
    <>
      <AuthSessionPinger />
      <StartTrialView
        access={{
          state: access.state,
          allowed: access.allowed,
          hasUsedTrial: access.hasUsedTrial,
          canSkipPayment: access.canSkipPayment,
          hasStripe: access.hasStripe,
        }}
        sessionId={sessionId ?? null}
        email={user.email ?? ''}
        chargeDate={trialConversionDateLabel()}
      />
    </>
  )
}
