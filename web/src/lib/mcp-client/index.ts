/**
 * MCP client for talking to external MCP servers (Atlassian, Linear, custom).
 *
 * The Native Intelligence backend acts as the MCP *client* here. Each call opens a fresh
 * transport, performs one operation (list/call), and closes — there is no
 * long-lived per-server session. This matches our stateless live-agent model
 * and avoids holding sockets across the cold-start boundary in serverless.
 *
 * If you need to issue multiple calls back-to-back, use `withClient()` and
 * batch them inside the callback so the connection is reused.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import { decryptCredential } from '@/lib/crypto/credentials'
import { ensureSafeMcpUrl } from './url-guard'
import { ensurePublicMcpUrl } from './url-guard-dns'
import { ensureFreshAccessToken, isStoredMcpServer } from './token-refresh'
import { isMcpToolHidden } from './tool-access'
import { GITHUB_INTEGRATION_SERVER_ID } from './github-server'
import type {
  ConnectedMcpServerRow,
  McpCallToolResult,
  McpToolDescriptor,
} from './types'
import type { McpToolAnnotations } from './approval-policy'

export { McpTokenExpiredError, McpTokenRefreshUnavailableError } from './token-refresh'

const CLIENT_INFO = {
  name: 'dial8',
  version: '1.0.0',
}

/** The transports' fetch: every request, GETs included, refuses to follow a redirect. */
export const noRedirectFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  fetch(input, { ...init, redirect: 'error' })

function buildTransport(server: ConnectedMcpServerRow) {
  // Re-validate at connect-time. The server_url was validated at insert
  // time, but a row could be edited or restored from a backup, and we
  // never want to silently dial something internal.
  const url = ensureSafeMcpUrl(server.server_url)
  const headers: Record<string, string> = {}
  // A server Native Intelligence builds (github-integration.ts) pins its own headers; never Authorization.
  for (const [name, value] of Object.entries(server.extra_headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') headers[name] = value
  }

  if (server.auth_type === 'bearer' || server.auth_type === 'oauth2') {
    if (!server.access_token_encrypted) {
      throw new Error(
        `MCP server "${server.display_name}" has auth_type=${server.auth_type} but no access token`,
      )
    }
    const token = decryptCredential(server.access_token_encrypted)
    headers.Authorization = `Bearer ${token}`
  }

  // redirect 'error': a 3xx never takes the dial past the SSRF guard to
  // another host. requestInit covers the POSTs; the SDK's GETs (the
  // streamable-HTTP standalone stream opened after initialize, the SSE
  // EventSource) ignore it and use the transport's `fetch`, so that is
  // pinned too.
  const opts = { requestInit: { headers, redirect: 'error' as const }, fetch: noRedirectFetch }
  if (server.transport === 'sse') return new SSEClientTransport(url, opts)
  return new StreamableHTTPClientTransport(url, opts)
}

/** Options for a call that must give up on time (the live agent's lookups). */
export interface McpCallOptions {
  /**
   * Aborting it stops the call: it is checked before and after the token
   * refresh, stops the wait for a refresh (the refresh itself finishes and is
   * saved: token-refresh.ts, as an aborted token request may already have
   * rotated the token), rides the handshake and the request (the SDK rejects
   * the pending request), and closes the client, which closes the transport.
   */
  signal?: AbortSignal
}

/**
 * The server refused the request's credentials: the transports' own HTTP 401
 * (StreamableHTTPError, SseError), sent before it runs anything. Never a
 * JSON-RPC error that happens to carry 401 (McpError): that is the tool's
 * answer, after it ran.
 */
export function isMcpAuthRefusal(err: unknown): boolean {
  return (err instanceof StreamableHTTPError || err instanceof SseError) && err.code === 401
}

/**
 * Open a connection, run `fn` with the connected client, then close. All
 * teardown happens in `finally` so a thrown callback still releases the
 * underlying transport. With a `signal`, an abort closes the client at once
 * (whatever it is waiting on) and the finally still runs.
 *
 * A stored OAuth server that refuses its token (an HTTP 401: revoked, or
 * expired early) gets one forced refresh and one retry (GEN-1171): a 401
 * means nothing ran, so the retry never runs a call twice. A refresh the
 * token endpoint refuses for good marks it (token-refresh.ts); the server
 * refusing the new token too is this call's error only, never a mark (as for
 * integrations, only the token endpoint's verdict marks a sign-in).
 */
export async function withClient<T>(
  server: ConnectedMcpServerRow,
  fn: (client: Client) => Promise<T>,
  opts: McpCallOptions = {},
): Promise<T> {
  const { signal } = opts
  signal?.throwIfAborted()
  // The whole SSRF guard, DNS included, before any dial: the adapter, the
  // live agent, the apply engine, refresh-tools and the OAuth callback all
  // come through here (a host found public is trusted for 60 s).
  await ensurePublicMcpUrl(server.server_url)
  signal?.throwIfAborted()
  const fresh = await ensureFreshAccessToken(server, { signal })
  signal?.throwIfAborted()
  try {
    return await connectAndRun(fresh, fn, signal)
  } catch (err) {
    if (!isMcpAuthRefusal(err) || fresh.auth_type !== 'oauth2' || !isStoredMcpServer(fresh) || signal?.aborted) throw err
    const renewed = await ensureFreshAccessToken(fresh, { signal, force: true })
    signal?.throwIfAborted()
    try {
      return await connectAndRun(renewed, fn, signal)
    } catch (again) {
      if (!isMcpAuthRefusal(again)) throw again
      const refused = new Error(`MCP server "${renewed.display_name}" refused its sign-in even after it was renewed. If it keeps happening, reconnect it.`)
      ;(refused as { cause?: unknown }).cause = again
      throw refused
    }
  }
}

async function connectAndRun<T>(server: ConnectedMcpServerRow, fn: (client: Client) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const transport = buildTransport(server)
  const client = new Client(CLIENT_INFO)
  const closeOnAbort = () => {
    client.close().catch(() => {})
  }
  signal?.addEventListener('abort', closeOnAbort, { once: true })
  try {
    if (signal) await client.connect(transport, { signal })
    else await client.connect(transport)
    return await fn(client)
  } finally {
    signal?.removeEventListener('abort', closeOnAbort)
    try {
      await client.close()
    } catch {
      // Best-effort close — surface the original error from `fn` instead.
    }
  }
}

/** A tool's annotations, reduced to the known boolean hints and a short title; undefined when there are none. */
export function toolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const out: McpToolAnnotations = {}
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean
  }
  if (typeof source.title === 'string' && source.title.trim()) out.title = source.title.trim().slice(0, 200)
  return Object.keys(out).length ? out : undefined
}

