/**
 * The schedule's newer cadences: monthly (a day 1-28 at a time), cron (a
 * custom expression, cron.ts) and once (one run at run_at, then off). The
 * validator stores each in one shape and refuses a past one-time run on a
 * write (unless it is the stored one, re-saved); next_run_at follows
 * (next-run.ts): a once loop whose time has passed stays NULL when switched
 * back on.
 */
import { describe, expect, it } from 'vitest'
import { computeNextRun, isOnceFire, runAtInstant, toWallTime } from '../schedule'
import { validateScheduleConfig, validateTriggerConfig } from '../queries'
import { nextRunAtOnEnable, nextRunAtOnWrite } from '../next-run'
import type { ScheduleTriggerConfig } from '../types'

const NY = 'America/New_York'
const NOW = new Date('2026-11-16T15:00:00.000Z') // Mon 10:00 EST

const cfg = (over: Partial<ScheduleTriggerConfig>): ScheduleTriggerConfig => ({ kind: 'schedule', cadence: 'daily', timezone: NY, ...over })

describe('monthly', () => {
  it('runs on its day at its time, rolling into next month once passed', () => {
    const m = cfg({ cadence: 'monthly', day_of_month: 1, time: '08:30' })
    expect(computeNextRun(m, NOW)!.toISOString()).toBe('2026-12-01T13:30:00.000Z')
    const today = cfg({ cadence: 'monthly', day_of_month: 16, time: '11:00' })
    expect(computeNextRun(today, NOW)!.toISOString()).toBe('2026-11-16T16:00:00.000Z')
    const passed = cfg({ cadence: 'monthly', day_of_month: 16, time: '09:00' })
    expect(computeNextRun(passed, NOW)!.toISOString()).toBe('2026-12-16T14:00:00.000Z')
  })

  it('validates day 1-28 and a time', () => {
    expect(validateScheduleConfig({ cadence: 'monthly', day_of_month: 28, time: '09:00', timezone: NY })).toEqual({
      kind: 'schedule', cadence: 'monthly', day_of_month: 28, time: '09:00', timezone: NY,
    })
    expect(validateScheduleConfig({ cadence: 'monthly', day_of_month: 29, time: '09:00', timezone: NY })).toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'monthly', day_of_month: 0, time: '09:00', timezone: NY })).toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'monthly', day_of_month: 1.5, time: '09:00', timezone: NY })).toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'monthly', day_of_month: 1, timezone: NY })).toBeInstanceOf(Error)
  })
})

describe('cron', () => {
  it('stores the normalized expression only, and computes from it', () => {
    const v = validateScheduleConfig({ cadence: 'cron', cron: '0  9 * * 1-5', time: '07:00', weekday: 3, timezone: NY }, { now: NOW })
    expect(v).toEqual({ kind: 'schedule', cadence: 'cron', cron: '0 9 * * 1-5', timezone: NY })
    expect(computeNextRun(v as ScheduleTriggerConfig, NOW)!.toISOString()).toBe('2026-11-17T14:00:00.000Z')
  })

  it('refuses a bad, too-frequent or never-running expression, naming the field', () => {
    expect((validateScheduleConfig({ cadence: 'cron', cron: '0 9 * *', timezone: NY }) as Error).message).toMatch(/^trigger_config\.cron: /)
    expect(validateScheduleConfig({ cadence: 'cron', cron: '*/5 * * * *', timezone: NY })).toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'cron', cron: '0 0 31 2 *', timezone: NY })).toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'cron', timezone: NY })).toBeInstanceOf(Error)
  })

  it('a stored expression that no longer parses never fires (null, not a throw)', () => {
    expect(computeNextRun(cfg({ cadence: 'cron', cron: 'nonsense' }), NOW)).toBeNull()
  })
})

describe('once', () => {
  it('reads run_at as a wall time in the zone, or an instant with an offset; stores the wall time', () => {
    expect(runAtInstant('2026-11-20T15:00', NY)!.toISOString()).toBe('2026-11-20T20:00:00.000Z')
    expect(runAtInstant('2026-11-20T20:00:00Z', NY)!.toISOString()).toBe('2026-11-20T20:00:00.000Z')
    expect(runAtInstant('2026-04-31T15:00', NY)).toBeNull()
    expect(runAtInstant('tomorrow at 3', NY)).toBeNull()
    expect(runAtInstant('2026-11-20 15:00', NY)).toBeNull()
    expect(toWallTime(new Date('2026-11-20T20:00:00Z'), NY)).toBe('2026-11-20T15:00')
    const v = validateScheduleConfig({ cadence: 'once', run_at: '2026-11-20T20:00:00Z', timezone: NY }, { now: NOW })
    expect(v).toEqual({ kind: 'schedule', cadence: 'once', run_at: '2026-11-20T15:00', timezone: NY })
  })

  it('next_run_at is run_at; null once it has passed', () => {
    const once = cfg({ cadence: 'once', run_at: '2026-11-20T15:00' })
    expect(computeNextRun(once, NOW)!.toISOString()).toBe('2026-11-20T20:00:00.000Z')
    expect(nextRunAtOnWrite('schedule', once, NOW)).toBe('2026-11-20T20:00:00.000Z')
    expect(computeNextRun(once, new Date('2026-11-20T20:00:00.000Z'))).toBeNull()
  })

  it('refuses a past run_at on a write; a stored one re-saved unchanged is fine', () => {
    const past = { cadence: 'once', run_at: '2026-11-10T09:00', timezone: NY }
    expect((validateTriggerConfig('schedule', past, { now: NOW }) as Error).message).toMatch(/run_at is in the past/)
    expect(validateTriggerConfig('schedule', past, { now: NOW, storedConfig: { kind: 'schedule', ...past } })).not.toBeInstanceOf(Error)
    // A different past time than the stored one is still refused.
    expect(validateTriggerConfig('schedule', { ...past, run_at: '2026-11-11T09:00' }, { now: NOW, storedConfig: { kind: 'schedule', ...past } })).toBeInstanceOf(Error)
    // Without a clock (reading a stored row) it validates.
    expect(validateScheduleConfig(past)).not.toBeInstanceOf(Error)
    expect(validateScheduleConfig({ cadence: 'once', timezone: NY })).toBeInstanceOf(Error)
  })

  it('switching a finished one-time loop back on leaves next_run_at NULL; a future one gets its time', () => {
    expect(nextRunAtOnEnable('schedule', { kind: 'schedule', cadence: 'once', run_at: '2026-11-10T09:00', timezone: NY }, NOW)).toBeNull()
    expect(nextRunAtOnEnable('schedule', { kind: 'schedule', cadence: 'once', run_at: '2026-11-20T15:00', timezone: NY }, NOW)).toBe('2026-11-20T20:00:00.000Z')
  })

  it('isOnceFire: the event for its own run_at only', () => {
    const stored = { kind: 'schedule', cadence: 'once', run_at: '2026-11-20T15:00', timezone: NY }
    expect(isOnceFire(stored, '2026-11-20T20:00:00+00:00')).toBe(true)
    expect(isOnceFire(stored, '2026-11-21T20:00:00+00:00')).toBe(false)
    expect(isOnceFire({ ...stored, cadence: 'daily' }, '2026-11-20T20:00:00+00:00')).toBe(false)
    expect(isOnceFire(stored, null)).toBe(false)
  })
})
