/**
 * Settings › Connectors' Discover categories (Claude's directory has them
 * too): one per connector, integrations (by capability, connector-directory.ts)
 * and catalog MCP servers (`category` in mcp-client/suggested.ts) alike.
 * Listed in the order Discover shows them.
 *
 * Plain data, no imports: the MCP catalog and the list model both read it.
 */

export const CONNECTOR_CATEGORIES = [
  { id: 'projects', label: 'Projects & docs' },
  { id: 'calendar', label: 'Calendar & email' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'meetings', label: 'Meetings & knowledge' },
  { id: 'sales', label: 'Sales & marketing' },
  { id: 'engineering', label: 'Engineering & data' },
  { id: 'sites', label: 'Content & sites' },
  { id: 'automation', label: 'Automation' },
] as const

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number]['id']

export function connectorCategoryLabel(id: ConnectorCategory): string {
  return CONNECTOR_CATEGORIES.find((c) => c.id === id)?.label ?? id
}
