/**
 * Connecting the owner's Stripe (roadmap C1), from the texted setup link
 * (./setup-link.ts) the owner taps on their phone. The link's page offers two
 * buttons, each a same-origin POST that uses the link once:
 *
 *   new       Dial8 makes (or reuses, while unfinished) the workspace's
 *             Accounts v2 account: the full Stripe Dashboard, Stripe-owned
 *             fees and losses (`fees_collector` / `losses_collector`
 *             'stripe'), the merchant configuration with card payments. Then
 *             a v2 Account Link sends the owner to Stripe-hosted onboarding,
 *             which returns to /payments/setup/done (finished or left) or,
 *             when the Stripe link has expired, to the refresh route, which
 *             texts a fresh setup link rather than minting one for whoever
 *             holds the URL.
 *   existing  Stripe OAuth (read_write) for an account they already run.
 *             The state is HMAC-signed with a key of its own (never valid at
 *             the integrations' OAuth callback) and bound to an httpOnly
 *             cookie set on the same response, so the callback completes only
 *             in the browser that tapped the link.
 *
 * Server only.
 */
import crypto from 'node:crypto'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bindingCookieName, oauthStateSecret, secretsEqual } from '@/lib/oauth/state'
import { connectOAuthClientId, PAYMENTS_PATHS } from './config'
import { getConnectedAccount, isStripeAccountId, upsertConnectedAccount } from './accounts'
import { setupReturnQuery } from './return-token'

/** The OAuth binding cookie. */
export const STRIPE_OAUTH_COOKIE = () => bindingCookieName('stripe_connect_nonce')
/** How long the OAuth round trip may take. */
export const STRIPE_OAUTH_TTL_MS = 10 * 60_000

export type StartResult =
  | { ok: true; redirectUrl: string; cookie?: { name: string; value: string; maxAgeSeconds: number } }
  | { ok: false; reason: 'already_connected' | 'oauth_off' | 'stripe_failed' | 'store_failed'; error?: string }

interface StartArgs {
  workspaceId: string
  userId: string
  origin: string
  /** The setup link's id: the account creation's idempotency key. */
  linkId: string
}

/** Where Stripe sends the owner back, signed (./return-token.ts): the page and the route are public. */
function returnUrl(origin: string, workspaceId: string): string {
  return `${origin}${PAYMENTS_PATHS.done}?${setupReturnQuery(workspaceId)}`
}

function refreshUrl(origin: string, workspaceId: string): string {
  return `${origin}${PAYMENTS_PATHS.refresh}?${setupReturnQuery(workspaceId)}`
}

