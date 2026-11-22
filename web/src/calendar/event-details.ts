/**
 * What the event card on the calendar (components/dialogs/event-details-popover.tsx)
 * shows and hands out, worked out from the event alone: the date line, the
 * video call's name, the guests with the person's own row and the organizer
 * marked, whether "Going?" can be answered, the event as an .ics file, and
 * where the card sits beside the block that opened it. No React here, so it
 * is tested on its own (__tests__/event-details.test.ts).
 */
import { format, isSameDay, parseISO } from 'date-fns'

import { exclusiveEndDate } from '@/calendar/adapters'
import { htmlToPlainText } from '@/lib/email/plain-text-to-html'
import type { IEvent } from '@/calendar/interfaces'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** An all-day date (YYYY-MM-DD) as that local day; anything else as its instant. */
function when(value: string): Date {
  return parseISO(value)
}

const time = (d: Date) => format(d, 'h:mm a')

/**
 * "Wed, November 18 · 8:00 AM–9:00 AM". All day: "Wed, November 18 · All day",
 * or the first and last day for several. A timed event over midnight names both days.
 */
export function eventDateLine(event: Pick<IEvent, 'startDate' | 'endDate' | 'isAllDay'>): string {
  const start = when(event.startDate)
  const end = when(event.endDate)
  if (Number.isNaN(start.getTime())) return ''
  if (event.isAllDay) {
    // An all-day endDate is the last day covered (adapters' allDayDates).
    const last = Number.isNaN(end.getTime()) ? start : end
    return isSameDay(start, last)
      ? `${format(start, 'EEE, MMMM d')} · All day`
      : `${format(start, 'EEE, MMM d')} – ${format(last, 'EEE, MMM d')} · All day`
  }
  if (Number.isNaN(end.getTime()) || isSameDay(start, end)) {
    return `${format(start, 'EEE, MMMM d')} · ${time(start)}${Number.isNaN(end.getTime()) ? '' : `–${time(end)}`}`
  }
  return `${format(start, 'EEE, MMM d')}, ${time(start)} – ${format(end, 'EEE, MMM d')}, ${time(end)}`
}

/** The video call's service by its address ("Google Meet"), or null when it isn't one we know. */
export function meetingProviderName(url: string | null | undefined): string | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const on = (domain: string) => host === domain || host.endsWith(`.${domain}`)
  if (on('meet.google.com')) return 'Google Meet'
  if (on('zoom.us') || on('zoom.com')) return 'Zoom'
  if (on('teams.microsoft.com') || on('teams.live.com')) return 'Microsoft Teams'
  if (on('webex.com')) return 'Webex'
  if (on('whereby.com')) return 'Whereby'
  if (on('around.co')) return 'Around'
  return null
}

export type GuestResponse = 'accepted' | 'declined' | 'tentative' | 'pending'

/** The providers' words for a guest's answer (Google's and Microsoft's), as one of four. */
export function guestResponse(status: string | undefined): GuestResponse {
  switch (status) {
    case 'accepted':
    case 'organizer':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentative':
    case 'tentativelyAccepted':
      return 'tentative'
    default:
      return 'pending'
  }
}

export interface Guest {
  email: string
  /** The provider's display name, when it gives one. */
  name: string | null
  isOrganizer: boolean
  /** The person looking: the event's own account. */
  isSelf: boolean
  response: GuestResponse
}

const norm = (email: string | undefined | null) => (email ?? '').trim().toLowerCase()

/** The guests, the organizer first and then the person's own row, each once. */
export function eventGuests(event: Pick<IEvent, 'attendeeDetails' | 'attendees' | 'accountEmail' | 'response'>): Guest[] {
  const self = norm(event.accountEmail)
  const raw = event.attendeeDetails?.length
    ? event.attendeeDetails
    : (event.attendees ?? []).map((email) => ({ email, name: undefined, isOrganizer: undefined, responseStatus: undefined }))
  const seen = new Set<string>()
  const guests: Guest[] = []
  for (const a of raw) {
    const email = norm(a.email)
    if (!email || seen.has(email)) continue
    seen.add(email)
    const isSelf = !!self && email === self
    guests.push({
      email: a.email.trim(),
      name: a.name?.trim() || null,
      isOrganizer: !!a.isOrganizer,
      isSelf,
      // The person's own answer is the one the grid keeps current (an answer from the card lands there first).
      response: isSelf && event.response ? event.response : guestResponse(a.responseStatus),
    })
  }
  const rank = (g: Guest) => (g.isOrganizer ? 0 : g.isSelf ? 1 : 2)
  return guests.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g)
}

