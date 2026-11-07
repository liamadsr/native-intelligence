// @vitest-environment jsdom
/**
 * The main chat restored after a reload or a workspace switch mounts its panel
 * on the copy of its thread this device stored — and that copy can be behind
 * its conversation, or empty. It is written only on pagehide and a workspace
 * switch, and a full storage bucket refuses the write without a word.
 *
 * So a panel that mounts bound to a conversation reads its rows once and
 * catches the thread up from them (caughtUpThread). Pinned here on the real
 * ChatPanel over a stateful useChat stub (the same harness as
 * chat-panel-retention):
 *   • an empty or stale copy takes the rows (and is never named: the main chat
 *     has no title);
 *   • a copy holding a message the rows don't have is left alone;
 *   • anything that happened in the panel before the rows arrived wins;
 *   • no conversation, the home conversation, or rows that can't be read:
 *     nothing changes;
 *   • a long thread's newest page (hasMore) catches up a copy at the cap, on
 *     mount and on focus (PROD 2026-10-31: a 616-message home thread never
 *     took a home turn);
 *   • a banner about a home-thread message (lib/chat/home-message.ts): its
 *     arrival reads the message in when the chat lacks it, its click lands on
 *     it, and the miss is reported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
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
window.HTMLElement.prototype.scrollIntoView = () => {}

// A stateful useChat with the real setter's semantics (always a fresh array).
let chatMessages: UIMessage[] = []
let seededWith: UIMessage[] | null = null
let rerender: (() => void) | null = null
const setMessages = vi.fn((updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
  const next = typeof updater === 'function' ? updater(chatMessages) : updater
  chatMessages = [...next]
  rerender?.()
})

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages?: UIMessage[] }) => {
    if (seededWith === null) {
      seededWith = opts.messages ?? []
      chatMessages = [...seededWith]
    }
    return {
      messages: chatMessages,
      sendMessage: vi.fn(),
      setMessages,
      addToolResult: vi.fn(),
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
      regenerate: vi.fn(),
    }
  },
}))

vi.mock('@/lib/supabase/client', () => {
  // Chainable: the home conversation's Realtime bridge subscribes to two events.
  const channel: Record<string, () => unknown> = { on: () => channel, subscribe: () => channel }
  return {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      channel: () => channel,
      removeChannel: () => {},
    }),
  }
})
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
}))
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [],
  SlashCommandPicker: () => null,
}))
vi.mock('@/lib/workspace-fetch', () => ({
  workspaceFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  installWorkspaceFetch: () => {},
  getClientWorkspaceId: () => 'ws-1',
}))

const posthogCapture = vi.hoisted(() => vi.fn())
vi.mock('posthog-js/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('posthog-js/react')>()),
  usePostHog: () => ({ capture: posthogCapture }),
}))
// The message list is stubbed (it draws nothing): a message counts as drawn once the thread holds it.
vi.mock('../message-interactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../message-interactions')>()),
  jumpToMessage: () => false,
  jumpToMessageWhenDrawn: async (id: string) => chatMessages.some((m) => m.id === id),
}))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { createRef } from 'react'

const msg = (id: string, role: 'user' | 'assistant' = 'user'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage
const rows = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user'))

// ── The network: the conversation's rows, answered when the test says so ───

let history: { respond: (body: unknown, ok?: boolean) => Promise<void>; fail: () => Promise<void> } | null = null
const fetchMock = vi.fn()
const historyReads = () => fetchMock.mock.calls.filter((c) => /^\/api\/account\/chat-history\/[^/]+$/.test(String(c[0]))).length
const titleRequests = () => fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/account/chat/title').length

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  chatMessages = []
  seededWith = null
  setMessages.mockClear()
  history = null
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    if (/^\/api\/account\/chat-history\/[^/]+$/.test(String(url)) && (!init?.method || init.method === 'GET')) {
      return new Promise((resolve, reject) => {
        history = {
          respond: async (body, ok = true) => {
            resolve({ ok, status: ok ? 200 : 500, json: async () => body })
            await settle()
          },
          fail: async () => {
            reject(new TypeError('Failed to fetch'))
            await settle()
          },
        }
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  globalThis.fetch = fetchMock as never
})

let container: HTMLDivElement
let root: Root | undefined

async function mount(props: {
  initialMessages?: UIMessage[]
  initialConversationId?: string
  homeConversationId?: string
  homeThreadId?: string
  ref?: React.Ref<ChatPanelHandle>
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  const render = () =>
    r.render(
      h(ChatPanel, {
        chatSessionId: 'sess-restored',
        userAvatarUrl: null,
        userInitials: 'LA',
        alwaysShowMessages: true,
        ...props,
      }),
    )
  rerender = () => act(() => render())
  await act(async () => {
    render()
    await Promise.resolve()
  })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  rerender = null
})

describe('ChatPanel — a restored thread catches up from its conversation', () => {
  it('an EMPTY stored copy takes the conversation, and nothing names the chat', async () => {
    await mount({ initialMessages: [], initialConversationId: 'conv-1' })
    expect(historyReads()).toBe(1)

    await history!.respond({ messages: rows(6), title: 'Hiring plan' })

    expect(chatMessages.map((m) => m.id)).toEqual(rows(6).map((m) => m.id))
    // The main chat has no title to ask for.
    expect(titleRequests()).toBe(0)
  })

  it('a copy that fell behind takes the rest', async () => {
    await mount({ initialMessages: rows(6).slice(0, 2), initialConversationId: 'conv-1' })
    await history!.respond({ messages: rows(6), title: 'Something else' })

    expect(chatMessages.map((m) => m.id)).toEqual(rows(6).map((m) => m.id))
  })

  it('a copy holding a message the conversation never got is left as it is', async () => {
    const stored = [...rows(2), msg('unsaved')]
    await mount({ initialMessages: stored, initialConversationId: 'conv-1' })
    await history!.respond({ messages: rows(6), title: null })

    expect(chatMessages.map((m) => m.id)).toEqual(stored.map((m) => m.id))
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('whatever happened in the panel before the rows arrived wins', async () => {
    await mount({ initialMessages: [], initialConversationId: 'conv-1' })
    // A message sent (or a conversation loaded) while the read was out.
    await act(async () => {
      chatMessages = [msg('typed-now')]
      rerender!()
      await Promise.resolve()
    })
    await history!.respond({ messages: rows(6), title: 'Hiring plan' })

    expect(chatMessages.map((m) => m.id)).toEqual(['typed-now'])
  })

  it('reads nothing for a chat with no conversation, or one on the home conversation', async () => {
    await mount({ initialMessages: [] })
    expect(historyReads()).toBe(0)
    act(() => root!.unmount())
    root = undefined
    container.remove()

    seededWith = null
    await mount({ initialMessages: [], initialConversationId: 'conv-home', homeConversationId: 'conv-home' })
    expect(historyReads()).toBe(0)
  })

  it('rows that can\'t be read leave the stored copy standing', async () => {
    await mount({ initialMessages: rows(2), initialConversationId: 'conv-1' })
    await history!.respond({ error: 'boom' }, false)
    expect(chatMessages.map((m) => m.id)).toEqual(['m0', 'm1'])

    act(() => root!.unmount())
    root = undefined
    container.remove()
    seededWith = null
    await mount({ initialMessages: rows(2), initialConversationId: 'conv-1' })
    await history!.fail()
    expect(chatMessages.map((m) => m.id)).toEqual(['m0', 'm1'])
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('a panel gone before the rows arrive does nothing with them', async () => {
    await mount({ initialMessages: [], initialConversationId: 'conv-1' })
    act(() => root!.unmount())
    root = undefined
    await history!.respond({ messages: rows(6), title: 'Hiring plan' })
    expect(setMessages).not.toHaveBeenCalled()
  })
})

// ── A long home thread, and a banner about a message in it ─────────────────

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => msg(`m${from + i}`, (from + i) % 2 ? 'assistant' : 'user'))
const homeTurn = (id: string): UIMessage =>
  ({ id: `home-turn:${id}`, role: 'assistant', parts: [{ type: 'text', text: 'Your Whole Foods delivery moved to 4:00.' }], metadata: { kind: 'home_turn', eve_written: true } }) as UIMessage
const reads = (pattern: RegExp) => fetchMock.mock.calls.filter((c) => pattern.test(String(c[0]))).length

describe('ChatPanel — a long thread’s newest page catches a copy at the cap up (PROD 2026-10-31)', () => {
  it('on mount: a copy whose oldest messages are past the page takes the newer rows', async () => {
    await mount({ initialMessages: range(0, 300), initialConversationId: 'conv-1' })
    await history!.respond({ messages: range(60, 350), hasMore: true })

    expect(chatMessages.at(-1)!.id).toBe('m409')
    expect(chatMessages).toHaveLength(300)
  })

  it('on focus: the home thread takes the home turn that landed, though its oldest message left the page', async () => {
    await mount({ initialMessages: range(0, 300), initialConversationId: 'home-1', homeThreadId: 'home-1' })
    await history!.respond({ messages: range(0, 300), hasMore: true })
    expect(chatMessages.at(-1)!.id).toBe('m299')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    await history!.respond({ messages: [...range(1, 299), homeTurn('wf')], hasMore: true })

    expect(chatMessages.at(-1)!.id).toBe('home-turn:wf')
    expect(chatMessages).toHaveLength(300)
  })
})

describe('ChatPanel — a banner about a home-thread message (lib/chat/home-message.ts)', () => {
  async function mountHome() {
    const ref = createRef<ChatPanelHandle>()
    await mount({ initialMessages: range(0, 4), initialConversationId: 'home-1', homeThreadId: 'home-1', ref })
    await history!.respond({ messages: range(0, 4) })
    posthogCapture.mockClear()
    return ref
  }

  it('a click on one the chat lacks reads it in, lands on it, and reports the miss', async () => {
    const ref = await mountHome()
    let revealed: Promise<boolean> | null = null
    await act(async () => {
      revealed = ref.current!.revealMessage('home-turn:wf')
      await Promise.resolve()
    })
    expect(reads(/\/api\/account\/chat-history\/home-1\?limit=100$/)).toBe(1)
    await history!.respond({ messages: [...range(0, 4), homeTurn('wf')] })

    expect(await revealed!).toBe(true)
    expect(chatMessages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'home-turn:wf'])
    expect(posthogCapture).toHaveBeenCalledWith('home_message_catch_up', { trigger: 'click', before: 'absent', drawn: true, status: 'ready', channel: 'none' })
  })

  it('its arrival reads it in when the chat lacks it, and reports the miss', async () => {
    const ref = await mountHome()
    let done: Promise<void> | null = null
    await act(async () => {
      done = ref.current!.catchUpServerTurns('home-turn:wf')
      await Promise.resolve()
    })
    await history!.respond({ messages: [...range(0, 4), homeTurn('wf')] })
    await done

    expect(chatMessages.at(-1)!.id).toBe('home-turn:wf')
    expect(posthogCapture).toHaveBeenCalledWith('home_message_catch_up', { trigger: 'banner', before: 'absent', status: 'ready', channel: 'none' })
  })

  it('its arrival reads nothing when the chat holds it already (the live bridge brought it)', async () => {
    const ref = await mountHome()
    const before = fetchMock.mock.calls.length
    await act(async () => {
      await ref.current!.catchUpServerTurns('m3')
    })
    expect(fetchMock.mock.calls.length).toBe(before)
    expect(posthogCapture).not.toHaveBeenCalled()
  })
})
