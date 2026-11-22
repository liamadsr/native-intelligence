// @vitest-environment jsdom
/**
 * New email in the Create dialog is Mail's own composer (email-composer.tsx,
 * the one Reply and Forward use), From the mailbox the dialog's picker names.
 * Its Send later, beside Send: a preset picked schedules the message from
 * that mailbox (POST /api/account/email/scheduled with its time), the dialog
 * closes, and the toast says when, with Undo. With no connected mailbox there
 * is nothing to schedule from. Send goes through the composer's Undo wait.
 *
 * The clock is fake (it still moves with real time, for the fetches and
 * React) and pinned, and the Send later case also runs at fixed instants in
 * several zones, which is where a preset's day or hour would go wrong.
 * Made-up people.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ fn: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: toasts.fn }))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [] }) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: vi.fn() }))
vi.mock('@/calendar/hooks/use-calendar-events', () => ({ patchCalendarEventsCache: vi.fn() }))
vi.mock('@/calendar/adapters', () => ({ calendarEventToIEvent: vi.fn() }))
// The composer's To (the first recipient field drawn) fills itself with one made-up address; Cc and Bcc stay empty.
const recipients = vi.hoisted(() => ({ claimed: false }))
vi.mock('@/components/email/email-recipient-input', async () => {
  const { useState } = await import('react')
  return {
    EmailRecipientInput: ({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) => {
      const [mine] = useState(() => {
        if (recipients.claimed) return false
        recipients.claimed = true
        return true
      })
      useEffect(() => {
        if (mine && values.length === 0) onChange(['dana@harborline.example'])
      }, [mine, values, onChange])
      return null
    },
  }
})
// The rich-text field is a textarea here (compose-editor has its own test).
vi.mock('@/components/email/compose-editor', async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import('react')
  return {
    safeLinkHref: (v: string) => v,
    sanitizeComposeHtml: (v: string) => v,
    ComposeEditor: forwardRef(function FakeEditor(props: { onChange?: (html: string) => void }, ref) {
      const el = useRef<HTMLTextAreaElement>(null)
      useImperativeHandle(ref, () => ({
        getHTML: () => (el.current?.value ? `<p>${el.current.value}</p>` : '<p></p>'),
        setHTML: () => {},
        focus: () => {},
        toggleBold: () => {},
        toggleItalic: () => {},
        toggleBulletList: () => {},
        toggleOrderedList: () => {},
        setLink: () => {},
        isActive: () => false,
        currentLink: () => '',
      }))
      return h('textarea', { ref: el, 'data-fake-editor': '', onChange: (e: { target: { value: string } }) => props.onChange?.(`<p>${e.target.value}</p>`) })
    }),
  }
})
vi.mock('@/components/ui/datetime-picker', () => ({ DateTimePicker: () => null }))

import { CreateDialog } from '../create-dialog'

/** The run that failed on main: a Friday evening in UTC, Saturday morning in Tokyo. */
const REPORTED = '2026-11-13T22:05:00Z'
const HOUR = 3_600_000

let container: HTMLDivElement
let root: Root | null = null
let posts: Array<{ url: string; body: Record<string, unknown> }>
let accounts: unknown[]

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

beforeEach(() => {
  recipients.claimed = false
  window.localStorage.clear()
  posts = []
  accounts = [{ id: 'acct-work', account_email: 'me@fernhill.example', provider: 'google', capability: 'email', is_enabled: true, is_primary: true }]
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/oauth/status') return new Response(JSON.stringify({ accounts }))
      if (url === '/api/account/email/send') {
        posts.push({ url, body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ message_id: 'sent-1', thread_id: 'thr-new' }))
      }
      if (url === '/api/account/email/scheduled') {
        const body = JSON.parse(String(init?.body))
        posts.push({ url, body })
        return new Response(JSON.stringify({ scheduled: { id: 'sched-1', send_at: body.send_at, status: 'scheduled' } }))
      }
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/**
 * Render the dialog at `at` (an instant), in `zone` when given (else the
 * runner's own). Timers are fake but move with real time; React's scheduler
 * (setImmediate) and microtasks stay real.
 */
function mount({ at = REPORTED, zone }: { at?: string; zone?: string } = {}) {
  if (zone) {
    vi.stubEnv('TZ', zone)
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
  }
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date(at))
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(h(CreateDialog))
  })
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const subject = () => document.body.querySelector<HTMLInputElement>('[data-email-composer="new"] input[aria-label="Subject"]')
const editor = () => document.body.querySelector<HTMLTextAreaElement>('[data-fake-editor]')
const sendLater = () => document.body.querySelector<HTMLButtonElement>('[data-send-later]')
const preset = (id: string) => document.body.querySelector<HTMLButtonElement>(`[data-send-later-preset="${id}"]`)

