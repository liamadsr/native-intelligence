/**
 * Next-run computation for calendar_event-trigger flows (GEN-136) — the loop
 * engine's calendar clock. Unlike schedule.ts (pure cadence math), this one
 * queries `local_calendar_event` (the desktop-synced calendar cache), so it is
 * async and takes the service client + the run-as user id.
 *
 * The flow is anchored to a RECURRING event by its TITLE (exact-normalized).
 * There is no cross-provider-stable series id — each occurrence is its own row
 * with a per-occurrence external_id — so the title is the only identity stable
 * across occurrences. See docs/loop-engine/CALENDAR-ANCHORED-DESIGN.md.
 *
 * computeNextCalendarRun(config, from, supabase, runAsUserId) returns the first
 * fire instant STRICTLY AFTER `from`:
 *   next_run_at = occurrence.start_at + offset_minutes,   (occurrence.start_at > now)
 * skipping any occurrence whose offset-adjusted fire instant has already passed
 * (e.g. "30 min before" an event that starts in 10 min), and returning null
 * (dormant, not broken) when no future occurrence exists or the calendar cache
 * is stale.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalendarEventTriggerConfig } from './types'

const MINUTE_MS = 60_000

/**
 * If the user's newest local_calendar_event.synced_at is older than this, the
 * desktop has stopped pushing calendar data and the cache can't be trusted (a
 * since-deleted event we never learned about would otherwise fire forever).
 * Treat the calendar as stale → dormant. Generous: the desktop syncs on a tight
 * cadence when running, so 3 days means "the desktop has been offline for days."
 */
export const CALENDAR_STALE_AFTER_MS = 3 * 24 * 60 * MINUTE_MS

/**
 * How far ahead to scan for the anchored occurrence. A recurring event has an
 * occurrence within this window under any normal cadence (daily → weekly →
 * monthly); a quarterly ritual is the practical ceiling. Bounded so a renamed/
 * ended series doesn't scan unboundedly.
 */
const LOOKAHEAD_MS = 120 * 24 * 60 * MINUTE_MS

/** Exact-normalized title key: lowercased + trimmed. The anchor identity. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase()
}

export interface CalendarRunResult {
  /** The fire instant, or null when the flow should be dormant. */
  next: Date | null
  /**
   * Why null, for observability/UI. Absent when `next` is non-null.
   *   - 'no_occurrence'       : cache fresh + has future events, none match the
   *     anchor title (series ended / event renamed).
   *   - 'beyond_sync_horizon' : cache fresh but holds no future events at all —
   *     the anchored occurrence is further out than the desktop's synced window.
   *     Self-heals when it enters the window.
   *   - 'stale_calendar'      : the cache hasn't synced recently (or ever).
   */
  reason?: 'no_occurrence' | 'beyond_sync_horizon' | 'stale_calendar'
}

/**
 * Compute the next fire instant for a calendar-anchored flow. Reads only the
 * run-as user's own calendar rows (user_id = runAsUserId — the loop-engine
 * per-user scoping invariant; the service client bypasses RLS so we filter
 * explicitly). NOT scoped by workspace: `local_calendar_event` keys uniqueness
 * on (user_id, external_id), so a given event lives under exactly one
 * workspace_id at a time (last sync wins) and a workspace filter would
 * spuriously hide the anchor.
 */
export async function computeNextCalendarRun(
  config: CalendarEventTriggerConfig,
  from: Date,
  supabase: SupabaseClient,
  runAsUserId: string,
): Promise<CalendarRunResult> {
  const anchor = normalizeTitle(config.event_title)
  if (!anchor) return { next: null, reason: 'no_occurrence' }

  const fromMs = from.getTime()
  const horizon = new Date(fromMs + LOOKAHEAD_MS).toISOString()

  // Fetch this user's upcoming occurrences within the lookahead window. Title
  // matching is done in JS (exact-normalized) rather than SQL ilike — a title
  // may contain %/_ which ilike treats as wildcards, and PostgREST has no clean
  // escape for arbitrary literals. Bounded by the lookahead + a row cap.
  const { data: rows, error } = await supabase
    .from('local_calendar_event')
    .select('title, start_at, synced_at')
    .eq('user_id', runAsUserId)
    .gt('start_at', from.toISOString())
    .lte('start_at', horizon)
    .order('start_at', { ascending: true })
    .limit(500)

  if (error) {
    // A read failure is not "no occurrence" — surfacing it as dormant would
    // silently freeze the loop. Throw so the tick logs + retries next cycle.
    throw new Error(`computeNextCalendarRun: calendar read failed: ${error.message}`)
  }

  const futureRows = rows ?? []
  const candidates = futureRows.filter(
    (r) => typeof r.title === 'string' && normalizeTitle(r.title) === anchor,
  )

  if (candidates.length === 0) {
    // No future occurrence with this title. Three distinct causes to name
    // honestly (all → dormant, but the UI reason differs):
    //   - stale_calendar       : the cache hasn't refreshed recently.
    //   - beyond_sync_horizon  : the cache IS fresh but holds NO future rows at
    //     all (the desktop syncs a narrow window; the anchored occurrence is
    //     further out than what's synced). This SELF-HEALS: the re-anchor pass
    //     picks it up once the occurrence enters the synced window — but calling
    //     it 'no_occurrence' would wrongly imply the event is gone.
    //   - no_occurrence        : the cache is fresh AND has future rows, just
    //     none with this title (series ended / event renamed).
    const stale = await isCalendarStale(supabase, runAsUserId, from)
    if (stale) return { next: null, reason: 'stale_calendar' }
    return {
      next: null,
      reason: futureRows.length === 0 ? 'beyond_sync_horizon' : 'no_occurrence',
    }
  }

  // Stale-calendar guard: even with a matching future occurrence, if the cache
  // hasn't refreshed recently we may be firing on an occurrence that has since
  // moved or been cancelled. Prefer dormant over firing on stale data.
  if (await isCalendarStale(supabase, runAsUserId, from)) {
    return { next: null, reason: 'stale_calendar' }
  }

  // Walk occurrences in chronological order; the first whose offset-adjusted
  // fire instant is strictly after `from` wins. Skipping past-fire occurrences
  // (offset before now) is the design's "never fire late for a window that
  // already closed."
  const offsetMs = config.offset_minutes * MINUTE_MS
  for (const c of candidates) {
    const start = new Date(c.start_at as string).getTime()
    if (!Number.isFinite(start)) continue
    const fireMs = start + offsetMs
    if (fireMs > fromMs) return { next: new Date(fireMs) }
  }

  // Every matching occurrence's fire window is already in the past (e.g. a
  // "+60 min after" offset on events that all started >60 min ago and none
  // recur within the lookahead). Dormant until a fresh occurrence appears.
  return { next: null, reason: 'no_occurrence' }
}

