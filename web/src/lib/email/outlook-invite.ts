/**
 * What an Outlook thread read needs beyond the message list, for the
 * invitation card and the attachment chips. Both read with the mailbox's own
 * token (Mail.Read, already asked for) and nothing more.
 *
 * 1. A meeting request Exchange delivers natively. It is not an email with an
 *    `.ics`: Graph types it `#microsoft.graph.eventMessage`, and the meeting
 *    is its linked `event`. `outlookEventInvite` reads that event
 *    (`$expand=microsoft.graph.eventMessage/event`) into the same
 *    CalendarInvite the card draws for Gmail, with the event's iCalendar UID,
 *    so answering it goes the usual way (calendar-rsvp.ts, on the person's
 *    connected CALENDAR account). When the event can't be expanded (it was
 *    removed, or the mailbox won't give it), the card is built from what the
 *    message itself says (when, where, who sent it); with no UID it can be
 *    read, not answered.
 *
 * 2. A message's attachments, by name, size and type. The thread's list query
 *    names `attachments` in `$select`, which Graph does not promise to return
 *    for a navigation property; `outlookAttachmentList` is the documented
 *    read (`/messages/{id}/attachments`), used for a message that says it has
 *    attachments and came back with none listed. Without it an Outlook
 *    message shows no chips, and an attached `.ics` no card.
 *
 * Every value is plain text out; nothing a message or event names is fetched.
 */
import type { CalendarInvite, InviteAttendee, InviteMethod, InvitePerson, InviteResponse } from './calendar-invite'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const TIMEOUT_MS = 12_000
/** Guests kept, as the .ics parser keeps. */
const MAX_ATTENDEES = 200

export const EVENT_MESSAGE_TYPE = '#microsoft.graph.eventMessage'

/** Is this Graph message a meeting request / response / cancellation? */
export function isOutlookEventMessage(msg: Record<string, unknown>): boolean {
  const type = msg['@odata.type']
  return typeof type === 'string' && type.toLowerCase().startsWith(EVENT_MESSAGE_TYPE.toLowerCase())
}

function methodOf(meetingMessageType: unknown): InviteMethod {
  switch (meetingMessageType) {
    case 'meetingRequest':
      return 'REQUEST'
    case 'meetingCancelled':
      return 'CANCEL'
    case 'meetingAccepted':
    case 'meetingTenativelyAccepted': // Graph's own spelling
    case 'meetingTentativelyAccepted':
    case 'meetingDeclined':
      return 'REPLY'
    default:
      return 'OTHER'
  }
}

function responseOf(value: unknown): InviteResponse {
  switch (value) {
    case 'accepted':
    case 'organizer':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentativelyAccepted':
      return 'tentative'
    default:
      return 'pending'
  }
}

function personOf(value: unknown): InvitePerson | null {
  const address = (value as { emailAddress?: { address?: unknown; name?: unknown } } | undefined)?.emailAddress
  const email = typeof address?.address === 'string' ? address.address.trim().toLowerCase() : ''
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return null
  const name = typeof address?.name === 'string' ? address.name.trim() : ''
  return { email, name: name && name.toLowerCase() !== email ? name : null }
}

function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s<>"']+$/i.test(value.trim()) ? value.trim() : null
}

interface GraphTime {
  dateTime?: unknown
  timeZone?: unknown
}

/** Graph's `{ dateTime, timeZone: 'UTC' }` as the card's start / end. All-day: dates, the end the LAST day covered. */
function times(start: GraphTime | undefined, end: GraphTime | undefined, allDay: boolean): { start: string; end: string | null } | null {
  const text = (t: GraphTime | undefined) => (typeof t?.dateTime === 'string' ? t.dateTime : '')
  const s = text(start)
  if (!s) return null
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
    const first = s.slice(0, 10)
    const e = text(end)
    let last: string | null = null
    if (/^\d{4}-\d{2}-\d{2}/.test(e)) {
      const [y, m, d] = e.slice(0, 10).split('-').map(Number)
      const before = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
      if (before > first) last = before
    }
    return { start: first, end: last }
  }
  const instant = (value: string) => {
    const at = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + 'Z')
    return Number.isNaN(at.getTime()) ? null : at.toISOString()
  }
  const from = instant(s)
  if (!from) return null
  return { start: from, end: text(end) ? instant(text(end)) : null }
}

