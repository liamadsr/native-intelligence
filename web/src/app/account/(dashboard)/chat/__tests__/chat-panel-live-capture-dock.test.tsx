// @vitest-environment jsdom
/**
 * The live capture's card in the real ChatPanel, beside its notepad
 * (chat/live-capture-dock.tsx): while the capture records, the card opened
 * for it (the recording bridge's delivery, "Recording ←", a live meeting's
 * thread) docks instead of going full screen, its opened-card message joining
 * the thread as any; "Recording ←" brings back the one there; a chat the dock is
 * beside with no card of the capture gets one; the capture ending lets the
 * card go, the page visited last (kept mounted). A capture that isn't
 * recording opens like any page.
 *
 * Over the same stateful useChat stub as chat-panel-open-page.test.tsx.
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
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
window.HTMLElement.prototype.scrollIntoView = () => {}

const env = vi.hoisted(() => ({
  messages: [] as unknown[],
  status: 'ready' as 'ready' | 'streaming',
  seeded: false,
  rerender: null as null | (() => void),
  transportOptions: null as null | {
    getCardContext?: () => unknown[]
    getPendingConversation?: () => Promise<string | null> | null
  },
  /** The transport's turnPersisted, as a test scripts it (absent: settled at once). */
  turnPersisted: null as null | ((chatId: string) => Promise<void>),
  prewarms: [] as string[],
  edition: null as unknown,
  /** The panel's card store, as the message list reads it (the card host). */
  store: null as null | import('@/components/chat-cards/card-store').ChatCardStore,
}))
const sendMessage = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages?: unknown[] }) => {
    if (!env.seeded) {
      env.seeded = true
      env.messages = [...(opts.messages ?? [])]
    }
    return {
      messages: env.messages,
      sendMessage,
      setMessages: (next: unknown[] | ((prev: unknown[]) => unknown[])) => {
        env.messages = [...(typeof next === 'function' ? next(env.messages) : next)]
        env.rerender?.()
      },
      addToolResult: vi.fn(),
      status: env.status,
      stop: vi.fn(),
      error: undefined,
      regenerate: vi.fn(),
    }
  },
}))

// The transport: what a send would read, and nothing that could reach eve.
vi.mock('@/lib/chat/eve/eve-chat-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/eve/eve-chat-transport')>()),
  EveChatTransport: class {
    constructor(options: typeof env.transportOptions) {
      env.transportOptions = options
      return new Proxy(this, {
        get: (target, key) => {
          if (key === 'turnPersisted') return (chatId: string) => env.turnPersisted?.(chatId) ?? Promise.resolve()
          if (key === 'prewarm') return (chatId: string) => void env.prewarms.push(chatId)
          return key in target ? (target as never)[key] : () => undefined
        },
      })
    }
  },
}))

// The chat-agent's numbering state: a fresh session, as after a reload.
vi.mock('eve/context', () => ({
  defineState: <T,>(_name: string, initial: () => T) => {
    let state = initial()
    return { get: () => state, update: (fn: (prev: T) => T) => void (state = fn(state)) }
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
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({ flushTranscriptForAgent: async () => {}, getSegmentsForAgent: () => [] }),
}))
// The kept-card host mounts the opened cards (the message list may not
// mount at all with only those): it hands over the panel's store too.
vi.mock('../kept-card-host', () => ({
  KeptCardHost: (props: { store: import('@/components/chat-cards/card-store').ChatCardStore }) => {
    env.store = props.store
    return null
  },
}))
vi.mock('../chat-message-list', async () => {
  const { useChatCardHost } = await import('@/components/chat-cards/card-host')
  return {
  ChatMessageList: () => {
    env.store = useChatCardHost().store ?? null
    return null
  },
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
  }
})
vi.mock('@/lib/workspace-fetch', () => ({
  workspaceFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  installWorkspaceFetch: () => {},
  getClientWorkspaceId: () => 'ws-1',
}))
vi.mock('../../../workspace-switcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspaceEdition: () => env.edition,
}))


import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { createRef } from 'react'
import { getEdition } from '@/lib/editions/manifest'
import { openedCardFromPart } from '@/lib/chat-cards/opened-card'
import { cardForTarget } from '@/lib/chat-cards/open-card'
import { LiveCaptureDockSlotProvider, type LiveCaptureDockSlot } from '@/components/chat-cards/card-dock-slot'

const CAPTURE = cardForTarget({ type: 'capture', id: 'cap-1', title: 'Capture Oct 9' })!
const OTHER = cardForTarget({ type: 'capture', id: 'cap-old', title: 'Yesterday' })!

