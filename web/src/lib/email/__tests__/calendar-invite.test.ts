/** Invitations as mail clients send them. Every person and address is made up. */
import { describe, expect, it } from 'vitest'
import { INVITE_MAX_BYTES, isCalendarAttachment, parseCalendarInvite } from '../calendar-invite'

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Example//Calendar//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART:20261126T190000Z',
  'DTEND:20261126T194500Z',
  'ORGANIZER;CN=Priya Natarajan:mailto:priya@example.org',
  'UID:evt-7781@example.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Priya Na',
  ' tarajan;X-NUM-GUESTS=0:mailto:priya@example.org',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE',
  ' ;CN=sam@example.com;X-NUM-GUESTS=0:mailto:sam@example.com',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;CN="Whitfield, Dana":mailto:dana@example.org',
  'ATTENDEE;CUTYPE=ROOM;PARTSTAT=ACCEPTED;CN=Room 4:mailto:room4@example.org',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'DESCRIPTION:Agenda\\, notes\\nand a second line',
  'LOCATION:Harbor Labs\\, 4th floor',
  'SEQUENCE:0',
  'SUMMARY:Planning call',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H10M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('parseCalendarInvite', () => {
  it('reads a Google invitation: folded lines, guests, the organizer, the call link', () => {
    const invite = parseCalendarInvite(GOOGLE)!
    expect(invite).toMatchObject({
      method: 'REQUEST',
      uid: 'evt-7781@example.com',
      title: 'Planning call',
      start: '2026-11-26T19:00:00.000Z',
      end: '2026-11-26T19:45:00.000Z',
      allDay: false,
      location: 'Harbor Labs, 4th floor',
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      organizer: { name: 'Priya Natarajan', email: 'priya@example.org' },
      updated: false,
    })
    expect(invite.attendees).toEqual([
      { name: 'Priya Natarajan', email: 'priya@example.org', status: 'accepted' },
      // A name that is only the address is no name.
      { name: null, email: 'sam@example.com', status: 'pending' },
      { name: 'Whitfield, Dana', email: 'dana@example.org', status: 'tentative', optional: true },
    ])
  })

  it('does not take the alarm’s description for the event’s', () => {
    expect(parseCalendarInvite(GOOGLE)!.title).toBe('Planning call')
  })

  it('places a time given in a named zone, on either side of a clock change', () => {
    const at = (line: string) =>
      parseCalendarInvite(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\n${line}\nEND:VEVENT\nEND:VCALENDAR`)!.start
    // New York: UTC-5 in November, UTC-4 in July.
    expect(at('DTSTART;TZID=America/New_York:20261126T140000')).toBe('2026-11-26T19:00:00.000Z')
    expect(at('DTSTART;TZID=America/New_York:20260715T140000')).toBe('2026-07-15T18:00:00.000Z')
    expect(at('DTSTART;TZID=Asia/Kolkata:20261126T093000')).toBe('2026-11-26T04:00:00.000Z')
  })

  it('leaves a floating time, or one in a zone it cannot place, on the reader’s clock', () => {
    const invite = parseCalendarInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART;TZID=Customized Time Zone:20261126T140000\nEND:VEVENT\nEND:VCALENDAR')!
    expect(invite.start).toBe('2026-11-26T14:00:00')
  })

  it('reads an all-day event, its end as the last day covered', () => {
    const one = parseCalendarInvite('BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\nSUMMARY:Offsite\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261202\nEND:VEVENT\nEND:VCALENDAR')!
    expect(one).toMatchObject({ allDay: true, start: '2026-12-01', end: null })
    const three = parseCalendarInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Offsite\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261204\nEND:VEVENT\nEND:VCALENDAR')!
    expect(three).toMatchObject({ start: '2026-12-01', end: '2026-12-03' })
  })

  it('reads a cancellation and an update', () => {
    const cancel = parseCalendarInvite('BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nSUMMARY:Planning call\nDTSTART:20261126T190000Z\nSEQUENCE:2\nEND:VEVENT\nEND:VCALENDAR')!
    expect(cancel.method).toBe('CANCEL')
    expect(cancel.updated).toBe(true)
  })

  it('finds a call link in the location or description, and only a known host’s', () => {
    const ics = (extra: string) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART:20261126T190000Z\n${extra}\nEND:VEVENT\nEND:VCALENDAR`
    expect(parseCalendarInvite(ics('DESCRIPTION:Join: https://example.zoom.us/j/5550100 (passcode in chat)'))!.conferenceUrl).toBe('https://example.zoom.us/j/5550100')
    expect(parseCalendarInvite(ics('DESCRIPTION:See https://example.com/agenda'))!.conferenceUrl).toBeNull()
    expect(parseCalendarInvite(ics('X-GOOGLE-CONFERENCE:javascript:alert(1)'))!.conferenceUrl).toBeNull()
  })

  it('drops guests without a real address and counts no one twice', () => {
    const invite = parseCalendarInvite(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART:20261126T190000Z\nATTENDEE;CN=Nobody:mailto:not-an-address\nATTENDEE;CN=Jo:MAILTO:Jo@Example.net\nATTENDEE;CN=Jo again:mailto:jo@example.net\nEND:VEVENT\nEND:VCALENDAR',
    )!
    expect(invite.attendees).toEqual([{ name: 'Jo', email: 'jo@example.net', status: 'pending' }])
  })

  it('reads only the first event', () => {
    const invite = parseCalendarInvite(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:First\nDTSTART:20261126T190000Z\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Second\nDTSTART:20261127T190000Z\nATTENDEE:mailto:x@example.org\nEND:VEVENT\nEND:VCALENDAR',
    )!
    expect(invite.title).toBe('First')
    expect(invite.attendees).toEqual([])
  })

  it('returns null for what is not an invitation it can show', () => {
    expect(parseCalendarInvite(null)).toBeNull()
    expect(parseCalendarInvite('')).toBeNull()
    expect(parseCalendarInvite('Hello, see you Thursday')).toBeNull()
    expect(parseCalendarInvite('BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR')).toBeNull()
    expect(parseCalendarInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:No time\nEND:VEVENT\nEND:VCALENDAR')).toBeNull()
    expect(parseCalendarInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:garbage\nEND:VEVENT\nEND:VCALENDAR')).toBeNull()
    expect(parseCalendarInvite(`BEGIN:VCALENDAR\n${'X'.repeat(INVITE_MAX_BYTES)}`)).toBeNull()
  })

  it('gives every value back as plain text, markup and all', () => {
    const invite = parseCalendarInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:<img src=x onerror=alert(1)>\nDTSTART:20261126T190000Z\nLOCATION:<script>alert(1)</script>\nEND:VEVENT\nEND:VCALENDAR')!
    // Plain strings: the card renders them as text, never as HTML.
    expect(invite.title).toBe('<img src=x onerror=alert(1)>')
    expect(invite.location).toBe('<script>alert(1)</script>')
  })
})

describe('isCalendarAttachment', () => {
  it('knows a calendar file by type or by name', () => {
    expect(isCalendarAttachment({ name: 'invite.ics', mimeType: 'application/octet-stream' })).toBe(true)
    expect(isCalendarAttachment({ name: 'meeting', mimeType: 'text/calendar; method=REQUEST' })).toBe(true)
    expect(isCalendarAttachment({ name: 'x', mimeType: 'application/ics' })).toBe(true)
    expect(isCalendarAttachment({ name: 'notes.pdf', mimeType: 'application/pdf' })).toBe(false)
  })
})
