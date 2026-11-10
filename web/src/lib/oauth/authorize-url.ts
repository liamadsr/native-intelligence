/**
 * The first half of an OAuth integration connect: the signed `state` and the
 * provider's authorize URL. Shared by the two places a connect starts:
 *   - the authorize route (src/app/api/oauth/[provider]/authorize/route.ts),
 *     for a signed-in person in the app or the desktop;
 *   - a texted single-use link (src/lib/links/oauth-link.ts), for the person
 *     whose phone the link was sent to, with no session: its state says
 *     `via: 'text'`, so the callback finishes in the text thread.
 *
 * The caller has ALREADY established who `userId` is (the session, or the
 * link bound to that account). The binding of the completing browser is the
 * caller's too: a web start sets the returned `nonce` as the oauth_nonce
 * cookie, which the callback requires (lib/oauth/state.ts).
 *
 * Moved from the authorize route (roadmap track A2) unchanged.
 */
import crypto from 'crypto'
import { OAUTH_CONFIG, getRedirectUri, getScopesForCapability, isPkceProvider, type OAuthCapability, type OAuthProvider } from './config'
import { pkceChallenge, pkceVerifier } from './pkce'
import { OAUTH_STATE_TTL_MS, claimHash, newClaimSecret, oauthStateSecret } from './state'
import { APP_PAGE_ORIGINS } from '@/lib/app-url'

/**
 * How each provider wants its scope list joined in the authorize URL.
 *
 * RFC 6749 says space-separated, which is what every provider here accepted
 * until Linear: its authorize endpoint documents and expects a COMMA-separated
 * list ("read,write") and does not parse the spaced form. A per-provider lookup
 * rather than an inline ternary so the default stays the spec's — a new provider
 * is space-separated unless someone deliberately says otherwise.
 *
 * Only the REQUEST is affected. Linear's token response reports granted scopes
 * space-separated (and, for pre-2023 apps, sometimes as an array), which is one
 * more reason nothing in this stack round-trips the string.
 */
const SCOPE_DELIMITER: Partial<Record<OAuthProvider, string>> = {
  linear: ',',
}

/** A connect started from a texted link: what is left to connect after this leg, and what already connected. */
export interface TextConnectLegs {
  /** Capabilities still to connect, in order, after this one (Google: calendar after email). */
  then: OAuthCapability[]
  /** Capabilities this link already connected. */
  done: OAuthCapability[]
}

export interface OAuthStartArgs {
  provider: OAuthProvider
  capability: OAuthCapability
  userId: string
  workspaceId: string | null
  source: 'web' | 'desktop'
  returnTo?: string | null
  loginHint?: string | null
  /** Set for a connect started from a texted link (always a web source). */
  text?: TextConnectLegs | null
  /**
   * The origin of the page a web connect began on. Kept in the state only when
   * it is one of the hosted app's page origins, so the callback can finish
   * there, handing the answer over to it if need be (state.ts `origin`).
   */
  pageOrigin?: string | null
  now?: number
}

export interface OAuthStart {
  authUrl: string
  state: string
  /** The web flow's binding: set it as the oauth_nonce cookie. */
  nonce: string
  /** The desktop flow's claim secret (desktop only): only the initiating window gets it. */
  claimSecret: string | null
}

export function oauthClientId(provider: OAuthProvider): string | undefined {
  const clientIdByProvider: Record<OAuthProvider, string | undefined> = {
    google: process.env.GOOGLE_CLIENT_ID,
    microsoft: process.env.MICROSOFT_CLIENT_ID,
    github: process.env.GITHUB_CLIENT_ID,
    hubspot: process.env.HUBSPOT_CLIENT_ID,
    asana: process.env.ASANA_CLIENT_ID,
    jira: process.env.JIRA_CLIENT_ID,
    linear: process.env.LINEAR_CLIENT_ID,
    brevo: process.env.BREVO_CLIENT_ID,
  }
  return clientIdByProvider[provider]
}

/**
 * The origin a web connect is finished on and returns to: the page's, when it
 * is one of the hosted app's own page origins. The provider calls back the one
 * registered address (getRedirectUri), which can be on the app's other domain,
 * and the nonce cookie and the popup's opener are on the page's. Null for any
 * page that is not the hosted app's (local dev, a preview): those finish on
 * the app's address, as they always have.
 */
export function connectHomeOrigin(pageOrigin: string | null): string | null {
  return pageOrigin && APP_PAGE_ORIGINS.includes(pageOrigin) ? pageOrigin : null
}

