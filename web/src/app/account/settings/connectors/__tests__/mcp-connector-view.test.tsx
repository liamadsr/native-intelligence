// @vitest-environment jsdom
/**
 * A connected app's page under Settings › Connectors (mcp-connector-view.tsx),
 * GEN-1171: an OAuth server whose sign-in expired says so plainly, with
 * Reconnect (the MCP OAuth flow again, under the server's own name, so the
 * callback renews this row in place); any other error stays the red box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../settings-shell', () => ({ useSettingsNavigate: () => vi.fn() }))
vi.mock('../../../(dashboard)/side-panels/connections-section', () => ({ RowIcon: () => null }))
const connect = vi.hoisted(() => ({ connectWithUrl: vi.fn(async (_key: string, start: () => Promise<string>) => void (await start())), connectingId: null as string | null }))
vi.mock('@/lib/integrations/use-connect-provider', () => ({
  useConnectProvider: () => ({ connect: vi.fn(), connectWithUrl: connect.connectWithUrl, connectingId: connect.connectingId }),
}))
const oauth = vi.hoisted(() => ({ start: vi.fn(async () => 'https://auth.example/authorize') }))
vi.mock('@/lib/integrations/start-mcp-oauth', () => ({ startMcpOAuth: oauth.start }))

const { McpConnectorView } = await import('../mcp-connector-view')

const ID = 'srv-1'
const server = (over: Record<string, unknown> = {}) => ({
  id: ID,
  display_name: 'My Supabase',
  server_url: 'https://mcp.supabase.com/mcp',
  transport: 'streamable_http',
  auth_type: 'oauth2',
  is_enabled: true,
  disabled_tools: [],
  require_approval_tools: [],
  approval_free_tools: [],
  allowed_tools: [],
  tools_cache: [],
  last_error: null,
  token_expires_at: null,
  created_at: '2026-10-27T04:00:00Z',
  ...over,
})
const net = { servers: [] as unknown[] }

let container: HTMLDivElement
let root: Root
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
async function render() {
  act(() => root.render(h(McpConnectorView, { id: ID })))
  await flush()
}
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined

beforeEach(() => {
  net.servers = []
  connect.connectWithUrl.mockClear()
  oauth.start.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ servers: net.servers }), { status: 200 })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('McpConnectorView', () => {
  it('an expired sign-in: a plain "Sign-in expired" box whose Reconnect signs in again under its own name', async () => {
    net.servers = [server({ reauth_required_at: '2026-10-27T04:00:00Z', last_error: 'MCP server "My Supabase" needs to be reconnected — the OAuth token expired and could not be refreshed.' })]
    await render()
    const box = container.querySelector('[data-mcp-reconnect]')
    expect(box?.textContent).toContain('Sign-in expired')
    expect(box?.textContent).toContain('your tool permissions stay as they are')
    expect(container.textContent).not.toContain('Disconnect it, then connect it again')
    await act(async () => button('Reconnect')!.click())
    expect(connect.connectWithUrl).toHaveBeenCalledWith(`mcp:${ID}`, expect.any(Function))
    // A catalog app signs in at the catalog's address, under the person's own name (the callback renews this row).
    expect(oauth.start).toHaveBeenCalledWith({ display_name: 'My Supabase', server_url: 'https://mcp.supabase.com/mcp', transport: 'streamable_http' })
  })

  it('a healthy server shows no box, and another error stays the red box with no Reconnect', async () => {
    net.servers = [server()]
    await render()
    expect(container.querySelector('[data-mcp-reconnect]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    net.servers = [server({ last_error: 'tools/list timed out' })]
    await render()
    expect(container.querySelector('[data-mcp-reconnect]')).toBeNull()
    expect(container.textContent).toContain('tools/list timed out')
    expect(button('Reconnect')).toBeUndefined()
  })
})