/** Discover the tools an external server exposes via tools/list. */
export async function listTools(
  server: ConnectedMcpServerRow,
  opts: McpCallOptions = {},
): Promise<McpToolDescriptor[]> {
  return withClient(server, async (client) => {
    const result = await client.listTools()
    return result.tools.map((t) => {
      // Kept for the approval policy (approval-policy.ts): readOnlyHint lets a
      // read run without a card. Only the boolean hints and the title. Always
      // present ({} when the server sent none): a cache whose tools carry no
      // `annotations` key at all predates this and is re-listed once
      // (adapter.ts refreshLegacyToolsCache).
      return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        annotations: toolAnnotations(t.annotations) ?? {},
      }
    })
  }, opts)
}

/** Invoke a single tool on the external server. */
export async function callTool(
  server: ConnectedMcpServerRow,
  toolName: string,
  args: Record<string, unknown>,
  opts: McpCallOptions = {},
): Promise<McpCallToolResult> {
  return withClient(
    server,
    async (client) => {
      const params = { name: toolName, arguments: args }
      const result = opts.signal
        ? await client.callTool(params, undefined, { signal: opts.signal })
        : await client.callTool(params)
      return {
        content: result.content,
        isError: Boolean(result.isError),
      }
    },
    opts,
  )
}

/**
 * Load a single connected MCP server row by id and call a tool on it.
 * Intended for the apply-engine path where we have a server_id stashed
 * inside a proposed_change row but no in-memory server reference.
 *
 * `expectedUserId` is REQUIRED — without it, a future caller passing a
 * service-role client could resolve any user's server by UUID, which is
 * a cross-user IDOR. The check happens inside this helper so callers
 * can't forget it. Pass the user_id of the principal applying the
 * proposed change.
 */
export async function callToolByServerId(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  expectedUserId: string,
): Promise<McpCallToolResult> {
  // The GitHub integration's server is never stored: built from the caller's
  // own integration (github-integration.ts; loaded here, so the loader's import
  // of this module stays one-way at load time).
  if (serverId === GITHUB_INTEGRATION_SERVER_ID) {
    const { loadGitHubIntegrationServer } = await import('./github-integration')
    const github = await loadGitHubIntegrationServer(supabase, expectedUserId)
    if (!github) throw new Error('GitHub is not connected, or its sign-in needs reconnecting')
    if (isMcpToolHidden(github, toolName)) throw new Error(`"${toolName}" is not one of GitHub's read tools`)
    return callTool(github, toolName, args)
  }
  const { data, error } = await supabase
    .from('connected_mcp_server')
    .select('*')
    .eq('id', serverId)
    .maybeSingle<ConnectedMcpServerRow>()

  if (error) throw new Error(`MCP server lookup failed: ${error.message}`)
  if (!data) throw new Error('MCP server not found or revoked')
  if (data.user_id !== expectedUserId) {
    // Defence in depth: should be unreachable under RLS, but cheap to
    // check and would catch a service-role-client refactor that elides
    // the workspace/user gate.
    throw new Error('MCP server does not belong to the requesting user')
  }
  if (!data.is_enabled) throw new Error(`MCP server "${data.display_name}" is disabled`)

  if (isMcpToolHidden(data, toolName)) {
    throw new Error(`Tool "${toolName}" is disabled for ${data.display_name}`)
  }

  return callTool(data, toolName, args)
}

export type { ConnectedMcpServerRow, McpToolDescriptor, McpCallToolResult } from './types'
