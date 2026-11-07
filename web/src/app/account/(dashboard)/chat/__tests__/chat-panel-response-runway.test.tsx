// @vitest-environment jsdom
/**
 * The response runway — `.chat-response-runway`, a `max(160px, 100dvh - 340px)`
 * spacer rendered while `responseRunwayActive` is true — reserves scroll room
 * below a freshly submitted turn so a one-line reply doesn't jump straight to
 * the top of the viewport while it streams in.
 *
 * Bug this spec pins (live-verified against the dev server, 2026-09-20):
 * NOTHING ever cleared `responseRunwayActive` back to false once ITS OWN turn
 * settled — only `handleNewChat` and `handleLoadConversation` cleared it, and
 * both are for switching to a DIFFERENT conversation. So once any turn
 * completed in a ChatPanel's lifetime, the runway spacer stayed mounted
 * forever after: a short, already-finished conversation renders with a huge
 * dead gap below it (the reserved viewport-height spacer) instead of settling
 * to the bottom above the composer. Screenshot: a two-message "complete ✅"
 * exchange pinned near the top with the rest of the panel empty.
 *
 * The fix (chat-panel.tsx, next to the runway state) retires the runway once
 * `status` returns to 'ready' or 'error' — whichever way the turn that armed
 * it finishes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
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

let chatMessages: UIMessage[] = []
let chatStatus: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready'
const sendMessage = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  // See chat-panel-thinking-orb.test.tsx's identical note: useChat reads its
  // `messages` option ONCE at construction, so this mock must ignore
  // opts.messages and always return the test's own mutable chatMessages.
  useChat: () => ({
    messages: chatMessages,
    sendMessage,
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

import { ChatPanel, type ChatPanelHandle, type ProposalChatContext } from '../chat-panel'

const userMsg = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const assistantTextMsg = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const PROPOSAL: ProposalChatContext = {
  captureId: 'cap-1',
  proposalId: 'prop-1',
  displayText: 'Follow up with the investor list',
  description: null,
  reasoning: null,
  triggerQuote: null,
  changeType: 'action',
  entityType: 'action',
}

function runwayEl(container: HTMLDivElement) {
  return container.querySelector('[data-chat-response-runway]')
}

describe('ChatPanel response runway', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  let rerender: (() => void) | null = null

  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = () =>
      root.render(
        h(ChatPanel, {
          ref,
          chatSessionId: 'sess-runway',
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
    rerender = () => act(() => render())
    await act(async () => {
      render()
      await Promise.resolve()
    })
  }

  afterEach(() => {
    if (root) act(() => root.unmount())
    container?.remove()
    chatMessages = []
    chatStatus = 'ready'
    sendMessage.mockClear()
    rerender = null
  })

  it('is absent before any turn is armed', async () => {
    chatMessages = [userMsg('u1', 'hi'), assistantTextMsg('a1', 'hello')]
    chatStatus = 'ready'
    await mount()
    expect(runwayEl(container)).toBeNull()
  })

  it('mounts once a turn is armed (submitted) and clears once it settles back to ready — WITHOUT switching conversations', async () => {
    chatMessages = [userMsg('u1', 'hi'), assistantTextMsg('a1', 'hello')]
    chatStatus = 'ready'
    await mount()
    expect(runwayEl(container)).toBeNull()

    // Arm a turn via the imperative handle — chatAboutProposal calls
    // prepareForResponse() synchronously (unlike startProspecting, it has no
    // async skill lookup in front of it), so this is the closest real trigger
    // to a normal send without reimplementing the composer's submit handler.
    chatStatus = 'submitted'
    await act(async () => {
      ref.current!.chatAboutProposal(PROPOSAL)
      await Promise.resolve()
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(runwayEl(container)).not.toBeNull()

    // The turn settles — same conversation, no handleNewChat, no
    // handleLoadConversation. Before the fix, nothing cleared the runway here.
    chatStatus = 'ready'
    rerender!()
    expect(runwayEl(container)).toBeNull()
  })

  it('also clears on a turn that ends in error, not just ready', async () => {
    chatMessages = [userMsg('u1', 'hi'), assistantTextMsg('a1', 'hello')]
    chatStatus = 'ready'
    await mount()

    chatStatus = 'submitted'
    await act(async () => {
      ref.current!.chatAboutProposal(PROPOSAL)
      await Promise.resolve()
    })
    expect(runwayEl(container)).not.toBeNull()

    chatStatus = 'error'
    rerender!()
    expect(runwayEl(container)).toBeNull()
  })

  it('stays mounted through the whole "streaming" phase, not just "submitted"', async () => {
    chatMessages = [userMsg('u1', 'hi'), assistantTextMsg('a1', 'hello')]
    chatStatus = 'ready'
    await mount()

    chatStatus = 'submitted'
    await act(async () => {
      ref.current!.chatAboutProposal(PROPOSAL)
      await Promise.resolve()
    })
    expect(runwayEl(container)).not.toBeNull()

    chatStatus = 'streaming'
    rerender!()
    expect(runwayEl(container)).not.toBeNull()

    chatStatus = 'ready'
    rerender!()
    expect(runwayEl(container)).toBeNull()
  })
})
