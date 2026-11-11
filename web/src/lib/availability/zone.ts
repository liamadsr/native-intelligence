/**
 * Wall-clock times in a zone, for the availability engine (./engine.ts) and
 * everything that offers a time (src/lib/customers/slots.ts). A slot is 10:00
 * in the person's zone across a daylight-saving change. Pure.
 */

export interface LocalDay {
  y: number
  m: number
  d: number
}

/** The zone's offset from UTC at `at`, in ms (positive east of UTC). */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at
}

/** A wall-clock time in `timeZone` as an instant (DST-correct: the offset is read at the instant itself). Pure. */
export function zonedTime(date: LocalDay, clock: string, timeZone: string): number {
  const [h, min] = clock.split(':').map(Number)
  const wall = Date.UTC(date.y, date.m - 1, date.d, h, min)
  const first = offsetAt(wall, timeZone)
  // A second pass settles a guess that landed across a daylight-saving change.
  const second = offsetAt(wall - first, timeZone)
  if (second === first) return wall - first
  // The two passes disagree only near a change. A time that exists under the
  // second offset is that instant; one that doesn't (02:30 on a spring-forward
  // day) is the later reading, the instant the clock skipped to.
  const at = wall - second
  return offsetAt(at, timeZone) === second ? at : Math.max(wall - first, wall - second)
}

/** The local calendar date of `at` in `timeZone`, and its weekday (0 Sunday). Pure. */
export function localDate(at: number, timeZone: string): LocalDay & { weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(at))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday }
}

export function addDays(date: LocalDay, n: number): LocalDay & { weekday: number } {
  const utc = new Date(Date.UTC(date.y, date.m - 1, date.d + n))
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate(), weekday: utc.getUTCDay() }
}

/** A local day as YYYY-MM-DD. */
export function dayKey(date: LocalDay): string {
  return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`
}

/** YYYY-MM-DD as a local day, or null when it isn't one. */
export function parseDayKey(value: string | null | undefined): LocalDay | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null
}

const HALF_DAY_MS = 12 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

/** Whether an all-day block takes the local day [dayStart, dayEnd): it covers half of it or more. Pure. */
export function allDayTakes(block: { start: number; end: number }, dayStart: number, dayEnd: number): boolean {
  return Math.min(block.end, dayEnd) - Math.max(block.start, dayStart) >= Math.min(HALF_DAY_MS, dayEnd - dayStart)
}

/**
 * Whether an all-day block takes the local `day` in `timeZone`. Google and
 * Outlook hand an all-day event as calendar dates, which reach here as UTC
 * midnights: such a block takes the dates it names, in any zone (a day off
 * on the 12th is the 12th in Auckland and in Pago Pago alike). Anything else
 * (the desktop's Exchange rows, stored at the Mac's local midnight) takes
 * the local days it covers for half the day or more ({@link allDayTakes}). Pure.
 */
export function allDayTakesDay(block: { start: number; end: number }, day: LocalDay, timeZone: string): boolean {
  if (block.start % DAY_MS === 0 && block.end % DAY_MS === 0) {
    const at = Date.UTC(day.y, day.m - 1, day.d)
    return at >= block.start && at < block.end
  }
  return allDayTakes(block, zonedTime(day, '00:00', timeZone), zonedTime(addDays(day, 1), '00:00', timeZone))
}

/** A zone's short name at `at` ("EST", "GMT+1"), or null for one Intl doesn't know. Pure. */
export function zoneAbbreviation(timeZone: unknown, at: number): string | null {
  if (typeof timeZone !== 'string' || !timeZone) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}

export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return h * 60 + m
}

export function minutesClock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
