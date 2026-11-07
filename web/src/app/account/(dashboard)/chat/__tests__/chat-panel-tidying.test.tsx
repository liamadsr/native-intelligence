// @vitest-environment jsdom
/**
 * While eve tidies the conversation up (compacts it) before a turn can start,
 * the transport says so (onSessionBusy) and
 * the chat shows SESSION_TIDYING_COPY in place of the waiting orb: no error,
 * no Retry. A send refused because the session is still busy
 * (EVE_SESSION_BUSY) gets its own quiet toast, never "Message failed to send".
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.HTMLElement.prototype.scrollIntoView = () => {}

const env = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: 'ready' as 'ready' | 'submitted' | 'streaming',
  transportOptions: null as null | Record<string, unknown>,
  onError: null as null | ((err: unknown) => void),
  toast: { message: vi.fn(), error: vi.fn() },
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { onError?: (err: unknown) => void }) => {
    env.onError = opts.onError ?? null
    return {
      messages: env.messages,
      sendMessage: vi.fn(),
      setMessages: vi.fn(),
      status: env.status,
      stop: vi.fn(),
      error: undefined,
      regenerate: vi.fn(),
    }
  },
}))
vi.mock('@/lib/chat/eve/eve-chat-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/eve/eve-chat-transport')>()),
  EveChatTransport: class {
    constructor(opts: Record<string, unknown>) {
      env.transportOptions = opts
      return new Proxy(this, {
        get: (t, p) => {
          if (p === 'turnPersisted') return () => Promise.resolve()
          return p in t ? (t as never)[p] : () => undefined
        },
      })
    }
  },
}))
vi.mock('sonner', () => ({ toast: env.toast }))
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
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
}))
vi.mock('../slash-command-picker', () => ({ useRecipeCommands: () => [], SlashCommandPicker: () => null }))
vi.mock('@/lib/workspace-fetch', () => ({
  workspaceFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  installWorkspaceFetch: () => {},
  getClientWorkspaceId: () => 'ws-1',
}))

import { ChatPanel } from '../chat-panel'
import { EVE_SESSION_BUSY, SESSION_TIDYING_COPY } from '@/lib/chat/eve/eve-chat-transport'

describe('ChatPanel while eve tidies the conversation up', () => {
  let container: HTMLDivElement
  let root: Root

  async function render() {
    await act(async () => {
      root.render(h(ChatPanel, { chatSessionId: 'sess-tidy', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true }))
      await Promise.resolve()
    })
  }

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    env.messages = []
    env.status = 'ready'
  })

  it('shows the tidying words in place of the orb while the turn waits, and the orb again after', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    env.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage]
    env.status = 'submitted'
    await render()
    const onSessionBusy = env.transportOptions?.onSessionBusy as (id: string, s: 'compacting' | null) => void
    expect(typeof onSessionBusy).toBe('function')
    expect(container.querySelector('[data-chat-tidying]')).toBeNull()

    await act(async () => onSessionBusy('sess-tidy', 'compacting'))
    expect(container.querySelector('[data-chat-tidying]')?.textContent).toBe(SESSION_TIDYING_COPY)
    expect(container.textContent).not.toMatch(/Retry|failed/i)

    await act(async () => onSessionBusy('sess-tidy', null))
    expect(container.querySelector('[data-chat-tidying]')).toBeNull()
  })

  it('a send refused while the session is busy gets a quiet toast, not the failure one', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
    const err = Object.assign(new Error('The agent is still tidying up this conversation.'), { code: EVE_SESSION_BUSY })
    await act(async () => {
      env.onError?.(err)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(env.toast.message).toHaveBeenCalledWith('Still finishing up', { description: 'The agent is still tidying up this conversation.' })
    expect(env.toast.error).not.toHaveBeenCalled()
  })
})
