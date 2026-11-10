/**
 * The OAuth `state` param's secret and lifetime, shared by the authorize and
 * callback routes so the signing and verifying sides can never drift.
 *
 * ── Security review 2026-10-31 (P0-2) ──────────────────────────────────────
 * The state is HMAC-signed to stop tampering and, for the non-web surfaces
 * that can't carry a cookie across browsers, is the main CSRF signal. Before
 * this change the secret fell back to CRON_SECRET and then to the literal
 * 'dev-fallback' — a fail-OPEN default that in production would sign (and
 * accept) state anyone could forge. Now production REQUIRES a dedicated
 * OAUTH_STATE_SECRET (it throws if unset), and the literal fallback exists
 * only outside production for local dev.
 */

import crypto from 'crypto'

/** The state param's life — matches the oauth_nonce cookie's 10-minute maxAge. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/**
 * The desktop claim secret (P0-2). A desktop connect completes in the SYSTEM
 * browser, which carries none of the webview's cookies, so the callback can't
 * bind the completer to the initiator the way the web flow does. Instead the
 * authorize route hands the initiating window a random secret and signs only
 * its hash into the state; the callback deep-links the code back to the app
 * without exchanging it; and the claim route exchanges it only for a caller
 * who presents the secret AND is signed in as the state's user. An attacker
 * who sends a victim their consent link holds their own secret, but the code
 * lands on the victim's machine — so neither side can complete the link.
 */
export function newClaimSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** The hash of a claim secret, as signed into the state. */
export function claimHash(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('base64url')
}

/** Constant-time check that `secret` hashes to `expectedHash`. False on any shape mismatch. */
export function claimSecretMatches(secret: unknown, expectedHash: unknown): boolean {
  if (typeof secret !== 'string' || !secret || typeof expectedHash !== 'string' || !expectedHash) return false
  return constantTimeEqual(claimHash(secret), expectedHash)
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * A web OAuth flow's binding cookie (the integration flow's nonce, an MCP
 * connector flow's bind value): the cookie the browser that STARTED the flow
 * holds, and the only thing its callback accepts as proof of that.
 *
 * Production names it `__Host-<base>`: a browser accepts that prefix only
 * when the cookie is Secure, `Path=/` and has no Domain, so no `*.nativeintelligence.dev`
 * subdomain (a takeover, an XSS on a docs or marketing host) can plant one for
 * nativeintelligence.dev. A planted copy of an attacker's own flow cookie (they can read it
 * in their own browser) was the remaining way to link a victim's account to
 * theirs (security review 2026-10-31). The callbacks therefore no longer
 * accept a matching session instead: a subdomain could toss its owner's
 * session cookie too. Dev keeps the plain name (localhost is plain http).
 */
export function bindingCookieName(base: string): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${base}` : base
}

/** The integration flow's web binding cookie (the authorize route's nonce). */
export const OAUTH_NONCE_COOKIE = () => bindingCookieName('oauth_nonce')

/** The options every binding cookie is set with (and cleared with: the same name and path). */
export function bindingCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax: sent on the provider's top-level redirect back to the callback.
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
    // `__Host-` requires the root path.
    path: '/',
  }
}

/** The value of cookie `name` in a Cookie header, or null. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

/** Constant-time equality of a presented value and the expected one; false on any type or length mismatch. */
export function secretsEqual(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !presented) return false
  return constantTimeEqual(presented, expected)
}

/** How long after its state's `exp` a desktop claim may still finish. */
export const CLAIM_GRACE_MS = 5 * 60 * 1000

/**
 * The provider's code for a desktop connect, sealed for its trip back through
 * the `dial8desktop://` deep link (AES-256-GCM). The key is derived from the
 * state secret and the flow's own nonce, so only this server can open it, and
 * only for that flow's state. Why: the deep link leaves the server's hands (any
 * app can claim the scheme, older desktop builds logged deep-link URLs). A raw
 * code there could be redeemed by whoever reads it at the WEB callback with
 * their own state, linking the person's account to theirs (provider codes
 * aren't bound to our state). Sealed, it is useless anywhere but the claim
 * route, which also demands the claim secret and the person's session.
 */
export function sealDesktopCode(code: string, nonce: string): string {
  const iv = u8(crypto.randomBytes(IV_BYTES))
  const cipher = crypto.createCipheriv('aes-256-gcm', desktopCodeKey(nonce), iv)
  const body = [u8(cipher.update(code, 'utf8')), u8(cipher.final())]
  return Buffer.concat([iv, u8(cipher.getAuthTag()), ...body]).toString('base64url')
}

/** The code inside a {@link sealDesktopCode} value for this nonce; null if it isn't one. */
export function openDesktopCode(sealed: unknown, nonce: string): string | null {
  if (typeof sealed !== 'string' || !sealed) return null
  try {
    const raw = u8(Buffer.from(sealed, 'base64url'))
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', desktopCodeKey(nonce), raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const code = Buffer.concat([u8(decipher.update(raw.subarray(IV_BYTES + TAG_BYTES))), u8(decipher.final())]).toString('utf8')
    return code || null
  } catch {
    return null
  }
}

