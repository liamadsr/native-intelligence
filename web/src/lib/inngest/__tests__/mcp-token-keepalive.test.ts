/**
 * GEN-1171: the hourly keep-alive renews connected apps' sign-ins before
 * they expire, through the one refresh path; counts what it renewed, what
 * needs the person and what failed for now; skips marked ones.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'

const refresh = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock('@/lib/mcp-client/token-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp-client/token-refresh')>()),
  ensureFreshAccessToken: refresh.ensure,
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('../client', () => ({ inngest: { createFunction: (opts: unknown, fn: unknown) => ({ opts, fn }) } }))

const { keepMcpTokensFresh, KEEPALIVE_WINDOW_MS } = await import('../mcp-token-keepalive')
const { McpTokenExpiredError, McpTokenRefreshUnavailableError } = await import('@/lib/mcp-client/token-refresh')

/** Each read records its calls; `columns: false` answers a filter on the mark as Postgres does before migration 451. */
function db(rows: Array<Partial<ConnectedMcpServerRow>>, opts: { columns?: boolean } = {}) {
  const reads: Array<Array<[string, ...unknown[]]>> = []
  const from = () => {
    const calls: Array<[string, ...unknown[]]> = []
    reads.push(calls)
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'not', 'lt', 'is', 'order', 'limit']) chain[m] = (...args: unknown[]) => (calls.push([m, ...args]), chain)
    chain.then = (ok: (v: unknown) => unknown) => {
      const filtersMark = calls.some(([m, k]) => m === 'is' && k === 'reauth_required_at')
      if (filtersMark && opts.columns === false) return Promise.resolve({ data: null, error: { code: '42703', message: 'column connected_mcp_server.reauth_required_at does not exist' } }).then(ok)
      return Promise.resolve({ data: rows, error: null }).then(ok)
    }
    return chain
  }
  return { client: { from } as never, reads }
}

describe('keepMcpTokensFresh', () => {
  it('reads only enabled OAuth apps with a refresh token expiring within the window', async () => {
    const { client, reads } = db([])
    const now = Date.parse('2026-10-27T12:00:00Z')
    await keepMcpTokensFresh(client, { nowMs: now })
    expect(reads).toHaveLength(1)
    expect(reads[0]).toEqual(
      expect.arrayContaining([
        ['eq', 'auth_type', 'oauth2'],
        ['eq', 'is_enabled', true],
        ['not', 'refresh_token_encrypted', 'is', null],
        ['lt', 'token_expires_at', new Date(now + KEEPALIVE_WINDOW_MS).toISOString()],
        // Marked ones are skipped in the query, so they never crowd healthy ones out of the limit.
        ['is', 'reauth_required_at', null],
      ]),
    )
  })

  it('before migration 451: reads again without the mark filter', async () => {
    refresh.ensure.mockReset().mockImplementation(async (server: ConnectedMcpServerRow) => server)
    const fake = db([{ id: 'a', access_token_encrypted: 'x' }], { columns: false })
    expect(await keepMcpTokensFresh(fake.client)).toMatchObject({ due: 1 })
    expect(fake.reads).toHaveLength(2)
    expect(fake.reads[1].some(([m]) => m === 'is')).toBe(false)
  })

  it('renews each due app with the window as its leeway, skips marked ones, and counts the outcomes', async () => {
    const rows = [
      { id: 'a', access_token_encrypted: 'old-a' },
      { id: 'b', access_token_encrypted: 'old-b' },
      { id: 'c', access_token_encrypted: 'old-c' },
      { id: 'd', access_token_encrypted: 'old-d' },
      { id: 'marked', access_token_encrypted: 'x', reauth_required_at: '2026-10-27T04:00:00Z' },
    ]
    refresh.ensure.mockReset().mockImplementation(async (server: ConnectedMcpServerRow) => {
      if (server.id === 'a') return { ...server, access_token_encrypted: 'new-a' }
      if (server.id === 'b') return server
      if (server.id === 'c') throw new McpTokenExpiredError('C')
      throw new McpTokenRefreshUnavailableError('D')
    })
    const { client } = db(rows)
    expect(await keepMcpTokensFresh(client)).toEqual({ due: 4, renewed: 1, needsReconnect: 1, failed: 1 })
    expect(refresh.ensure).toHaveBeenCalledTimes(4)
    expect(refresh.ensure.mock.calls.map((c) => (c[0] as ConnectedMcpServerRow).id)).not.toContain('marked')
    expect(refresh.ensure.mock.calls[0][1]).toEqual({ leewayMs: KEEPALIVE_WINDOW_MS })
  })

  it('a failed read throws (the step retries)', async () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'not', 'lt', 'is', 'order', 'limit']) chain[m] = () => chain
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'down' } }).then(ok)
    await expect(keepMcpTokensFresh({ from: () => chain } as never)).rejects.toThrow(/down/)
  })
})
