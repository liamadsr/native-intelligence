/**
 * computeNextRun is the loop engine's clock — every schedule flow's fire
 * instant comes out of it, so the DST edge cases here are load-bearing.
 * All assertions are on UTC instants (never local time) so the suite is
 * independent of the machine's timezone.
 *
 * America/Los_Angeles in 2026: spring-forward Sun Mar 8 (02:00→03:00,
 * PST→PDT), fall-back Sun Nov 1 (02:00→01:00, PDT→PST).
 */
import { describe, it, expect } from 'vitest'
import { computeNextRun } from '../schedule'
import type { ScheduleTriggerConfig } from '../types'

const LA = 'America/Los_Angeles'

function cfg(
  partial: Partial<ScheduleTriggerConfig> & Pick<ScheduleTriggerConfig, 'cadence'>,
): ScheduleTriggerConfig {
  return { kind: 'schedule', timezone: LA, ...partial }
}

function next(config: ScheduleTriggerConfig, fromIso: string): string {
  return computeNextRun(config, new Date(fromIso))!.toISOString()
}

describe('computeNextRun — hourly', () => {
  it('returns the next top-of-hour', () => {
    expect(next(cfg({ cadence: 'hourly' }), '2026-06-24T10:15:30.123Z')).toBe(
      '2026-06-24T11:00:00.000Z',
    )
  })

  it('is strictly after: exactly on the hour rolls to the next hour', () => {
    expect(next(cfg({ cadence: 'hourly' }), '2026-06-24T10:00:00.000Z')).toBe(
      '2026-06-24T11:00:00.000Z',
    )
  })

  it('is timezone-independent', () => {
    const from = '2026-06-24T10:15:00.000Z'
    expect(next(cfg({ cadence: 'hourly', timezone: 'Asia/Tokyo' }), from)).toBe(
      next(cfg({ cadence: 'hourly' }), from),
    )
  })
})

describe('computeNextRun — daily', () => {
  const daily9 = cfg({ cadence: 'daily', time: '09:00' })

  it('fires later today when the time has not passed yet', () => {
    // 2026-06-24T15:00Z = 08:00 PDT, before 09:00.
    expect(next(daily9, '2026-06-24T15:00:00.000Z')).toBe('2026-06-24T16:00:00.000Z')
  })

  it('rolls to tomorrow when the time already passed today', () => {
    // 2026-06-24T17:00Z = 10:00 PDT, past 09:00.
    expect(next(daily9, '2026-06-24T17:00:00.000Z')).toBe('2026-06-25T16:00:00.000Z')
  })

  it('is strictly after: exactly at the scheduled instant rolls to tomorrow', () => {
    expect(next(daily9, '2026-06-24T16:00:00.000Z')).toBe('2026-06-25T16:00:00.000Z')
  })

  it('rolls across a month boundary', () => {
    // Jun 30 10:00 PDT, past 09:00 → Jul 1 09:00 PDT.
    expect(next(daily9, '2026-06-30T17:00:00.000Z')).toBe('2026-07-01T16:00:00.000Z')
  })

  it('handles a positive-offset timezone whose day differs from UTC', () => {
    // 2026-06-24T01:00Z = 10:00 JST, past 09:00 → Jun 25 09:00 JST = Jun 25 00:00Z.
    const tokyo = cfg({ cadence: 'daily', time: '09:00', timezone: 'Asia/Tokyo' })
    expect(next(tokyo, '2026-06-24T01:00:00.000Z')).toBe('2026-06-25T00:00:00.000Z')
  })

  it('handles a half-hour-offset timezone', () => {
    // 05:30 IST (00:00Z), before 09:00 IST → same day 09:00 IST = 03:30Z.
    const kolkata = cfg({ cadence: 'daily', time: '09:00', timezone: 'Asia/Kolkata' })
    expect(next(kolkata, '2026-06-24T00:00:00.000Z')).toBe('2026-06-24T03:30:00.000Z')
  })
})

describe('computeNextRun — DST spring-forward (LA, 2026-03-08)', () => {
  it('daily run lands 23 real hours after the pre-transition run', () => {
    const daily9 = cfg({ cadence: 'daily', time: '09:00' })
    // Sat Mar 7 09:00 PST fired at 17:00Z; next is Sun Mar 8 09:00 PDT = 16:00Z.
    const out = computeNextRun(daily9, new Date('2026-03-07T17:00:00.000Z'))!
    expect(out.toISOString()).toBe('2026-03-08T16:00:00.000Z')
    expect(out.getTime() - Date.parse('2026-03-07T17:00:00.000Z')).toBe(23 * 3_600_000)
  })

  it('a nonexistent wall time (02:30 on the gap day) shifts forward, not skipped', () => {
    const daily230 = cfg({ cadence: 'daily', time: '02:30' })
    // From Mar 8 00:00 PST (08:00Z). 02:30 PST/PDT does not exist that day;
    // expect the shifted-forward instant 03:30 PDT = 10:30Z.
    expect(next(daily230, '2026-03-08T08:00:00.000Z')).toBe('2026-03-08T10:30:00.000Z')
  })
})

