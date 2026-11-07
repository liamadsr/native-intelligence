import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GET /api/cron/triage-reconciler — the 2026-10 PROD audit cases, end to end
 * through the route: proposals with no capture, private captures, captures
 * still recording, just ended or retired by the abandoned sweep, workspaces
 * that would fail the usage gate,
 * and the lifetime per-capture cap. Only the one genuinely fireable capture
 * may be enqueued; everything else gets no fire, no ledger row, no notice.
 */

const NOW = Date.parse('2026-10-15T12:30:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const HOUR = 60 * 60 * 1000

const { send, startWork, calls, state } = vi.hoisted(() => ({
  send: vi.fn(async (_event: unknown) => ({ ids: ['e1'] })),
  startWork: vi.fn(async (_supabase: unknown, _args: unknown) => ({
    inert: false,
    finish: async () => {},
    fail: async () => {},
  })),
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  state: {
    tables: {} as Record<string, unknown[]>,
    rpc: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  },
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send } }))
vi.mock('@/lib/work/recorder', () => ({ startWork }))
vi.mock('@/lib/work/system-teammates', () => ({ systemTeammateId: async () => null }))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => null }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => chain(table),
    rpc: async (_fn: string, args: { p_user_id: string }) =>
      state.rpc[args.p_user_id] ?? { data: [{ allowed: true }], error: null },
  }),
}))

/** A chain that records every call and resolves to the table's rows. */
function chain(table: string): unknown {
  const rows = () => state.tables[table] ?? []
  const target: Record<string, unknown> = {
    then: (res: (r: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      return (...args: unknown[]) => {
        calls.push({ table, method: prop, args })
        return proxy
      }
    },
  })
  return proxy
}

import { GET } from '../route'

const request = () => new Request('http://localhost/api/cron/triage-reconciler') as never

function seed() {
  state.tables = {
    flow: [
      { id: 'f-paid', workspace_id: 'w-paid', created_by: 'u-paid' },
      { id: 'f-unpaid', workspace_id: 'w-unpaid', created_by: 'u-unpaid' },
    ],
    proposed_change: [
      { id: 'p-null', capture_id: null, workspace_id: 'w-paid' },
      { id: 'p-private', capture_id: 'cap-private', workspace_id: 'w-paid' },
      { id: 'p-recording', capture_id: 'cap-recording', workspace_id: 'w-paid' },
      { id: 'p-settling', capture_id: 'cap-settling', workspace_id: 'w-paid' },
      { id: 'p-capped', capture_id: 'cap-capped', workspace_id: 'w-paid' },
      { id: 'p-unpaid', capture_id: 'cap-unpaid', workspace_id: 'w-unpaid' },
      { id: 'p-retired', capture_id: 'cap-retired', workspace_id: 'w-paid' },
      { id: 'p-ready', capture_id: 'cap-ready', workspace_id: 'w-paid' },
    ],
    flow_run: [],
    attention_item: [],
    captures: [
      { id: 'cap-private', visibility: 'private', ended_at: iso(3 * HOUR), batch_processed_at: iso(3 * HOUR) },
      { id: 'cap-recording', visibility: 'workspace', ended_at: null, batch_processed_at: null },
      { id: 'cap-settling', visibility: 'workspace', ended_at: iso(5 * 60 * 1000), batch_processed_at: null },
      { id: 'cap-capped', visibility: 'workspace', ended_at: iso(48 * HOUR), batch_processed_at: iso(48 * HOUR) },
      { id: 'cap-unpaid', visibility: 'workspace', ended_at: iso(3 * HOUR), batch_processed_at: iso(3 * HOUR) },
      // Retired by the abandoned sweep (open, quiet past its lookback): never triaged.
      {
        id: 'cap-retired',
        visibility: 'workspace',
        ended_at: iso(40 * 24 * HOUR),
        batch_processed_at: null,
        metadata: { finalized: { by: 'server', reason: 'stale', at: iso(HOUR) } },
      },
      { id: 'cap-ready', visibility: 'workspace', ended_at: iso(2 * HOUR), batch_processed_at: iso(2 * HOUR) },
    ],
    tracked_job: [
      { source: { capture_id: 'cap-capped' } },
      { source: { capture_id: 'cap-capped' } },
      { source: { capture_id: null } },
    ],
    member: [{ id: 'm1', user_id: 'u-paid' }],
  }
  state.rpc = {
    'u-unpaid': { data: [{ allowed: false, reason: 'subscription_required' }], error: null },
  }
}

describe('GET /api/cron/triage-reconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    send.mockClear()
    startWork.mockClear()
    calls.length = 0
    seed()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires only the finished, settled, under-cap capture in a workspace that passes the usage gate', async () => {
    const res = await GET(request())
    const body = await res.json()

    expect(body).toMatchObject({ ok: true, eligible: 1, fired: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'flow/capture.processed',
        data: expect.objectContaining({ workspace_id: 'w-paid', capture_id: 'cap-ready', reconciled: true }),
      }),
    )
    // One ledger row, for that capture only: nothing for the null, private,
    // recording, settling, retired, capped or unsubscribed cases.
    expect(startWork).toHaveBeenCalledTimes(1)
    expect(startWork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: { capture_id: 'cap-ready' } }),
    )
  })

  it('excludes NULL capture ids in the pending query itself', async () => {
    await GET(request())
    expect(calls).toContainEqual({ table: 'proposed_change', method: 'not', args: ['capture_id', 'is', null] })
  })

  it('counts the cap from the whole ledger (no time window)', async () => {
    await GET(request())
    const jobFilters = calls.filter((c) => c.table === 'tracked_job')
    expect(jobFilters.some((c) => c.method === 'gte')).toBe(false)
    expect(jobFilters).toContainEqual(
      expect.objectContaining({ method: 'in', args: ['source->>capture_id', expect.any(Array)] }),
    )
  })

  it('an unsubscribed workspace gets no fire at all (so no failed run, no work_failed notice)', async () => {
    state.tables.proposed_change = [{ id: 'p-unpaid', capture_id: 'cap-unpaid', workspace_id: 'w-unpaid' }]
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ eligible: 0, fired: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(startWork).not.toHaveBeenCalled()
  })

  it('a usage-check RPC error fails open, as run-skill does', async () => {
    state.tables.proposed_change = [{ id: 'p-unpaid', capture_id: 'cap-unpaid', workspace_id: 'w-unpaid' }]
    state.rpc = { 'u-unpaid': { data: null, error: { message: 'boom' } } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ eligible: 1, fired: 1 })
  })

  it('a workspace with only null-capture proposals does nothing', async () => {
    state.tables.proposed_change = [{ id: 'p-null', capture_id: null, workspace_id: 'w-paid' }]
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ eligible: 0, fired: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})
