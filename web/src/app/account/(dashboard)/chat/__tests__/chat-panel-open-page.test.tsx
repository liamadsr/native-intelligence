// @vitest-environment jsdom
/**
 * The instant `/` path in the real ChatPanel (docs/plans/one-agent-and-chat-pages.md,
 * Part 2): picking a page puts its card in the chat at once, FULL SCREEN, with
 * no model call and no eve turn; the card is saved like any message and comes
 * back after a reload; it takes the next card number; the next turn carries
 * it, so the agent's cards note names it once and its next `show` numbers past
 * it. Picking the same page again brings its card back rather than a second.
 * And skills picked from the same menu still arm the turn.
 *
 * P5, every way in opens a card: `openCard` (what a chip, a notification, a
 * bot's Open, a desktop event or a deep link delivers through the tabs
 * provider) puts the card in the chat the same way and takes it FULL SCREEN
 * at once; `reuse` brings back the card already showing that place; one
 * opened while a turn is out is full screen over the chat at once and joins
 * the thread when the turn settles; a fold puts matching cards back.
 *
 * Over a stateful useChat stub (setMessages really changes what the panel
 * reads) and a stub transport that records what a send would read.
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

// The `/` menu as buttons: one per page the composer offers, one per skill.
const SCOUT = { id: 'skill-scout', slug: 'scout', name: 'Scout', icon: null, color: null, description: null, views_context: null }
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [SCOUT],
  SlashCommandPicker: (props: { open: boolean; pages?: Array<{ slug: string }>; onSelectPage?: (p: unknown) => void; onSelect: (s: unknown) => void }) =>
    props.open
      ? h(
          'div',
          { 'data-slash-menu': '' },
          ...(props.pages ?? []).map((p) => h('button', { key: p.slug, 'data-page': p.slug, onClick: () => props.onSelectPage?.(p) })),
          h('button', { 'data-skill': 'scout', onClick: () => props.onSelect(SCOUT) }),
        )
      : null,
}))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { createRef } from 'react'
import { pageOfCard } from '../../rail/rail-pages'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { openedCardFromPart, isOpenedCardMessage } from '@/lib/chat-cards/opened-card'
import { parseCardContext, renderCardsSection } from '@/lib/chat-cards/context'
import { highestCardNumber, stampCardNumber } from '../../../../../../agents/chat-agent/lib/card-numbers'
import { cardForTarget, foldCards } from '@/lib/chat-cards/open-card'
import { COMPOSER_RESERVE_VAR, holdFrontCard } from '@/components/chat-cards/front-card'

const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []

function showMessage(id: string, n: number): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'show',
        toolCallId: `call_${n}`,
        state: 'output-available',
        input: {},
        output: { success: true, card: { kind: 'list', title: `Card ${n}`, entity_type: 'action', filters: [] }, count: 1, card_number: n },
      },
    ],
  } as unknown as UIMessage
}

describe('ChatPanel: pages from /', () => {
  let container: HTMLDivElement
  let root: Root

  let ref: React.RefObject<ChatPanelHandle | null>
  let props: Record<string, unknown> = {}

  async function mount(initial: Record<string, unknown> = {}) {
    ref = createRef<ChatPanelHandle>()
    props = initial
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = () =>
      root.render(h(ChatPanel, { ref, chatSessionId: 'sess-pages', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true, ...props }))
    env.rerender = () => act(() => render())
    await act(async () => {
      render()
      await Promise.resolve()
    })
  }

  function unmount() {
    act(() => root.unmount())
    container.remove()
    env.rerender = null
  }

  /** `/` pressed outside any text field: the global palette (a `/` typed in the box is only a character). */
  async function openMenu() {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    })
  }

  async function pickPage(slug: string) {
    await openMenu()
    const button = container.querySelector(`[data-page="${slug}"]`) as HTMLButtonElement | null
    expect(button, `page /${slug} in the menu`).not.toBeNull()
    await act(async () => {
      button!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  const openedCards = () =>
    (env.messages as UIMessage[]).flatMap((m) => m.parts.map(openedCardFromPart).filter((c): c is NonNullable<typeof c> => !!c))
  const turnCards = () => env.transportOptions!.getCardContext!()

  beforeEach(() => {
    env.messages = []
    env.status = 'ready'
    env.seeded = false
    env.transportOptions = null
    env.turnPersisted = null
    env.prewarms = []
    env.edition = getEdition('full')
    sendMessage.mockClear()
    fetchCalls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url === '/api/account/chat-history' && init?.method === 'POST') return new Response(JSON.stringify({ conversationId: 'conv-1' }))
        return new Response('{}')
      }),
    )
  })
  afterEach(() => {
    if (root) unmount()
    vi.unstubAllGlobals()
  })

  it('puts the page’s card in the chat at once, with no model call and no eve turn', async () => {
    await mount()
    await pickPage('actions')

    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ kind: 'list', title: 'My actions', entity_type: 'action' })
    expect(cards[0].number).toBe(1)
    expect(isOpenedCardMessage((env.messages as UIMessage[])[0])).toBe(true)
    // Full screen at once, as every way in opens a page.
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    // Nothing was sent: no turn, no eve, no model.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(fetchCalls.filter((c) => /eve|chat-run|\/api\/ai\//.test(c.url))).toEqual([])
    // The `/` it was picked with left the draft.
    expect(container.querySelector('textarea')!.value).toBe('')
  })

  it('a chat holding only pages the person opened still rotates its starters in the composer (the pages never draw in the column)', async () => {
    await mount()
    expect(container.querySelector('[data-composer-suggestions]')).not.toBeNull()
    await pickPage('actions')
    expect(openedCards()).toHaveLength(1)
    expect(container.querySelector('[data-composer-suggestions]')).not.toBeNull()
    // The stage a browser card's full screen draws on stands without messages too.
    expect(container.querySelector('[data-chat-card-stage]')).not.toBeNull()
  })

  it('the flush (what pagehide writes) carries the page at once, so a reload mounts with it', async () => {
    await mount()
    await pickPage('actions')
    const first = ref.current!.flushSnapshot()
    expect(first.chatSessionId).toBe('sess-pages')
    expect(first.chatMessages.some((m) => isOpenedCardMessage(m))).toBe(true)
    // And for a page opened while a turn was out, once it joins the thread.
    env.status = 'streaming'
    env.rerender!()
    await pickPage('captures')
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(ref.current!.flushSnapshot().chatMessages.filter((m) => isOpenedCardMessage(m))).toHaveLength(2)
  })

  it('saves it like any message, and it comes back after a reload', async () => {
    await mount()
    await pickPage('contacts')
    const save = fetchCalls.find((c) => c.url === '/api/account/chat-history' && c.method === 'POST')
    expect(save, 'a new chat creates its conversation with the card').toBeDefined()
    const saved = (save!.body as { messages: UIMessage[] }).messages
    expect(saved).toHaveLength(1)
    expect(openedCardFromPart(saved[0].parts[0])?.spec).toMatchObject({ entity_type: 'contact' })

    // A reload: the thread as the conversation's rows hold it.
    unmount()
    env.seeded = false
    await mount({ initialMessages: JSON.parse(JSON.stringify(saved)), initialConversationId: 'conv-1' })
    expect(turnCards()).toEqual([expect.objectContaining({ n: 1, u: true, entity: 'contact' })])

    // Bound to its conversation, the next page goes onto it.
    await pickPage('actions')
    const patch = fetchCalls.find((c) => c.url === '/api/account/chat-history/conv-1' && c.method === 'PATCH')
    expect((patch!.body as { messages: UIMessage[] }).messages.map((m) => openedCardFromPart(m.parts[0])?.number)).toEqual([2])
  })

  it('takes the next card number after the agent’s, and the next turn carries it once', async () => {
    await mount({ initialMessages: [showMessage('a1', 1), showMessage('a2', 2)] })
    await pickPage('actions')
    expect(openedCards()[0].number).toBe(3)

    const entries = turnCards()
    expect(entries.find((e) => (e as { n: number }).n === 3)).toMatchObject({ u: true, title: 'My actions' })
    // The note names the person's card once, and leaves the agent's untouched ones out.
    const note = renderCardsSection(parseCardContext(entries))!
    expect(note.match(/card 3 /g)).toHaveLength(1)
    expect(note).toContain('you opened it')
    expect(note).not.toContain('card 1 ')
    // The agent's next show numbers past it.
    expect(stampCardNumber({ success: true }, 'call_next', highestCardNumber(entries))).toMatchObject({ card_number: 4 })
  })

  it('picked during a turn: full screen at once, in the thread once the turn settles', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)] })
    env.status = 'streaming'
    env.rerender!()
    await pickPage('captures')
    expect(openedCards()).toHaveLength(0)
    expect(env.store!.card(env.store!.fullScreen()!)?.spec).toMatchObject({ title: 'Captures' })
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await Promise.resolve()
    })
    expect(openedCards()).toEqual([expect.objectContaining({ number: 2 })])
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('lists only the pages that are on in the workspace', async () => {
    env.edition = withEffectiveSurface(getEdition('full'), { crm: 'off', sequences: 'off', prospecting: 'off' })
    await mount()
    await openMenu()
    expect(container.querySelector('[data-page="contacts"]')).toBeNull()
    expect(container.querySelector('[data-page="actions"]')).not.toBeNull()
  })

  it('still arms a skill picked from the same menu', async () => {
    await mount()
    await openMenu()
    await act(async () => {
      ;(container.querySelector('[data-skill="scout"]') as HTMLButtonElement).click()
    })
    const textarea = container.querySelector('textarea')!
    expect(textarea.value).toBe('/scout ')
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1].body.skillId).toBe('skill-scout')
    expect(openedCards()).toHaveLength(0)
  })

  it('saves a card picked during a turn only after that turn’s own rows are written', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)], initialConversationId: 'conv-1' })
    let release!: () => void
    env.turnPersisted = () => new Promise<void>((r) => (release = r))
    env.status = 'streaming'
    env.rerender!()
    await pickPage('captures')
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await new Promise((r) => setTimeout(r, 0))
    })
    // On screen at once, but not saved while the reply's write is out.
    expect(openedCards()).toHaveLength(1)
    const saves = () => fetchCalls.filter((c) => c.url === '/api/account/chat-history/conv-1' && c.method === 'PATCH')
    expect(saves()).toHaveLength(0)
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saves().map((c) => (c.body as { messages: UIMessage[] }).messages.map((m) => openedCardFromPart(m.parts[0])?.number))).toEqual([[2]])
  })

  it('numbers two pages picked during one turn one after the other', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)] })
    env.status = 'streaming'
    env.rerender!()
    await pickPage('captures')
    await pickPage('actions')
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(openedCards().map((c) => [c.spec.title, c.number])).toEqual([
      ['Captures', 2],
      ['My actions', 3],
    ])
    // The last one picked is the one full screen; the other waits, put away.
    expect(env.store!.fullScreen()).toBe(openedCards()[1].id)
    expect(env.store!.openedByVisit().map((c) => c.spec.title)).toEqual(['Captures', 'My actions'])
  })

  it('picking a page already opened here brings its card back, full screen and the one visited last', async () => {
    await mount()
    await pickPage('actions')
    await pickPage('captures')
    const [actions, captures] = openedCards().map((c) => c.id)
    expect(env.store!.fullScreen()).toBe(captures)
    await act(async () => env.store!.exitFullScreen())
    await new Promise((r) => setTimeout(r, 2))
    await pickPage('actions')
    expect(openedCards()).toHaveLength(2)
    expect(env.store!.fullScreen()).toBe(actions)
    expect(env.store!.openedByVisit().map((c) => c.id)).toEqual([captures, actions])
  })

  it('Projects and Initiatives nest under Tasks (Liam, 11-11): from `/` or a link, My Actions’ card opens on that place', async () => {
    await mount()
    await pickPage('projects')
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ kind: 'list', title: 'My actions', entity_type: 'action' })
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    expect(env.store!.state(cards[0].id).tasksPlace).toBe('projects')
    // A link (openTarget `page`) to Initiatives: the same card brought back, on its place.
    await act(async () => env.store!.exitFullScreen())
    const initiatives = cardForTarget({ type: 'page', slug: 'initiatives' })!
    await act(async () => ref.current!.openCard({ spec: initiatives.spec, from: 'link' }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    expect(env.store!.state(cards[0].id).tasksPlace).toBe('initiatives')
  })

  it('Teams nests under Tasks too (Liam, 11-11: "Teams should be under action items"): from `/` or a link, My Actions’ card opens on All teams', async () => {
    await mount()
    await pickPage('teams')
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ kind: 'list', title: 'My actions', entity_type: 'action' })
    expect(pageOfCard(cards[0].spec)).toBe('actions')
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    expect(env.store!.state(cards[0].id).tasksPlace).toBe('teams')
    await act(async () => env.store!.exitFullScreen())
    const teams = cardForTarget({ type: 'page', slug: 'teams' })!
    await act(async () => ref.current!.openCard({ spec: teams.spec, from: 'link' }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    expect(env.store!.state(cards[0].id).tasksPlace).toBe('teams')
  })

  it('where My Actions is off, Teams opens on its own as before', async () => {
    const full = getEdition('full')
    env.edition = { ...full, views: full.views.filter((v) => v !== 'todo'), extraAllowedViews: full.extraAllowedViews.filter((v) => v !== 'todo') }
    await mount()
    await pickPage('teams')
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ kind: 'teams' })
    expect(env.store!.state(cards[0].id).tasksPlace).toBeUndefined()
  })

  it('where My Actions is off, the Projects page opens on its own as before', async () => {
    const full = getEdition('full')
    env.edition = { ...full, views: full.views.filter((v) => v !== 'todo'), extraAllowedViews: full.extraAllowedViews.filter((v) => v !== 'todo') }
    await mount()
    await pickPage('projects')
    const cards = openedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ kind: 'list', entity_type: 'project' })
    expect(env.store!.state(cards[0].id).tasksPlace).toBeUndefined()
  })

  it('drops a page queued in one chat when the panel moves to another', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)] })
    env.status = 'streaming'
    env.rerender!()
    await pickPage('captures')
    // The panel now shows another chat, and that chat's turn settles.
    props = { ...props, chatSessionId: 'sess-other' }
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(openedCards()).toHaveLength(0)
  })


  it('a new chat’s first send waits on the conversation the page is creating, and / alone never prewarms', async () => {
    // The create-save is slow to answer.
    let answer!: () => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/account/chat-history' && init?.method === 'POST') {
          await new Promise<void>((r) => (answer = r))
          return new Response(JSON.stringify({ conversationId: 'conv-1' }))
        }
        return new Response('{}')
      }),
    )
    await mount()
    await pickPage('actions')
    // The bare `/` keystroke asked for no prewarm (it would mint a second row).
    expect(env.prewarms).toEqual([])
    // The page's save is creating the conversation: the transport's first send waits for it.
    const pending = env.transportOptions!.getPendingConversation!()
    expect(pending).not.toBeNull()
    await act(async () => {
      answer()
      await expect(pending).resolves.toBe('conv-1')
    })
    // Once created, nothing is pending.
    expect(env.transportOptions!.getPendingConversation!()).toBeNull()
  })

  // ── P5: every way in opens a card ─────────────────────────────────────────

  const ACTION = cardForTarget({ type: 'action', id: 'a-1', title: 'GEN-1 Pricing' })!

  it('openCard: the card goes in the chat, saved and numbered, and FULL SCREEN at once', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)] })
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    const cards = openedCards()
    expect(cards).toEqual([expect.objectContaining({ number: 2, spec: expect.objectContaining({ kind: 'record', record: { type: 'action', id: 'a-1' } }) })])
    expect(env.store!.fullScreen()).toBe(cards[0].id)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(fetchCalls.some((c) => c.url === '/api/account/chat-history' && c.method === 'POST')).toBe(true)
  })

  it('reuse: the card already showing that place comes back full screen, not a second one', async () => {
    await mount()
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'capture', reuse: true }))
    const first = openedCards()[0].id
    await act(async () => env.store!.exitFullScreen())
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'capture', reuse: true }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(first)
    // Without reuse too: a place the person opened here comes back.
    await act(async () => env.store!.exitFullScreen())
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(first)
  })

  it('an agent’s card of the place is brought back only with reuse; else the person’s own opens', async () => {
    const agentCard = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'show',
          toolCallId: 'call_agent',
          state: 'output-available',
          input: {},
          output: { success: true, card: ACTION.spec, count: 1, card_number: 1 },
        },
      ],
    } as unknown as UIMessage
    await mount({ initialMessages: [agentCard] })
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(openedCards()[0].id)
    await act(async () => env.store!.exitFullScreen())
    // With reuse, the newest of the place (the person's own now) comes back.
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'capture', reuse: true }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(openedCards()[0].id)
  })

  it('reuse alone brings back an agent’s card of the place', async () => {
    const agentCard = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'show',
          toolCallId: 'call_agent',
          state: 'output-available',
          input: {},
          output: { success: true, card: ACTION.spec, count: 1, card_number: 1 },
        },
      ],
    } as unknown as UIMessage
    await mount({ initialMessages: [agentCard] })
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'capture', reuse: true }))
    expect(openedCards()).toHaveLength(0)
    expect(env.store!.fullScreen()).toBe('call_agent')
  })

  it('a bot’s page opened again reuses its card and moves it to the item asked for', async () => {
    await mount()
    const page = cardForTarget({ type: 'bot', teammateId: 'tm-ada', name: 'Ada' })!
    await act(async () => ref.current!.openCard({ spec: page.spec, from: 'bot', reuse: true }))
    const first = openedCards()[0].id
    await act(async () => env.store!.exitFullScreen())
    const onItem = cardForTarget({ type: 'bot', teammateId: 'tm-ada', name: 'Ada', item: { itemId: 'item-9', title: 'Reply to Acme' } })!
    await act(async () => ref.current!.openCard({ spec: onItem.spec, seed: onItem.seed, from: 'bot', reuse: true }))
    expect(openedCards()).toHaveLength(1)
    expect(env.store!.fullScreen()).toBe(first)
    expect(env.store!.state(first).at).toMatchObject({ type: 'work_item', id: 'item-9' })
  })


  it('a seed lands in the card’s state before it mounts (a flow’s editor on its run)', async () => {
    await mount()
    const flow = cardForTarget({ type: 'flow', id: 'flow-1', title: 'Nightly', runId: 'run-9' })!
    await act(async () => ref.current!.openCard({ spec: flow.spec, seed: flow.seed, from: 'notification' }))
    const id = openedCards()[0].id
    expect(env.store!.state(id)).toMatchObject({ editing: 'flow-1', editingRun: 'run-9' })
    expect(env.store!.fullScreen()).toBe(id)
  })

  it('opened while a turn is out: full screen over the chat at once, in the thread once the turn settles', async () => {
    await mount({ initialMessages: [showMessage('a1', 1)] })
    env.status = 'streaming'
    env.rerender!()
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'notification' }))
    expect(openedCards()).toHaveLength(0)
    const waiting = env.store!.fullScreen()
    expect(waiting).not.toBeNull()
    await act(async () => {
      env.status = 'ready'
      env.rerender!()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(openedCards().map((c) => c.id)).toEqual([waiting])
    expect(openedCards()[0].number).toBe(2)
  })

  it('a press around the composer (not on it) puts a full-screen card back: the app’s one rule for empty presses (Liam, 11-11)', async () => {
    const { EmptyPressMinimizes } = await import('../../minimized-card-tile')
    const wasMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('min-width'), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    document.documentElement.setAttribute('data-app-rail', '')
    const ruleHost = document.createElement('div')
    document.body.append(ruleHost)
    const ruleRoot = createRoot(ruleHost)
    let release = () => {}
    try {
      await act(async () => ruleRoot.render(h(EmptyPressMinimizes)))
      await mount()
      await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
      const id = env.store!.fullScreen()
      expect(id).not.toBeNull()
      // The card in front, as its ShowToolCard holds it (the kept-card host is a stub here).
      const { holdFrontCard } = await import('@/components/chat-cards/front-card')
      release = holdFrontCard({ id: id!, spec: ACTION.spec, close: () => env.store!.exitFullScreen() })
      const press = (el: Element) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
      // On the composer itself: the card stays.
      await act(async () => press(container.querySelector('textarea')!))
      expect(env.store!.fullScreen()).toBe(id)
      // Its margins: the chat's backdrop.
      const zone = container.querySelector('[data-chat-composer]') as HTMLElement
      await act(async () => press(zone.firstElementChild as HTMLElement))
      expect(env.store!.fullScreen()).toBeNull()
    } finally {
      release()
      act(() => ruleRoot.unmount())
      ruleHost.remove()
      document.documentElement.removeAttribute('data-app-rail')
      window.matchMedia = wasMatchMedia
    }
  })

  // Liam, 11-11: "you can still see the main chat input even when you have a panel open".
  const textarea = () => container.querySelector('textarea')!
  async function type(text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('typing in the composer leaves a full-screen card be; a send puts it back in the chat, and every card in front with it', async () => {
    await mount()
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    const id = env.store!.fullScreen()
    expect(id).not.toBeNull()
    // A card of another chat, full screen too (front-card.ts): it goes back as well.
    const other = vi.fn()
    const release = holdFrontCard({ id: 'other', spec: ACTION.spec, close: other })
    try {
      await type('What is left on this?')
      expect(env.store!.fullScreen()).toBe(id)
      expect(other).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
      await act(async () => {
        textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(env.store!.fullScreen()).toBeNull()
      expect(other).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  it('an empty Enter sends nothing and leaves the card full screen', async () => {
    await mount()
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    const id = env.store!.fullScreen()
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(env.store!.fullScreen()).toBe(id)
  })

  it('a panel that is not the main chat never puts a card back on send (its composer may sit inside the card)', async () => {
    await mount({ alwaysShowMessages: false })
    const close = vi.fn()
    const release = holdFrontCard({ id: 'outer', spec: ACTION.spec, close })
    try {
      await type('Hello')
      await act(async () => {
        textarea().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(close).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  it('the main chat says how tall its composer dock stands on <html>, for the full-screen layer; gone with the chat', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-chat-composer-dock') ? 96 : 0
      },
    })
    try {
      await mount()
      expect(document.documentElement.style.getPropertyValue(COMPOSER_RESERVE_VAR)).toBe('96px')
      unmount()
      expect(document.documentElement.style.getPropertyValue(COMPOSER_RESERVE_VAR)).toBe('')
      // Another panel (not the main chat) never writes it.
      await mount({ alwaysShowMessages: false })
      expect(document.documentElement.style.getPropertyValue(COMPOSER_RESERVE_VAR)).toBe('')
    } finally {
      Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('a bot’s page full screen brings its own composer: the chat’s steps aside until it goes back', async () => {
    await mount()
    const composer = () => container.querySelector('[data-chat-composer]') as HTMLElement
    expect(composer().hidden).toBe(false)
    const page = cardForTarget({ type: 'bot', teammateId: 'tm-ada', name: 'Ada' })!
    await act(async () => ref.current!.openCard({ spec: page.spec, from: 'bot', reuse: true }))
    expect(composer().hidden).toBe(true)
    expect(composer().hasAttribute('inert')).toBe(true)
    await act(async () => env.store!.exitFullScreen())
    expect(composer().hidden).toBe(false)
    // Any other card full screen leaves it where it is.
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    expect(composer().hidden).toBe(false)
  })

  it('a fold puts matching cards out of full screen', async () => {
    await mount()
    await act(async () => ref.current!.openCard({ spec: ACTION.spec, from: 'chip' }))
    expect(env.store!.fullScreen()).not.toBeNull()
    await act(async () => foldCards({ kind: 'record', type: 'action', id: 'a-1' }))
    expect(env.store!.fullScreen()).toBeNull()
  })
})
