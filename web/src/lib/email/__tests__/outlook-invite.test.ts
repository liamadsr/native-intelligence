/**
 * Outlook's own meeting requests and attachment lists, as the thread read
 * gets them: the requests sent to Graph (recorded shapes) and what comes back
 * as the invitation card's data. People and meetings are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOutlookEventMessage, outlookAttachmentList, outlookEventInvite } from '../outlook-invite'

interface Call {
  url: string
  auth: string | null
}
let calls: Call[]
let respond: (url: string) => { status: number; json?: unknown }
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  respond = () => ({ status: 404 })
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null })
    const { status, json } = respond(url)
    return { ok: status >= 200 && status < 300, status, json: async () => json ?? {} } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

const person = (name: string, address: string) => ({ emailAddress: { name, address } })
// A thread-list row for a meeting request: Graph marks the derived type even under $select.
const LISTED = {
  '@odata.type': '#microsoft.graph.eventMessage',
  id: 'AAMkAGI2=',
  subject: 'Quarterly review with Harbor Labs',
  from: person('Marcus Oyelaran', 'Marcus@Northwind.example'),
  isDraft: false,
}
const EVENT = {
  id: 'AAMk-event',
  subject: 'Quarterly review with Harbor Labs',
  isAllDay: false,
  isCancelled: false,
  type: 'singleInstance',
  iCalUId: '040000008200E00074C5B7101A82E00800000000A0B1',
  start: { dateTime: '2026-12-03T18:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-12-03T19:00:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Microsoft Teams Meeting' },
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc' },
  organizer: person('Marcus Oyelaran', 'marcus@northwind.example'),
  attendees: [
    { type: 'required', status: { response: 'none' }, ...person('Sam Rivera', 'sam@harborlabs.example') },
    { type: 'optional', status: { response: 'tentativelyAccepted' }, ...person('Dana Whitfield', 'dana@northwind.example') },
    { type: 'resource', status: { response: 'accepted' }, ...person('Room 4B', 'room4b@northwind.example') },
    { type: 'required', status: { response: 'declined' }, ...person('jo@example.net', 'jo@example.net') },
  ],
}
const FULL = { ...LISTED, meetingMessageType: 'meetingRequest', type: 'singleInstance', isAllDay: false, event: EVENT }

describe('isOutlookEventMessage', () => {
  it('knows a meeting message by its Graph type, and nothing else', () => {
    expect(isOutlookEventMessage(LISTED)).toBe(true)
    expect(isOutlookEventMessage({ '@odata.type': '#microsoft.graph.eventMessageRequest', id: 'x' })).toBe(true)
    expect(isOutlookEventMessage({ '@odata.type': '#microsoft.graph.message', id: 'x' })).toBe(false)
    expect(isOutlookEventMessage({ id: 'x', subject: 'Invitation: lunch' })).toBe(false)
  })
})

describe('outlookEventInvite', () => {
  it('asks nothing for a message that is not a meeting message', async () => {
    expect(await outlookEventInvite('m-token', { id: 'plain', subject: 'Hello' })).toBeNull()
    expect(calls).toEqual([])
  })

  it('reads the message’s linked event, with the mailbox’s token, into the card’s invitation', async () => {
    respond = () => ({ status: 200, json: FULL })
    const invite = await outlookEventInvite('m-token', LISTED)
    expect(calls).toEqual([
      {
        url: 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2=?$expand=microsoft.graph.eventMessage/event($select=id,subject,start,end,isAllDay,location,organizer,attendees,iCalUId,onlineMeeting,isCancelled,type)',
        auth: 'Bearer m-token',
      },
    ])
    expect(invite).toEqual({
      method: 'REQUEST',
      uid: '040000008200E00074C5B7101A82E00800000000A0B1',
      title: 'Quarterly review with Harbor Labs',
      start: '2026-12-03T18:00:00.000Z',
      end: '2026-12-03T19:00:00.000Z',
      allDay: false,
      location: 'Microsoft Teams Meeting',
      conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
      organizer: { name: 'Marcus Oyelaran', email: 'marcus@northwind.example' },
      attendees: [
        { name: 'Sam Rivera', email: 'sam@harborlabs.example', status: 'pending' },
        { name: 'Dana Whitfield', email: 'dana@northwind.example', status: 'tentative', optional: true },
        { name: null, email: 'jo@example.net', status: 'declined' },
      ],
      attendeesOmitted: 0,
      updated: false,
    })
  })

  it('says an all-day meeting by its days (the last one inclusive), never as instants', async () => {
    respond = () => ({
      status: 200,
      json: { ...FULL, event: { ...EVENT, isAllDay: true, start: { dateTime: '2026-11-26T00:00:00.0000000' }, end: { dateTime: '2026-11-28T00:00:00.0000000' } } },
    })
    expect(await outlookEventInvite('m-token', LISTED)).toMatchObject({ allDay: true, start: '2026-11-26', end: '2026-11-27' })
    respond = () => ({
      status: 200,
      json: { ...FULL, event: { ...EVENT, isAllDay: true, start: { dateTime: '2026-11-26T00:00:00.0000000' }, end: { dateTime: '2026-11-27T00:00:00.0000000' } } },
    })
    expect(await outlookEventInvite('m-token', LISTED)).toMatchObject({ allDay: true, start: '2026-11-26', end: null })
  })

  it('reads a cancellation and a reply as what they are', async () => {
    respond = () => ({ status: 200, json: { ...FULL, meetingMessageType: 'meetingCancelled' } })
    expect((await outlookEventInvite('m-token', LISTED))!.method).toBe('CANCEL')
    respond = () => ({ status: 200, json: { ...FULL, meetingMessageType: 'meetingRequest', event: { ...EVENT, isCancelled: true } } })
    expect((await outlookEventInvite('m-token', LISTED))!.method).toBe('CANCEL')
    respond = () => ({ status: 200, json: { ...FULL, meetingMessageType: 'meetingTenativelyAccepted' } })
    expect((await outlookEventInvite('m-token', LISTED))!.method).toBe('REPLY')
  })

  it('falls back to what the message itself says when its event can’t be expanded: readable, with no UID to answer by', async () => {
    respond = (url) =>
      url.includes('$expand')
        ? { status: 403 }
        : {
            status: 200,
            json: {
              ...LISTED,
              meetingMessageType: 'meetingRequest',
              isAllDay: false,
              startDateTime: { dateTime: '2026-12-03T18:00:00.0000000', timeZone: 'UTC' },
              endDateTime: { dateTime: '2026-12-03T19:00:00.0000000', timeZone: 'UTC' },
              location: { displayName: 'Room 4B' },
              toRecipients: [person('Sam Rivera', 'sam@harborlabs.example')],
              ccRecipients: [person('Marcus Oyelaran', 'marcus@northwind.example')],
            },
          }
    const invite = await outlookEventInvite('m-token', LISTED)
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('$expand=microsoft.graph.eventMessage/event'), 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2='])
    expect(invite).toMatchObject({
      method: 'REQUEST',
      uid: null,
      title: 'Quarterly review with Harbor Labs',
      start: '2026-12-03T18:00:00.000Z',
      end: '2026-12-03T19:00:00.000Z',
      location: 'Room 4B',
      conferenceUrl: null,
      organizer: { name: 'Marcus Oyelaran', email: 'marcus@northwind.example' },
      attendees: [{ name: 'Sam Rivera', email: 'sam@harborlabs.example', status: 'pending' }],
    })
  })

  it('draws no card when nothing can be read, or the meeting says no time; it never throws', async () => {
    respond = () => ({ status: 500 })
    expect(await outlookEventInvite('m-token', LISTED)).toBeNull()
    respond = () => ({ status: 200, json: { ...LISTED, meetingMessageType: 'meetingRequest' } })
    expect(await outlookEventInvite('m-token', LISTED)).toBeNull()
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await outlookEventInvite('m-token', LISTED)).toBeNull()
  })

  it('keeps a call link only when it is https, and every value as plain text', async () => {
    respond = () => ({
      status: 200,
      json: { ...FULL, event: { ...EVENT, subject: '<img src=x onerror=alert(1)>', onlineMeeting: { joinUrl: 'javascript:alert(1)' } } },
    })
    const invite = await outlookEventInvite('m-token', LISTED)
    expect(invite!.conferenceUrl).toBeNull()
    expect(invite!.title).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('outlookAttachmentList', () => {
  it('lists a message’s files by name, size and type, inline images left out', async () => {
    respond = () => ({
      status: 200,
      json: {
        value: [
          { id: 'a1', name: 'invite.ics', size: 2210, contentType: 'text/calendar', isInline: false },
          { id: 'a2', name: 'logo.png', size: 9000, contentType: 'image/png', isInline: true },
          { id: 'a3', name: '', size: 12 },
        ],
      },
    })
    expect(await outlookAttachmentList('m-token', 'AAMkAGI2=')).toEqual([
      { name: 'invite.ics', size: 2210, mimeType: 'text/calendar' },
      { name: 'attachment', size: 12, mimeType: 'application/octet-stream' },
    ])
    expect(calls).toEqual([{ url: 'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2=/attachments?$select=id,name,size,contentType,isInline', auth: 'Bearer m-token' }])
  })

  it('is empty when the list can’t be read', async () => {
    respond = () => ({ status: 403 })
    expect(await outlookAttachmentList('m-token', 'x')).toEqual([])
  })
})
