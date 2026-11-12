/**
 * The schedule's cron pass: which trackers are due, the compare-and-set that
 * makes two overlapping ticks start one check, the gate's outcomes, the due
 * time given back while a check still runs (and a stuck one reaped, so it
 * never blocks the schedule for good), and the per-tick budget. The
 * store is in memory, holding migration 594's two unique indexes on runs; the
 * Supabase store's own filters are checked against a recording client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GateDeps } from '../gate'
import type { RunRow } from '../queries'
import type { InsertRunResult } from '../runs'
import {
  createScheduleStore,
  runScheduledRankChecks,
  SCHEDULED_SEARCH_BUDGET,
  type DueTracker,
  type ScheduleStore,
} from '../schedule'

const NOW = new Date('2026-11-12T10:07:00.000Z')
const DUE = '2026-11-12T09:30:00.000Z'
const WS = '00000000-0000-4000-8000-000000000001'
const PERSON = '00000000-0000-4000-8000-0000000000aa'

function due(
  id: string,
  overrides: Partial<DueTracker & { last_skip_reason: string | null }> = {},
): DueTracker & { last_skip_reason: string | null } {
  return {
    id,
    workspace_id: WS,
    created_by: PERSON,
    devices: 'mobile',
    serp_depth: 20,
    schedule_interval: 'daily',
    next_check_at: DUE,
    paused: false,
    keyword_count: 3,
    last_skip_reason: null,
    ...overrides,
  }
}

function memorySchedule(
  trackers: Array<DueTracker & { last_skip_reason: string | null }>,
  opts: {
    liveTrackers?: string[]
    /** Live checks that are stuck: the reap fails them. */
    stuckTrackers?: string[]
    dispatchFails?: boolean
  } = {},
) {
  const rows = new Map(trackers.map((t) => [t.id, { ...t }]))
  const runs: Array<{
    tracker_id: string
    scheduled_for: string
    status: string
  }> = (opts.liveTrackers ?? []).map((id) => ({
    tracker_id: id,
    scheduled_for: '',
    status: 'running',
  }))
  const dispatched: string[] = []
  const reaped: string[] = []
  const store: ScheduleStore = {
    async listDue(nowIso, limit) {
      return [...rows.values()]
        .filter(
          (t) =>
            !t.paused &&
            t.schedule_interval !== 'manual' &&
            t.next_check_at !== null &&
            t.next_check_at <= nowIso,
        )
        .sort((a, b) =>
          (a.next_check_at ?? '').localeCompare(b.next_check_at ?? ''),
        )
        .slice(0, limit)
        .map((t) => ({ ...t }))
    },
    async advance(tracker, observed, next, skipReason) {
      // Let the other tick interleave between its read and this write.
      await Promise.resolve()
      const row = rows.get(tracker.id)
      if (
        !row ||
        row.paused ||
        row.schedule_interval !== tracker.schedule_interval ||
        row.next_check_at !== observed
      )
        return false
      row.next_check_at = next
      if (skipReason !== undefined) row.last_skip_reason = skipReason
      return true
    },
    async keywords(tracker) {
      return Array.from(
        { length: rows.get(tracker.id)!.keyword_count },
        (_, i) => `keyword ${i}`,
      )
    },
    async insertRun(tracker, scheduledFor): Promise<InsertRunResult> {
      if (
        runs.some(
          (r) =>
            r.tracker_id === tracker.id &&
            (r.status === 'queued' || r.status === 'running'),
        )
      )
        return { ok: false, reason: 'live' }
      if (
        runs.some(
          (r) =>
            r.tracker_id === tracker.id && r.scheduled_for === scheduledFor,
        )
      )
        return { ok: false, reason: 'due_time_taken' }
      runs.push({
        tracker_id: tracker.id,
        scheduled_for: scheduledFor,
        status: 'queued',
      })
      return {
        ok: true,
        run: {
          id: `run-${runs.length}`,
          tracker_id: tracker.id,
          workspace_id: tracker.workspace_id,
        } as RunRow,
      }
    },
    async dispatch(run) {
      dispatched.push(run.tracker_id)
      return !opts.dispatchFails
    },
    async reapStuck(tracker) {
      if (!opts.stuckTrackers?.includes(tracker.id)) return false
      const live = runs.find(
        (r) =>
          r.tracker_id === tracker.id &&
          (r.status === 'queued' || r.status === 'running'),
      )
      if (!live) return false
      live.status = 'failed'
      reaped.push(tracker.id)
      return true
    },
  }
  return { store, rows, runs, dispatched, reaped }
}

