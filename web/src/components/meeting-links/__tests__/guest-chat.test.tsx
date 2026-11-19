// @vitest-environment jsdom
/**
 * A meeting guest's chat in the call (../guest-chat.tsx): the list as plain
 * words, their own as "You", another guest marked; Enter sends, Shift+Enter
 * does not; a send that fails says so and keeps the words; the chat is asked
 * every few seconds while the tab is on screen and never while it is hidden;
 * the side panel's two tabs (arrow keys move between them, a dot on Chat for
 * what is new), Chat alone when the notes are off; what is new counts only
 * others' messages, and nothing while the chat is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GuestChatView, GuestSidePanel, useChatUnread, useGuestChat, type GuestChat, type GuestPanelTab } from '../guest-chat'
import type { GuestChatMessage } from '@/lib/meeting-links/guest-chat'

let host: HTMLDivElement
let root: Root
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let visibility: DocumentVisibilityState = 'visible'
beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const msg = (over: Partial<GuestChatMessage>): GuestChatMessage => ({ id: 'm1', at: '2026-11-19T10:00:00Z', author: 'member', name: 'Rosa Lind', mine: false, text: 'Welcome', note: null, ...over })
const MESSAGES = [
  msg({ id: 'm1', text: 'Welcome, see https://example.test/brief' }),
  msg({ id: 'm2', at: '2026-11-19T10:00:05Z', author: 'agent', name: 'Joseph', text: 'Here are the notes' }),
  msg({ id: 'm3', at: '2026-11-19T10:00:09Z', author: 'guest', name: 'Lee Park', text: 'Hi all' }),
  msg({ id: 'm4', at: '2026-11-19T10:00:10Z', author: 'guest', name: 'Sam Ruiz', mine: true, text: 'Hello' }),
  msg({ id: 'm5', at: '2026-11-19T10:00:11Z', text: '', note: 'Sent a file' }),
]

function view(over: Partial<GuestChat> = {}) {
  const chat: GuestChat = { messages: MESSAGES, state: 'ready', draft: '', setDraft: () => undefined, sending: false, sendError: null, send: async () => true, ...over }
  act(() => root.render(h(GuestChatView, { chat })))
  return chat
}
const q = (sel: string) => host.querySelector(sel)
const textarea = () => q('[data-guest-chat-input]') as HTMLTextAreaElement
const press = (key: string, shiftKey = false) =>
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })

describe('the chat as drawn', () => {
  it('names each message’s writer, their own as You, another guest and the agent marked; a file is a plain line; links open apart', () => {
    view()
    const rows = [...host.querySelectorAll('[data-guest-chat-message]')]
    expect(rows.map((r) => r.querySelector('span')!.textContent)).toEqual(['Rosa Lind', 'Joseph', 'Lee Park', 'You', 'Rosa Lind'])
    expect(rows[1].textContent).toContain('Agent')
    expect(rows[2].textContent).toContain('Guest')
    expect(rows[3].getAttribute('data-mine')).toBe('true')
    expect(rows[3].textContent).not.toContain('Guest')
    expect(rows[4].textContent).toContain('Sent a file')
    const link = rows[0].querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.test/brief')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(q('[role="log"]')!.getAttribute('aria-label')).toBe('Chat messages')
    expect(q('label[for="guest-chat-text"]')!.textContent).toBe('Message everyone in the meeting')
  })

  it('nothing yet, loading, failed: one plain line each', () => {
    view({ messages: [], state: 'ready' })
    expect(q('[data-guest-chat-list]')!.textContent).toContain('No messages yet')
    view({ messages: [], state: 'loading' })
    expect(q('[data-guest-chat-list]')!.textContent).toContain('Loading')
    view({ messages: [], state: 'failed' })
    expect(q('[data-guest-chat-list]')!.textContent).toContain('Couldn’t load the chat')
  })

  it('Enter sends, Shift+Enter is a new line, an empty box sends nothing, 2000 characters at most', () => {
    const send = vi.fn(async () => true)
    view({ draft: 'Can you hear me?', send })
    press('Enter', true)
    expect(send).not.toHaveBeenCalled()
    press('Enter')
    expect(send).toHaveBeenCalledTimes(1)
    expect(textarea().maxLength).toBe(2000)
    view({ draft: '   ', send })
    expect((q('[data-guest-chat-send]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed send says so, out loud; once they are out of the call the box says so and is off', () => {
    view({ draft: 'Still here?', sendError: 'Couldn’t send. Your message is still here: try again.' })
    expect(q('[data-guest-chat-error]')!.getAttribute('role')).toBe('alert')
    expect(textarea().value).toBe('Still here?')
    view({ state: 'refused' })
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toContain('no longer in the call')
  })
})

describe('useGuestChat', () => {
  let probe: GuestChat
  function Harness({ active }: { active: boolean }) {
    probe = useGuestChat('/m/tok', active)
    return h(GuestChatView, { chat: probe })
  }
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve())
  }

  it('asked at once and every 4 seconds while on screen; not at all while hidden, and at once when back', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [MESSAGES[0]] })))
    vi.stubGlobal('fetch', fetchMock)
    act(() => root.render(h(Harness, { active: true })))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(probe.messages.map((m) => m.id)).toEqual(['m1'])
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    visibility = 'hidden'
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('not connected: nothing is asked', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    act(() => root.render(h(Harness, { active: false })))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a send that fails keeps the words and says why; one that works shows at once and empties the box', async () => {
    let fail = true
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify({ messages: [] }))
      if (fail) return new Response(JSON.stringify({ error: 'no' }), { status: 500 })
      return new Response(JSON.stringify({ message: msg({ id: 'new', author: 'guest', name: 'Sam Ruiz', mine: true, text: 'Hello there' }) }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    act(() => root.render(h(Harness, { active: true })))
    await flush()
    act(() => probe.setDraft('Hello there'))
    await act(async () => void (await probe.send()))
    expect(probe.draft).toBe('Hello there')
    expect(q('[data-guest-chat-error]')!.textContent).toContain('still here')
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(sent[1]!.body))).toEqual({ text: 'Hello there' })
    fail = false
    await act(async () => void (await probe.send()))
    expect(probe.draft).toBe('')
    expect(probe.sendError).toBeNull()
    expect(probe.messages.map((m) => m.id)).toContain('new')
  })

  it('no longer in the call (403): refused, and asked no more', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_IN_CALL' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    act(() => root.render(h(Harness, { active: true })))
    await flush()
    expect(probe.state).toBe('refused')
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the side panel', () => {
  function Panel({ tabs, unread = 0, onClose = () => undefined }: { tabs: GuestPanelTab[]; unread?: number; onClose?: () => void }) {
    const [tab, setTab] = useState<GuestPanelTab>(tabs[0])
    return h(GuestSidePanel, { tab, tabs, onTab: setTab, onClose, unread, children: h('p', { 'data-body': tab }, tab) })
  }

  it('two tabs while the notes are shown: one selected, arrow keys move, a dot on Chat for what is new, Close closes', () => {
    const onClose = vi.fn()
    act(() => root.render(h(Panel, { tabs: ['notes', 'chat'], unread: 2, onClose })))
    const tabs = [...host.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Notes', 'true'],
      ['Chat2 new messages', 'false'],
    ])
    expect(q('[data-guest-chat-tab-dot]')).not.toBeNull()
    expect(q('[role="tabpanel"]')!.getAttribute('aria-labelledby')).toBe('guest-panel-tab-notes')
    act(() => {
      q('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(q('[data-body]')!.textContent).toBe('chat')
    expect(document.activeElement?.getAttribute('data-guest-panel-tab')).toBe('chat')
    expect(q('[data-guest-chat-tab-dot]')).toBeNull()
    act(() => (q('[data-guest-panel-close]') as HTMLButtonElement).click())
    expect(onClose).toHaveBeenCalled()
  })

  it('the notes off: Chat alone, as a heading', () => {
    act(() => root.render(h(Panel, { tabs: ['chat'] })))
    expect(q('[role="tablist"]')).toBeNull()
    expect(q('h2')!.textContent).toBe('Chat')
  })
})

describe('useChatUnread', () => {
  let count = -1
  function Probe({ messages, onScreen }: { messages: GuestChatMessage[]; onScreen: boolean }) {
    count = useChatUnread(messages, onScreen)
    return null
  }

  it('counts others’ messages since the chat was last on screen, never their own, nothing while it is', () => {
    act(() => root.render(h(Probe, { messages: MESSAGES.slice(0, 2), onScreen: false })))
    expect(count).toBe(2)
    act(() => root.render(h(Probe, { messages: MESSAGES.slice(0, 2), onScreen: true })))
    expect(count).toBe(0)
    act(() => root.render(h(Probe, { messages: MESSAGES.slice(0, 2), onScreen: false })))
    expect(count).toBe(0)
    // Their own does not count; another guest's does.
    act(() => root.render(h(Probe, { messages: [...MESSAGES.slice(0, 2), MESSAGES[3]], onScreen: false })))
    expect(count).toBe(0)
    act(() => root.render(h(Probe, { messages: MESSAGES.slice(0, 4), onScreen: false })))
    expect(count).toBe(1)
  })
})
