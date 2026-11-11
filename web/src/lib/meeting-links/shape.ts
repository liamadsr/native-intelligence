/**
 * Meeting links (calls plan, phase 7, migrations 572-575): the shared
 * vocabulary, pure and client-safe.
 *
 * A member makes a meeting: a title, maybe a start and a length. It is a
 * private conversation of its own kind (team_chat_channel.kind 'meeting',
 * its members in team_chat_member, like a DM's) with a link on the app's own
 * domain, `<app>/m/<token>`. The token is 32 base64url characters (192 bits)
 * the server derives from the meeting's id with a secret
 * (src/lib/meeting-links/link.ts); only its sha256 is stored. Members who open the
 * link join the conversation and its call; anyone else is a guest, who waits
 * in a lobby until someone in the call lets them in.
 *
 * In a LiveKit room a guest's identity is `guest-<their id>` (never a member
 * id, which is a bare uuid) and their token's metadata says `{"guest":true}`,
 * which the client can't change (canUpdateOwnMetadata is false).
 */
import { APP_PAGE_ORIGINS, appUrl } from '@/lib/app-url'

/** A meeting link's token: 24 bytes as base64url. */
export const MEETING_TOKEN_LENGTH = 32
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/

/** The path a meeting's link opens, and every guest route sits under (the guest's cookie is scoped to it). */
export const MEETING_PATH_PREFIX = '/m/'

/** The most guests waiting in one meeting's lobby at once (574's max_waiting). */
export const MEETING_MAX_WAITING = 10
/** The longest name a guest may give (573's check). */
export const MEETING_GUEST_NAME_MAX = 60
/** The longest title a meeting has (573's check, the conversation's name). */
export const MEETING_TITLE_MAX = 80
/** A scheduled meeting's length when none is given, and the bounds (574). */
export const MEETING_DEFAULT_MINUTES = 30
export const MEETING_MIN_MINUTES = 5
export const MEETING_MAX_MINUTES = 480
/** How often a waiting guest's page asks whether they were let in. */
export const MEETING_LOBBY_POLL_MS = 3_000

export function isMeetingToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value)
}

/** The link a token opens, on the app's address. */
export function meetingUrlOf(token: string, origin: string = appUrl()): string {
  return `${origin.replace(/\/+$/, '')}${MEETING_PATH_PREFIX}${token}`
}

/**
 * The token of one of our meeting links inside some text (an event's
 * location, its description, a conference URL), or null. Only the app's own
 * origins count (and the configured address, a developer's machine
 * included), never another site that copies the path.
 */
export function meetingTokenIn(text: string | null | undefined, origins: readonly string[] = meetingOrigins()): string | null {
  if (!text) return null
  for (const origin of origins) {
    const at = text.indexOf(`${origin}${MEETING_PATH_PREFIX}`)
    if (at < 0) continue
    const start = at + origin.length + MEETING_PATH_PREFIX.length
    const token = text.slice(start, start + MEETING_TOKEN_LENGTH)
    const after = text.charAt(start + MEETING_TOKEN_LENGTH)
    if (isMeetingToken(token) && !/[A-Za-z0-9_-]/.test(after)) return token
  }
  return null
}

/** Our own link in some text, as written, or null. */
export function meetingUrlIn(text: string | null | undefined, origins: readonly string[] = meetingOrigins()): string | null {
  if (!text) return null
  for (const origin of origins) {
    const token = meetingTokenIn(text, [origin])
    if (token) return meetingUrlOf(token, origin)
  }
  return null
}

/** The origins a meeting link may be on: the configured address first, then every page host of the app. */
export function meetingOrigins(): string[] {
  return [...new Set([appUrl(), ...APP_PAGE_ORIGINS])]
}

// ── Guests ──────────────────────────────────────────────────────────────────

const GUEST_PREFIX = 'guest-'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A guest's LiveKit identity: never a member id (a bare uuid). */
export function guestIdentity(guestId: string): string {
  return `${GUEST_PREFIX}${guestId.toLowerCase()}`
}

/** The guest an identity is, or null for a member's (or anything else). */
export function guestIdOfIdentity(identity: string | null | undefined): string | null {
  if (!identity || !identity.startsWith(GUEST_PREFIX)) return null
  const id = identity.slice(GUEST_PREFIX.length)
  return UUID.test(id) ? id.toLowerCase() : null
}

/** The metadata a guest's token carries (the server's, never the client's). */
export const GUEST_METADATA = JSON.stringify({ guest: true })

/** True when a participant's server-set metadata says it is a guest. */
export function isGuestMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false
  try {
    return (JSON.parse(metadata) as { guest?: unknown } | null)?.guest === true
  } catch {
    return false
  }
}

/**
 * A guest's name as typed, tidied, or null when it can't be one: 1 to 60
 * characters of letters (any script), marks, digits, spaces and . ' ’ - ( ),
 * with at least one letter; no link, no address, no markup.
 */
