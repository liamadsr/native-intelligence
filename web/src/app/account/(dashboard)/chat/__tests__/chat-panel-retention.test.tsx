// @vitest-environment jsdom
/**
 * ChatPanel's LIVE message retention — the crux of the chat half of the
 * 2026-09 desktop heap fix (948MB WebContent after 7h, 1.82GB peak).
 *
 * The reducer-side cap (tab-chat-cap.test.ts) only fires on tab close /
 * workspace switch / pagehide, because dashboard-shell keeps a background
 * tab's panel MOUNTED (visibility:hidden + inert) rather than unmounting it.
 * Between those moments the only thing bounding what a tab holds in the heap is
 * the effect pinned here — so this spec mounts the real ChatPanel over a
 * stateful useChat stub and asserts on what actually lands in useChat state.
 *
 * The no-loop assertion is not incidental: the trim calls setMessages, whose
 * result feeds the same effect's deps. The real @ai-sdk/react setter always
 * stores a fresh copy, so reference equality can never stop that loop —
 * `applyChatRetention` being IDEMPOTENT is what does, and the stub below copies
 * on write precisely so this spec tests the real mechanism.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import {
  MAX_LIVE_MESSAGES,
  MAX_PART_CHARS,
  RECENT_MESSAGE_WINDOW,
  capMessages,
} from '@/lib/chat/message-retention'

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

// A stateful useChat: `setMessages` really updates the array the panel reads on
// the next render, so the trim effect runs against its own output — exactly the
// feedback loop that would hang if retention were not idempotent.
//
// The COPY on write is deliberate and matches the real thing. @ai-sdk/react's
// setter is `chatRef.current.messages = next`, and the ReactChatState setter
// behind it does `__privateSet(this, _messages, [...newMessages])` and notifies
// every subscriber — i.e. it ALWAYS hands back a fresh array, even for an
// unchanged one. A stub that preserved identity would make the effect look like
// it terminates on reference equality, which is not the mechanism: what stops
// it is `needsChatRetention` going false on the trimmed output. Copying here is
// what makes this spec able to catch a non-idempotent retention pass.
let chatMessages: UIMessage[] = []
let chatStatus: 'ready' | 'streaming' = 'ready'
let setMessagesCalls = 0
let rerender: (() => void) | null = null
let seededWith: UIMessage[] | null = null

/** A runaway trim would otherwise spin forever and hang the suite. */
const RUNAWAY_SET_MESSAGES = 25

const setMessages = vi.fn((updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
  setMessagesCalls += 1
  if (setMessagesCalls > RUNAWAY_SET_MESSAGES) {
    throw new Error(
      `setMessages called ${setMessagesCalls}x — the retention trim effect is not converging`,
    )
  }
  const next = typeof updater === 'function' ? updater(chatMessages) : updater
  chatMessages = [...next] // real setter semantics: always a fresh array
  rerender?.()
})

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages?: UIMessage[] }) => {
    // Real useChat reads `messages` ONCE, at Chat construction, and copies it.
    // A later render passing a different array is ignored — which is why
    // chat-panel bounds the seed at the seam rather than relying on the effect.
    if (seededWith === null) {
      seededWith = opts.messages ?? []
      chatMessages = [...seededWith]
    }
    return {
      messages: chatMessages,
      sendMessage: vi.fn(),
      setMessages,
      addToolResult: vi.fn(),
      status: chatStatus,
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
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
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

// The rendered list is pure presentation and drags in ChatMessage's
// dependencies; retention is about what's in useChat STATE, not what
// paints, so stub the list out.
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
}))

vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [],
  SlashCommandPicker: () => null,
}))

// workspace-fetch monkey-patches global fetch on import — stub it so the panel's
// incidental network calls never escape the test.
vi.mock('@/lib/workspace-fetch', () => ({
  workspaceFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  installWorkspaceFetch: () => {},
  // The chat's shared reads (skill commands, model settings) are per workspace.
  getClientWorkspaceId: () => 'ws-1',
}))

import { ChatPanel } from '../chat-panel'

const text = (id: string, role: 'user' | 'assistant'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as unknown as UIMessage

const toolMsg = (id: string, output: unknown): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool-search', toolCallId: `c-${id}`, state: 'output-available', input: {}, output }],
  }) as unknown as UIMessage

function conversation(n: number, prefix = 'm'): UIMessage[] {
  return Array.from({ length: n }, (_, i) =>
    text(`${prefix}${i}`, i % 2 === 0 ? 'user' : 'assistant'),
  )
}