/** "AR" for Ana Ruiz, "AN" for ana@example.com. */
export function initials(guest: Pick<Guest, 'name' | 'email'>): string {
  const words = (guest.name ?? '').split(/\s+/).filter((w) => /\p{L}/u.test(w))
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return guest.email.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?'
}

/**
 * Whether the card offers "Going?": the person is a guest on this event (not
 * its organizer), and it is on a Google or Microsoft calendar the reply route
 * can find by its iCalendar UID. An event of their own with no one invited,
 * a task, or one only on the Mac's local calendar has no answer to give.
 */
export function canAnswerHere(event: IEvent): boolean {
  if (event.isAction || !event.icalUid) return false
  if (event.source === 'local_exchange') return false
  if (event.provider && event.provider !== 'google' && event.provider !== 'microsoft') return false
  const guests = eventGuests(event)
  const self = guests.find((g) => g.isSelf)
  if (self?.isOrganizer) return false
  // Their own row is on the guest list: a guest.
  if (self) return true
  // No row of theirs (a list without the account's address on it): the calendar's answer for them decides.
  // Anything but "accepted" is a guest's answer. "Accepted" is also what an organizer reads as
  // (Microsoft's 'organizer'), so it counts only when someone else is named the organizer.
  if (!event.response) return false
  if (event.response !== 'accepted') return true
  return guests.some((g) => g.isOrganizer)
}

/**
 * A description as text to show: Google's can carry HTML (links, <br>), and
 * an Outlook body is a whole HTML document. Plain text is left as it is.
 */
export function descriptionText(description: string | undefined | null): string {
  const raw = (description ?? '').trim()
  if (!/<\/?[a-z][^>]*>/i.test(raw)) return raw
  const withoutHead = raw.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '')
  // A link whose words aren't its address keeps the address, so it can still be followed.
  const withHrefs = withoutHead.replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const words = inner.replace(/<[^>]+>/g, '').trim()
    return !words || words === href ? href : `${words} (${href})`
  })
  return htmlToPlainText(withHrefs).trim()
}

/** The addresses to write to: every guest but the person themself. */
export function otherGuestEmails(event: Pick<IEvent, 'attendeeDetails' | 'attendees' | 'accountEmail' | 'response'>): string[] {
  return eventGuests(event).filter((g) => !g.isSelf).map((g) => g.email)
}

/** A mailto: link (addresses as they are, subject and body encoded). */
export function mailtoHref(to: string[], subject?: string, body?: string): string {
  const params: string[] = []
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`)
  if (body) params.push(`body=${encodeURIComponent(body)}`)
  return `mailto:${to.map((e) => encodeURIComponent(e).replace(/%40/g, '@')).join(',')}${params.length ? `?${params.join('&')}` : ''}`
}

/** The event in a few lines, for an email that passes it on. */
export function eventSummaryText(event: IEvent): string {
  const lines = [event.title || '(no title)', eventDateLine(event)]
  if (event.conferenceUrl) lines.push(`Join: ${event.conferenceUrl}`)
  if (event.location) lines.push(`Where: ${event.location}`)
  if (event.htmlLink) lines.push(`Event: ${event.htmlLink}`)
  if (event.description?.trim()) lines.push('', event.description.trim())
  return lines.join('\n')
}

// ── .ics (RFC 5545) ─────────────────────────────────────────────────────────

function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

/** A content line folded at 75 octets (continuations start with a space), never inside a character. */
function fold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const size = encoder.encode(ch).length
    const limit = parts.length === 0 ? 75 : 74
    if (bytes + size > limit) {
      parts.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const dateValue = (isoDate: string) => isoDate.slice(0, 10).replace(/-/g, '')

const PARTSTAT: Record<GuestResponse, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  pending: 'NEEDS-ACTION',
}

const quotedName = (name: string) => `"${name.replace(/["\\]/g, '')}"`

