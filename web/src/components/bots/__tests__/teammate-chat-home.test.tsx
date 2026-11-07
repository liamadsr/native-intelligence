// @vitest-environment jsdom
/**
 * The agent's face runs NO Chat on the home thread (one face,
 * docs/plans/always-on-agent.md §2c; review of A3): the chat strip's home tab
 * is its one Chat in a window, so two views can't drift apart or both send
 * (#681). TeammateChat `home` (the bubble, the agent page, its item chat):
 *   - opens nothing: no eve-session call, no transport, no history read;
 *   - says where its conversation is, with a way there (openHomeThread);
 *   - what's typed goes to the strip (OPEN_HOME_THREAD_EVENT with the text),
 *     a card it's about riding as `cardIds` (the turn's aboutCardIds), a work
 *     item's ids in the text; a card's Refine goes there too.
 * The transport is a scripted stand-in (its own tests pin the wire).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/app/account/(dashboard)/chat/chat-message', () => ({
  ChatMessage: ({ message }: { message: { role: string; parts: Array<Record<string, unknown>> } }) =>
    h('div', { 'data-role': message.role }, message.parts.map((p) => (p.type === 'text' ? (p.text as string) : '')).join(' ')),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-1', user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}))

const transports: Array<{ opts: Record<string, unknown>; sends: Array<{ messages: Array<{ parts: Array<{ type: string; text?: string }> }>; body?: Record<string, unknown> }> }> = []
vi.mock('@/lib/chat/eve/eve-chat-transport', () => ({
  EveChatTransport: class {
    record: (typeof transports)[number]
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, sends: [] }
      transports.push(this.record)
    }
    async sendMessages(options: (typeof transports)[number]['sends'][number]) {
      this.record.sends.push(options)
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start' })
          controller.enqueue({ type: 'finish' })
          controller.close()
        },
      })
    }
    async reconnectToStream() {
      return null
    }
    async disposeAll() {}
  },
}))

import { TeammateChat } from '../teammate-chat'
import { __resetTeammateChatsForTests } from '@/hooks/use-teammate-chat'
import { OPEN_HOME_THREAD_EVENT } from '@/lib/chat/home-thread-client'
import { sendRefine } from '@/lib/bots/refine-in-chat'

const CARD = '11111111-2222-4333-8444-555555555555'
let container: HTMLDivElement
let root: Root
const calls: Array<{ url: string; body: Record<string, unknown> }> = []

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  transports.length = 0
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ url, body })
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response
      if (url === '/api/account/chat/eve-session') return json({ token: 'run.token', conversationId: 'conv-home', eveSessionId: 'sess-home' })
      if (url.startsWith('/api/account/chat-history/')) return json({ messages: [] })
      return json({})
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  __resetTeammateChatsForTests()
  container.remove()
  vi.unstubAllGlobals()
})

describe('the agent’s face hands off to the strip’s home thread (one face)', () => {
  const opened: unknown[] = []
  // A stand-in chat strip: takes the event, records what was handed over, and
  // answers with `answer` (the strip's real result: handOffToHome).
  let answer: { ok: true } | { ok: false; reason: string } = { ok: true }
  const onOpen = (e: Event) => {
    const { take, onResult, ...rest } = (e as CustomEvent).detail as Record<string, unknown> & { take?: () => void; onResult?: (r: unknown) => void }
    opened.push(rest)
    take?.()
    onResult?.(answer)
  }
  beforeEach(() => {
    opened.length = 0
    answer = { ok: true }
    window.addEventListener(OPEN_HOME_THREAD_EVENT, onOpen)
  })
  afterEach(() => window.removeEventListener(OPEN_HOME_THREAD_EVENT, onOpen))

  const box = () => container.querySelector<HTMLTextAreaElement>('textarea')!
  async function type(text: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box(), text)
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await flush()
    })
  }

  it('opens no Chat of its own: no eve-session, no transport, no history; it says where the conversation is', async () => {
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-agent', workspaceId: 'ws-1', home: true }))
    })
    await act(async () => {
      await flush()
    })
    expect(calls).toEqual([])
    expect(transports).toHaveLength(0)
    expect(container.querySelector('[data-teammate-chat-note]')?.textContent).toContain('Your conversation with Assistant is in the chat')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-teammate-chat-note-action]')!.click())
    expect(opened).toEqual([{}])
  })

  it('what’s typed goes to the strip’s home thread, the card it’s about riding as cardIds', async () => {
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-agent', workspaceId: 'ws-1', home: true, about: { context: { cardId: CARD }, title: 'Send Acme the deck' } }))
    })
    await type('make it shorter')
    expect(opened).toEqual([{ text: 'make it shorter', cardIds: [CARD], workspaceId: 'ws-1' }])
    expect(calls).toEqual([])
    expect(transports).toHaveLength(0)
    // Sent: the box is clear.
    expect(box().value).toBe('')
  })

  it('a hand-off that didn’t go keeps the text and says why (A3 verification)', async () => {
    answer = { ok: false, reason: 'That’s in another workspace: switch to it first, then send it again.' }
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-agent', workspaceId: 'ws-1', home: true }))
    })
    await type('make it shorter')
    expect(box().value).toBe('make it shorter')
    expect(container.textContent).toContain('another workspace')
  })

  it('with no chat strip in the window, nothing is said to be sent', async () => {
    window.removeEventListener(OPEN_HOME_THREAD_EVENT, onOpen)
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-agent', workspaceId: 'ws-1', home: true }))
    })
    await type('hello')
    expect(box().value).toBe('hello')
  })

  it('a work item it’s about rides the text as ids (no field for it on the turn)', async () => {
    const JOB = '22222222-3333-4444-8555-666666666666'
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-agent', workspaceId: 'ws-1', home: true, about: { context: { workItemId: JOB }, title: 'Two replies' } }))
    })
    await type('send the first')
    const detail = opened[0] as { text: string; cardIds?: string[] }
    expect(detail.text.startsWith('send the first')).toBe(true)
    expect(detail.text).toContain(`get_bot_item, id ${JOB}`)
    expect(detail.cardIds).toBeUndefined()
  })

  it('Refine on the agent’s card with no run chat hands the template to the strip, the card riding the turn', async () => {
    const ok = await sendRefine({ id: 'tm-agent', workspaceId: 'ws-1', home: true }, { runId: null, context: { cardId: CARD }, title: 'About: the deck', workspaceId: 'ws-1' }, 'Let’s work on this email')
    expect(ok).toBe(true)
    expect(opened).toEqual([{ text: 'Let’s work on this email', cardIds: [CARD], workspaceId: 'ws-1' }])
    answer = { ok: false, reason: 'Couldn’t send that to your conversation. Try again in a moment.' }
    expect(await sendRefine({ id: 'tm-agent', workspaceId: 'ws-1', home: true }, { runId: null, context: { cardId: CARD }, title: 'About: the deck', workspaceId: 'ws-1' }, 'again')).toBe(false)
    expect(calls).toEqual([])
    expect(transports).toHaveLength(0)
  })
})
