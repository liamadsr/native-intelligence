/**
 * The demo reset's guard (src/lib/demo/reset.ts): only a workspace flagged in
 * `demo_workspace` is ever written, on any database; every delete is fenced on
 * that one workspace; the people in it are never touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/crm/deals', () => ({
  ensureDefaultPipeline: vi.fn(async () => null),
  findDeals: vi.fn(async () => ({ deals: [], pipelines: [] })),
  createDeal: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/crm/contacts', () => ({ ensureMemberContact: vi.fn(async () => undefined) }))
vi.mock('../seed', () => ({
  WORKSPACE_NAME: 'Fernhill Studio',
  loadSeedContext: vi.fn(async (admin: unknown, ids: Record<string, string>) => ({ admin, ...ids, teamId: 't1', states: new Map() })),
  resetSeeded: vi.fn(async () => undefined),
  seedDemoContent: vi.fn(async () => ({ projectId: 'p1', contacts: new Map() })),
}))

import { COMMENTABLE, DemoResetRefused, NEVER_WIPED, WIPE, assertDemoWorkspace, resetDemoWorkspace, wipeVisitorContent } from '../reset'
import { loadSeedContext, seedDemoContent } from '../seed'
import { ensureMemberContact } from '@/lib/crm/contacts'
import { createDeal, ensureDefaultPipeline, findDeals } from '@/lib/crm/deals'

const DEMO = 'ws-demo'
const REAL = 'ws-real'

interface Call {
  table: string
  op: 'select' | 'delete' | 'update' | 'insert'
  filters: Array<[string, string, unknown]>
  /** Set on a paged read (`.range(from, to)`): the reset's reads of a parent's ids. */
  range?: [number, number]
}

/** The ids a parent table holds in the demo workspace: `<table>-0` … (none in any other workspace). */
const parentIds = (table: string, n: number) => Array.from({ length: n }, (_, i) => `${table}-${i}`)

