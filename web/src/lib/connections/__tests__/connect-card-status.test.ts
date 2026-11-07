/**
 * The Connect card's settle read (connect-card-status.ts), GEN-1171: an app
 * whose sign-in expired is not connected, so its card keeps Reconnect; once
 * the person reconnects (the mark cleared) it reads Connected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateConnectStatus, readConnectState } from '../connect-card-status'
import type { ConnectCard } from '../connect-card'

const card: ConnectCard = {
  kind: 'catalog_app',
  catalog_id: 'supabase',
  name: 'Supabase',
  description: '',
  domain: 'mcp.supabase.com',
  server_url: 'https://mcp.supabase.com/mcp',
  transport: 'streamable_http',
  status: 'needs_reconnect',
}
let servers: unknown[] = []

beforeEach(() => {
  invalidateConnectStatus()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ servers }), { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('readConnectState for an app', () => {
  it('an expired sign-in is not connected; reconnected, it is', async () => {
    servers = [{ server_url: 'https://mcp.supabase.com/mcp', reauth_required_at: '2026-10-27T04:00:00Z', tools_cache: [{ name: 'list_projects' }], allowed_tools: ['list_projects'] }]
    expect(await readConnectState(card)).toEqual({ connected: false, detail: null })
    invalidateConnectStatus()
    servers = [{ server_url: 'https://mcp.supabase.com/mcp', reauth_required_at: null, tools_cache: [{ name: 'list_projects' }], allowed_tools: ['list_projects'] }]
    expect(await readConnectState(card)).toEqual({ connected: true, detail: '1 tool' })
  })
})
