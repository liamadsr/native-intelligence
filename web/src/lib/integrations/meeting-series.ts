/**
 * Recurring-meeting series identity.
 *
 * Providers disagree about what an event id means for a recurring meeting:
 * Google (singleEvents=true) and Microsoft (calendarview) mint a distinct id
 * per occurrence, while EventKit's eventIdentifier is shared by every
 * occurrence of a series. A capture history thread therefore needs its own
 * key, derived once here and stamped on captures by every creation path.
 *
 * - `seriesKey` groups all occurrences of one recurring meeting. Scoped to a
 *   mailbox for Google/Microsoft master ids; EventKit falls back to the
 *   shared event id.
 * - `icalUid` is the iCalendar UID: series-scoped AND identical across
 *   attendees' mailboxes, so it also groups different users' captures of the
 *   same call (Microsoft event ids never match across attendees).
 * - `occurrenceStart` pins a capture to one occurrence, distinguishing
 *   EventKit occurrences that share an event id and grouping teammates'
 *   captures of the same call.
 */

export interface SeriesIdentitySource {
  /** Raw provider event id (per-occurrence for OAuth, per-series for EventKit). */
  id: string
  /** Occurrence start as an ISO string. */
  start?: string | null
  /** Google recurringEventId / Microsoft seriesMasterId. */
  seriesMasterId?: string | null
  /** iCalendar UID (Google iCalUID / Microsoft iCalUId). */
  icalUid?: string | null
  /** True when the event belongs to a recurring series. */
  hasRecurrence?: boolean | null
  /** "local_exchange" for EventKit events, undefined for OAuth. */
  source?: string | null
}

export interface SeriesIdentity {
  seriesKey: string | null
  icalUid: string | null
  occurrenceStart: string | null
}

/**
 * Google instance ids embed the series master id as a prefix:
 * `<masterId>_20260811T170000Z` (timed) or `<masterId>_20260811` (all-day).
 * Recoverable without any API call — also used by migration 226's backfill.
 */
const GOOGLE_INSTANCE_SUFFIX = /_\d{8}(T\d{6}Z)?$/

export function parseGoogleSeriesFromInstanceId(eventId: string): string | null {
  if (!GOOGLE_INSTANCE_SUFFIX.test(eventId)) return null
  return eventId.replace(GOOGLE_INSTANCE_SUFFIX, '')
}

export function deriveSeriesIdentity(event: SeriesIdentitySource): SeriesIdentity {
  // toISOString throws on an unparseable date — a malformed start from a stale
  // client must degrade to "no occurrence", not a 500 in every caller route.
  const startMs = event.start ? new Date(event.start).getTime() : NaN
  const occurrenceStart = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null
  const icalUid = event.icalUid?.trim() || null

  let seriesKey: string | null = null
  if (event.seriesMasterId?.trim()) {
    seriesKey = event.seriesMasterId.trim()
  } else if (event.source === 'local_exchange') {
    // EventKit's eventIdentifier is already shared by the whole series.
    seriesKey = event.hasRecurrence ? event.id : null
  } else if (event.hasRecurrence) {
    // OAuth event flagged recurring but master id missing (older desktop
    // caches) — Google ids still carry the master as a prefix.
    seriesKey = parseGoogleSeriesFromInstanceId(event.id)
  }

  return { seriesKey, icalUid, occurrenceStart }
}
