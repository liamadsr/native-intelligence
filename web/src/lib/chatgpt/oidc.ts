/**
 * The OpenAI side of "Continue with ChatGPT": the one-time sign-in
 * transaction, the authorize URL, the code exchange, ID-token verification,
 * refresh and revocation. Follows OpenAI's website guide
 * (developers.openai.com/siwc/website) plus the plan-usage additions
 * (`resource` everywhere, the plan scope). See ./config.ts for the clients.
 *
 * The transaction (state, nonce, PKCE verifier, where to go after) is sealed
 * with the credentials key and rides in an HttpOnly cookie scoped to
 * /auth/chatgpt, so nothing secret reaches browser JavaScript and no table is
 * needed. It lives 10 minutes and the callback clears it. A replayed cookie
 * is useless without a fresh authorization code, which OpenAI issues once.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'
import {
  AGENT_NAME,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_REVOKE_URL,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
  DYNAMIC_CLIENT_ID,
  type ChatGptClient,
} from './config'

export const TRANSACTION_COOKIE = 'chatgpt_auth_tx'
export const TRANSACTION_TTL_SECONDS = 10 * 60

export interface SignInTransaction {
  state: string
  nonce: string
  verifier: string
  /** The client the authorize request named (DYNAMIC_CLIENT_ID when registering). */
  clientId: string
  redirectUri: string
  /** Finish on a dial8desktop:// deep link instead of a web session. */
  desktop: boolean
  /** Desktop only: the webview's one-time value, echoed into the deep link so
   *  it redeems only a sign-in it started (src/lib/auth/desktop-sign-in.ts). */
  bind: string | null
  /** Epoch ms after which the transaction is refused. */
  expiresAt: number
}

/** The desktop's `bind`: 24 random bytes, hex. */
export const BIND_PATTERN = /^[0-9a-f]{48}$/

export function createTransaction(
  client: ChatGptClient,
  { desktop, bind, redirectUri }: { desktop: boolean; bind: string | null; redirectUri: string },
  now = Date.now(),
): SignInTransaction {
  return {
    state: randomValue(32),
    nonce: randomValue(32),
    verifier: randomValue(64),
    clientId: client.clientId,
    redirectUri,
    desktop,
    bind: desktop ? bind : null,
    expiresAt: now + TRANSACTION_TTL_SECONDS * 1000,
  }
}

export function sealTransaction(tx: SignInTransaction): string {
  return encryptCredential(JSON.stringify(tx))
}

/** The transaction a cookie carries, or null if it's missing, forged or expired. */
export function openTransaction(sealed: string | undefined, now = Date.now()): SignInTransaction | null {
  if (!sealed) return null
  try {
    const tx = JSON.parse(decryptCredential(sealed)) as SignInTransaction
    if (typeof tx.state !== 'string' || typeof tx.verifier !== 'string') return null
    return tx.expiresAt > now ? tx : null
  } catch {
    return null
  }
}

/** Constant-time state check (an attacker controls the returned value). */
export function stateMatches(tx: SignInTransaction, returned: string | null): boolean {
  if (!returned) return false
  const a = new TextEncoder().encode(tx.state)
  const b = new TextEncoder().encode(returned)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function authorizeUrl(client: ChatGptClient, tx: SignInTransaction): string {
  const params = new URLSearchParams({
    client_id: tx.clientId,
    redirect_uri: tx.redirectUri,
    response_type: 'code',
    scope: CHATGPT_SCOPES,
    resource: CHATGPT_PLAN_RESOURCE,
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: pkceChallenge(tx.verifier),
    code_challenge_method: 'S256',
  })
  if (client.hostId) {
    // Self-serve client: the host is named on every request; the app name
    // only when registering.
    params.set('ext_agent_host_id', client.hostId)
    if (tx.clientId === DYNAMIC_CLIENT_ID) params.set('agent_name_hint', AGENT_NAME)
  }
  return `${CHATGPT_AUTHORIZE_URL}?${params}`
}

/**
 * The client to exchange the code with. A self-serve registration returns the
 * issued id on the callback; a returning sign-in must come back on the client
 * it asked for (a different one is refused rather than adopted).
 */
export function exchangeClientId(tx: SignInTransaction, returnedClientId: string | null): string | null {
  if (tx.clientId === DYNAMIC_CLIENT_ID) {
    return returnedClientId && returnedClientId !== DYNAMIC_CLIENT_ID ? returnedClientId : null
  }
  if (returnedClientId && returnedClientId !== tx.clientId) return null
  return tx.clientId
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresIn: number
  scopes: string[]
}

export class ChatGptTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    super(`OpenAI token endpoint returned ${status}${code ? ` ${code}` : ''}`)
  }
}

