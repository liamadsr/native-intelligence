/**
 * What `connect` resolves its input to (flows-connectors F2 §2.1): an
 * integration from the catalog, a catalog app, or a server from a URL the
 * person gave (decision 23), as the Connect card it puts in the chat.
 *
 * A server from a URL is discovered first, safely:
 *   - the SSRF guard (url-guard.ts) refuses a private, loopback or metadata
 *     host, and anything but https, before any request; then every address
 *     the name resolves to must be public (url-guard-dns.ts); no redirect
 *     is ever followed;
 *   - one tools/list with no credentials, bounded in time. If it answers,
 *     the server needs no sign-in and the card lists its tools, each with the
 *     access it will start with (initialRequireApprovalTools: everything that
 *     is not a plain read asks first);
 *   - otherwise the server's OAuth metadata (the start route's own discovery,
 *     every URL guarded), bounded in time: the card says it needs a sign-in,
 *     and its tools are listed once the person authorizes.
 * Nothing is saved here: the person's tap does that, through the existing
 * routes, which re-check the URL.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_CATALOG, getIntegration } from '@/lib/integrations/catalog'
import { suggestedMcpServerById, suggestedMcpServerFor, type SuggestedMcpServer } from '@/lib/mcp-client/suggested'
import { assertSafeMcpUrl } from '@/lib/mcp-client/url-guard'
import { assertPublicHost, type AddressLookup } from '@/lib/mcp-client/url-guard-dns'
import { listTools } from '@/lib/mcp-client'
import { discoverOAuthForServer } from '@/lib/mcp-client/oauth'
import { isPlainReadForUnknownServer } from '@/lib/mcp-client/tool-access'
import type { ConnectedMcpServerRow, McpToolDescriptor } from '@/lib/mcp-client/types'
import { missingScopes } from '@/lib/oauth/scope-diff'
import { mcpNeedsReconnect } from '@/lib/mcp-client/needs-reconnect'
import { CONNECT_CARD_TOOLS_MAX, nameFromDomain, type ConnectCard, type ConnectCardStatus } from './connect-card'

/** How long each discovery step may take. */
export const DISCOVERY_TIMEOUT_MS = 6_000

export type ConnectTarget =
  | { provider: string; capability?: string }
  | { catalog_id: string }
  | { mcp_url: string }

export type ConnectResolution = { ok: true; card: ConnectCard } | { ok: false; error: string }

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/

function transportFor(url: URL): 'streamable_http' | 'sse' {
  return /\/sse\/?$/.test(url.pathname) ? 'sse' : 'streamable_http'
}

/** The status of the caller's account(s) for one integration. */
async function integrationStatus(
  supabase: SupabaseClient,
  userId: string,
  provider: string,
  capability: string,
): Promise<{ status: ConnectCardStatus; account: string | null }> {
  const { data } = await supabase
    .from('connected_account')
    .select('id, account_email, is_enabled, reauth_required_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('capability', capability)
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; account_email: string | null; is_enabled: boolean | null; reauth_required_at?: string | null }>
  if (!rows.length) return { status: 'available', account: null }
  const broken = rows.find((r) => r.reauth_required_at)
  if (broken) return { status: 'needs_reconnect', account: broken.account_email }
  const { data: tokens } = await supabase
    .from('user_oauth_tokens')
    .select('account_id, scopes, updated_at')
    .eq('user_id', userId)
    .in('account_id', rows.map((r) => r.id))
    .order('updated_at', { ascending: false })
  const scopes = new Map<string, string[]>()
  for (const t of (tokens ?? []) as Array<{ account_id: string; scopes: string[] | null }>) if (!scopes.has(t.account_id)) scopes.set(t.account_id, t.scopes ?? [])
  const stale = rows.find((r) => missingScopes(provider, capability, scopes.get(r.id) ?? []).length > 0)
  if (stale) return { status: 'needs_update', account: stale.account_email }
  return { status: 'connected', account: rows[0].account_email }
}

/**
 * A server URL as one comparable string: lowercased scheme and host, no
 * default port, no trailing slash or dot, no fragment.
 */
