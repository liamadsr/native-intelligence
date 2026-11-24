// @vitest-environment jsdom
/**
 * The inbox's filter (../inbox-view.tsx InboxFilterButton; Liam, 11-24: "the
 * same type of filter for the incoming view with the different notifications
 * we support with all being the default"): the same button and menu as
 * Recent's. In a card, in its header (Liam, 11-23: "Into the header"), the
 * page starting with the list; on its own, at the top right of the list.
 * F opens it from the list. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/app/account/(dashboard)/views/team-chat-view', () => ({ TeamChatView: () => null }))
vi.mock('@/components/email/email-layout', () => ({ EmailLayout: () => null }))

const { InboxView } = await import('../inbox-view')
const { __resetInboxStoreForTests, inboxState, INBOX_FILTER_KEY } = await import('../inbox-store')

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root
const realFetch = globalThis.fetch
const at = new Date().toISOString()
const note = (key: string, type: string, over: Record<string, unknown> = {}) => ({ key, source: 'notification', category: 'other', at, title: `Note ${key}`, body: null, unread: true, count: 1, notificationIds: [key], actor: null, open: { kind: 'none' }, type, ...over })
let data: unknown = { items: [], held: [], mail: [] }

beforeEach(() => {
  __resetInboxStoreForTests()
  window.localStorage.clear()
  data = { items: [], held: [], mail: [] }
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })) as typeof fetch
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((el) => el.remove())
  globalThis.fetch = realFetch
})

const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const press = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
    ;(el as HTMLElement).click()
  })
}

describe('the inbox’s filter', () => {
  it('in a card: one filter button in its header, nothing over the list; All by default', async () => {
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><InboxView /></CardHeaderSlotsProvider>))
    const button = right.querySelector<HTMLButtonElement>('[data-inbox-filter]')!
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Filter')
    expect(button.getAttribute('title')).toBe('Filter (F)')
    expect(container.querySelector('[data-inbox-filter]')).toBeNull()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(inboxState().filter).toEqual({ status: 'all', kinds: [] })
  })

  it('on its own (no card): the button over the list, at its right', async () => {
    await act(async () => root.render(<InboxView />))
    expect(container.querySelector('[data-inbox-filter]')).not.toBeNull()
    expect(right.childElementCount).toBe(0)
  })

  it('F opens it; a Type narrows the list to that kind, kept on this device; Held shows what is held; Reset brings it all back', async () => {
    data = { items: [note('m1', 'team_chat_message'), note('g1', 'github_review_requested'), note('c1', 'comment_added')], held: [note('h1', 'reminder', { heldUntil: at })], mail: [] }
    await act(async () => root.render(<InboxView />))
    await act(async () => {})
    const rows = () => Array.from(container.querySelectorAll('[data-inbox-row]')).map((r) => r.getAttribute('data-inbox-row'))
    expect(rows()).toEqual(['m1', 'g1', 'c1'])
    const list = container.querySelector<HTMLElement>('[data-inbox-list]')!
    const ev = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })
    await act(async () => void list.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    // Only the kinds the list has, each with how many; Held among the Status choices.
    expect(Array.from(document.body.querySelectorAll('[data-inbox-kind]')).map((k) => k.getAttribute('data-inbox-kind'))).toEqual(['messages', 'tasks', 'comments', 'reviews'])
    expect(Array.from(document.body.querySelectorAll('[data-inbox-status]')).map((k) => k.getAttribute('data-inbox-status'))).toEqual(['all', 'unread', 'read', 'held'])
    await press(document.body.querySelector('[data-inbox-kind="reviews"]')!)
    expect(rows()).toEqual(['g1'])
    expect(JSON.parse(window.localStorage.getItem(INBOX_FILTER_KEY)!)).toEqual({ status: 'all', kinds: ['reviews'] })
    expect(container.querySelector('[data-inbox-filter]')!.getAttribute('data-inbox-filter-on')).toBe('1')
    await press(document.body.querySelector('[data-inbox-status="held"]')!)
    await act(async () => {})
    expect(inboxState().filter.status).toBe('held')
  })

  it('a key on a header control is that control’s, not the list’s: Enter presses it, e and h never touch a row', async () => {
    data = { items: [note('n1', 'other')], held: [], mail: [] }
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><InboxView /></CardHeaderSlotsProvider>))
    await act(async () => {})
    expect(container.textContent).toContain('Note n1')
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    const before = calls()
    for (const key of ['e', 'h', 'j']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => void right.querySelector<HTMLButtonElement>('[data-inbox-filter]')!.dispatchEvent(ev))
      expect(ev.defaultPrevented).toBe(false)
    }
    // Enter is the button's own: it opens the filter's menu, and opens no row.
    await act(async () => void right.querySelector<HTMLButtonElement>('[data-inbox-filter]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(menu()).not.toBeNull()
    expect(calls()).toBe(before)
  })
})
