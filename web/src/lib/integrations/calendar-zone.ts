/**
 * Calendar times in the person's own zone. A model asking about "this week"
 * writes bare dates (2026-11-02) or wall-clock date-times with no offset, and
 * reads every time it gets back as the clock on the person's wall. So a range
 * edge it wrote is read in their zone (parseRangeEdge, readRangeEdge), and an
 * event time it is handed is written in that zone with the offset spelled out
 * (isoInZone), never as UTC: on 2026-11-02 a 12:00Z Exchange call (7:00 am
 * Eastern) was read as noon. Shared by get_calendar_events
 * (src/lib/ai/tools/calendar.ts) and a guest's get_free_busy
 * (src/lib/guests/guest-tools.ts). Pure.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** A date-time with no offset and no Z: a wall-clock time. */
const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/
const DAY_MS = 24 * 60 * 60_000

/** The zone's offset from UTC at `at`, in ms (positive east of UTC); 0 for a zone Intl can't read. */
export function zoneOffsetMs(at: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    // Intl reads to the second: round to the minute so `at`'s milliseconds don't skew it.
    return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at) / 60_000) * 60_000
  } catch {
    return 0
  }
}

/** A wall-clock time in `timeZone` (written as if it were UTC) as the real instant. */
function fromWallClock(wall: number, timeZone: string): number {
  const guess = wall - zoneOffsetMs(wall, timeZone)
  // A second pass settles a guess that landed across a daylight-saving change.
  return wall - zoneOffsetMs(guess, timeZone)
}

/** A date or date-time as an instant; a bare date is midnight in `timeZone`. Null when unreadable. */
export function parseRangeEdge(value: string, timeZone: string): number | null {
  if (DATE_RE.test(value)) {
    const wall = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(wall) ? fromWallClock(wall, timeZone) : null
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/**
 * A range edge a model wrote, read in the person's zone: a bare date is the
 * start of that day there, or for the range's end the start of the next day,
 * so the whole day is in range; a date-time with no offset is that wall-clock
 * time there; one with an offset or a Z is taken as written. Null when
 * unreadable.
 */
export function readRangeEdge(value: string, timeZone: string, edge: 'start' | 'end'): number | null {
  const v = value.trim()
  if (DATE_RE.test(v)) {
    if (edge === 'start') return parseRangeEdge(v, timeZone)
    const day = Date.parse(`${v}T00:00:00Z`)
    return Number.isFinite(day) ? parseRangeEdge(new Date(day + DAY_MS).toISOString().slice(0, 10), timeZone) : null
  }
  if (WALL_CLOCK_RE.test(v)) {
    const wall = Date.parse(`${v.replace(' ', 'T')}Z`)
    return Number.isFinite(wall) ? fromWallClock(wall, timeZone) : null
  }
  return parseRangeEdge(v, timeZone)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `at` as the wall-clock time in `timeZone`, with its offset: 2026-11-05T07:00:00-05:00. */
export function isoInZone(at: number, timeZone: string): string {
  const offset = zoneOffsetMs(at, timeZone)
  const minutes = Math.abs(offset) / 60_000
  return `${new Date(at + offset).toISOString().slice(0, 19)}${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}
