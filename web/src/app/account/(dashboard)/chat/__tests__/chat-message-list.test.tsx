// @vitest-environment jsdom
/**
 * Light windowing of the chat message list (2026-08-05 incident: the whole
 * session's conversation stayed mounted — DOM + fibers for every message).
 * Only the last CHAT_MESSAGE_WINDOW messages render by default; a "Show
 * earlier messages" expander mounts the rest on demand. This is a RENDER cap,
 * not data loss — the caller's array is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub the heavy per-message renderer — the window logic is what's under test.
vi.mock('../chat-message', () => ({
  ChatMessage: ({ message }: { message: { id: string } }) =>
    h('div', { 'data-msg-id': message.id }),
}))

import {
  ChatMessageList,
  windowChatMessages,
  CHAT_MESSAGE_WINDOW,
} from '../chat-message-list'

function msg(i: number): UIMessage {
  return {
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `t${i}` }],
  } as UIMessage
}

function msgs(n: number): UIMessage[] {
  return Array.from({ length: n }, (_, i) => msg(i))
}

describe('windowChatMessages (pure)', () => {
  it('a list AT the window renders fully with nothing hidden', () => {
    const list = msgs(CHAT_MESSAGE_WINDOW)
    const { visible, hiddenCount } = windowChatMessages(list, false)
    expect(visible).toBe(list) // untouched reference — no needless copy
    expect(hiddenCount).toBe(0)
  })

  it('one message over the window hides exactly one (the oldest)', () => {
    const list = msgs(CHAT_MESSAGE_WINDOW + 1)
    const { visible, hiddenCount } = windowChatMessages(list, false)
    expect(hiddenCount).toBe(1)
    expect(visible).toHaveLength(CHAT_MESSAGE_WINDOW)
    expect(visible[0].id).toBe('m1') // m0 hidden; tail preserved in order
    expect(visible[visible.length - 1].id).toBe(`m${CHAT_MESSAGE_WINDOW}`)
  })

  it('showAll renders everything regardless of length', () => {
    const list = msgs(CHAT_MESSAGE_WINDOW + 50)
    const { visible, hiddenCount } = windowChatMessages(list, true)
    expect(visible).toBe(list)
    expect(hiddenCount).toBe(0)
  })
})

describe('ChatMessageList — expander', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(messages: UIMessage[]) {
    act(() => {
      root.render(
        h(ChatMessageList, {
          messages,
          latestUserMessageId: null,
          userAvatarUrl: null,
          userInitials: 'LA',
        }),
      )
    })
  }

  const renderedIds = () =>
    Array.from(container.querySelectorAll('[data-msg-id]')).map((el) =>
      el.getAttribute('data-msg-id'),
    )
  const expander = () =>
    Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Show earlier messages'),
    )

  it('renders everything (no expander) at or under the window', () => {
    render(msgs(CHAT_MESSAGE_WINDOW))
    expect(renderedIds()).toHaveLength(CHAT_MESSAGE_WINDOW)
    expect(expander()).toBeUndefined()
  })

  it('renders only the window tail with a counting expander when over', () => {
    render(msgs(CHAT_MESSAGE_WINDOW + 50))
    expect(renderedIds()).toHaveLength(CHAT_MESSAGE_WINDOW)
    expect(renderedIds()[0]).toBe('m50') // the 50 oldest are hidden
    const btn = expander()
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toContain('(50)')
  })

  it('clicking the expander mounts every message and removes the button', () => {
    render(msgs(CHAT_MESSAGE_WINDOW + 50))
    const btn = expander()!
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(renderedIds()).toHaveLength(CHAT_MESSAGE_WINDOW + 50)
    expect(renderedIds()[0]).toBe('m0')
    expect(expander()).toBeUndefined()
  })

  it('stays expanded when a new message arrives after expanding', () => {
    const list = msgs(CHAT_MESSAGE_WINDOW + 10)
    render(list)
    act(() => {
      expander()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    render([...list, msg(CHAT_MESSAGE_WINDOW + 10)])
    expect(renderedIds()).toHaveLength(CHAT_MESSAGE_WINDOW + 11)
    expect(expander()).toBeUndefined()
  })
})

describe('ChatMessageList — day lines and times', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const timed = (id: string, iso: string, role: 'user' | 'assistant' = 'assistant', metadata: Record<string, unknown> = {}): UIMessage =>
    ({ id, role, parts: [{ type: 'text', text: id }], metadata: { ...metadata, createdAt: iso } }) as UIMessage

  function render(messages: UIMessage[], props: Record<string, unknown> = {}) {
    act(() => {
      root.render(h(ChatMessageList, { messages, latestUserMessageId: null, userAvatarUrl: null, userInitials: 'LA', ...props }))
    })
  }
  // The rows in order: a line's label, or a message's id.
  const drawn = () =>
    Array.from(container.querySelectorAll('[data-chat-day-line], [data-msg-id]')).map((el) =>
      el.hasAttribute('data-chat-day-line') ? `-- ${el.getAttribute('aria-label')}` : el.getAttribute('data-msg-id'),
    )

  it('draws a line before each new day, none across the seam with the day before', () => {
    // Noon UTC: the same calendar day in any zone the suite runs in.
    const list = [timed('a', '2026-10-16T12:00:00Z'), timed('b', '2026-10-16T12:30:00Z'), timed('c', '2026-10-17T12:00:00Z')]
    render(list)
    expect(drawn()).toEqual([expect.stringMatching(/^-- Friday, October 16/), 'a', 'b', expect.stringMatching(/^-- Saturday, October 17/), 'c'])
    render(list, { dayBefore: Date.parse('2026-10-16T08:00:00Z') })
    expect(drawn()).toEqual(['a', 'b', expect.stringMatching(/^-- Saturday, October 17/), 'c'])
  })

  it('a hidden opened page makes no line', () => {
    const opened = { id: 'o', role: 'user', parts: [{ type: 'data-chat-card', data: {} }], metadata: { createdAt: '2026-10-15T12:00:00Z' } } as unknown as UIMessage
    render([opened, timed('a', '2026-10-16T12:00:00Z')], { hideOpenedCards: true })
    expect(drawn().filter((r) => r?.startsWith('--'))).toHaveLength(1)
  })

  it('a reaction’s own turn takes no row: no message, no line, no time (the agent reads it, the person never sees it)', () => {
    const reaction = timed('r', '2026-10-17T12:00:00Z', 'user', { kind: 'reaction', reaction: { emoji: '👍', messageId: 'a', bubble: 0, excerpt: 'Want it?' } })
    render([timed('a', '2026-10-16T12:00:00Z'), reaction, timed('b', '2026-10-17T12:01:00Z')], { messageTimes: true })
    expect(drawn()).toEqual([expect.stringMatching(/^-- Friday, October 16/), 'a', expect.stringMatching(/^-- Saturday, October 17/), 'b'])
    expect(container.querySelector('[data-message-row="r"]')).toBeNull()
  })

  it('shows each message’s time in its gutter only where the host asks', () => {
    render([timed('a', '2026-10-16T12:00:00Z'), timed('b', '2026-10-16T12:05:00Z', 'user')])
    expect(container.querySelectorAll('[data-message-time]')).toHaveLength(0)
    render([timed('a', '2026-10-16T12:00:00Z'), timed('b', '2026-10-16T12:05:00Z', 'user')], { messageTimes: true })
    const times = Array.from(container.querySelectorAll('[data-message-time]'))
    expect(times).toHaveLength(2)
    expect(times[0].className).toContain('right-full')
    expect(times[1].className).toContain('left-full')
  })
})
