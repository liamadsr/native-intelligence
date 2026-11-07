// @vitest-environment jsdom
/**
 * Reply on a For you card → the main chat, at the ChatPanel handle
 * (src/lib/chat/card-reply.ts; the shell forwards the checked ref to the home
 * thread's panel via `replyToCard`). What this pins:
 *
 *   • the card waits as a chip above the composer (its verb and sentence),
 *     the composer's placeholder becomes "Reply to message" and it takes
 *     focus; nothing is sent by the click;
 *   • × takes the chip off, and the placeholder goes back;
 *   • a new Reply replaces the chip (one card at a time); typing keeps it;
 *   • the next typed message carries the card once, as
 *     `systemContext.replyCard` (an attention card's id among `aboutCardIds`
 *     too), and the chip goes; the message after carries nothing;
 *   • a Reply while a reply is still running waits like any typed message:
 *     the chip attaches at once, the message waits above the composer with
 *     the card in its context and goes when the chat settles;
 *   • the chip paints over the composer dock's frosted strip (positioned and
 *     lifted after it), so it is never blurred;
 *   • the replied card's id goes first among the cards a turn is about;
 *   • the sent message keeps the card on its metadata (the thread shows it
 *     above the words, on reload too);
 *   • while the chip waits everything but the composer goes soft (<html>
 *     carries CARD_REPLY_FOCUS_ATTR, the dock rises over the shell's blur)
 *     and the column's card shows as the one in hand; the blur's press
 *     (dismissReplyingCard), or Esc in the field, takes the chip off;
 *   • the chip stays inside the composer's own box, one line at most most
 *     of its width.
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
const chat = vi.hoisted(() => ({ status: 'ready' as string, messages: [] as unknown[] }))

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

vi.mock('../chat-message-list', () => ({ ChatMessageList: () => null }))

import { ChatPanel, withReplyCard, type ChatPanelHandle } from '../chat-panel'
import { CARD_QUOTE_CLASS, CARD_REPLY_PLACEHOLDER } from '../card-reply-chip'
import type { CardReplyRef } from '@/lib/chat/card-reply'
import { CARD_REPLY_FOCUS_ATTR, dismissReplyingCard, useIsReplyingCard } from '@/lib/chat/card-reply-focus'

const WS = '11111111-1111-4111-8111-111111111111'
const CARD: CardReplyRef = {
  kind: 'card',
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: WS,
  verb: 'Add',
  sentence: '“Send Dana the pricing deck” to your to-dos',
  subkind: 'action_card',
}
const REVIEW: CardReplyRef = {
  kind: 'review',
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WS,
  verb: 'Review',
  sentence: 'the draft “Re: pricing”',
  subkind: 'work_run',
}
const CONTEXT = { assistantName: 'Dial' }

describe('ChatPanel.replyToCard', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-card-reply',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
      systemContext: CONTEXT,
    })
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
  }
  async function chatIs(status: string) {
    chat.status = status
    await act(async () => root.render(panel()))
    await act(async () => {
      await Promise.resolve()
    })
  }
  async function reply(card: CardReplyRef) {
    await act(async () => {
      ref.current!.replyToCard(card)
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
  const chip = () => container.querySelector<HTMLElement>('[data-card-reply-chip]')
  const placeholder = () => textarea().getAttribute('placeholder') || textarea().getAttribute('aria-placeholder')
  const contextOf = (call: number) => (sendMessage.mock.calls[call][1] as { body: { systemContext: Record<string, unknown> } }).body.systemContext

  beforeEach(() => {
    sendMessage.mockClear()
    chat.status = 'ready'
    chat.messages = []
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('attaches the card as a chip above the composer, says "Reply to message" and focuses it; nothing is sent', async () => {
    await mount()
    expect(placeholder()).not.toBe(CARD_REPLY_PLACEHOLDER)
    await reply(CARD)
    expect(chip()!.getAttribute('data-card-reply-chip')).toBe(CARD.id)
    expect(chip()!.textContent).toContain('Add')
    expect(chip()!.textContent).toContain('“Send Dana the pricing deck” to your to-dos')
    expect(placeholder()).toBe(CARD_REPLY_PLACEHOLDER)
    expect(document.activeElement).toBe(textarea())
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('× takes the chip off, and the placeholder goes back', async () => {
    await mount()
    await reply(CARD)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-card-reply-remove]')!.click())
    expect(chip()).toBeNull()
    expect(placeholder()).not.toBe(CARD_REPLY_PLACEHOLDER)
    await send('hello')
    expect(contextOf(0)).toEqual(CONTEXT)
  })

  it('one card at a time: a new Reply replaces the chip, and typing keeps it', async () => {
    await mount()
    await reply(CARD)
    await type('can you')
    await reply(REVIEW)
    expect(container.querySelectorAll('[data-card-reply-chip]')).toHaveLength(1)
    expect(chip()!.getAttribute('data-card-reply-chip')).toBe(REVIEW.id)
    expect(textarea().value).toBe('can you')
  })

  it('the next message carries the card once (an attention card among the cards it is about too), and the chip goes', async () => {
    await mount()
    await reply(CARD)
    await send('make it high priority and due Friday')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0].text).toBe('make it high priority and due Friday')
    expect(contextOf(0)).toEqual({ ...CONTEXT, replyCard: CARD, aboutCardIds: [CARD.id] })
    expect(chip()).toBeNull()
    expect(placeholder()).not.toBe(CARD_REPLY_PLACEHOLDER)

    await send('thanks')
    expect(contextOf(1)).toEqual(CONTEXT)
  })

  it('a review rides as itself (no about card id)', async () => {
    await mount()
    await reply(REVIEW)
    await send('shorter please')
    expect(contextOf(0)).toEqual({ ...CONTEXT, replyCard: REVIEW })
  })

  it('a Reply while a reply runs: the chip attaches at once; the message waits with the card and goes when the chat settles', async () => {
    await mount()
    await chatIs('streaming')
    await reply(CARD)
    expect(chip()).not.toBeNull()
    await send('dismiss it')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(chip()).toBeNull()

    await chatIs('ready')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(contextOf(0)).toEqual({ ...CONTEXT, replyCard: CARD, aboutCardIds: [CARD.id] })
  })

  it('the chip paints over the dock’s frosted strip: positioned and lifted, in the composer zone after it', async () => {
    await mount()
    await reply(CARD)
    const dock = container.querySelector<HTMLElement>('[data-chat-composer-dock]')!
    const frost = [...dock.children].find((el) => el.hasAttribute('data-fading-blur'))!
    const zone = dock.querySelector<HTMLElement>('[data-chat-composer]')!
    expect(frost).toBeDefined()
    // The strip stays for the thread behind; the chip is in the zone after it…
    expect(zone.contains(chip())).toBe(true)
    expect(frost.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // …positioned with a z-index, so it paints above the absolute strip.
    expect(chip()!.className).toMatch(/(^|\s)relative(\s|$)/)
    expect(chip()!.className).toMatch(/(^|\s)z-10(\s|$)/)
  })

  it('the replied card’s id goes first among the cards a turn is about (the server keeps the first few)', () => {
    const ctx = { ...CONTEXT, aboutCardIds: ['a', 'b', 'c', 'd', 'e', CARD.id] }
    expect(withReplyCard(ctx, CARD).aboutCardIds).toEqual([CARD.id, 'a', 'b', 'c', 'd', 'e'])
    expect(withReplyCard(CONTEXT, REVIEW).aboutCardIds).toBeUndefined()
  })

  it('a ref that isn’t one (no uuid) attaches nothing', async () => {
    await mount()
    await reply({ ...CARD, id: 'not-a-uuid' })
    expect(chip()).toBeNull()
  })

  it('the sent message keeps the card on its metadata; the next carries none', async () => {
    await mount()
    await reply(CARD)
    await send('what’s this?')
    expect(sendMessage.mock.calls[0][0].metadata).toEqual({ replyCard: CARD, createdAt: expect.any(String) })
    await send('thanks')
    // Only its time (message-time.ts): no card.
    expect(sendMessage.mock.calls[1][0].metadata).toEqual({ createdAt: expect.any(String) })
  })

  it('while the chip waits, everything but the composer goes soft: <html> says so, and the dock rises over the blur', async () => {
    await mount()
    const html = document.documentElement
    const dock = container.querySelector<HTMLElement>('[data-chat-composer-dock]')!
    expect(html.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
    expect(dock.className).toContain('[html[data-card-reply-focus]_&]:z-[46]')
    await reply(CARD)
    expect(html.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-card-reply-remove]')!.click())
    expect(html.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
    await reply(CARD)
    await send('ok')
    expect(html.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
  })

  it('Esc in the field takes the chip off and keeps the words', async () => {
    await mount()
    await reply(CARD)
    await type('half a thought')
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(chip()).toBeNull()
    expect(textarea().value).toBe('half a thought')
  })

  it('the column’s card shows as the one in hand while the chip waits', async () => {
    const probed = vi.fn<(on: boolean) => void>()
    const last = () => probed.mock.calls.at(-1)?.[0]
    function Probe() {
      probed(useIsReplyingCard(CARD))
      return null
    }
    const probeEl = document.createElement('div')
    const probe = createRoot(probeEl)
    await act(async () => probe.render(h(Probe)))
    await mount()
    expect(last()).toBe(false)
    await reply(CARD)
    expect(last()).toBe(true)
    // What's around the chat takes the chip off through it (the side panel's press).
    await act(async () => dismissReplyingCard())
    expect(chip()).toBeNull()
    expect(last()).toBe(false)
    await reply(CARD)
    await send('ok')
    expect(last()).toBe(false)
    act(() => probe.unmount())
  })

  it('the chip is the thread\'s card at the same size: flush with the composer, one line, the same cap', async () => {
    await mount()
    await reply(CARD)
    // Flush with the composer's box: in from the column by the same px-2 ChatInput's root keeps it.
    const input = container.querySelector<HTMLElement>('[data-chat-input-root]')!
    expect(input.className).toMatch(/(^|\s)px-2(\s|$)/)
    expect(chip()!.className).toMatch(/(^|\s)px-2(\s|$)/)
    const card = chip()!.querySelector<HTMLElement>('[data-card-quote]')!
    // The thread's quote's size (CARD_QUOTE_CLASS): its corners, line, text and cap.
    for (const cls of ['rounded-[22px]', 'py-2', 'text-[16px]', 'leading-6', 'max-w-[min(100%,26rem)]']) {
      expect(CARD_QUOTE_CLASS.split(' ')).toContain(cls)
      expect(card.className.split(' ')).toContain(cls)
    }
    expect(card.querySelector('.truncate')!.textContent).toContain(CARD.sentence)
  })
})