async function graphGet(url: string, accessToken: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

const EVENT_FIELDS = 'id,subject,start,end,isAllDay,location,organizer,attendees,iCalUId,onlineMeeting,isCancelled,type'

/**
 * The invitation an Exchange meeting message carries, or null when it is not
 * one (or says no time). `message` is the message as the thread list gave it;
 * its linked event is read here. Never throws.
 */
export async function outlookEventInvite(accessToken: string, message: Record<string, unknown>): Promise<CalendarInvite | null> {
  if (!isOutlookEventMessage(message) || typeof message.id !== 'string') return null
  const id = encodeURIComponent(message.id)
  // The message with its event; when that is refused, the message alone (its own when / where).
  const full =
    (await graphGet(`${GRAPH}/me/messages/${id}?$expand=${encodeURIComponent(`microsoft.graph.eventMessage/event($select=${EVENT_FIELDS})`)}`, accessToken)) ??
    (await graphGet(`${GRAPH}/me/messages/${id}`, accessToken))
  if (!full) return null

  const event = (full.event as Record<string, unknown> | null | undefined) ?? null
  const method = event?.isCancelled === true ? 'CANCEL' : methodOf(full.meetingMessageType)
  const allDay = (event?.isAllDay ?? full.isAllDay) === true
  const when =
    times(event?.start as GraphTime | undefined, event?.end as GraphTime | undefined, allDay) ??
    times(full.startDateTime as GraphTime | undefined, full.endDateTime as GraphTime | undefined, allDay)
  if (!when) return null

  const organizer = personOf(event?.organizer) ?? personOf(full.from ?? message.from)
  const attendees: InviteAttendee[] = []
  let omitted = 0
  const seen = new Set<string>()
  for (const raw of (Array.isArray(event?.attendees) ? event.attendees : []) as Array<Record<string, unknown>>) {
    if (raw?.type === 'resource') continue
    const who = personOf(raw)
    if (!who || seen.has(who.email)) continue
    seen.add(who.email)
    if (attendees.length >= MAX_ATTENDEES) {
      omitted++
      continue
    }
    attendees.push({
      ...who,
      status: responseOf((raw.status as { response?: unknown } | undefined)?.response),
      ...(raw.type === 'optional' ? { optional: true } : {}),
    })
  }
  // No event to read the guests from: the people the request was sent to.
  if (!event) {
    for (const raw of [...((full.toRecipients as unknown[]) ?? []), ...((full.ccRecipients as unknown[]) ?? [])]) {
      const who = personOf(raw)
      if (!who || seen.has(who.email) || who.email === organizer?.email || attendees.length >= MAX_ATTENDEES) continue
      seen.add(who.email)
      attendees.push({ ...who, status: 'pending' })
    }
  }

  const place = ((event?.location ?? full.location) as { displayName?: unknown } | undefined)?.displayName
  const title = [event?.subject, full.subject, message.subject].find((t): t is string => typeof t === 'string' && !!t.trim())
  const uid = typeof event?.iCalUId === 'string' && event.iCalUId.trim() ? event.iCalUId.trim() : null

  return {
    method,
    uid,
    title: (title ?? '(no title)').trim().slice(0, 300),
    start: when.start,
    end: when.end,
    allDay,
    location: typeof place === 'string' && place.trim() ? place.trim().slice(0, 500) : null,
    conferenceUrl: httpsUrl((event?.onlineMeeting as { joinUrl?: unknown } | undefined)?.joinUrl),
    organizer,
    attendees,
    attendeesOmitted: omitted,
    updated: full.type === 'exception' || event?.type === 'exception',
  }
}

export interface OutlookAttachmentMeta {
  name: string
  size: number
  mimeType: string
}

/** A message's attachments as the chips list them (inline images left out). Empty when it can't be read. Never throws. */
export async function outlookAttachmentList(accessToken: string, messageId: string): Promise<OutlookAttachmentMeta[]> {
  const data = await graphGet(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,size,contentType,isInline`, accessToken)
  const items = (Array.isArray(data?.value) ? data.value : []) as Array<Record<string, unknown>>
  return items.filter((a) => a.isInline !== true).map(outlookAttachmentMeta)
}

export function outlookAttachmentMeta(a: Record<string, unknown>): OutlookAttachmentMeta {
  return {
    name: (typeof a.name === 'string' && a.name) || 'attachment',
    size: typeof a.size === 'number' ? a.size : 0,
    mimeType: (typeof a.contentType === 'string' && a.contentType) || 'application/octet-stream',
  }
}
