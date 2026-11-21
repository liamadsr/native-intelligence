// @vitest-environment jsdom
/**
 * The invitation card and the attachment chips. People and addresses are made up.
 *
 * The card shows what the invitation says, marks the organizer, opens the full
 * guest list on "View all guest info", and says whose answer it is. Yes / No /
 * Maybe answer the invitation through the person's calendar: the card marks
 * the answer the calendar holds, the one being sent, and the new one; a reply
 * that fails leaves the old answer marked and says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { CalendarInvite } from '@/lib/email/calendar-invite'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock('@/lib/open-external', () => ({
  isOpenableUrl: (url: string) => /^https?:\/\//.test(url),
  openExternalUrl: async (url: string) => {
    opened.urls.push(url)
  },
}))

import { EmailInviteCard, InviteReplyError, inviteNote, inviteWhen, type InviteCalendarStatus } from '../email-invite-card'
import { attachedInviteFile, EmailAttachedInvite } from '../email-attached-invite'
import { INVITE_MAX_BYTES } from '@/lib/email/calendar-invite'
import { attachmentKind, EmailAttachments, formatFileSize } from '../email-attachments'

const INVITE: CalendarInvite = {
  method: 'REQUEST',
  uid: 'evt-7781@example.com',
  title: 'Planning call',
  start: new Date(2026, 10, 26, 14, 0).toISOString(),
  end: new Date(2026, 10, 26, 14, 45).toISOString(),
  allDay: false,
  location: 'Harbor Labs, 4th floor',
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  organizer: { name: 'Priya Natarajan', email: 'priya@example.org' },
  attendees: [
    { name: 'Sam Rivera', email: 'sam@example.com', status: 'pending' },
    { name: 'Priya Natarajan', email: 'priya@example.org', status: 'accepted' },
    { name: 'Dana Whitfield', email: 'dana@example.org', status: 'tentative' },
    { name: null, email: 'jo@example.net', status: 'declined' },
  ],
  attendeesOmitted: 0,
  updated: false,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  opened.urls = []
  replies.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type Reply = (invite: CalendarInvite, response: 'accepted' | 'declined' | 'tentative') => Promise<InviteCalendarStatus>
const LINK = 'https://calendar.example.com/event/7781'
const ON_CALENDAR: InviteCalendarStatus = { found: true, response: 'pending', link: LINK, canAnswer: true, provider: 'google', accountEmail: 'sam@example.com' }
const replies = vi.fn<Reply>()

async function renderCard(invite: CalendarInvite, found: InviteCalendarStatus | null, reply: Reply = replies) {
  const lookup = async () => found
  await act(async () => {
    root.render(h(EmailInviteCard, { invite, ownAddresses: new Set(['sam@example.com']), lookup, reply }))
  })
}
const note = () => container.querySelector('[data-invite-note]')!
const pressed = () => [...container.querySelectorAll('[data-invite-answer]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-invite-answer'))
/** A reply the test settles by hand. */
function deferred() {
  let resolve!: (status: InviteCalendarStatus) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<InviteCalendarStatus>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const text = () => container.textContent ?? ''
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!

describe('EmailInviteCard', () => {
  it('shows what, when, where and the guests, organizer first and marked', async () => {
    await renderCard(INVITE, null)
    expect(text()).toContain('Invitation')
    expect(text()).toContain('Planning call')
    expect(text()).toContain(inviteWhen(INVITE))
    expect(text()).toContain('Harbor Labs, 4th floor')
    expect(text()).toContain('Priya Natarajan (organizer), Sam Rivera, Dana Whitfield')
    expect(text()).toContain('+1 more')
  })

  it('opens every guest and their answer on "View all guest info"', async () => {
    await renderCard(INVITE, null)
    expect(container.querySelector('[data-invite-guests]')).toBeNull()
    act(() => button('View all guest info').click())
    const rows = [...container.querySelectorAll('[data-invite-guests] li')].map((li) => li.textContent)
    expect(rows).toEqual([
      'Priya Natarajan · priya@example.org (organizer)Organizer',
      'Sam Rivera · sam@example.comNot answered',
      'Dana Whitfield · dana@example.orgMaybe',
      'jo@example.netNo',
    ])
  })

  it('says whose answer it is, and marks the answer the calendar holds', async () => {
    await renderCard(INVITE, { ...ON_CALENDAR, response: 'tentative' })
    expect(text()).toContain('Reply for sam@example.com')
    expect(pressed()).toEqual(['tentative'])
    expect(note().textContent).toBe('Your calendar (sam@example.com) has your answer: Maybe. Choose another to change it.')
  })

  it('answers the invitation: the answer is sent for this invitation, marked while it goes, and kept when the calendar took it', async () => {
    const sending = deferred()
    replies.mockReturnValue(sending.promise)
    await renderCard(INVITE, ON_CALENDAR)
    expect(pressed()).toEqual([])
    act(() => button('Yes').click())
    expect(replies).toHaveBeenCalledTimes(1)
    expect(replies).toHaveBeenCalledWith(INVITE, 'accepted')
    // While it goes: the clicked answer is busy, the others can't be clicked, nothing is marked as given yet.
    expect(button('Yes').getAttribute('aria-busy')).toBe('true')
    expect(button('No').disabled).toBe(true)
    expect(button('Maybe').disabled).toBe(true)
    expect(note().textContent).toBe('Sending “Yes”…')
    act(() => button('Yes').click())
    expect(replies).toHaveBeenCalledTimes(1)

    await act(async () => sending.resolve({ ...ON_CALENDAR, response: 'accepted' }))
    expect(pressed()).toEqual(['accepted'])
    expect(note().textContent).toBe('You answered Yes. Priya Natarajan has been told.')
    expect(note().getAttribute('role')).toBe('status')
    expect(opened.urls).toEqual([])
    // The guest list follows: the person's own row shows the new answer.
    act(() => button('View all guest info').click())
    expect([...container.querySelectorAll('[data-invite-guests] li')].map((li) => li.textContent)).toContain('Sam Rivera · sam@example.comYes')
  })

  it('changes an answer already given, and does nothing when the same answer is clicked again', async () => {
    replies.mockResolvedValue({ ...ON_CALENDAR, response: 'declined', provider: 'microsoft' })
    await renderCard(INVITE, { ...ON_CALENDAR, response: 'accepted', provider: 'microsoft' })
    act(() => button('Yes').click())
    expect(replies).not.toHaveBeenCalled()
    await act(async () => button('No').click())
    expect(replies).toHaveBeenCalledWith(INVITE, 'declined')
    expect(pressed()).toEqual(['declined'])
    expect(note().textContent).toBe('You answered No. Priya Natarajan has been told, and Outlook has taken the event off your calendar.')
  })

  it('keeps the answer the calendar held when a reply fails, says why, and offers the calendar itself', async () => {
    replies.mockRejectedValue(new InviteReplyError('This event is no longer on your calendar.', 'RSVP_GONE'))
    await renderCard(INVITE, { ...ON_CALENDAR, response: 'tentative' })
    await act(async () => button('Yes').click())
    expect(pressed()).toEqual(['tentative'])
    expect(note().getAttribute('role')).toBe('alert')
    expect(note().textContent).toContain('This event is no longer on your calendar.')
    // Still where they were: every answer can be tried again, and the event opens in the calendar.
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-invite-answer]')) expect(b.disabled).toBe(false)
    act(() => container.querySelector<HTMLButtonElement>('[data-invite-open]')!.click())
    expect(opened.urls).toEqual([LINK])

    // Trying again clears the failure.
    replies.mockResolvedValue({ ...ON_CALENDAR, response: 'accepted' })
    await act(async () => button('Yes').click())
    expect(note().getAttribute('role')).toBe('status')
    expect(pressed()).toEqual(['accepted'])
  })

  it('opens the event in the calendar from "More options", without answering', async () => {
    await renderCard(INVITE, ON_CALENDAR)
    act(() => button('More options').click())
    expect(opened.urls).toEqual([LINK])
    expect(replies).not.toHaveBeenCalled()
  })

  it('disables the answers when the event is on no connected calendar, and says why', async () => {
    await renderCard(INVITE, null)
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-invite-answer], [data-invite-more]')) expect(b.disabled).toBe(true)
    expect(note().textContent).toContain('not on a connected calendar')
    act(() => button('Yes').click())
    expect(replies).not.toHaveBeenCalled()
    expect(opened.urls).toEqual([])
  })

  it('says what is in the way: no calendar, a sign-in to renew, a calendar that would not read, an event that can’t be answered', async () => {
    await renderCard(INVITE, { found: false, reason: 'no_calendar' })
    expect(note().textContent).toContain('No calendar is connected to this workspace')
    await renderCard({ ...INVITE }, { found: false, reason: 'reconnect', accountEmail: 'sam@example.com' })
    expect(note().textContent).toContain('Your calendar (sam@example.com) needs signing in again')
    await renderCard({ ...INVITE }, { found: false, reason: 'unreadable' })
    expect(note().textContent).toContain('couldn’t be read just now')
    await renderCard({ ...INVITE }, { found: true, response: null, link: LINK, canAnswer: false, blocked: 'not_invited' })
    expect(note().textContent).toContain('not on its guest list')
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-invite-answer]')) expect(b.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-invite-more]')!.disabled).toBe(false)
  })

  it('never lands a reply on another invitation: the card moved on while it was going', async () => {
    const sending = deferred()
    replies.mockReturnValue(sending.promise)
    await renderCard(INVITE, ON_CALENDAR)
    act(() => button('Yes').click())
    await renderCard({ ...INVITE, uid: 'evt-9000@example.com', title: 'Another call' }, { ...ON_CALENDAR, response: 'declined' })
    await act(async () => sending.resolve({ ...ON_CALENDAR, response: 'accepted' }))
    expect(pressed()).toEqual(['declined'])
  })

  it('joins the call through the external opener', async () => {
    await renderCard(INVITE, null)
    act(() => button('Join the call').click())
    expect(opened.urls).toEqual(['https://meet.google.com/abc-defg-hij'])
  })

  it('offers no answer on a cancellation, or to the organizer', async () => {
    await renderCard({ ...INVITE, method: 'CANCEL' }, null)
    expect(text()).toContain('Cancelled')
    expect(container.querySelector('[data-invite-answer]')).toBeNull()
    await act(async () => {
      root.render(h(EmailInviteCard, { invite: INVITE, ownAddresses: new Set(['priya@example.org']), lookup: async () => null }))
    })
    expect(container.querySelector('[data-invite-answer]')).toBeNull()
  })

  it('renders the invitation’s words as text, never as markup', async () => {
    await renderCard({ ...INVITE, title: '<img src=x onerror=alert(1)>', location: '<script>alert(1)</script>' }, null)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(text()).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('inviteNote', () => {
  it('says the plain state when nothing has been asked', () => {
    expect(inviteNote({ status: 'loading', sending: null, sent: null, error: null, organizer: null })).toBe('Looking for this event on your calendar…')
    expect(inviteNote({ status: { found: true, response: 'pending', canAnswer: true }, sending: null, sent: null, error: null, organizer: null })).toBe(
      'Your answer goes to the organizer from your calendar.',
    )
    expect(inviteNote({ status: { found: true, response: 'accepted', canAnswer: true }, sending: null, sent: 'accepted', error: null, organizer: null })).toBe(
      'You answered Yes. The organizer has been told.',
    )
  })
})

describe('EmailAttachedInvite', () => {
  const ics = { name: 'invite.ics', size: 2210, mimeType: 'application/octet-stream' }
  const pdf = { name: 'agenda.pdf', size: 48211, mimeType: 'application/pdf' }

  it('picks the first calendar file of an invitation’s size, by type or by name', () => {
    expect(attachedInviteFile([pdf, ics])).toBe(ics)
    expect(attachedInviteFile([{ name: 'meeting', size: 900, mimeType: 'text/calendar; method=REQUEST' }])?.name).toBe('meeting')
    expect(attachedInviteFile([pdf])).toBeNull()
    expect(attachedInviteFile([{ ...ics, size: INVITE_MAX_BYTES + 1 }])).toBeNull()
  })

  it('reads the attached file once and draws the same invitation card', async () => {
    const read = vi.fn(async () => INVITE)
    await act(async () => {
      root.render(h(EmailAttachedInvite, { attachments: [pdf, ics], hrefFor: (f: { name: string }) => `/invite?name=${f.name}`, read }))
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect((read.mock.calls[0] as unknown[])[0]).toBe('/invite?name=invite.ics')
    expect(container.querySelector('[data-email-attached-invite] [data-email-invite]')).not.toBeNull()
    expect(text()).toContain('Planning call')
  })

  it('draws nothing when there is no calendar file, nowhere to read it, or no event in it', async () => {
    const read = vi.fn(async () => null)
    await act(async () => {
      root.render(h(EmailAttachedInvite, { attachments: [pdf], hrefFor: () => '/invite', read }))
    })
    expect(read).not.toHaveBeenCalled()
    await act(async () => {
      root.render(h(EmailAttachedInvite, { attachments: [ics], hrefFor: () => null, read }))
    })
    expect(read).not.toHaveBeenCalled()
    await act(async () => {
      root.render(h(EmailAttachedInvite, { attachments: [ics], hrefFor: () => '/invite', read }))
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-email-invite]')).toBeNull()
  })
})

describe('inviteWhen', () => {
  it('says a same-day time range with the period once', () => {
    expect(inviteWhen({ start: new Date(2026, 10, 26, 14, 0).toISOString(), end: new Date(2026, 10, 26, 14, 45).toISOString(), allDay: false })).toBe('Thu, Nov 26, 2026 · 2:00 – 2:45 PM')
    expect(inviteWhen({ start: new Date(2026, 10, 26, 11, 0).toISOString(), end: new Date(2026, 10, 26, 13, 0).toISOString(), allDay: false })).toBe('Thu, Nov 26, 2026 · 11:00 AM – 1:00 PM')
  })

  it('says an all-day event by its days, not shifted by the time zone', () => {
    expect(inviteWhen({ start: '2026-12-01', end: null, allDay: true })).toBe('Tue, Dec 1, 2026 · All day')
    expect(inviteWhen({ start: '2026-12-01', end: '2026-12-03', allDay: true })).toBe('Tue, Dec 1 – Thu, Dec 3, 2026 · All day')
  })
})

describe('EmailAttachments', () => {
  const files = [
    { name: 'invite.ics', size: 1843, mimeType: 'text/calendar' },
    { name: 'Lease-2027-signed.pdf', size: 482113, mimeType: 'application/pdf' },
  ]

  it('draws a chip per file with its name and size, and a download button when there is a link', () => {
    act(() => root.render(h(EmailAttachments, { attachments: files, hrefFor: (f: { name: string }) => `/download/${f.name}` })))
    const chips = [...container.querySelectorAll('[data-email-attachment]')]
    expect(chips.map((c) => c.textContent)).toEqual(['invite.ics1.8 KB', 'Lease-2027-signed.pdf470.8 KB'])
    const links = [...container.querySelectorAll<HTMLAnchorElement>('[data-email-attachment-link]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/download/invite.ics', '/download/Lease-2027-signed.pdf'])
    expect(links[0].getAttribute('download')).toBe('invite.ics')
    expect(links[0].getAttribute('aria-label')).toBe('Download invite.ics')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('lists files with no download button when there is nowhere to download from', () => {
    act(() => root.render(h(EmailAttachments, { attachments: files })))
    expect(container.querySelectorAll('[data-email-attachment]').length).toBe(2)
    expect(container.querySelector('[data-email-attachment-link]')).toBeNull()
  })

  it('knows the kind of a file by type, or by name when the type says nothing', () => {
    expect(attachmentKind({ name: 'invite.ics', mimeType: 'application/octet-stream' }).label).toBe('Calendar file')
    expect(attachmentKind({ name: 'a.bin', mimeType: 'application/pdf' }).label).toBe('PDF')
    expect(attachmentKind({ name: 'costs.xlsx', mimeType: 'application/octet-stream' }).label).toBe('Spreadsheet')
    expect(attachmentKind({ name: 'photo.JPG', mimeType: '' }).label).toBe('Image')
    expect(attachmentKind({ name: 'thing', mimeType: 'application/octet-stream' }).label).toBe('File')
    expect(formatFileSize(0)).toBe('')
    expect(formatFileSize(1250331)).toBe('1.2 MB')
  })
})
