/**
 * list_connections (flows-connectors F2 §2.1): the person's integrations and
 * connected apps, each with its status, what it can do, per-tool access for
 * an app, and which of their loops use it. Plus what they could connect.
 *
 * Person-scoped: only the caller's own OAuth accounts and MCP servers (both
 * tables are per person), and only the caller's own loops in this workspace
 * (a loop runs as its owner). An account says whether it is linked to this
 * workspace. No token, client secret or OAuth metadata is ever read into the
 * result: the account read names its columns, and an app row is reduced to
 * its public fields first (public-row.ts).
 *
 * Four reads (accounts, their workspace links and scopes, apps, loops + their
 * skills), all on the tool's call, never per turn. With a GitHub integration,
 * also its agent tools (github-integration.ts: its token is read to list them,
 * and never reaches the result).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_CATALOG, getIntegration } from '@/lib/integrations/catalog'
import { SUGGESTED_MCP_SERVERS, suggestedMcpServerFor } from '@/lib/mcp-client/suggested'
import { publicMcpServer } from '@/lib/mcp-client/public-row'
import { mcpToolState, type McpToolState } from '@/lib/mcp-client/tool-access'
import { mcpNeedsReconnect } from '@/lib/mcp-client/needs-reconnect'
import { loadGitHubIntegrationServer, shadowsGitHubIntegration } from '@/lib/mcp-client/github-integration'
import { mcpServerSlug } from '@/lib/mcp-client/adapter'
import type { McpToolDescriptor } from '@/lib/mcp-client/types'
import { missingScopes } from '@/lib/oauth/scope-diff'
import { getToolSideEffect, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { loadLoopNeeds, loopsNeeding, needOfIntegration, type DependentLoop } from './dependents'

export type ConnectionStatus = 'connected' | 'needs_reconnect' | 'needs_update' | 'error' | 'off'

/** What a connection lets the agent do, counted. */
export interface ConnectionCapability {
  summary: string
  tools: number
  reads: number
  writes: number
}

export interface ListedConnection {
  /** The id disconnect and set_tool_access take. */
  id: string
  kind: 'integration' | 'app'
  name: string
  /** integration: its provider and capability (connect takes them). app: its catalog id, when it is one. */
  provider?: string
  capability?: string
  catalog_id?: string
  account?: string | null
  /** app: the server's domain. */
  domain?: string
  status: ConnectionStatus
  /** integration: whether this workspace uses this account (null: linked to no workspace yet, so any). */
  in_this_workspace?: boolean | null
  can_do: ConnectionCapability
  /**
   * app: the tools the server lists, with their access (new = hidden until
   * added), at most LIST_TOOLS_MAX. The GitHub integration: GitHub's read
   * tools the agent reaches on it (github-integration.ts).
   */
  tools?: Array<{ name: string; access: McpToolState }>
  /** app: how many more it lists than `tools` shows. */
  tools_not_shown?: number
  used_by_loops: DependentLoop[]
  /** app: the server's own error text, fenced as data. */
  error?: string
}

export interface AvailableConnection {
  name: string
  description: string
  /** What connect takes to put up its card. */
  connect: { provider: string; capability: string } | { catalog_id: string }
}

export interface ConnectionsList {
  connections: ListedConnection[]
  available: AvailableConnection[]
}

/** The chat tools each integration powers (the registry's names; their classes give the split). */
const INTEGRATION_TOOLS: Record<string, { tools: string[]; summary: string }> = {
  'google:calendar': { tools: categoryTools('calendar', 'calendar_capture'), summary: 'Read and change calendar events; meetings become captures.' },
  'microsoft:calendar': { tools: categoryTools('calendar', 'calendar_capture'), summary: 'Read and change calendar events; meetings become captures.' },
  'google:email': { tools: categoryTools('emails'), summary: 'Read mail and write drafts (never sends).' },
  'microsoft:email': { tools: categoryTools('emails'), summary: 'Read mail and write drafts (never sends).' },
  'github:github': { tools: [], summary: 'Links pull requests to actions and projects; loops can start on a PR change.' },
  'hubspot:crm': { tools: [], summary: 'Syncs contacts and companies from HubSpot into the CRM.' },
  // The SEO area (src/lib/seo/google/, src/lib/ai/tools/seo-google.ts): read only, for the workspace's chosen site and property.
  'google:search_console': {
    tools: ['list_search_console_sites', 'get_search_console_performance', 'get_search_opportunities', 'get_url_inspection', 'set_search_console_site'],
    summary: 'Reads Search Console for the site this workspace chose: searches, clicks, positions and index status (read only).',
  },
  'google:analytics': {
    tools: [
      'list_google_analytics_properties',
      'get_google_analytics_organic_overview',
      'get_google_analytics_organic_landing_pages',
      'get_google_analytics_page_performance',
      'get_google_analytics_key_events',
      'get_google_analytics_traffic_acquisition',
      'get_google_analytics_ecommerce_performance',
      'get_google_analytics_site_search',
      'get_google_analytics_audience_breakdown',
      'get_google_analytics_measurement_health',
      'set_google_analytics_property',
    ],
    summary: 'Reads Google Analytics for the property this workspace chose: what visitors from search do on the site (read only).',
  },
  'asana:tasks': { tools: ['push_action_to_asana'], summary: 'Pushes actions to Asana as tasks and keeps completion in sync.' },
  'jira:tasks': { tools: ['push_action_to_jira'], summary: 'Pushes actions to Jira as issues and keeps status in sync.' },
  'linear:tasks': { tools: ['push_action_to_linear'], summary: 'Pushes actions to Linear as issues and keeps state in sync.' },
}

