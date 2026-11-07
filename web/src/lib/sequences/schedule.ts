import { TZDate } from '@date-fns/tz'

/**
 * Send-window / delay arithmetic for sequences.
 *
 * All math is WALL-CLOCK in the sequence's IANA zone via TZDate — never
 * "add N × 24h in UTC", which drifts across DST transitions. The zone is a
 * snapshot stored on the sequence.
 */

export interface SendWindow {
  /** ISO weekday numbers, 1=Mon .. 7=Sun */
  days: number[]
  /** Local hour the window opens (inclusive) */
  start_hour: number
  /** Local hour the window closes (exclusive) */
  end_hour: number
}

export const DEFAULT_SEND_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 16,
}

/** JS getDay() (0=Sun..6=Sat) → ISO weekday (1=Mon..7=Sun) */
function isoWeekday(d: Date): number {
  const day = d.getDay()
  return day === 0 ? 7 : day
}

function isAllowedDay(d: TZDate, window: SendWindow): boolean {
  return window.days.includes(isoWeekday(d))
}

/** Business days = the window's allowed days (Mon–Fri by default). */
function addDelayDays(
  start: TZDate,
  delayDays: number,
  unit: 'business' | 'calendar',
  window: SendWindow,
): TZDate {
  let cursor = start
  if (unit === 'calendar') {
    return new TZDate(
      cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + delayDays,
      cursor.getHours(), cursor.getMinutes(), 0, 0, cursor.timeZone!,
    )
  }
  // A disallowed 'from' day (Sat launch) must advance to the next allowed day
  // BEFORE counting — otherwise delay 0 and delay 1 both land on Monday and
  // consecutive steps double-send same-day.
  for (let guard = 0; guard < 7 && !isAllowedDay(cursor, window); guard++) {
    cursor = new TZDate(
      cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1,
      cursor.getHours(), cursor.getMinutes(), 0, 0, cursor.timeZone!,
    )
  }
  let remaining = delayDays
  while (remaining > 0) {
    cursor = new TZDate(
      cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1,
      cursor.getHours(), cursor.getMinutes(), 0, 0, cursor.timeZone!,
    )
    if (isAllowedDay(cursor, window)) remaining--
  }
  return cursor
}

/**
 * Snap an instant FORWARD into the next open window slot. Before the window
 * opens on an allowed day → that day's start_hour. Inside the window → as-is.
 * Past close, or a disallowed day → next allowed day's start_hour.
 *
 * Every constructed candidate re-enters the loop for validation: DST
 * spring-forward can materialize start_hour as a LATER hour (LA 2026-03-08
 * has no 2:00 — it materializes as 3:00), which may fall outside the window.
 * Only a candidate whose materialized hour is within [start_hour, end_hour)
 * is returned.
 */
function snapIntoWindow(d: TZDate, window: SendWindow): TZDate {
  let cursor = d
  for (let guard = 0; guard < 30; guard++) {
    if (isAllowedDay(cursor, window)) {
      const hour = cursor.getHours()
      if (hour >= window.start_hour && hour < window.end_hour) return cursor
      if (hour < window.start_hour) {
        cursor = new TZDate(
          cursor.getFullYear(), cursor.getMonth(), cursor.getDate(),
          window.start_hour, 0, 0, 0, cursor.timeZone!,
        )
        continue
      }
    }
    // Disallowed day or past close — try the next day's open.
    cursor = new TZDate(
      cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1,
      window.start_hour, 0, 0, 0, cursor.timeZone!,
    )
  }
  return cursor // unreachable with a non-empty days array; guard vs bad data
}

export interface ComputeNextSendArgs {
  /** The previous step's ACTUAL send time (or launch time for step 1) */
  from: Date
  delayDays: number
  delayUnit: 'business' | 'calendar'
  /** IANA zone name from the sequence */
  timezone: string
  window?: SendWindow
  /**
   * Jitter in ms, supplied by the caller (so tests are deterministic).
   * Clamped so the jittered time never spills past the window close.
   */
  jitterMs?: number
}

export function computeNextSendAt(args: ComputeNextSendArgs): Date {
  const window = normalizeWindow(args.window)
  const local = new TZDate(args.from.getTime(), args.timezone)
  const delayed = addDelayDays(local, args.delayDays, args.delayUnit, window)
  const snapped = snapIntoWindow(delayed, window)

  const jitter = Math.max(0, args.jitterMs ?? 0)
  const windowClose = new TZDate(
    snapped.getFullYear(), snapped.getMonth(), snapped.getDate(),
    window.end_hour, 0, 0, 0, snapped.timeZone!,
  )
  const headroom = windowClose.getTime() - 1 - snapped.getTime()
  return new Date(snapped.getTime() + Math.min(jitter, Math.max(0, headroom)))
}

/**
 * Floor for any EDIT-driven reschedule: a structure edit (delay / send-window /
 * timezone / delay-unit change) may move a pending send LATER freely, but must
 * never move it earlier than this far from "now" — otherwise an edit to a
 * sequence with already-due-ish enrollments fires an instant burst.
 */
export const MIN_EDIT_RESCHEDULE_MS = 2 * 60_000

/**
 * Recompute a pending enrollment's next_send_at after a structure edit,
 * counting the (new) delay from the enrollment's last ACTUAL send — with the
 * never-burst floor: the result is never earlier than now + 2 minutes.
 *
 * When the recomputed time is already due (the delay was served under the old
 * settings), the send is snapped forward from NOW through the send window —
 * the same shape as resume — and then floored, because the window-close jitter
 * clamp in computeNextSendAt can otherwise produce a time within seconds of
 * now.
 */
export function computeEditedNextSendAt(args: ComputeNextSendArgs & { now: Date }): Date {
  const computed = computeNextSendAt(args)
  const floor = args.now.getTime() + MIN_EDIT_RESCHEDULE_MS
  if (computed.getTime() >= floor) return computed
  const snapped = computeNextSendAt({ ...args, from: args.now, delayDays: 0 })
  return new Date(Math.max(snapped.getTime(), floor))
}

/** Defensive parse of the jsonb column — bad data degrades to the default. */
export function normalizeWindow(raw: unknown): SendWindow {
  if (raw && typeof raw === 'object') {
    const w = raw as Partial<SendWindow>
    const days = Array.isArray(w.days)
      ? w.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)
      : []
    const start = Number.isInteger(w.start_hour) ? (w.start_hour as number) : NaN
    const end = Number.isInteger(w.end_hour) ? (w.end_hour as number) : NaN
    if (days.length > 0 && start >= 0 && end > start && end <= 24) {
      return { days, start_hour: start, end_hour: end }
    }
  }
  return DEFAULT_SEND_WINDOW
}

/** Random jitter between 2 and 10 minutes — sends must never share a timestamp. */
export function randomJitterMs(): number {
  return (2 + Math.random() * 8) * 60_000
}
