/**
 * "Sign in with Google" on dial8.ai. Native Intelligence runs Google's OAuth flow itself,
 * so the browser goes dial8.ai → accounts.google.com → dial8.ai and never
 * visits <project>.supabase.co. Supabase's own flow calls back to its project
 * URL, which Google's account chooser then shows the person ("to continue to
 * bzfthjzyzevjokbuhqci.supabase.co"); the custom-domain add-on that would
 * change that is paid, and Liam declined it (11-02).
 *
 * The callback (src/app/auth/google/callback/route.ts) hands Google's ID token
 * to Supabase (`signInWithIdToken`), which verifies it and signs in, links or
 * creates the account exactly as its Google provider does, the work-email
 * hook (migration 241) included.
 *
 * The client must be the one Supabase's Google provider is configured with:
 * Supabase refuses an ID token issued to any other audience.
 *   GOOGLE_SIGN_IN_CLIENT_ID       that client's id
 *   GOOGLE_SIGN_IN_CLIENT_SECRET   its secret
 *   GOOGLE_SIGN_IN_REDIRECT_URI    optional; else `<origin>/auth/google/callback`.
 *                                  Either must be an authorized redirect URI
 *                                  of the client in Google Cloud Console.
 * Unset → the login pages run Supabase's flow, as before.
 *
 * The transaction (state, nonce, PKCE verifier, how to finish) is sealed with
 * the credentials key in an HttpOnly cookie scoped to /auth/google, as for
 * ChatGPT (src/lib/chatgpt/oidc.ts): nothing secret reaches browser
 * JavaScript and no table is needed. It lives 10 minutes and the callback
 * clears it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { adminEmailDomain } from '@/lib/admin-emails'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_SCOPES = 'openid email profile'

export const GOOGLE_TRANSACTION_COOKIE = 'google_auth_tx'
export const GOOGLE_TRANSACTION_PATH = '/auth/google'
export const GOOGLE_TRANSACTION_TTL_SECONDS = 10 * 60

export interface GoogleSignInClient {
  clientId: string
  clientSecret: string
}

/** The configured client, or null when Google sign-in runs on Supabase's flow. */
export function googleSignInClient(): GoogleSignInClient | null {
  const clientId = env('GOOGLE_SIGN_IN_CLIENT_ID')
  const clientSecret = env('GOOGLE_SIGN_IN_CLIENT_SECRET')
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Does "Sign in with Google" run on dial8.ai? */
export function isGoogleSignInEnabled(): boolean {
  return googleSignInClient() !== null
}

/** The exact registered callback: GOOGLE_SIGN_IN_REDIRECT_URI, else
 *  `<origin>/auth/google/callback`. */
export function googleRedirectUri(origin: string): string {
  return env('GOOGLE_SIGN_IN_REDIRECT_URI') ?? `${origin}/auth/google/callback`
}

/** Where a sign-in finishes: a web session, the desktop's dial8desktop://
 *  deep link, or the admin panel. */
export type GoogleSignInMode = 'web' | 'desktop' | 'admin'

export interface GoogleSignInTransaction {
  state: string
  /** The raw nonce. Google gets its SHA-256 (hex), which is what Supabase
   *  compares the raw value against. */
  nonce: string
  verifier: string
  redirectUri: string
  mode: GoogleSignInMode
  /** Desktop only: the webview's one-time value, echoed into the deep link so
   *  it redeems only a sign-in it started (src/lib/auth/desktop-sign-in.ts). */
  bind: string | null
  /** Epoch ms after which the transaction is refused. */
  expiresAt: number
}

export function createGoogleTransaction(
  { mode, bind, redirectUri }: { mode: GoogleSignInMode; bind: string | null; redirectUri: string },
  now = Date.now(),
): GoogleSignInTransaction {
  return {
    state: randomValue(32),
    nonce: randomValue(32),
    verifier: randomValue(64),
    redirectUri,
    mode,
    bind: mode === 'desktop' ? bind : null,
    expiresAt: now + GOOGLE_TRANSACTION_TTL_SECONDS * 1000,
  }
}

export function sealGoogleTransaction(tx: GoogleSignInTransaction): string {
  return encryptCredential(JSON.stringify(tx))
}

/** The transaction a cookie carries, or null if it's missing, forged or expired. */
export function openGoogleTransaction(sealed: string | undefined, now = Date.now()): GoogleSignInTransaction | null {
  if (!sealed) return null
  try {
    const tx = JSON.parse(decryptCredential(sealed)) as GoogleSignInTransaction
    if (typeof tx.state !== 'string' || typeof tx.verifier !== 'string' || typeof tx.nonce !== 'string') return null
    if (tx.mode !== 'web' && tx.mode !== 'desktop' && tx.mode !== 'admin') return null
    return tx.expiresAt > now ? tx : null
  } catch {
    return null
  }
}

/** Constant-time state check (an attacker controls the returned value). */
export function googleStateMatches(tx: GoogleSignInTransaction, returned: string | null): boolean {
  if (!returned) return false
  const a = new TextEncoder().encode(tx.state)
  const b = new TextEncoder().encode(returned)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** What Google is sent as `nonce`: SHA-256 of the raw nonce, lowercase hex
 *  (Supabase's signInWithIdToken hashes the raw nonce the same way). */
export function hashedNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex')
}

export function googleAuthorizeUrl(client: GoogleSignInClient, tx: GoogleSignInTransaction): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: tx.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state: tx.state,
    nonce: hashedNonce(tx.nonce),
    code_challenge: createHash('sha256').update(tx.verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  // Admin sign-in asks Google for an account on the admins' domain when they
  // share one (a hint only; the callback's ADMIN_EMAILS check is the gate).
  const adminDomain = tx.mode === 'admin' ? adminEmailDomain() : null
  if (adminDomain) params.set('hd', adminDomain)
  return `${GOOGLE_AUTHORIZE_URL}?${params}`
}

export interface GoogleTokens {
  idToken: string
  /** Supabase checks the ID token's `at_hash` against it. */
  accessToken: string
}

export class GoogleTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Google token endpoint returned ${status}${code ? ` ${code}` : ''}`)
  }
}

/** Exchange the authorization code (with the PKCE verifier) for Google's tokens. */
export async function exchangeGoogleCode(
  client: GoogleSignInClient,
  code: string,
  tx: GoogleSignInTransaction,
): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: tx.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: tx.verifier,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof body.id_token !== 'string' || typeof body.access_token !== 'string') {
    throw new GoogleTokenError(res.status, typeof body.error === 'string' ? body.error : null)
  }
  return { idToken: body.id_token, accessToken: body.access_token }
}

function randomValue(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}