function categoryTools(...ids: string[]): string[] {
  return TOOL_CATEGORIES.filter((c) => ids.includes(c.id)).flatMap((c) => c.tools.map((t) => t.name))
}

/**
 * The GitHub integration's row when its sign-in also gives the agent GitHub's
 * read tools (github-integration.ts): one GitHub connection, never a second
 * row for its MCP server.
 */
function githubCapability(n: number): ConnectionCapability {
  return {
    summary:
      `${INTEGRATION_TOOLS['github:github'].summary} Its sign-in also gives you ${n} read-only GitHub tools ` +
      '(repos, commits, files, code, issues, pull requests), named mcp__github__*: load them with search_tools ("github <what you need>"). ' +
      'A loop\'s call_tool step or a skill step takes it as connection "GitHub".',
    tools: n,
    reads: n,
    writes: 0,
  }
}

function integrationCapability(provider: string, capability: string): ConnectionCapability {
  const entry = INTEGRATION_TOOLS[`${provider}:${capability}`] ?? { tools: [], summary: getIntegration(provider, capability)?.description ?? '' }
  const reads = entry.tools.filter((t) => getToolSideEffect(t) === 'read').length
  return { summary: entry.summary, tools: entry.tools.length, reads, writes: entry.tools.length - reads }
}

/** The most tool names one app puts in front of the model (a hostile server can list thousands). */
export const LIST_TOOLS_MAX = 50

