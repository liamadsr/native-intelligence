// @vitest-environment jsdom
/**
 * The "thinking" orb ChatPanel shows while a turn is in flight and nothing on
 * screen already indicates that.
 *
 * Two independent gaps this spec pins, both live-verified against the dev
 * server (2026-09-20):
 *
 *  1. Was gated on `status === 'submitted'` only, which the AI SDK sets just
 *     for the pre-first-chunk window; it flips to 'streaming' on the FIRST
 *     chunk (including a tool-call chunk) and stays 'streaming' for the rest
 *     of the turn. A multi-tool-call turn went dark for every gap AFTER the
 *     first tool — live-repro: "Get dashboard summary" (Done) → "Search
 *     workspace" (Done) → nothing on screen for several seconds while the
 *     model decided its next step, with the network stream still open.
 *  2. Was ALSO gated on `messages[messages.length - 1].role === 'user'` —
 *     true for an ordinary send, but FALSE for the answer-a-clarifying-
 *     question resume: `handleAnswerQuestion` never appends a new user
 *     message, it flips the existing `ask_user` tool part to
 *     `output-available` IN PLACE on the trailing ASSISTANT message, then
 *     resumes the same turn.
 *
 * See chat-panel.tsx's orb block for the fix and its full reasoning.
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
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 400,
})
window.HTMLElement.prototype.scrollIntoView = () => {}

let chatMessages: UIMessage[] = []
let chatStatus: 'ready' | 'submitted' | 'streaming' = 'ready'

vi.mock('@ai-sdk/react', () => ({
  // ChatPanel calls useChat({ messages: seedMessages, ... }) where seedMessages
  // is applyChatRetention(initialMessages) — NOT the ambient `chatMessages` this
  // spec sets before mount. Real useChat reads its `messages` option ONCE, at
  // Chat construction, and ignores it on later renders (see
  // chat-panel-retention.test.tsx's identical note) — so this mock must IGNORE
  // opts.messages entirely and always return the test's own chatMessages,
  // rather than let the (empty, since no `initialMessages` prop is passed)
  // seedMessages clobber it.
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: chatStatus,
    stop: vi.fn(),
    error: undefined,
    regenerate: vi.fn(),
  }),
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
// dependencies; the orb is a sibling of ChatMessageList in
// ChatPanel's own markup, so stubbing the list out doesn't touch it.
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
  // The chat's shared reads (skill commands, model settings) are per workspace.
  getClientWorkspaceId: () => 'ws-1',
}))

import { ChatPanel } from '../chat-panel'

const userMsg = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const assistantTextMsg = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as unknown as UIMessage

/** An assistant message whose only part is an ask_user tool call, in the given state. */
const askUserMsg = (
  id: string,
  state: 'input-streaming' | 'input-available' | 'output-available',
  output?: unknown,
): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask_user',
        toolCallId: `c-${id}`,
        state,
        input: {},
        ...(state === 'output-available' ? { output: output ?? { answers: { q: 'a' } } } : {}),
      },
    ],
  }) as unknown as UIMessage

/**
 * An assistant message with an EARLIER text part followed by TWO tool calls
 * that already completed (output-available) — the exact live-repro shape for
 * the gap AFTER a tool finishes and BEFORE the model's next chunk arrives.
 * The earlier text part is the trap: a `.some()`-over-every-part check finds
 * it and wrongly treats the message as "already showing text", which is what
 * hid the orb live. Only the TRAILING part (the second, completed tool)
 * should be consulted.
 */
const textThenTwoCompletedToolsMsg = (id: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      { type: 'text', text: "Got it — I'll wait for your pick." },
      {
        type: 'tool-get_dashboard_summary',
        toolCallId: `c-${id}-1`,
        state: 'output-available',
        input: {},
        output: {},
      },
      {
        type: 'tool-search',
        toolCallId: `c-${id}-2`,
        state: 'output-available',
        input: {},
        output: {},
      },
    ],
  }) as unknown as UIMessage

function orbEl(container: HTMLDivElement) {
  // The Loader's orb variant — matched by the wrapping div's class, not text
  // content (the orb itself is decorative/SVG-ish, no stable accessible name).
  return container.querySelector('.flex.items-center.gap-3.px-1')
}

