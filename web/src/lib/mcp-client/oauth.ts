/**
 * MCP OAuth 2.1 client helpers — Dial8 acting as the *client* against an
 * external MCP server that advertises an OAuth-protected resource.
 *
 * Flow per the MCP authorization spec (which composes RFC 9728 + 8414 + 7591
 * + 7636):
 *
 *   1. probeProtectedResource(server_url)
 *      → if the server responds 401 with WWW-Authenticate, parse the
 *        resource_metadata URL. Otherwise fall back to constructing the
 *        well-known URL at the same origin.
 *   2. fetchProtectedResourceMetadata(url)
 *      → returns { authorization_servers: [...] }
 *   3. fetchAuthorizationServerMetadata(issuer)
 *      → returns { authorization_endpoint, token_endpoint, registration_endpoint, ... }
 *   4. registerClient(registration_endpoint, redirect_uri)
 *      → POST RFC 7591; returns { client_id, client_secret? }
 *   5. buildAuthorizationUrl(...) — caller persists state + verifier
 *   6. exchangeCodeForTokens(token_endpoint, code, verifier, client_id)
 *      → returns access_token + refresh_token + expires_in
 *
 * We deliberately don't hold any state inside this module — every function
 * is a one-shot fetch. State lives in the external_mcp_oauth_state table.
 */

import { createHash, randomBytes } from 'node:crypto'
import { TokenRefreshError } from '@/lib/oauth/token-manager'
import { ensureSafeMcpUrl } from './url-guard'
import { ensurePublicMcpUrl } from './url-guard-dns'

export interface ProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  response_types_supported?: string[]
  grant_types_supported?: string[]
  code_challenge_methods_supported?: string[]
}

export interface RegisteredClient {
  client_id: string
  client_secret?: string
  registration_access_token?: string
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

const USER_AGENT = 'dial8-mcp-client/1.0'

/** Discovery's options: a signal that really aborts its requests (connect's time bound). */
export interface DiscoveryOptions {
  signal?: AbortSignal
}

/** The most of a discovery response read: metadata is a few KB, never megabytes. */
export const DISCOVERY_BODY_MAX_BYTES = 1_000_000

/**
 * A JSON body, read only up to DISCOVERY_BODY_MAX_BYTES: a server streaming a
 * huge or endless body is cut off (and the read cancelled), never buffered.
 */
export async function readJsonCapped(res: Response, max = DISCOVERY_BODY_MAX_BYTES): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) throw new Error('Metadata response too large')
  if (!res.body) return JSON.parse(await res.text())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new Error('Metadata response too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * Send a probing request to the MCP server. If it returns 401 with a
 * `WWW-Authenticate: Bearer resource_metadata="..."` header, return that
 * URL. Otherwise return null so the caller falls back to the well-known
 * path on the same origin.
 */
export async function probeProtectedResourceMetadataUrl(
  serverUrl: string,
  opts: DiscoveryOptions = {},
): Promise<string | null> {
  try {
    // Name, literal and DNS checks before every fetch (url-guard-dns.ts).
    await ensurePublicMcpUrl(serverUrl)
    const res = await fetch(serverUrl, {
      redirect: 'error',
      ...(opts.signal ? { signal: opts.signal } : {}),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': USER_AGENT,
      },
      // An MCP initialize request — the smallest payload that should hit
      // the auth gate. We don't care about the response body either way.
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dial8-probe', version: '1.0' },
        },
      }),
    })

    if (res.status !== 401) return null
    const wwwAuth = res.headers.get('www-authenticate') || ''
    const match = wwwAuth.match(/resource_metadata="?([^",]+)"?/i)
    const raw = match?.[1] ?? null
    if (!raw) return null
    // The metadata URL is server-supplied — an HTTPS server could still
    // serve a 401 pointing at internal infrastructure. Validate before
    // returning to the caller.
    try {
      ensureSafeMcpUrl(raw)
      return raw
    } catch {
      return null
    }
  } catch {
    return null
  }
}

export async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  opts: DiscoveryOptions = {},
): Promise<ProtectedResourceMetadata> {
  // Server-supplied (a 401's resource_metadata): name, literal and DNS checks.
  await ensurePublicMcpUrl(metadataUrl)
  const res = await fetch(metadataUrl, {
      redirect: 'error',
      ...(opts.signal ? { signal: opts.signal } : {}),
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  })
  if (!res.ok) {
    throw new Error(
      `Protected resource metadata fetch failed (${res.status}) at ${metadataUrl}`,
    )
  }
  return (await readJsonCapped(res)) as ProtectedResourceMetadata
}

