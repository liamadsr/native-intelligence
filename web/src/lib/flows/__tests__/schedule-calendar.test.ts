/**
 * Tests for the calendar-anchored clock (GEN-136) — computeNextCalendarRun.
 *
 * Two query shapes hit `local_calendar_event`:
 *   - the occurrence scan: .select(...).eq(user).gt(start).lte(horizon)
 *       .order(start).limit(500)   → resolves { data: rows }
 *   - the staleness probe:  .select('synced_at').eq(user)
 *       .order(synced_at desc).limit(1).maybeSingle()  → resolves { data }
 * The mock distinguishes them by their terminal method (thenable vs maybeSingle).
 */
import { describe, it, expect } from 'vitest'
import {
  computeNextCalendarRun,
  decideCalendarAction,
  normalizeTitle,
  CALENDAR_STALE_AFTER_MS,
} from '../schedule-calendar'
import type { CalendarEventTriggerConfig } from '../types'

interface Occurrence {
  title: string
  start_at: string
}

/**
 * Build a fake service client over a fixed set of the run-as user's upcoming
 * occurrences + a fixed newest synced_at. The occurrence scan filters by the
 * gt/lte start bounds it's given; the staleness probe returns `newestSyncedAt`.
 */
function mockCalendar(opts: {
  occurrences?: Occurrence[]
  newestSyncedAt?: string | null
  /** Force the occurrence read to error (tests the throw path). */
  occurrenceError?: string
  /** Force the staleness probe (.maybeSingle) to error (tests fail-safe). */
  stalenessError?: string
}) {
  const occurrences = opts.occurrences ?? []
  const from = () => {
    let gtStart: string | null = null
    let lteStart: string | null = null
    const chain: Record<string, unknown> = {}
    const passthrough = (col?: string, val?: unknown) => {
      if (col === 'start_at' && typeof val === 'string') {
        // .gt('start_at', x) then .lte('start_at', y): first sets gt, second lte
        if (gtStart === null) gtStart = val
        else lteStart = val
      }
      return chain
    }
    for (const m of ['select', 'eq', 'gt', 'lte', 'order']) chain[m] = passthrough
    // Occurrence scan terminates in .limit(N) and is awaited directly.
    chain.limit = () => {
      if (opts.occurrenceError) {
        return Promise.resolve({ data: null, error: { message: opts.occurrenceError } })
      }
      const rows = occurrences.filter((o) => {
        if (gtStart && !(o.start_at > gtStart)) return false
        if (lteStart && !(o.start_at <= lteStart)) return false
        return true
      })
      // The staleness probe also ends in .limit(1) but then calls .maybeSingle().
      // Return a thenable that ALSO exposes maybeSingle so both paths work.
      const result: Record<string, unknown> = {
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(res),
        maybeSingle: () =>
          opts.stalenessError
            ? Promise.resolve({ data: null, error: { message: opts.stalenessError } })
            : Promise.resolve({
                data:
                  opts.newestSyncedAt === null || opts.newestSyncedAt === undefined
                    ? null
                    : { synced_at: opts.newestSyncedAt },
                error: null,
              }),
      }
      return result
    }
    return chain
  }
  return { from } as never
}

const NOW = new Date('2026-07-02T12:00:00.000Z')
const FRESH_SYNC = new Date(NOW.getTime() - 60_000).toISOString() // synced 1 min ago

function cfg(offset: number, title = 'Couples Counseling'): CalendarEventTriggerConfig {
  return { kind: 'calendar_event', event_title: title, offset_minutes: offset }
}

describe('normalizeTitle', () => {
  it('lowercases and trims', () => {
    expect(normalizeTitle('  Couples Counseling  ')).toBe('couples counseling')
    expect(normalizeTitle('COUPLES counseling')).toBe('couples counseling')
  })
})

