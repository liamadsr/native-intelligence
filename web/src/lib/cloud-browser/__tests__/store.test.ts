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
      for (const m of ['select', 'insert', 'upsert', 'update', 'delete', 'match', 'eq', 'is', 'in', 'lt', 'gt', 'order', 'limit', 'like', 'or']) {
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
    const out = await store.markStarting(ref, 'browser-x')
    expect(ops(0)[0]).toEqual(['upsert', expect.objectContaining({ ...ROW, sandbox_name: 'browser-x', status: 'starting', started_at: out.at, last_active_at: out.at }),
      { onConflict: 'user_id,workspace_id', ignoreDuplicates: true }])
    // When the row BECAME starting: the stuck-starting stop is judged by it.
    has(1, 'update', { status: 'starting', stop_reason: null, started_at: out.at })
    has(1, 'eq', 'status', 'stopped')
    expect(ops(2)[0]).toEqual(['update', { last_active_at: out.at }])
    expect(ops(2).some(([m]) => m === 'eq')).toBe(false) // a running or stopping row keeps its status
    // Neither the insert nor the wake matched a row: another ensure started it, or it runs.
    expect(out.moved).toBe(false)
  })

  it('says when THIS call moved the row to starting: it inserted it, or it was the update that found it stopped', async () => {
    db.results = [{ data: [{ user_id: 'u1' }] }]
    expect((await store.markStarting(ref, 'browser-x')).moved).toBe(true)
    db.calls = []
    db.results = [{ data: [] }, { data: [{ user_id: 'u1' }] }]
    expect((await store.markStarting(ref, 'browser-x')).moved).toBe(true)
    db.calls = []
    db.results = [{ data: [] }, { data: [] }]
    expect((await store.markStarting(ref, 'browser-x')).moved).toBe(false)
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

  it('on the runtime backend keeps the session: the row still names the sandbox its profile is in', async () => {
    await store.markStopped(ref, 'idle', { keepSession: true })
    has(0, 'update', { status: 'stopped', stop_reason: 'idle', driver: 'agent', exit_mode: null, exit_device_id: null, exit_connected_at: null })
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
    // An expiry's claim is left alone far longer: its destroy may still be on its way.
    has(0, 'or', `stop_reason.is.null,stop_reason.neq.expiring,updated_at.lt."${iso(CLOUD_BROWSER.expiringStaleMs)}"`)
    expect(CLOUD_BROWSER.expiringStaleMs).toBe(30 * 60_000)
    has(1, 'eq', 'status', 'running'); has(1, 'lt', 'started_at', iso(CLOUD_BROWSER.sessionTimeoutMs - CLOUD_BROWSER.stopBeforeTimeoutMs))
    // A stuck start by when it BEGAN (started_at, set by markStarting), not its activity, which each retry renews.
    has(2, 'eq', 'status', 'starting')
    has(2, 'or', `started_at.lt."${iso(CLOUD_BROWSER.startingStaleMs)}",and(started_at.is.null,last_active_at.lt."${iso(CLOUD_BROWSER.startingStaleMs)}")`)
    expect(ops(2)).not.toContainEqual(['lt', 'last_active_at', expect.anything()])
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

describe('the runtime backend’s reads and its expiry', () => {
  it('reads the status and the session (the hub follows from it)', async () => {
    db.results = [{ data: { status: 'running', session_id: 'abc.1' } }, { data: null }]
    expect(await store.readSession(ref)).toEqual({ status: 'running', sessionId: 'abc.1' })
    has(0, 'select', 'status, session_id')
    has(0, 'match', ROW)
    expect(await store.readSession(ref)).toBeNull()
  })

  it('lists stopped browsers unused since the cutoff, oldest first, bounded', async () => {
    db.results = [{ data: [{ ...ROW, sandbox_name: 'b' }] }]
    const cutoff = new Date('2026-09-01T00:00:00Z')
    expect(await store.listUnusedStopped(cutoff, 50)).toEqual([{ ...ROW, sandbox_name: 'b' }])
    has(0, 'eq', 'status', 'stopped')
    has(0, 'lt', 'last_active_at', '2026-09-01T00:00:00.000Z')
    has(0, 'order', 'last_active_at', { ascending: true })
    has(0, 'limit', 50)
  })

  it('claims an unused browser for the expiry only from `stopped` with the same last activity, into a state no ensure starts', async () => {
    db.results = [{ data: { user_id: 'u1' } }, { data: null }]
    expect(await store.claimUnusedForExpiry(ref, '2026-08-01T00:00:00+00:00')).toBe(true)
    has(0, 'update', { status: 'stopping', stop_reason: 'expiring' })
    has(0, 'match', ROW)
    has(0, 'eq', 'status', 'stopped')
    has(0, 'eq', 'last_active_at', '2026-08-01T00:00:00+00:00')
    // A person came back in between: the row moved, the claim fails.
    expect(await store.claimUnusedForExpiry(ref, '2026-08-01T00:00:00+00:00')).toBe(false)
  })

  it('tells an ensure that the expiry holds the row, and deletes only a row it still holds', async () => {
    db.results = [{ data: { status: 'stopping', stop_reason: 'expiring' } }, { data: { status: 'stopping', stop_reason: 'idle' } }, { data: { user_id: 'u1' } }]
    expect(await store.isExpiring(ref)).toBe(true)
    expect(await store.isExpiring(ref)).toBe(false)
    expect(await store.deleteExpiringRow(ref)).toBe(true)
    has(2, 'delete')
    has(2, 'match', ROW)
    has(2, 'eq', 'status', 'stopping')
    has(2, 'eq', 'stop_reason', 'expiring')
  })

  it('reads the session of a browser by its sandbox name', async () => {
    db.results = [{ data: { session_id: 'abc.1' } }, { data: null }]
    expect(await store.sessionOfSandboxName('browser-x')).toBe('abc.1')
    has(0, 'eq', 'sandbox_name', 'browser-x')
    expect(await store.sessionOfSandboxName('browser-y')).toBeNull()
  })

  it('a hub is live when a starting or running row’s session starts with exactly `<id>.`', async () => {
    db.results = [{ data: [{ user_id: 'u1' }] }, { data: [] }]
    expect(await store.hubSessionLive('abc123')).toBe(true)
    has(0, 'in', 'status', ['starting', 'running'])
    has(0, 'like', 'session_id', 'abc123.%')
    expect(await store.hubSessionLive('zzz999')).toBe(false)
    // Never a pattern from a name: anything but the id's shape is no, without a query.
    for (const bad of ['abc%', 'a_c', 'ABC', '', 'a.b']) expect(await store.hubSessionLive(bad)).toBe(false)
    expect(db.calls).toHaveLength(2)
  })
})

describe('the shared slots and the hub’s early name (runtime backend)', () => {
  /** SQL's LIKE, enough for the hub's pattern (`\` escapes, `%` any run). */
  const like = (value: string, pattern: string) => new RegExp(`^${pattern.replace(/\\(.)|%|_|[.*+?^${}()|[\]]/g, (m, esc) =>
    esc !== undefined ? `\\${esc}` : m === '%' ? '.*' : m === '_' ? '.' : `\\${m}`)}$`).test(value)

  it('names the sandbox in a STARTING row only, as `<id>.0`, which the hub’s question matches for that id and no other', async () => {
    db.results = [{ data: [{ user_id: 'u1' }] }]
    expect(await store.recordStartingSandbox('browser-x', 'abc123')).toBe(true)
    has(0, 'update', { session_id: 'abc123.0' })
    has(0, 'eq', 'sandbox_name', 'browser-x')
    has(0, 'eq', 'status', 'starting')
    // The session it writes is the one hubSessionLive's pattern finds, for that id alone.
    db.results = [{ data: [] }]
    await store.hubSessionLive('abc123')
    const pattern = ops(1).find(([m]) => m === 'like')![2] as string
    expect(like('abc123.0', pattern)).toBe(true)
    expect(like('abc1234.0', pattern)).toBe(false)
    expect(like('xabc123.0', pattern)).toBe(false)
    // Never anything but the id's shape.
    expect(await store.recordStartingSandbox('browser-x', 'a%b')).toBe(false)
    expect(db.calls).toHaveLength(2)
    // No starting row there to name it: false (and then nothing asks the edge).
    db.results = [{ data: [] }]
    expect(await store.recordStartingSandbox('browser-x', 'abc123')).toBe(false)
  })

  it('a refused start goes back to stopped only from starting and as its ensure left it (its own activity), keeping its session', async () => {
    db.results = [{ data: { user_id: 'u1' } }]
    expect(await store.releaseStart(ref, '2026-11-14T12:00:00.001Z')).toBe(true)
    has(0, 'update', { status: 'stopped', stop_reason: 'busy' })
    has(0, 'match', ROW)
    has(0, 'eq', 'status', 'starting')
    has(0, 'eq', 'last_active_at', '2026-11-14T12:00:00.001Z')
    expect(ops(0).some(([m, v]) => m === 'update' && typeof v === 'object' && v !== null && 'session_id' in v)).toBe(false)
    expect(await store.releaseStart(ref, 'x')).toBe(false)
  })

  it('reads the slot holders, idle longest first, without the expiry’s claims', async () => {
    db.results = [{ data: [
      { ...ROW, status: 'running', stop_reason: null, last_active_at: 'a' },
      { ...ROW, user_id: 'u2', status: 'stopping', stop_reason: 'expiring', last_active_at: 'b' },
      { ...ROW, user_id: 'u3', status: 'stopping', stop_reason: null, last_active_at: 'c' },
      { ...ROW, user_id: 'u4', status: 'starting', stop_reason: null, last_active_at: 'd' },
    ] }]
    expect((await store.listSlotHolders()).map(r => r.user_id)).toEqual(['u1', 'u3', 'u4'])
    has(0, 'in', 'status', ['starting', 'running', 'stopping'])
    has(0, 'order', 'last_active_at', { ascending: true })
    expect(ops(0)[0][1]).toContain('stop_reason')
    expect(ops(0)[0][1]).toContain('driver')
  })

  it('a browser is in use with a command in flight (a live lease, or waiting and not expired) or a browser step waiting on the person', async () => {
    const now = Date.parse('2026-11-14T12:00:00Z')
    const nowIso = '2026-11-14T12:00:00.000Z'
    // Two queries per browser (commands, approvals), in that order: a has a command, b an approval, c neither.
    db.results = [{ data: [{ id: 1 }] }, { data: [] }, { data: [] }, { data: [{ id: 2 }] }, { data: [] }, { data: [] }]
    const refs = ['a', 'b', 'c'].map(userId => ({ userId, workspaceId: 'w' }))
    expect([...await store.browsersInUse(refs, now)].sort()).toEqual(['a:w', 'b:w'])
    const commands = db.calls.filter(c => c.table === 'browser_command_queue')
    const approvals = db.calls.filter(c => c.table === 'tool_approval')
    expect(commands).toHaveLength(3)
    expect(approvals).toHaveLength(3)
    for (const call of commands) {
      expect(call.ops).toContainEqual(['eq', 'workspace_id', 'w'])
      expect(call.ops).toContainEqual(['or', `and(status.in.(claimed,running),lease_expires_at.gt."${nowIso}"),and(status.eq.waiting_for_device,expires_at.gt."${nowIso}")`])
      // One row is enough, per browser: no one's backlog hides another's command.
      expect(call.ops).toContainEqual(['limit', 1])
    }
    for (const call of approvals) {
      expect(call.ops).toContainEqual(['eq', 'tool', 'run_browser_task'])
      expect(call.ops).toContainEqual(['eq', 'status', 'pending'])
      expect(call.ops).toContainEqual(['gt', 'expires_at', nowIso])
      expect(call.ops).toContainEqual(['limit', 1])
    }
    db.calls = []
    expect(await store.browsersInUse([])).toEqual(new Set())
    expect(db.calls).toHaveLength(0)
  })

  it('counts the recent evictions by their stop reason and last update', async () => {
    db.results = [{ count: 2 }]
    const now = Date.parse('2026-11-14T12:00:00Z')
    expect(await store.countRecentEvictions(60 * 60_000, now)).toBe(2)
    has(0, 'eq', 'stop_reason', 'evicted')
    has(0, 'gt', 'updated_at', '2026-11-14T11:00:00.000Z')
  })
})
