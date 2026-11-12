/**
 * Settings › Connectors (connectors-view.tsx): the two lists Claude's own
 * Connectors page has, "Your connectors" and "Discover", built from the same
 * rows as the side panel's card (connections.ts groupConnections).
 *
 * Unlike the panel (panelRows), nothing folds here: an integration and the
 * same service's MCP server are two different things (Liam, 10-22: "linear
 * and jira are integrations and MCPs, we don't want to lose that"). The
 * Linear integration pushes action items and keeps their state in sync; the
 * Linear MCP server gives the agent Linear's own tools. Each is its own row,
 * connected and managed on its own, and an MCP row carries a label saying so.
 *
 * Pure (no React, no fetch): every rule is a plain test case.
 */

import { getIntegration, LOCAL_EXCHANGE_ENTRY, SLACK_APP_ENTRY, TEXTING_ENTRY } from './catalog'
import { CONNECTOR_CATEGORIES, connectorCategoryLabel, type ConnectorCategory } from './connector-categories'
import type { ConnectionGroups, ConnectionRow } from './connections'

/** Discover's filter: every connector, the integrations, or the MCP servers. */
export type ConnectorKindFilter = 'all' | 'integrations' | 'mcp'

export const CONNECTOR_KIND_FILTERS: readonly { id: ConnectorKindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'mcp', label: 'MCP servers' },
]

/** What's connected: what needs the person first, then the rest, each group in its own order. */
export function yourConnectors(groups: ConnectionGroups): ConnectionRow[] {
  return [...groups.attention, ...groups.connected]
}

/**
 * The label beside an MCP row's name: "MCP" for a catalog server, "Custom MCP"
 * for one added by URL (Claude's "Custom"). An integration has none.
 */
export function connectorKindLabel(row: Pick<ConnectionRow, 'kind' | 'mcp'>): string | null {
  if (row.kind !== 'mcp') return null
  return row.mcp?.suggested ? 'MCP' : 'Custom MCP'
}

/** One line on what the connector does: the catalog's own description. */
export function connectorDescription(row: Pick<ConnectionRow, 'kind' | 'provider' | 'capability' | 'mcp'>): string | null {
  if (row.kind === 'mcp') return row.mcp?.suggested?.description ?? null
  if (row.kind === 'local') return LOCAL_EXCHANGE_ENTRY.description
  if (row.kind === 'app') return row.provider === TEXTING_ENTRY.provider ? TEXTING_ENTRY.description : SLACK_APP_ENTRY.description
  return getIntegration(row.provider, row.capability)?.description ?? null
}

/**
 * The one status word a connected row shows on the page: Connected, or Off
 * for an MCP server switched off (the panel's "Connected app", said plainly
 * where the MCP label already names the kind). Anything else keeps its own
 * status (Sync error, Error, Expired, Reconnect…).
 */
export function connectorStatus(row: Pick<ConnectionRow, 'group' | 'statusText' | 'mcp'>): string {
  if (row.group !== 'connected') return row.statusText
  return row.mcp?.enabled === false ? 'Off' : 'Connected'
}

/** An integration's category, by what it connects. */
const CAPABILITY_CATEGORY: Record<string, ConnectorCategory> = {
  calendar: 'calendar',
  email: 'calendar',
  tasks: 'projects',
  crm: 'sales',
  // Google Contacts: the people a business sells to (roadmap track G2).
  contacts: 'sales',
  // Google Search Console and Google Analytics: how the business's website does (the SEO area).
  search_console: 'sites',
  analytics: 'sites',
  github: 'engineering',
  messaging: 'messaging',
}

/**
 * The row's Discover category: a catalog MCP server's own, an integration's
 * by its capability; none for a server added by URL (it shows under All).
 */
export function connectorCategory(row: Pick<ConnectionRow, 'kind' | 'capability' | 'mcp'>): ConnectorCategory | null {
  if (row.kind === 'mcp') return row.mcp?.suggested?.category ?? null
  return CAPABILITY_CATEGORY[row.capability] ?? null
}

/** The categories these rows fall in, in Discover's order. */
export function categoriesIn(rows: readonly ConnectionRow[]): ConnectorCategory[] {
  const present = new Set(rows.map(connectorCategory))
  return CONNECTOR_CATEGORIES.map((c) => c.id).filter((id) => present.has(id))
}

function matchesKind(row: ConnectionRow, kind: ConnectorKindFilter): boolean {
  if (kind === 'all') return true
  return kind === 'mcp' ? row.kind === 'mcp' : row.kind !== 'mcp'
}

function matchesQuery(row: ConnectionRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const category = connectorCategory(row)
  return [row.name, connectorDescription(row), connectorKindLabel(row), category && connectorCategoryLabel(category)].some(
    (text) => text?.toLowerCase().includes(q),
  )
}

/** What could be added, narrowed by Discover's search, kind filter and category. */
export function discoverConnectors(
  groups: ConnectionGroups,
  {
    query = '',
    kind = 'all',
    category = null,
  }: { query?: string; kind?: ConnectorKindFilter; category?: ConnectorCategory | null } = {},
): ConnectionRow[] {
  return groups.available.filter(
    (row) => matchesKind(row, kind) && (!category || connectorCategory(row) === category) && matchesQuery(row, query),
  )
}

/** Discover's kind filter is worth showing only when both kinds are there to choose between. */
export function hasBothKinds(rows: readonly ConnectionRow[]): boolean {
  return rows.some((r) => r.kind === 'mcp') && rows.some((r) => r.kind !== 'mcp')
}
