/**
 * Where a meeting prep's meeting is found again (prep-doc.ts has the story):
 * the shape `metadata.meeting_prep` (the report message) and
 * `frontmatter.meeting_prep` (the document) hold, and its parser. Pure and
 * client-safe, so the chat's prep card reads it too (MeetingGoalComposer);
 * prep-doc.ts re-exports it for the server.
 */
import { NOW_KEY } from '@/lib/now/now-stamp'

/** Where a prep's meeting is found again: its start and end, its calendar event, its pending capture, its key. */
export interface MeetingPrepRef {
  startIso: string
  /** Its end as the calendar gave it; null when none was (the label then takes DEFAULT_MEETING_MS). */
  endIso: string | null
  calendarEventId: string | null
  captureId: string | null
  /** meetingKey (upcoming-meetings.ts): the meeting's stable key, shared with its heads-up rows. */
  meetingKey: string
}

/** The key under `metadata` (the report message) and `frontmatter` (the document). */
export const MEETING_PREP_KEY = 'meeting_prep'

/** The stamps only the server writes into a document's frontmatter: a meeting prep's, and the Now file's (migration 440). */
const SERVER_STAMP_KEYS = [MEETING_PREP_KEY, NOW_KEY] as const

const MEETING_KEY_RE = /^[0-9a-f]{40}$/

/** A stored ref, shape-checked (a row is data), else null. Pure. */
export function parseMeetingPrepRef(value: unknown): MeetingPrepRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.startIso !== 'string' || !Number.isFinite(Date.parse(v.startIso))) return null
  if (typeof v.meetingKey !== 'string' || !MEETING_KEY_RE.test(v.meetingKey)) return null
  const id = (x: unknown) => (typeof x === 'string' && x.length > 0 && x.length <= 300 ? x : null)
  const startMs = Date.parse(v.startIso)
  const endMs = typeof v.endIso === 'string' ? Date.parse(v.endIso) : NaN
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: Number.isFinite(endMs) && endMs > startMs ? new Date(endMs).toISOString() : null,
    calendarEventId: id(v.calendarEventId),
    captureId: id(v.captureId),
    meetingKey: v.meetingKey,
  }
}

/**
 * Frontmatter as written from outside the server (a document route, a draft,
 * a publish, a chat or MCP tool): any incoming `meeting_prep` is dropped and
 * the stored one, if any, is kept. Only the server's markPrepDocuments
 * (prep-doc.ts, on the service role) sets it, so a teammate can't stamp a
 * document as someone's prep through the app. Since migration 359 the
 * database refuses it too: a client write that sets, changes or drops the
 * stamp raises (the document guard trigger), which is why the routes must
 * keep the stored stamp exactly (pass it as `stored`). The readers still
 * prove the document came from the person's own prep run (prep-doc.ts
 * provenPrepDocIds), for rows stamped before 359. The Now file's stamp
 * (`now`, set only by update_now: src/lib/now/now-file.ts) is kept the same
 * way, and migration 440 guards it as 359 guards the prep's. Returns undefined
 * when the incoming value isn't an object (the caller then writes nothing).
 * Pure.
 */
export function withServerFrontmatter(incoming: unknown, stored?: unknown): Record<string, unknown> | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return undefined
  const rest = { ...(incoming as Record<string, unknown>) }
  const storedObject = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined
  for (const key of SERVER_STAMP_KEYS) {
    delete rest[key]
    const kept = storedObject?.[key]
    if (kept !== undefined) rest[key] = kept
  }
  return rest
}
