import type { SupabaseClient } from '@supabase/supabase-js'
import { isMetadataClientId, resolveClientMetadata, type ClientMetadata, type FetchDocument } from './client-metadata'
import { UNSAFE_REDIRECT_SCHEMES } from './redirect-uri'

/**
 * An MCP OAuth client as the authorize, approve and deny steps read it: a
 * registered one (mcp_oauth_client), or one whose client_id is an https URL
 * naming its metadata document (client-metadata.ts), fetched and checked
 * fresh, which approve saves as a row before it mints a code.
 */
export interface McpOAuthClient {
  client_id: string
  redirect_uris: string[]
  client_name: string | null
  /** Set for a client named by its metadata document. */
  metadata?: ClientMetadata
}

/**
 * `redirectUri` is the registered URI to send the browser to: always one the
 * client registered (a portless loopback one on the port asked for), never
 * the raw param.
 */
export type McpClientCheck =
  | { ok: true; client: McpOAuthClient; redirectUri: string }
  | { ok: false; error: 'invalid_request' | 'invalid_client' | 'invalid_redirect_uri'; description: string }

/**
 * What Next.js rewrites to `localhost` in a route handler's `request.url`: it
 * builds the URL from a normalised NextURL, which replaces the first
 * `127.x.x.x`, `[::1]` or `localhost` anywhere in it, query included
 * (REGEX_LOCALHOST_HOSTNAME in next/dist/server/web/next-url.js, mirrored
 * here). A client that registered http://127.0.0.1:53682/callback reaches
 * /authorize asking for http://localhost:53682/callback.
 */
const NEXT_LOCALHOST = /127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}|\[::1\]|localhost/

