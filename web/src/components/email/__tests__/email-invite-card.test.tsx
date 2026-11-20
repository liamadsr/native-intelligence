// @vitest-environment jsdom
/**
 * The invitation card and the attachment chips. People and addresses are made up.
 *
 * The card shows what the invitation says, marks the organizer, opens the full
 * guest list on "View all guest info", and says whose answer it is. Answering
 * is not connected to a provider yet: with the event on the person's calendar
 * the buttons open it there; without, they are disabled and the card says why.
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

import { EmailInviteCard, inviteWhen } from '../email-invite-card'
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderCard(invite: CalendarInvite, found: { response: 'accepted' | 'declined' | 'tentative' | 'pending' | null; link: string | null } | null) {
  await act(async () => {
    root.render(h(EmailInviteCard, { invite, ownAddresses: new Set(['sam@example.com']), lookup: async () => found }))
  })
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
    await renderCard(INVITE, { response: 'tentative', link: 'https://calendar.example.com/event/7781' })
    expect(text()).toContain('Reply for sam@example.com')
    const pressed = [...container.querySelectorAll('[data-invite-answer]')].filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((b) => b.getAttribute('data-invite-answer'))).toEqual(['tentative'])
  })

  it('opens the event in the calendar to answer, and says replying from here is not connected', async () => {
    await renderCard(INVITE, { response: 'pending', link: 'https://calendar.example.com/event/7781' })
    act(() => button('Yes').click())
    act(() => button('More options').click())
    expect(opened.urls).toEqual(['https://calendar.example.com/event/7781', 'https://calendar.example.com/event/7781'])
    expect(container.querySelector('[data-invite-note]')!.textContent).toContain('not connected yet')
  })

  it('disables the answers when the event is on no connected calendar, and says why', async () => {
    await renderCard(INVITE, null)
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-invite-answer], [data-invite-more]')) expect(b.disabled).toBe(true)
    expect(container.querySelector('[data-invite-note]')!.textContent).toContain('not on a connected calendar')
    act(() => button('Yes').click())
    expect(opened.urls).toEqual([])
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
