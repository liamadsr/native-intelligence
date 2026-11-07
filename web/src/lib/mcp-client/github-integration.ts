/**
 * The agent's GitHub tools, on the person's GitHub integration: one GitHub
 * connection for both jobs (Liam, 2026-10-27). The integration's sign-in
 * already clones, pushes and opens pull requests for coding runs, lists repos
 * and links pull requests to actions; the agent reads GitHub through GitHub's
 * own MCP server with that same token. Nobody connects GitHub twice, and
 * Settings and list_connections show one GitHub row.
 *
 * The server is built here, in memory, from the integration, and never stored
 * in connected_mcp_server: turning GitHub off, or a sign-in that needs
 * reconnecting, takes the tools away on the next turn, with nothing to keep
 * in step. The adapter (adapter.ts createExternalMcpTools) adds it beside the
 * person's connected apps, so the chat's prompt block, tool search, tool route
 * and the Mac's tool route all see it like any app.
 *
 *   - Read-only at GitHub: the `/readonly` URL, where GitHub's server lists no
 *     write tool and refuses one by name ("unknown tool"), whatever we send.
 *     The toolsets are pinned with its X-MCP-Toolsets header.
 *   - Read-only here too: a listed tool without readOnlyHint, or with
 *     destructiveHint, is dropped. The kept ones run without a card (they are
 *     the row's approval_free_tools, approval-policy.ts step 2), as a catalog
 *     app's reads do.
 *   - A home turn runs them on its own (ServerToolMeta.pinnedRead), names like
 *     pull_request_read included: reading GitHub sends nothing anywhere.
 *   - The tool list is GitHub's, the same for everyone: listed once per
 *     instance with the first caller's token. Past GITHUB_TOOLS_TTL_MS the
 *     kept list still serves while one re-list runs in the background (a
 *     failed one keeps it). Only an instance with no list waits for one, at
 *     most GITHUB_TOOLS_LIST_TIMEOUT_MS. A listing that fails makes that person
 *     wait GITHUB_TOOLS_RETRY_MS before their token lists again (theirs only:
 *     one person's revoked token never takes the tools from anyone else).
 *   - A result is cut to GITHUB_RESULT_MAX_CHARS before it is fenced: one pull
 *     request comes back as 7-12K characters.
 *   - A sign-in GitHub refuses (HTTP 401: revoked, or the app's access
 *     withdrawn) answers the agent with GITHUB_RECONNECT_INSTRUCTION.
 *   - An app of the person's own whose tools would be named mcp__github__*
 *     wins: the integration then adds nothing (shadowsGitHubIntegration).
 *
 * Never throws: anything missing or failing is no GitHub tools this turn.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptCredential } from '@/lib/crypto/credentials'
import { storedGithubTokensByAccount } from '@/lib/oauth/github-token'
import { listTools } from './index'
import type { ConnectedMcpServerRow, McpToolDescriptor } from './types'
import { GITHUB_INTEGRATION_SERVER_ID, GITHUB_MCP_URL, GITHUB_SERVER_DISPLAY_NAME } from './github-server'

export { GITHUB_INTEGRATION_SERVER_ID, GITHUB_MCP_URL, GITHUB_SERVER_DISPLAY_NAME, isGitHubReadOnlyServerUrl } from './github-server'

/** What it offers: who the person is, repos (commits, files, code), issues, pull requests. */
export const GITHUB_MCP_TOOLSETS = 'context,repos,issues,pull_requests'

/** The most of one result the agent reads (cut before fencing, so the marker always closes). */
export const GITHUB_RESULT_MAX_CHARS = 40_000

/** Our own words on each GitHub tool's description, after the server's fenced text. */
export const GITHUB_TOOL_NOTE =
  `Read-only, on the person's GitHub sign-in. A result over ${GITHUB_RESULT_MAX_CHARS.toLocaleString('en-US')} characters is cut, and one pull request or issue is up to 12,000: ask for 3 to 5 at a time (perPage). list_commits is the short way to see what merged.`