const okGate: GateDeps = {
  configured: () => true,
  memberRole: async () => 'member',
  onFreePlan: async () => false,
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runScheduledRankChecks', () => {
  it('starts a due check: the anchor moves one step from its due time (not from now), the run carries the due time', async () => {
    const mem = memorySchedule([due('t1')])
    const out = await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(out).toMatchObject({ due: 1, started: 1, lost: 0, errors: 0 })
    expect(mem.rows.get('t1')!.next_check_at).toBe('2026-11-13T09:30:00.000Z')
    expect(mem.runs).toEqual([
      { tracker_id: 't1', scheduled_for: DUE, status: 'queued' },
    ])
    expect(mem.dispatched).toEqual(['t1'])
  })

  it('selects only due, unpaused, scheduled trackers, oldest due first', async () => {
    const mem = memorySchedule([
      due('later', { next_check_at: '2026-11-12T10:00:00.000Z' }),
      due('future', { next_check_at: '2026-11-12T10:30:00.000Z' }),
      due('paused', { paused: true }),
      due('off', { schedule_interval: 'manual', next_check_at: null }),
      due('first', { next_check_at: '2026-11-11T09:00:00.000Z' }),
    ])
    await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(mem.dispatched).toEqual(['first', 'later'])
  })

  it('two overlapping ticks start the check once', async () => {
    const mem = memorySchedule([due('t1'), due('t2')])
    const [a, b] = await Promise.all([
      runScheduledRankChecks({ store: mem.store, gate: okGate }),
      runScheduledRankChecks({ store: mem.store, gate: okGate }),
    ])
    expect(a.started + b.started).toBe(2)
    expect(a.lost + b.lost).toBe(2)
    expect(mem.runs.map((r) => r.tracker_id).sort()).toEqual(['t1', 't2'])
  })

  it('the run’s unique due time is a second fence: a due time already started starts nothing', async () => {
    const mem = memorySchedule([due('t1')])
    mem.runs.push({ tracker_id: 't1', scheduled_for: DUE, status: 'completed' })
    const out = await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(out).toMatchObject({ started: 0, duplicate: 1 })
    expect(mem.dispatched).toEqual([])
    // Not given back: that due time is spent.
    expect(mem.rows.get('t1')!.next_check_at).toBe('2026-11-13T09:30:00.000Z')
  })

  it('a refusal of the gate skips this check: the schedule moves on and keeps the reason', async () => {
    const mem = memorySchedule([due('t1')])
    const out = await runScheduledRankChecks({
      store: mem.store,
      gate: { ...okGate, onFreePlan: async () => true },
    })
    expect(out).toMatchObject({ started: 0, skipped: 1 })
    expect(mem.rows.get('t1')).toMatchObject({
      next_check_at: '2026-11-13T09:30:00.000Z',
      last_skip_reason: 'free_plan',
    })
    expect(mem.runs).toEqual([])
  })

  it('a tracker with no keywords is skipped with its reason', async () => {
    const mem = memorySchedule([due('t1', { keyword_count: 0 })])
    await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(mem.rows.get('t1')!.last_skip_reason).toBe('no_keywords')
  })

  it('a standing it can’t read leaves the tracker due and spends nothing', async () => {
    const mem = memorySchedule([due('t1')])
    const out = await runScheduledRankChecks({
      store: mem.store,
      gate: {
        ...okGate,
        onFreePlan: async () => {
          throw new Error('rpc down')
        },
      },
    })
    expect(out).toMatchObject({ started: 0, unreadable: 1 })
    expect(mem.rows.get('t1')!.next_check_at).toBe(DUE)
    expect(mem.runs).toEqual([])
  })

  it('a check still running gets its due time back, to start on a later tick', async () => {
    const mem = memorySchedule([due('t1', { last_skip_reason: 'free_plan' })], {
      liveTrackers: ['t1'],
    })
    const out = await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(out).toMatchObject({ started: 0, already_running: 1, reaped: 0 })
    expect(mem.rows.get('t1')!.next_check_at).toBe(DUE)
    expect(mem.reaped).toEqual([])
  })

  it('a stuck check is reaped, so the next tick starts the check instead of waiting on it forever', async () => {
    const mem = memorySchedule([due('t1')], {
      liveTrackers: ['t1'],
      stuckTrackers: ['t1'],
    })
    const first = await runScheduledRankChecks({
      store: mem.store,
      gate: okGate,
    })
    expect(first).toMatchObject({ started: 0, already_running: 1, reaped: 1 })
    expect(mem.reaped).toEqual(['t1'])
    // Its due time is given back, and the next tick starts it.
    expect(mem.rows.get('t1')!.next_check_at).toBe(DUE)
    const second = await runScheduledRankChecks({
      store: mem.store,
      gate: okGate,
    })
    expect(second).toMatchObject({ started: 1 })
    expect(mem.dispatched).toEqual(['t1'])
  })

  it('a send that fails leaves the schedule advanced (no storm of due trackers after an outage)', async () => {
    const mem = memorySchedule([due('t1')], { dispatchFails: true })
    const out = await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(out).toMatchObject({ started: 0, errors: 1 })
    expect(mem.rows.get('t1')!.next_check_at).toBe('2026-11-13T09:30:00.000Z')
  })

  it('admits work up to the tick’s budget; the first start is always admitted', async () => {
    const big = SCHEDULED_SEARCH_BUDGET + 10
    const mem = memorySchedule([
      due('huge', {
        keyword_count: big,
        next_check_at: '2026-11-12T08:00:00.000Z',
      }),
      due('small', { keyword_count: 2 }),
    ])
    const out = await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(out).toMatchObject({ started: 1, stopped_by_budget: true })
    expect(mem.dispatched).toEqual(['huge'])
    // The rest stays due for the next tick.
    expect(mem.rows.get('small')!.next_check_at).toBe(DUE)
  })

  it('a weekly tracker due days ago moves to its next slot on the same weekday', async () => {
    const mem = memorySchedule([
      due('t1', {
        schedule_interval: 'weekly',
        next_check_at: '2026-11-02T09:30:00.000Z',
      }),
    ])
    await runScheduledRankChecks({ store: mem.store, gate: okGate })
    expect(mem.rows.get('t1')!.next_check_at).toBe('2026-11-16T09:30:00.000Z')
  })
})