describe('computeNextCalendarRun', () => {
  it('fires offset-minutes before the next matching occurrence', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: 'Couples Counseling', start_at: '2026-07-02T18:00:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    // 18:00 − 30 min = 17:30
    expect(r.next?.toISOString()).toBe('2026-07-02T17:30:00.000Z')
    expect(r.reason).toBeUndefined()
  })

  it('supports a positive (after) offset', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: 'Standup', start_at: '2026-07-02T15:00:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(15, 'Standup'), NOW, svc, 'u1')
    expect(r.next?.toISOString()).toBe('2026-07-02T15:15:00.000Z')
  })

  it('matches the title case-insensitively and ignoring surrounding whitespace', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: '  couples COUNSELING ', start_at: '2026-07-02T18:00:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(0), NOW, svc, 'u1')
    expect(r.next?.toISOString()).toBe('2026-07-02T18:00:00.000Z')
  })

  it('does NOT match a different title', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: 'Couples Counselling', start_at: '2026-07-02T18:00:00.000Z' }], // typo'd title
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('no_occurrence')
  })

  it('skips an occurrence whose fire window (offset before start) already passed, to the next one', async () => {
    // First occurrence starts in 10 min; "30 min before" is 20 min in the PAST →
    // skip. Second occurrence a week later fires at start−30.
    const svc = mockCalendar({
      occurrences: [
        { title: 'Couples Counseling', start_at: '2026-07-02T12:10:00.000Z' },
        { title: 'Couples Counseling', start_at: '2026-07-09T18:00:00.000Z' },
      ],
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next?.toISOString()).toBe('2026-07-09T17:30:00.000Z')
  })

  it('returns dormant when every matching occurrence has a past fire instant', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: 'Couples Counseling', start_at: '2026-07-02T12:10:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
    })
    // Only occurrence is +10 min out; a −30 offset puts the fire 20 min in the past.
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('no_occurrence')
  })

  it('returns no_occurrence when the cache is fresh AND has future events but none match the title', async () => {
    // A future event exists (fresh cache) but with a different title → the
    // series ended / event renamed, genuinely no occurrence.
    const svc = mockCalendar({
      occurrences: [{ title: 'Some Other Meeting', start_at: '2026-07-05T18:00:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('no_occurrence')
  })

  it('returns beyond_sync_horizon when the cache is fresh but holds NO future events (narrow sync window)', async () => {
    // Fresh sync, zero future rows → the anchored occurrence is further out than
    // the desktop synced. Self-heals; must NOT be mislabeled 'no_occurrence'.
    const svc = mockCalendar({ occurrences: [], newestSyncedAt: FRESH_SYNC })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('beyond_sync_horizon')
  })

  it('fails SAFE (dormant) when the staleness probe errors, rather than firing on unverified data', async () => {
    const svc = mockCalendar({
      occurrences: [{ title: 'Couples Counseling', start_at: '2026-07-02T18:00:00.000Z' }],
      newestSyncedAt: FRESH_SYNC,
      stalenessError: 'probe blip',
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('stale_calendar')
  })

  it('returns stale_calendar when the cache has not synced recently, even with a matching occurrence', async () => {
    const staleSync = new Date(NOW.getTime() - CALENDAR_STALE_AFTER_MS - 60_000).toISOString()
    const svc = mockCalendar({
      occurrences: [{ title: 'Couples Counseling', start_at: '2026-07-02T18:00:00.000Z' }],
      newestSyncedAt: staleSync,
    })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('stale_calendar')
  })

  it('reports stale_calendar (not no_occurrence) when there are no rows at all', async () => {
    const svc = mockCalendar({ occurrences: [], newestSyncedAt: null })
    const r = await computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('stale_calendar')
  })

  it('throws on a hard occurrence-read failure (never silently dormant)', async () => {
    const svc = mockCalendar({ occurrenceError: 'connection reset', newestSyncedAt: FRESH_SYNC })
    await expect(computeNextCalendarRun(cfg(-30), NOW, svc, 'u1')).rejects.toThrow(/calendar read failed/)
  })

  it('returns dormant for an empty anchor title', async () => {
    const svc = mockCalendar({ occurrences: [], newestSyncedAt: FRESH_SYNC })
    const r = await computeNextCalendarRun(cfg(-30, '   '), NOW, svc, 'u1')
    expect(r.next).toBeNull()
    expect(r.reason).toBe('no_occurrence')
  })
})

describe('decideCalendarAction (cron-tick per-flow decision)', () => {
  const FUTURE = new Date(NOW.getTime() + 60 * 60_000) // +1h
  const NEXT_WEEK = new Date(NOW.getTime() + 7 * 24 * 60 * 60_000)

  it('FIRES when the stored next_run_at has arrived, advancing to the recomputed next', () => {
    const stored = new Date(NOW.getTime() - 60_000).toISOString() // due 1 min ago
    const d = decideCalendarAction({ storedNextRunAt: stored, recomputed: NEXT_WEEK, now: NOW })
    expect(d.action).toBe('fire')
    expect(d.advanceTo).toBe(NEXT_WEEK.toISOString())
  })

  it('FIRES the final occurrence and advances to null when no next remains', () => {
    const stored = new Date(NOW.getTime() - 60_000).toISOString()
    const d = decideCalendarAction({ storedNextRunAt: stored, recomputed: null, now: NOW })
    expect(d.action).toBe('fire')
    expect(d.advanceTo).toBeNull()
  })

  it('fires when stored equals exactly now (boundary is due)', () => {
    const d = decideCalendarAction({ storedNextRunAt: NOW.toISOString(), recomputed: NEXT_WEEK, now: NOW })
    expect(d.action).toBe('fire')
  })

  it('RE-ANCHORS when not due but the true next fire drifted (meeting moved)', () => {
    const stored = FUTURE.toISOString()
    const moved = new Date(NOW.getTime() + 2 * 60 * 60_000) // moved to +2h
    const d = decideCalendarAction({ storedNextRunAt: stored, recomputed: moved, now: NOW })
    expect(d.action).toBe('re-anchor')
    expect(d.advanceTo).toBe(moved.toISOString())
  })

  it('goes DORMANT when not due and the recompute yields no occurrence', () => {
    const d = decideCalendarAction({ storedNextRunAt: FUTURE.toISOString(), recomputed: null, now: NOW })
    expect(d.action).toBe('dormant')
    expect(d.advanceTo).toBeNull()
  })

  it('NOOPs when not due and the stored value already matches the recompute', () => {
    const d = decideCalendarAction({ storedNextRunAt: FUTURE.toISOString(), recomputed: FUTURE, now: NOW })
    expect(d.action).toBe('noop')
  })

  it('NOOPs on the same instant in PostgREST timestamptz form (+00:00, no millis)', () => {
    const stored = FUTURE.toISOString().replace(/\.\d{3}Z$/, '+00:00')
    const d = decideCalendarAction({ storedNextRunAt: stored, recomputed: FUTURE, now: NOW })
    expect(d.action).toBe('noop')
    expect(d.advanceTo).toBe(stored)
  })

  it('NOOPs when both stored and recomputed are null (already dormant)', () => {
    const d = decideCalendarAction({ storedNextRunAt: null, recomputed: null, now: NOW })
    expect(d.action).toBe('noop')
    expect(d.advanceTo).toBeNull()
  })

  it('RE-ANCHORS from null when a fresh occurrence appears (dormant → future)', () => {
    const d = decideCalendarAction({ storedNextRunAt: null, recomputed: FUTURE, now: NOW })
    expect(d.action).toBe('re-anchor')
    expect(d.advanceTo).toBe(FUTURE.toISOString())
  })
})
