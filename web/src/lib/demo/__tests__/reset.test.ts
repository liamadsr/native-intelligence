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

import { DemoResetRefused, NEVER_WIPED, WIPE, assertDemoWorkspace, resetDemoWorkspace, wipeVisitorContent } from '../reset'
import { loadSeedContext, seedDemoContent } from '../seed'
import { ensureMemberContact } from '@/lib/crm/contacts'

const DEMO = 'ws-demo'
const REAL = 'ws-real'

interface Call {
  table: string
  op: 'select' | 'delete' | 'update' | 'insert'
  filters: Array<[string, string, unknown]>
}

/** A service client that records every statement and answers from `tables`. */
function fakeService(opts: { flagged?: string[]; flagError?: string; refuse?: Record<string, string>; members?: Array<{ id: string; user_id: string; role: string }>; liveCalls?: number; liveError?: string } = {}) {
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
    expect(deletes.length).toBe(WIPE.length)
    for (const d of deletes) {
      expect(d.filters).toContainEqual(['eq', 'workspace_id', DEMO])
      expect(NEVER_WIPED).not.toContain(d.table)
    }
    expect(report).toMatchObject({ workspaceId: DEMO, seeded: true, seedError: null, members: 2, failed: {}, skipped: null })
    expect(report.cleared.chat_conversations).toBe(2)
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
