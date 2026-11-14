// @vitest-environment jsdom
/**
 * Send later beside Send: the button's choices (presets in the browser's
 * time, a picked time only in the future), the thread view's draft editor
 * handing its edits and the time on, and the Scheduled folder's rows (Send
 * now, Cancel, a failure's reason with Dismiss). Real components; fetch
 * stubbed. Made-up people and companies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import { SendLaterButton } from '../send-later-button'
import { DraftEditor } from '../draft-editor'
import { ScheduledList, filterScheduled } from '../scheduled-list'

const FRIDAY = new Date(2026, 10, 13, 10, 0)

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
const inDoc = <T extends Element>(sel: string) => document.body.querySelector<T>(sel)
const buttonNamed = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name) ?? null
const setInput = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function openButton(onSchedule: (at: Date) => unknown) {
  await act(async () => root.render(h(SendLaterButton, { onSchedule: onSchedule as never, now: () => FRIDAY })))
  await act(async () => inDoc<HTMLButtonElement>('[data-send-later]')!.click())
  await flush()
}

describe('SendLaterButton', () => {
  it('offers tomorrow and Monday at 8:00 AM, and picking one schedules it', async () => {
    const onSchedule = vi.fn()
    await openButton(onSchedule)
    expect([...document.body.querySelectorAll('[data-send-later-preset]')].map((b) => b.textContent)).toEqual(['Tomorrow, 8:00 AM', 'Monday, 8:00 AM'])
    await act(async () => inDoc<HTMLButtonElement>('[data-send-later-preset="monday"]')!.click())
    expect(onSchedule).toHaveBeenCalledWith(new Date(2026, 10, 16, 8, 0))
  })

  it('a picked date and time: only a future one can be scheduled', async () => {
    const onSchedule = vi.fn()
    await openButton(onSchedule)
    await act(async () => inDoc<HTMLButtonElement>('[data-send-later-pick]')!.click())
    const input = inDoc<HTMLInputElement>('input[type="datetime-local"]')!
    expect(input.min).toBe('2026-11-13T10:01')
    setInput(input, '2026-11-12T09:00')
    expect(buttonNamed('Schedule')!.disabled).toBe(true)
    expect(document.body.textContent).toContain('Pick a time in the future')
    setInput(input, '2026-11-20T14:30')
    expect(buttonNamed('Schedule')!.disabled).toBe(false)
    await act(async () => buttonNamed('Schedule')!.click())
    expect(onSchedule).toHaveBeenCalledWith(new Date(2026, 10, 20, 14, 30))
  })
})

describe('DraftEditor — Send later', () => {
  it('hands the edits and the time on; without the prop there is no Send later', async () => {
    const onSendLater = vi.fn()
    const initial = { to: ['dana@harborline.example'], cc: [], subject: 'Re: Q4', body: 'Tuesday works.' }
    await act(async () => root.render(h(DraftEditor, { initial, sending: false, onSend: vi.fn(), onSendLater, onCancel: vi.fn() })))
    await act(async () => inDoc<HTMLButtonElement>('[data-send-later]')!.click())
    await flush()
    await act(async () => inDoc<HTMLButtonElement>('[data-send-later-preset="tomorrow"]')!.click())
    expect(onSendLater).toHaveBeenCalledTimes(1)
    expect(onSendLater.mock.calls[0][0]).toEqual(initial)
    expect(onSendLater.mock.calls[0][1]).toBeInstanceOf(Date)
    await act(async () => root.render(h(DraftEditor, { initial, sending: false, onSend: vi.fn(), onCancel: vi.fn() })))
    expect(inDoc('[data-send-later]')).toBeNull()
  })
})

describe('ScheduledList', () => {
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString()
  let requests: Array<{ url: string; method: string }>
  let rows: unknown[]
  beforeEach(() => {
    requests = []
    rows = [
      { id: 's-1', account_id: 'a', provider: 'google', thread_id: null, to_emails: ['dana@harborline.example'], subject: 'Q4 renewal', send_at: future, status: 'scheduled', error: null, sent_at: null, created_at: future },
      { id: 's-2', account_id: 'a', provider: 'google', thread_id: null, to_emails: ['lee@harborline.example'], subject: 'Invoice', send_at: future, status: 'failed', error: 'The draft was no longer in your mailbox: it was sent or deleted.', sent_at: null, created_at: future },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, method: init?.method ?? 'GET' })
        if (url === '/api/account/email/scheduled') return new Response(JSON.stringify({ scheduled: rows }))
        return new Response(JSON.stringify({ ok: true, outcome: 'sent' }))
      }),
    )
  })

  async function renderList() {
    await act(async () => root.render(h(ScheduledList, {})))
    await flush()
    await flush()
  }
  const row = (id: string) => container.querySelector(`[data-scheduled-row="${id}"]`)!
  const inRow = (id: string, name: string) => [...row(id).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name) ?? null

  it('lists recipients, subject and when; a failed one shows why, with Dismiss only', async () => {
    await renderList()
    expect(row('s-1').textContent).toContain('dana@harborline.example')
    expect(row('s-1').textContent).toContain('Q4 renewal')
    expect(inRow('s-1', 'Send now')).not.toBeNull()
    expect(inRow('s-1', 'Cancel')).not.toBeNull()
    expect(row('s-2').querySelector('[data-scheduled-error]')!.textContent).toBe('The draft was no longer in your mailbox: it was sent or deleted.')
    expect(inRow('s-2', 'Send now')).toBeNull()
    expect(inRow('s-2', 'Dismiss')).not.toBeNull()
  })

  it('Send now, Cancel (a draft kept, Drafts synced) and Dismiss each call their route, then read again', async () => {
    await renderList()
    await act(async () => inRow('s-1', 'Send now')!.click())
    await flush()
    await act(async () => inRow('s-1', 'Cancel')!.click())
    await flush()
    await act(async () => inRow('s-2', 'Dismiss')!.click())
    await flush()
    const changes = requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`)
    expect(changes).toEqual([
      'POST /api/account/email/scheduled/s-1/send-now',
      'POST /api/account/email/scheduled/s-1/cancel',
      'POST /api/account/email/sync',
      'DELETE /api/account/email/scheduled/s-2',
    ])
    expect(toasts.success).toHaveBeenCalledWith('Email sent')
    expect(toasts.success).toHaveBeenCalledWith('Kept as a draft')
    expect(requests.filter((r) => r.url === '/api/account/email/scheduled').length).toBeGreaterThanOrEqual(4)
  })

  it('nothing scheduled says so', async () => {
    rows = []
    await renderList()
    expect(container.textContent).toContain('Nothing scheduled')
  })

  it('Mail’s search filters it by recipient and subject', async () => {
    await act(async () => root.render(h(ScheduledList, { search: 'invoice' })))
    await flush()
    await flush()
    expect([...container.querySelectorAll('[data-scheduled-row]')].map((r) => r.getAttribute('data-scheduled-row'))).toEqual(['s-2'])
    expect(filterScheduled(rows as never, 'DANA harborline').map((r) => r.id)).toEqual(['s-1'])
    expect(filterScheduled(rows as never, '').map((r) => r.id)).toEqual(['s-1', 's-2'])
    await act(async () => root.render(h(ScheduledList, { search: 'nothing-like-this' })))
    expect(container.textContent).toContain('No scheduled email matches')
  })

  it('reads again when the window gets focus back', async () => {
    await renderList()
    const before = requests.filter((r) => r.url === '/api/account/email/scheduled').length
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await flush()
    expect(requests.filter((r) => r.url === '/api/account/email/scheduled').length).toBe(before + 1)
  })

  it('reads again just after the soonest send time passes (one timer, no polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      rows = [{ ...(rows[0] as object), send_at: new Date(Date.now() + 60_000).toISOString() }]
      await renderList()
      const before = requests.filter((r) => r.url === '/api/account/email/scheduled').length
      await act(async () => void vi.advanceTimersByTime(30_000))
      expect(requests.filter((r) => r.url === '/api/account/email/scheduled').length).toBe(before)
      await act(async () => void vi.advanceTimersByTime(60_000))
      await flush()
      expect(requests.filter((r) => r.url === '/api/account/email/scheduled').length).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})
