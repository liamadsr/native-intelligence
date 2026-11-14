// @vitest-environment jsdom
/**
 * The new-email composer's Send later, beside Send: a preset picked schedules
 * the message from the picked mailbox (POST /api/account/email/scheduled with
 * its time), the composer closes, and the toast says when, with Undo. With no
 * connected mailbox there is nothing to schedule from. Made-up people.
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

let container: HTMLDivElement
let root: Root | null = null
let posts: Array<{ url: string; body: Record<string, unknown> }>
let accounts: unknown[]

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

beforeEach(async () => {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(h(CreateDialog))
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const dialog = () => document.body.querySelector('[role="dialog"]')
const sendLater = () => document.body.querySelector<HTMLButtonElement>('[data-send-later]')

async function openCompose(subject: string) {
  await act(async () => void document.dispatchEvent(new Event('open-create-email')))
  await flush()
  await flush()
  const subj = document.body.querySelector<HTMLInputElement>('input[placeholder="Subject"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(subj, subject)
    subj.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CreateDialog — Send later', () => {
  it('schedules from the picked mailbox, closes the composer, and toasts when with Undo', async () => {
    await openCompose('Q4 renewal')
    expect(sendLater()!.disabled).toBe(false)
    await act(async () => sendLater()!.click())
    await flush()
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-send-later-preset="tomorrow"]')!.click())
    await flush()
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
    await openCompose('Q4 renewal')
    expect(sendLater()!.disabled).toBe(true)
  })
})