describe('ChatPanel thinking orb', () => {
  let container: HTMLDivElement
  let root: Root

  async function mount() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatPanel, {
          chatSessionId: 'sess-orb',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
      await Promise.resolve()
    })
  }

  afterEach(() => {
    if (root) act(() => root.unmount())
    container?.remove()
    chatMessages = []
    chatStatus = 'ready'
  })

  it('shows while submitted after an ordinary user send (baseline, unchanged)', async () => {
    chatMessages = [userMsg('u1', 'hello')]
    chatStatus = 'submitted'
    await mount()
    expect(orbEl(container)).not.toBeNull()
  })

  it('does NOT show once ready (turn settled)', async () => {
    chatMessages = [userMsg('u1', 'hello'), assistantTextMsg('a1', 'hi there')]
    chatStatus = 'ready'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  it('shows after answering a clarifying question — trailing message is ASSISTANT with a resolved ask_user part', async () => {
    // This is handleAnswerQuestion's actual output shape: the ask_user part on
    // the last assistant message flips to output-available; no new message is
    // appended. The turn is then resumed, so status goes back to 'submitted'.
    chatMessages = [
      userMsg('u1', 'build a GTM'),
      askUserMsg('a1', 'output-available'),
    ]
    chatStatus = 'submitted'
    await mount()
    expect(orbEl(container)).not.toBeNull()
  })

  it('does NOT show while the trailing tool part is still actively running — its own card is the indicator', async () => {
    chatMessages = [userMsg('u1', 'search'), askUserMsg('a1', 'input-available')]
    chatStatus = 'submitted'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  it('does NOT show with an empty message list', async () => {
    chatMessages = []
    chatStatus = 'submitted'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  it('shows during status "streaming" in the gap AFTER a tool call completes — the SDK is past "submitted" for the rest of the turn', async () => {
    // Live repro: status is 'streaming' (not 'submitted') for this whole
    // window — it flips on the FIRST chunk of the turn, tool-call chunks
    // included, and never goes back to 'submitted' until the turn settles.
    chatMessages = [userMsg('u1', 'deep dive'), askUserMsg('a1', 'output-available')]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).not.toBeNull()
  })

  it('shows between two completed tool calls, ignoring an EARLIER text part on the same message — the exact live repro', async () => {
    chatMessages = [userMsg('u1', 'deep dive'), textThenTwoCompletedToolsMsg('a1')]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).not.toBeNull()
  })

  it('does NOT show while trailing text is actively streaming — new characters are themselves the "working" signal', async () => {
    chatMessages = [userMsg('u1', 'hello'), assistantTextMsg('a1', 'Working on it')]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  it('does NOT show while a SECOND tool call is actively running after a completed first one', async () => {
    chatMessages = [
      userMsg('u1', 'deep dive'),
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-get_dashboard_summary',
            toolCallId: 'c-a1-1',
            state: 'output-available',
            input: {},
            output: {},
          },
          {
            type: 'tool-search',
            toolCallId: 'c-a1-2',
            state: 'input-available',
            input: {},
          },
        ],
      } as unknown as UIMessage,
    ]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  const reasoningMsg = (id: string, text: string, state: 'streaming' | 'done'): UIMessage =>
    ({ id, role: 'assistant', parts: [{ type: 'reasoning', text, state }] }) as unknown as UIMessage

  it('does NOT show while trailing reasoning is streaming — its shimmering "Thinking" line is the indicator', async () => {
    chatMessages = [userMsg('u1', 'hello'), reasoningMsg('a1', 'Weighing the options.', 'streaming')]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).toBeNull()
  })

  it('shows for an empty streaming reasoning part (it renders nothing yet) and for a closed one (static)', async () => {
    chatMessages = [userMsg('u1', 'hello'), reasoningMsg('a1', '', 'streaming')]
    chatStatus = 'streaming'
    await mount()
    expect(orbEl(container)).not.toBeNull()
    act(() => root.unmount())
    container.remove()

    chatMessages = [userMsg('u1', 'hello'), reasoningMsg('a1', 'Done weighing.', 'done')]
    await mount()
    expect(orbEl(container)).not.toBeNull()
  })
})