/** The event as an iCalendar file, for "Download .ics". */
export function eventToIcs(event: IEvent, now: Date = new Date()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Native Intelligence//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT']
  lines.push(`UID:${event.icalUid || `${event.id}@native-intelligence`}`)
  lines.push(`DTSTAMP:${utcStamp(now)}`)
  if (event.isAllDay && DATE_ONLY.test(event.startDate.slice(0, 10))) {
    lines.push(`DTSTART;VALUE=DATE:${dateValue(event.startDate)}`)
    // The provider's exclusive end: the day after the last one covered.
    lines.push(`DTEND;VALUE=DATE:${dateValue(exclusiveEndDate(event))}`)
  } else {
    lines.push(`DTSTART:${utcStamp(parseISO(event.startDate))}`)
    lines.push(`DTEND:${utcStamp(parseISO(event.endDate))}`)
  }
  lines.push(`SUMMARY:${icsText(event.title || '(no title)')}`)
  const description = [event.description?.trim(), event.conferenceUrl ? `Join: ${event.conferenceUrl}` : ''].filter(Boolean).join('\n\n')
  if (description) lines.push(`DESCRIPTION:${icsText(description)}`)
  if (event.location) lines.push(`LOCATION:${icsText(event.location)}`)
  const url = event.conferenceUrl || event.htmlLink
  if (url) lines.push(`URL:${url}`)
  for (const g of eventGuests(event)) {
    const cn = g.name ? `;CN=${quotedName(g.name)}` : ''
    if (g.isOrganizer) lines.push(`ORGANIZER${cn}:mailto:${g.email}`)
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=${PARTSTAT[g.response]}:mailto:${g.email}`)
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** "design-review.ics": the title as a file name. */
export function icsFileName(event: Pick<IEvent, 'title'>): string {
  const slug = (event.title || 'event')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'event'}.ics`
}

// ── Where the card sits ─────────────────────────────────────────────────────

export interface Rect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

/** Room kept between the card and the window's edge, and between the card and the block. */
export const CARD_EDGE = 12
export const CARD_GAP = 8

/**
 * The card beside the block: on its right when it fits there (or the block is
 * on the left half), else on its left; when neither side has room, over the
 * block's column, below or above it. Then shifted to stay inside the window.
 */
export function placeCard(anchor: Rect, card: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number; side: 'right' | 'left' | 'below' | 'above' } {
  const fitsRight = anchor.right + CARD_GAP + card.width <= viewport.width - CARD_EDGE
  const fitsLeft = anchor.left - CARD_GAP - card.width >= CARD_EDGE
  const preferRight = anchor.left + anchor.width / 2 < viewport.width / 2
  let side: 'right' | 'left' | 'below' | 'above'
  let left: number
  let top: number
  if ((preferRight && fitsRight) || (fitsRight && !fitsLeft)) {
    side = 'right'
    left = anchor.right + CARD_GAP
    top = anchor.top
  } else if (fitsLeft) {
    side = 'left'
    left = anchor.left - CARD_GAP - card.width
    top = anchor.top
  } else {
    left = anchor.left + anchor.width / 2 - card.width / 2
    const below = anchor.bottom + CARD_GAP
    if (below + card.height <= viewport.height - CARD_EDGE || anchor.top - CARD_GAP - card.height < CARD_EDGE) {
      side = 'below'
      top = below
    } else {
      side = 'above'
      top = anchor.top - CARD_GAP - card.height
    }
  }
  const maxLeft = Math.max(CARD_EDGE, viewport.width - CARD_EDGE - card.width)
  const maxTop = Math.max(CARD_EDGE, viewport.height - CARD_EDGE - card.height)
  return {
    side,
    left: Math.round(Math.min(Math.max(left, CARD_EDGE), maxLeft)),
    top: Math.round(Math.min(Math.max(top, CARD_EDGE), maxTop)),
  }
}
