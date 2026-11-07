// @vitest-environment jsdom
/**
 * A blank chat prewarms its eve session on the first keystroke of its first
 * message (docs/plans/chat-ttft.md, Phase 5), so Enter only sends.
 *
 * Pinned here: the composer asks the transport once per draft, with the
 * persona and skill the send will carry; a chat with messages, or one bound to
 * a conversation, never asks. And the panel follows the client's token
 * refreshes, so a send's mint seals the live JWT (the prewarm's token is only
 * reused on that same JWT). What the transport does with it (and that it
 * makes at most one per blank chat) is covered in eve-chat-transport.test.ts.
 *
 * Also the typing presence signal: typing in a chat bound to a conversation
 * hands the transport that conversation (it throttles to one ping a minute,
 * eve-chat-transport-presence.test.ts); a blank chat or an empty draft never.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { ChatTransport } from 'ai'

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

let chatMessages: UIMessage[] = []
/** The transport the panel hands useChat. */
let chatTransport: ChatTransport<UIMessage> | null = null
/** The panel's onAuthStateChange listener, as supabase-js holds it. */
let authListener: ((event: string, session: { access_token?: string } | null) => void) | null = null
/** The listener's unsubscribe, which the panel calls when it unmounts. */
const authUnsubscribe = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { transport?: ChatTransport<UIMessage> }) => {
    chatTransport = opts.transport ?? null
    return {
    messages: chatMessages,
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: 'ready',
    stop: vi.fn(),
    error: undefined,
    regenerate: vi.fn(),
    }
  },
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: (listener: typeof authListener) => {
        authListener = listener
        return { data: { subscription: { unsubscribe: authUnsubscribe } } }
      },
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}))

// The composer's Capture button needs the recording + tabs providers, which
// these tests don't mount; it has its own tests (capture-bar-button-calendar).
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [
    { id: 'skill-prospect-list', slug: 'build-prospect-list', name: 'Build a prospect list', icon: null, color: null, description: null, views_context: null },
  ],
  SlashCommandPicker: () => null,
}))

// The rendered list drags in ChatMessage's dependencies; only
// whether the chat HAS messages matters here.
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
}))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'

describe('ChatPanel prewarm', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  let prewarm: MockInstance<EveChatTransport['prewarm']>
  let presence: MockInstance<EveChatTransport['presence']>

  async function mount(props: Record<string, unknown> = {}) {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatPanel, {
          ref,
          chatSessionId: 'sess-pre',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
          ...props,
        }),
      )
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

  beforeEach(() => {
    chatMessages = []
    chatTransport = null
    authListener = null
    authUnsubscribe.mockClear()
    prewarm = vi.spyOn(EveChatTransport.prototype, 'prewarm').mockResolvedValue(undefined)
    presence = vi.spyOn(EveChatTransport.prototype, 'presence').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    prewarm.mockRestore()
    presence.mockRestore()
  })

  it('typing in a chat bound to a conversation hands the transport that conversation’s presence', async () => {
    await mount({ initialConversationId: 'conv-home' })
    await type('h')
    await type('hi')
    expect(presence).toHaveBeenCalledTimes(2)
    expect(presence).toHaveBeenCalledWith('conv-home')
  })

  it('a blank chat, or a cleared draft, never signals presence', async () => {
    await mount()
    await type('hello')
    expect(presence).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
    await mount({ initialConversationId: 'conv-home' })
    await type('   ')
    expect(presence).not.toHaveBeenCalled()
  })

  it('asks once, on the first keystroke of a blank chat’s draft', async () => {
    await mount()
    await type('h')
    await type('he')
    await type('hello')
    expect(prewarm).toHaveBeenCalledTimes(1)
    expect(prewarm).toHaveBeenCalledWith('sess-pre', { agentId: undefined, skillId: undefined })
  })

  it('carries the skill armed in the composer', async () => {
    await mount()
    await act(async () => {
      await ref.current!.askAboutList({ listId: 'list-1', listName: 'Series A fintech', selectedCount: 3 })
    })
    await type('research these')
    expect(prewarm).toHaveBeenCalledTimes(1)
    expect(prewarm).toHaveBeenCalledWith('sess-pre', { agentId: undefined, skillId: 'skill-prospect-list' })
  })

  it('never asks for a chat that already has messages', async () => {
    chatMessages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'earlier' }] } as UIMessage]
    await mount()
    await type('follow-up')
    expect(prewarm).not.toHaveBeenCalled()
  })

  it('never asks for a chat bound to a conversation (a loaded chat, the onboarding home)', async () => {
    await mount({ initialConversationId: 'conv-home' })
    await type('hi')
    expect(prewarm).not.toHaveBeenCalled()
  })

  it('follows the client’s token refreshes: the next send’s mint carries the JWT onAuthStateChange pushed', async () => {
    await mount()
    // Outside act, React has not re-rendered (nor run the effect that copies
    // accessToken state into the ref) when the send below reads the token, so
    // only the listener's own synchronous ref write can supply tok-2.
    const actWarning = vi.spyOn(console, 'error').mockImplementation(() => {})
    authListener!('TOKEN_REFRESHED', { access_token: 'tok-2' })
    // A session-less event (signed out) leaves the cached token alone.
    authListener!('SIGNED_OUT', null)
    // The mint is the first request of a send; refuse it to end the send there.
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: false, status: 500, json: async () => ({ error: 'stop' }) }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        chatTransport!.sendMessages({
          chatId: 'sess-pre',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
          trigger: 'submit-message',
          messageId: undefined,
          body: {},
        } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]),
      ).rejects.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
    const mint = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/account/chat/eve-session'))
    expect((mint?.[1] as RequestInit | undefined)?.headers).toMatchObject({ Authorization: 'Bearer tok-2' })
    // Let the scheduled state update land before the test ends.
    await act(async () => {})
    actWarning.mockRestore()
  })

  it('unsubscribes from onAuthStateChange when it unmounts', async () => {
    await mount()
    expect(authUnsubscribe).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(authUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
