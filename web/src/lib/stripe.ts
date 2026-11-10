import Stripe from 'stripe'
import { APP_PAGE_ORIGINS, appUrl } from '@/lib/app-url'

/**
 * Stripe client singletons.
 *
 * Most of the app uses the default client (`STRIPE_SECRET_KEY`).
 * Admin tooling that manages production purchases/subscriptions from a
 * dev environment needs the production client (`PROD_STRIPE_SECRET_KEY`)
 * so actions hit the real Stripe account.
 *
 * Both are cached so we don't instantiate a new client per request.
 */

type Env = 'development' | 'production'

let defaultClient: Stripe | null = null
let prodClient: Stripe | null = null

export function getStripe(): Stripe {
  if (!defaultClient) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set')
    }
    defaultClient = new Stripe(key)
  }
  return defaultClient
}

/**
 * Returns the Stripe client for the given environment, or null when the
 * relevant key isn't configured. Admin routes use this so they can surface
 * a user-friendly 500 instead of crashing.
 */
export function getStripeForEnv(env: Env): Stripe | null {
  if (env === 'production') {
    if (!prodClient) {
      const key = process.env.PROD_STRIPE_SECRET_KEY
      if (!key) return null
      prodClient = new Stripe(key)
    }
    return prodClient
  }
  // Development / non-prod — use the default client if configured.
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return getStripe()
}

/**
 * Test-only: reset the cached clients so unit tests can swap env vars.
 * Not exported from the public barrel — intentionally available for
 * tests that import from '@/lib/stripe' directly.
 */
export function __resetStripeClientsForTest() {
  defaultClient = null
  prodClient = null
}

/**
 * Resolve a safe base URL for Stripe Checkout success/cancel redirects (P2-6).
 *
 * The client-supplied `Origin` header must NOT be trusted verbatim — a proxied
 * request could redirect the user to an attacker's site after payment. We only
 * honor an allowlisted origin; otherwise fall back to the canonical site URL.
 */
const ALLOWED_CHECKOUT_ORIGINS = new Set(
  [
    ...APP_PAGE_ORIGINS,
    appUrl(),
    process.env.NEXT_PUBLIC_SITE_URL,
    // Local development.
    process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : undefined,
  ].filter(Boolean) as string[],
)

export function safeCheckoutOrigin(requestOrigin: string | null): string {
  if (requestOrigin && ALLOWED_CHECKOUT_ORIGINS.has(requestOrigin)) {
    return requestOrigin
  }
  return process.env.NEXT_PUBLIC_SITE_URL || appUrl()
}
