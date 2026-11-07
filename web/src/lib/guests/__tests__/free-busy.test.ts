/**
 * A guest's view of the owner's calendar: busy blocks only, never a word
 * about what an event is.
 */
import { describe, expect, it } from 'vitest'
import { busyBlocks } from '../free-busy'

const WINDOW: [string, string] = ['2026-10-26T00:00:00.000Z', '2026-10-27T00:00:00.000Z']

describe('busyBlocks', () => {
  it('keeps only the times, whatever else an event carries', () => {
    const events = [
      { start: '2026-10-26T15:00:00.000Z', end: '2026-10-26T16:00:00.000Z', title: 'Therapy', location: 'Dr. K', attendees: ['k@example.com'], description: 'private' },
    ]
    const blocks = busyBlocks(events, ...WINDOW)
    expect(blocks).toEqual([{ start: '2026-10-26T15:00:00.000Z', end: '2026-10-26T16:00:00.000Z' }])
    expect(JSON.stringify(blocks)).not.toMatch(/Therapy|Dr\. K|example|private/)
  })

  it('merges overlapping and touching blocks, and sorts them', () => {
    const blocks = busyBlocks(
      [
        { start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z' },
        { start: '2026-10-26T15:00:00.000Z', end: '2026-10-26T16:00:00.000Z' },
        { start: '2026-10-26T15:30:00.000Z', end: '2026-10-26T16:30:00.000Z' },
        { start: '2026-10-26T16:30:00.000Z', end: '2026-10-26T16:45:00.000Z' },
      ],
      ...WINDOW,
    )
    expect(blocks).toEqual([
      { start: '2026-10-26T15:00:00.000Z', end: '2026-10-26T16:45:00.000Z' },
      { start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z' },
    ])
  })

  it('clips to the window, and drops what is outside it, cancelled or unreadable', () => {
    const blocks = busyBlocks(
      [
        { start: '2026-10-25T23:00:00.000Z', end: '2026-10-26T01:00:00.000Z' },
        { start: '2026-10-27T01:00:00.000Z', end: '2026-10-27T02:00:00.000Z' },
        { start: '2026-10-26T10:00:00.000Z', end: '2026-10-26T11:00:00.000Z', status: 'cancelled' },
        { start: 'soon', end: 'later' },
        { start: '2026-10-26T12:00:00.000Z', end: '2026-10-26T11:00:00.000Z' },
      ],
      ...WINDOW,
    )
    expect(blocks).toEqual([{ start: '2026-10-26T00:00:00.000Z', end: '2026-10-26T01:00:00.000Z' }])
  })

  it('all-day events stay whole days, apart from the timed blocks', () => {
    const blocks = busyBlocks(
      [
        { start: '2026-10-26T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z', isAllDay: true },
        { start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T10:00:00.000Z' },
      ],
      ...WINDOW,
    )
    expect(blocks).toEqual([
      { start: '2026-10-26T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z', allDay: true },
      { start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T10:00:00.000Z' },
    ])
  })

  it('a bad window is nothing', () => {
    expect(busyBlocks([{ start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T10:00:00.000Z' }], WINDOW[1], WINDOW[0])).toEqual([])
    expect(busyBlocks([], 'x', 'y')).toEqual([])
  })
})
