/**
 * The invitation in an attached calendar file: the person's own mailbox, a
 * hard size cap on what is downloaded, parsed to plain fields, nothing the
 * file names fetched. The people and the meeting are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: mocks.auth }))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailAttachment: mocks.read }))

import { GET } from '../route'
import { INVITE_MAX_BYTES } from '@/lib/email/calendar-invite'

const request = (query: string) => new NextRequest(`http://localhost/api/account/email/threads/t1/invite${query}`)
const bytes = (text: string) => new TextEncoder().encode(text)

// As Outlook attaches it: CRLF lines, a folded line, a zone by name.
const OUTLOOK_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Priya Natarajan:mailto:priya@example.org',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Sam Rivera:mailto:sam@example.com',
  'ATTACH:https://tracker.example.org/open.gif?who=sam',
  'DESCRIPTION:Quarterly review.\\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
  'UID:040000008200E00074C5B7101A82E00800000000A0B1',
  'SUMMARY:Quarterly review with Harbor',
  '  Labs',
  'DTSTART;TZID=America/New_York:20261203T100000',
  'DTEND;TZID=America/New_York:20261203T110000',
  'SEQUENCE:0',
  'LOCATION:Microsoft Teams Meeting',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const originalFetch = globalThis.fetch
beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: 'u1' }, workspaceId: 'w1' })
  mocks.read.mockReset()
  globalThis.fetch = vi.fn(async () => {
    throw new Error('the invite route must fetch nothing')
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('GET /api/account/email/threads/[threadId]/invite', () => {
  it('answers what the auth helper answers when nobody is signed in', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await GET(request('?message=m1&name=invite.ics'))).status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('needs a message and a name', async () => {
    expect((await GET(request('?message=m1'))).status).toBe(400)
    expect((await GET(request('?name=invite.ics'))).status).toBe(400)
    expect((await GET(request(`?message=${'m'.repeat(513)}&name=invite.ics`))).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('reads the file from the person’s own mailboxes in this workspace, capped at an invitation’s size', async () => {
    mocks.read.mockResolvedValue({ fileName: 'invite.ics', bytes: bytes(OUTLOOK_ICS) })
    const res = await GET(request('?message=m1&name=invite.ics'))
    expect(mocks.read).toHaveBeenCalledWith('u1', 'm1', 'invite.ics', 'w1', INVITE_MAX_BYTES)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
    const { invite } = await res.json()
    expect(invite).toMatchObject({
      method: 'REQUEST',
      uid: '040000008200E00074C5B7101A82E00800000000A0B1',
      title: 'Quarterly review with Harbor Labs',
      start: '2026-12-03T15:00:00.000Z',
      end: '2026-12-03T16:00:00.000Z',
      allDay: false,
      location: 'Microsoft Teams Meeting',
      conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
      organizer: { name: 'Priya Natarajan', email: 'priya@example.org' },
      attendees: [{ name: 'Sam Rivera', email: 'sam@example.com', status: 'pending' }],
    })
  })

  it('fetches nothing the file names (an ATTACH link, a tracking image)', async () => {
    mocks.read.mockResolvedValue({ fileName: 'invite.ics', bytes: bytes(OUTLOOK_ICS) })
    await GET(request('?message=m1&name=invite.ics'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('is a 404 when the file isn’t there or is over the cap (the reader returns nothing)', async () => {
    mocks.read.mockResolvedValue(null)
    expect((await GET(request('?message=m1&name=invite.ics'))).status).toBe(404)
  })

  it('is a 404 for a file that holds no event, and for bytes that are not text', async () => {
    mocks.read.mockResolvedValue({ fileName: 'notes.ics', bytes: bytes('BEGIN:VCALENDAR\r\nEND:VCALENDAR') })
    expect((await GET(request('?message=m1&name=notes.ics'))).status).toBe(404)
    mocks.read.mockResolvedValue({ fileName: 'x.ics', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81]) })
    expect((await GET(request('?message=m1&name=x.ics'))).status).toBe(404)
  })

  it('is a 500 with the shared error shape when the read throws', async () => {
    mocks.read.mockRejectedValue(new Error('boom'))
    const res = await GET(request('?message=m1&name=invite.ics'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Couldn't read that calendar file")
  })
})
