// @vitest-environment jsdom
/**
 * An area face's page chats in the person's main-chat conversation focused on
 * its area (one-agent plan S3; useTeammateChat's `focusArea`):
 *   - it opens with eve-session { action: 'focus', focusArea }, never the
 *     face's thread, and its transport mints as the main agent with the focus
 *     (no teammate);
 *   - "Refine in chat" posts there with the card it's about: the main agent's
 *     token takes no item, so the card's id rides the text (focusedAboutLine)
 *     and the main agent can read, revise or settle THAT card (S3 review).
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
import { __resetTeammateChatsForTests, sendToTeammate } from '@/hooks/use-teammate-chat'

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
      if (url === '/api/account/chat/eve-session') return json({ conversationId: 'conv-focus', workspaceId: 'ws-1', eveSessionId: null, focusArea: 'mail' })
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

describe('an area face’s page chat (one-agent S3)', () => {
  it('opens the focused main-agent conversation, never the face’s thread', async () => {
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-mail', workspaceId: 'ws-1', focusArea: 'mail' }))
    })
    await act(async () => {
      await flush()
    })
    const opened = calls.find((c) => c.url === '/api/account/chat/eve-session')!
    expect(opened.body).toEqual({ action: 'focus', focusArea: 'mail' })
    expect(transports).toHaveLength(1)
    expect(transports[0].opts).not.toHaveProperty('teammateId')
    expect((transports[0].opts.getFocusArea as () => string)()).toBe('mail')
  })

  it('Refine in chat posts the card’s id with the text, so the main agent can act on THAT card', async () => {
    const ok = await sendToTeammate('tm-mail', 'ws-1', 'Let’s work on this email', { about: { cardId: CARD }, focusArea: 'mail' })
    await act(async () => {
      await flush()
    })
    expect(ok).toBe(true)
    const send = transports.at(-1)!.sends.at(-1)!
    const text = send.messages.at(-1)!.parts.find((p) => p.type === 'text')!.text!
    expect(text.startsWith('Let’s work on this email')).toBe(true)
    expect(text).toContain(`get_bot_item, id ${CARD}`)
    expect(text).toContain(`settle_card, card_id ${CARD}`)
    // The main agent's token takes no item: nothing about rides the body.
    expect(send.body ?? {}).not.toHaveProperty('teammateAbout')
  })

  it('the face’s own thread (the bubble) still sends the item as its about, with the text untouched', async () => {
    await sendToTeammate('tm-mail', 'ws-1', 'Let’s work on this email', { about: { cardId: CARD } })
    await act(async () => {
      await flush()
    })
    const send = transports.at(-1)!.sends.at(-1)!
    expect(send.messages.at(-1)!.parts.find((p) => p.type === 'text')!.text).toBe('Let’s work on this email')
    expect(send.body).toMatchObject({ teammateAbout: { cardId: CARD } })
  })
})
