/**
 * The chat's Connections list: every connection the user has, needs to fix,
 * or could add, as ONE flat model the panel renders without knowing where each
 * fact came from.
 *
 * Pure (no React, no fetch) so every grouping rule is a plain test case.
 * Sources:
 *   - the integration catalog (catalog.ts), in catalog order, GitHub included.
 *   - `LOCAL_EXCHANGE_ENTRY`, desktop only (EventKit, no OAuth).
 *   - `GET /api/account/integrations/slack` for Dial8's Slack app, only where
 *     this deployment has one (`SLACK_APP_ENTRY`).
 *   - `GET /api/account/phone` for Texting, only where this deployment has
 *     texting (`TEXTING_ENTRY`).
 *   - `GET /api/oauth/status` for every OAuth account.
 *   - `GET /api/account/mcp-servers` for connected MCP apps, plus the curated
 *     suggestions (mcp-client/suggested.ts) not yet added.
 *
 * One row per catalog entry: several accounts for one entry make one row
 * ("a@x.com +1"), and if any of them needs attention the row does.
 */

import { INTEGRATION_CATALOG, LOCAL_EXCHANGE_ENTRY, SLACK_APP_ENTRY, TEXTING_ENTRY } from './catalog'
import type { ConnectedAccount, OAuthStatus } from './oauth-status'
import type { SuggestedMcpServer } from '@/lib/mcp-client/suggested'
import type { LocalCalendarStatus } from '@/lib/tauri-bridge'
import { mcpNeedsReconnect } from '@/lib/mcp-client/needs-reconnect'

export type ConnectionGroup = 'connected' | 'attention' | 'available'
export type AttentionCause =
  | 'reauth'
  | 'missing_scopes'
  | 'sync_error'
  | 'hubspot_write'
  | 'mcp_error'
  | 'mcp_expired'

export type ConnectionAction = 'manage' | 'connect' | 'update' | 'reconnect'

/** A connected MCP server as `GET /api/account/mcp-servers` returns it (the fields this model reads). */
export interface McpServerRow {
  id: string
  display_name: string
  server_url: string
  transport?: 'streamable_http' | 'sse'
  auth_type?: 'none' | 'bearer' | 'oauth2'
  is_enabled?: boolean
  last_error: string | null
  token_expires_at?: string | null
  /** Its sign-in expired for good and needs the person (migration 451). */
  reauth_required_at?: string | null
}

/**
 * `GET /api/account/integrations/slack` (the fields this model reads):
 * `{ configured: false }` where this deployment has no Slack app.
 */
export interface SlackAppStatus {
  configured: boolean
  /** May add Dial8 to a Slack workspace (a Dial8 workspace admin). */
  canInstall?: boolean
  /** May link their own Slack account (not a guest). */
  canLink?: boolean
  installations?: Array<{
    teamId: string
    teamName: string | null
    teamDomain: string | null
    myLink: { slackUserName: string | null } | null
  }>
}

/**
 * `GET /api/account/phone` (the fields this model reads): `available: false`
 * where this deployment has no texting.
 */
export interface PhoneStatus {
  available: boolean
  phone: { masked: string; optedOut: boolean } | null
}

export interface ConnectionRow {
  /** Stable React key: `${provider}:${capability}`, `mcp:${serverId}` or `mcp-suggested:${id}`. */
  key: string
  /**
   * 'app' is Dial8's own app installed in another product (Slack): adding it
   * takes steps on its page, so every action opens that page.
   */
  kind: 'oauth' | 'mcp' | 'local' | 'app'
  /** OAuth/local/app: the provider (`getBrandIcon(provider, capability)`). MCP: the suggested id, or 'mcp'. */
  provider: string
  /** 'mcp' for MCP rows. */
  capability: string
  name: string
  group: ConnectionGroup
  cause: AttentionCause | null
  /** One short status word/phrase for the row. */
  statusText: string
  /** The connected account's email or label, when there is one ("a@x.com +1" for several). */
  detail: string | null
  /** The ONE action: manage (open Settings at settingsPath), connect, update (re-run connect for missing scopes), reconnect. */
  action: ConnectionAction
  /**
   * For `openSettings(path)` (settings-overlay.tsx): the connector's own page
   * under Settings › Connectors (`connectors/{provider}/{capability}`,
   * `connectors/local-exchange/calendar`, `connectors/mcp/{serverId}`,
   * `connectors/slack`), or
   * `connectors` for an MCP suggestion not added yet. Set on every row.
   */
  settingsPath: string | null
  /** For 'update' / 'reconnect': the account to re-authorize, passed as `connect(…, { loginHint })`. */
  loginHint: string | null
  /** MCP rows only. */
  mcp?: {
    /** The connected server's id; null for a suggestion not yet added. */
    serverId: string | null
    serverUrl: string
    /** An added server: false when the person switched it off. Absent on a suggestion. */
    enabled?: boolean
    /** An added server's transport: its Reconnect signs in again at its own URL (GEN-1171). */
    transport?: 'streamable_http' | 'sse'
    /**
     * The matching curated suggestion: its icon (`iconSvg` / `iconPath` +
     * `iconViewBox`, `accent`) and, for an available row, what
     * `connectWithUrl(row.key, () => startMcpOAuth(suggested))` needs. Null for
     * a custom server.
     */
    suggested: SuggestedMcpServer | null
  }
}