describe('createScheduleStore', () => {
  function recordingClient(result: { data: unknown; error: null }) {
    const calls: Array<[string, unknown[]]> = []
    const builder: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then')
            return (resolve: (v: unknown) => void) => resolve(result)
          return (...args: unknown[]) => {
            calls.push([prop, args])
            return builder
          }
        },
      },
    )
    const client = {
      from: (table: string) => (calls.push(['from', [table]]), builder),
    }
    return { client, calls }
  }

  it('the due scan: unpaused, scheduled, due by now, oldest first, bounded, with the keyword count', async () => {
    const { client, calls } = recordingClient({
      data: [{ ...due('t1'), keyword_count: [{ count: 4 }] }],
      error: null,
    })
    const rows = await createScheduleStore(client as never).listDue(
      NOW.toISOString(),
      100,
    )
    expect(rows[0].keyword_count).toBe(4)
    expect(calls).toEqual([
      ['from', ['seo_rank_tracker']],
      [
        'select',
        [expect.stringContaining('keyword_count:seo_rank_keyword(count)')],
      ],
      ['eq', ['paused', false]],
      ['neq', ['schedule_interval', 'manual']],
      ['not', ['next_check_at', 'is', null]],
      ['lte', ['next_check_at', NOW.toISOString()]],
      ['order', ['next_check_at', { ascending: true }]],
      ['limit', [100]],
    ])
  })

  it('the advance is a compare-and-set on the value read, the schedule and the pause', async () => {
    const { client, calls } = recordingClient({
      data: [{ id: 't1' }],
      error: null,
    })
    const won = await createScheduleStore(client as never).advance(
      due('t1'),
      DUE,
      '2026-11-13T09:30:00.000Z',
      null,
    )
    expect(won).toBe(true)
    const update = calls.find(([m]) => m === 'update')![1][0] as Record<
      string,
      unknown
    >
    expect(update).toMatchObject({
      next_check_at: '2026-11-13T09:30:00.000Z',
      last_skip_reason: null,
    })
    expect(calls.filter(([m]) => m === 'eq').map(([, a]) => a)).toEqual([
      ['id', 't1'],
      ['workspace_id', WS],
      ['schedule_interval', 'daily'],
      ['paused', false],
      ['next_check_at', DUE],
    ])
  })

  it('the reap fails a stuck live check and tells the lane to stop it; a healthy one is left', async () => {
    const stuck = {
      id: 'run-1',
      status: 'running',
      created_at: '2026-11-12T01:00:00.000Z',
      started_at: '2026-11-12T01:00:00.000Z',
    }
    const { client, calls } = recordingClient({ data: [stuck], error: null })
    const send = vi.fn(async () => undefined)
    expect(
      await createScheduleStore(client as never, send).reapStuck(due('t1')),
    ).toBe(true)
    expect(calls.find(([m]) => m === 'update')![1][0]).toMatchObject({
      status: 'failed',
      error_code: 'STUCK',
    })
    expect(send).toHaveBeenCalledWith({
      name: 'seo/rank-check.cancel',
      data: { runId: 'run-1' },
    })

    const healthy = recordingClient({
      data: [{ ...stuck, started_at: '2026-11-12T09:00:00.000Z' }],
      error: null,
    })
    const quiet = vi.fn(async () => undefined)
    expect(
      await createScheduleStore(healthy.client as never, quiet).reapStuck(
        due('t1'),
      ),
    ).toBe(false)
    expect(quiet).not.toHaveBeenCalled()
    expect(healthy.calls.some(([m]) => m === 'update')).toBe(false)
  })

  it('a lost compare-and-set (no row matched) says so', async () => {
    const { client } = recordingClient({ data: [], error: null })
    expect(
      await createScheduleStore(client as never).advance(due('t1'), DUE, 'x'),
    ).toBe(false)
  })
})