describe('ChatPanel live message retention', () => {
  let container: HTMLDivElement
  let root: Root

  async function mount(initialMessages: UIMessage[]) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = () =>
      root.render(
        h(ChatPanel, {
          chatSessionId: 'sess-retain',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
          initialMessages,
        }),
      )
    rerender = () => act(() => render())
    await act(async () => {
      render()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    chatMessages = []
    chatStatus = 'ready'
    setMessagesCalls = 0
    seededWith = null
    setMessages.mockClear()
  })

  afterEach(() => {
    // The pure-helper specs below never mount, so the root may be absent.
    if (root) act(() => root.unmount())
    container?.remove()
    root = undefined as unknown as Root
    container = undefined as unknown as HTMLDivElement
    rerender = null
  })

  it('seeds useChat with a BOUNDED copy of a hydrated transcript', async () => {
    await mount(conversation(MAX_LIVE_MESSAGES + 150))
    expect(seededWith!.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    expect(seededWith![seededWith!.length - 1].id).toBe(`m${MAX_LIVE_MESSAGES + 149}`)
  })

  it('trims the live array when it grows past the cap, and then STOPS', async () => {
    await mount(conversation(10))
    // A long run appends past the cap without the panel remounting.
    await act(async () => {
      chatMessages = conversation(MAX_LIVE_MESSAGES + 80, 'g')
      rerender!()
      await Promise.resolve()
    })
    expect(chatMessages.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    expect(chatMessages[chatMessages.length - 1].id).toBe(`g${MAX_LIVE_MESSAGES + 79}`)

    // TERMINATION, asserted behaviourally rather than as an exact call count.
    // The real setter always stores a fresh copy and notifies, so the effect
    // necessarily re-runs on its own output at least once; what must hold is
    // that it CONVERGES — a bounded number of trims, then silence. (The
    // RUNAWAY_SET_MESSAGES guard in the stub turns a non-converging pass into a
    // thrown error instead of a hung suite.)
    expect(setMessagesCalls).toBeLessThanOrEqual(3)
    const callsAfterTrim = setMessagesCalls
    const settledIds = chatMessages.map((m) => m.id)
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        rerender!()
        await Promise.resolve()
      })
    }
    expect(setMessagesCalls).toBe(callsAfterTrim)
    expect(chatMessages.map((m) => m.id)).toEqual(settledIds)
  })

  it('never trims while a turn is in flight', async () => {
    await mount(conversation(10))
    await act(async () => {
      chatStatus = 'streaming'
      chatMessages = conversation(MAX_LIVE_MESSAGES + 80, 's')
      rerender!()
      await Promise.resolve()
    })
    expect(setMessagesCalls).toBe(0)
    expect(chatMessages.length).toBe(MAX_LIVE_MESSAGES + 80)
    // …and catches up once the turn settles.
    await act(async () => {
      chatStatus = 'ready'
      rerender!()
      await Promise.resolve()
    })
    expect(chatMessages.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
  })

  it('shrinks an oversized string tool output on an older message in place', async () => {
    const big = 'x'.repeat(MAX_PART_CHARS * 2)
    await mount(conversation(4))
    await act(async () => {
      chatMessages = [toolMsg('dump', big), ...conversation(RECENT_MESSAGE_WINDOW + 2, 't')]
      rerender!()
      await Promise.resolve()
    })
    const part = (chatMessages[0].parts as unknown as Array<Record<string, unknown>>)[0]
    expect((part.output as string).length).toBeLessThan(big.length)
    expect(part.output).toContain('full output is saved in chat history')
    expect(part.state).toBe('output-available')
    expect(part.toolCallId).toBe('c-dump')
  })

  it('leaves a short, small conversation completely alone', async () => {
    await mount(conversation(12))
    await act(async () => {
      rerender!()
      await Promise.resolve()
    })
    expect(setMessagesCalls).toBe(0)
  })

  // The live-capture / ambient-agent tab is assistant-only for the entire
  // meeting (conversation-writer.ts emits only assistant rows). Before the
  // two-sided findTrimStart this shape was the one tab the cap never touched.
  it('trims an ASSISTANT-ONLY live transcript (the capture tab shape)', async () => {
    await mount(conversation(4))
    await act(async () => {
      chatMessages = Array.from({ length: MAX_LIVE_MESSAGES + 400 }, (_, i) =>
        text(`live${i}`, 'assistant'),
      )
      rerender!()
      await Promise.resolve()
    })
    expect(chatMessages.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    expect(chatMessages[chatMessages.length - 1].id).toBe(`live${MAX_LIVE_MESSAGES + 399}`)
    expect(setMessagesCalls).toBeLessThanOrEqual(3)
  })

  // The unbounded growth this whole module exists to stop is worth asserting
  // directly on the helper too, independent of the panel's wiring: a short
  // transcript must come back by REFERENCE at every length, or the effect below
  // would setMessages on every render.
  it('capMessages is a strict no-op below the cap, at every length', () => {
    for (const n of [1, 2, 5, 12, MAX_LIVE_MESSAGES - 1, MAX_LIVE_MESSAGES]) {
      const msgs = conversation(n, 'q')
      expect(capMessages(msgs)).toBe(msgs)
    }
    const assistantOnly = Array.from({ length: 12 }, (_, i) => text(`a${i}`, 'assistant'))
    expect(capMessages(assistantOnly)).toBe(assistantOnly)
  })
})