describe('computeNextRun — DST fall-back (LA, 2026-11-01)', () => {
  it('daily run lands 25 real hours after the pre-transition run', () => {
    const daily9 = cfg({ cadence: 'daily', time: '09:00' })
    // Sat Oct 31 09:00 PDT fired at 16:00Z; next is Sun Nov 1 09:00 PST = 17:00Z.
    const out = computeNextRun(daily9, new Date('2026-10-31T16:00:00.000Z'))!
    expect(out.toISOString()).toBe('2026-11-01T17:00:00.000Z')
    expect(out.getTime() - Date.parse('2026-10-31T16:00:00.000Z')).toBe(25 * 3_600_000)
  })

  it('an ambiguous wall time (01:30 occurs twice) resolves to its first occurrence', () => {
    const daily130 = cfg({ cadence: 'daily', time: '01:30' })
    // From Nov 1 00:00 PDT (07:00Z). 01:30 happens at 08:30Z (PDT) and again
    // at 09:30Z (PST); expect the first.
    expect(next(daily130, '2026-11-01T07:00:00.000Z')).toBe('2026-11-01T08:30:00.000Z')
  })
})

describe('computeNextRun — weekdays', () => {
  const weekdays5pm = cfg({ cadence: 'weekdays', time: '17:00' })

  it('fires later the same weekday when the time has not passed', () => {
    // Wed Jun 24 08:00 PDT → Wed 17:00 PDT = Jun 25 00:00Z.
    expect(next(weekdays5pm, '2026-06-24T15:00:00.000Z')).toBe('2026-06-25T00:00:00.000Z')
  })

  it('hops Friday-after-hours to Monday', () => {
    // Fri Jun 26 18:00 PDT (Sat 01:00Z) → Mon Jun 29 17:00 PDT = Jun 30 00:00Z.
    expect(next(weekdays5pm, '2026-06-27T01:00:00.000Z')).toBe('2026-06-30T00:00:00.000Z')
  })

  it('hops a Saturday to Monday', () => {
    // Sat Jun 27 11:00 PDT → Mon Jun 29 17:00 PDT.
    expect(next(weekdays5pm, '2026-06-27T18:00:00.000Z')).toBe('2026-06-30T00:00:00.000Z')
  })

  it('hops a Sunday to Monday', () => {
    // Sun Jun 28 11:00 PDT → Mon Jun 29 17:00 PDT.
    expect(next(weekdays5pm, '2026-06-28T18:00:00.000Z')).toBe('2026-06-30T00:00:00.000Z')
  })
})

describe('computeNextRun — weekly', () => {
  const weeklyWed4pm = cfg({ cadence: 'weekly', time: '16:00', weekday: 3 })

  it('fires the upcoming weekday in the same week', () => {
    // Mon Jun 22 → Wed Jun 24 16:00 PDT = 23:00Z.
    expect(next(weeklyWed4pm, '2026-06-22T12:00:00.000Z')).toBe('2026-06-24T23:00:00.000Z')
  })

  it('hops a full week when this week\'s occurrence already passed', () => {
    // Wed Jun 24 16:30 PDT → Wed Jul 1 16:00 PDT = 23:00Z.
    expect(next(weeklyWed4pm, '2026-06-24T23:30:00.000Z')).toBe('2026-07-01T23:00:00.000Z')
  })

  it('is strictly after: exactly at the occurrence hops a full week', () => {
    expect(next(weeklyWed4pm, '2026-06-24T23:00:00.000Z')).toBe('2026-07-01T23:00:00.000Z')
  })

  it('crosses the spring-forward transition to the right wall time', () => {
    // Weekly Sunday 09:00; from Mon Mar 2 → Sun Mar 8 09:00 PDT = 16:00Z
    // (the transition day itself).
    const weeklySun9 = cfg({ cadence: 'weekly', time: '09:00', weekday: 0 })
    expect(next(weeklySun9, '2026-03-02T20:00:00.000Z')).toBe('2026-03-08T16:00:00.000Z')
  })

  it('crosses the fall-back transition to the right wall time', () => {
    // Weekly Sunday 09:00; from Mon Oct 26 → Sun Nov 1 09:00 PST = 17:00Z.
    const weeklySun9 = cfg({ cadence: 'weekly', time: '09:00', weekday: 0 })
    expect(next(weeklySun9, '2026-10-26T20:00:00.000Z')).toBe('2026-11-01T17:00:00.000Z')
  })
})
