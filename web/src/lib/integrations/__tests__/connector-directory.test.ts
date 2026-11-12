/**
 * Settings › Connectors' lists (connector-directory.ts): what's yours, what
 * Discover offers, and that an integration and the same service's MCP server
 * stay two rows.
 */
import { describe, it, expect } from 'vitest'
import { groupConnections, type McpServerRow } from '../connections'
import {
  categoriesIn,
  connectorCategory,
  connectorDescription,
  connectorKindLabel,
  connectorStatus,
  discoverConnectors,
  hasBothKinds,
  yourConnectors,
} from '../connector-directory'
import { getIntegration } from '../catalog'
import type { ConnectedAccount } from '../oauth-status'
import type { SuggestedMcpServer } from '@/lib/mcp-client/suggested'

const SUGGESTED: SuggestedMcpServer[] = [
  { id: 'atlassian', display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', description: 'Jira issues and Confluence pages', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
  { id: 'linear', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', transport: 'streamable_http', description: 'Issues, projects, and cycles', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
]

function account(provider: ConnectedAccount['provider'], capability: ConnectedAccount['capability'], over: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: `${provider}-${capability}`,
    provider,
    capability,
    account_email: 'a@x.com',
    display_name: null,
    color: '#000',
    is_enabled: true,
    is_primary: true,
    is_visible: true,
    scopes: ['granted'],
    missing_scopes: [],
    reauth_required_at: null,
    ...over,
  }
}

function server(over: Partial<McpServerRow> = {}): McpServerRow {
  return { id: 'srv1', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', is_enabled: true, last_error: null, ...over }
}

function groups(accounts: ConnectedAccount[] = [], servers: McpServerRow[] | null = null) {
  return groupConnections({ status: { accounts }, mcpServers: servers, suggested: SUGGESTED, desktop: false, localExchange: null })
}

describe('integrations and MCP servers stay apart', () => {
  it('a connected Linear integration and a connected Linear MCP server are two of your connectors', () => {
    const yours = yourConnectors(groups([account('linear', 'tasks')], [server()]))
    const linear = yours.filter((r) => r.name === 'Linear')
    expect(linear.map((r) => [r.key, r.kind, connectorKindLabel(r)])).toEqual([
      ['linear:tasks', 'oauth', null],
      ['mcp:srv1', 'mcp', 'MCP'],
    ])
  })

  it('with neither connected, Discover offers both: the Linear integration and the Linear MCP server', () => {
    const rows = discoverConnectors(groups())
    expect(rows.filter((r) => r.name === 'Linear').map((r) => r.key)).toEqual(['linear:tasks', 'mcp-suggested:linear'])
    // Jira's integration and Atlassian's MCP server too.
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(['jira:tasks', 'mcp-suggested:atlassian']))
  })

  it('connecting one leaves the other in Discover', () => {
    const g = groups([account('linear', 'tasks')])
    expect(yourConnectors(g).map((r) => r.key)).toContain('linear:tasks')
    expect(discoverConnectors(g).map((r) => r.key)).toContain('mcp-suggested:linear')
  })
})

describe('your connectors', () => {
  it('needs-you first, then the connected, each in its own order', () => {
    const g = groups([account('google', 'email'), account('hubspot', 'crm', { reauth_required_at: '2026-10-01T00:00:00Z' })])
    expect(yourConnectors(g).map((r) => r.key)).toEqual(['hubspot:crm', 'google:email'])
  })

  it('says Connected, Off for an MCP server switched off, and keeps a problem’s own word', () => {
    const g = groups([], [server(), server({ id: 'off', display_name: 'Atlassian', server_url: SUGGESTED[0].server_url, is_enabled: false }), server({ id: 'bad', display_name: 'Custom', server_url: 'https://x.example/mcp', last_error: 'ECONNREFUSED' })])
    const byKey = Object.fromEntries(yourConnectors(g).map((r) => [r.key, connectorStatus(r)]))
    expect(byKey).toEqual({ 'mcp:bad': 'Error', 'mcp:srv1': 'Connected', 'mcp:off': 'Off' })
  })
})

describe('discover', () => {
  it('filters by kind', () => {
    const g = groups()
    expect(discoverConnectors(g, { kind: 'mcp' }).every((r) => r.kind === 'mcp')).toBe(true)
    expect(discoverConnectors(g, { kind: 'integrations' }).some((r) => r.kind === 'mcp')).toBe(false)
    expect(discoverConnectors(g, { kind: 'all' })).toHaveLength(g.available.length)
  })

  it('searches the name, the description and the MCP label, ignoring case', () => {
    const g = groups()
    expect(discoverConnectors(g, { query: 'confluence' }).map((r) => r.key)).toEqual(['mcp-suggested:atlassian'])
    expect(discoverConnectors(g, { query: 'GMAIL' }).map((r) => r.key)).toEqual(['google:email'])
    expect(discoverConnectors(g, { query: 'mcp' }).every((r) => r.kind === 'mcp')).toBe(true)
    expect(discoverConnectors(g, { query: 'linear', kind: 'mcp' }).map((r) => r.key)).toEqual(['mcp-suggested:linear'])
    expect(discoverConnectors(g, { query: 'nothing like this' })).toEqual([])
  })

  it('offers the kind filter only when both kinds are there', () => {
    const g = groups()
    expect(hasBothKinds(g.available)).toBe(true)
    expect(hasBothKinds(g.available.filter((r) => r.kind !== 'mcp'))).toBe(false)
  })
})

describe('labels and descriptions', () => {
  it('a catalog MCP server reads MCP, one added by URL Custom MCP, an integration nothing', () => {
    const g = groups([account('google', 'email')], [server(), server({ id: 'c', display_name: 'Internal', server_url: 'https://mcp.internal.example/' })])
    const label = (key: string) => connectorKindLabel(yourConnectors(g).find((r) => r.key === key)!)
    expect([label('mcp:srv1'), label('mcp:c'), label('google:email')]).toEqual(['MCP', 'Custom MCP', null])
  })

  it('describes each from its own catalog', () => {
    const g = groups()
    const rows = discoverConnectors(g)
    expect(connectorDescription(rows.find((r) => r.key === 'linear:tasks')!)).toBe(getIntegration('linear', 'tasks')!.description)
    expect(connectorDescription(rows.find((r) => r.key === 'mcp-suggested:linear')!)).toBe('Issues, projects, and cycles')
  })
})

describe('categories', () => {
  it('an integration takes its category from what it connects; a catalog MCP server carries its own', () => {
    const rows = discoverConnectors(groups())
    const cat = (key: string) => connectorCategory(rows.find((r) => r.key === key)!)
    expect([cat('google:email'), cat('google:calendar'), cat('linear:tasks'), cat('hubspot:crm'), cat('github:github')]).toEqual([
      'calendar',
      'calendar',
      'projects',
      'sales',
      'engineering',
    ])
    expect(cat('mcp-suggested:linear')).toBe('projects')
  })

  it('a server added by URL has none', () => {
    const g = groups([], [server({ id: 'c', display_name: 'Internal', server_url: 'https://mcp.internal.example/' })])
    expect(connectorCategory(yourConnectors(g).find((r) => r.key === 'mcp:c')!)).toBeNull()
  })

  it('lists the categories present, in Discover’s order, and filters by one', () => {
    const g = groups()
    expect(categoriesIn(discoverConnectors(g))).toEqual(['projects', 'calendar', 'sales', 'engineering', 'sites'])
    const sales = discoverConnectors(g, { category: 'sales' })
    expect(sales.map((r) => r.key)).toEqual(['google:contacts', 'hubspot:crm', 'brevo:contacts'])
    expect(discoverConnectors(g, { category: 'projects', kind: 'mcp' }).map((r) => r.key)).toEqual([
      'mcp-suggested:atlassian',
      'mcp-suggested:linear',
    ])
  })

  it('search matches a category’s name', () => {
    expect(discoverConnectors(groups(), { query: 'calendar & email' }).map((r) => r.key)).toEqual(
      expect.arrayContaining(['google:calendar', 'google:email', 'microsoft:calendar', 'microsoft:email']),
    )
  })
})