const IV_BYTES = 12
const TAG_BYTES = 16

/** A plain Uint8Array copy — node:crypto's typings refuse a Buffer (as in chat-run-credential.ts). */
function u8(b: Buffer | ArrayBuffer): Uint8Array {
  return new Uint8Array(b)
}

function desktopCodeKey(nonce: string): Uint8Array {
  return u8(crypto.createHmac('sha256', oauthStateSecret()).update(`dial8-desktop-oauth-code-v1:${nonce}`).digest())
}

/** The fields of a verified state the callback and the claim route read. */
export interface OAuthStateData {
  nonce: string | null
  userId: string | null
  /** As signed; callers check it with isValidCapability. */
  capability: string | null
  source: 'web' | 'desktop'
  workspaceId: string | null
  returnTo: string | null
  /** The desktop claim secret's hash (desktop states only). */
  claim: string | null
  /** 'text' for a connect started from a texted single-use link (src/lib/links/oauth-link.ts): web states only. */
  via: 'text' | null
  /** A texted link's capabilities still to connect after this one, in order. */
  then: string[]
  /** A texted link's capabilities already connected. */
  done: string[]
}

/**
 * Verify a `state` param's signature and expiry and read its fields. Returns
 * `{ ok: false, error }` for a bad signature ('invalid_state_signature'), an
 * expired state ('state_expired') or an unreadable one ('invalid_state').
 * `source` is 'desktop' only when the state says exactly that; anything else
 * is 'web' (the enforced binding).
 */
export function verifyOAuthState(
  stateParam: string | null,
  opts: { graceMs?: number } = {},
): { ok: true; data: OAuthStateData } | { ok: false; error: string } {
  if (!stateParam) return { ok: false, error: 'invalid_state' }
  const dotIdx = stateParam.lastIndexOf('.')
  if (dotIdx <= 0) return { ok: false, error: 'invalid_state_signature' }
  const stateB64 = stateParam.slice(0, dotIdx)
  const providedSig = stateParam.slice(dotIdx + 1)
  let secret: string
  try {
    secret = oauthStateSecret()
  } catch {
    return { ok: false, error: 'server_misconfigured' }
  }
  const expectedSig = crypto.createHmac('sha256', secret).update(stateB64).digest('base64url')
  if (!constantTimeEqual(providedSig, expectedSig)) {
    return { ok: false, error: 'invalid_state_signature' }
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(stateB64, 'base64url').toString())
  } catch {
    return { ok: false, error: 'invalid_state' }
  }
  // Every state the authorize route signs carries `exp`; one without it was
  // signed before the field existed and is past any sane life by now.
  // `graceMs` lets the claim, which follows a callback that passed, finish.
  if (typeof raw.exp !== 'number' || Date.now() > raw.exp + (opts.graceMs ?? 0)) {
    return { ok: false, error: 'state_expired' }
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 8) : [])
  const source = raw.source === 'desktop' ? 'desktop' : 'web'
  const via = raw.via === 'text' && source === 'web' ? 'text' : null
  return {
    ok: true,
    data: {
      nonce: str(raw.nonce),
      userId: str(raw.user_id),
      capability: str(raw.capability),
      source,
      workspaceId: str(raw.workspace_id),
      returnTo: str(raw.return_to),
      claim: str(raw.claim),
      via,
      then: via ? strs(raw.then) : [],
      done: via ? strs(raw.done) : [],
    },
  }
}

/**
 * The HMAC key for the OAuth state param: a dedicated OAUTH_STATE_SECRET when
 * set; otherwise a key DERIVED from CRON_SECRET for this one purpose (so a tag
 * made with CRON_SECRET anywhere else is never a valid state signature).
 * Production never falls back further: with neither set it throws (the routes
 * refuse the connect) rather than sign with a guessable key. Outside production
 * a fixed dev string remains so local dev needs no setup.
 *
 * As of 2026-10-31 OAUTH_STATE_SECRET is set for Preview only; production signs
 * with the CRON_SECRET-derived key. Setting a dedicated production value is
 * still recommended (it separates this key from the cron bearer entirely).
 */
export function oauthStateSecret(): string {
  const dedicated = process.env.OAUTH_STATE_SECRET
  if (dedicated) return dedicated
  const cron = process.env.CRON_SECRET
  if (cron) return crypto.createHmac('sha256', cron).update('dial8-oauth-state-key-v1').digest('base64url')
  if (process.env.NODE_ENV === 'production') {
    throw new Error('OAUTH_STATE_SECRET (or CRON_SECRET) is required in production')
  }
  return 'dev-fallback'
}
