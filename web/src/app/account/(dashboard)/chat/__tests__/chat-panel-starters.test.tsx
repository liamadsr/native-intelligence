// @vitest-environment jsdom
/**
 * First-run starters in the real ChatPanel, as the composer's rotating
 * placeholder (composer-suggestions.tsx): in an empty main chat the
 * placeholder holds the default hint 3 s, then a starter with a "Tab" keycap
 * 5 s, then the hint, then the next starter (shuffled, none repeated until all
 * have shown), only for areas on in the workspace and tools the chat may call.
 * Tab on a starter types it all out, holds it a beat, then sends it as the
 * person's message, carrying only the prompt. A conversation,
 * or a teammate's / run's chat rotates nothing. The starters are no
 * longer drawn in the chat's body.
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
  transportOptions: null as null | { getCardContext?: () => unknown[] },
  edition: null as unknown,
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
          if (key === 'turnPersisted') return () => Promise.resolve()
          return key in target ? (target as never)[key] : () => undefined
        },
      })
    }
  },
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => {
      const ch: Record<string, unknown> = {}
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: () => {},
  }),
}))
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({ flushTranscriptForAgent: async () => {}, getSegmentsForAgent: () => [] }),
}))
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
  CHAT_MESSAGE_WINDOW: 100,
  windowChatMessages: (m: unknown[]) => ({ visible: m, hiddenCount: 0 }),
}))
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
import { ChatInput } from '../chat-input'
import { HINT_HOLD_MS, SUGGESTION_HOLD_MS } from '../composer-suggestions'
import { createRef } from 'react'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { STARTER_AREAS } from '@/lib/chat/starters'

const HINT = '@ to mention'
const promptsOf = (...ids: string[]) => STARTER_AREAS.filter((a) => ids.includes(a.id)).flatMap((a) => [...a.prompts])
const ALL_PROMPTS = STARTER_AREAS.flatMap((a) => [...a.prompts])

describe('ChatPanel: starters in the composer’s rotating placeholder', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  async function mount(props: Record<string, unknown> = {}) {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = () =>
      root.render(h(ChatPanel, { ref, chatSessionId: 'sess-starters', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true, ...props }))
    env.rerender = () => act(() => render())
    await act(async () => {
      render()
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  const textarea = () => container.querySelector('textarea')!
  const overlay = () => container.querySelector('[data-composer-suggestions]')
  const front = () => overlay()?.querySelector('[data-composer-suggestion-layer="front"]') ?? null
  /** The suggestion showing, or null on the hint. */
  const shown = () => front()?.querySelector('[data-composer-suggestion]')?.textContent ?? null
  const keycap = () => front()?.querySelector('kbd')?.textContent ?? null

  async function type(value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea(), value)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function key(k: string) {
    const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    await act(async () => {
      textarea().dispatchEvent(ev)
    })
    return ev
  }
  /** Every suggestion over `count` cycles. */
  async function collect(count: number) {
    const seen: string[] = []
    for (let i = 0; i < count; i++) {
      await advance(HINT_HOLD_MS)
      seen.push(shown()!)
      await advance(SUGGESTION_HOLD_MS)
    }
    return seen
  }
  /** On to the first suggestion. */
  async function toSuggestion() {
    await advance(HINT_HOLD_MS)
    const prompt = shown()
    expect(prompt).not.toBeNull()
    return prompt!
  }
  /** Advance in small steps until the box holds `text` (the type-out's last character). */
  async function untilBoxHolds(text: string) {
    for (let i = 0; i < 400 && textarea().value !== text; i++) await advance(10)
    expect(textarea().value).toBe(text)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    env.messages = []
    env.status = 'ready'
    env.seeded = false
    env.edition = getEdition('full')
    sendMessage.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    env.rerender = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('cycles hint (3 s) → suggestion A (5 s) → hint → suggestion B, the keycap only on a suggestion', async () => {
    await mount()
    expect(overlay()).not.toBeNull()
    expect(overlay()!.getAttribute('aria-hidden')).toBe('true')
    expect(front()!.textContent).toBe(HINT)
    expect(keycap()).toBeNull()
    await advance(HINT_HOLD_MS - 1)
    expect(shown()).toBeNull()
    await advance(1)
    const a = shown()
    expect(ALL_PROMPTS).toContain(a)
    expect(keycap()).toBe('Tab')
    // The keycap leads the line, then the suggestion: "[Tab] What's due this week?".
    expect(front()!.firstElementChild!.tagName).toBe('KBD')
    expect(front()!.lastElementChild!.textContent).toBe(a)
    await advance(SUGGESTION_HOLD_MS - 1)
    expect(shown()).toBe(a)
    await advance(1)
    expect(shown()).toBeNull()
    expect(front()!.textContent).toBe(HINT)
    expect(keycap()).toBeNull()
    await advance(HINT_HOLD_MS)
    const b = shown()
    expect(ALL_PROMPTS).toContain(b)
    expect(b).not.toBe(a)
  })

  it('shows every starter once, shuffled, before any repeats', async () => {
    await mount()
    const seen = await collect(ALL_PROMPTS.length)
    expect(new Set(seen).size).toBe(ALL_PROMPTS.length)
    expect([...seen].sort()).toEqual([...ALL_PROMPTS].sort())
  })

  it('one visible placeholder line: the native one is empty under the overlay, the hint stays for assistive tech', async () => {
    await mount()
    expect(textarea().placeholder).toBe('')
    expect(textarea().getAttribute('aria-placeholder')).toBe(HINT)
    // No overlay (text in the box): the native placeholder is back, as before.
    await type('h')
    expect(overlay()).toBeNull()
    expect(textarea().placeholder).toBe(HINT)
    expect(textarea().hasAttribute('aria-placeholder')).toBe(false)
  })

  it('an ongoing conversation keeps its native “Continue chat” and rotates nothing', async () => {
    await mount({ initialMessages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] })
    expect(overlay()).toBeNull()
    expect(textarea().placeholder).toBe('Continue chat')
    expect(textarea().hasAttribute('aria-placeholder')).toBe(false)
  })

  it('rotates only the starters of areas on in the workspace', async () => {
    env.edition = withEffectiveSurface(getEdition('full'), { prospecting: 'off', sequences: 'off', crm: 'off', email: 'off', knowledge: 'off' })
    await mount()
    const allowed = promptsOf('calendar', 'actions', 'captures')
    const seen = await collect(allowed.length)
    expect([...seen].sort()).toEqual([...allowed].sort())
  })



  it('rotates them only on the home thread once its id is known (A3): another conversation rotates nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }))))
    await mount({ homeThreadId: 'home-1', initialConversationId: 'side-1' })
    expect(overlay()).toBeNull()
    root.unmount()
    await mount({ homeThreadId: 'home-1', initialConversationId: 'home-1' })
    expect(overlay()).not.toBeNull()
  })

  it('never binds a capture’s conversation: a load of one is refused, and the chat stays as it was', async () => {
    // One chat (Slice 3): a call's conversation is its live agent's, in the
    // HUD. The main chat never shows it, so it never sends there.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).split('?')[0] === '/api/account/chat-history/conv-1'
          ? new Response(JSON.stringify({ messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Listening in.' }] }], title: 'Live: Pricing sync', captureId: 'cap-1', recipeId: null }))
          : new Response(JSON.stringify({ messages: [] })),
      ),
    )
    await mount()
    expect(overlay()).not.toBeNull()
    let outcome: unknown
    await act(async () => {
      outcome = await ref.current!.loadConversation('conv-1')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(outcome).toBe('missing')
    expect(ref.current!.flushSnapshot().conversationId).toBeUndefined()
    expect(ref.current!.flushSnapshot().chatMessages).toEqual([])
    expect(overlay()).not.toBeNull()
    // Nothing of the old live flow is on the handle any more.
    expect('openLiveCaptureConversation' in ref.current!).toBe(false)
    expect('getLiveCaptureId' in ref.current!).toBe(false)
  })

  it('a teammate’s or a run’s composer (no suggestions) keeps the native placeholder', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
          onStop: () => {},
          isLoading: false,
          attachedNotes: [],
          onAttachNote: () => {},
          onRemoveNote: () => {},
          attachedFiles: [],
          onAttachFiles: () => {},
          onRemoveFile: () => {},
          mainComposer: false,
        }),
      )
    })
    expect(overlay()).toBeNull()
    expect(textarea().placeholder).toBe('@ to mention')
    await advance(HINT_HOLD_MS + SUGGESTION_HOLD_MS)
    expect(overlay()).toBeNull()
  })

  it('stops while the box holds text, and starts again from the hint when it is cleared', async () => {
    await mount()
    const first = await toSuggestion()
    await type('Hel')
    expect(overlay()).toBeNull()
    await advance(30_000)
    expect(overlay()).toBeNull()
    await type('')
    expect(overlay()).not.toBeNull()
    expect(shown()).toBeNull()
    await advance(HINT_HOLD_MS - 1)
    expect(shown()).toBeNull()
    await advance(1)
    // On to a new one, not a replay.
    expect(shown()).not.toBeNull()
    expect(shown()).not.toBe(first)
  })

  it('rotates nothing over an armed skill', async () => {
    await mount()
    // Skills are picked from the global palette (`/` outside a text field).
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-skill="scout"]') as HTMLButtonElement).click()
    })
    await advance(HINT_HOLD_MS + SUGGESTION_HOLD_MS)
    expect(overlay()).toBeNull()
    expect(textarea().placeholder).toBe(HINT)
    const tab = await key('Tab')
    expect(tab.defaultPrevented).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })


  it('pauses while the document is hidden, and starts again from the hint when it shows', async () => {
    await mount()
    const setVisibility = async (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    }
    try {
      await toSuggestion()
      await setVisibility('hidden')
      expect(shown()).toBeNull()
      await advance(30_000)
      expect(shown()).toBeNull()
      await setVisibility('visible')
      await advance(HINT_HOLD_MS)
      expect(shown()).not.toBeNull()
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState
    }
  })

  it('Tab on a suggestion types it all out, holds it a beat, then sends the prompt alone and clears the box', async () => {
    await mount()
    const prompt = await toSuggestion()
    const ev = await key('Tab')
    expect(ev.defaultPrevented).toBe(true)
    // Typing: part of it, nothing sent.
    expect(textarea().value.length).toBeGreaterThan(0)
    expect(textarea().value.length).toBeLessThan(prompt.length)
    expect(prompt.startsWith(textarea().value)).toBe(true)
    expect(sendMessage).not.toHaveBeenCalled()
    await untilBoxHolds(prompt)
    // The whole text in the box, the beat not yet over: still nothing sent.
    expect(sendMessage).not.toHaveBeenCalled()
    await advance(180)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(textarea().value).toBe(prompt)
    await advance(30)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toEqual({ text: prompt, metadata: { createdAt: expect.any(String) } })
    expect(sendMessage.mock.calls[0][1].body.skillId).toBeUndefined()
    expect(textarea().value).toBe('')
  })

  it('types at ~30 ms a character, a long suggestion in no more than about 1.2 s', async () => {
    await mount()
    const prompt = await toSuggestion()
    await key('Tab')
    await advance(Math.min(30 * prompt.length, 1200))
    expect(textarea().value).toBe(prompt)
    expect(sendMessage).not.toHaveBeenCalled()
    await advance(250)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('a second Tab while it types does not send twice', async () => {
    await mount()
    await toSuggestion()
    await key('Tab')
    await advance(60)
    const again = await key('Tab')
    expect(again.defaultPrevented).toBe(true)
    await advance(3000)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('Esc mid type-out cancels the send and leaves the whole suggestion in the box to edit', async () => {
    await mount()
    const prompt = await toSuggestion()
    await key('Tab')
    await advance(90)
    expect(textarea().value).not.toBe(prompt)
    await key('Escape')
    expect(textarea().value).toBe(prompt)
    await advance(5000)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(textarea().value).toBe(prompt)
  })

  it('typing mid type-out stops it where it was, and sends nothing', async () => {
    await mount()
    await toSuggestion()
    await key('Tab')
    await advance(90)
    const partial = textarea().value
    await type(`${partial}x`)
    await advance(5000)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(textarea().value).toBe(`${partial}x`)
  })

  it('Enter mid type-out sends the whole suggestion at once', async () => {
    await mount()
    const prompt = await toSuggestion()
    await key('Tab')
    await advance(60)
    await key('Enter')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toEqual({ text: prompt, metadata: { createdAt: expect.any(String) } })
    await advance(3000)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('Tab on the hint, or with text in the box, does nothing special', async () => {
    await mount()
    const onHint = await key('Tab')
    expect(onHint.defaultPrevented).toBe(false)
    await toSuggestion()
    await type('hello')
    const withText = await key('Tab')
    expect(withText.defaultPrevented).toBe(false)
    await advance(3000)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(textarea().value).toBe('hello')
  })

  it('under reduced motion: no crossfade, and Tab puts the whole text in at once, then the beat, then sends', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
    await mount()
    for (const layer of overlay()!.querySelectorAll('[data-composer-suggestion-layer]')) expect(layer.className).toContain('motion-reduce:transition-none')
    const prompt = await toSuggestion()
    await key('Tab')
    expect(textarea().value).toBe(prompt)
    await advance(190)
    expect(sendMessage).not.toHaveBeenCalled()
    await advance(20)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toEqual({ text: prompt, metadata: { createdAt: expect.any(String) } })
  })

  it('draws no starters in the chat’s body', async () => {
    await mount()
    expect(container.querySelector('[data-chat-starters]')).toBeNull()
    expect(container.querySelector('[data-starter-area]')).toBeNull()
    // Only the composer's own controls are buttons with a starter's words.
    const buttonTexts = [...container.querySelectorAll('button')].map((b) => b.textContent)
    for (const prompt of ALL_PROMPTS) expect(buttonTexts).not.toContain(prompt)
  })
})
