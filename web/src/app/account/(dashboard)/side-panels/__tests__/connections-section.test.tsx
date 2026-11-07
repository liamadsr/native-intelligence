// @vitest-environment jsdom
/**
 * The side panel's Connectors card (connections-section.tsx):
 *
 *   • its row's summary (the row itself is the panel's: side-panels.test):
 *     "N to reconnect" in amber, else "N connected" muted, nothing while
 *     loading or with none connected;
 *   • every connection, in order: needs attention, then connected, then
 *     available; each an icon tile, the name and ONE action word that
 *     carries the state (Reconnect / Update access, Connect, Connected); no
 *     group headings, no subtitles;
 *   • condensed: the first 3 rows, then Show more opens the whole list in
 *     a box that scrolls inside the card (the card keeps its size) and reads
 *     Show less; Manage connectors opens Settings › Connectors;
 *   • Linear's OAuth integration and its MCP server are two rows, the MCP
 *     one labelled;
 *   • Connected opens Manage (Settings at the integration's own page);
 *   • Connect / Update access / Reconnect go through the one connect hook,
 *     started from the panel, the account as the login hint;
 *   • a catalog MCP app not added yet connects in one click; one that needs
 *     attention opens its own page, catalog or custom;
 *   • a connect returning re-reads the statuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectionRow } from '@/lib/integrations/connections'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hook = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  connectWithUrl: vi.fn(async (_key: string, _get: () => Promise<string | null>) => {}),
  connectingId: null as string | null,
  opts: null as null | { origin?: string; onReturn?: (r: unknown) => void },
}))
vi.mock('@/lib/integrations/use-connect-provider', () => ({
  useConnectProvider: (opts: typeof hook.opts) => {
    hook.opts = opts
    return { connect: hook.connect, connectWithUrl: hook.connectWithUrl, connectingId: hook.connectingId }
  },
}))
const startMcpOAuth = vi.hoisted(() => vi.fn(async () => 'https://mcp.example/authorize'))
vi.mock('@/lib/integrations/start-mcp-oauth', () => ({ startMcpOAuth }))
const openSettings = vi.hoisted(() => vi.fn())
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => ({ openSettings }) }))

const { ConnectionsSection, VISIBLE_ROWS, connectionsSummary } = await import('../connections-section')
const store = await import('../side-panel-store')

function conn(over: Partial<ConnectionRow>): ConnectionRow {
  return {
    key: 'google:email',
    kind: 'oauth',
    provider: 'google',
    capability: 'email',
    name: 'Gmail',
    group: 'connected',
    cause: null,
    statusText: 'Connected',
    detail: 'a@x.com',
    action: 'manage',
    settingsPath: 'connectors/google/email',
    loginHint: null,
    ...over,
  }
}
const SUGGESTED = { id: 'linear', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', transport: 'streamable_http' as const, description: '', accent: 'bg-blue-500/10', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } }
const ATLASSIAN = { id: 'atlassian', display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' as const, description: '', accent: 'bg-blue-500/10', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } }

const available = (key: string, name: string, provider = key.split(':')[0], capability = key.split(':')[1]) =>
  conn({ key, provider, capability, name, group: 'available', statusText: 'Not connected', detail: null, action: 'connect', settingsPath: `connectors/${provider}/${capability}` })

let container: HTMLDivElement
let root: Root
const refresh = vi.fn()
type Groups = { connected?: ConnectionRow[]; attention?: ConnectionRow[]; available?: ConnectionRow[] }
function render(groups: Groups, { loading = false } = {}) {
  const connections = {
    groups: { connected: groups.connected ?? [], attention: groups.attention ?? [], available: groups.available ?? [] },
    needsAttention: (groups.attention ?? []).length > 0,
    loading,
    refresh,
  }
  act(() => root.render(h(ConnectionsSection, { connections })))
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const more = () => q('[data-connections-more]') as HTMLButtonElement | null
const rowKeys = () => [...container.querySelectorAll('[data-connection]')].map((el) => el.getAttribute('data-connection'))

beforeEach(() => {
  window.localStorage.clear()
  store.resetSidePanelStore()
  hook.connect.mockClear()
  hook.connectWithUrl.mockClear()
  hook.connectingId = null
  openSettings.mockClear()
  refresh.mockClear()
  startMcpOAuth.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the Connectors card', () => {
  it('no heading of its own: the "Connectors" row is the panel’s', () => {
    render({ connected: [conn({})] })
    expect(q('[data-side-panel-section-toggle]')).toBeNull()
    expect(container.textContent).not.toContain('Connectors')
  })

  it('its row’s summary: "N to reconnect" in amber, else "N connected" muted; nothing while loading or with none connected', () => {
    const groups = (g: Groups) => ({ connected: g.connected ?? [], attention: g.attention ?? [], available: g.available ?? [] })
    const hubspot = conn({ key: 'hubspot:crm', provider: 'hubspot', capability: 'crm', name: 'HubSpot', group: 'attention', action: 'reconnect' })
    const calendar = conn({ key: 'google:calendar', capability: 'calendar', name: 'Calendar', group: 'attention', action: 'update' })
    expect(connectionsSummary({ groups: groups({ attention: [hubspot, calendar], connected: [conn({})] }), loading: false })).toEqual({
      text: '2 to reconnect',
      tone: 'attention',
    })
    expect(connectionsSummary({ groups: groups({ connected: [conn({})], available: [available('asana:tasks', 'Asana')] }), loading: false })).toEqual({
      text: '1 connected',
      tone: 'muted',
    })
    expect(connectionsSummary({ groups: groups({ available: [available('asana:tasks', 'Asana')] }), loading: false })).toBeNull()
    expect(connectionsSummary({ groups: groups({ attention: [hubspot] }), loading: true })).toBeNull()
    // Linear's OAuth integration and its MCP server are two connections.
    const linear = [
      conn({ key: 'linear:tasks', provider: 'linear', capability: 'tasks', name: 'Linear' }),
      conn({ key: 'mcp:s-1', kind: 'mcp', provider: 'linear', capability: 'mcp', name: 'Linear', mcp: { serverId: 's-1', serverUrl: SUGGESTED.server_url, suggested: SUGGESTED } }),
    ]
    expect(connectionsSummary({ groups: groups({ connected: linear }), loading: false })?.text).toBe('2 connected')
  })

  it('needs attention first, then connected, then available; no group headings, no subtitles', () => {
    render({
      connected: [conn({})],
      attention: [conn({ key: 'hubspot:crm', provider: 'hubspot', capability: 'crm', name: 'HubSpot', group: 'attention', cause: 'reauth', statusText: 'Reconnect', action: 'reconnect', detail: 'b@x.com', loginHint: 'b@x.com' })],
      available: [available('asana:tasks', 'Asana')],
    })
    expect(rowKeys()).toEqual(['hubspot:crm', 'google:email', 'asana:tasks'])
    expect(container.querySelector('h4')).toBeNull()
    expect(container.textContent).not.toMatch(/Needs attention|Available|a@x\.com|b@x\.com/)
    // Each row: its name and ONE action.
    const hubspot = q('[data-connection="hubspot:crm"]')!
    expect(hubspot.getAttribute('data-connection-cause')).toBe('reauth')
    expect(hubspot.querySelectorAll('button')).toHaveLength(1)
    expect(hubspot.querySelector('[data-connection-name]')!.textContent).toBe('HubSpot')
    expect(hubspot.querySelector('[data-connection-action]')!.textContent).toBe('Reconnect')
  })

  it('the action word carries the state: Reconnect / Update access in amber, Connect in the warm accent, a muted Connected', () => {
    render({
      attention: [
        conn({ key: 'hubspot:crm', provider: 'hubspot', capability: 'crm', name: 'HubSpot', group: 'attention', cause: 'reauth', action: 'reconnect' }),
        conn({ key: 'google:calendar', capability: 'calendar', name: 'Calendar', group: 'attention', cause: 'missing_scopes', action: 'update' }),
      ],
      available: [available('asana:tasks', 'Asana')],
      connected: [conn({})],
    })
    act(() => more()!.click())
    const action = (key: string) => q(`[data-connection="${key}"] [data-connection-action]`)!
    expect(action('hubspot:crm').textContent).toBe('Reconnect')
    expect(action('google:calendar').textContent).toBe('Update access')
    expect(action('asana:tasks').textContent).toBe('Connect')
    expect(action('google:email').textContent).toBe('Connected')
    expect(action('hubspot:crm').className).toContain('text-amber-700')
    expect(action('google:calendar').className).toContain('text-amber-700')
    expect(action('asana:tasks').className).toContain('text-foreground')
    expect(action('google:email').className).toContain('text-muted-foreground')
    expect(action('google:email').getAttribute('aria-label')).toBe('Manage Gmail')
  })

  it('condensed to the first 3 rows; Show more opens every connection in a box that scrolls inside the card, and reads Show less', () => {
    const keys = ['asana:tasks', 'jira:tasks', 'linear:tasks', 'hubspot:crm', 'github:github', 'microsoft:email', 'microsoft:calendar', 'google:calendar', 'local_exchange:calendar']
    render({ available: keys.map((k) => available(k, k)), connected: [conn({})] })
    expect(VISIBLE_ROWS).toBe(3)
    expect(rowKeys()).toEqual(['google:email', 'asana:tasks', 'jira:tasks'])
    expect(more()!.textContent).toBe('Show more')
    expect(more()!.getAttribute('aria-expanded')).toBe('false')
    act(() => more()!.click())
    expect(rowKeys()).toEqual(['google:email', ...keys])
    expect(more()!.textContent).toBe('Show less')
    expect(more()!.getAttribute('aria-expanded')).toBe('true')
    // Opened: the whole list in a bounded box that scrolls itself, so the panel doesn't have to.
    const list = q('#side-panel-connections-list')!
    expect(list.className).toMatch(/max-h-/)
    expect(list.className).toContain('overflow-y-auto')
    expect(list.className).toContain('overscroll-contain')
    act(() => more()!.click())
    expect(rowKeys()).toHaveLength(3)
    // Condensed: three rows, no scroll box.
    expect(q('#side-panel-connections-list')!.className).not.toMatch(/max-h-|overflow/)
  })

  it('no Show more at 3 rows or fewer', () => {
    render({ available: [available('asana:tasks', 'Asana'), available('jira:tasks', 'Jira')], connected: [conn({})] })
    expect(rowKeys()).toHaveLength(3)
    expect(more()).toBeNull()
  })

  it('Manage connectors opens Settings › Connectors', () => {
    render({ connected: [conn({})] })
    act(() => q('[data-connections-manage]')!.click())
    expect(openSettings).toHaveBeenCalledWith('connectors')
  })

  it('Linear’s OAuth integration and its MCP server are two rows, the MCP one labelled; an MCP app not added yet lists too', () => {
    render({
      connected: [
        conn({ key: 'linear:tasks', provider: 'linear', capability: 'tasks', name: 'Linear', settingsPath: 'connectors/linear/tasks' }),
        conn({ key: 'mcp:s-1', kind: 'mcp', provider: 'linear', capability: 'mcp', name: 'Linear', statusText: 'Connected app', detail: 'mcp.linear.app', settingsPath: 'connectors/mcp/s-1', mcp: { serverId: 's-1', serverUrl: SUGGESTED.server_url, suggested: SUGGESTED } }),
      ],
      available: [
        conn({ key: 'mcp-suggested:atlassian', kind: 'mcp', provider: 'atlassian', capability: 'mcp', name: 'Atlassian', group: 'available', action: 'connect', detail: null, settingsPath: 'connectors', mcp: { serverId: null, serverUrl: ATLASSIAN.server_url, suggested: ATLASSIAN } }),
      ],
    })
    expect(rowKeys()).toEqual(['linear:tasks', 'mcp:s-1', 'mcp-suggested:atlassian'])
    const kind = (key: string) => q(`[data-connection="${key}"] [data-connection-kind]`)?.textContent ?? null
    expect([kind('linear:tasks'), kind('mcp:s-1'), kind('mcp-suggested:atlassian')]).toEqual([null, 'MCP', 'MCP'])
    expect(q('[data-connection="mcp:s-1"] [data-connection-action]')!.getAttribute('aria-label')).toBe('Manage Linear (MCP)')
  })

  it('a catalog MCP app not added yet connects in one click through its own start endpoint', async () => {
    render({
      available: [conn({ key: 'mcp-suggested:atlassian', kind: 'mcp', provider: 'atlassian', capability: 'mcp', name: 'Atlassian', group: 'available', action: 'connect', settingsPath: 'connectors', mcp: { serverId: null, serverUrl: ATLASSIAN.server_url, suggested: ATLASSIAN } })],
    })
    act(() => q('[data-connection="mcp-suggested:atlassian"] button')!.click())
    expect(hook.connectWithUrl).toHaveBeenCalledWith('mcp-suggested:atlassian', expect.any(Function))
    await hook.connectWithUrl.mock.calls[0][1]()
    expect(startMcpOAuth).toHaveBeenCalledWith(ATLASSIAN)
  })

  it('an added app whose sign-in expired reconnects as itself: its own name and URL, so its row is renewed in place (GEN-1171)', async () => {
    const own = 'https://mcp.atlassian.com/v1/mcp'
    render({
      attention: [conn({ key: 'mcp:srv-9', kind: 'mcp', provider: 'atlassian', capability: 'mcp', name: 'Atlassian (work)', group: 'attention', cause: 'mcp_expired', statusText: 'Reconnect', action: 'reconnect', settingsPath: 'connectors/mcp/srv-9', mcp: { serverId: 'srv-9', serverUrl: own, suggested: ATLASSIAN, enabled: true, transport: 'streamable_http' } })],
    })
    act(() => q('[data-connection="mcp:srv-9"] button')!.click())
    await hook.connectWithUrl.mock.calls[0][1]()
    expect(startMcpOAuth).toHaveBeenCalledWith({ display_name: 'Atlassian (work)', server_url: own, transport: 'streamable_http' })
  })

  it('Connected opens Manage: Settings at the integration’s own page', () => {
    render({ connected: [conn({})] })
    act(() => q('[data-connection-action="manage"]')!.click())
    expect(openSettings).toHaveBeenCalledWith('connectors/google/email')
    expect(hook.connect).not.toHaveBeenCalled()
  })

  it('Connect goes through the one connect hook, started from the panel', () => {
    render({ available: [available('asana:tasks', 'Asana')] })
    expect(hook.opts?.origin).toBe('panel')
    act(() => q('[data-connection-action="connect"]')!.click())
    expect(hook.connect).toHaveBeenCalledWith('asana', 'tasks', undefined)
  })

  it('Update access and Reconnect connect that account again (its login hint)', () => {
    render({
      attention: [
        conn({ key: 'google:calendar', capability: 'calendar', group: 'attention', cause: 'missing_scopes', action: 'update', loginHint: 'a@x.com' }),
        conn({ key: 'hubspot:crm', provider: 'hubspot', capability: 'crm', group: 'attention', cause: 'reauth', action: 'reconnect', loginHint: 'b@x.com' }),
      ],
    })
    act(() => q('[data-connection="google:calendar"] button')!.click())
    act(() => q('[data-connection="hubspot:crm"] button')!.click())
    expect(hook.connect.mock.calls).toEqual([
      ['google', 'calendar', { loginHint: 'a@x.com' }],
      ['hubspot', 'crm', { loginHint: 'b@x.com' }],
    ])
  })

  it('an MCP app that needs attention opens its own page (it can’t be re-authorised in place), catalog or custom', () => {
    render({
      attention: [
        conn({ key: 'mcp:a-1', kind: 'mcp', provider: 'atlassian', capability: 'mcp', name: 'Atlassian', group: 'attention', cause: 'mcp_expired', action: 'manage', settingsPath: 'connectors/mcp/a-1', mcp: { serverId: 'a-1', serverUrl: ATLASSIAN.server_url, suggested: ATLASSIAN } }),
        conn({ key: 'mcp:s-1', kind: 'mcp', provider: 'mcp', capability: 'mcp', name: 'Custom', group: 'attention', cause: 'mcp_error', action: 'reconnect', settingsPath: 'connectors/mcp/s-1', mcp: { serverId: 's-1', serverUrl: 'https://x', suggested: null } }),
      ],
    })
    act(() => q('[data-connection="mcp:a-1"] button')!.click())
    act(() => q('[data-connection="mcp:s-1"] button')!.click())
    expect(openSettings.mock.calls).toEqual([['connectors/mcp/a-1'], ['connectors/mcp/s-1']])
    expect(hook.connectWithUrl).not.toHaveBeenCalled()
    expect(startMcpOAuth).not.toHaveBeenCalled()
  })

  it('a connect returning re-reads the statuses', () => {
    render({ available: [available('asana:tasks', 'Asana')] })
    act(() => hook.opts!.onReturn!({ provider: 'asana', capability: 'tasks', success: true, via: 'reported' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('the row connecting now is busy', () => {
    hook.connectingId = 'asana-tasks'
    render({ available: [available('asana:tasks', 'Asana')] })
    const button = q('[data-connection="asana:tasks"] button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
  })

  it('before the first read: a quiet line, not a list of Connects', () => {
    render({ available: [available('asana:tasks', 'Asana')] }, { loading: true })
    expect(container.textContent).toContain('Checking your connections')
    expect(rowKeys()).toEqual([])
  })
})
