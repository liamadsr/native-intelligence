/**
 * Payments through the owner's own Stripe (roadmap track C, migration 459):
 * Stripe Connect, with Native Intelligence's Stripe account as the platform. This file is
 * the env and the one switch; nothing here talks to Stripe.
 *
 * Native Intelligence's own billing (src/lib/billing/*, the stripe-webhook edge function)
 * shares the Stripe account and its secret key (getStripe), and nothing else:
 * Connect has its own webhook endpoints, secrets and tables.
 *
 * Live mode is off until Native Intelligence's Connect platform profile is approved
 * (docs/plans/stripe-connect-payments.md "Before going live"): with a live
 * secret key, Connect refuses unless STRIPE_CONNECT_LIVE is '1'. A test key
 * always works. So deploying this to production moves no real money.
 */

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

/** The platform key's mode, read from its prefix. Null: no key. */
export function platformKeyMode(): 'test' | 'live' | null {
  const key = env('STRIPE_SECRET_KEY')
  if (!key) return null
  return /^(sk|rk)_live_/.test(key) ? 'live' : 'test'
}

export type ConnectAvailability = { ok: true; livemode: boolean } | { ok: false; reason: 'no_key' | 'live_not_enabled' }

/** Whether Connect may run: a test key, or a live key with STRIPE_CONNECT_LIVE=1. */
export function connectAvailability(): ConnectAvailability {
  const mode = platformKeyMode()
  if (!mode) return { ok: false, reason: 'no_key' }
  if (mode === 'live' && env('STRIPE_CONNECT_LIVE') !== '1') return { ok: false, reason: 'live_not_enabled' }
  return { ok: true, livemode: mode === 'live' }
}

/** The platform's OAuth client id (ca_…), for linking an existing Stripe account. Null: linking is off. */
export function connectOAuthClientId(): string | null {
  const id = env('STRIPE_CONNECT_CLIENT_ID')
  return id && /^ca_[A-Za-z0-9]+$/.test(id) ? id : null
}

/** The signing secret of the snapshot-event endpoint (events on connected accounts). */
export function connectWebhookSecret(): string | null {
  return env('STRIPE_CONNECT_WEBHOOK_SECRET')
}

/** The signing secret of the thin-event destination (v2 account events). */
export function connectV2WebhookSecret(): string | null {
  return env('STRIPE_CONNECT_V2_WEBHOOK_SECRET')
}

/** The app's public origin, for links in texts and Stripe's redirect URLs. */
export function paymentsOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://dial8.ai').replace(/\/$/, '')
}

/** The paths Stripe and the texts send people to. */
export const PAYMENTS_PATHS = {
  /** The texted onboarding link's page (GET peeks, its buttons POST). */
  setup: (token: string) => `/payments/setup/${token}`,
  setupAction: (token: string) => `/api/payments/setup/${token}`,
  /** Stripe-hosted onboarding came back (finished or left). */
  done: '/payments/setup/done',
  /** Stripe's Account Link expired or was used: text a fresh link. */
  refresh: '/api/payments/setup/refresh',
  /** Stripe OAuth (an existing account) came back. */
  oauthCallback: '/api/payments/setup/oauth/callback',
  /** A customer finished paying. */
  paid: '/payments/paid',
} as const
