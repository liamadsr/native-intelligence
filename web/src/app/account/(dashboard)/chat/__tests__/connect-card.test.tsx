// @vitest-environment jsdom
/**
 * The chat's Connect card (connect, F2): the Connectors panel's row in a
 * card. Its tap is the one connect flow (integration: the provider's
 * authorize route; catalog app: the MCP start route), started as 'panel'; a
 * URL server shows its domain and tools first; the flow's return re-reads the
 * connection, settles the card and leaves a note for the agent's next turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hook = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  connectWithUrl: vi.fn(async (_key: string, _get: () => Promise<string | null>) => {}),
  opts: null as null | { origin?: string; onReturn?: (r: unknown) => void },
}))
vi.mock('@/lib/integrations/use-connect-provider', () => ({
  useConnectProvider: (opts: typeof hook.opts) => {
    hook.opts = opts
    return { connect: hook.connect, connectWithUrl: hook.connectWithUrl, connectingId: null }
  },
}))
const startMcpOAuth = vi.hoisted(() => vi.fn(async () => 'https://mcp.example/authorize'))
vi.mock('@/lib/integrations/start-mcp-oauth', () => ({ startMcpOAuth }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
const state = vi.hoisted(() => ({ connected: false }))
vi.mock('@/lib/connections/connect-card-status', () => ({
  invalidateConnectStatus: vi.fn(),
  readConnectState: vi.fn(async () => (state.connected ? { connected: true, detail: 'me@x.com' } : { connected: false, detail: null })),
}))

const { ConnectCard } = await import('../connect-card')
const notes = await import('@/lib/connections/connect-card')

let container: HTMLDivElement
let root: Root
async function render(card: Parameters<typeof ConnectCard>[0]['card']) {
  await act(async () => {
    root.render(h(ConnectCard, { card }))
  })
}
const button = () => container.querySelector('button') as HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  hook.connect.mockClear()
  hook.connectWithUrl.mockClear()
  state.connected = false
  notes.clearConnectionNotes()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ConnectCard', () => {
  it('an integration: Connect runs the panel connect flow, and its return settles the card and leaves a note', async () => {
    await render({ kind: 'integration', provider: 'google', capability: 'calendar', name: 'Calendar', description: 'Schedule and manage calendar events', status: 'available' })
    expect(button().textContent).toBe('Connect')
    expect(hook.opts?.origin).toBe('panel')
    await act(async () => button().click())
    expect(hook.connect).toHaveBeenCalledWith('google', 'calendar', undefined)
    state.connected = true
    await act(async () => hook.opts?.onReturn?.({ success: true }))
    expect(container.querySelector('[data-connect-state="connected"]')).not.toBeNull()
    expect(container.textContent).toContain('me@x.com')
    expect(notes.pendingConnectionNotes()).toEqual([{ name: 'Calendar', outcome: 'connected', detail: 'me@x.com' }])
  })

  it('a reconnect passes the account as the login hint; a failed return says so and offers Try again', async () => {
    await render({ kind: 'integration', provider: 'google', capability: 'email', name: 'Gmail', description: '', status: 'needs_reconnect', account: 'me@x.com' })
    expect(button().textContent).toBe('Reconnect')
    await act(async () => button().click())
    expect(hook.connect).toHaveBeenCalledWith('google', 'email', { loginHint: 'me@x.com' })
    await act(async () => hook.opts?.onReturn?.({ success: false, error: 'access_denied' }))
    expect(button().textContent).toBe('Try again')
    expect(container.textContent).toContain("Didn't connect: access_denied")
    expect(notes.pendingConnectionNotes()[0]).toMatchObject({ outcome: 'not_connected', detail: 'access_denied' })
  })

  it('a catalog app starts its MCP sign-in', async () => {
    await render({ kind: 'catalog_app', catalog_id: 'atlassian', name: 'Atlassian', description: 'Jira issues and Confluence pages', domain: 'mcp.atlassian.com', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', status: 'available' })
    await act(async () => button().click())
    expect(hook.connectWithUrl).toHaveBeenCalledTimes(1)
    await hook.connectWithUrl.mock.calls[0][1]()
    expect(startMcpOAuth).toHaveBeenCalledWith({ display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' })
  })

  it('an expired catalog app reconnects as the person’s own row: its name and its own URL (GEN-1171)', async () => {
    const own = 'https://mcp.supabase.com/mcp?read_only=true'
    await render({ kind: 'catalog_app', catalog_id: 'supabase', name: 'Supabase 2', description: '', domain: 'mcp.supabase.com', server_url: own, transport: 'streamable_http', status: 'needs_reconnect' })
    expect(button().textContent).toContain('Reconnect')
    await act(async () => button().click())
    await hook.connectWithUrl.mock.calls[0][1]()
    expect(startMcpOAuth).toHaveBeenCalledWith({ display_name: 'Supabase 2', server_url: own, transport: 'streamable_http' })
  })

  it('a URL server shows its domain and tools before Authorize', async () => {
    await render({
      kind: 'url_app',
      name: 'Deepwiki',
      domain: 'mcp.deepwiki.com',
      server_url: 'https://mcp.deepwiki.com/mcp',
      transport: 'streamable_http',
      auth: 'oauth',
      tools: [
        { name: 'search_docs', access: 'read_only' },
        { name: 'delete_page', access: 'ask' },
      ],
      status: 'available',
    })
    expect(button().textContent).toBe('Authorize')
    const details = container.querySelector('[data-connect-details]')!
    expect(details.textContent).toContain("mcp.deepwiki.com isn't in Native Intelligence's catalog")
    expect(details.textContent).toContain('delete_pageAsks first')
    expect(details.textContent).toContain('search_docsReads')
  })
})
