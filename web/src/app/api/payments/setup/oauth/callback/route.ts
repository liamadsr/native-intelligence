import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, paymentsOrigin, PAYMENTS_PATHS } from '@/lib/payments/config'
import { completeOAuth, STRIPE_OAUTH_COOKIE } from '@/lib/payments/onboarding'
import { syncConnectedAccount } from '@/lib/payments/accounts'
import { notifyIfReady } from '@/lib/payments/setup'
import { bindingCookieOptions, readCookie } from '@/lib/oauth/state'
import { setupReturnQuery } from '@/lib/payments/return-token'

/**
 * Stripe OAuth came back (roadmap C1: an owner linking a Stripe account they
 * already run). Completes only in the browser that tapped the setup link
 * (the state's binding cookie), stores the account, reads it back from
 * Stripe and texts the owner when it can take payments.
 */
export async function GET(request: Request) {
  const origin = paymentsOrigin()
  const url = new URL(request.url)
  const cookieName = STRIPE_OAUTH_COOKIE()
  const finish = (query: Record<string, string> | string) => {
    const response = NextResponse.redirect(`${origin}${PAYMENTS_PATHS.done}?${typeof query === 'string' ? query : new URLSearchParams(query)}`, 303)
    response.cookies.set(cookieName, '', bindingCookieOptions(0))
    return response
  }
  const availability = connectAvailability()
  if (!availability.ok) return finish({ e: 'payments_off' })

  const supabase = getServiceClient()
  const stripe = getStripe()
  const result = await completeOAuth(supabase, stripe, {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
    cookieNonce: readCookie(request.headers.get('cookie'), cookieName),
    livemode: availability.livemode,
  })
  if (!result.ok) {
    if (result.reason === 'stripe_failed' || result.reason === 'store_failed') console.error('[payments] oauth failed:', result.reason, result.error)
    return finish({ e: result.reason })
  }
  try {
    const synced = await syncConnectedAccount(supabase, result.stripeAccountId, { retrieve: (id) => stripe.accounts.retrieve(id) })
    if (synced) await notifyIfReady(supabase, synced)
  } catch (err) {
    // The webhook's account.updated reads it again.
    console.error('[payments] oauth sync failed:', err instanceof Error ? err.message : String(err))
  }
  return finish(setupReturnQuery(result.workspaceId))
}