export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (name.length < 1 || name.length > MEETING_GUEST_NAME_MAX) return null
  if (!/^[\p{L}\p{M}\p{N} .'’()-]+$/u.test(name)) return null
  if (!/\p{L}/u.test(name)) return null
  return name
}

/** How a guest is labelled for members: "Dana (guest)". The notes use the same. */
export function guestLabel(name: string): string {
  return `${name.trim() || 'Guest'} (guest)`
}

/** A meeting title as typed, tidied, or null. */
export function cleanMeetingTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const title = raw.replace(/\s+/g, ' ').trim()
  if (!title || title.length > MEETING_TITLE_MAX) return null
  return title
}

/** The first word of a display name: all a guest's page says of the host. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40)
  return first ? first : null
}

// ── The link's window ───────────────────────────────────────────────────────

export const MEETING_OPENS_BEFORE_MS = 15 * 60_000
export const MEETING_CLOSES_AFTER_MS = 2 * 60 * 60_000
export const MEETING_UNSCHEDULED_MS = 30 * 24 * 60 * 60_000

/** When a link works, as 574's meeting_create writes it (the same rule, for tests and the dialog's words). */
export function meetingWindow(input: { startsAt: Date | null; minutes?: number | null; now?: Date }): { opensAt: Date; closesAt: Date; endsAt: Date | null } {
  const now = input.now ?? new Date()
  if (!input.startsAt) return { opensAt: now, closesAt: new Date(now.getTime() + MEETING_UNSCHEDULED_MS), endsAt: null }
  const endsAt = new Date(input.startsAt.getTime() + (input.minutes ?? MEETING_DEFAULT_MINUTES) * 60_000)
  return { opensAt: new Date(input.startsAt.getTime() - MEETING_OPENS_BEFORE_MS), closesAt: new Date(endsAt.getTime() + MEETING_CLOSES_AFTER_MS), endsAt }
}

export type MeetingLinkState = 'early' | 'open' | 'closed' | 'revoked'

/** Where a link is now. */
export function meetingLinkState(m: { opens_at: string; closes_at: string; revoked_at: string | null }, now: number = Date.now()): MeetingLinkState {
  if (m.revoked_at) return 'revoked'
  if (now >= Date.parse(m.closes_at)) return 'closed'
  if (now < Date.parse(m.opens_at)) return 'early'
  return 'open'
}

/** A meeting as the conversation's link bar shows it (573's columns a member may read, and its link). */
export interface MeetingView {
  id: string
  channel_id: string
  host_member_id: string | null
  title: string
  starts_at: string | null
  ends_at: string | null
  opens_at: string
  closes_at: string
  revoked_at: string | null
  /** The link (made again by the server from the meeting's id), for whoever may read the conversation. */
  url: string | null
}

export const MEETING_COLUMNS = 'id, channel_id, host_member_id, title, starts_at, ends_at, opens_at, closes_at, revoked_at'

export type MeetingGuestState = 'waiting' | 'admitted' | 'declined' | 'removed' | 'left'

/** A guest, as members read them (573's meeting_guest under RLS). */
export interface MeetingGuest {
  id: string
  meeting_id: string
  channel_id: string
  name: string
  state: MeetingGuestState
  call_id: string | null
  in_call: boolean
  requested_at: string
  last_seen_at: string
}

export const MEETING_GUEST_COLUMNS = 'id, meeting_id, channel_id, name, state, call_id, in_call, requested_at, last_seen_at'

/** A guest row into a list (replacing that guest's), as Realtime and a read hand them over. */
export function upsertGuest(list: readonly MeetingGuest[], row: MeetingGuest): MeetingGuest[] {
  return [...list.filter((g) => g.id !== row.id), row].sort((a, b) => a.requested_at.localeCompare(b.requested_at))
}

/** Who waits in the lobby now (seen in the last two minutes, 574's cap's rule), first come first. */
export function waitingGuests(list: readonly MeetingGuest[], now: number = Date.now()): MeetingGuest[] {
  return list.filter((g) => g.state === 'waiting' && now - Date.parse(g.last_seen_at) < 2 * 60_000)
}

/**
 * Must an admitted guest see the notice and say go before they may publish
 * (phase 6's notice, enforced by the server for guests)? While the call has
 * notes on in a round they haven't said go to, or a recording running they
 * haven't said go to since it started. The same rule as 574's
 * meeting_guest_needs_notice; what they said go to is the server's record
 * (POST /m/<token>/notice), never anything their page sends.
 */
export function guestNeedsNotice(
  call: { notes: boolean; notes_round: number; recording: string | null | undefined; recording_started_at: string | null | undefined },
  guest: { notes_ack_round: number | null | undefined; recording_ack_at: string | null | undefined },
): boolean {
  const notes = call.notes && (guest.notes_ack_round ?? 0) < call.notes_round
  const recordingOn = call.recording === 'on' || call.recording === 'starting'
  const recording = recordingOn && (!guest.recording_ack_at || (!!call.recording_started_at && Date.parse(guest.recording_ack_at) < Date.parse(call.recording_started_at)))
  return notes || recording
}

/** The lobby's line for members: "Dana is waiting", "Dana and Lee are waiting", "3 people are waiting". */
export function waitingLine(names: readonly string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is waiting`
  if (names.length === 2) return `${names[0]} and ${names[1]} are waiting`
  return `${names.length} people are waiting`
}