describe('ChatPanel: the live capture’s card docks', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  let slot: LiveCaptureDockSlot | null = null

  const dockSlot = (extra: Partial<LiveCaptureDockSlot> = {}): LiveCaptureDockSlot => ({
    captureId: 'cap-1',
    body: null,
    ending: false,
    attach: () => () => {},
    ...extra,
  })

  async function mount(initialSlot: LiveCaptureDockSlot | null) {
    slot = initialSlot
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = () =>
      root.render(
        h(LiveCaptureDockSlotProvider, {
          value: slot,
          children: h(ChatPanel, { ref, chatSessionId: 'sess-dock', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true }),
        }),
      )
    env.rerender = () => act(() => render())
    await act(async () => {
      render()
      await Promise.resolve()
    })
  }
  async function setSlot(next: LiveCaptureDockSlot | null) {
    slot = next
    await act(async () => {
      env.rerender?.()
      await Promise.resolve()
    })
  }
  async function wait(ms: number) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms))
    })
  }

  const openedCards = () =>
    (env.messages as UIMessage[]).flatMap((m) => m.parts.map(openedCardFromPart).filter((c): c is NonNullable<typeof c> => !!c))
  const store = () => env.store!

  beforeEach(() => {
    env.messages = []
    env.status = 'ready'
    env.seeded = false
    env.transportOptions = null
    env.turnPersisted = null
    env.prewarms = []
    env.edition = getEdition('full')
    env.store = null
    sendMessage.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/account/chat-history' && init?.method === 'POST') return new Response(JSON.stringify({ conversationId: 'conv-1' }))
        return new Response('{}')
      }),
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    env.rerender = null
    vi.unstubAllGlobals()
  })

  it('starting a capture docks its card rather than taking it full screen', async () => {
    await mount(dockSlot())
    await act(async () => ref.current!.openCard({ spec: CAPTURE.spec, from: 'capture' }))
    const cards = openedCards()
    // Its opened-card message joins the thread as today (the cards note, the history).
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toEqual(CAPTURE.spec)
    expect(store().fullScreen()).toBeNull()
    expect(store().docked()).toBe(cards[0].id)
    expect(store().keptPages().map((c) => c.id)).not.toContain(cards[0].id)
    // The sync check after a moment finds it: still one card.
    await wait(450)
    expect(openedCards()).toHaveLength(1)
  })

  it('keeps the card docked when it is asked for again ("Recording ←"): no second card, no full screen', async () => {
    await mount(dockSlot())
    await act(async () => ref.current!.openCard({ spec: CAPTURE.spec, from: 'capture' }))
    await act(async () => ref.current!.openCard({ spec: CAPTURE.spec, from: 'capture', reuse: true }))
    expect(openedCards()).toHaveLength(1)
    expect(store().fullScreen()).toBeNull()
    expect(store().docked()).toBe(openedCards()[0].id)
  })

  it('opens a capture that is not recording like any page', async () => {
    await mount(dockSlot())
    await act(async () => ref.current!.openCard({ spec: OTHER.spec, from: 'chip' }))
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(store().fullScreen()).toBe(cards[0].id)
    expect(store().docked()).toBeNull()
  })

  it('opens the live capture full screen where no dock is beside the chat', async () => {
    await mount(null)
    await act(async () => ref.current!.openCard({ spec: CAPTURE.spec, from: 'capture' }))
    expect(store().fullScreen()).toBe(openedCards()[0].id)
    expect(store().docked()).toBeNull()
  })

  it('gives a chat the dock is beside a card of the capture when it has none', async () => {
    await mount(dockSlot())
    expect(openedCards()).toHaveLength(0)
    await wait(450)
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(store().docked()).toBe(cards[0].id)
    expect(store().fullScreen()).toBeNull()
  })

  it('lets the card go when the capture ends: the page visited last, kept mounted, the dock gone', async () => {
    await mount(dockSlot())
    await act(async () => ref.current!.openCard({ spec: CAPTURE.spec, from: 'capture' }))
    const id = openedCards()[0].id
    await setSlot(dockSlot({ ending: true }))
    expect(store().docked()).toBeNull()
    expect(store().openedByVisit().at(-1)?.id).toBe(id)
    expect(store().keptPages().map((c) => c.id)).toContain(id)
    await setSlot(null)
    expect(store().docked()).toBeNull()
    expect(store().fullScreen()).toBeNull()
  })
})
