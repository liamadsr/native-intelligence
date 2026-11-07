/**
 * GEN-1171: which row a new sign-in renews (reconnect in place, never a
 * second row or a duplicate-name error), what counts as needing a reconnect,
 * and the once-per-expiry notice the mark sends.
 */
import { describe, it, expect, vi } from 'vitest'

const recorder = vi.hoisted(() => ({ record: vi.fn(async () => 1) }))
vi.mock('@/lib/agent-events/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-events/record')>()),
  recordAgentEvents: recorder.record,
}))

import { agentEventRow } from '@/lib/agent-events/record'
import { reconnectTarget } from '../reconnect'
import { mcpNeedsReconnect } from '../needs-reconnect'
import { recordMcpReconnectEvent } from '../expired-notice'
import { mcpReconnectInstruction } from '../adapter'

const marked = '2026-10-27T04:00:00.000Z'

describe('reconnectTarget', () => {
  const rows = [
    { id: 'sb', display_name: 'Supabase', server_url: 'https://mcp.supabase.com/mcp?read_only=true', reauth_required_at: null },
    { id: 'sb2', display_name: 'Supabase 2', server_url: 'https://mcp.supabase.com/mcp', reauth_required_at: marked },
    { id: 'acme', display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp/', reauth_required_at: marked },
  ]

  it('the same app under the same name (its slug): what every Reconnect sends', () => {
    expect(reconnectTarget(rows, { display_name: 'Supabase 2', server_url: 'https://mcp.supabase.com/mcp' })?.id).toBe('sb2')
    // A catalog app by its host: its own URL (a query the person set) still matches.
    expect(reconnectTarget(rows, { display_name: 'supabase', server_url: 'https://mcp.supabase.com/mcp?read_only=true' })?.id).toBe('sb')
    expect(reconnectTarget(rows, { display_name: 'Acme', server_url: 'https://MCP.acme.dev/mcp' })?.id).toBe('acme')
  })

  it('never a healthy second account: the name decides, not which row is expired', () => {
    expect(reconnectTarget(rows, { display_name: 'Supabase', server_url: 'https://mcp.supabase.com/mcp' })?.id).toBe('sb')
    expect(reconnectTarget(rows, { display_name: 'Supabase (client)', server_url: 'https://mcp.supabase.com/mcp' })).toBeNull()
  })

  it('never another server with the same name: a new row, refused by the slug index as before', () => {
    expect(reconnectTarget(rows, { display_name: 'Acme', server_url: 'https://mcp.acme.dev/v2/mcp' })).toBeNull()
    expect(reconnectTarget([], { display_name: 'Supabase', server_url: 'https://mcp.supabase.com/mcp' })).toBeNull()
  })
})

describe('mcpNeedsReconnect', () => {
  const expiredMessage = 'MCP server "X" needs to be reconnected — the OAuth token expired and could not be refreshed.'

  it('with the column (migration 451) the mark alone decides: an old expired message is not a mark', () => {
    expect(mcpNeedsReconnect({ reauth_required_at: marked })).toBe(true)
    expect(mcpNeedsReconnect({ reauth_required_at: null, last_error: expiredMessage })).toBe(false)
    expect(mcpNeedsReconnect({ reauth_required_at: null, last_error: 'tools/list timed out' })).toBe(false)
  })

  it('before migration 451 (no such key) the expired message stands in', () => {
    expect(mcpNeedsReconnect({ last_error: expiredMessage })).toBe(true)
    expect(mcpNeedsReconnect({ last_error: 'tools/list timed out' })).toBe(false)
    expect(mcpNeedsReconnect({})).toBe(false)
  })
})

describe('recordMcpReconnectEvent', () => {
  const server = { id: 'srv-1', user_id: 'u1', workspace_id: 'w1', display_name: 'my supabase', server_url: 'https://mcp.supabase.com/mcp', reauth_required_at: marked }

  it('one connection.needs_reconnect row per expiry: a catalog app named by Dial8, with its catalog id', async () => {
    recorder.record.mockClear()
    expect(await recordMcpReconnectEvent(server)).toBe(true)
    const [inputs] = recorder.record.mock.calls[0] as unknown as [Array<Record<string, unknown>>]
    expect(inputs).toEqual([
      expect.objectContaining({
        workspaceId: 'w1',
        userId: 'u1',
        kind: 'connection.needs_reconnect',
        refType: 'connected_mcp_server',
        refId: 'srv-1',
        occursAt: marked,
        facts: { title: 'Supabase', catalogId: 'supabase' },
        dedupeKey: `connection:srv-1:needs_reconnect:${Date.parse(marked)}`,
      }),
    ])
    // Each row is a valid one for the table.
    expect(agentEventRow(inputs[0] as never)).toMatchObject({ kind: 'connection.needs_reconnect', source: 'work' })
  })

  it('a custom app is named by the person’s own name, with no catalog id', async () => {
    recorder.record.mockClear()
    await recordMcpReconnectEvent({ ...server, display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp' })
    const [inputs] = recorder.record.mock.calls[0] as unknown as [Array<Record<string, unknown>>]
    expect(inputs[0].facts).toEqual({ title: 'Acme' })
  })

  it('skips a server with no workspace (no home thread to tell)', async () => {
    recorder.record.mockClear()
    expect(await recordMcpReconnectEvent({ ...server, workspace_id: null })).toBe(false)
    expect(recorder.record).not.toHaveBeenCalled()
  })
})

describe('mcpReconnectInstruction', () => {
  it('names the exact connect call: the catalog id, else the server URL', () => {
    expect(mcpReconnectInstruction({ display_name: 'Supabase', server_url: 'https://mcp.supabase.com/mcp' })).toMatch(/connect with catalog_id "supabase"/)
    expect(mcpReconnectInstruction({ display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp' })).toMatch(/connect with mcp_url "https:\/\/mcp\.acme\.dev\/mcp"/)
    expect(mcpReconnectInstruction({ display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp' })).toMatch(/no need to disconnect/)
  })
})
