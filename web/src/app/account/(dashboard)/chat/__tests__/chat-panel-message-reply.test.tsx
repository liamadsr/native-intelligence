// @vitest-environment jsdom
/**
 * Reply to a message, and react to one, at the ChatPanel (src/lib/chat/message-reply.ts,
 * src/lib/chat/message-reactions.ts; the thread reaches them through
 * MessageInteractionsContext). What this pins:
 *
 *   • a message's Reply waits as a chip above the composer (the words picked
 *     out, or the whole message as written), the placeholder says "Reply to
 *     message"; nothing is sent by it;
 *   • meanwhile everything but the composer goes soft (<html> carries
 *     CARD_REPLY_FOCUS_ATTR, as for a card); a press on the blur takes the
 *     chip off, and so does sending;
 *   • the next typed message carries it once, as `systemContext.replyTo` and
 *     on the message's own metadata (`replyTo`), and the chip goes; × and
 *     Esc take it off;
 *   • one chip at a time: a message's Reply takes a card's place, and a
 *     card's a message's;
 *   • a reaction is saved at once; one that doesn't answer starts no turn
 *     and rides the next typed message (`systemContext.reactions`);
 *   • a yes on the agent's newest message, when it asked something, starts
 *     a turn of its own after the wait: the reaction's line as the words,
 *     `kind: 'reaction'` on the message; taken off in the wait, nothing goes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 400,
})

const sendMessage = vi.fn()
const chat = vi.hoisted(() => ({ status: 'ready' as string, messages: [] as unknown[] }))
// What the thread gets from the panel (its Reply and React), captured by the list's stand-in.
const thread = vi.hoisted(() => ({ interactions: null as null | import('../message-interactions').MessageInteractions }))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chat.messages,
    sendMessage,
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: chat.status,
    stop: vi.fn(async () => {}),
    error: undefined,
    regenerate: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }),
  Toaster: () => null,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}))

vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [],
  SlashCommandPicker: () => null,
}))

vi.mock('../chat-message-list', async () => {
  const { useContext } = await import('react')
  const { MessageInteractionsContext } = await import('../message-interactions')
  return {
    ChatMessageList: () => {
      thread.interactions = useContext(MessageInteractionsContext)
      return null
    },
  }
})

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { MESSAGE_REPLY_PLACEHOLDER } from '../message-reply-chip'
import type { CardReplyRef } from '@/lib/chat/card-reply'
import type { MessageReplyRef } from '@/lib/chat/message-reply'
import { REACTION_TURN_DELAY_MS, reactionTurnText } from '@/lib/chat/message-reactions'
import { CARD_REPLY_FOCUS_ATTR, dismissReplyingCard } from '@/lib/chat/card-reply-focus'

const WS = '11111111-1111-4111-8111-111111111111'
const CONV = '44444444-4444-4444-8444-444444444444'
const CARD: CardReplyRef = {
  kind: 'card',
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: WS,
  verb: 'Add',
  sentence: '“Send Dana the pricing deck” to your to-dos',
}
const REPLY: MessageReplyRef = { messageId: 'eve-msg-a1', role: 'assistant', quote: 'just your Google Calendar so far', part: true }
const CONTEXT = { assistantName: 'Dial' }

const asked: UIMessage = {
  id: 'eve-msg-a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'I drafted it. **Want me to send it to Dana?**' }],
  metadata: { createdAt: '2026-10-20T10:00:00.000Z' },
} as UIMessage
const told: UIMessage = {
  id: 'eve-msg-a0',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Your calendar is connected.' }],
  metadata: { createdAt: '2026-10-20T09:00:00.000Z' },
} as UIMessage
const mine: UIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'Draft a reply to Dana' }],
  metadata: { createdAt: '2026-10-20T09:30:00.000Z' },
} as UIMessage

describe('ChatPanel — a message’s Reply and reactions', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  const fetchMock = vi.fn()

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-message-reply',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
      systemContext: CONTEXT,
      initialConversationId: CONV,
    })
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
    await act(async () => {
      await Promise.resolve()
    })
  }
  const textarea = () => container.querySelector('textarea')!
  async function type(text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function send(text: string) {
    await type(text)
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }
  async function replyTo(reply: MessageReplyRef) {
    await act(async () => {
      thread.interactions!.reply(reply, null)
      await Promise.resolve()
    })
  }
  async function react(message: UIMessage, emoji: string | null, bubble = 0) {
    await act(async () => {
      thread.interactions!.react(message, bubble, emoji)
      await Promise.resolve()
    })
  }
  const chip = () => container.querySelector<HTMLElement>('[data-message-reply-chip]')
  const placeholder = () => textarea().getAttribute('placeholder') || textarea().getAttribute('aria-placeholder')
  const call = (n: number) => sendMessage.mock.calls[n] as [{ text: string; metadata?: Record<string, unknown> }, { body: { systemContext: Record<string, unknown> } }]
  const reactionPosts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/account/chat/reactions') && init?.method === 'POST')

  beforeEach(() => {
    sendMessage.mockClear()
    chat.status = 'ready'
    // The list (and the Reply it is handed) mounts once the thread has messages.
    chat.messages = [mine, told]
    thread.interactions = null
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/account/chat/reactions') && init?.method === 'POST') {
        const { emoji } = JSON.parse(String(init.body)) as { emoji: string | null }
        return new Response(JSON.stringify({ reaction: emoji ? { emoji, at: new Date().toISOString() } : null }), { status: 200 })
      }
      if (String(url).startsWith('/api/account/chat/reactions')) return new Response(JSON.stringify({ reactions: {} }), { status: 200 })
      return new Response(JSON.stringify({ messages: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a message’s Reply waits as a chip with its words; "Reply to message"; nothing is sent', async () => {
    await mount()
    await replyTo(REPLY)
    expect(chip()!.getAttribute('data-message-reply-chip')).toBe(REPLY.messageId)
    expect(chip()!.textContent).toContain('“just your Google Calendar so far”')
    expect(placeholder()).toBe(MESSAGE_REPLY_PLACEHOLDER)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a reply to the whole message shows all of it, as written', async () => {
    chat.messages = [mine, asked]
    await mount()
    await replyTo({ messageId: asked.id, role: 'assistant', quote: 'I drafted it. Want me to send it to Dana?', part: false })
    const body = chip()!.querySelector('[data-message-reply-body]')!
    expect(body.textContent).toBe('I drafted it. Want me to send it to Dana?')
    // Its markdown, drawn: the bold is bold.
    expect(body.querySelector('strong')?.textContent).toBe('Want me to send it to Dana?')
    // The message alone: no header, no ×.
    expect(chip()!.querySelector('[data-message-quote]')!.getAttribute('aria-label')).toBe('Replying to this message')
    expect(chip()!.querySelector('button')).toBeNull()
  })

  it('everything else goes soft while it waits; a press on the blur takes it off, and so does sending', async () => {
    await mount()
    await replyTo(REPLY)
    expect(document.documentElement.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(true)
    await act(async () => dismissReplyingCard())
    expect(chip()).toBeNull()
    expect(document.documentElement.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
    await replyTo(REPLY)
    await send('and this?')
    expect(document.documentElement.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
  })

  it('the next message carries it once, in its context and on its metadata, and the chip goes', async () => {
    await mount()
    await replyTo(REPLY)
    await send('which account is that?')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(call(0)[0].text).toBe('which account is that?')
    expect(call(0)[0].metadata).toMatchObject({ replyTo: REPLY })
    expect(call(0)[1].body.systemContext).toEqual({ ...CONTEXT, replyTo: REPLY })
    expect(chip()).toBeNull()

    await send('thanks')
    expect(call(1)[1].body.systemContext).toEqual(CONTEXT)
    expect(call(1)[0].metadata?.replyTo).toBeUndefined()
  })

  it('Esc takes it off', async () => {
    await mount()
    await replyTo(REPLY)
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(chip()).toBeNull()
    expect(placeholder()).not.toBe(MESSAGE_REPLY_PLACEHOLDER)
  })

  it('one chip at a time: a message’s Reply takes a card’s place, and a card’s a message’s', async () => {
    await mount()
    await act(async () => ref.current!.replyToCard(CARD))
    expect(container.querySelector('[data-card-reply-chip]')).not.toBeNull()
    await replyTo(REPLY)
    expect(container.querySelector('[data-card-reply-chip]')).toBeNull()
    expect(chip()).not.toBeNull()
    await act(async () => ref.current!.replyToCard(CARD))
    expect(chip()).toBeNull()
    expect(container.querySelector('[data-card-reply-chip]')).not.toBeNull()
  })

  it('a reaction that doesn’t answer is saved, starts no turn, and rides the next typed message', async () => {
    chat.messages = [mine, told]
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await react(told, '❤️')
    expect(reactionPosts()).toHaveLength(1)
    expect(JSON.parse(String(reactionPosts()[0][1].body))).toEqual({ conversationId: CONV, messageId: told.id, bubble: 0, emoji: '❤️' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REACTION_TURN_DELAY_MS + 100)
    })
    expect(sendMessage).not.toHaveBeenCalled()
    vi.useRealTimers()

    await send('ok')
    const reactions = call(0)[1].body.systemContext.reactions as Array<Record<string, unknown>>
    expect(reactions).toHaveLength(1)
    expect(reactions[0]).toMatchObject({ emoji: '❤️', excerpt: 'Your calendar is connected.', asked: false })
  })

  it('a yes on the agent’s newest message, which asked something, starts its own turn after the wait', async () => {
    chat.messages = [mine, asked]
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await react(asked, '👍')
    expect(sendMessage).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REACTION_TURN_DELAY_MS + 100)
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, { body }] = call(0)
    expect(message.text).toBe(reactionTurnText({ emoji: '👍', excerpt: 'I drafted it. Want me to send it to Dana?', asked: true }))
    expect(message.metadata).toMatchObject({ kind: 'reaction', reaction: { emoji: '👍', messageId: asked.id, bubble: 0 } })
    expect((body.systemContext.reactions as unknown[]).length).toBe(1)
  })

  it('a yes on a bubble that isn’t the turn’s last is absorbed', async () => {
    const twoSaid = {
      id: 'eve-msg-a2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Shall I look first?' }, { type: 'text', text: 'Looked: nothing new.' }],
      metadata: { createdAt: '2026-10-20T10:00:00.000Z' },
    } as UIMessage
    chat.messages = [mine, twoSaid]
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await react(twoSaid, '👍', 0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REACTION_TURN_DELAY_MS + 100)
    })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(JSON.parse(String(reactionPosts()[0][1].body)).bubble).toBe(0)
  })

  it('taken off in the wait, nothing goes', async () => {
    chat.messages = [mine, asked]
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await react(asked, '👍')
    await react(asked, null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REACTION_TURN_DELAY_MS + 100)
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a yes while a reply runs starts nothing (it rides the next turn)', async () => {
    chat.messages = [mine, asked]
    chat.status = 'streaming'
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await react(asked, '👍')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REACTION_TURN_DELAY_MS + 100)
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