async function openCompose(text: string) {
  await act(async () => void document.dispatchEvent(new Event('open-create-email')))
  await flush()
  await flush()
  const subj = subject()!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(subj, text)
    subj.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const area = editor()!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Hi Dana, the renewal terms are below.')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The dialog's focus-on-open timer (100 ms) has run, as it has long before
  // any person reaches Send later.
  await act(async () => void (await vi.advanceTimersByTimeAsync(150)))
}

/** Open Send later and pick "Tomorrow, 8:00 AM". */
async function scheduleTomorrow() {
  await openCompose('Q4 renewal')
  expect(sendLater()!.disabled).toBe(false)
  await act(async () => sendLater()!.click())
  await flush()
  expect(sendLater()!.getAttribute('data-state')).toBe('open')
  await act(async () => preset('tomorrow')!.click())
  await flush()
}

describe('CreateDialog — New email is Mail’s composer', () => {
  it('opens the composer, From the picked mailbox; Send goes after the Undo wait, and the dialog closes at once', async () => {
    mount()
    await openCompose('Q4 renewal')
    expect(document.body.querySelector('[data-email-composer="new"]')).not.toBeNull()
    // The dialog's own Create footer is hidden for email: the composer has its own Send.
    const create = [...document.body.querySelectorAll('button')].find((b) => /^Create email$/.test(b.textContent ?? ''))
    expect(!create || !!create.closest('.hidden')).toBe(true)
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-compose-send]')!.click())
    expect(dialog()).toBeNull()
    expect(toasts.fn).toHaveBeenCalledWith('Sending…', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    expect(posts).toHaveLength(0)
    await act(async () => void (await vi.advanceTimersByTimeAsync(5100)))
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({ account_id: 'acct-work', to: ['dana@harborline.example'], subject: 'Q4 renewal' })
    expect(posts[0].body.thread_id).toBeUndefined()
    expect(String(posts[0].body.body_html)).toContain('the renewal terms are below.')
  })

  it('a new email needs a subject', async () => {
    mount()
    await openCompose('')
    expect(document.body.querySelector<HTMLButtonElement>('[data-compose-send]')!.disabled).toBe(true)
  })
})

describe('CreateDialog — Send later', () => {
  it('schedules from the picked mailbox, closes the composer, and toasts when with Undo', async () => {
    mount()
    await scheduleTomorrow()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({ account_id: 'acct-work', to: ['dana@harborline.example'], subject: 'Q4 renewal' })
    expect(posts[0].body.reply_thread_id).toBeUndefined()
    const at = new Date(String(posts[0].body.send_at))
    expect(at.getHours()).toBe(8)
    expect(at.getTime()).toBeGreaterThan(Date.now())
    expect(dialog()).toBeNull()
    expect(toasts.fn.success).toHaveBeenCalledWith(expect.stringMatching(/^Scheduled for /), expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
  })

  it('with no connected mailbox there is nothing to schedule from', async () => {
    accounts = []
    mount()
    await openCompose('Q4 renewal')
    expect(sendLater()!.disabled).toBe(true)
  })
})

describe('CreateDialog — Send later, at any time in any zone', () => {
  const instants = [
    REPORTED,
    // Sunday night in UTC: tomorrow is Monday there (and in New York); Monday morning in Tokyo.
    '2026-11-15T23:30:00Z',
    // 01:30 in New York on the night its clocks go back (the 01:00 hour repeats at 06:00 UTC).
    '2026-11-01T05:30:00Z',
    // 01:30 in New York on the night its clocks go forward (02:00 is skipped, at 07:00 UTC).
    '2026-03-08T06:30:00Z',
    // The year turns: still Dec 31 in UTC and to the west, already Jan 1 in Tokyo.
    '2026-12-31T23:59:00Z',
  ]
  // UTC, the zones of the report, and the two ends of the clock (UTC+14, UTC−11).
  const zones = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']
  const cases = instants.flatMap((at) => zones.map((zone) => ({ at, zone })))

  it.each(cases)('$at in $zone: Tomorrow, 8:00 AM is scheduled for 8:00 the next local day', async ({ at, zone }) => {
    mount({ at, zone })
    const now = new Date(at)
    await scheduleTomorrow()
    expect(posts).toHaveLength(1)
    const sendAt = new Date(String(posts[0].body.send_at))
    // 8:00 on the next calendar day where the person is.
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    expect([sendAt.getFullYear(), sendAt.getMonth(), sendAt.getDate()]).toEqual([next.getFullYear(), next.getMonth(), next.getDate()])
    expect([sendAt.getHours(), sendAt.getMinutes()]).toEqual([8, 0])
    // From just before midnight on a night the clocks go forward (7 h + a minute)
    // to just after midnight on a night they go back (33 h).
    expect(sendAt.getTime() - now.getTime()).toBeGreaterThan(7 * HOUR)
    expect(sendAt.getTime() - now.getTime()).toBeLessThanOrEqual(33 * HOUR)
    expect(dialog()).toBeNull()
    expect(toasts.fn.success).toHaveBeenCalledWith('Scheduled for Tomorrow, 8:00 AM', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
  })
})
