/**
 * What the event card works out from an event (event-details.ts): its date
 * line, the call's service, the guests, whether "Going?" can be answered, the
 * .ics file, mail links and where the card sits. People and addresses are made up.
 */
import { describe, expect, it } from 'vitest'
import type { IEvent } from '@/calendar/interfaces'
import {
  canAnswerHere,
  descriptionText,
  eventDateLine,
  eventGuests,
  eventToIcs,
  icsFileName,
  initials,
  mailtoHref,
  meetingProviderName,
  otherGuestEmails,
  placeCard,
  CARD_EDGE,
  CARD_GAP,
} from '../event-details'

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString()

const base: IEvent = {
  id: 'evt-1',
  title: 'Design review',
  color: 'blue',
  description: '',
  startDate: at(2026, 11, 18, 8),
  endDate: at(2026, 11, 18, 9),
  provider: 'google',
  icalUid: 'uid-1@example.com',
  accountEmail: 'ana@example.com',
}

const ana = { email: 'ana@example.com', name: 'Ana Ruiz' }
const ben = { email: 'ben@example.com', name: 'Ben Okafor', isOrganizer: true, responseStatus: 'accepted' }
const cy = { email: 'cy@example.com', responseStatus: 'declined' }

describe('eventDateLine', () => {
  it('reads a timed event as its day and times', () => {
    expect(eventDateLine(base)).toBe('Wed, November 18 · 8:00 AM–9:00 AM')
  })
  it('names both days of a timed event over midnight', () => {
    expect(eventDateLine({ ...base, startDate: at(2026, 11, 18, 22), endDate: at(2026, 11, 19, 1) })).toBe('Wed, Nov 18, 10:00 PM – Thu, Nov 19, 1:00 AM')
  })
  it('reads an all-day event by its days (the end is the last day covered)', () => {
    expect(eventDateLine({ ...base, isAllDay: true, startDate: '2026-11-18', endDate: '2026-11-18' })).toBe('Wed, November 18 · All day')
    expect(eventDateLine({ ...base, isAllDay: true, startDate: '2026-11-18', endDate: '2026-11-20' })).toBe('Wed, Nov 18 – Fri, Nov 20 · All day')
  })
})

describe('meetingProviderName', () => {
  it('names the services it knows by their address, and nothing else', () => {
    expect(meetingProviderName('https://meet.google.com/abc-defg-hij')).toBe('Google Meet')
    expect(meetingProviderName('https://us02web.zoom.us/j/123')).toBe('Zoom')
    expect(meetingProviderName('https://teams.microsoft.com/l/meetup-join/x')).toBe('Microsoft Teams')
    expect(meetingProviderName('https://notzoom.us.example.com/j/1')).toBeNull()
    expect(meetingProviderName('not a url')).toBeNull()
    expect(meetingProviderName(undefined)).toBeNull()
  })
})

describe('eventGuests', () => {
  it('puts the organizer first, then the person, each once, with their answers', () => {
    const guests = eventGuests({ ...base, response: 'tentative', attendeeDetails: [cy, ana, ben, { ...cy, email: 'CY@example.com' }] })
    expect(guests.map((g) => [g.email, g.isOrganizer, g.isSelf, g.response])).toEqual([
      ['ben@example.com', true, false, 'accepted'],
      // The person's own answer is the grid's.
      ['ana@example.com', false, true, 'tentative'],
      ['cy@example.com', false, false, 'declined'],
    ])
  })
  it('falls back to the bare addresses', () => {
    expect(eventGuests({ ...base, attendees: ['ben@example.com'] })).toEqual([
      { email: 'ben@example.com', name: null, isOrganizer: false, isSelf: false, response: 'pending' },
    ])
  })
  it('leaves the person out of the addresses to write to', () => {
    expect(otherGuestEmails({ ...base, attendeeDetails: [ana, ben, cy] })).toEqual(['ben@example.com', 'cy@example.com'])
  })
})

describe('initials', () => {
  it('takes the first and last name, else the address', () => {
    expect(initials({ name: 'Ana María Ruiz', email: 'x' })).toBe('AR')
    expect(initials({ name: 'Ben', email: 'x' })).toBe('BE')
    expect(initials({ name: null, email: 'cy@example.com' })).toBe('CY')
  })
})

describe('canAnswerHere', () => {
  it('offers Going? to a guest of a Google or Microsoft event', () => {
    expect(canAnswerHere({ ...base, response: 'pending', attendeeDetails: [ben, ana] })).toBe(true)
    expect(canAnswerHere({ ...base, provider: 'microsoft', response: 'accepted', attendeeDetails: [ben, ana] })).toBe(true)
  })
  it('not to the organizer, nor for their own event with no one invited', () => {
    expect(canAnswerHere({ ...base, response: 'accepted', attendeeDetails: [{ ...ana, isOrganizer: true }, cy] })).toBe(false)
    expect(canAnswerHere({ ...base })).toBe(false)
    // Microsoft's organizer reads as accepted, with no list naming anyone else the organizer.
    expect(canAnswerHere({ ...base, provider: 'microsoft', response: 'accepted' })).toBe(false)
  })
  it('a guest whose own row is missing still answers when the calendar holds a guest’s answer', () => {
    expect(canAnswerHere({ ...base, response: 'pending' })).toBe(true)
    expect(canAnswerHere({ ...base, response: 'accepted', attendeeDetails: [ben] })).toBe(true)
  })
  it('not without an iCalendar UID, on the Mac’s local calendar, or for a task', () => {
    const guest = { ...base, response: 'pending' as const, attendeeDetails: [ben, ana] }
    expect(canAnswerHere({ ...guest, icalUid: undefined })).toBe(false)
    expect(canAnswerHere({ ...guest, source: 'local_exchange' })).toBe(false)
    expect(canAnswerHere({ ...guest, isAction: true })).toBe(false)
  })
})

