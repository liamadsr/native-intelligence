import { getServiceClient } from '@/lib/admin'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, PAYMENTS_PATHS } from '@/lib/payments/config'
import { getConnectedAccount, syncConnectedAccount, type ConnectStatus } from '@/lib/payments/accounts'
import { notifyIfReady } from '@/lib/payments/setup'
import { setupReturnQuery, verifySetupReturn } from '@/lib/payments/return-token'
import { SetupDoneView } from './setup-done-view'

export const metadata = {
  title: 'Stripe setup',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Why setup stopped, in the owner's words (the routes' `e`). */
const ERRORS: Record<string, string> = {
  expired: 'That setup link had expired. Text your Dial8 agent “connect Stripe” for a fresh one.',
  used: 'That setup link was already used. Text your Dial8 agent “connect Stripe” for a fresh one.',
  invalid: 'That link doesn’t work. Text your Dial8 agent “connect Stripe” for a fresh one.',
  not_admin: 'Only a workspace owner or admin can connect Stripe.',
  already_connected: 'Stripe is already connected for this business.',
  already_linked: 'That Stripe account already takes payments for another Dial8 business. Use another account, or set up a new one.',
  oauth_off: 'Linking an existing Stripe account isn’t available yet. Set up a new one from a fresh link instead.',
  denied: 'Stripe wasn’t connected: the connection was cancelled on Stripe’s page.',
  bad_state: 'Stripe wasn’t connected: finish it in the same browser you started in, from a fresh link.',
  payments_off: 'Card payments aren’t switched on for Dial8 yet.',
  stripe_failed: 'Stripe couldn’t finish this just now. Try again from a fresh link.',
  store_failed: 'Something went wrong on our side. Try again from a fresh link.',
  server: 'Something went wrong on our side. Try again from a fresh link.',
}

/** What a texted link meant (the refresh route's `t`). */
const TEXTED: Record<string, string> = {
  sent: 'Stripe’s page timed out, so we texted you a fresh link. Tap it to pick up where you left off.',
  too_soon: 'We texted you a fresh link a moment ago. Tap it to pick up where you left off.',
  daily_cap: 'We’ve sent several setup links today. Text your Dial8 agent “connect Stripe” tomorrow, or contact support.',
  no_phone: 'Stripe’s page timed out, and we couldn’t text you a fresh link: no phone is verified on your account.',
}

/**
 * Where Stripe sends the owner back (roadmap C1): hosted onboarding finished
 * or left, OAuth done, or a refresh. The status is read from Stripe here,
 * never trusted from the redirect; the "payments are on" text goes out once,
 * from whichever of this page and the webhooks reads it ready first. Only
 * with the URL's signed `s` (src/lib/payments/return-token.ts): a bare
 * workspace id reads nothing and shows nothing about it.
 */
export default async function StripeSetupDonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : '')
  const workspaceId = one('w')
  const error = ERRORS[one('e')] ?? null
  const texted = UUID.test(workspaceId) && verifySetupReturn(workspaceId, one('s')) ? (TEXTED[one('t')] ?? null) : null
  const signed = UUID.test(workspaceId) && verifySetupReturn(workspaceId, one('s'))

  let status: ConnectStatus | null = null
  let needsDetails = false
  if (!error && signed && connectAvailability().ok) {
    const supabase = getServiceClient()
    const account = await getConnectedAccount(supabase, workspaceId)
    if (account) {
      status = account.status
      try {
        const stripe = getStripe()
        const synced = await syncConnectedAccount(supabase, account.stripeAccountId, { retrieve: (id) => stripe.accounts.retrieve(id) })
        if (synced) {
          status = synced.account.status
          needsDetails = synced.state.needsDetails
          await notifyIfReady(supabase, synced)
        }
      } catch (err) {
        console.error('[payments] setup return sync failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  const title = error
    ? 'Stripe isn’t connected yet'
    : status === 'ready'
      ? 'You’re all set'
      : texted
        ? 'Check your texts'
        : status === 'restricted'
          ? 'Stripe is reviewing your account'
          : 'Almost there'
  const body = error
    ? error
    : status === 'ready'
      ? 'Stripe is connected. Customers can pay you by card, straight into your Stripe account, and we’ve texted you to confirm.'
      : texted
        ? texted
        : status === 'restricted'
          ? 'Stripe has your details and is checking them. We’ll text you as soon as you can take payments.'
          : needsDetails
            ? 'Stripe still needs a few details before you can take payments. Get a fresh link below to finish.'
            : 'Stripe is finishing your setup. We’ll text you as soon as you can take payments.'

  const refreshHref = needsDetails && status !== 'ready' && !error && signed ? `${PAYMENTS_PATHS.refresh}?${setupReturnQuery(workspaceId)}` : null
  return <SetupDoneView title={title} body={body} status={status ?? (error ? 'error' : 'unknown')} refreshHref={refreshHref} />
}
