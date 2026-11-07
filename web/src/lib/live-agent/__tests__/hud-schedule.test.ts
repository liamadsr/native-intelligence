/**
 * The meeting's scheduled time in the HUD (lib/live-agent/hud-schedule.ts):
 * built from the capture's row, checked when it crosses windows, read from the
 * capture route's light `schedule` variant, and turned into the bar's fraction
 * and the header's words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HUD_SCHEDULE_WARN_MS,
  fetchHudSchedule,
  hudScheduleLabel,
  hudScheduleOf,
  hudScheduleProgress,
  readHudSchedule,
  sameHudSchedule,
} from '../hud-schedule'

const START = Date.parse('2026-10-17T15:00:00.000Z')
const END = Date.parse('2026-10-17T16:00:00.000Z')
const MIN = 60_000
const S = { captureId: 'cap-1', start: START, end: END }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hudScheduleOf', () => {
  it('reads the row’s ISO times', () => {
    expect(hudScheduleOf('cap-1', { scheduled_start: '2026-10-17T15:00:00.000Z', scheduled_end: '2026-10-17T16:00:00+00:00' })).toEqual(S)
  })

  it('is null without a scheduled end, a start, or an end after the start', () => {
    expect(hudScheduleOf('cap-1', { scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: null })).toBeNull()
    expect(hudScheduleOf('cap-1', { scheduled_start: null, scheduled_end: '2026-10-17T16:00:00Z' })).toBeNull()
    expect(hudScheduleOf('cap-1', { scheduled_start: '2026-10-17T16:00:00Z', scheduled_end: '2026-10-17T16:00:00Z' })).toBeNull()
    expect(hudScheduleOf('cap-1', { scheduled_start: 'soon', scheduled_end: 'later' })).toBeNull()
    expect(hudScheduleOf('cap-1', null)).toBeNull()
    expect(hudScheduleOf('', { scheduled_start: START, scheduled_end: END })).toBeNull()
  })
})

describe('readHudSchedule (what crosses windows)', () => {
  it('takes a schedule, and nothing else', () => {
    expect(readHudSchedule(S)).toEqual(S)
    expect(readHudSchedule({ captureId: null })).toBeNull()
    expect(readHudSchedule({ captureId: 'cap-1', start: END, end: START })).toBeNull()
    expect(readHudSchedule({ captureId: 'cap-1', start: 'x', end: END })).toBeNull()
    expect(readHudSchedule('nope')).toBeNull()
  })

  it('compares by value', () => {
    expect(sameHudSchedule(S, { ...S })).toBe(true)
    expect(sameHudSchedule(S, { ...S, end: END + MIN })).toBe(false)
    expect(sameHudSchedule(null, null)).toBe(true)
    expect(sameHudSchedule(S, null)).toBe(false)
  })
})

describe('progress and words', () => {
  it('drains from full at the start to empty at the end', () => {
    expect(hudScheduleProgress(S, START).remaining).toBe(1)
    expect(hudScheduleProgress(S, START + 15 * MIN).remaining).toBe(0.75)
    expect(hudScheduleProgress(S, START + 30 * MIN).remaining).toBe(0.5)
    expect(hudScheduleProgress(S, END).remaining).toBe(0)
    // Before the start it's full; past the end, empty.
    expect(hudScheduleProgress(S, START - 5 * MIN)).toMatchObject({ remaining: 1, before: true, over: false, warn: false })
    expect(hudScheduleProgress(S, END + 5 * MIN)).toMatchObject({ remaining: 0, over: true, warn: false })
  })

  it('warns in the last ten minutes, not before and not after the end', () => {
    expect(HUD_SCHEDULE_WARN_MS).toBe(10 * MIN)
    expect(hudScheduleProgress(S, END - 10 * MIN - 1).warn).toBe(false)
    expect(hudScheduleProgress(S, END - 10 * MIN).warn).toBe(true)
    expect(hudScheduleProgress(S, END - 1).warn).toBe(true)
    expect(hudScheduleProgress(S, END).warn).toBe(false)
  })

  it('says the time left, rounded up; before the start and past the end too', () => {
    expect(hudScheduleLabel(S, START)).toBe('1 h left')
    expect(hudScheduleLabel(S, START + 30 * 1000)).toBe('1 h left')
    expect(hudScheduleLabel(S, START + 15 * MIN)).toBe('45 min left')
    expect(hudScheduleLabel(S, END - 20 * 1000)).toBe('1 min left')
    expect(hudScheduleLabel({ ...S, end: START + 65 * MIN }, START)).toBe('1 h 5 min left')
    expect(hudScheduleLabel(S, START - 3 * MIN)).toBe('Starts in 3 min')
    expect(hudScheduleLabel(S, END + 30 * 1000)).toBe('At time')
    expect(hudScheduleLabel(S, END + 5 * MIN + 30 * 1000)).toBe('5 min over')
  })
})

describe('fetchHudSchedule', () => {
  it('reads the capture route’s schedule variant', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ capture: { id: 'cap-1', scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: '2026-10-17T16:00:00Z' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchHudSchedule('cap-1')).toEqual(S)
    expect(fetchMock).toHaveBeenCalledWith('/api/account/captures/cap-1?fields=schedule', { signal: undefined })
  })

  it('is null for a capture without one, a refusal, or a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ capture: { id: 'cap-1', scheduled_start: null, scheduled_end: null } }) })))
    expect(await fetchHudSchedule('cap-1')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    expect(await fetchHudSchedule('cap-1')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))
    expect(await fetchHudSchedule('cap-1')).toBeNull()
  })
})
