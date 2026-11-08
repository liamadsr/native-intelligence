// @vitest-environment jsdom
/**
 * Settings › Connectors (connectors-view.tsx), over the real list model
 * (groupConnections + connector-directory):
 *
 *   • an integration and the same service's MCP server are two rows, both in
 *     Your connectors and both in Discover, the MCP one labelled;
 *   • a row opens the connector's own page; Discover's Connect runs the same
 *     connect as the side panel;
 *   • the Integrations / MCP servers filter narrows Discover, and lets go
 *     once only one kind is left to add; unfiltered, Discover sits under
 *     category headings, and a category chip narrows it to one;
 *   • with nothing connected there is no Your connectors section;
 *   • Native Intelligence's Slack app opens its own page, to add or to manage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { groupConnections, type ConnectionGroups, type McpServerRow, type SlackAppStatus } from '@/lib/integrations/connections'
import type { ConnectedAccount } from '@/lib/integrations/oauth-status'
import type { SuggestedMcpServer } from '@/lib/mcp-client/suggested'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ groups: null as ConnectionGroups | null }))
vi.mock('@/lib/integrations/use-connections', () => ({
  useConnections: () => ({ groups: state.groups!, needsAttention: false, loading: false, refresh: vi.fn() }),
}))
const hook = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  connectWithUrl: vi.fn(async () => {}),
}))
vi.mock('@/lib/integrations/use-connect-provider', () => ({
  useConnectProvider: () => ({ connect: hook.connect, connectWithUrl: hook.connectWithUrl, connectingId: null }),
}))
vi.mock('@/lib/integrations/start-mcp-oauth', () => ({ startMcpOAuth: vi.fn(async () => null) }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../../settings-shell', () => ({ useSettingsNavigate: () => navigate }))
vi.mock('../../../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))

const { ConnectorsView } = await import('../connectors-view')

const SUGGESTED: SuggestedMcpServer[] = [
  { id: 'atlassian', display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', description: 'Jira issues and Confluence pages', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
  { id: 'linear', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', transport: 'streamable_http', description: 'Issues, projects, and cycles', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
]

function account(provider: ConnectedAccount['provider'], capability: ConnectedAccount['capability']): ConnectedAccount {
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
  }
}
const LINEAR_MCP: McpServerRow = { id: 'srv1', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', is_enabled: true, last_error: null }

let container: HTMLDivElement
let root: Root
function render(accounts: ConnectedAccount[] = [], servers: McpServerRow[] = [], slack: SlackAppStatus | null = null) {
  state.groups = groupConnections({ status: { accounts }, mcpServers: servers, suggested: SUGGESTED, desktop: false, localExchange: null, slack })
  act(() => root.render(h(ConnectorsView)))
}
const section = (id: string) => container.querySelector(`section[aria-labelledby="${id}"]`)
const keysIn = (id: string) => [...(section(id)?.querySelectorAll('[data-connector]') ?? [])].map((el) => el.getAttribute('data-connector'))
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name) as HTMLButtonElement | undefined

beforeEach(() => {
  hook.connect.mockClear()
  hook.connectWithUrl.mockClear()
  navigate.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('integrations and MCP servers are separate connectors', () => {
  it('a connected Linear integration and Linear MCP server are both yours, the MCP one labelled', () => {
    render([account('linear', 'tasks')], [LINEAR_MCP])
    expect(keysIn('your-connectors')).toEqual(['linear:tasks', 'mcp:srv1'])
    const mcpRow = section('your-connectors')!.querySelector('[data-connector="mcp:srv1"]')!
    expect(mcpRow.textContent).toContain('MCP')
    expect(button('Manage Linear')).toBeDefined()
    expect(button('Manage Linear (MCP)')).toBeDefined()
  })

  it('with neither connected, Discover offers both, and Jira beside Atlassian’s MCP server', () => {
    render()
    expect(section('your-connectors')).toBeNull()
    expect(keysIn('discover-connectors')).toEqual(
      expect.arrayContaining(['linear:tasks', 'mcp-suggested:linear', 'jira:tasks', 'mcp-suggested:atlassian']),
    )
  })
})

describe('actions', () => {
  it('a row opens its own page; an MCP server’s is under connectors/mcp', () => {
    render([account('linear', 'tasks')], [LINEAR_MCP])
    act(() => button('Manage Linear (MCP)')!.click())
    act(() => button('Manage Linear')!.click())
    expect(navigate.mock.calls).toEqual([['/account/settings/connectors/mcp/srv1'], ['/account/settings/connectors/linear/tasks']])
  })

  it('Discover connects an integration with its provider, an MCP server through its start endpoint', () => {
    render()
    act(() => button('Connect Linear')!.click())
    act(() => button('Connect Linear (MCP)')!.click())
    expect(hook.connect).toHaveBeenCalledWith('linear', 'tasks', undefined)
    expect(hook.connectWithUrl).toHaveBeenCalledWith('mcp-suggested:linear', expect.any(Function))
  })

  it('Slack’s Connect and its connected row both open its page: adding it takes steps there', () => {
    render([], [], { configured: true, canInstall: true, canLink: true, installations: [] })
    act(() => button('Connect Slack')!.click())
    render([], [], { configured: true, installations: [{ teamId: 'T1', teamName: 'Acme', teamDomain: 'acme', myLink: { slackUserName: 'liam' } }] })
    expect(keysIn('your-connectors')).toEqual(['slack:messaging'])
    act(() => button('Manage Slack')!.click())
    expect(navigate.mock.calls).toEqual([['/account/settings/connectors/slack'], ['/account/settings/connectors/slack']])
    expect(hook.connect).not.toHaveBeenCalled()
  })

  it('the MCP servers filter narrows Discover to MCP servers', () => {
    render()
    act(() => button('MCP servers')!.click())
    expect(keysIn('discover-connectors')).toEqual(['mcp-suggested:atlassian', 'mcp-suggested:linear'])
    expect(button('MCP servers')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('unfiltered, Discover groups its cards under category headings; a category chip narrows to one', () => {
    render()
    const headings = [...container.querySelectorAll('[data-discover-category] h3')].map((el) => el.textContent)
    expect(headings).toEqual(['Projects & docs', 'Calendar & email', 'Sales & marketing', 'Engineering & data'])
    act(() => button('Sales & marketing')!.click())
    expect(container.querySelector('[data-discover-category]')).toBeNull()
    expect(keysIn('discover-connectors')).toEqual(['google:contacts', 'hubspot:crm', 'brevo:contacts'])
    expect(button('Sales & marketing')!.getAttribute('aria-pressed')).toBe('true')
    act(() => button('All categories')!.click())
    expect(container.querySelectorAll('[data-discover-category]').length).toBe(4)
  })

  it('once every MCP server is connected the filter goes, and Discover shows the integrations again', () => {
    render()
    act(() => button('MCP servers')!.click())
    render([], [LINEAR_MCP, { id: 'srv2', display_name: 'Atlassian', server_url: SUGGESTED[0].server_url, is_enabled: true, last_error: null }])
    expect(button('MCP servers')).toBeUndefined()
    expect(keysIn('discover-connectors')).toEqual(expect.arrayContaining(['linear:tasks', 'jira:tasks']))
  })
})