/** `uri` as a route handler reads it once Next.js has rewritten its loopback host. */
function asRouteHandlerReads(uri: string): string {
  return uri.replace(NEXT_LOCALHOST, 'localhost')
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * A registered loopback callback with no port, as `redirectUri` names it on
 * the port the app picked: RFC 8252 §7.3, a server MUST allow any port on a
 * loopback redirect, since a native app takes a free port at sign-in. Claude
 * Code's metadata document lists `http://localhost/callback` this way. The
 * scheme, host (or Next.js's localhost rewrite of it), path and query must
 * still be the registered ones; a URI that names a port matches only exactly.
 */
function onAnyLoopbackPort(registered: string, redirectUri: string): string | null {
  let reg: URL
  let req: URL
  try {
    reg = new URL(registered)
    req = new URL(redirectUri)
  } catch {
    return null
  }
  if (reg.protocol !== 'http:' || reg.port !== '' || !LOOPBACK_HOSTS.includes(reg.hostname)) return null
  if (req.protocol !== 'http:' || req.port === '' || req.hash || req.username || req.password) return null
  if (req.pathname !== reg.pathname || req.search !== reg.search) return null
  const withPort = new URL(registered)
  withPort.port = req.port
  const named = withPort.toString()
  return named === redirectUri || asRouteHandlerReads(named) === redirectUri ? named : null
}

/** The registered URI `redirectUri` names: itself, the one Next.js rewrote into it, or a portless loopback one on its port. */
function registeredRedirectUri(registered: string[], redirectUri: string): string | null {
  if (registered.includes(redirectUri)) return redirectUri
  const rewritten = registered.find((uri) => asRouteHandlerReads(uri) === redirectUri)
  if (rewritten) return rewritten
  for (const uri of registered) {
    const named = onAnyLoopbackPort(uri, redirectUri)
    if (named) return named
  }
  return null
}

/**
 * Do two redirect URIs name the same callback: equal, or equal once Next.js's
 * loopback rewrite is applied to both? /authorize can't tell
 * http://localhost:P/cb from http://127.0.0.1:P/cb, so a client that
 * registered both and asked for the second gets a code bound to the first.
 */
export function sameRedirectUri(a: string, b: string): boolean {
  return a === b || asRouteHandlerReads(a) === asRouteHandlerReads(b)
}

/**
 * The registered client a request names, when `redirectUri` is one of the
 * URIs it registered. Nothing may send a browser to a `redirect_uri` before
 * this says yes (RFC 6749 §4.1.2.1): a URI no client registered is anyone's,
 * and `/api/mcp/…` is a path a sign-in may resume (src/lib/auth/login-redirect.ts),
 * so an unchecked one is an open redirect.
 */
export async function checkMcpClient(
  service: SupabaseClient,
  clientId: string | null,
  redirectUri: string | null,
  /** The signed-in person (a metadata-document client is only fetched for one), and a test seam for the fetch. */
  opts: { requester?: string; fetchDocument?: FetchDocument } = {},
): Promise<McpClientCheck> {
  if (!clientId || !redirectUri) {
    return { ok: false, error: 'invalid_request', description: 'Missing required parameters: client_id, redirect_uri' }
  }
  let client: McpOAuthClient
  if (isMetadataClientId(clientId)) {
    if (!opts.requester) return { ok: false, error: 'invalid_client', description: 'Sign in to Dial8 first' }
    // Never a stored row: the document as it is now (or as cached under its
    // own Cache-Control), so a redirect URI it dropped is refused at once.
    const resolved = await resolveClientMetadata(clientId, {
      fetchDocument: opts.fetchDocument ?? (await import('./client-metadata-fetch')).fetchMetadataDocument,
      requester: opts.requester,
    })
    if (!resolved.ok) return { ok: false, error: 'invalid_client', description: resolved.reason }
    const { metadata } = resolved
    client = { client_id: metadata.client_id, redirect_uris: metadata.redirect_uris, client_name: metadata.client_name, metadata }
  } else {
    const { data } = await service
      .from('mcp_oauth_client')
      .select('client_id, redirect_uris, client_name')
      .eq('client_id', clientId)
      .single()
    if (!data) return { ok: false, error: 'invalid_client', description: 'Unknown client_id' }
    client = data as McpOAuthClient
  }
  const registered = Array.isArray(client.redirect_uris) ? registeredRedirectUri(client.redirect_uris, redirectUri) : null
  if (!registered) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uri does not match registered URIs' }
  }
  // Never a script/data scheme, even one registered before /register refused them.
  let protocol: string
  try {
    protocol = new URL(registered).protocol
  } catch {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uri is not a valid URL' }
  }
  if (UNSAFE_REDIRECT_SCHEMES.has(protocol)) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uri uses a scheme that is not allowed' }
  }
  return { ok: true, client, redirectUri: registered }
}

/**
 * Save a metadata-document client as a mcp_oauth_client row, refreshed to
 * the document just checked: the auth code and token rows point at it
 * (foreign keys), and Connected apps reads its name. Only approve calls this,
 * once the person has said yes: an unanswered sign-in writes nothing.
 */
export async function saveMetadataClient(service: SupabaseClient, metadata: ClientMetadata): Promise<boolean> {
  const { error } = await service.from('mcp_oauth_client').upsert(
    {
      client_id: metadata.client_id,
      redirect_uris: metadata.redirect_uris,
      client_name: metadata.client_name,
      grant_types: metadata.grant_types,
      token_endpoint_auth_method: 'none',
    },
    { onConflict: 'client_id' },
  )
  if (error) console.error('[mcp-cimd] failed to save metadata client', { clientId: metadata.client_id, error: error.message })
  return !error
}

/** A validated client redirect URI carrying an OAuth error (and the request's state), or null when it isn't a URL. */
export function oauthErrorUrl(redirectUri: string, error: string, description: string, state: string | null): string | null {
  try {
    const url = new URL(redirectUri)
    url.searchParams.set('error', error)
    url.searchParams.set('error_description', description)
    if (state) url.searchParams.set('state', state)
    return url.toString()
  } catch {
    return null
  }
}
