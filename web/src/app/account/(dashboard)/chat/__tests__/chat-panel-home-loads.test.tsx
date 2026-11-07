// @vitest-environment jsdom
/**
 * The home thread's loads into a chat panel (A3 review). Pinned on the real
 * ChatPanel over a stateful useChat stub (the restored catch-up harness):
 *   - an `ifUntouched` load (the home thread into the chat) aborts when a
 *     message lands in the chat while it reads: the chat that was started
 *     survives, and nothing of it is touched;
 *   - one that lands on an untouched chat applies;
 *   - only the newest load applies: an older one landing late is dropped;
 *   - a home thread re-reads its newest rows when the window regains focus
 *     and takes the ones another window added; a side chat doesn't;
 *   - a home thread on screen is reported to the presence client with its
 *     newest message time (the seen marker, reach-follows-you §2), cleared
 *     when the panel leaves it; a side chat is never reported.
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

// The chat's transport: which eve session its handle is on (A3: the focus
// re-sync drops it when the conversation moved), and its resets.
const transportState = vi.hoisted(() => ({
  sessionId: null as string | null,
  resets: [] as string[],
  sendMessage: (() => {}) as (...args: unknown[]) => unknown,
}))
vi.mock('@/lib/chat/eve/eve-chat-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/eve/eve-chat-transport')>()),
  EveChatTransport: class {
    constructor() {
      return new Proxy(this, {
        get: (target, key) => {
          if (key === 'eveSessionIdOf') return () => transportState.sessionId
          if (key === 'resetSession') return async (chatId: string) => void transportState.resets.push(chatId)
          if (key === 'turnPersisted') return () => Promise.resolve()
          return key in target ? (target as never)[key] : () => undefined
        },
      })
    }
  },
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages?: UIMessage[] }) => {
    if (seededWith === null) {
      seededWith = opts.messages ?? []
      chatMessages = [...seededWith]
    }
    return {
      messages: chatMessages,
      sendMessage: transportState.sendMessage,
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
// The presence client's seen marker (lib/presence/client.ts): what the panel reports, and its clears.
const presence = vi.hoisted(() => ({ reports: [] as [string, number][], clears: 0 }))
vi.mock('@/lib/presence/client', () => ({
  reportHomeView: (conversationId: string, newestAt: number) => {
    presence.reports.push([conversationId, newestAt])
    return () => {
      presence.clears++
    }
  },
}))
vi.mock('@/lib/workspace-fetch', () => ({
  workspaceFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  installWorkspaceFetch: () => {},
  getClientWorkspaceId: () => 'ws-1',
}))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'

const msg = (id: string, role: 'user' | 'assistant' = 'user'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage
const rows = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user'))

// ── The network: the conversation's rows, answered when the test says so ───

type Pending = { respond: (body: unknown, ok?: boolean) => Promise<void>; fail: () => Promise<void> }
let history: Pending | null = null
const pending: Pending[] = []
const fetchMock = vi.fn()
const historyReads = () => fetchMock.mock.calls.filter((c) => /^\/api\/account\/chat-history\/[^/]+$/.test(String(c[0]))).length

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
  pending.length = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    if (/^\/api\/account\/chat-history\/[^/?]+(\?.*)?$/.test(String(url)) && (!init?.method || init.method === 'GET')) {
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
        pending.push(history)
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  globalThis.fetch = fetchMock as never
})

let container: HTMLDivElement
let root: Root | undefined

const panelRef = createRef<ChatPanelHandle>()

async function mount(props: {
  initialMessages?: UIMessage[]
  initialConversationId?: string
  homeConversationId?: string
  homeThreadId?: string
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  const render = () =>
    r.render(
      h(ChatPanel, {
        ref: panelRef,
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

describe('ChatPanel — the home thread’s loads (A3 review)', () => {
  it('an ifUntouched load aborts when a message lands meanwhile: the chat that was started survives', async () => {
    await mount({ initialMessages: [] })
    let outcome: string | undefined
    act(() => {
      void panelRef.current!.loadConversation('home-1', { ifUntouched: true }).then((o) => {
        outcome = o
      })
    })
    // The person sends while the home thread is still being read.
    act(() => setMessages([msg('typed')]))
    await pending[0].respond({ messages: rows(4), title: 'Home', agentTeammateKnown: true })
    expect(outcome).toBe('aborted')
    expect(chatMessages.map((m) => m.id)).toEqual(['typed'])
  })

  it('an ifUntouched load on an untouched chat applies', async () => {
    await mount({ initialMessages: [] })
    let outcome: string | undefined
    act(() => {
      void panelRef.current!.loadConversation('home-1', { ifUntouched: true }).then((o) => {
        outcome = o
      })
    })
    await pending[0].respond({ messages: rows(4), title: 'Home', agentTeammateKnown: true })
    expect(outcome).toBe('loaded')
    expect(chatMessages.map((m) => m.id)).toEqual(rows(4).map((m) => m.id))
  })

  it('an ifUntouched load of a conversation that is gone says so and loads nothing', async () => {
    await mount({ initialMessages: [] })
    let outcome: string | undefined
    act(() => {
      void panelRef.current!.loadConversation('gone', { ifUntouched: true }).then((o) => {
        outcome = o
      })
    })
    await pending[0].respond({ messages: [], title: null, agentTeammateKnown: false })
    expect(outcome).toBe('missing')
    expect(chatMessages).toEqual([])
  })

  it('reads the newest rows a live thread keeps (300), not one page', async () => {
    await mount({ initialMessages: [] })
    act(() => {
      void panelRef.current!.loadConversation('conv-x')
    })
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('/api/account/chat-history/conv-x?limit=300')
  })

  it('only the newest load applies: an older one landing late is dropped', async () => {
    await mount({ initialMessages: [] })
    const outcomes: string[] = []
    act(() => {
      void panelRef.current!.loadConversation('conv-a').then((o) => outcomes.push(`a:${o}`))
      void panelRef.current!.loadConversation('conv-b').then((o) => outcomes.push(`b:${o}`))
    })
    await pending[1].respond({ messages: [msg('b1')], title: 'B', agentTeammateKnown: true })
    await pending[0].respond({ messages: [msg('a1')], title: 'A', agentTeammateKnown: true })
    expect(chatMessages.map((m) => m.id)).toEqual(['b1'])
    expect(outcomes.sort()).toEqual(['a:aborted', 'b:loaded'])
  })

  it('the home thread takes what another window added when this one regains focus; a side chat doesn’t look', async () => {
    await mount({ initialMessages: rows(2), initialConversationId: 'home-1', homeThreadId: 'home-1' })
    // The mount's catch-up read: nothing new.
    await pending[0].respond({ messages: rows(2), title: 'Home', agentTeammateKnown: true })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(pending).toHaveLength(2)
    await pending[1].respond({ messages: rows(4), title: 'Home', agentTeammateKnown: true })
    expect(chatMessages.map((m) => m.id)).toEqual(rows(4).map((m) => m.id))
    act(() => root!.unmount())
    root = undefined
    pending.length = 0
    await mount({ initialMessages: rows(2), initialConversationId: 'side-1', homeThreadId: 'home-1' })
    await pending[0].respond({ messages: rows(2), title: 'Side', agentTeammateKnown: true })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(pending).toHaveLength(1)
  })

  it('reports the home thread on screen with its newest message time, and clears it on leaving; a side chat is never reported', async () => {
    presence.reports.length = 0
    presence.clears = 0
    const at = (id: string, createdAt: string, role: 'user' | 'assistant') => ({ ...msg(id, role), metadata: { createdAt } }) as UIMessage
    const initial = [at('a', '2026-10-31T11:00:00.000Z', 'user'), at('b', '2026-10-31T11:01:00.000Z', 'assistant')]
    await mount({ initialMessages: initial, initialConversationId: 'home-1', homeThreadId: 'home-1' })
    await pending[0].respond({ messages: initial, title: 'Home', agentTeammateKnown: true })
    expect(presence.reports).toEqual([['home-1', Date.parse('2026-10-31T11:01:00.000Z')]])
    // A new message: the newer time replaces the old report.
    act(() => setMessages((prev) => [...prev, at('c', '2026-10-31T11:05:00.000Z', 'assistant')]))
    expect(presence.reports.at(-1)).toEqual(['home-1', Date.parse('2026-10-31T11:05:00.000Z')])
    expect(presence.clears).toBe(1)
    // A re-render with the same newest message reports nothing new.
    const count = presence.reports.length
    act(() => setMessages((prev) => [...prev]))
    expect(presence.reports).toHaveLength(count)
    act(() => root!.unmount())
    root = undefined
    expect(presence.clears).toBe(2)

    pending.length = 0
    presence.reports.length = 0
    seededWith = null
    await mount({ initialMessages: initial, initialConversationId: 'side-1', homeThreadId: 'home-1' })
    await pending[0].respond({ messages: initial, title: 'Side', agentTeammateKnown: true })
    expect(presence.reports).toEqual([])
  })

  it('a home window whose conversation moved to another eve session drops its handle on focus (A3 verification)', async () => {
    transportState.sessionId = 'wrun_old'
    transportState.resets.length = 0
    await mount({ initialMessages: rows(2), initialConversationId: 'home-1', homeThreadId: 'home-1' })
    await pending[0].respond({ messages: rows(2), title: 'Home', agentTeammateKnown: true, eveSessionId: 'wrun_old' })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    // Same session: nothing dropped.
    await pending[1].respond({ messages: rows(2), title: 'Home', agentTeammateKnown: true, eveSessionId: 'wrun_old' })
    expect(transportState.resets).toEqual([])
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await pending[2].respond({ messages: rows(2), title: 'Home', agentTeammateKnown: true, eveSessionId: 'wrun_new' })
    expect(transportState.resets).toEqual(['sess-restored'])
    transportState.sessionId = null
  })

  it('a surface turn sends only its words and cards: the composer’s draft stays (A3 verification)', async () => {
    const sent: unknown[][] = []
    transportState.sendMessage = (...args: unknown[]) => void sent.push(args)
    await mount({ initialMessages: rows(2) })
    await settle()
    const box = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'my own draft')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    let went = false
    await act(async () => {
      went = await panelRef.current!.sendFromSurface('Draft the reply', { cardIds: ['card-1'] })
    })
    await settle()
    expect(went).toBe(true)
    expect(sent).toHaveLength(1)
    const [message, options] = sent[0] as [{ text: string }, { body: { systemContext: Record<string, unknown> } }]
    expect(message.text).toBe('Draft the reply')
    expect(options.body.systemContext.aboutCardIds).toEqual(['card-1'])
    for (const key of [
      'attachedNoteIds',
      'attachedContactIds',
      'attachedCompanyIds',
      'attachedActionIds',
      'attachedDocumentIds',
      'attachedProjectIds',
      'attachedInitiativeIds',
      'editorSelection',
      'chatFiles',
      'voiceAsk',
    ]) {
      expect(options.body.systemContext).not.toHaveProperty(key)
    }
    expect(box.value).toBe('my own draft')
    transportState.sendMessage = () => {}
  })
})