/** A service client that records every statement and answers from `tables`. */
function fakeService(opts: { flagged?: string[]; flagError?: string; refuse?: Record<string, string>; refuseRead?: Record<string, string>; members?: Array<{ id: string; user_id: string; role: string }>; liveCalls?: number; liveError?: string; parents?: number } = {}) {
  const calls: Call[] = []
  const flagged = opts.flagged ?? [DEMO]
  const members = opts.members ?? [
    { id: 'm-owner', user_id: 'u-owner', role: 'owner' },
    { id: 'm-visitor', user_id: 'u-visitor', role: 'member' },
  ]
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] }
    calls.push(call)
    const eqValue = (col: string) => call.filters.find(([op, c]) => op === 'eq' && c === col)?.[2]
    const answer = () => {
      if (call.op === 'delete') {
        const refused = opts.refuse?.[table]
        return refused ? { data: null, error: { message: refused }, count: null } : { data: null, error: null, count: 2 }
      }
      if (call.op !== 'select') return { data: null, error: null, count: null }
      if (call.range) {
        if (opts.refuseRead?.[table]) return { data: null, error: { message: opts.refuseRead[table] } }
        const all = eqValue('workspace_id') === DEMO ? parentIds(table, opts.parents ?? 2) : []
        return { data: all.slice(call.range[0], call.range[1] + 1).map((id) => ({ id })), error: null }
      }
      if (table === 'demo_workspace') {
        if (opts.flagError) return { data: null, error: { message: opts.flagError } }
        const id = eqValue('workspace_id')
        if (id === undefined) return { data: flagged.map((workspace_id) => ({ workspace_id })), error: null }
        return { data: flagged.includes(id as string) ? { workspace_id: id } : null, error: null }
      }
      if (table === 'member') return { data: members, error: null }
      if (table === 'team_call') return opts.liveError ? { data: null, error: { message: opts.liveError }, count: null } : { data: null, error: null, count: opts.liveCalls ?? 0 }
      if (table === 'team_chat_message') return { data: null, error: null, count: 1 }
      return { data: null, error: null, count: 0 }
    }
    const q: Record<string, unknown> = {
      select: () => q,
      delete: () => ((call.op = 'delete'), q),
      update: () => ((call.op = 'update'), q),
      insert: () => ((call.op = 'insert'), q),
      eq: (c: string, v: unknown) => (call.filters.push(['eq', c, v]), q),
      is: (c: string, v: unknown) => (call.filters.push(['is', c, v]), q),
      in: (c: string, v: unknown) => (call.filters.push(['in', c, v]), q),
      range: (a: number, b: number) => ((call.range = [a, b]), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => answer(),
      single: async () => answer(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
    }
    return q
  }
  const service = {
    from,
    auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@fernhill.example`, user_metadata: {} } } })) } },
  } as unknown as SupabaseClient
  return { service, calls, writes: () => calls.filter((c) => c.op !== 'select') }
}

beforeEach(() => vi.clearAllMocks())

describe('assertDemoWorkspace', () => {
  it('passes a flagged workspace', async () => {
    await expect(assertDemoWorkspace(fakeService().service, DEMO)).resolves.toBeUndefined()
  })

  it('refuses a workspace that is not flagged, an empty id, and an unreadable flag', async () => {
    await expect(assertDemoWorkspace(fakeService().service, REAL)).rejects.toBeInstanceOf(DemoResetRefused)
    await expect(assertDemoWorkspace(fakeService().service, '')).rejects.toBeInstanceOf(DemoResetRefused)
    await expect(assertDemoWorkspace(fakeService({ flagError: 'timeout' }).service, DEMO)).rejects.toBeInstanceOf(DemoResetRefused)
  })
})

describe('resetDemoWorkspace', () => {
  it('writes nothing at all to a workspace that is not flagged', async () => {
    const { service, writes, calls } = fakeService()
    await expect(resetDemoWorkspace(service, REAL)).rejects.toBeInstanceOf(DemoResetRefused)
    expect(writes()).toEqual([])
    // Not even a read beyond the flag itself.
    expect(calls.map((c) => c.table)).toEqual(['demo_workspace'])
    expect(seedDemoContent).not.toHaveBeenCalled()
  })

  it('wipeVisitorContent checks the flag itself: it cannot be called around the guard', async () => {
    const { service, writes } = fakeService()
    await expect(wipeVisitorContent(service, REAL)).rejects.toBeInstanceOf(DemoResetRefused)
    expect(writes()).toEqual([])
  })

  it('fences every delete on the demo workspace and never clears who is in it', async () => {
    const { service, calls } = fakeService()
    const report = await resetDemoWorkspace(service, DEMO)
    const deletes = calls.filter((c) => c.op === 'delete')
    // One delete a step; a comment's step makes one per kind of thing it can be on.
    expect(deletes.length).toBe(WIPE.length - 1 + Object.keys(COMMENTABLE).length)
    for (const d of deletes) {
      expect(NEVER_WIPED).not.toContain(d.table)
      const step = WIPE.find((s) => s.table === d.table)!
      if (step.through) {
        expect(d.filters).toEqual([['in', step.through.column, parentIds(step.through.parent, 2)]])
      } else if (step.commentable) {
        const type = d.filters.find(([op, c]) => op === 'eq' && c === 'commentable_type')?.[2] as string
        expect(d.filters).toEqual([['in', 'commentable_id', parentIds(COMMENTABLE[type], 2)], ['eq', 'commentable_type', type]])
      } else {
        expect(d.filters).toContainEqual(['eq', step.column ?? 'workspace_id', DEMO])
      }
    }
    // Every id list a delete names was read from its parent, fenced on the demo workspace.
    const reads = calls.filter((c) => c.range)
    expect(reads.length).toBeGreaterThan(0)
    for (const r of reads) expect(r.filters).toContainEqual(['eq', 'workspace_id', DEMO])
    expect(report).toMatchObject({ workspaceId: DEMO, seeded: true, seedError: null, members: 2, failed: {}, skipped: null })
    expect(report.cleared.chat_conversations).toBe(2)
    expect(report.cleared.comment).toBe(2 * Object.keys(COMMENTABLE).length)
  })

  it('clears what has no workspace column of its own through its parent, and profile facts by where they were learned', async () => {
    const { service, calls } = fakeService()
    await resetDemoWorkspace(service, DEMO)
    const del = (t: string) => calls.filter((c) => c.table === t && c.op === 'delete')
    expect(del('cycle')[0].filters).toEqual([['in', 'team_id', parentIds('team', 2)]])
    expect(del('decision')[0].filters).toEqual([['in', 'capture_id', parentIds('captures', 2)]])
    expect(del('milestone')[0].filters).toEqual([['in', 'project_id', parentIds('projects', 2)]])
    expect(del('flow_run')[0].filters).toEqual([['in', 'flow_id', parentIds('flow', 2)]])
    expect(del('profile_fact')[0].filters).toEqual([['eq', 'source_workspace_id', DEMO]])
    expect(del('comment').map((c) => c.filters[1][2]).sort()).toEqual(Object.keys(COMMENTABLE).sort())
    // Teams are only read, never written.
    expect(calls.filter((c) => c.table === 'team' && c.op !== 'select')).toEqual([])
    expect(del('sms_message')).toEqual([])
  })

  it('pages through a parent with more than a thousand rows and deletes a hundred ids at a time', async () => {
    const { service, calls } = fakeService({ parents: 1050 })
    await resetDemoWorkspace(service, DEMO)
    const teamReads = calls.filter((c) => c.table === 'team' && c.range)
    expect(teamReads.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
    const cycleDeletes = calls.filter((c) => c.table === 'cycle' && c.op === 'delete')
    expect(cycleDeletes.length).toBe(11)
    const named = cycleDeletes.flatMap((c) => c.filters[0][2] as string[])
    expect(cycleDeletes.every((c) => (c.filters[0][2] as string[]).length <= 100)).toBe(true)
    expect(named).toEqual(parentIds('team', 1050))
  })

  it('a parent that cannot be read is that step failing: reported, tried once more, the rest goes on', async () => {
    const { service, calls } = fakeService({ refuseRead: { team: 'timeout' } })
    const report = await resetDemoWorkspace(service, DEMO)
    expect(report.failed).toEqual({ cycle: 'team: timeout' })
    expect(calls.filter((c) => c.table === 'cycle' && c.op === 'delete')).toEqual([])
    expect(calls.filter((c) => c.table === 'team' && c.range).length).toBe(2)
    expect(report.seeded).toBe(true)
  })

  it('seeds the deals as the owner: every pipeline read names them (a service client has no signed-in user)', async () => {
    const pipelines = [{ id: 'pipe-1', name: 'Sales', is_default: true }]
    vi.mocked(ensureDefaultPipeline).mockResolvedValueOnce('pipe-1')
    vi.mocked(findDeals).mockResolvedValueOnce({ deals: [], pipelines } as never)
    const report = await resetDemoWorkspace(fakeService().service, DEMO)
    expect(report).toMatchObject({ seeded: true, seedError: null })
    expect(ensureDefaultPipeline).toHaveBeenCalledWith(expect.anything(), DEMO, 'u-owner')
    expect(findDeals).toHaveBeenCalledWith(expect.anything(), DEMO, { limit: 100 }, { viewer: 'u-owner' })
    expect(vi.mocked(createDeal).mock.calls.length).toBeGreaterThan(0)
    for (const c of vi.mocked(createDeal).mock.calls) {
      expect(c[3]).toMatchObject({ userId: 'u-owner' })
      expect(c[4]).toEqual({ viewer: 'u-owner', pipelines })
    }
  })

  it('keeps the members: no delete or update on member, their contact cards, or the default pipeline', async () => {
    const { service, calls } = fakeService()
    await resetDemoWorkspace(service, DEMO)
    expect(calls.filter((c) => c.table === 'member' && c.op !== 'select')).toEqual([])
    const contacts = calls.find((c) => c.table === 'contact' && c.op === 'delete')!
    expect(contacts.filters).toContainEqual(['is', 'member_id', null])
    const tables = calls.find((c) => c.table === 'data_table' && c.op === 'delete')!
    expect(tables.filters).toContainEqual(['eq', 'is_default', false])
    // Each member gets their own contact card back, visitors included.
    expect(vi.mocked(ensureMemberContact).mock.calls.map((c) => c[1])).toEqual(['m-owner', 'm-visitor'])
  })

  it('seeds as the owner, with other members present', async () => {
    const { service } = fakeService()
    await resetDemoWorkspace(service, DEMO)
    expect(loadSeedContext).toHaveBeenCalledWith(service, { workspaceId: DEMO, userId: 'u-owner', memberId: 'm-owner' })
    expect(seedDemoContent).toHaveBeenCalledOnce()
  })

  it('reports a table that refuses, tries it once more, and still seeds', async () => {
    const { service, calls } = fakeService({ refuse: { company: 'violates foreign key constraint' } })
    const report = await resetDemoWorkspace(service, DEMO)
    expect(report.failed).toEqual({ company: 'violates foreign key constraint' })
    expect(calls.filter((c) => c.table === 'company' && c.op === 'delete').length).toBe(2)
    expect(report.seeded).toBe(true)
  })

  it('people in a call right now: nothing is touched, and the run says it was put off', async () => {
    const { service, writes } = fakeService({ liveCalls: 1 })
    const report = await resetDemoWorkspace(service, DEMO)
    expect(report).toMatchObject({ skipped: 'live_call', seeded: false, cleared: {}, failed: {} })
    expect(writes()).toEqual([])
    expect(seedDemoContent).not.toHaveBeenCalled()
  })

  it('a live-call read that fails puts the reset off too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service, writes } = fakeService({ liveError: 'timeout' })
    expect((await resetDemoWorkspace(service, DEMO)).skipped).toBe('live_call')
    expect(writes()).toEqual([])
  })

  it('asks for live calls in that workspace only', async () => {
    const { service, calls } = fakeService()
    await resetDemoWorkspace(service, DEMO)
    const look = calls.find((c) => c.table === 'team_call' && c.op === 'select')!
    expect(look.filters).toEqual([['eq', 'workspace_id', DEMO], ['eq', 'status', 'live']])
  })

  it('a failed seed is reported, not thrown', async () => {
    vi.mocked(seedDemoContent).mockRejectedValueOnce(new Error('the team has no "Todo" column'))
    const report = await resetDemoWorkspace(fakeService().service, DEMO)
    expect(report).toMatchObject({ seeded: false, seedError: 'the team has no "Todo" column' })
  })

  it('refuses a demo workspace with no owner to seed as', async () => {
    const { service, writes } = fakeService({ members: [{ id: 'm1', user_id: 'u1', role: 'member' }] })
    await expect(resetDemoWorkspace(service, DEMO)).rejects.toBeInstanceOf(DemoResetRefused)
    expect(writes()).toEqual([])
  })
})

describe('the wipe list', () => {
  it('names no table twice and none that holds who is in the workspace', () => {
    const names = WIPE.map((s) => s.table)
    expect(new Set(names).size).toBe(names.length)
    for (const kept of NEVER_WIPED) expect(names).not.toContain(kept)
    for (const account of ['connected_account', 'connected_account_workspace', 'ai_usage_logs', 'chat_usage_outbox', 'seo_spend']) {
      expect(names).not.toContain(account)
    }
  })
})