/** Who the account is for, for Stripe's prefill: the owner's email and the business's name. */
async function prefill(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<{ email: string | null; name: string | null }> {
  const [{ data: workspace }, user] = await Promise.all([
    supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle(),
    supabase.auth.admin.getUserById(userId).catch(() => null),
  ])
  const name = ((workspace as { name?: string | null } | null)?.name ?? '').trim().slice(0, 100) || null
  const email = user?.data?.user?.email ?? null
  return { email, name }
}

/**
 * Button 1: a new Stripe account, onboarded on Stripe. Reuses the workspace's
 * unfinished created account (so a second tap continues, never duplicates).
 */
export async function startNewAccount(supabase: SupabaseClient, stripe: Stripe, args: StartArgs & { livemode: boolean }): Promise<StartResult> {
  const existing = await getConnectedAccount(supabase, args.workspaceId)
  if (existing && existing.status === 'ready') return { ok: false, reason: 'already_connected' }

  let accountId = existing && existing.linkedVia === 'created' && existing.status !== 'disconnected' ? existing.stripeAccountId : null
  if (!accountId) {
    const who = await prefill(supabase, args.workspaceId, args.userId)
    try {
      const account = await stripe.v2.core.accounts.create(
        {
          ...(who.email ? { contact_email: who.email } : {}),
          ...(who.name ? { display_name: who.name } : {}),
          dashboard: 'full',
          identity: { country: 'us' },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          defaults: { currency: 'usd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
          metadata: { dial8_workspace_id: args.workspaceId },
        },
        { idempotencyKey: `dial8-connect-account-${args.linkId}` },
      )
      accountId = account.id
    } catch (err) {
      return { ok: false, reason: 'stripe_failed', error: err instanceof Error ? err.message : String(err) }
    }
    if (!isStripeAccountId(accountId)) return { ok: false, reason: 'stripe_failed', error: 'unexpected account id' }
    const stored = await upsertConnectedAccount(supabase, {
      workspaceId: args.workspaceId,
      stripeAccountId: accountId,
      linkedVia: 'created',
      livemode: args.livemode,
      connectedBy: args.userId,
    })
    if (!stored.ok) return { ok: false, reason: 'store_failed', error: stored.error }
  }

  try {
    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: refreshUrl(args.origin, args.workspaceId),
          return_url: returnUrl(args.origin, args.workspaceId),
          collection_options: { fields: 'currently_due' },
        },
      },
    })
    return { ok: true, redirectUrl: link.url }
  } catch (err) {
    return { ok: false, reason: 'stripe_failed', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Stripe OAuth (an existing account) ────────────────────────────────────

function stateKey(): string {
  return crypto.createHmac('sha256', oauthStateSecret()).update('dial8-stripe-connect-state-v1').digest('base64url')
}

interface StripeState {
  workspaceId: string
  userId: string
  nonce: string
  exp: number
}

/** Sign a state. Exported for the tests. */
export function signStripeState(state: StripeState): string {
  const body = Buffer.from(JSON.stringify({ w: state.workspaceId, u: state.userId, n: state.nonce, e: state.exp })).toString('base64url')
  const sig = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

/** Verify a state's signature, expiry and binding cookie. */
export function verifyStripeState(param: unknown, cookieNonce: string | null, now = Date.now()): { ok: true; state: StripeState } | { ok: false; error: string } {
  if (typeof param !== 'string' || param.length > 1000) return { ok: false, error: 'invalid_state' }
  const dot = param.lastIndexOf('.')
  if (dot <= 0) return { ok: false, error: 'invalid_state' }
  const body = param.slice(0, dot)
  let expected: string
  try {
    expected = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  } catch {
    return { ok: false, error: 'server_misconfigured' }
  }
  if (!secretsEqual(param.slice(dot + 1), expected)) return { ok: false, error: 'invalid_state' }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return { ok: false, error: 'invalid_state' }
  }
  const state = { workspaceId: raw.w, userId: raw.u, nonce: raw.n, exp: raw.e }
  if (typeof state.workspaceId !== 'string' || typeof state.userId !== 'string' || typeof state.nonce !== 'string' || typeof state.exp !== 'number') {
    return { ok: false, error: 'invalid_state' }
  }
  if (now > state.exp) return { ok: false, error: 'state_expired' }
  // Only the browser that tapped the link holds the cookie: an attacker can't
  // send someone else their own consent link to link the wrong account.
  if (!secretsEqual(cookieNonce, state.nonce)) return { ok: false, error: 'not_bound' }
  return { ok: true, state: state as StripeState }
}

/** Button 2: link an account they already have, by Stripe OAuth. */
export function startExistingAccount(stripe: Stripe, args: StartArgs & { ownerEmail?: string | null; businessName?: string | null }, now = Date.now()): StartResult {
  const clientId = connectOAuthClientId()
  if (!clientId) return { ok: false, reason: 'oauth_off' }
  const nonce = crypto.randomBytes(24).toString('base64url')
  const state = signStripeState({ workspaceId: args.workspaceId, userId: args.userId, nonce, exp: now + STRIPE_OAUTH_TTL_MS })
  const redirectUrl = stripe.oauth.authorizeUrl({
    client_id: clientId,
    response_type: 'code',
    scope: 'read_write',
    state,
    redirect_uri: `${args.origin}${PAYMENTS_PATHS.oauthCallback}`,
    ...(args.ownerEmail || args.businessName
      ? { stripe_user: { ...(args.ownerEmail ? { email: args.ownerEmail } : {}), ...(args.businessName ? { business_name: args.businessName } : {}) } }
      : {}),
  })
  return { ok: true, redirectUrl, cookie: { name: STRIPE_OAUTH_COOKIE(), value: nonce, maxAgeSeconds: Math.floor(STRIPE_OAUTH_TTL_MS / 1000) } }
}

export type CompleteOAuthResult =
  | { ok: true; workspaceId: string; stripeAccountId: string }
  | { ok: false; reason: 'bad_state' | 'denied' | 'already_linked' | 'stripe_failed' | 'store_failed'; error?: string }

/** The OAuth callback: exchange the code and store the linked account. */
export async function completeOAuth(
  supabase: SupabaseClient,
  stripe: Stripe,
  args: { code: string | null; state: string | null; error: string | null; cookieNonce: string | null; livemode: boolean },
): Promise<CompleteOAuthResult> {
  const verified = verifyStripeState(args.state, args.cookieNonce)
  if (!verified.ok) return { ok: false, reason: 'bad_state', error: verified.error }
  if (args.error || !args.code) return { ok: false, reason: 'denied', error: args.error ?? 'no code' }
  const { workspaceId, userId } = verified.state

  let stripeAccountId: string | undefined
  try {
    const token = await stripe.oauth.token({ grant_type: 'authorization_code', code: args.code })
    stripeAccountId = token.stripe_user_id
  } catch (err) {
    return { ok: false, reason: 'stripe_failed', error: err instanceof Error ? err.message : String(err) }
  }
  if (!isStripeAccountId(stripeAccountId)) return { ok: false, reason: 'stripe_failed', error: 'no account id' }

  const stored = await upsertConnectedAccount(supabase, { workspaceId, stripeAccountId, linkedVia: 'oauth', livemode: args.livemode, connectedBy: userId })
  if (!stored.ok) {
    // The unique live-account key: this Stripe account already takes another workspace's payments.
    const taken = /duplicate key|stripe_connect_account_live_account_key/i.test(stored.error)
    return { ok: false, reason: taken ? 'already_linked' : 'store_failed', error: stored.error }
  }
  return { ok: true, workspaceId, stripeAccountId }
}