/** How long one listing of GitHub's tools is kept. */
export const GITHUB_TOOLS_TTL_MS = 6 * 60 * 60 * 1000
/** How long a person whose listing failed waits before it is tried again. */
export const GITHUB_TOOLS_RETRY_MS = 5 * 60 * 1000
/** How long a turn waits for a listing before going on without GitHub. */
export const GITHUB_TOOLS_LIST_TIMEOUT_MS = 4_000

let toolsCache: { tools: McpToolDescriptor[]; at: number } | null = null
let listing: Promise<McpToolDescriptor[] | null> | null = null
const failedAt = new Map<string, number>()
/** The most people one instance remembers a failed listing for. */
const FAILED_MAX = 1_000

/** Test seam: forget the listed tools and every failure. */
export function _resetGitHubToolsForTests(): void {
  toolsCache = null
  listing = null
  failedAt.clear()
}

/** True for the server this module builds. */
export function isGitHubIntegrationServer(server: Pick<ConnectedMcpServerRow, 'id'>): boolean {
  return server.id === GITHUB_INTEGRATION_SERVER_ID
}

/**
 * True when one of the person's own apps (enabled or not) would name its tools
 * mcp__github__*: theirs wins whole, so a tool they switched off or never
 * added never comes back through the integration, and the prompt names one
 * GitHub. The slug rule is the adapter's (mcpServerSlug), passed in.
 */
export function shadowsGitHubIntegration(
  servers: ReadonlyArray<{ id?: unknown; display_name?: unknown }>,
  slugOf: (displayName: string) => string,
): boolean {
  const ours = slugOf(GITHUB_SERVER_DISPLAY_NAME)
  return servers.some((s) => s?.id !== GITHUB_INTEGRATION_SERVER_ID && typeof s?.display_name === 'string' && slugOf(s.display_name) === ours)
}

/** What the agent reads when GitHub refuses the sign-in. */
export const GITHUB_RECONNECT_INSTRUCTION =
  'GitHub refused the sign-in. Tell the person to reconnect GitHub in Settings > Connectors, and stop calling GitHub tools for the rest of this conversation.'

/** GitHub's server refused the token (the transport's HTTP 401). */
export function isGitHubSignInRefused(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 401
}

/** A tool GitHub marks read-only and not destructive: the only kind kept. */
export function isGitHubReadTool(tool: McpToolDescriptor): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true
}

interface Deps {
  listTools?: typeof listTools
  now?: () => number
  /**
   * Never wait for a listing (a live meeting turn): an instance with no list
   * yet starts one in the background and gives no GitHub tools this time.
   */
  cachedOnly?: boolean
}

/** The built server: a connected-app row, plus the GitHub account whose sign-in it rides. */
export type GitHubIntegrationServer = ConnectedMcpServerRow & { github_account_id: string }

/** The row, its token encrypted the way a stored one is, so the client dials it like any app. */
function githubServerRow(
  userId: string,
  accountId: string,
  token: string,
  createdAt: string,
  tools: McpToolDescriptor[],
): GitHubIntegrationServer {
  const names = tools.map((t) => t.name)
  return {
    id: GITHUB_INTEGRATION_SERVER_ID,
    github_account_id: accountId,
    user_id: userId,
    workspace_id: null,
    display_name: GITHUB_SERVER_DISPLAY_NAME,
    server_url: GITHUB_MCP_URL,
    transport: 'streamable_http',
    auth_type: 'bearer',
    access_token_encrypted: encryptCredential(token),
    refresh_token_encrypted: null,
    token_expires_at: null,
    oauth_metadata: null,
    is_enabled: true,
    disabled_tools: [],
    require_approval_tools: [],
    approval_free_tools: names,
    allowed_tools: names,
    tools_cache: tools,
    tools_cache_refreshed_at: null,
    last_health_check_at: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    extra_headers: { 'X-MCP-Toolsets': GITHUB_MCP_TOOLSETS },
  }
}