export async function fetchAuthorizationServerMetadata(
  issuer: string,
  opts: DiscoveryOptions = {},
): Promise<AuthorizationServerMetadata> {
  // Per RFC 8414, the well-known path is appended after a slash. Some
  // implementations also expose OIDC discovery at /.well-known/openid-configuration
  // — try the OAuth one first, then OIDC as fallback.
  const candidates = [
    new URL('/.well-known/oauth-authorization-server', issuer).toString(),
    new URL('/.well-known/openid-configuration', issuer).toString(),
  ]
  let lastError: unknown
  for (const url of candidates) {
    try {
      // The issuer is server-supplied: name, literal and DNS checks.
      await ensurePublicMcpUrl(url)
      const res = await fetch(url, {
      redirect: 'error',
      ...(opts.signal ? { signal: opts.signal } : {}),
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
      if (res.ok) {
        return (await readJsonCapped(res)) as AuthorizationServerMetadata
      }
      lastError = new Error(`${url} → ${res.status}`)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `Could not fetch authorization-server metadata from ${issuer}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  options: { client_name?: string; scopes?: string[] } = {},
): Promise<RegisteredClient> {
  await ensurePublicMcpUrl(registrationEndpoint)
  const res = await fetch(registrationEndpoint, {
      redirect: 'error',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_name: options.client_name ?? 'Dial8',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: options.scopes?.join(' '),
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dynamic client registration failed at ${registrationEndpoint} (${res.status}): ${body.slice(0, 300)}`,
    )
  }
  const json = await res.json()
  if (!json.client_id) {
    throw new Error('Registration response missing client_id')
  }
  return json as RegisteredClient
}

// ─── PKCE ─────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function generateStateString(): string {
  return base64url(randomBytes(32))
}

// ─── Authorize URL + token exchange ───────────────────────────

export function buildAuthorizationUrl(input: {
  authorization_endpoint: string
  client_id: string
  redirect_uri: string
  scopes: string[]
  state: string
  code_challenge: string
}): string {
  const url = new URL(input.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.client_id)
  url.searchParams.set('redirect_uri', input.redirect_uri)
  if (input.scopes.length > 0) {
    url.searchParams.set('scope', input.scopes.join(' '))
  }
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.code_challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export async function refreshAccessToken(input: {
  token_endpoint: string
  client_id: string
  client_secret?: string
  refresh_token: string
  /** Aborts the token request (a lookup's deadline), so no refresh lands after the caller gave up. */
  signal?: AbortSignal
}): Promise<TokenResponse> {
  await ensurePublicMcpUrl(input.token_endpoint)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refresh_token,
    client_id: input.client_id,
  })
  if (input.client_secret) body.set('client_secret', input.client_secret)

  const res = await fetch(input.token_endpoint, {
      redirect: 'error',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!res.ok) {
    // The OAuth `error` code decides whether the sign-in is gone for good
    // (token-manager.ts isDefinitiveRefreshFailure), so it rides the error.
    let oauthError: string | null = null
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error) oauthError = body.error.slice(0, 60)
    } catch {
      // Non-JSON (or unreadable) body: the status is the useful part.
    }
    throw new TokenRefreshError('MCP token', res.status, oauthError)
  }
  const json = await res.json()
  if (!json.access_token) {
    throw new Error('Refresh response missing access_token')
  }
  return json as TokenResponse
}

export async function exchangeCodeForTokens(input: {
  token_endpoint: string
  client_id: string
  client_secret?: string
  code: string
  code_verifier: string
  redirect_uri: string
}): Promise<TokenResponse> {
  await ensurePublicMcpUrl(input.token_endpoint)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirect_uri,
    client_id: input.client_id,
    code_verifier: input.code_verifier,
  })
  if (input.client_secret) body.set('client_secret', input.client_secret)

  const res = await fetch(input.token_endpoint, {
      redirect: 'error',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Token exchange failed (${res.status}): ${text.slice(0, 300)}`,
    )
  }
  const json = await res.json()
  if (!json.access_token) {
    throw new Error('Token response missing access_token')
  }
  return json as TokenResponse
}

/**
 * One-call helper: starting from a server_url, return everything the backend
 * needs to perform DCR + redirect. Throws with a useful message if any step
 * fails — caller surfaces that to the user verbatim.
 */
export async function discoverOAuthForServer(serverUrl: string, opts: DiscoveryOptions = {}): Promise<{
  authorizationServer: AuthorizationServerMetadata
  scopes: string[]
}> {
  const origin = new URL(serverUrl).origin

  // Try the protected-resource probe first; otherwise hit the well-known
  // path at the same origin as the MCP endpoint.
  let metadataUrl = await probeProtectedResourceMetadataUrl(serverUrl, opts)
  if (!metadataUrl) {
    metadataUrl = new URL('/.well-known/oauth-protected-resource', origin).toString()
  }

  let resourceMeta: ProtectedResourceMetadata
  try {
    resourceMeta = await fetchProtectedResourceMetadata(metadataUrl, opts)
  } catch {
    // Some servers (especially older / non-spec-compliant) skip the
    // protected-resource layer and host their auth server at the same
    // origin. Fall through to that.
    resourceMeta = { authorization_servers: [origin] }
  }

  const issuer = resourceMeta.authorization_servers?.[0] ?? origin
  const authServer = await fetchAuthorizationServerMetadata(issuer, opts)
  const scopes = resourceMeta.scopes_supported ?? authServer.scopes_supported ?? []
  return { authorizationServer: authServer, scopes }
}