describe('descriptionText', () => {
  it('leaves plain text, and reads HTML as text with its links kept', () => {
    expect(descriptionText('Agenda:\n1. Intro')).toBe('Agenda:\n1. Intro')
    expect(descriptionText('Notes<br>See <a href="https://example.com/doc">the doc</a> &amp; more')).toBe('Notes\nSee the doc (https://example.com/doc) & more')
    expect(descriptionText('<html><head><style>p{color:red}</style></head><body><p>Hi</p></body></html>')).toBe('Hi')
  })
})

describe('mailtoHref', () => {
  it('lists the addresses and encodes the subject and body', () => {
    expect(mailtoHref(['ben@example.com', 'cy@example.com'], 'Design review', 'A & B')).toBe('mailto:ben@example.com,cy@example.com?subject=Design%20review&body=A%20%26%20B')
    expect(mailtoHref([], 'Hi')).toBe('mailto:?subject=Hi')
  })
})

describe('eventToIcs', () => {
  const now = new Date(Date.UTC(2026, 10, 22, 12, 0, 0))

  it('writes a timed event in UTC, with its guests and escaped text, in CRLF lines', () => {
    const ics = eventToIcs(
      {
        ...base,
        title: 'Review; budget, Q4',
        description: 'Line one\nLine two',
        location: 'Room 4, Floor 2',
        conferenceUrl: 'https://meet.google.com/abc-defg-hij',
        attendeeDetails: [ben, cy],
      },
      now,
    )
    const lines = ics.split('\r\n')
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(lines).toContain('UID:uid-1@example.com')
    expect(lines).toContain('DTSTAMP:20261122T120000Z')
    expect(lines).toContain(`DTSTART:${new Date(base.startDate).toISOString().replace(/[-:]/g, '').replace('.000', '')}`)
    expect(lines).toContain('SUMMARY:Review\\; budget\\, Q4')
    expect(lines).toContain('LOCATION:Room 4\\, Floor 2')
    expect(lines).toContain('URL:https://meet.google.com/abc-defg-hij')
    expect(lines).toContain('ORGANIZER;CN="Ben Okafor":mailto:ben@example.com')
    expect(lines).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED:mailto:cy@example.com')
    expect(ics.replace(/\r\n /g, '')).toContain('DESCRIPTION:Line one\\nLine two\\n\\nJoin: https://meet.google.com/abc-defg-hij')
  })

  it('writes an all-day event as dates, its end the day after the last', () => {
    const ics = eventToIcs({ ...base, isAllDay: true, startDate: '2026-11-18', endDate: '2026-11-20' }, now)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261118\r\n')
    expect(ics).toContain('DTEND;VALUE=DATE:20261121\r\n')
  })

  it('folds a long line at 75 octets without splitting a character', () => {
    const ics = eventToIcs({ ...base, description: 'é'.repeat(100) }, now)
    const encoder = new TextEncoder()
    for (const line of ics.split('\r\n')) expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain(`DESCRIPTION:${'é'.repeat(100)}`)
  })

  it('names the file after the title', () => {
    expect(icsFileName({ title: 'Café sync: Q4 / plans' })).toBe('cafe-sync-q4-plans.ics')
    expect(icsFileName({ title: '' })).toBe('event.ics')
  })
})

describe('placeCard', () => {
  const viewport = { width: 1400, height: 900 }
  const card = { width: 380, height: 500 }
  const rect = (left: number, top: number, width = 150, height = 60) => ({ left, top, width, height, right: left + width, bottom: top + height })

  it('sits on the right of a block on the left half', () => {
    expect(placeCard(rect(300, 200), card, viewport)).toEqual({ side: 'right', left: 450 + CARD_GAP, top: 200 })
  })
  it('flips to the left of a block on the right half', () => {
    expect(placeCard(rect(1000, 200), card, viewport)).toEqual({ side: 'left', left: 1000 - CARD_GAP - 380, top: 200 })
  })
  it('flips to the right when the left has no room', () => {
    expect(placeCard(rect(200, 100, 1000), card, { width: 1700, height: 900 }).side).toBe('right')
  })
  it('shifts up to stay on screen', () => {
    expect(placeCard(rect(300, 700), card, viewport).top).toBe(900 - CARD_EDGE - 500)
  })
  it('goes below or above a block as wide as the window', () => {
    expect(placeCard(rect(0, 100, 1400, 40), card, viewport)).toMatchObject({ side: 'below', top: 140 + CARD_GAP })
    expect(placeCard(rect(0, 700, 1400, 40), card, viewport)).toMatchObject({ side: 'above', top: 700 - CARD_GAP - 500 })
  })
})