export function normalizeServerUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/\.+$/, '')
    const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : ''
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${host}${port}${path}${u.search}`
  } catch {
    return raw.trim()
  }
}

interface AppMatch {
  status: 'available' | 'connected' | 'needs_reconnect'
  /**
   * The expired row's own name, URL and transport (or the first row's): a
   * Reconnect signs in under them, so the OAuth callback renews that very row
   * and keeps its URL (a path or query the person set stays).
   */
  row: { name: string; server_url: string; transport: 'streamable_http' | 'sse' } | null
}

/**
 * The caller's server with this URL (same host for a catalog app, the same
 * normalized URL otherwise), if any: connected, or its sign-in expired
 * (GEN-1171: the card's tap then signs in again, in place).
 */
async function appStatus(supabase: SupabaseClient, userId: string, serverUrl: string, catalog: SuggestedMcpServer | undefined): Promise<AppMatch> {
  // `*` (public fields only are used): reauth_required_at is absent before migration 451.
  const { data } = await supabase.from('connected_mcp_server').select('*').eq('user_id', userId)
  const rows = (Array.isArray(data) ? data : []) as Array<{ server_url: string; display_name?: string; transport?: string; reauth_required_at?: string | null; last_error?: string | null }>
  const want = normalizeServerUrl(serverUrl)
  const mine = rows.filter((r) => (catalog ? suggestedMcpServerFor(r.server_url)?.id === catalog.id : normalizeServerUrl(r.server_url) === want))
  if (!mine.length) return { status: 'available', row: null }
  const expired = mine.find((r) => mcpNeedsReconnect(r))
  const pick = expired ?? mine[0]
  const row =
    typeof pick.display_name === 'string' && pick.display_name
      ? { name: pick.display_name.slice(0, 100), server_url: pick.server_url, transport: pick.transport === 'sse' ? ('sse' as const) : ('streamable_http' as const) }
      : null
  return { status: expired ? 'needs_reconnect' : 'connected', row }
}

function catalogCard(entry: SuggestedMcpServer, match: AppMatch): ConnectCard {
  // An expired one reconnects as the person's own row: its name, its URL.
  const own = match.status === 'needs_reconnect' ? match.row : null
  return {
    kind: 'catalog_app',
    catalog_id: entry.id,
    name: own?.name ?? entry.display_name,
    description: entry.description,
    domain: new URL(entry.server_url).hostname,
    server_url: own?.server_url ?? entry.server_url,
    transport: own?.transport ?? entry.transport,
    status: match.status,
  }
}

/** A throwaway row for a no-credential tools/list (never saved). */
function probeRow(userId: string, serverUrl: string, transport: 'streamable_http' | 'sse'): ConnectedMcpServerRow {
  const now = new Date().toISOString()
  return {
    id: 'connect-probe',
    user_id: userId,
    workspace_id: null,
    display_name: 'probe',
    server_url: serverUrl,
    transport,
    auth_type: 'none',
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    token_expires_at: null,
    oauth_metadata: null,
    is_enabled: true,
    disabled_tools: [],
    require_approval_tools: [],
    tools_cache: null,
    tools_cache_refreshed_at: null,
    last_health_check_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

export interface ConnectDeps {
  listTools?: (row: ConnectedMcpServerRow, opts: { signal: AbortSignal }) => Promise<McpToolDescriptor[]>
  discoverOAuth?: (url: string, opts: { signal: AbortSignal }) => Promise<unknown>
  /** The DNS lookup the public-address check uses (tests pass their own). */
  lookup?: AddressLookup
}

/** Resolve `connect`'s input to its card. Never throws. */
export async function resolveConnectTarget(
  supabase: SupabaseClient,
  userId: string,
  target: ConnectTarget,
  deps: ConnectDeps = {},
): Promise<ConnectResolution> {
  if ('provider' in target) {
    const provider = target.provider.trim().toLowerCase()
    const choices = INTEGRATION_CATALOG.filter((e) => e.provider === provider)
    if (!choices.length) {
      return { ok: false, error: `"${target.provider}" isn't an integration Dial8 has. Integrations: ${[...new Set(INTEGRATION_CATALOG.map((e) => e.provider))].join(', ')}. For another app, pass its catalog_id or its MCP server URL.` }
    }
    const capability = target.capability?.trim().toLowerCase() || (choices.length === 1 ? choices[0].capability : '')
    const entry = capability ? getIntegration(provider, capability) : undefined
    if (!entry) {
      return { ok: false, error: `Say which ${provider} connection: capability ${choices.map((c) => `"${c.capability}" (${c.name})`).join(' or ')}.` }
    }
    const { status, account } = await integrationStatus(supabase, userId, provider, entry.capability)
    return { ok: true, card: { kind: 'integration', provider, capability: entry.capability, name: entry.name, description: entry.description, status, account } }
  }

  if ('catalog_id' in target) {
    const entry = suggestedMcpServerById(target.catalog_id.trim().toLowerCase())
    if (!entry) return { ok: false, error: `"${target.catalog_id}" isn't in the app catalog. For any other app, pass its MCP server URL as mcp_url.` }
    return { ok: true, card: catalogCard(entry, await appStatus(supabase, userId, entry.server_url, entry)) }
  }

  const guard = assertSafeMcpUrl(target.mcp_url.trim())
  if (!guard.ok) return { ok: false, error: `That URL can't be connected: ${guard.reason}.` }
  const url = guard.url
  const serverUrl = url.toString()
  const catalog = suggestedMcpServerFor(serverUrl)
  if (catalog) return { ok: true, card: catalogCard(catalog, await appStatus(supabase, userId, catalog.server_url, catalog)) }
  // Every address the name resolves to must be public, before any request.
  const resolved = await assertPublicHost(url, deps.lookup)
  if (!resolved.ok) return { ok: false, error: `That URL can't be connected: ${resolved.reason}.` }
  const domain = url.hostname
  const transport = transportFor(url)
  const base = { kind: 'url_app' as const, name: nameFromDomain(domain), domain, server_url: serverUrl, transport }
  const existing = await appStatus(supabase, userId, serverUrl, undefined)
  if (existing.status !== 'available') {
    const own = existing.row ? { name: existing.row.name, server_url: existing.row.server_url, transport: existing.row.transport } : {}
    return { ok: true, card: { ...base, ...own, auth: 'oauth', tools: null, status: existing.status } }
  }

  // 1. No credentials: does it list its tools?
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  let tools: McpToolDescriptor[] | null = null
  try {
    tools = await (deps.listTools ?? ((row, opts) => listTools(row, opts)))(probeRow(userId, serverUrl, transport), { signal: controller.signal })
  } catch {
    tools = null
  } finally {
    clearTimeout(timer)
  }
  if (tools) {
    // A hostile server can list thousands of names: the card (and the model
    // reading this result) gets at most CONNECT_CARD_TOOLS_MAX, and the count.
    const safe = tools.filter((t) => t && typeof t.name === 'string' && SAFE_TOOL_NAME.test(t.name))
    const shown = safe
      .slice(0, CONNECT_CARD_TOOLS_MAX)
      .map((t) => ({ name: t.name, access: isPlainReadForUnknownServer(t) ? ('read_only' as const) : ('ask' as const) }))
    return { ok: true, card: { ...base, auth: 'none', tools: shown, tool_count: safe.length, status: 'available' } }
  }

  // 2. A sign-in: its OAuth metadata (every URL it follows is guarded).
  // The deadline really aborts discovery's requests (and its body reads are capped: oauth.ts).
  const discovery = new AbortController()
  const discoveryTimer = setTimeout(() => discovery.abort(), DISCOVERY_TIMEOUT_MS)
  const oauth = await withTimeout((deps.discoverOAuth ?? discoverOAuthForServer)(serverUrl, { signal: discovery.signal }), DISCOVERY_TIMEOUT_MS).finally(() =>
    clearTimeout(discoveryTimer),
  )
  if (oauth) return { ok: true, card: { ...base, auth: 'oauth', tools: null, status: 'available' } }
  return { ok: false, error: `Nothing at ${domain} answered as an MCP server (no tool list, no sign-in). Check the URL with the person; it is usually the server's /mcp address.` }
}