/** The signed state and the provider's authorize URL for one connect. Throws when the state secret is missing in production. */
export function buildOAuthStart(args: OAuthStartArgs): OAuthStart {
  const { provider, capability, userId, workspaceId, source } = args
  const config = OAUTH_CONFIG[provider]
  const redirectUri = getRedirectUri(provider)
  const scopes = getScopesForCapability(provider, capability)

  // Encode user_id + capability + source + workspace in the state param so callback can associate tokens.
  const nonce = crypto.randomUUID()
  // `source` selects how the callback binds the completer to the initiator
  // (security review P0-2). 'web': the callback requires the single-use nonce
  // cookie. 'desktop': the callback never exchanges the code; it deep-links it
  // back, and only the initiating window, holding the claim secret below and
  // signed in as this user, can claim it (/api/oauth/[provider]/claim).
  const claimSecret = source === 'desktop' ? newClaimSecret() : null
  const returnTo = args.returnTo || null
  // `exp` bounds the state's life (10 min), matching the oauth_nonce cookie's
  // maxAge: the callback rejects an expired state, so a signed authUrl can't
  // be stockpiled and replayed later (security review P0-2).
  const exp = (args.now ?? Date.now()) + OAUTH_STATE_TTL_MS
  const text = source === 'web' ? (args.text ?? null) : null
  const origin = source === 'web' && !text ? connectHomeOrigin(args.pageOrigin ?? null) : null
  const statePayload = JSON.stringify({
    nonce,
    user_id: userId,
    capability,
    source,
    workspace_id: workspaceId,
    exp,
    ...(returnTo && { return_to: returnTo }),
    // Only the hash: the state travels through the provider and the system browser.
    ...(claimSecret && { claim: claimHash(claimSecret) }),
    // A texted link's connect: the callback confirms in the text thread and chains the next leg.
    ...(text && { via: 'text', then: text.then, done: text.done }),
    // The hosted page it began on: the callback finishes there, handing the answer over when the provider called back the app's other domain.
    ...(origin && { origin }),
  })
  const stateB64 = Buffer.from(statePayload).toString('base64url')
  // Sign the state to prevent tampering (CSRF for non-web sources that lack cookies)
  const sig = crypto.createHmac('sha256', oauthStateSecret()).update(stateB64).digest('base64url')
  const state = `${stateB64}.${sig}`

  const clientId = oauthClientId(provider)!
  const loginHint = args.loginHint ?? null

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(SCOPE_DELIMITER[provider] ?? ' '),
    state,
    ...(provider === 'google'
      ? {
          access_type: 'offline',
          prompt: 'consent', // Force consent to always get refresh token + account picker
        }
      : provider === 'microsoft'
        ? {
            // Azure accepts only ONE prompt value — a space-separated list is
            // rejected with AADSTS90023 (live-verified). So the value is
            // conditional: fresh connects get select_account (the picker,
            // required for add-a-second-mailbox; a first-time account has no
            // cached consent to dodge), while targeted reconnects (login_hint
            // present — the "Update access" banner) get consent, defeating
            // Azure's consent cache so scope widenings like Mail.Send
            // actually re-prompt. A same-account reconnect through the plain
            // Connect button self-heals: the stale grant is persisted, the
            // missing_scopes banner appears, and its reconnect carries
            // login_hint.
            prompt: loginHint ? 'consent' : 'select_account',
          }
        : provider === 'jira'
          ? {
              // Atlassian REQUIRES audience — the authorize call is rejected
              // without it, and it must be exactly this value (it selects the
              // api.atlassian.com gateway the tokens are minted for).
              audience: 'api.atlassian.com',
              // Force the access-grant screen every time. Without it a
              // returning user can skip consent and we silently inherit the
              // scope set granted on a PREVIOUS connect — which, on a
              // reconnect after we widen scopes, hands back a token missing
              // the new ones with no visible failure.
              prompt: 'consent',
            }
          : {}), // GitHub / HubSpot / Asana: no extra params needed
  })

  // login_hint pre-selects a specific account (reconnect flows, and a texted link's later legs)
  if (loginHint) {
    authParams.set('login_hint', loginHint)
  }

  // A public app (Brevo): the S256 challenge of a verifier derived from this flow's nonce (./pkce.ts).
  if (isPkceProvider(provider)) {
    authParams.set('code_challenge', pkceChallenge(pkceVerifier(nonce)))
    authParams.set('code_challenge_method', 'S256')
  }

  return { authUrl: `${config.authUrl}?${authParams}`, state, nonce, claimSecret }
}