/** A tool name as the model reads it: a server's own text, so only a plain identifier passes. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/

function domainOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

interface AccountRow {
  id: string
  provider: string
  capability: string
  account_email: string | null
  is_enabled: boolean | null
  reauth_required_at?: string | null
}

/** Read and shape the caller's connections. Never throws: a failed read leaves that half empty. */
export async function listConnections(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string },
): Promise<ConnectionsList> {
  const [accountsRes, appsRes, loops] = await Promise.all([
    supabase
      .from('connected_account')
      // Named columns: never a token (those live in user_oauth_tokens).
      .select('id, provider, capability, account_email, is_enabled, reauth_required_at')
      .eq('user_id', args.userId)
      .order('created_at', { ascending: true }),
    supabase.from('connected_mcp_server').select('*').eq('user_id', args.userId).order('created_at', { ascending: true }),
    loadLoopNeeds(supabase, args),
  ])
  const accounts = (Array.isArray(accountsRes.data) ? accountsRes.data : []) as AccountRow[]
  // The GitHub integration's agent tools, beside the links and scopes (the
  // loader checks the account again). None when an app of theirs is named
  // like it: the adapter adds nothing then, so neither does this.
  const githubLoad =
    accounts.some((a) => a.provider === 'github' && a.capability === 'github' && a.is_enabled !== false && !a.reauth_required_at) &&
    !shadowsGitHubIntegration(Array.isArray(appsRes.data) ? appsRes.data : [], mcpServerSlug)
      ? loadGitHubIntegrationServer(supabase, args.userId)
      : Promise.resolve(null)
  const ids = accounts.map((a) => a.id)
  const [linksRes, scopesRes] = ids.length
    ? await Promise.all([
        supabase.from('connected_account_workspace').select('account_id, workspace_id').in('account_id', ids),
        supabase.from('user_oauth_tokens').select('account_id, scopes, updated_at').eq('user_id', args.userId).order('updated_at', { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }]
  const links = new Map<string, string[]>()
  for (const row of (linksRes.data ?? []) as Array<{ account_id: string; workspace_id: string }>) {
    links.set(row.account_id, [...(links.get(row.account_id) ?? []), row.workspace_id])
  }
  const scopes = new Map<string, string[]>()
  for (const row of (scopesRes.data ?? []) as Array<{ account_id: string | null; scopes: string[] | null }>) {
    if (row.account_id && !scopes.has(row.account_id)) scopes.set(row.account_id, row.scopes ?? [])
  }

  const github = await githubLoad
  const githubToolNames = (github?.tools_cache ?? []).map((t) => t.name).filter((name) => SAFE_TOOL_NAME.test(name))
  const connections: ListedConnection[] = []
  for (const a of accounts) {
    const entry = getIntegration(a.provider, a.capability)
    if (!entry) continue
    const linked = links.get(a.id) ?? []
    const status: ConnectionStatus =
      a.is_enabled === false
        ? 'off'
        : a.reauth_required_at
          ? 'needs_reconnect'
          : missingScopes(a.provider, a.capability, scopes.get(a.id) ?? []).length
            ? 'needs_update'
            : 'connected'
    connections.push({
      id: a.id,
      kind: 'integration',
      name: entry.name,
      provider: a.provider,
      capability: a.capability,
      account: a.account_email,
      status,
      in_this_workspace: linked.length ? linked.includes(args.workspaceId) : null,
      // The account whose sign-in the agent's GitHub tools ride (one, with several).
      ...(github && github.github_account_id === a.id && githubToolNames.length
        ? {
            can_do: githubCapability(githubToolNames.length),
            tools: githubToolNames.slice(0, LIST_TOOLS_MAX).map((name) => ({ name, access: 'read_only' as const })),
            ...(githubToolNames.length > LIST_TOOLS_MAX ? { tools_not_shown: githubToolNames.length - LIST_TOOLS_MAX } : {}),
          }
        : { can_do: integrationCapability(a.provider, a.capability) }),
      used_by_loops: loopsNeeding(loops, needOfIntegration(a.provider, a.capability)),
    })
  }

  const apps = (Array.isArray(appsRes.data) ? appsRes.data : []).map((row) => publicMcpServer(row)).filter(Boolean) as Array<Record<string, unknown>>
  for (const app of apps) {
    const serverUrl = String(app.server_url ?? '')
    const catalog = suggestedMcpServerFor(serverUrl)
    const cache = (Array.isArray(app.tools_cache) ? app.tools_cache : []) as McpToolDescriptor[]
    const lists = {
      server_url: serverUrl,
      disabled_tools: (app.disabled_tools as string[] | null) ?? [],
      allowed_tools: (app.allowed_tools as string[] | null) ?? null,
      require_approval_tools: (app.require_approval_tools as string[] | null) ?? [],
      approval_free_tools: (app.approval_free_tools as string[] | null) ?? [],
    }
    const tools = cache
      .filter((t) => t && typeof t.name === 'string' && SAFE_TOOL_NAME.test(t.name))
      .map((t) => ({ name: t.name, access: mcpToolState(t, lists) }))
    const visible = tools.filter((t) => t.access !== 'new' && t.access !== 'off')
    const reads = visible.filter((t) => t.access === 'read_only').length
    const lastError = typeof app.last_error === 'string' && app.last_error ? app.last_error : null
    const nNew = tools.filter((t) => t.access === 'new').length
    connections.push({
      id: String(app.id),
      kind: 'app',
      name: catalog?.display_name ?? String(app.display_name ?? 'Connected app'),
      ...(catalog ? { catalog_id: catalog.id } : {}),
      domain: domainOf(serverUrl),
      // An expired sign-in (GEN-1171) is its own status: connect's card reconnects it in place.
      status: app.is_enabled === false ? 'off' : mcpNeedsReconnect(app) ? 'needs_reconnect' : lastError ? 'error' : 'connected',
      can_do: {
        summary:
          `${visible.length} of its ${tools.length} tools reach you: ${reads} run without asking, ${visible.length - reads} ask first.` +
          (nNew ? ` ${nNew} new ${nNew === 1 ? 'tool is' : 'tools are'} hidden until added.` : ''),
        tools: visible.length,
        reads,
        writes: visible.length - reads,
      },
      tools: tools.slice(0, LIST_TOOLS_MAX),
      ...(tools.length > LIST_TOOLS_MAX ? { tools_not_shown: tools.length - LIST_TOOLS_MAX } : {}),
      // No loop can reach a connected app yet (F4 adds call_tool).
      used_by_loops: [],
      ...(lastError ? { error: wrapUntrusted(lastError.slice(0, 200), 'TOOL') ?? undefined } : {}),
    })
  }

  // What they could connect: every catalog integration with no account, every catalog app not added.
  const have = new Set(accounts.map((a) => `${a.provider}:${a.capability}`))
  const haveApps = new Set(apps.map((a) => suggestedMcpServerFor(String(a.server_url ?? ''))?.id).filter(Boolean))
  const available: AvailableConnection[] = [
    ...INTEGRATION_CATALOG.filter((e) => !have.has(`${e.provider}:${e.capability}`)).map((e) => ({
      name: e.name,
      description: e.description,
      connect: { provider: e.provider, capability: e.capability },
    })),
    ...SUGGESTED_MCP_SERVERS.filter((s) => !haveApps.has(s.id)).map((s) => ({
      name: s.display_name,
      description: s.description,
      connect: { catalog_id: s.id },
    })),
  ]
  return { connections, available }
}
