// @vitest-environment jsdom
/**
 * `/compact` in the composer (Liam, 10-22: the Context panel "with an option to
 * compact on command"): typed on its own, it compacts the conversation now
 * (lib/chat/context-client.ts compactChatContext, the side panel's Compact
 * now) and is never sent to the agent.
 *
 * Pinned here:
 *   • `/compact` compacts the bound conversation, clears the box, sends nothing,
 *     and says what happened in a toast;
 *   • with no conversation yet, it says there's nothing to compact;
 *   • an armed sticky skill doesn't swallow it, and stays armed for the next turn;
 *   • `/compact` with more words is an ordinary message.
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

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage,
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: 'ready',
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

vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

/** The sticky prospect-list skill (askAboutList arms it), as chat-panel-sticky-skill.test.tsx has it. */
const PROSPECT_LIST_SKILL = {
  id: 'skill-prospect-list',
  slug: 'build-prospect-list',
  name: 'Build a prospect list',
  icon: null,
  color: null,
  description: null,
  views_context: null,
}
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [PROSPECT_LIST_SKILL],
  SlashCommandPicker: () => null,
}))

const m = vi.hoisted(() => ({
  compact: vi.fn(async (_id: string) => ({ text: 'Compacted. The next message starts from a summary.', tone: 'muted' as const })),
  toast: Object.assign(vi.fn(), { loading: vi.fn(() => 't-1'), success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/chat/context-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/context-client')>()),
  compactChatContext: m.compact,
}))
vi.mock('sonner', () => ({ toast: m.toast }))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import type { ProspectingAskDetail } from '../../prospecting/start-event'

const ASK: ProspectingAskDetail = { listId: 'list-1', listName: 'Series A fintech', selectedCount: 3 }

describe('ChatPanel /compact', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  async function mount(props: Record<string, unknown> = {}) {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(h(ChatPanel, { ref, chatSessionId: 'sess-compact', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true, ...props }))
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

  async function submit() {
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    sendMessage.mockClear()
    m.compact.mockClear()
    m.toast.mockClear()
    m.toast.loading.mockClear()
    m.toast.success.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'stop' }) })))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('compacts the conversation, clears the box, sends nothing, and says so', async () => {
    await mount({ initialConversationId: 'conv-1' })
    await type(' /compact ')
    await submit()
    expect(m.compact).toHaveBeenCalledWith('conv-1')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(textarea().value).toBe('')
    expect(m.toast.loading).toHaveBeenCalledWith('Compacting the conversation…')
    await act(async () => {
      await Promise.resolve()
    })
    expect(m.toast.success).toHaveBeenCalledWith('Compacted. The next message starts from a summary.', { id: 't-1' })
  })

  it('with no conversation yet, there is nothing to compact', async () => {
    await mount()
    await type('/compact')
    await submit()
    expect(m.compact).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(m.toast).toHaveBeenCalledWith('Nothing to compact yet.')
  })

  it('an armed sticky skill does not swallow it, and stays armed for the next turn', async () => {
    await mount({ initialConversationId: 'conv-1' })
    await act(async () => {
      await ref.current!.askAboutList(ASK)
    })
    await type('/compact')
    await submit()
    expect(m.compact).toHaveBeenCalledWith('conv-1')
    expect(sendMessage).not.toHaveBeenCalled()
    await type('research these')
    await submit()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBe('skill-prospect-list')
  })

  it('/compact with more words is an ordinary message', async () => {
    await mount({ initialConversationId: 'conv-1' })
    await type('/compact the notes from Monday')
    await submit()
    expect(m.compact).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
