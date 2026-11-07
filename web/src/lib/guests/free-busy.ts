/**
 * The owner's calendar as a guest's get_free_busy sees it
 * (src/lib/guests/tools.ts): blocks of busy time and nothing else. No
 * titles, places, notes, links, organizers or attendees ever leave here, so a
 * Colleague learns when the owner is busy and never what they are doing.
 *
 * Pure.
 */

export interface BusyBlock {
  start: string
  end: string
  /** An all-day event (a day off, travel): busy the whole day. */
  allDay?: true
}

/** The fields this reads. Every other field of an event is ignored. */
export interface EventTimes {
  start: string
  end: string
  isAllDay?: boolean
  status?: string
}

/**
 * The busy blocks of `events` inside [windowStart, windowEnd): cancelled and
 * unparseable events dropped, each clipped to the window, overlapping or
 * touching timed blocks merged, sorted by start. All-day blocks are kept
 * apart (they say "busy that day", not a time).
 */
export function busyBlocks(events: readonly EventTimes[], windowStart: string, windowEnd: string): BusyBlock[] {
  const from = Date.parse(windowStart)
  const to = Date.parse(windowEnd)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []

  const timed: Array<[number, number]> = []
  const allDay = new Map<string, BusyBlock>()
  for (const event of events) {
    if (!event || event.status === 'cancelled') continue
    const start = Date.parse(event.start)
    const end = Date.parse(event.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (end <= from || start >= to) continue
    if (event.isAllDay) {
      const block: BusyBlock = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: true }
      allDay.set(`${block.start}|${block.end}`, block)
      continue
    }
    timed.push([Math.max(start, from), Math.min(end, to)])
  }

  timed.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of timed) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const blocks: BusyBlock[] = [
    ...allDay.values(),
    ...merged.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })),
  ]
  return blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.allDay ? -1 : 1))
}
