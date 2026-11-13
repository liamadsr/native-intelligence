/**
 * Custom (cron) schedules (cron.ts): the parser takes the five standard
 * fields with *, lists, ranges, steps and names; day-of-week 7 is Sunday;
 * both day fields restricted means either matches. The next-run search runs
 * on the flow's wall clock and is DST-correct (America/New_York). Validation
 * refuses an expression that runs more often than every 15 minutes or never
 * within a year.
 */
import { describe, expect, it } from 'vitest'
import {
  computeNextCronRun,
  cronMinIntervalMinutes,
  nextCronRuns,
  normalizeCron,
  parseCron,
  validateCronExpression,
  type CronSchedule,
} from '../cron'

const NY = 'America/New_York'

function parsed(expr: string): CronSchedule {
  const s = parseCron(expr)
  if (s instanceof Error) throw s
  return s
}
const next = (expr: string, fromIso: string, tz = NY) => computeNextCronRun(parsed(expr), tz, new Date(fromIso))?.toISOString() ?? null

describe('parseCron', () => {
  it('reads *, single values, lists, ranges and steps', () => {
    const s = parsed('*/15 9-17/4 1,15 * 1-5')
    expect(s.minutes).toEqual([0, 15, 30, 45])
    expect(s.hours).toEqual([9, 13, 17])
    expect([...s.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15])
    expect(s.months.size).toBe(12)
    expect([...s.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5])
    expect(s.domRestricted).toBe(true)
    expect(s.dowRestricted).toBe(true)
  })

  it('a/n runs from a to the field end; a list may mix ranges and values', () => {
    expect(parsed('5/20 0 * * *').minutes).toEqual([5, 25, 45])
    expect(parsed('0,10-12,30 0 * * *').minutes).toEqual([0, 10, 11, 12, 30])
  })

  it('day-of-week 7 is Sunday, and names are accepted', () => {
    expect([...parsed('0 9 * * 7').daysOfWeek]).toEqual([0])
    expect([...parsed('0 9 * * 0').daysOfWeek]).toEqual([0])
    expect([...parsed('0 9 * jan,Mar mon-wed').daysOfWeek].sort()).toEqual([1, 2, 3])
    expect([...parsed('0 9 * jan,Mar mon-wed').months].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('a field starting with * is unrestricted, even with a step', () => {
    const s = parsed('0 9 */2 * 1')
    expect(s.domRestricted).toBe(false)
    expect(s.dowRestricted).toBe(true)
  })

  it('refuses the wrong field count, out-of-range values, backwards ranges and bad steps', () => {
    expect(parseCron('0 9 * *')).toBeInstanceOf(Error)
    expect(parseCron('0 9 * * * *')).toBeInstanceOf(Error)
    expect(parseCron('60 9 * * *')).toBeInstanceOf(Error)
    expect(parseCron('0 24 * * *')).toBeInstanceOf(Error)
    expect(parseCron('0 9 0 * *')).toBeInstanceOf(Error)
    expect(parseCron('0 9 * 13 *')).toBeInstanceOf(Error)
    expect(parseCron('0 9 * * 8')).toBeInstanceOf(Error)
    expect(parseCron('0 17-9 * * *')).toBeInstanceOf(Error)
    expect(parseCron('*/0 9 * * *')).toBeInstanceOf(Error)
    expect(parseCron('0 9 L * *')).toBeInstanceOf(Error)
    expect(parseCron('0,,5 9 * * *')).toBeInstanceOf(Error)
  })

  it('normalizes spacing', () => {
    expect(normalizeCron('  0   9 *  * 1-5 ')).toBe('0 9 * * 1-5')
  })
})

describe('computeNextCronRun', () => {
  it('weekdays at 9 in New York (EST, UTC-5)', () => {
    // Fri 2026-11-13 10:00 EST → Mon 2026-11-16 09:00 EST = 14:00Z.
    expect(next('0 9 * * 1-5', '2026-11-13T15:00:00.000Z')).toBe('2026-11-16T14:00:00.000Z')
    // Strictly after: from exactly 09:00 → the next day's.
    expect(next('0 9 * * 1-5', '2026-11-16T14:00:00.000Z')).toBe('2026-11-17T14:00:00.000Z')
  })

  it('steps within the day', () => {
    expect(next('*/30 * * * *', '2026-11-16T14:05:00.000Z')).toBe('2026-11-16T14:30:00.000Z')
    expect(next('0 */6 * * *', '2026-11-16T14:00:00.000Z')).toBe('2026-11-16T17:00:00.000Z') // 12:00 EST
  })

  it('both day fields restricted: either matches (classic cron OR)', () => {
    // The 1st of the month OR a Monday. From Tue 2026-11-17: next Monday is the 23rd, before Dec 1.
    expect(next('0 9 1 * 1', '2026-11-17T15:00:00.000Z')).toBe('2026-11-23T14:00:00.000Z')
    // From Tue 2026-11-24: next is Mon Nov 30, then Tue Dec 1 (the 1st).
    expect(next('0 9 1 * 1', '2026-11-30T15:00:00.000Z')).toBe('2026-12-01T14:00:00.000Z')
  })

  it('only one day field restricted: that one alone', () => {
    // Day-of-week starts with *: the 15th only.
    expect(next('0 9 15 * *', '2026-11-16T15:00:00.000Z')).toBe('2026-12-15T14:00:00.000Z')
  })

  it('a month list', () => {
    expect(next('0 9 1 jan,jul *', '2026-11-16T15:00:00.000Z')).toBe('2027-01-01T14:00:00.000Z')
  })

  it('DST spring forward (2026-03-08, New York): a skipped wall time runs at the shifted instant, never lost', () => {
    // 02:30 EST does not exist that day: 03:30 EDT = 07:30Z.
    expect(next('30 2 * * *', '2026-03-08T05:00:00.000Z')).toBe('2026-03-08T07:30:00.000Z')
    // A run at 09:00 either side of the switch: 23 real hours apart.
    const before = next('0 9 * * *', '2026-03-07T13:00:00.000Z')!
    expect(before).toBe('2026-03-07T14:00:00.000Z')
    expect(next('0 9 * * *', before)).toBe('2026-03-08T13:00:00.000Z')
  })

  it('DST fall back (2026-11-01, New York): a repeated wall time runs once, at its first occurrence', () => {
    // 01:30 happens at 05:30Z (EDT) and 06:30Z (EST): the first.
    const first = next('30 1 * * *', '2026-11-01T04:00:00.000Z')!
    expect(first).toBe('2026-11-01T05:30:00.000Z')
    // And not again that night: the next is the following day.
    expect(next('30 1 * * *', first)).toBe('2026-11-02T06:30:00.000Z')
    // 09:00 either side: 25 real hours apart.
    expect(next('0 9 * * *', '2026-10-31T14:00:00.000Z')).toBe('2026-11-01T14:00:00.000Z')
  })

  it('null when nothing matches within the search window', () => {
    expect(computeNextCronRun(parsed('0 9 31 2 *'), NY, new Date('2026-11-16T00:00:00Z'))).toBeNull()
  })

  it('nextCronRuns lists consecutive runs', () => {
    const runs = nextCronRuns(parsed('0 9 * * 1,3'), NY, new Date('2026-11-16T15:00:00Z'), 3).map((d) => d.toISOString())
    expect(runs).toEqual(['2026-11-18T14:00:00.000Z', '2026-11-23T14:00:00.000Z', '2026-11-25T14:00:00.000Z'])
  })
})

describe('the 15-minute floor and the one-year horizon', () => {
  it('measures the shortest gap, the wrap across midnight included', () => {
    expect(cronMinIntervalMinutes(parsed('*/15 * * * *'))).toBe(15)
    expect(cronMinIntervalMinutes(parsed('*/5 * * * *'))).toBe(5)
    expect(cronMinIntervalMinutes(parsed('0 9 * * *'))).toBe(1440)
    expect(cronMinIntervalMinutes(parsed('59 23 * * *'))).toBe(1440)
    expect(cronMinIntervalMinutes(parsed('0,59 0,23 * * *'))).toBe(1) // 23:59 then 00:00
  })

  it('refuses more often than every 15 minutes', () => {
    const now = new Date('2026-11-16T00:00:00Z')
    expect(validateCronExpression('* * * * *', NY, now)).toBeInstanceOf(Error)
    expect(validateCronExpression('*/10 * * * *', NY, now)).toBeInstanceOf(Error)
    expect((validateCronExpression('*/10 * * * *', NY, now) as Error).message).toMatch(/at most every 15 minutes/)
    expect(validateCronExpression('*/15 * * * *', NY, now)).not.toBeInstanceOf(Error)
  })

  it('refuses an expression with no run in the next 366 days', () => {
    const now = new Date('2026-11-16T00:00:00Z')
    const never = validateCronExpression('0 9 30 2 *', NY, now)
    expect(never).toBeInstanceOf(Error)
    expect((never as Error).message).toMatch(/never runs in the next 366 days/)
    // A 29th of February more than a year away (2028) is refused too.
    expect(validateCronExpression('0 9 29 2 *', NY, now)).toBeInstanceOf(Error)
  })

  it('keeps a valid expression, normalized', () => {
    const ok = validateCronExpression(' 0  9 * * 1-5', NY, new Date('2026-11-16T00:00:00Z'))
    expect(ok).not.toBeInstanceOf(Error)
    expect((ok as { cron: string }).cron).toBe('0 9 * * 1-5')
    expect(validateCronExpression('', NY)).toBeInstanceOf(Error)
    expect(validateCronExpression(undefined, NY)).toBeInstanceOf(Error)
  })
})
