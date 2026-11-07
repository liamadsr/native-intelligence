import { describe, it, expect } from 'vitest'
import { TZDate } from '@date-fns/tz'
import {
  computeEditedNextSendAt,
  computeNextSendAt,
  normalizeWindow,
  DEFAULT_SEND_WINDOW,
  MIN_EDIT_RESCHEDULE_MS,
} from '@/lib/sequences/schedule'

const TZ = 'America/Los_Angeles'

/** Build a UTC instant from LA wall-clock parts */
function la(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(new TZDate(y, mo - 1, d, h, mi, 0, 0, TZ).getTime())
}

/** Read back an instant as LA wall-clock for assertions */
function laParts(d: Date) {
  const z = new TZDate(d.getTime(), TZ)
  return { day: z.getDate(), hour: z.getHours(), minute: z.getMinutes(), weekday: z.getDay() }
}

describe('computeNextSendAt', () => {
  it('adds calendar days and keeps an in-window time', () => {
    // Tue Aug 11 2026 10:00 LA + 3 calendar days = Fri Aug 14 10:00
    const next = computeNextSendAt({
      from: la(2026, 8, 11, 10),
      delayDays: 3,
      delayUnit: 'calendar',
      timezone: TZ,
    })
    expect(laParts(next)).toMatchObject({ day: 14, hour: 10 })
  })

  it('counts business days over a weekend', () => {
    // Fri Aug 14 2026 10:00 + 3 business days = Wed Aug 19 10:00
    const next = computeNextSendAt({
      from: la(2026, 8, 14, 10),
      delayDays: 3,
      delayUnit: 'business',
      timezone: TZ,
    })
    expect(laParts(next)).toMatchObject({ day: 19, hour: 10 })
  })

  it('snaps a weekend landing forward to Monday open', () => {
    // Thu Aug 13 + 2 calendar days = Sat Aug 15 → Mon Aug 17 09:00
    const next = computeNextSendAt({
      from: la(2026, 8, 13, 10),
      delayDays: 2,
      delayUnit: 'calendar',
      timezone: TZ,
    })
    expect(laParts(next)).toMatchObject({ day: 17, hour: 9 })
  })

  it('snaps an after-close landing to the next day open', () => {
    // Launch Tue Aug 11 17:30 (past 16:00 close), 0 delay → Wed Aug 12 09:00
    const next = computeNextSendAt({
      from: la(2026, 8, 11, 17, 30),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
    })
    expect(laParts(next)).toMatchObject({ day: 12, hour: 9 })
  })

  it('snaps a before-open landing to the same day open', () => {
    const next = computeNextSendAt({
      from: la(2026, 8, 11, 6, 15),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
    })
    expect(laParts(next)).toMatchObject({ day: 11, hour: 9 })
  })

  it('clamps jitter inside the window close', () => {
    // Tue 15:58 + 10min jitter must NOT spill past 16:00
    const next = computeNextSendAt({
      from: la(2026, 8, 11, 15, 58),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
      jitterMs: 10 * 60_000,
    })
    const parts = laParts(next)
    expect(parts.day).toBe(11)
    expect(parts.hour).toBeLessThan(16)
  })

  it('applies jitter when there is headroom', () => {
    const next = computeNextSendAt({
      from: la(2026, 8, 11, 10, 0),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
      jitterMs: 5 * 60_000,
    })
    expect(laParts(next)).toMatchObject({ day: 11, hour: 10, minute: 5 })
  })

  it('is DST-safe: wall-clock hour survives the fall-back transition', () => {
    // Fri Oct 30 2026 10:00 LA (PDT) + 3 calendar days crosses Nov 1 (PST).
    const next = computeNextSendAt({
      from: la(2026, 10, 30, 10),
      delayDays: 3,
      delayUnit: 'calendar',
      timezone: TZ,
    })
    // Mon Nov 2 — still 10:00 LA wall-clock despite the offset change.
    expect(laParts(next)).toMatchObject({ day: 2, hour: 10 })
  })

  it('keeps delay 0 and delay 1 on distinct days for a Saturday launch', () => {
    // Sat Aug 15 2026 10:00 launch. Delay 0 → Mon Aug 17; delay 1 → Tue Aug 18.
    // Without advancing to the next allowed day before counting, both collapse
    // onto Monday and consecutive steps double-send same-day.
    const from = la(2026, 8, 15, 10)
    const step0 = computeNextSendAt({ from, delayDays: 0, delayUnit: 'business', timezone: TZ })
    const step1 = computeNextSendAt({ from, delayDays: 1, delayUnit: 'business', timezone: TZ })
    expect(laParts(step0)).toMatchObject({ day: 17, hour: 10 })
    expect(laParts(step1)).toMatchObject({ day: 18, hour: 10 })
    expect(laParts(step0).day).not.toBe(laParts(step1).day)
  })

  it('re-validates a spring-forward start_hour candidate against the window', () => {
    // LA 2026 springs forward Sun Mar 8: 2:00 does not exist and materializes
    // as 3:00. With window [2, 3) the constructed open candidate is OUTSIDE
    // the window and must roll to Mon Mar 9 02:00, not be returned as-is.
    const next = computeNextSendAt({
      from: la(2026, 3, 8, 0, 30),
      delayDays: 0,
      delayUnit: 'calendar',
      timezone: TZ,
      window: { days: [1, 2, 3, 4, 5, 6, 7], start_hour: 2, end_hour: 3 },
    })
    const parts = laParts(next)
    expect(parts).toMatchObject({ day: 9, hour: 2 })
    expect(parts.hour).toBeGreaterThanOrEqual(2)
    expect(parts.hour).toBeLessThan(3)
  })

  it('accepts a spring-forward materialized hour that is still in-window', () => {
    // Same missing-hour day, but window [2, 5): the 2:00 candidate materializes
    // as 3:00, which the loop re-validates and accepts.
    const next = computeNextSendAt({
      from: la(2026, 3, 8, 0, 30),
      delayDays: 0,
      delayUnit: 'calendar',
      timezone: TZ,
      window: { days: [1, 2, 3, 4, 5, 6, 7], start_hour: 2, end_hour: 5 },
    })
    expect(laParts(next)).toMatchObject({ day: 8, hour: 3 })
  })

  it('respects a custom window (weekend-inclusive)', () => {
    const next = computeNextSendAt({
      from: la(2026, 8, 13, 10), // Thu + 2 = Sat, allowed by this window
      delayDays: 2,
      delayUnit: 'calendar',
      timezone: TZ,
      window: { days: [1, 2, 3, 4, 5, 6, 7], start_hour: 8, end_hour: 20 },
    })
    expect(laParts(next)).toMatchObject({ day: 15, hour: 10 })
  })
})