/**
 * One listing at a time per instance (whoever asks meanwhile shares it),
 * bounded by the timeout. A success replaces the kept list; a failure keeps
 * it and makes this person wait GITHUB_TOOLS_RETRY_MS. Never rejects.
 */
function relist(userId: string, rowForListing: () => ConnectedMcpServerRow, deps: Deps): Promise<McpToolDescriptor[] | null> {
  if (listing) return listing
  const now = deps.now ?? Date.now
  const run = (async () => {
    try {
      const listed = await (deps.listTools ?? listTools)(rowForListing(), { signal: AbortSignal.timeout(GITHUB_TOOLS_LIST_TIMEOUT_MS) })
      const tools = listed.filter((t) => t && typeof t.name === 'string' && isGitHubReadTool(t))
      if (!tools.length) throw new Error('GitHub listed no read-only tools')
      toolsCache = { tools, at: now() }
      return tools
    } catch (err) {
      console.warn('[github mcp] tools/list failed:', { name: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : String(err) })
      if (failedAt.size >= FAILED_MAX) failedAt.clear()
      failedAt.set(userId, now())
      return null
    }
  })()
  // Cleared once settled, and only if still this one (a throw before the
  // first await settles it before it is even assigned).
  listing = run
  void run.finally(() => {
    if (listing === run) listing = null
  })
  return run
}

/**
 * GitHub's read tools: the kept list (past its TTL it still serves, and one
 * re-list starts in the background), or, on an instance with none, one
 * listing waited for. Null when there is none to give.
 */
async function githubTools(
  userId: string,
  rowForListing: () => ConnectedMcpServerRow,
  deps: Deps,
): Promise<McpToolDescriptor[] | null> {
  const now = deps.now ?? Date.now
  const failed = failedAt.get(userId)
  const waiting = failed !== undefined && now() - failed < GITHUB_TOOLS_RETRY_MS
  if (toolsCache) {
    if (now() - toolsCache.at >= GITHUB_TOOLS_TTL_MS && !waiting) void relist(userId, rowForListing, deps)
    return toolsCache.tools
  }
  if (waiting) return null
  if (deps.cachedOnly) {
    void relist(userId, rowForListing, deps)
    return null
  }
  return relist(userId, rowForListing, deps)
}

/**
 * The person's GitHub server, built from their GitHub integration: an enabled
 * account that needs no reconnect, that account's own newest token (never
 * another account's, so an account turned off or needing a reconnect lends
 * nothing; every GitHub token on DEV and PROD carries its account_id), and
 * GitHub's read tools. Null when any is missing.
 */
export async function loadGitHubIntegrationServer(
  supabase: SupabaseClient,
  userId: string,
  deps: Deps = {},
): Promise<GitHubIntegrationServer | null> {
  try {
    const { data: accounts } = await supabase
      .from('connected_account')
      .select('id, created_at, reauth_required_at')
      .eq('user_id', userId)
      .eq('provider', 'github')
      .eq('capability', 'github')
      .eq('is_enabled', true)
      .order('created_at', { ascending: true })
    const usable = (Array.isArray(accounts) ? accounts : []).filter(
      (a: { id?: unknown; reauth_required_at?: unknown }) => typeof a?.id === 'string' && !a.reauth_required_at,
    ) as Array<{ id: string; created_at?: string | null }>
    if (!usable.length) return null

    const tokens = await storedGithubTokensByAccount(supabase, userId)
    const tokenOf = (accountId: string): string | null => tokens.find((t) => t.accountId === accountId)?.token ?? null
    const account = usable.find((a) => tokenOf(a.id))
    const token = account ? tokenOf(account.id) : null
    if (!account || !token) return null

    const createdAt = typeof account.created_at === 'string' ? account.created_at : new Date(0).toISOString()
    const row = (tools: McpToolDescriptor[]) => githubServerRow(userId, account.id, token, createdAt, tools)
    const tools = await githubTools(userId, () => row([]), deps)
    return tools ? row(tools) : null
  } catch (err) {
    console.warn('[github mcp] could not build the GitHub server:', { name: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : String(err) })
    return null
  }
}
