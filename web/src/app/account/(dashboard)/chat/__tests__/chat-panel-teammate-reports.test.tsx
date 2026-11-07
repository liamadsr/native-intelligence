// @vitest-environment jsdom
/**
 * The main chat hears back from the teammates it delegated to (bots v2,
 * phase 7). When a delegated run settles, the server appends the teammate's
 * report to the conversation (src/lib/work/chat-report.ts); the open panel
 * takes it over Realtime: an ordinary chat subscribes to its OWN conversation
 * for teammate reports only. Pinned on the real ChatPanel over a stateful
 * useChat stub (the harness of chat-panel-restored-catch-up):
 *   • a report inserted into the open conversation shows after its messages;
 *   • the conversation's other rows (its own turns' stored copies) do not;
 *   • the live-capture and home conversations keep the full bridge.
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

// The Realtime bridge: every channel the panel opens, with its handlers.
const realtime = vi.hoisted(() => ({
  channels: [] as Array<{ name: string; handlers: Array<{ event: string; handler: (p: { new: unknown }) => void }> }>,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: (name: string) => {
      const entry = { name, handlers: [] as Array<{ event: string; handler: (p: { new: unknown }) => void }> }
      realtime.channels.push(entry)
      const ch: Record<string, unknown> = {}
      ch.on = (_type: string, cfg: { event: string }, handler: (p: { new: unknown }) => void) => {
        entry.handlers.push({ event: cfg.event, handler })
        return ch
      }
      ch.subscribe = () => ch
      return ch
    },
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

import { ChatPanel } from '../chat-panel'

const msg = (id: string, role: 'user' | 'assistant' = 'user'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage

const fetchMock = vi.fn()

beforeEach(() => {
  chatMessages = []
  seededWith = null
  setMessages.mockClear()
  realtime.channels = []
  fetchMock.mockReset()
  // The restored chat's catch-up read finds exactly what the panel holds.
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ messages: chatMessages }) }))
  globalThis.fetch = fetchMock as never
})

let container: HTMLDivElement
let root: Root | undefined

async function mount(props: { initialMessages?: UIMessage[]; initialConversationId?: string; homeConversationId?: string }) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  const render = () =>
    r.render(
      h(ChatPanel, {
        chatSessionId: 'sess-reports',
        userAvatarUrl: null,
        userInitials: 'LA',
        alwaysShowMessages: true,
        ...props,
      }),
    )
  rerender = () => act(() => render())
  await act(async () => {
    render()
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  rerender = null
})

/** A channel's topic without the hook instance's suffix (`…:<uuid>`, one channel per panel). */
const topic = (name: string) => name.replace(/:[0-9a-f-]{36}$/, '')
const insertInto = (name: string, row: unknown) => {
  const channel = realtime.channels.find((c) => topic(c.name) === name)
  if (!channel) throw new Error(`no channel ${name}: ${realtime.channels.map((c) => c.name).join(', ')}`)
  act(() => {
    for (const h of channel.handlers) if (h.event === 'INSERT') h.handler({ new: row })
  })
}

const reportRow = {
  ui_message: {
    id: 'teammate-report-run-1-needs_review',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Quill finished **Q3 recap** — ready for your review.' },
      { type: 'data-teammate-report', data: { work_item_id: 'item-1', workspace_id: 'ws-1', status: 'needs_review', title: 'Q3 recap' } },
    ],
    metadata: { eve_written: true, kind: 'teammate_report' },
  },
}

describe('ChatPanel — a teammate reports back in the open chat', () => {
  it('shows a report inserted into its own conversation, after the thread', async () => {
    const thread = [msg('u1'), msg('a1', 'assistant')]
    await mount({ initialMessages: thread, initialConversationId: 'conv-1' })
    const reports = realtime.channels.filter((c) => topic(c.name) === 'server-turns:conv-1')
    expect(reports).toHaveLength(1)
    // The topic carries this panel's own suffix, so a second panel never shares it.
    expect(reports[0].name).toMatch(/^server-turns:conv-1:[0-9a-f-]{36}$/)
    // The main chat is the home thread (one chat): it takes the server-written
    // rows ('server-turns'), only ever inserted, so no UPDATE listener.
    expect(reports[0].handlers.map((h) => h.event)).toEqual(['INSERT'])

    insertInto('server-turns:conv-1', reportRow)
    expect(chatMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'teammate-report-run-1-needs_review'])
  })

  it('leaves the conversation\'s other rows alone: its own turns are already in the panel', async () => {
    const thread = [msg('u1'), msg('a1', 'assistant')]
    await mount({ initialMessages: thread, initialConversationId: 'conv-1' })
    insertInto('server-turns:conv-1', { ui_message: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'stored copy' }], metadata: { eve_written: true } } })
    insertInto('server-turns:conv-1', { ui_message: { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'x' }] } })
    expect(chatMessages).toEqual(thread)
  })

  it('a chat with no conversation yet listens to nothing', async () => {
    await mount({ initialMessages: [] })
    expect(realtime.channels).toHaveLength(0)
  })

  it('the home conversation keeps the full bridge (every server-written row)', async () => {
    await mount({ initialMessages: [], initialConversationId: 'conv-home', homeConversationId: 'conv-home' })
    expect(realtime.channels.map((c) => topic(c.name))).toEqual(['live-convo:conv-home'])
    expect(realtime.channels[0].handlers.map((h) => h.event)).toEqual(['INSERT', 'UPDATE'])
  })
})
