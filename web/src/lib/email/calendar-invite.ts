/**
 * A calendar invitation read out of an email: the iCalendar text Google,
 * Outlook and the rest send as a `text/calendar` part (and often again as
 * `invite.ics`). Enough of RFC 5545 for the invitation card: the first VEVENT's
 * title, time, place, organizer and guests. Recurrence rules, alarms and
 * time-zone definitions are not read.
 *
 * Pure, and safe on anything: the text comes from whoever sent the mail. It is
 * capped, never evaluated, and every value comes out as plain text.
 */

/** A calendar part larger than this is not read (a real invitation is a few KB). */
export const INVITE_MAX_BYTES = 256 * 1024
/** Guests kept: the card shows a few and counts the rest. */
const MAX_ATTENDEES = 200

export type InviteMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | 'COUNTER' | 'OTHER'
export type InviteResponse = 'accepted' | 'declined' | 'tentative' | 'pending'

export interface InvitePerson {
  name: string | null
  email: string
}

export interface InviteAttendee extends InvitePerson {
  status: InviteResponse
  optional?: boolean
}

export interface CalendarInvite {
  method: InviteMethod
  uid: string | null
  title: string
  /**
   * ISO instant for a time with a zone; `YYYY-MM-DD` for an all-day event;
   * `YYYY-MM-DDTHH:mm:ss` (no zone) for a floating time, read in the reader's own zone.
   */
  start: string
  /** As `start`. For an all-day event, the LAST day it covers (iCalendar's end is the day after). */
  end: string | null
  allDay: boolean
  location: string | null
  /** A video-call link the invitation names. Only http(s). */
  conferenceUrl: string | null
  organizer: InvitePerson | null
  attendees: InviteAttendee[]
  /** More guests than were kept. */
  attendeesOmitted: number
  /** SEQUENCE > 0: the organizer changed the event after first sending it. */
  updated: boolean
}

interface Line {
  name: string
  params: Record<string, string>
  value: string
}

/** RFC 5545 unfolding: a line that starts with a space or tab continues the one before. */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1)
    else out.push(raw)
  }
  return out
}

/** `NAME;PARAM=value;PARAM="quoted:value":the value`. */
function parseLine(line: string): Line | null {
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon < 1) return null
  const head = line.slice(0, colon)
  const parts: string[] = []
  let current = ''
  inQuotes = false
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes
    if (c === ';' && !inQuotes) {
      parts.push(current)
      current = ''
    } else current += c
  }
  parts.push(current)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(colon + 1) }
}

/** TEXT unescaping: `\n`, `\,`, `\;`, `\\`. */
function text(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c)).trim()
}

function emailOf(value: string): string | null {
  const address = value.replace(/^mailto:/i, '').trim().toLowerCase()
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address) ? address : null
}

function person(line: Line): InvitePerson | null {
  const email = emailOf(line.value) ?? (line.params.EMAIL ? emailOf(line.params.EMAIL) : null)
  if (!email) return null
  const name = line.params.CN?.trim()
  return { email, name: name && name.toLowerCase() !== email ? name : null }
}

function responseOf(partstat: string | undefined): InviteResponse {
  switch ((partstat ?? '').toUpperCase()) {
    case 'ACCEPTED':
      return 'accepted'
    case 'DECLINED':
      return 'declined'
    case 'TENTATIVE':
      return 'tentative'
    default:
      return 'pending'
  }
}

/** The UTC offset, in minutes, a zone has at a wall-clock time. Null for a zone this runtime doesn't know. */
function zoneOffsetMinutes(zone: string, wallAsUtc: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(wallAsUtc))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return (shown - wallAsUtc) / 60000
  } catch {
    return null
  }
}

interface ParsedTime {
  value: string
  allDay: boolean
}

/** DTSTART / DTEND: a date, a UTC time, a time in a named zone, or a floating time. */
function parseTime(line: Line): ParsedTime | null {
  const v = line.value.trim()
  const date = v.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (date) return { value: `${date[1]}-${date[2]}-${date[3]}`, allDay: true }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  if (Number.isNaN(wallAsUtc)) return null
  if (m[7] === 'Z') return { value: new Date(wallAsUtc).toISOString(), allDay: false }
  const zone = line.params.TZID
  if (zone) {
    // The offset at the wall time, then once more at the instant it gives (a time near a clock change).
    const first = zoneOffsetMinutes(zone, wallAsUtc)
    if (first !== null) {
      const second = zoneOffsetMinutes(zone, wallAsUtc - first * 60000) ?? first
      return { value: new Date(wallAsUtc - second * 60000).toISOString(), allDay: false }
    }
  }
  // Floating (or a zone we can't place): the reader's own clock.
  return { value: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, allDay: false }
}

