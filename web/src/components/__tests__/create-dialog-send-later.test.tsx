// @vitest-environment jsdom
/**
 * The new-email composer's Send later, beside Send: a preset picked schedules
 * the message from the picked mailbox (POST /api/account/email/scheduled with
 * its time), the composer closes, and the toast says when, with Undo. With no
 * connected mailbox there is nothing to schedule from. Made-up people.
 *
 * The composer puts focus in its title 100 ms after it opens (create-dialog's
 * "Focus title on open"). A popover open at that moment loses focus to the
 * title, and Radix closes a popover whose focus moves outside it. A person
 * never reaches Send later that fast, but a test can: its click landed ~105 ms
 * after the open, on either side of the timer, so the case passed or failed
 * by how quick the run was (in any zone, at any hour). Each case therefore
 * lets that timer run first and checks the title has focus. The clock is fake
 * (it still moves with real time, for the fetches and React) and pinned, and
 * the case also runs at fixed instants in several zones, which is where a
 * preset's day or hour would go wrong.
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
// The To field fills itself with one made-up address (the others stay empty).
vi.mock('@/components/email/email-recipient-input', () => ({
  EmailRecipientInput: ({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) => {
    useEffect(() => {
      if (placeholder?.startsWith('Type email') && values.length === 0) onChange(['dana@harborline.example'])
    }, [values, onChange, placeholder])
    return null
  },
}))
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
  posts = []
  accounts = [{ id: 'acct-work', account_email: 'me@fernhill.example', provider: 'google', capability: 'email', is_enabled: true, is_primary: true }]
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/oauth/status') return new Response(JSON.stringify({ accounts }))
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
const subject = () => document.body.querySelector<HTMLInputElement>('input[placeholder="Subject"]')
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
  // The composer's focus-on-open timer (100 ms) has run, as it has long before
  // any person reaches Send later: the title has focus.
  await act(async () => void (await vi.advanceTimersByTimeAsync(150)))
  expect(document.activeElement).toBe(subj)
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

describe('CreateDialog — Send later', () => {
  it('schedules from the picked mailbox, closes the composer, and toasts when with Undo', async () => {
    mount()
    await scheduleTomorrow()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({ account_id: 'acct-work', to: ['dana@harborline.example'], subject: 'Q4 renewal' })
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