export interface ConnectionGroups {
  connected: ConnectionRow[]
  attention: ConnectionRow[]
  available: ConnectionRow[]
}

/** HubSpot meeting-logging writeback needs this scope (mirrors integration-detail-view.tsx). */
export const HUBSPOT_WRITE_SCOPE = 'crm.objects.contacts.write'

/** Highest priority first: when one account has several problems, the first wins. */
const CAUSE_PRIORITY: readonly AttentionCause[] = [
  'reauth',
  'missing_scopes',
  'sync_error',
  'hubspot_write',
  'mcp_expired',
  'mcp_error',
]

const CAUSE_PRESENTATION: Record<AttentionCause, { statusText: string; action: ConnectionAction }> = {
  reauth: { statusText: 'Reconnect', action: 'reconnect' },
  missing_scopes: { statusText: 'Update access', action: 'update' },
  sync_error: { statusText: 'Sync error', action: 'manage' },
  hubspot_write: { statusText: 'Needs write access', action: 'update' },
  // A sign-in renews the server's own row (the OAuth callback, GEN-1171): a
  // catalog app reconnects from the row, a custom one on its own page.
  mcp_expired: { statusText: 'Reconnect', action: 'reconnect' },
  mcp_error: { statusText: 'Error', action: 'manage' },
}

/**
 * What's wrong with one OAuth account, if anything.
 *
 * HubSpot write access: the detail view flags a HubSpot connection whose
 * granted `scopes` lack contacts.write (including legacy rows with no recorded
 * scopes). The status route ALSO folds that scope into `missing_scopes` when
 * the grant is recorded, so a HubSpot account missing ONLY the write scope is
 * classified as `hubspot_write` rather than `missing_scopes`; any other missing
 * scope still reads as `missing_scopes`.
 */
export function accountCause(account: ConnectedAccount): AttentionCause | null {
  if (account.reauth_required_at) return 'reauth'
  const missing = account.missing_scopes ?? []
  const isHubspotCrm = account.provider === 'hubspot' && account.capability === 'crm'
  const otherMissing = isHubspotCrm ? missing.filter((s) => s !== HUBSPOT_WRITE_SCOPE) : missing
  if (otherMissing.length > 0) return 'missing_scopes'
  if (account.capability === 'email' && account.last_sync_error) return 'sync_error'
  if (
    isHubspotCrm &&
    (missing.includes(HUBSPOT_WRITE_SCOPE) || !(account.scopes ?? []).includes(HUBSPOT_WRITE_SCOPE))
  ) {
    return 'hubspot_write'
  }
  return null
}

/**
 * What's wrong with a connected MCP server: its sign-in marked expired by the
 * refresh path (`reauth_required_at`, mcp-client/token-refresh.ts; before
 * migration 451 its `last_error` saying so), or another error. A past
 * `token_expires_at` alone is NOT a signal: the access token is refreshed on
 * the next call (and hourly ahead of its expiry), so it is normal on an idle
 * server.
 */
export function mcpCause(server: McpServerRow): AttentionCause | null {
  if (mcpNeedsReconnect(server)) return 'mcp_expired'
  return server.last_error ? 'mcp_error' : null
}

function firstByPriority(causes: (AttentionCause | null)[]): AttentionCause | null {
  for (const cause of CAUSE_PRIORITY) if (causes.includes(cause)) return cause
  return null
}

function accountLabel(account: ConnectedAccount): string | null {
  const email = account.account_email || null
  // GitHub rows store the login as `login@github` (see the GitHub card).
  if (email && account.provider === 'github') return email.replace(/@github$/, '')
  return email ?? account.display_name ?? null
}

function withMore(label: string | null, total: number): string | null {
  if (!label) return total > 1 ? `${total} accounts` : null
  return total > 1 ? `${label} +${total - 1}` : label
}

