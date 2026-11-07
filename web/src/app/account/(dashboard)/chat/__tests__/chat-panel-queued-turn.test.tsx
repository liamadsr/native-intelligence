// @vitest-environment jsdom
/**
 * A message sent while a reply is still running (queued-turn.ts).
 *
 * Sending over a running reply let its stream keep writing after the new
 * message, and the SDK appended a second copy of the reply (the duplicate-key
 * warning). Now, pinned here:
 *   • a send during a reply never reaches sendMessage: it shows above the
 *     composer ("Sends when this reply finishes") and the composer clears;
 *   • it goes, once, when the reply finishes, and a second send meanwhile is
 *     added to it (one turn, the words in order);
 *   • "Send now" stops the reply; the message goes the moment the stop settles;
 *   • "Edit" puts the words back into the composer and sends nothing, and the
 *     For you card the message rode back on its chip;
 *   • a stopped or failed reply frees the chat too;
 *   • a send while the chat is idle goes at once, as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'

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
const setMessages = vi.fn()
const stop = vi.fn(async () => {})
const chat = vi.hoisted(() => ({ status: 'ready' as string, messages: [] as unknown[] }))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chat.messages,
    sendMessage,
    setMessages,
    addToolResult: vi.fn(),
    status: chat.status,
    stop,
    error: undefined,
    regenerate: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
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

// The thread itself isn't what these pin (its tool cards want the tabs
// provider); the panel's state and sends are.
vi.mock('../chat-message-list', () => ({ ChatMessageList: () => null }))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { CARD_REPLY_HELD_NOTE } from '../card-reply-chip'
import type { CardReplyRef } from '@/lib/chat/card-reply'

const CARD: CardReplyRef = {
  kind: 'card',
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  verb: 'Add',
  sentence: '“Send Dana the pricing deck” to your to-dos',
  subkind: 'action_card',
}

describe('ChatPanel: a message sent while a reply is running waits', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-queue',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
    })
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
  }
  /** The reply moves on: re-render with the new status, as useChat would. */
  async function chatIs(status: string) {
    chat.status = status
    await act(async () => root.render(panel()))
    await act(async () => {
      await Promise.resolve()
    })
  }
  async function type(text: string) {
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function enter() {
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }
  async function send(text: string) {
    await type(text)
    await enter()
  }
  const row = () => container.querySelector('[data-queued-turn]')
  const chip = () => container.querySelector<HTMLElement>('[data-card-reply-chip]')
  const rowText = () => container.querySelector('[data-queued-turn-text]')?.textContent ?? null
  const composer = () => container.querySelector('textarea')!.value
  function button(label: string): HTMLButtonElement {
    const b = [...container.querySelectorAll('[data-queued-turn] button')].find((x) => x.textContent === label)
    if (!b) throw new Error(`no ${label} button`)
    return b as HTMLButtonElement
  }
  const sentTexts = () => sendMessage.mock.calls.map(([message]) => (message as { text: string }).text)

  beforeEach(() => {
    sendMessage.mockClear()
    setMessages.mockClear()
    stop.mockClear()
    chat.status = 'ready'
    chat.messages = []
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('a send while idle goes at once, and no row shows', async () => {
    await mount()
    await send('hello')
    expect(sentTexts()).toEqual(['hello'])
    expect(row()).toBeNull()
  })

  it('a send during a reply waits above the composer, then goes once when the reply finishes', async () => {
    await mount()
    await chatIs('streaming')
    await send('and the Q3 numbers')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(row()?.textContent).toContain('Sends when this reply finishes')
    expect(rowText()).toBe('and the Q3 numbers')
    expect(composer()).toBe('')

    await chatIs('ready')
    expect(sentTexts()).toEqual(['and the Q3 numbers'])
    expect(row()).toBeNull()

    // Nothing more goes on the next settle.
    await chatIs('submitted')
    await chatIs('ready')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('a second send meanwhile joins the waiting one: one turn, the words in order', async () => {
    await mount()
    await chatIs('submitted')
    await send('first thought')
    await send('second thought')
    expect(rowText()).toBe('first thought\n\nsecond thought')

    await chatIs('ready')
    expect(sentTexts()).toEqual(['first thought\n\nsecond thought'])
  })

  it('"Send now" stops the reply; the message goes the moment the stop settles', async () => {
    await mount()
    await chatIs('streaming')
    await send('stop and do this instead')

    await act(async () => button('Send now').click())
    expect(stop).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()

    await chatIs('ready')
    expect(sentTexts()).toEqual(['stop and do this instead'])
  })

  it('"Edit" puts the words back in the composer and sends nothing', async () => {
    await mount()
    await chatIs('streaming')
    await send('draft I want to change')

    await act(async () => button('Edit').click())
    expect(row()).toBeNull()
    expect(composer()).toBe('draft I want to change')

    await chatIs('ready')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('"Edit" on a message that rode a For you card puts the card back on its chip, and it rides the next send', async () => {
    await mount()
    await chatIs('streaming')
    await act(async () => {
      ref.current!.replyToCard(CARD)
      await Promise.resolve()
    })
    await send('make it Friday')
    expect(chip()).toBeNull()

    await act(async () => button('Edit').click())
    expect(composer()).toBe('make it Friday')
    expect(chip()?.getAttribute('data-card-reply-chip')).toBe(CARD.id)

    await chatIs('ready')
    expect(sendMessage).not.toHaveBeenCalled()
    await enter()
    expect(sentTexts()).toEqual(['make it Friday'])
    const context = (sendMessage.mock.calls[0][1] as { body: { systemContext: Record<string, unknown> } }).body.systemContext
    expect(context.replyCard).toEqual(CARD)
    expect(chip()).toBeNull()
  })

  it('"Edit" never replaces a card the person attached since', async () => {
    const other: CardReplyRef = { ...CARD, id: '44444444-4444-4444-8444-444444444444', verb: 'Review' }
    await mount()
    await chatIs('streaming')
    await act(async () => {
      ref.current!.replyToCard(CARD)
      await Promise.resolve()
    })
    await send('make it Friday')
    await act(async () => {
      ref.current!.replyToCard(other)
      await Promise.resolve()
    })
    await act(async () => button('Edit').click())
    expect(chip()?.getAttribute('data-card-reply-chip')).toBe(other.id)
  })

  it('a failed reply frees the chat too', async () => {
    await mount()
    await chatIs('streaming')
    await send('try again')
    await chatIs('error')
    expect(sentTexts()).toEqual(['try again'])
  })

  it('words typed while the agent waits on its question answer it, never wait behind it', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'book it' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ask-1',
            state: 'input-available',
            input: { questions: [{ question: 'Which day?', options: [{ label: 'Mon' }, { label: 'Tue' }] }] },
          },
        ],
      },
    ]
    await mount()
    await chatIs('streaming')
    await send('Friday works')

    expect(row()).toBeNull()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer()).toBe('')
    // The question's part flips to answered with the typed words.
    const flip = setMessages.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function') as
      | ((prev: unknown[]) => Array<{ parts: Array<{ toolCallId?: string; state?: string; output?: unknown }> }>)
      | undefined
    expect(flip).toBeDefined()
    const answered = flip!(chat.messages)[1].parts[0]
    expect(answered).toMatchObject({ toolCallId: 'ask-1', state: 'output-available', output: { response: 'Friday works' } })
  })

  it('an answer to the question leaves a waiting For you card on its chip, says so, and the next message carries it', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'book it' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ask-1',
            state: 'input-available',
            input: { questions: [{ question: 'Which day?', options: [{ label: 'Mon' }, { label: 'Tue' }] }] },
          },
        ],
      },
    ]
    await mount()
    await chatIs('streaming')
    await act(async () => {
      ref.current!.replyToCard(CARD)
      await Promise.resolve()
    })
    expect(container.querySelector('[data-card-reply-note]')).toBeNull()
    await send('Friday works')

    // The answer went (its words only); the card stayed, and the chip says why.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(chip()?.getAttribute('data-card-reply-chip')).toBe(CARD.id)
    expect(container.querySelector('[data-card-reply-note]')?.textContent).toBe(CARD_REPLY_HELD_NOTE)

    // The question answered and the reply done: the next message carries the card, and the chip goes.
    const flip = setMessages.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function') as (prev: unknown[]) => unknown[]
    chat.messages = flip(chat.messages)
    await chatIs('ready')
    await send('and add it to my to-dos')
    expect(sentTexts()).toEqual(['and add it to my to-dos'])
    const context = (sendMessage.mock.calls[0][1] as { body: { systemContext: Record<string, unknown> } }).body.systemContext
    expect(context.replyCard).toEqual(CARD)
    expect(chip()).toBeNull()
  })

  it('a message waiting when the page goes away is kept in the composer the device saves', async () => {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const withSnapshot = () =>
      h(ChatPanel, { ref, chatSessionId: 'sess-queue', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true })
    await act(async () => root.render(withSnapshot()))
    chat.status = 'streaming'
    await act(async () => root.render(withSnapshot()))
    await send('don’t lose me')
    expect(ref.current!.flushSnapshot().chatInput).toBe('don’t lose me')
  })

  it('a skill picked while a reply runs waits like a typed message, then goes with its skill', async () => {
    await mount()
    await chatIs('streaming')
    await act(async () => {
      ref.current!.triggerSkill({ id: 'skill-brief', slug: 'morning-brief', name: 'Morning Brief', icon: null, color: null, description: null, views_context: null } as never)
      await Promise.resolve()
    })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(rowText()).toBe('/morning-brief')

    await chatIs('ready')
    expect(sentTexts()).toEqual(['/morning-brief'])
    expect((sendMessage.mock.calls[0][1] as { body: { skillId?: string } }).body.skillId).toBe('skill-brief')
  })

  it('the composer offers to queue while a reply runs with words typed, and Stop when empty', async () => {
    await mount()
    await chatIs('streaming')
    expect(container.querySelector('[aria-label="Stop generating"]')).not.toBeNull()
    await type('next')
    expect(container.querySelector('[aria-label="Stop generating"]')).toBeNull()
    expect(container.querySelector('[aria-label="Send when this reply finishes"]')).not.toBeNull()
  })
})