/**
 * Per-flow decision for the cron tick's calendar pass, pure so it can be
 * unit-tested apart from the DB plumbing. Given the flow's stored next_run_at,
 * the freshly recomputed next fire, and now, decide what the tick should do:
 *
 *   - 'fire'      — the stored fire moment has arrived; fire and CAS-advance
 *                   next_run_at to `advanceTo` (the recomputed next occurrence,
 *                   or null when this was the last one).
 *   - 're-anchor' — not due, but the true next fire drifted from what's stored
 *                   (the meeting moved); CAS next_run_at to `advanceTo`.
 *   - 'dormant'   — not due and the recompute yielded no occurrence; CAS
 *                   next_run_at to null (only when it isn't already null).
 *   - 'noop'      — not due and stored already matches the recompute.
 *
 * `advanceTo` is the ISO value to CAS to (null = clear). Undefined for 'noop'.
 */
export type CalendarTickAction = 'fire' | 're-anchor' | 'dormant' | 'noop'

export function decideCalendarAction(args: {
  storedNextRunAt: string | null
  recomputed: Date | null
  now: Date
}): { action: CalendarTickAction; advanceTo: string | null } {
  const { storedNextRunAt, recomputed, now } = args
  const recomputedIso = recomputed ? recomputed.toISOString() : null

  const storedMs = storedNextRunAt ? new Date(storedNextRunAt).getTime() : null
  const isDue = storedMs !== null && Number.isFinite(storedMs) && storedMs <= now.getTime()

  if (isDue) {
    // Fire this occurrence, advancing to the recomputed NEXT fire (strictly
    // after now by construction, or null when the series has no more).
    return { action: 'fire', advanceTo: recomputedIso }
  }

  // Not due. Re-anchor only if the stored value no longer matches reality.
  // Compare instants, not strings: PostgREST returns a timestamptz as
  // "…T10:00:00+00:00", toISOString() writes "…T10:00:00.000Z".
  const same = recomputed === null
    ? storedNextRunAt === null
    : storedMs !== null && storedMs === recomputed.getTime()
  if (same) {
    return { action: 'noop', advanceTo: storedNextRunAt }
  }
  return {
    action: recomputedIso === null ? 'dormant' : 're-anchor',
    advanceTo: recomputedIso,
  }
}

/**
 * True iff the user's newest local_calendar_event.synced_at is older than
 * CALENDAR_STALE_AFTER_MS relative to `from` — or there are no rows at all
 * (never synced). A single cheap read of the most-recent sync stamp.
 */
async function isCalendarStale(
  supabase: SupabaseClient,
  runAsUserId: string,
  from: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('local_calendar_event')
    .select('synced_at')
    .eq('user_id', runAsUserId)
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Fail SAFE on a probe error: treat as stale (→ dormant) rather than fresh.
  // Returning "fresh" here would let a matched occurrence fire on calendar data
  // we couldn't verify (it may have moved/cancelled since); a transient blip
  // costing one tick's dormancy is the cheaper failure. Logged for visibility.
  if (error) {
    console.error(
      `[schedule-calendar] staleness probe failed for user ${runAsUserId}, treating as stale:`,
      error.message,
    )
    return true
  }
  if (!data || typeof data.synced_at !== 'string') return true

  const syncedMs = new Date(data.synced_at).getTime()
  if (!Number.isFinite(syncedMs)) return true
  return from.getTime() - syncedMs > CALENDAR_STALE_AFTER_MS
}
