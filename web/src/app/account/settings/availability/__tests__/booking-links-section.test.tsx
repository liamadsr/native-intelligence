// @vitest-environment jsdom
/**
 * Settings → Availability → Booking links (../booking-links-section.tsx):
 * the address, the links with their length, hosts and on/off, the empty
 * state; each change goes to its route: on/off, the address, a new link
 * from the dialog with only a title; Delete waits for its toast (Undo keeps
 * the link). Made-up people.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))

import { copyTextToClipboard } from '@/lib/clipboard'
import { BookingLinksSection, hostOf, typedHandle } from '../booking-links-section'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AVA = 'a0000000-0000-4000-8000-00000000000a'
const BEN = 'b0000000-0000-4000-8000-00000000000b'
const link = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://app.example/book/ava-lin/${id}`,
  profile: 'ava-lin',
  slug: id,
  purpose: 'meeting',
  title: id === 'intro' ? 'Intro call' : 'Team sync',
  description: null,
  duration_minutes: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  notice_minutes: 240,
  window_days: 30,
  questions: [],
  video: true,
  location: null,
  ask_first: false,
  host_mode: 'one',
  hosts: [AVA],
  owner_user_id: AVA,
  active: true,
  can_edit: true,
  ...extra,
})

let container: HTMLDivElement
let root: Root
let links: unknown[]
const fetchMock = vi.fn()

beforeEach(() => {
  links = [link('intro'), link('team', { hosts: [AVA, BEN], host_mode: 'all', duration_minutes: 60, ask_first: true })]
  toasts.success.mockReset()
  toasts.error.mockReset()
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
    const method = init?.method ?? 'GET'
    if (url === '/api/account/booking-links' && method === 'GET') return json({ links, handles: { me: 'ava-lin', workspace: null }, can_manage: true, user_id: AVA })
    if (url === '/api/account/workspace/members') return json({ members: [{ user_id: AVA, display_name: 'Ava Lin' }, { user_id: BEN, display_name: 'Ben Ruiz' }] })
    if (url === '/api/account/booking-links' && method === 'POST') return json({ link: link('new-one', { title: JSON.parse(String(init!.body)).title }) }, 201)
    if (url === '/api/account/booking-profile') return json({ handles: { me: JSON.parse(String(init!.body)).handle, workspace: null } })
    if (url.startsWith('/api/account/booking-links/') && method === 'PATCH') return json({ link: { ...link('intro'), ...JSON.parse(String(init!.body)) } })
    if (url.startsWith('/api/account/booking-links/') && method === 'DELETE') return json({ link: link('intro'), deleted: true })
    return json({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
const sent = (method: string) => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method).map((c) => [c[0], (c[1] as RequestInit).body ? JSON.parse(String((c[1] as RequestInit).body)) : null])
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
  await flush()
}
function type(el: Element | null, value: string) {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the helpers', () => {
  it('the site and a typed handle', () => {
    expect(hostOf('https://app.example/')).toBe('app.example')
    expect(typedHandle('Ava Lin!')).toBe('ava-lin')
  })
})

describe('BookingLinksSection', () => {
  it('the address and each link: its length, hosts, ask first, on', async () => {
    act(() => root.render(h(BookingLinksSection)))
    await flush()
    expect((container.querySelector('[data-booking-handle]') as HTMLInputElement).value).toBe('ava-lin')
    const rows = [...container.querySelectorAll('[data-testid="booking-link"]')].map((r) => r.textContent)
    expect(rows[0]).toContain('Intro call')
    expect(rows[0]).toContain('30 min · Ava Lin · app.example/book/ava-lin/intro')
    expect(rows[1]).toContain('Asks first')
    expect(rows[1]).toContain('1 hr · Ava Lin and Ben Ruiz')
    expect(container.querySelector('[aria-label="Intro call is on"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('no links: the empty state with New link', async () => {
    links = []
    act(() => root.render(h(BookingLinksSection)))
    await flush()
    expect(container.querySelector('[data-booking-links-empty]')?.textContent).toContain('No booking links yet')
  })

  it('on/off, copy and the address go to their routes', async () => {
    act(() => root.render(h(BookingLinksSection)))
    await flush()
    await click(container.querySelector('[aria-label="Intro call is on"]'))
    await click(container.querySelector('[aria-label="Copy the link to Intro call"]'))
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://app.example/book/ava-lin/intro')
    type(container.querySelector('[data-booking-handle]'), 'Ava Studio')
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Save'))
    expect(sent('PATCH')).toEqual([['/api/account/booking-links/intro', { active: false }]])
    expect(sent('PUT')).toEqual([['/api/account/booking-profile', { handle: 'ava-studio' }]])
  })

  it('a new link is a title and Create', async () => {
    act(() => root.render(h(BookingLinksSection)))
    await flush()
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'New link'))
    const dialog = document.querySelector('[data-booking-link-dialog]')!
    expect(dialog.textContent).toContain('app.example/book/ava-lin/')
    // Two members: the hosts list, Ava ticked; no sharing choice with one host.
    expect(dialog.querySelector('[aria-label="Ava Lin hosts"]')?.getAttribute('aria-checked')).toBe('true')
    expect(dialog.querySelector('[data-link-host-mode]')).toBeNull()
    type(dialog.querySelector('#link-title'), 'Office hours')
    expect((dialog.querySelector('#link-slug') as HTMLInputElement).value).toBe('office-hours')
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Create link'))
    const [[url, body]] = sent('POST')
    expect(url).toBe('/api/account/booking-links')
    expect(body).toMatchObject({ title: 'Office hours', slug: 'office-hours', duration_minutes: 30, hosts: [AVA], host_mode: 'one' })
    expect([...container.querySelectorAll('[data-testid="booking-link"]')][0].textContent).toContain('Office hours')
  })

  it('delete hides it at once and goes when the toast does; Undo keeps it', async () => {
    act(() => root.render(h(BookingLinksSection)))
    await flush()
    const remove = async (title: string) => {
      const more = container.querySelector(`[aria-label="More for ${title}"]`)!
      await act(async () => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      await flush()
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent === 'Delete')
      await click(item)
      return toasts.success.mock.calls.at(-1)![1] as { action: { onClick: () => void }; onAutoClose: () => void; onDismiss: () => void }
    }
    const undo = await remove('Team sync')
    expect(container.textContent).not.toContain('Team sync')
    act(() => undo.action.onClick())
    act(() => undo.onDismiss())
    await flush()
    expect(container.textContent).toContain('Team sync')
    expect(sent('DELETE')).toEqual([])
    const gone = await remove('Intro call')
    act(() => gone.onAutoClose())
    await flush()
    expect(sent('DELETE')).toEqual([['/api/account/booking-links/intro', null]])
    expect(container.textContent).not.toContain('Intro call')
  })
})
