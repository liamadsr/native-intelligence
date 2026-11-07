import { describe, expect, it } from 'vitest'
import {
  dayKey,
  dayLabel,
  lastMessageTime,
  messageSourceLabel,
  messageTime,
  stampCreatedAt,
  timeLabel,
  withCreatedAt,
  withDayLines,
} from '../message-time'

const NY = 'America/New_York'
// Sunday, October 18, 2026, 3 PM in New York.
const NOW = Date.parse('2026-10-18T19:00:00Z')

const at = (id: string, iso: string | null, metadata: Record<string, unknown> = {}) => ({
  id,
  role: 'assistant' as const,
  parts: [],
  metadata: iso ? { ...metadata, createdAt: iso } : metadata,
})

describe('messageTime / withCreatedAt / stampCreatedAt', () => {
  it('reads metadata.createdAt, null when absent or not a time', () => {
    expect(messageTime(at('a', '2026-10-18T12:00:00Z'))).toBe(Date.parse('2026-10-18T12:00:00Z'))
    expect(messageTime(at('a', null))).toBeNull()
    expect(messageTime({ id: 'a', metadata: { createdAt: 'nope' } })).toBeNull()
    expect(messageTime({ id: 'a' })).toBeNull()
  })

  it('stamps the row time, keeps a time the message carries, passes anything else through', () => {
    expect(withCreatedAt({ id: 'a', metadata: { kind: 'x' } }, '2026-10-01T00:00:00Z')).toEqual({ id: 'a', metadata: { kind: 'x', createdAt: '2026-10-01T00:00:00Z' } })
    const own = at('a', '2026-09-01T00:00:00Z')
    expect(withCreatedAt(own, '2026-10-01T00:00:00Z')).toBe(own)
    expect(withCreatedAt(null, '2026-10-01T00:00:00Z')).toBeNull()
    const msg = { id: 'a' }
    expect(withCreatedAt(msg, 'not a time')).toBe(msg)
  })

  it('stampCreatedAt adds now, never overwrites', () => {
    expect(stampCreatedAt(undefined, NOW)).toEqual({ createdAt: new Date(NOW).toISOString() })
    expect(stampCreatedAt({ replyCard: 1 }, NOW)).toEqual({ replyCard: 1, createdAt: new Date(NOW).toISOString() })
    expect(stampCreatedAt({ createdAt: 'x' }, NOW)).toEqual({ createdAt: 'x' })
  })
})

describe('day and time labels', () => {
  it('a day is the local calendar day in the zone', () => {
    // 1 AM UTC on the 18th is still the 17th in New York.
    expect(dayKey(Date.parse('2026-10-18T01:00:00Z'), NY)).toBe('2026-10-17')
    expect(dayKey(Date.parse('2026-10-18T01:00:00Z'), 'UTC')).toBe('2026-10-18')
  })

  it('names the day, with the year only outside this one', () => {
    expect(dayLabel(NOW, { now: NOW, timeZone: NY })).toBe('Sunday, October 18')
    expect(dayLabel(Date.parse('2025-12-31T17:00:00Z'), { now: NOW, timeZone: NY })).toBe('Wednesday, December 31, 2025')
  })

  it('a time today is the clock alone; another day carries its date', () => {
    expect(timeLabel(Date.parse('2026-10-18T11:32:00Z'), { now: NOW, timeZone: NY })).toEqual({ day: null, time: '7:32 AM' })
    expect(timeLabel(Date.parse('2026-10-16T23:32:00Z'), { now: NOW, timeZone: NY })).toEqual({ day: 'Oct 16', time: '7:32 PM' })
    expect(timeLabel(Date.parse('2025-10-16T23:32:00Z'), { now: NOW, timeZone: NY }).day).toBe('Oct 16, 2025')
  })
})

describe('messageSourceLabel', () => {
  it('names a home turn by its label, else by its reason; nothing else gets one', () => {
    expect(messageSourceLabel(at('a', null, { kind: 'home_turn', reason: 'helper_report', label: 'Evening Brief' }))).toBe('Evening Brief')
    expect(messageSourceLabel(at('a', null, { kind: 'home_turn', reason: 'digest' }))).toBe('Daily digest')
    expect(messageSourceLabel(at('a', null, { kind: 'home_turn', reason: 'event' }))).toBe('Heads up')
    expect(messageSourceLabel(at('a', null, { kind: 'teammate_report' }))).toBeNull()
    expect(messageSourceLabel({ id: 'a' })).toBeNull()
  })
})

describe('withDayLines', () => {
  const opts = { now: NOW, timeZone: NY }
  const lines = (rows: ReturnType<typeof withDayLines>) => rows.map((r) => (r.type === 'line' ? `-- ${r.label}` : r.message.id))

  it('draws a line before the first message of each day', () => {
    const rows = withDayLines(
      [
        at('a', '2026-10-16T23:00:00Z'),
        at('b', '2026-10-16T23:30:00Z'),
        at('c', '2026-10-18T13:00:00Z'),
      ],
      opts,
    )
    expect(lines(rows)).toEqual(['-- Friday, October 16', 'a', 'b', '-- Sunday, October 18', 'c'])
  })

  it('a message with no time joins the day before it', () => {
    expect(lines(withDayLines([at('a', '2026-10-18T13:00:00Z'), at('b', null), at('c', '2026-10-18T14:00:00Z')], opts))).toEqual(['-- Sunday, October 18', 'a', 'b', 'c'])
  })

  it('dayBefore: the same day across the seam draws no second line', () => {
    const seam = Date.parse('2026-10-18T12:00:00Z')
    expect(lines(withDayLines([at('a', '2026-10-18T13:00:00Z')], { ...opts, dayBefore: seam }))).toEqual(['a'])
    expect(lines(withDayLines([at('a', '2026-10-18T13:00:00Z')], { ...opts, dayBefore: Date.parse('2026-10-17T12:00:00Z') }))).toEqual(['-- Sunday, October 18', 'a'])
  })

  it('names what the agent posted on its own, sharing the line with a new day', () => {
    const rows = withDayLines(
      [
        at('a', '2026-10-16T22:00:00Z'),
        at('b', '2026-10-16T23:32:00Z', { kind: 'home_turn', reason: 'helper_report', label: 'Evening Brief' }),
        at('c', '2026-10-18T13:00:00Z', { kind: 'home_turn', reason: 'digest' }),
      ],
      opts,
    )
    expect(lines(rows)).toEqual(['-- Friday, October 16', 'a', '-- Evening Brief', 'b', '-- Sunday, October 18 · Daily digest', 'c'])
  })

  it('keeps each message’s time on its row', () => {
    const rows = withDayLines([at('a', '2026-10-18T13:00:00Z'), at('b', null)], opts)
    expect(rows.filter((r) => r.type === 'message').map((r) => (r.type === 'message' ? r.time : 0))).toEqual([Date.parse('2026-10-18T13:00:00Z'), null])
  })

  it('lastMessageTime reads back from the end, past messages with none', () => {
    expect(lastMessageTime([at('a', '2026-10-18T13:00:00Z'), at('b', null)])).toBe(Date.parse('2026-10-18T13:00:00Z'))
    expect(lastMessageTime([at('b', null)])).toBeNull()
  })
})
