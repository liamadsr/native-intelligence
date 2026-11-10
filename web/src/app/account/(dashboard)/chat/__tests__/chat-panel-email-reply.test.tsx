// @vitest-environment jsdom
/**
 * Mail's Reply / Reply All → the chat, at the ChatPanel handle.
 *
 * The thread view fires `ni:email-reply`; the shell forwards the checked
 * request to the ACTIVE tab's panel via `replyToEmail`. What this pins:
 *
 *   • the panel auto-sends the seeded turn (src/lib/email/reply-in-chat.ts)
 *     with the tab's system context plus the request as `emailReply` (what
 *     loads the thread into that turn's prompt), and NO skill: the reply skill
 *     is retired, and the general assistant drafts the reply with its email
 *     tools;
 *   • it focuses the chat and leaves what the user was typing in the composer;
 *   • a click while a turn is in flight is never dropped and never sent over
 *     the stream: it waits, and goes out when the chat settles, one per turn;
 *   • a double click sends one reply.
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

const sendMessage = vi.fn()
const chat = vi.hoisted(() => ({ status: 'ready' as string }))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage,
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: chat.status,
    stop: vi.fn(),
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

import { ChatPanel, REPEAT_REPLY_MS, type ChatPanelHandle } from '../chat-panel'
import { buildEmailReplySeedText, type EmailReplyRequest } from '@/lib/email/reply-in-chat'

const REPLY_ALL: EmailReplyRequest = { threadId: '1929fa3c5b7e0d12' }
const REPLY_TO_SIMON: EmailReplyRequest = {
  threadId: '1929fa3c5b7e0d12',
  message: { id: '1929fb00aa11bb22', fromEmail: 'simon@harborline.io' },
}
const MAIL_CONTEXT = { assistantName: 'Dial' }

describe('ChatPanel.replyToEmail', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-1',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
      systemContext: MAIL_CONTEXT,
    })
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
  }
  /** The chat's turn moves on: re-render with the new status, as useChat would. */
  async function chatIs(status: string) {
    chat.status = status
    await act(async () => root.render(panel()))
    await act(async () => {
      await Promise.resolve()
    })
  }
  async function reply(request: EmailReplyRequest) {
    await act(async () => {
      ref.current!.replyToEmail(request)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    sendMessage.mockClear()
    chat.status = 'ready'
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    container.remove()
  })

  it('auto-sends the seeded turn with the tab’s context and no skill', async () => {
    await mount()
    await reply(REPLY_ALL)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = sendMessage.mock.calls[0]
    expect(message).toEqual({ text: buildEmailReplySeedText(REPLY_ALL), metadata: { createdAt: expect.any(String) } })
    // The request rides on this turn's context: it is what loads the thread
    // into the prompt (chat-system-prompt.ts §6b-email).
    expect(options.body.systemContext).toEqual({ ...MAIL_CONTEXT, emailReply: REPLY_ALL })
    expect(options.body).not.toHaveProperty('skillId')
  })

  it('focuses the chat and leaves what the user was typing in the composer', async () => {
    await mount()
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'what meetings do I have tomorrow?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await reply(REPLY_TO_SIMON)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('what meetings do I have tomorrow?')
    expect(sendMessage.mock.calls[0][0].text).toBe(buildEmailReplySeedText(REPLY_TO_SIMON))
  })

  it('a click while a turn is in flight waits, and goes out when the chat settles', async () => {
    await mount()
    await chatIs('streaming')
    await reply(REPLY_ALL)
    expect(sendMessage).not.toHaveBeenCalled()

    await chatIs('ready')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0].text).toBe(buildEmailReplySeedText(REPLY_ALL))
  })

  it('two replies asked while it answers go out one per turn, in order', async () => {
    await mount()
    await chatIs('submitted')
    await reply(REPLY_ALL)
    await reply(REPLY_TO_SIMON)
    expect(sendMessage).not.toHaveBeenCalled()

    await chatIs('ready')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await chatIs('submitted')
    await chatIs('streaming')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await chatIs('ready')
    expect(sendMessage.mock.calls.map(([m]) => m.text)).toEqual([
      buildEmailReplySeedText(REPLY_ALL),
      buildEmailReplySeedText(REPLY_TO_SIMON),
    ])
  })

  it('a double click sends one reply; the same Reply asked again later sends another', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount()
    await reply(REPLY_ALL)
    await reply(REPLY_ALL)
    expect(sendMessage).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + REPEAT_REPLY_MS + 1)
    await reply(REPLY_ALL)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})
