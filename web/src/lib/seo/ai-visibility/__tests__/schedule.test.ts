/**
 * Who pays for a scheduled check (../gate.ts) and the schedule's clock
 * (../schedule.ts):
 *
 *   - The gate: the server's key, a tracker that isn't paused, an owner who
 *     still has an account, is still a member and isn't on the free plan; a
 *     plan we can't read skips the check rather than spending.
 *   - The tick advances each due tracker with a compare-and-set before
 *     anything else, so two overlapping ticks start one check, not two; a
 *     refusal is written as the tracker's skip reason and creates nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createRun: vi.fn(),
  dispatchRun: vi.fn(),
  failIfStuck: vi.fn(),
  getLiveRun: vi.fn(),
}))
vi.mock('../runs', () => ({
  createRun: h.createRun,
  dispatchRun: h.dispatchRun,
  failIfStuck: h.failIfStuck,
}))
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  getLiveRun: h.getLiveRun,
}))

import { scheduledRunGate, type ScheduledGateDeps } from '../gate'
import { advanceDueTracker, runDueTrackers } from '../schedule'

const WS = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-0000000000aa'

type Row = Record<string, unknown>

/** Just enough of PostgREST's builder over arrays for the schedule's own queries. */
function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row; matched: number }> = []
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'update' = 'select'
    let patch: Row = {}
    let limit = Infinity
    let orderBy: string | null = null
    const api = {
      select: () => api,
      update: (p: Row) => {
        mode = 'update'
        patch = p
        return api
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), api),
      lte: (k: string, v: string) => (
        filters.push(
          (r) =>
            typeof r[k] === 'string' &&
            Date.parse(r[k] as string) <= Date.parse(v),
        ),
        api
      ),
      order: (k: string) => ((orderBy = k), api),
      limit: (n: number) => ((limit = n), api),
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r)),
        )
        if (mode === 'update') {
          for (const r of rows) Object.assign(r, patch)
          updates.push({ table, patch, matched: rows.length })
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null })
        }
        const sorted = orderBy
          ? [...rows].sort((a, b) =>
              String(a[orderBy as string]).localeCompare(
                String(b[orderBy as string]),
              ),
            )
          : rows
        return resolve({
          data: sorted.slice(0, limit).map((r) => ({ ...r })),
          error: null,
        })
      },
    }
    return api
  }
  return {
    client: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    updates,
  }
}

function tracker(id: string, o: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    created_by: OWNER,
    brand_name: 'Fernhill',
    brand_aliases: [],
    domain: 'fernhillstudio.example',
    competitors: [],
    location_code: 2840,
    language_code: 'en',
    engines: ['chatgpt'],
    schedule_interval: 'weekly',
    next_run_at: '2026-11-10T06:30:00.000Z',
    last_run_at: null,
    last_skip_reason: null,
    paused: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...o,
  }
}

const now = () => new Date('2026-11-12T08:00:00Z')
const allowAll: Required<ScheduledGateDeps> = {
  isConfigured: () => true,
  isMember: async () => true,
  isFreePlan: async () => false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.getLiveRun.mockResolvedValue(null)
  h.failIfStuck.mockResolvedValue(false)
  h.createRun.mockImplementation(
    async (_svc, t: Row, opts: { runId: string }) => ({
      ok: true,
      run: { id: opts.runId, tracker_id: t.id },
      estimate: {},
    }),
  )
  h.dispatchRun.mockResolvedValue(true)
})

describe('scheduledRunGate', () => {
  const svc = {} as SupabaseClient
  const t = {
    workspace_id: WS,
    created_by: OWNER,
    paused: false,
    schedule_interval: 'weekly',
  }

  it('lets a paying member’s schedule through', async () => {
    expect(await scheduledRunGate(svc, t, allowAll)).toEqual({ ok: true })
  })

  const cases: Array<
    [string, ScheduledGateDeps, Parameters<typeof scheduledRunGate>[1]]
  > = [
    ['not_configured', { ...allowAll, isConfigured: () => false }, t],
    ['paused', allowAll, { ...t, paused: true }],
    ['schedule_off', allowAll, { ...t, schedule_interval: 'off' }],
    ['creator_gone', allowAll, { ...t, created_by: null }],
    ['creator_not_member', { ...allowAll, isMember: async () => false }, t],
    ['free_plan', { ...allowAll, isFreePlan: async () => true }, t],
    [
      'plan_unreadable',
      {
        ...allowAll,
        isFreePlan: async () => {
          throw new Error('rpc down')
        },
      },
      t,
    ],
  ]
  it.each(cases)('refuses: %s', async (reason, deps, input) => {
    const out = await scheduledRunGate(svc, input, deps)
    expect(out).toMatchObject({ ok: false, reason })
    expect(out.ok === false && out.message.length).toBeGreaterThan(5)
  })

  it('checks the plan of the schedule’s owner, failing closed', async () => {
    const isFreePlan = vi.fn(async () => false)
    await scheduledRunGate(svc, t, { ...allowAll, isFreePlan })
    expect(isFreePlan).toHaveBeenCalledWith(OWNER)
  })
})

