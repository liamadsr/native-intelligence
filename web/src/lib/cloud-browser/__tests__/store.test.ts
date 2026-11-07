/**
 * The cloud_browser row (src/lib/cloud-browser/store.ts). Every query's filters
 * are recorded, so the compare-and-set conditions that keep the sweep from
 * stopping a browser an ensure just used are asserted, not assumed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CLOUD_BROWSER } from '@/lib/cloud-browser/config'

type Call = { table: string; ops: [string, ...unknown[]][] }
const db = vi.hoisted(() => ({
  calls: [] as { table: string; ops: [string, ...unknown[]][] }[],
  /** The result for the Nth query (by order), else { data: null }. */
  results: [] as unknown[],
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const call: Call = { table, ops: [] }
      const index = db.calls.push(call) - 1
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'insert', 'upsert', 'update', 'delete', 'match', 'eq', 'is', 'in', 'lt', 'order', 'limit']) {
        chain[m] = (...args: unknown[]) => { call.ops.push([m, ...args]); return chain }
      }
      const result = () => Promise.resolve({ error: null, ...((db.results[index] ?? { data: null }) as object) })
      chain.maybeSingle = () => { call.ops.push(['maybeSingle']); return result() }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => result().then(resolve, reject)
      return chain
    },
  }),
}))

const store = await import('@/lib/cloud-browser/store')
const ref = { userId: 'u1', workspaceId: 'w1' }
const ROW = { user_id: 'u1', workspace_id: 'w1' }
const ops = (i: number) => db.calls[i].ops
const has = (i: number, ...op: unknown[]) => expect(ops(i)).toContainEqual(op)

beforeEach(() => { db.calls = []; db.results = [] })

describe('markStarting', () => {
  it('inserts on first use, wakes only a stopped row, and counts as activity', async () => {
    await store.markStarting(ref, 'browser-x')
    expect(ops(0)[0]).toEqual(['upsert', expect.objectContaining({ ...ROW, sandbox_name: 'browser-x', status: 'starting' }),
      { onConflict: 'user_id,workspace_id', ignoreDuplicates: true }])
    has(1, 'update', { status: 'starting', stop_reason: null })
    has(1, 'eq', 'status', 'stopped')
    expect(ops(2)[0]).toEqual(['update', { last_active_at: expect.any(String) }])
    expect(ops(2).some(([m]) => m === 'eq')).toBe(false) // a running or stopping row keeps its status
  })
})

describe('markRunning', () => {
  it('records the session and the platform start time (the session cap counts from it)', async () => {
    const startedAt = new Date('2026-10-22T10:00:00Z')
    await store.markRunning(ref, 'sbx_1', startedAt)
    has(0, 'update', expect.objectContaining({ status: 'running', session_id: 'sbx_1', started_at: '2026-10-22T10:00:00.000Z' }))
  })
})

describe('markStopping (compare-and-set)', () => {
  const seen = (reason: string) => ({ ...ROW, sandbox_name: 'b', session_id: 'sbx_1', status: 'running', started_at: 's',
    last_active_at: '2026-10-22T10:00:00+00:00', updated_at: '2026-10-22T10:01:00+00:00', reason }) as never

  it('claims an idle browser only if nobody touched it since the sweep read it', async () => {
    db.results = [{ data: { user_id: 'u1' } }]
    expect(await store.markStopping(ref, seen('idle'))).toBe(true)
    has(0, 'eq', 'status', 'running')
    has(0, 'eq', 'last_active_at', '2026-10-22T10:00:00+00:00')
  })

  it('reports a changed browser (the update matched nothing)', async () => {
    db.results = [{ data: null }]
    expect(await store.markStopping(ref, seen('idle'))).toBe(false)
  })

  it('claims a busy browser near the session cap by its session, not its activity', async () => {
    db.results = [{ data: { user_id: 'u1' } }]
    await store.markStopping(ref, seen('session_limit'))
    has(0, 'eq', 'session_id', 'sbx_1')
    expect(ops(0)).not.toContainEqual(['eq', 'last_active_at', expect.anything()])
  })

  it('retries a stuck stop by its last update', async () => {
    db.results = [{ data: { user_id: 'u1' } }]
    await store.markStopping(ref, seen('stuck_stopping'))
    has(0, 'eq', 'updated_at', '2026-10-22T10:01:00+00:00')
  })

  it('claims any live browser on an explicit stop', async () => {
    db.results = [{ data: { user_id: 'u1' } }]
    await store.markStopping(ref, null)
    has(0, 'in', 'status', ['starting', 'running', 'stopping'])
  })
})

describe('markStopped', () => {
  it('only lands on a row still stopping (an ensure that resumed it keeps "running"), and gives the browser back to the agent', async () => {
    await store.markStopped(ref, 'idle')
    has(0, 'update', { status: 'stopped', session_id: null, stop_reason: 'idle', driver: 'agent', exit_mode: null, exit_device_id: null, exit_connected_at: null })
    has(0, 'eq', 'status', 'stopping')
  })
})

describe('listStopCandidates', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z')
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const row = (over: Record<string, unknown>) => ({ ...ROW, sandbox_name: 'b', session_id: 's', status: 'running',
    started_at: iso(60_000), last_active_at: iso(60_000), updated_at: iso(60_000), ...over })

  it('asks for stuck stops, near-cap sessions, stuck starts and idle browsers with the right cutoffs', async () => {
    await store.listStopCandidates(NOW)
    has(0, 'eq', 'status', 'stopping'); has(0, 'lt', 'updated_at', iso(CLOUD_BROWSER.stoppingStaleMs))
    has(1, 'eq', 'status', 'running'); has(1, 'lt', 'started_at', iso(CLOUD_BROWSER.sessionTimeoutMs - CLOUD_BROWSER.stopBeforeTimeoutMs))
    has(2, 'eq', 'status', 'starting'); has(2, 'lt', 'last_active_at', iso(CLOUD_BROWSER.startingStaleMs))
    has(3, 'eq', 'status', 'running'); has(3, 'lt', 'last_active_at', iso(CLOUD_BROWSER.idleStopMs))
    for (let i = 0; i < 4; i++) has(i, 'limit', CLOUD_BROWSER.maxStopsPerSweep)
  })

  it('puts the urgent ones first, lists each browser once, and bounds the run', async () => {
    const idle = Array.from({ length: CLOUD_BROWSER.maxStopsPerSweep }, (_, i) => row({ user_id: `idle${i}` }))
    db.results = [
      { data: [row({ user_id: 'stuck', status: 'stopping' })] },
      { data: [row({ user_id: 'cap' }), row({ user_id: 'idle0' })] },
      { data: [] },
      { data: idle },
    ]
    const out = await store.listStopCandidates(NOW)
    expect(out.slice(0, 3).map(r => [r.user_id, r.reason])).toEqual([['stuck', 'stuck_stopping'], ['cap', 'session_limit'], ['idle0', 'session_limit']])
    expect(out.filter(r => r.user_id === 'idle0')).toHaveLength(1)
    expect(out).toHaveLength(CLOUD_BROWSER.maxStopsPerSweep)
  })
})

describe('sandboxNamesWithRows', () => {
  it('returns the names some row owns', async () => {
    db.results = [{ data: [{ sandbox_name: 'browser-a' }] }]
    expect(await store.sandboxNamesWithRows(['browser-a', 'browser-b'])).toEqual(new Set(['browser-a']))
    has(0, 'in', 'sandbox_name', ['browser-a', 'browser-b'])
  })
})