function oauthRows(status: OAuthStatus | null): ConnectionRow[] {
  const accounts = status?.accounts ?? []
  return INTEGRATION_CATALOG.map((entry): ConnectionRow => {
    const base = {
      key: `${entry.provider}:${entry.capability}`,
      kind: 'oauth' as const,
      provider: entry.provider,
      capability: entry.capability,
      name: entry.name,
      settingsPath: `connectors/${entry.provider}/${entry.capability}`,
    }
    const mine = accounts.filter((a) => a.provider === entry.provider && a.capability === entry.capability)
    if (mine.length === 0) {
      return {
        ...base,
        group: 'available',
        cause: null,
        statusText: 'Not connected',
        detail: null,
        action: 'connect',
        loginHint: null,
      }
    }
    const causes = mine.map(accountCause)
    const cause = firstByPriority(causes)
    if (cause) {
      const culprit = mine[causes.indexOf(cause)]
      return {
        ...base,
        group: 'attention',
        cause,
        ...CAUSE_PRESENTATION[cause],
        // Lead with the account that needs the fix.
        detail: withMore(accountLabel(culprit), mine.length),
        loginHint: culprit.account_email || null,
      }
    }
    const lead = mine.find((a) => a.is_primary) ?? mine[0]
    return {
      ...base,
      group: 'connected',
      cause: null,
      statusText: 'Connected',
      detail: withMore(accountLabel(lead), mine.length),
      action: 'manage',
      loginHint: null,
    }
  })
}

function localExchangeRow(local: LocalCalendarStatus | null): ConnectionRow {
  const calendars = local?.exchangeCalendars ?? []
  const base = {
    key: `${LOCAL_EXCHANGE_ENTRY.provider}:${LOCAL_EXCHANGE_ENTRY.capability}`,
    kind: 'local' as const,
    provider: LOCAL_EXCHANGE_ENTRY.provider,
    capability: LOCAL_EXCHANGE_ENTRY.capability,
    name: LOCAL_EXCHANGE_ENTRY.name,
    cause: null,
    loginHint: null,
    settingsPath: 'connectors/local-exchange/calendar',
  }
  if (local?.hasAccess && calendars.length > 0) {
    const accountsNamed = new Set(calendars.map((c) => c.accountName).filter(Boolean))
    const [first] = accountsNamed
    return {
      ...base,
      group: 'connected',
      statusText: 'Connected',
      detail: withMore(first ?? null, Math.max(accountsNamed.size, 1)),
      action: 'manage',
    }
  }
  if (local?.hasAccess) {
    // Access granted but macOS Calendar has no Exchange account: nothing to
    // grant here, the detail page says where to add one.
    return { ...base, group: 'available', statusText: 'No Exchange accounts', detail: null, action: 'manage' }
  }
  return { ...base, group: 'available', statusText: 'Not connected', detail: null, action: 'connect' }
}

/**
 * Dial8's Slack app, for this person: connected once their own Slack account
 * is linked in a Slack workspace bound here (that's when they can message
 * their agent); until then something to add, but only when they can add it:
 * link their account in a Slack workspace already bound here, or (an admin)
 * add the app. No row where this deployment has no Slack app, before the
 * first read, or for someone whose Connect would only say "ask an admin".
 */
function slackRow(slack: SlackAppStatus | null): ConnectionRow | null {
  if (!slack?.configured) return null
  const base = {
    key: `${SLACK_APP_ENTRY.provider}:${SLACK_APP_ENTRY.capability}`,
    kind: 'app' as const,
    provider: SLACK_APP_ENTRY.provider,
    capability: SLACK_APP_ENTRY.capability,
    name: SLACK_APP_ENTRY.name,
    cause: null,
    loginHint: null,
    settingsPath: 'connectors/slack',
  }
  const installations = slack.installations ?? []
  const linked = installations.filter((i) => i.myLink)
  if (linked.length === 0) {
    const canAdd = slack.canLink === true && (installations.length > 0 || slack.canInstall === true)
    return canAdd ? { ...base, group: 'available', statusText: 'Not connected', detail: null, action: 'connect' } : null
  }
  const [lead] = linked
  const team = lead.teamName || lead.teamDomain || null
  const handle = lead.myLink?.slackUserName ? `@${lead.myLink.slackUserName}` : null
  const label = handle && team ? `${handle} · ${team}` : (handle ?? team)
  return { ...base, group: 'connected', statusText: 'Connected', detail: withMore(label, linked.length), action: 'manage' }
}

/**
 * Texting, for this person: connected once their phone is verified, until
 * then something to add. Both open Settings › Phone. No row where this
 * deployment has no texting, or before the first read.
 */
