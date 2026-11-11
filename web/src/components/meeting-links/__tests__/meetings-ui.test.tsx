// @vitest-environment jsdom
/**
 * The meetings people can find, on the page:
 *   - team chat's meetings section (../meetings-section.tsx): nothing when
 *     there are none; a just-made unused link, a scheduled one and a live one,
 *     live first, each with Join (its same-origin POST) and its when-line;
 *     the title opens its conversation;
 *   - the new-meeting dialog (../new-meeting-dialog.tsx): one writable
 *     calendar, no picker (it's used); several, a picker, the chosen one sent
 *     and remembered for next time; none, no picker; made, Join now next to
 *     Copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))

import { MeetingsSection } from '../meetings-section'
import { NewMeetingDialog } from '../new-meeting-dialog'
import { MEETING_CALENDAR_KEY } from '@/lib/meeting-links/calendar-pick'
import type { MyMeeting } from '@/lib/meeting-links/section'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-11T15:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const URL_OF = (n: number) => `https://app.example/m/${String(n).repeat(32).slice(0, 32)}`

const meeting = (id: string, over: Partial<MyMeeting> = {}): MyMeeting => ({
  id,
  channel_id: `ch-${id}`,
  title: id,
  starts_at: null,
  ends_at: null,
  opens_at: iso(NOW - H),
  closes_at: iso(NOW + 30 * 24 * H),
  revoked_at: null,
  created_at: iso(NOW - 60_000),
  host_member_id: 'me',
  is_host: true,
  live: false,
  url: URL_OF(1),
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  localStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

describe('the meetings section', () => {
  it('nothing at all when there are no meetings', () => {
    act(() => root.render(h(MeetingsSection, { refreshKey: 0, liveChannels: new Set<string>(), unread: () => 0, activeChannelId: null, onOpen: () => {}, initial: [], now: NOW })))
    expect(el.innerHTML).toBe('')
  })

  it('a just-made unused link, a scheduled one and a live one: live first; Join is the link’s own POST; the title opens it', () => {
    const onOpen = vi.fn()
    const items = [
      meeting('Just made'),
      meeting('Design review', { starts_at: iso(NOW + 24 * H), ends_at: iso(NOW + 25 * H), url: URL_OF(2) }),
      meeting('Standup', { url: URL_OF(3) }),
    ]
    act(() => root.render(h(MeetingsSection, { refreshKey: 0, liveChannels: new Set(['ch-Standup']), unread: () => 0, activeChannelId: null, onOpen, initial: items, now: NOW })))
    const rows = [...el.querySelectorAll('[data-meeting-row]')]
    expect(rows.map((r) => r.getAttribute('data-meeting-row'))).toEqual(['live', 'upcoming', 'anytime'])
    expect(rows.map((r) => r.querySelector('[data-meeting-when]')?.textContent)).toEqual(['Live now', expect.stringMatching(/^Tomorrow /), 'Any time'])
    const forms = [...el.querySelectorAll('form')]
    expect(forms.map((f) => [f.getAttribute('method'), f.getAttribute('action')])).toEqual([
      ['post', `${new URL(URL_OF(3)).pathname}/enter`],
      ['post', `${new URL(URL_OF(2)).pathname}/enter`],
      ['post', `${new URL(URL_OF(1)).pathname}/enter`],
    ])
    act(() => (rows[2].querySelector('[data-meeting-open]') as HTMLButtonElement).click())
    expect(onOpen).toHaveBeenCalledWith('ch-Just made')
  })
})

describe('the new-meeting dialog', () => {
  const two = [
    { id: 'acct-google', provider: 'google' as const, label: 'ana@example.com' },
    { id: 'acct-outlook', provider: 'microsoft' as const, label: 'ana@work.example' },
  ]
  function mockCreate() {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ meeting: { meetingId: 'm-1', channelId: 'ch-1', url: URL_OF(4), title: 'Design review', opensAt: 'a', closesAt: 'b' } }), { status: 200 })
      }),
    )
    return bodies
  }
  const type = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  async function schedule(calendars: typeof two) {
    const onCreated = vi.fn()
    act(() => root.render(h(NewMeetingDialog, { open: true, onOpenChange: () => {}, onCreated, initialCalendars: calendars })))
    const dialog = document.body
    type(dialog.querySelector('input[placeholder="e.g. Design review"]') as HTMLInputElement, 'Design review')
    act(() => (dialog.querySelector('[data-new-meeting-schedule]') as HTMLInputElement).click())
    type(dialog.querySelector('input[type="datetime-local"]') as HTMLInputElement, '2026-11-12T10:00')
    return { dialog, onCreated }
  }

  it('one writable calendar: no picker, and it is used', async () => {
    const bodies = mockCreate()
    const { dialog } = await schedule([two[0]])
    expect(dialog.querySelector('[data-new-meeting-calendar]')).toBeNull()
    expect(dialog.querySelector('[data-new-meeting-calendar-one]')?.textContent).toContain('ana@example.com')
    await act(async () => (dialog.querySelector('[data-new-meeting-create]') as HTMLButtonElement).click())
    expect(bodies[0]).toMatchObject({ title: 'Design review', calendarAccountId: 'acct-google' })
  })

  it('several: a picker, the chosen one sent and remembered for next time; made, Join now next to Copy', async () => {
    const bodies = mockCreate()
    const { dialog, onCreated } = await schedule(two)
    const picker = dialog.querySelector('[data-new-meeting-calendar]') as HTMLSelectElement
    expect([...picker.options].map((o) => o.textContent)).toEqual(['ana@example.com · Google Calendar', 'ana@work.example · Outlook'])
    act(() => type(picker, 'acct-outlook'))
    await act(async () => (dialog.querySelector('[data-new-meeting-create]') as HTMLButtonElement).click())
    expect(bodies[0]).toMatchObject({ calendarAccountId: 'acct-outlook' })
    expect(localStorage.getItem(MEETING_CALENDAR_KEY)).toBe('acct-outlook')
    expect(onCreated).toHaveBeenCalled()
    const join = dialog.querySelector('[data-new-meeting-join]')!
    expect(join.closest('form')?.getAttribute('action')).toBe(`${new URL(URL_OF(4)).pathname}/enter`)
    expect(dialog.querySelector('[data-new-meeting-copy]')).not.toBeNull()
  })

  it('the remembered choice is preselected next time', async () => {
    localStorage.setItem(MEETING_CALENDAR_KEY, 'acct-outlook')
    mockCreate()
    const { dialog } = await schedule(two)
    expect((dialog.querySelector('[data-new-meeting-calendar]') as HTMLSelectElement).value).toBe('acct-outlook')
  })

  it('no calendar connected: no picker, nothing sent (the app’s calendar shows it)', async () => {
    const bodies = mockCreate()
    const { dialog } = await schedule([])
    expect(dialog.querySelector('[data-new-meeting-calendar]')).toBeNull()
    await act(async () => (dialog.querySelector('[data-new-meeting-create]') as HTMLButtonElement).click())
    expect(bodies[0].calendarAccountId ?? null).toBeNull()
  })
})