describe('computeEditedNextSendAt — edits never burst', () => {
  it('keeps a comfortably-future recompute unchanged', () => {
    // now = Tue Aug 11 2026 10:00; last send Mon Aug 10 10:00 + 3 business
    // days = Thu Aug 13 10:00, far past the floor — returned as-is.
    const next = computeEditedNextSendAt({
      from: la(2026, 8, 10, 10),
      delayDays: 3,
      delayUnit: 'business',
      timezone: TZ,
      now: la(2026, 8, 11, 10),
    })
    expect(laParts(next)).toMatchObject({ day: 13, hour: 10 })
  })

  it('floors an already-due recompute to now + 2 minutes (never an instant send)', () => {
    // Shrinking the delay makes the recomputed time land in the PAST:
    // last send Mon Aug 10 10:00 + 0 days = in-window but before now.
    const now = la(2026, 8, 11, 10)
    const next = computeEditedNextSendAt({
      from: la(2026, 8, 10, 10),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
      now,
    })
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_EDIT_RESCHEDULE_MS)
  })

  it('snaps an already-due recompute forward through the window from now', () => {
    // now = Sat Aug 15 10:00 (outside the Mon–Fri window). The due recompute
    // must not just be floored to Saturday+2min — it snaps forward to Monday.
    const now = la(2026, 8, 15, 10)
    const next = computeEditedNextSendAt({
      from: la(2026, 8, 10, 10),
      delayDays: 1,
      delayUnit: 'business',
      timezone: TZ,
      now,
    })
    expect(laParts(next)).toMatchObject({ day: 17, hour: 10 })
  })

  it('enforces the floor even when window-close clamping eats the slack', () => {
    // now = Tue 15:59:30, thirty seconds before close. Snapping from now
    // stays inside the window at ~now (the close clamp kills any jitter), so
    // the 2-minute floor is what prevents an instant send.
    const now = new Date(la(2026, 8, 11, 15, 59).getTime() + 30_000)
    const next = computeEditedNextSendAt({
      from: la(2026, 8, 4, 10),
      delayDays: 1,
      delayUnit: 'business',
      timezone: TZ,
      now,
    })
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_EDIT_RESCHEDULE_MS)
  })

  it('respects caller-supplied jitter on the snap-forward path', () => {
    const now = la(2026, 8, 11, 10)
    const next = computeEditedNextSendAt({
      from: la(2026, 8, 10, 10),
      delayDays: 0,
      delayUnit: 'business',
      timezone: TZ,
      jitterMs: 5 * 60_000,
      now,
    })
    // Snap-forward from now (in-window) + 5min jitter.
    expect(laParts(next)).toMatchObject({ day: 11, hour: 10, minute: 5 })
  })
})

describe('normalizeWindow', () => {
  it('passes a valid window through', () => {
    expect(normalizeWindow({ days: [1, 3], start_hour: 8, end_hour: 12 })).toEqual({
      days: [1, 3],
      start_hour: 8,
      end_hour: 12,
    })
  })

  it('degrades bad shapes to the default', () => {
    expect(normalizeWindow(null)).toEqual(DEFAULT_SEND_WINDOW)
    expect(normalizeWindow({ days: [], start_hour: 9, end_hour: 16 })).toEqual(DEFAULT_SEND_WINDOW)
    expect(normalizeWindow({ days: [1], start_hour: 12, end_hour: 9 })).toEqual(DEFAULT_SEND_WINDOW)
    expect(normalizeWindow({ days: [8, 0], start_hour: 9, end_hour: 16 })).toEqual(
      DEFAULT_SEND_WINDOW,
    )
  })
})