describe('advanceDueTracker', () => {
  it('moves the due time on once: a second tick holding the old value loses', async () => {
    const db = fakeDb({ seo_ai_tracker: [tracker('t1')] })
    const seen = {
      id: 't1',
      next_run_at: '2026-11-10T06:30:00.000Z',
      schedule_interval: 'weekly' as const,
    }
    expect(await advanceDueTracker(db.client, seen, now())).toBe(true)
    expect(await advanceDueTracker(db.client, seen, now())).toBe(false)
    // The weekly anchor is kept: whole weeks after the due time, in the future.
    const advanced = Date.parse(db.updates[0].patch.next_run_at as string)
    const week = 7 * 86_400_000
    expect((advanced - Date.parse(seen.next_run_at)) % week).toBe(0)
    expect(advanced).toBeGreaterThan(Date.now())
  })
})

describe('runDueTrackers', () => {
  it('starts one scheduled check per due tracker, for its due time, spending as the workspace', async () => {
    const db = fakeDb({
      seo_ai_tracker: [
        tracker('t1'),
        tracker('t2', { next_run_at: '2026-11-20T06:30:00.000Z' }),
      ],
    })
    const out = await runDueTrackers(db.client, {
      now,
      gate: async () => ({ ok: true }),
      newId: () => 'run-1',
    })
    expect(out.due).toBe(1)
    expect(out.started).toEqual([{ tracker_id: 't1', run_id: 'run-1' }])
    expect(h.createRun).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining({ id: 't1' }),
      {
        trigger: 'scheduled',
        startedBy: null,
        scheduledFor: '2026-11-10T06:30:00.000Z',
        runId: 'run-1',
      },
    )
    expect(h.dispatchRun).toHaveBeenCalledTimes(1)
  })

  it('two overlapping ticks start the due time once', async () => {
    const rows = [tracker('t1')]
    const db = fakeDb({ seo_ai_tracker: rows })
    // Both ticks read the tracker as due before either advances it.
    const seenBySecond = { ...rows[0] }
    await runDueTrackers(db.client, {
      now,
      gate: async () => ({ ok: true }),
      newId: () => 'run-1',
    })
    expect(
      await advanceDueTracker(db.client, seenBySecond as never, now()),
    ).toBe(false)
    expect(h.createRun).toHaveBeenCalledTimes(1)
  })

  it('writes a refusal as the skip reason and creates no check', async () => {
    const rows = [tracker('t1')]
    const db = fakeDb({ seo_ai_tracker: rows })
    const out = await runDueTrackers(db.client, {
      now,
      gate: async () => ({ ok: false, reason: 'free_plan', message: 'free' }),
    })
    expect(out.skipped).toEqual([{ tracker_id: 't1', reason: 'free_plan' }])
    expect(rows[0].last_skip_reason).toBe('free_plan')
    expect(h.createRun).not.toHaveBeenCalled()
    // Still advanced: a refused tracker moves on instead of staying due every hour.
    expect(rows[0].next_run_at).not.toBe('2026-11-10T06:30:00.000Z')
  })

  it('skips a tracker whose previous check is still running', async () => {
    h.getLiveRun.mockResolvedValue({ id: 'live', status: 'running' })
    const rows = [tracker('t1')]
    const out = await runDueTrackers(fakeDb({ seo_ai_tracker: rows }).client, {
      now,
      gate: async () => ({ ok: true }),
    })
    expect(out.skipped).toEqual([
      { tracker_id: 't1', reason: 'run_in_progress' },
    ])
    expect(rows[0].last_skip_reason).toBe('run_in_progress')
    expect(h.createRun).not.toHaveBeenCalled()
  })

  it('records a tracker without active prompts', async () => {
    h.createRun.mockResolvedValue({
      ok: false,
      code: 'NO_PROMPTS',
      message: 'none',
    })
    const rows = [tracker('t1')]
    await runDueTrackers(fakeDb({ seo_ai_tracker: rows }).client, {
      now,
      gate: async () => ({ ok: true }),
    })
    expect(rows[0].last_skip_reason).toBe('no_prompts')
    expect(h.dispatchRun).not.toHaveBeenCalled()
  })

  it('leaves paused trackers and schedules that are off alone', async () => {
    const db = fakeDb({
      seo_ai_tracker: [
        tracker('t1', { paused: true }),
        tracker('t2', { schedule_interval: 'off', next_run_at: null }),
      ],
    })
    const out = await runDueTrackers(db.client, {
      now,
      gate: async () => ({ ok: true }),
    })
    expect(out.due).toBe(0)
    expect(h.createRun).not.toHaveBeenCalled()
  })
})