function phoneRow(phone: PhoneStatus | null): ConnectionRow | null {
  if (!phone?.available) return null
  const base = {
    key: `${TEXTING_ENTRY.provider}:${TEXTING_ENTRY.capability}`,
    kind: 'app' as const,
    provider: TEXTING_ENTRY.provider,
    capability: TEXTING_ENTRY.capability,
    name: TEXTING_ENTRY.name,
    cause: null,
    loginHint: null,
    settingsPath: 'phone',
  }
  if (!phone.phone) return { ...base, group: 'available', statusText: 'Not connected', detail: null, action: 'connect' }
  const detail = phone.phone.optedOut ? `${phone.phone.masked} · texts off (STOP)` : phone.phone.masked
  return { ...base, group: 'connected', statusText: 'Connected', detail, action: 'manage' }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * The catalog entry an added server is: the same HOST, as the approval policy
 * decides it (suggested.ts suggestedMcpServerFor), never the same name. A
 * self-hosted "GitLab" on gitlab.acme.com is a custom server, and Linear's
 * old /sse address is still Linear.
 */
function suggestionFor(
  server: McpServerRow,
  suggested: readonly SuggestedMcpServer[],
): SuggestedMcpServer | null {
  const host = hostnameOf(server.server_url)
  return (host && suggested.find((s) => hostnameOf(s.server_url) === host)) || null
}

function mcpRows(
  servers: McpServerRow[] | null,
  suggested: readonly SuggestedMcpServer[],
): ConnectionRow[] {
  const rows: ConnectionRow[] = []
  const added = new Set<string>()
  for (const server of servers ?? []) {
    const match = suggestionFor(server, suggested)
    if (match) added.add(match.id)
    const cause = mcpCause(server)
    rows.push({
      key: `mcp:${server.id}`,
      kind: 'mcp',
      provider: match?.id ?? 'mcp',
      capability: 'mcp',
      name: server.display_name,
      group: cause ? 'attention' : 'connected',
      cause,
      ...(cause
        ? CAUSE_PRESENTATION[cause]
        : // A connected app (an MCP server), never read as a second copy of an
          // OAuth connection of the same name (Linear's both, say).
          { statusText: server.is_enabled === false ? 'Connected app, off' : 'Connected app', action: 'manage' as const }),
      detail: hostOf(server.server_url),
      settingsPath: `connectors/mcp/${server.id}`,
      loginHint: null,
      mcp: { serverId: server.id, serverUrl: server.server_url, suggested: match, enabled: server.is_enabled !== false, ...(server.transport ? { transport: server.transport } : {}) },
    })
  }
  for (const s of suggested) {
    if (added.has(s.id)) continue
    rows.push({
      key: `mcp-suggested:${s.id}`,
      kind: 'mcp',
      provider: s.id,
      capability: 'mcp',
      name: s.display_name,
      group: 'available',
      cause: null,
      statusText: 'Not connected',
      detail: null,
      action: 'connect',
      settingsPath: 'connectors',
      loginHint: null,
      mcp: { serverId: null, serverUrl: s.server_url, suggested: s },
    })
  }
  return rows
}

export function groupConnections(input: {
  status: OAuthStatus | null
  mcpServers: McpServerRow[] | null
  suggested: readonly SuggestedMcpServer[]
  desktop: boolean
  localExchange: LocalCalendarStatus | null
  slack?: SlackAppStatus | null
  phone?: PhoneStatus | null
}): ConnectionGroups {
  // Catalog order, then local Exchange (desktop only), then Slack, then
  // Texting, then MCP: each group keeps that order because rows are bucketed
  // in one pass.
  const slack = slackRow(input.slack ?? null)
  const phone = phoneRow(input.phone ?? null)
  const all = [
    ...oauthRows(input.status),
    ...(input.desktop ? [localExchangeRow(input.localExchange)] : []),
    ...(slack ? [slack] : []),
    ...(phone ? [phone] : []),
    ...mcpRows(input.mcpServers, input.suggested),
  ]
  const groups: ConnectionGroups = { connected: [], attention: [], available: [] }
  for (const row of all) groups[row.group].push(row)
  return groups
}

export function needsAttention(groups: ConnectionGroups): boolean {
  return groups.attention.length > 0
}

/**
 * The side panel's order: what needs the person, then what they have, then
 * everything they could add (the longest group, so it goes last).
 */
export const PANEL_ORDER: readonly ConnectionGroup[] = ['attention', 'connected', 'available']

/**
 * The side panel's one list (connections-section.tsx): every connection, in
 * PANEL_ORDER, each group keeping its own order; the card scrolls it (Liam,
 * 10-22: "show all the available connections so you can scroll and see it
 * all"). Nothing folds or hides: an integration and the same service's MCP
 * server (Linear, Jira's Atlassian) are two connections, two rows, the MCP
 * one labelled in the card (as on Settings › Connectors: connector-directory.ts).
 */
export function panelRows(groups: ConnectionGroups): ConnectionRow[] {
  return PANEL_ORDER.flatMap((group) => groups[group])
}
