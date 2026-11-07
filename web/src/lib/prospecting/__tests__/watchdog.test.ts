/**
 * The stale-run watchdog (src/lib/prospecting/watchdog.ts).
 *
 * The engine writes every terminal status — unless the engine never runs, or
 * dies without a failure event. Then a row sits at queued/running/canceling
 * forever and the page shows "Cancelling…" for good. These tests pin the two
 * things that make the sweep safe: it only touches rows that have been SILENT
 * for STALE_RUN_MS (heartbeat = progress.updated_at → started_at →
 * created_at), and every write is a CAS on the status it observed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'

// The run's Activity row follows only a write that WON (Sequence row 6); the
// mirror's own suite covers what it writes.
const hoisted = vi.hoisted(() => ({ settleByRun: vi.fn(async () => {}) }))
vi.mock('@/lib/work/prospecting-run-mirror', () => ({ settleProspectingWorkByRun: hoisted.settleByRun }))
beforeEach(() => hoisted.settleByRun.mockClear())
import {
  STALE_RUN_ERROR,
  STALE_RUN_MS,
  isStaleRun,
  lastHeartbeatMs,
  staleOutcome,
  sweepStaleRuns,
  type StaleCandidateRow,
} from '../watchdog'

const NOW = new Date('2026-09-05T20:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

function row(over: Partial<StaleCandidateRow> = {}): StaleCandidateRow {
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    status: 'running',
    progress: {},
    started_at: null,
    created_at: minutesAgo(60),
    ...over,
  }
}

describe('lastHeartbeatMs / isStaleRun', () => {
  it('reads the progress heartbeat first, then the claim, then creation', () => {
    const created = minutesAgo(60)
    const started = minutesAgo(30)
    const beat = minutesAgo(2)
    expect(lastHeartbeatMs(row({ created_at: created }), NOW)).toBe(Date.parse(created))
    expect(lastHeartbeatMs(row({ created_at: created, started_at: started }), NOW)).toBe(
      Date.parse(started),
    )
    expect(
      lastHeartbeatMs(
        row({ created_at: created, started_at: started, progress: { updated_at: beat } }),
        NOW,
      ),
    ).toBe(Date.parse(beat))
  })

  it('is stale only after STALE_RUN_MS of silence', () => {
    expect(STALE_RUN_MS).toBe(15 * 60_000)
    expect(isStaleRun(row({ progress: { updated_at: minutesAgo(14) } }), NOW)).toBe(false)
    expect(isStaleRun(row({ progress: { updated_at: minutesAgo(15) } }), NOW)).toBe(true)
    // A fresh heartbeat on an OLD row is not stale: the engine is alive.
    expect(
      isStaleRun(row({ created_at: minutesAgo(600), progress: { updated_at: minutesAgo(1) } }), NOW),
    ).toBe(false)
  })

  it('treats an unparseable heartbeat as absent and bad creation as born now', () => {
    expect(isStaleRun(row({ progress: { updated_at: 'garbage' }, created_at: minutesAgo(20) }), NOW)).toBe(
      true,
    )
    expect(isStaleRun(row({ created_at: 'garbage' }), NOW)).toBe(false)
  })

  it('ends a stuck cancel as canceled and anything else as failed', () => {
    expect(staleOutcome('canceling')).toEqual({ status: 'canceled', error: null })
    expect(staleOutcome('running')).toEqual({ status: 'failed', error: STALE_RUN_ERROR })
    expect(staleOutcome('queued')).toEqual({ status: 'failed', error: STALE_RUN_ERROR })
  })
})

describe('sweepStaleRuns', () => {
  function world(rows: StaleCandidateRow[], written: unknown[] | ((q: Captured) => unknown[]) = (q) => [{ id: filterArgs(q, 'eq').find(([c]) => c === 'id')?.[1] }]) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table !== 'prospecting_run') return { data: null }
      if (q.op === 'update') return { data: typeof written === 'function' ? written(q) : written }
      return { data: rows }
    })
  }

  it('reads only live rows old enough to matter, oldest first, bounded', async () => {
    const { client, queries } = world([])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toEqual({ scanned: 0, stale: 0, failed: 0, canceled: 0, skipped: 0 })
    const read = queries[0]
    expect(read.op).toBe('select')
    expect(filterArgs(read, 'in')).toEqual([['status', ['queued', 'running', 'canceling']]])
    expect(filterArgs(read, 'lt')).toEqual([['created_at', minutesAgo(15)]])
    expect(filterArgs(read, 'limit')).toEqual([[200]])
  })

  it('fails a silent running run with the banner message, CAS on the status it saw', async () => {
    const { client, queries } = world([row({ id: 'dead', status: 'running', started_at: minutesAgo(40) })])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toMatchObject({ scanned: 1, stale: 1, failed: 1, canceled: 0, skipped: 0 })

    const write = queries.find((q) => q.op === 'update')!
    expect(write.payload).toEqual({
      status: 'failed',
      error: STALE_RUN_ERROR,
      finished_at: NOW.toISOString(),
    })
    expect(filterArgs(write, 'eq')).toContainEqual(['id', 'dead'])
    expect(filterArgs(write, 'eq')).toContainEqual(['status', 'running'])
    expect(hasWorkspaceFilter(write, 'ws-1')).toBe(true)
    expect(hoisted.settleByRun).toHaveBeenCalledWith(client, 'dead', { status: 'failed', error: STALE_RUN_ERROR })
  })

  it('ends a stuck cancel as canceled, keeping its error untouched', async () => {
    const { client, queries } = world([
      row({ id: 'stuck', status: 'canceling', progress: { updated_at: minutesAgo(16) } }),
    ])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toMatchObject({ stale: 1, canceled: 1, failed: 0 })
    const write = queries.find((q) => q.op === 'update')!
    expect(write.payload).toEqual({ status: 'canceled', finished_at: NOW.toISOString() })
    expect(filterArgs(write, 'eq')).toContainEqual(['status', 'canceling'])
    expect(hoisted.settleByRun).toHaveBeenCalledTimes(1)
    expect(hoisted.settleByRun.mock.calls[0]).toMatchObject([client, 'stuck', { status: 'canceled' }])
  })

  it('fails a run that was never claimed', async () => {
    const { client, queries } = world([row({ id: 'never', status: 'queued', created_at: minutesAgo(20) })])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toMatchObject({ stale: 1, failed: 1 })
    expect(queries.find((q) => q.op === 'update')!.payload).toMatchObject({ status: 'failed' })
  })

  it('leaves a run alone while its heartbeat is fresh, however old the row', async () => {
    const { client, queries } = world([
      row({ created_at: minutesAgo(120), progress: { updated_at: minutesAgo(3) } }),
    ])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toMatchObject({ scanned: 1, stale: 0 })
    expect(queries.some((q) => q.op === 'update')).toBe(false)
    expect(hoisted.settleByRun).not.toHaveBeenCalled()
  })

  it('counts a row the engine settled in the gap as skipped, not as a write', async () => {
    // The CAS matched nothing: the engine wrote its own ending between the
    // read and the update. The engine wins, always.
    const { client } = world([row({ id: 'raced', started_at: minutesAgo(40) })], [])
    const result = await sweepStaleRuns(client, NOW)
    expect(result).toMatchObject({ stale: 1, skipped: 1, failed: 0, canceled: 0 })
    // The engine's ending stands, and so does the Activity row it settled.
    expect(hoisted.settleByRun).not.toHaveBeenCalled()
  })

  it('surfaces a failed read rather than reporting a clean sweep', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null, error: { message: 'db down' } }))
    await expect(sweepStaleRuns(client, NOW)).rejects.toThrow(/watchdog read failed/)
  })
})