export async function exchangeCode(
  client: ChatGptClient,
  clientId: string,
  code: string,
  tx: SignInTransaction,
): Promise<TokenSet> {
  return tokenRequest(client, clientId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: tx.redirectUri,
    client_id: clientId,
    code_verifier: tx.verifier,
    resource: CHATGPT_PLAN_RESOURCE,
  })
}

export async function refreshTokens(client: ChatGptClient, clientId: string, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(client, clientId, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: CHATGPT_PLAN_RESOURCE,
  })
}

/** Ends the renewable session at OpenAI. An empty 200 is success, also for an
 *  already-invalid token. Returns whether OpenAI confirmed it. */
export async function revokeRefreshToken(client: ChatGptClient, clientId: string, refreshToken: string): Promise<boolean> {
  const res = await fetch(CHATGPT_REVOKE_URL, {
    method: 'POST',
    headers: formHeaders(client, clientId),
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
  })
  return res.ok
}

async function tokenRequest(client: ChatGptClient, clientId: string, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: formHeaders(client, clientId),
    body: new URLSearchParams(form),
  })
  const requestId = res.headers.get('openai-request-id') ?? res.headers.get('x-request-id')
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new ChatGptTokenError(res.status, typeof body.error === 'string' ? body.error : null, requestId)
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  }
}

/** A confidential client authenticates with HTTP Basic only (OpenAI never
 *  falls back to public-client auth); a public client sends no secret. */
function formHeaders(client: ChatGptClient, clientId: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (client.clientSecret) {
    const enc = (v: string) => new URLSearchParams({ v }).toString().slice(2)
    headers.authorization = `Basic ${Buffer.from(`${enc(clientId)}:${enc(client.clientSecret)}`).toString('base64')}`
  }
  return headers
}

export interface ChatGptIdentity {
  sub: string
  email: string | null
  emailVerified: boolean
  name: string | null
}

export class IdTokenError extends Error {}

type Jwk = JsonWebKey & { kid?: string }
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null
const JWKS_MAX_AGE_MS = 60 * 60 * 1000

async function signingKey(kid: string | undefined): Promise<Jwk> {
  const fresh = !jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_MAX_AGE_MS
  let key = fresh ? undefined : jwksCache!.keys.find((k) => k.kid === kid)
  if (!key) {
    // Unknown kid or stale cache: refetch once (OpenAI rotates keys).
    const res = await fetch(CHATGPT_JWKS_URL)
    if (!res.ok) throw new IdTokenError(`JWKS fetch failed: ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() }
    key = jwksCache.keys.find((k) => k.kid === kid)
  }
  if (!key) throw new IdTokenError('ID token key is not in OpenAI JWKS')
  return key
}

/** Verify an OpenAI ID token: RS256 signature against the JWKS, then issuer,
 *  audience, expiry (5 s skew), issued-at, nonce and subject. */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
  now = Date.now(),
): Promise<ChatGptIdentity> {
  const [h, p, s] = idToken.split('.')
  if (!h || !p || !s) throw new IdTokenError('ID token is not a JWT')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string }
  if (header.alg !== 'RS256') throw new IdTokenError(`unexpected ID token alg ${header.alg}`)
  const key = await signingKey(header.kid)
  const signed = verify(
    'sha256',
    new TextEncoder().encode(`${h}.${p}`),
    createPublicKey({ key, format: 'jwk' }),
    new Uint8Array(Buffer.from(s, 'base64url')),
  )
  if (!signed) throw new IdTokenError('ID token signature is invalid')

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>
  const nowS = Math.floor(now / 1000)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== CHATGPT_ISSUER) throw new IdTokenError('ID token issuer mismatch')
  if (!aud.includes(clientId)) throw new IdTokenError('ID token audience mismatch')
  if (typeof claims.exp !== 'number' || claims.exp + 5 < nowS) throw new IdTokenError('ID token expired')
  if (typeof claims.iat !== 'number') throw new IdTokenError('ID token has no iat')
  if (claims.nonce !== nonce) throw new IdTokenError('ID token nonce mismatch')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('ID token has no subject')

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
  }
}

/** Test seam: forget cached signing keys. */
export function resetJwksCacheForTests(): void {
  jwksCache = null
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function randomValue(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}