const CONFERENCE_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)\//i

function httpUrl(value: string | undefined): string | null {
  const v = value?.trim()
  return v && /^https?:\/\/[^\s<>"']+$/i.test(v) ? v : null
}

function methodOf(value: string | undefined): InviteMethod {
  const m = (value ?? '').trim().toUpperCase()
  return m === 'REQUEST' || m === 'CANCEL' || m === 'REPLY' || m === 'PUBLISH' || m === 'COUNTER' ? m : 'OTHER'
}

/** The first event of an iCalendar text, or null when there is none to show. */
export function parseCalendarInvite(ics: string | null | undefined): CalendarInvite | null {
  if (!ics || ics.length > INVITE_MAX_BYTES || !/BEGIN:VCALENDAR/i.test(ics)) return null

  let method: string | undefined
  let inEvent = false
  let depth = 0
  let seen = false
  const event: Line[] = []
  for (const raw of unfold(ics)) {
    const line = parseLine(raw)
    if (!line) continue
    if (line.name === 'BEGIN') {
      const what = line.value.trim().toUpperCase()
      if (what === 'VEVENT' && !seen && !inEvent) inEvent = true
      else if (inEvent) depth++ // a VALARM inside the event: skipped
      continue
    }
    if (line.name === 'END') {
      if (inEvent && depth > 0) depth--
      else if (inEvent && line.value.trim().toUpperCase() === 'VEVENT') {
        inEvent = false
        seen = true
      }
      continue
    }
    if (inEvent && depth === 0) event.push(line)
    else if (!inEvent && line.name === 'METHOD') method = line.value
  }
  if (!seen) return null

  const first = (name: string) => event.find((l) => l.name === name)
  const startLine = first('DTSTART')
  const start = startLine ? parseTime(startLine) : null
  if (!start) return null
  const endLine = first('DTEND')
  let end = endLine ? parseTime(endLine) : null
  if (end && start.allDay && end.allDay) {
    // The day after the last day → the last day; a one-day event has no separate end.
    const [y, m, d] = end.value.split('-').map(Number)
    const last = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
    end = last > start.value ? { value: last, allDay: true } : null
  }

  const organizerLine = first('ORGANIZER')
  const organizer = organizerLine ? person(organizerLine) : null

  const attendees: InviteAttendee[] = []
  let omitted = 0
  const seenEmails = new Set<string>()
  for (const line of event) {
    if (line.name !== 'ATTENDEE') continue
    const who = person(line)
    if (!who || seenEmails.has(who.email)) continue
    // A room or a resource is not a guest.
    if (/^(ROOM|RESOURCE)$/i.test(line.params.CUTYPE ?? '')) continue
    seenEmails.add(who.email)
    if (attendees.length >= MAX_ATTENDEES) {
      omitted++
      continue
    }
    attendees.push({
      ...who,
      status: responseOf(line.params.PARTSTAT),
      ...(/^OPT-PARTICIPANT$/i.test(line.params.ROLE ?? '') ? { optional: true } : {}),
    })
  }

  const location = text(first('LOCATION')?.value ?? '') || null
  const description = text(first('DESCRIPTION')?.value ?? '')
  const conferenceUrl =
    httpUrl(first('X-GOOGLE-CONFERENCE')?.value) ??
    httpUrl(first('X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value) ??
    [location ?? '', description].flatMap((t) => t.match(/https:\/\/[^\s<>"')\]]+/g) ?? []).find((u) => CONFERENCE_HOSTS.test(u)) ??
    null

  return {
    method: methodOf(method),
    uid: text(first('UID')?.value ?? '') || null,
    title: text(first('SUMMARY')?.value ?? '').slice(0, 300) || '(no title)',
    start: start.value,
    end: end?.value ?? null,
    allDay: start.allDay,
    location: location ? location.slice(0, 500) : null,
    conferenceUrl,
    organizer,
    attendees,
    attendeesOmitted: omitted,
    updated: Number(first('SEQUENCE')?.value) > 0,
  }
}

/** Is this attachment a calendar file (by type or by name)? */
export function isCalendarAttachment(attachment: { name?: string | null; mimeType?: string | null }): boolean {
  const type = (attachment.mimeType ?? '').toLowerCase()
  return type.startsWith('text/calendar') || type === 'application/ics' || /\.ics$/i.test(attachment.name ?? '')
}
