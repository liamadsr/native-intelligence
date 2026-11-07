// @vitest-environment jsdom
/**
 * <TeammateChat> + useTeammateChat (bots v2, Phase 1) — the compact chat the
 * bot bubble mounts. Pins the HOST behaviour over a real useChat:
 *   - on mount it opens the teammate thread (eve-session { action: 'thread' })
 *     and loads that thread's history IN the teammate's workspace
 *     (x-workspace-id), then shows it;
 *   - the transport is the main chat's EveChatTransport, built with the
 *     teammate and a workspace getter that answers the thread's workspace, and
 *     the thread's conversation id;
 *   - a send streams the reply into the log; a refused thread shows the error
 *     and sends nothing;
 *   - Escape clears what's typed (handled, going no further), is left to the
 *     host in an empty box, and only ends an IME composition;
 *   - Enter does nothing while the thread opens, and a send that didn't go
 *     out (the thread couldn't open) gives its text back;
 *   - compact (the bot bubble): the log in the bubble's sizes and capped, the
 *     default untouched; autoFocus takes focus into the box from nowhere or
 *     from around it, never from somewhere else, and only when asked;
 *   - the thread outlives the chat (the bots v2 review): unmounted mid-reply,
 *     the reply runs to its end, never stopped, and the next mount shows it
 *     without opening the thread again; a failed open opens again; past
 *     TEAMMATE_CHATS_KEPT the least recently shown idle threads are let go;
 *     signing out (the wipe, or Supabase's SIGNED_OUT) ends them all;
 *   - what's typed is kept per teammate across mounts and cleared by a send;
 *     the root says when it's busy or has a draft;
 *   - the log follows a reply only while you're at its bottom; your own
 *     message always brings you down;
 *   - compact, the stack (bots-v2.md "Floating cards"): all but the newest
 *     TEAMMATE_CHAT_STACK_SHOWN are folded into it yet still in the log; it
 *     opens on its toggle (focus staying on it) or as focus moves into a
 *     folded message, and folds back; a message of your own folds it and
 *     pushes the one before into it.
 * ChatMessage is stubbed to a text dump (its real impl drags in the chat's dependencies);
 * the transport is a scripted stand-in (its own tests pin the wire).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// It also says whether a feedback store reached it (`data-feedback`), as the real
// one's thumbs would show: a teammate's replies must never find the main chat's.
vi.mock('@/app/account/(dashboard)/chat/chat-message', async () => {
  const { useContext } = await import('react')
  const { MessageFeedbackContext } = await import('@/app/account/(dashboard)/chat/message-feedback-buttons')
  return {
    ChatMessage: function StubChatMessage({ message }: { message: { role: string; parts: Array<Record<string, unknown>> } }) {
      const feedback = useContext(MessageFeedbackContext)
      return h(
        'div',
        { 'data-role': message.role, 'data-feedback': feedback ? 'on' : 'off' },
        message.parts.map((p) => (p.type === 'text' ? (p.text as string) : '')).join(' '),
      )
    },
  }
})

// Supabase's auth listener, as the store subscribed it (to play a sign-out).
const supa = vi.hoisted(() => ({ onAuth: null as null | ((event: string, session: unknown) => void) }))
// The realtime channels the thread opened (bots v4 A4: its relays bridge).
const live = vi.hoisted(() => ({ topics: [] as string[], inserts: [] as Array<(p: { new: unknown }) => void> }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    // A bot's thread's live bridge for relayed messages (bots v4 A4): the topics
    // opened, and the INSERT handlers, so a test can land a relayed row.
    channel: (name: string) => {
      live.topics.push(name)
      const ch = {
        on: (_e: string, cfg: { event: string }, handler: (p: { new: unknown }) => void) => {
          if (cfg.event === 'INSERT') live.inserts.push(handler)
          return ch
        },
        subscribe: () => ch,
      }
      return ch
    },
    removeChannel: () => {},
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-1', user: { id: 'user-1' } } } }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        supa.onAuth = cb
        return { data: { subscription: { unsubscribe() {} } } }
      },
    },
  }),
}))

// A reply held open part-way (`hold`), and every send's abort signal.
const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, signals: [] as AbortSignal[] }))
const transports: Array<{ opts: Record<string, unknown>; sends: unknown[] }> = []
vi.mock('@/lib/chat/eve/eve-chat-transport', () => ({
  EveChatTransport: class {
    record: { opts: Record<string, unknown>; sends: unknown[] }
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, sends: [] }
      transports.push(this.record)
    }
    async sendMessages(options: { abortSignal?: AbortSignal }) {
      this.record.sends.push(options)
      if (options.abortSignal) gate.signals.push(options.abortSignal)
      const held = gate.hold
      return new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'start' })
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'Hi from Writer' })
          if (held) {
            await held
            controller.enqueue({ type: 'text-delta', id: 't1', delta: ' and more.' })
          }
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({ type: 'finish' })
          controller.close()
        },
      })
    }
    async reconnectToStream() {
      return null
    }
    async disposeAll() {}
  },
}))

import { COMPACT_LOG, COMPACT_LOG_MAX, TEAMMATE_CHAT_STACK_SHOWN, TeammateChat } from '../teammate-chat'
import { __resetTeammateChatsForTests } from '@/hooks/use-teammate-chat'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import { createMessageFeedbackStore } from '@/hooks/use-message-feedback'

let container: HTMLDivElement
let root: Root

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

function stubFetch(thread: { ok: boolean }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/account/chat/eve-session') {
        return thread.ok
          ? okJson({ conversationId: 'conv-tm', workspaceId: 'ws-TM', eveSessionId: null, teammate: { id: 'tm-1', name: 'Writer' } })
          : okJson({ error: 'teammate not found', code: 'TEAMMATE_NOT_FOUND' }, 404)
      }
      if (url === '/api/account/chat-history/conv-tm') {
        return okJson({ messages: [{ id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Earlier reply' }] }] })
      }
      return okJson({}, 404)
    }),
  )
  return calls
}

async function type(text: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
  })
}

beforeEach(() => {
  live.topics.length = 0
  live.inserts.length = 0
  transports.length = 0
  gate.hold = null
  gate.signals = []
  supa.onAuth = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  // Teammate threads outlive their mounts (use-teammate-chat.ts): each test its own.
  __resetTeammateChatsForTests()
  container.remove()
  vi.unstubAllGlobals()
})

describe('TeammateChat', () => {
  it('shows what the main chat relays into the thread as it lands (bots v4 A4), and only that', async () => {
    stubFetch({ ok: true })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    expect(live.topics.some((t) => t.startsWith('relays:conv-tm:'))).toBe(true)
    const meta = { eve_written: true, relay: { id: 'relay-1', from: 'main_chat' } }
    await act(async () => {
      for (const handler of live.inserts) {
        handler({ new: { ui_message: { id: 'relay-relay-1-message', role: 'user', parts: [{ type: 'text', text: 'From your main chat: sign off as Liam' }], metadata: meta } } })
        handler({ new: { ui_message: { id: 'relay-relay-1-reply', role: 'assistant', parts: [{ type: 'text', text: 'Will do.' }], metadata: meta } } })
        // Not a relayed row: the thread's own turns are its transport's.
        handler({ new: { ui_message: { id: 'other', role: 'assistant', parts: [{ type: 'text', text: 'Not relayed' }] } } })
      }
      await flush()
    })
    expect(container.textContent).toContain('From your main chat: sign off as Liam')
    expect(container.textContent).toContain('Will do.')
    expect(container.textContent).not.toContain('Not relayed')
  })

  it('opens the teammate thread, loads its history in the teammate’s workspace, and shows it', async () => {
    const calls = stubFetch({ ok: true })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    const open = calls.find((c) => c.url === '/api/account/chat/eve-session')!
    expect(JSON.parse(String(open.init?.body))).toEqual({ action: 'thread', teammateId: 'tm-1' })
    const history = calls.find((c) => c.url === '/api/account/chat-history/conv-tm')!
    expect((history.init?.headers as Record<string, string>)['x-workspace-id']).toBe('ws-TM')
    expect(container.textContent).toContain('Earlier reply')
    // The teammate's name from the thread call labels the box (the placeholder
    // hides in a zero-width jsdom field).
    expect(container.querySelector('textarea')!.getAttribute('aria-label')).toBe('Message Writer')
    expect(container.querySelector('[role="log"]')!.getAttribute('aria-label')).toBe('Conversation with Writer')
  })

  it('runs on the main chat transport for this teammate, in its workspace, and streams the reply', async () => {
    stubFetch({ ok: true })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    const { opts } = transports[transports.length - 1]
    expect(opts.teammateId).toBe('tm-1')
    expect((opts.workspaceId as () => string | null)()).toBe('ws-TM')
    expect((opts.getConversationId as () => string | null)()).toBe('conv-tm')
    expect((opts.panelNamesChats as () => boolean)()).toBe(true)

    await type('what did you draft?')
    expect(transports[transports.length - 1].sends).toHaveLength(1)
    expect(container.textContent).toContain('what did you draft?')
    expect(container.textContent).toContain('Hi from Writer')
  })

  it('a refused thread shows the error and sends nothing', async () => {
    stubFetch({ ok: false })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-private' }))
    })
    await act(async () => {
      await flush()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('teammate not found')
    await type('hello?')
    for (const t of transports) expect(t.sends).toHaveLength(0)
  })

  it('Escape clears what’s typed (handled, going no further); in an empty box it’s the host’s; mid-composition it only ends that', async () => {
    stubFetch({ ok: true })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    // Whatever hosts it, above React's root.
    const host = vi.fn()
    document.body.addEventListener('keydown', host)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const escape = async (init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
      await act(async () => {
        textarea.dispatchEvent(e)
      })
      return e
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'half a thought')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const composing = await escape({ isComposing: true })
    expect(composing.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('half a thought')

    const clearing = await escape()
    expect(clearing.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('')
    expect(host).not.toHaveBeenCalled()

    const empty = await escape()
    expect(empty.defaultPrevented).toBe(false)
    expect(host).toHaveBeenCalledTimes(1)
    document.body.removeEventListener('keydown', host)
  })

  it('holds Enter while the thread opens, and gives the text back when it couldn’t open', async () => {
    let refuse: () => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/account/chat/eve-session'
          ? new Promise<Response>((resolve) => (refuse = () => resolve(okJson({ error: 'teammate not found' }, 404))))
          : Promise.resolve(okJson({}, 404)),
      ),
    )
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await type('are you there?')
    // Still opening: nothing sent, nothing lost.
    expect(textarea.value).toBe('are you there?')
    for (const t of transports) expect(t.sends).toHaveLength(0)

    await act(async () => {
      refuse()
      await flush()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('teammate not found')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    expect(textarea.value).toBe('are you there?')
    for (const t of transports) expect(t.sends).toHaveLength(0)
  })
})

describe('TeammateChat — inside the main chat', () => {
  it('its replies never take the main chat’s thumbs', async () => {
    stubFetch({ ok: true })
    const mainChat = createMessageFeedbackStore('c-main')
    await act(async () => {
      root.render(h(MessageFeedbackContext.Provider, { value: mainChat }, h(TeammateChat, { teammateId: 'tm-1' })))
    })
    await act(async () => {
      await flush()
    })
    expect(container.textContent).toContain('Earlier reply')
    const replies = [...container.querySelectorAll<HTMLElement>('[data-role="assistant"]')]
    expect(replies.length).toBeGreaterThan(0)
    expect(replies.every((el) => el.dataset.feedback === 'off')).toBe(true)
  })
})

describe('TeammateChat — compact, and taking focus', () => {
  async function mount(props: Record<string, unknown> = {}) {
    stubFetch({ ok: true })
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1', ...props }))
    })
    await act(async () => {
      await flush()
    })
  }
  const log = () => container.querySelector<HTMLElement>('[role="log"]')!

  it('draws compact in the bubble’s sizes: 13px on a 20px line, smaller headings and code, a log that grows to the bubble’s room', async () => {
    await mount({ density: 'compact' })
    expect(container.querySelector<HTMLElement>('[data-teammate-chat-density]')!.dataset.teammateChatDensity).toBe('compact')
    for (const cls of [
      COMPACT_LOG_MAX,
      'gap-2',
      '[&_.prose]:text-[13px]',
      '[&_.prose]:leading-5',
      '[&_.prose_:is(h1,h2)]:text-[14px]',
      '[&_.prose_:is(code,.font-mono)]:text-[12px]',
      '[&_.not-prose>div]:text-[12px]',
    ]) {
      expect(log().classList).toContain(cls)
    }
    expect(container.querySelector('textarea')!.classList).toContain('text-[13px]')
  })

  it('leaves the default as it was: the main chat’s sizes, none of the compact ones', async () => {
    await mount()
    expect(container.querySelector<HTMLElement>('[data-teammate-chat-density]')!.dataset.teammateChatDensity).toBe('comfortable')
    expect(log().classList).toContain('gap-3')
    for (const cls of COMPACT_LOG.split(' ').filter((c) => c !== 'gap-2')) expect(log().classList).not.toContain(cls)
    expect(container.querySelector('textarea')!.classList).toContain('text-sm')
  })

  it('takes focus into its box as it mounts, from nowhere', async () => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await mount({ autoFocus: true })
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it('takes focus from a dialog around it', async () => {
    const dialog = document.createElement('div')
    dialog.tabIndex = -1
    document.body.append(dialog)
    dialog.append(container)
    dialog.focus()
    await mount({ autoFocus: true })
    expect(document.activeElement).toBe(container.querySelector('textarea'))
    dialog.remove()
  })

  it('never takes focus from somewhere else, nor unasked', async () => {
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    await mount({ autoFocus: true })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()

    act(() => root.unmount())
    root = createRoot(container)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await mount()
    expect(document.activeElement).toBe(document.body)
  })
})

describe('TeammateChat — the thread outlives the chat', () => {
  const opens = (calls: Array<{ url: string; init?: RequestInit }>, teammateId = 'tm-1') =>
    calls.filter((c) => c.url === '/api/account/chat/eve-session' && JSON.parse(String(c.init?.body)).teammateId === teammateId).length
  async function show(teammateId = 'tm-1') {
    await act(async () => {
      root.render(h(TeammateChat, { teammateId }))
    })
    await act(async () => {
      await flush()
    })
  }
  async function hide() {
    await act(async () => {
      root.render(null)
    })
  }
  const box = () => container.querySelector('textarea') as HTMLTextAreaElement
  const chatRoot = () => container.querySelector<HTMLElement>('[data-teammate-chat-density]')!

  it('unmounted mid-reply, the reply runs to its end (never stopped), and the next mount shows it without opening again', async () => {
    const calls = stubFetch({ ok: true })
    let release!: () => void
    gate.hold = new Promise((resolve) => (release = resolve))
    await show()
    await type('draft the follow-up')
    expect(container.textContent).toContain('Hi from Writer')
    expect(chatRoot().hasAttribute('data-teammate-chat-busy')).toBe(true)

    await hide()
    expect(gate.signals).toHaveLength(1)
    expect(gate.signals[0].aborted).toBe(false)
    await act(async () => {
      release()
      await flush()
    })
    expect(gate.signals[0].aborted).toBe(false)

    await show()
    expect(container.textContent).toContain('draft the follow-up')
    expect(container.textContent).toContain('Hi from Writer and more.')
    expect(chatRoot().hasAttribute('data-teammate-chat-busy')).toBe(false)
    // One thread, opened and loaded once, on one transport.
    expect(opens(calls)).toBe(1)
    expect(calls.filter((c) => c.url === '/api/account/chat-history/conv-tm')).toHaveLength(1)
    expect(transports).toHaveLength(1)
  })

  it('a thread whose open failed opens again on the next mount', async () => {
    stubFetch({ ok: false })
    await show()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('teammate not found')
    await hide()
    vi.unstubAllGlobals()
    const calls = stubFetch({ ok: true })
    await show()
    expect(opens(calls)).toBe(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('Earlier reply')
  })

  it('keeps what’s typed per teammate across mounts, says so on its root, and a send clears it', async () => {
    stubFetch({ ok: true })
    await show()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'half a thought')
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(chatRoot().hasAttribute('data-teammate-chat-draft')).toBe(true)
    await hide()
    // Another teammate's box is its own.
    await show('tm-2')
    expect(box().value).toBe('')
    await hide()
    await show()
    expect(box().value).toBe('half a thought')
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    expect(box().value).toBe('')
    expect(chatRoot().hasAttribute('data-teammate-chat-draft')).toBe(false)
    await hide()
    await show()
    expect(box().value).toBe('')
  })

  it(`keeps at most TEAMMATE_CHATS_KEPT idle threads: the least recently shown is let go and opens again`, async () => {
    const { TEAMMATE_CHATS_KEPT } = await import('@/hooks/use-teammate-chat')
    const calls = stubFetch({ ok: true })
    const ids = Array.from({ length: TEAMMATE_CHATS_KEPT + 1 }, (_, i) => `tm-${i + 1}`)
    for (const id of ids) {
      await show(id)
      await hide()
    }
    // The newest are kept: shown again, nothing opens.
    await show(ids[ids.length - 1])
    await hide()
    expect(opens(calls, ids[ids.length - 1])).toBe(1)
    // The oldest was let go: it opens again.
    await show(ids[0])
    expect(opens(calls, ids[0])).toBe(2)
  })

  it('signing out ends every thread and forgets the drafts: the sign-out wipe, or Supabase’s SIGNED_OUT', async () => {
    const calls = stubFetch({ ok: true })
    await show()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'private note')
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await hide()
    act(() => supa.onAuth?.('SIGNED_OUT', null))
    await show()
    expect(opens(calls)).toBe(2)
    expect(box().value).toBe('')

    await hide()
    const { beginPersistedTabStateWipe } = await import('@/app/account/(dashboard)/main-chat/state-wipe')
    beginPersistedTabStateWipe()
    await show()
    expect(opens(calls)).toBe(3)
  })
})

describe('TeammateChat — following the reply', () => {
  /** The log's scroll box, measured: 1000px of content in a 100px window. */
  function measure(log: HTMLElement) {
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 })
  }
  const log = () => container.querySelector<HTMLElement>('[role="log"]')!
  async function scrollTo(top: number) {
    await act(async () => {
      log().scrollTop = top
      log().dispatchEvent(new Event('scroll'))
    })
  }

  it('follows a reply only while you’re at the bottom; your own message always brings you down', async () => {
    stubFetch({ ok: true })
    let release!: () => void
    gate.hold = new Promise((resolve) => (release = resolve))
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    measure(log())
    // Scrolled up to read; your own message brings you down to it.
    await scrollTo(0)
    await type('what did you draft?')
    expect(log().scrollTop).toBe(1000)

    // Scrolled up again while the reply streams in: it leaves you there.
    await scrollTo(200)
    await act(async () => {
      release()
      await flush()
    })
    expect(container.textContent).toContain('Hi from Writer and more.')
    expect(log().scrollTop).toBe(200)

    // Near the bottom (within TEAMMATE_CHAT_STICK_PX), the reply is followed.
    let releaseNext!: () => void
    gate.hold = new Promise((resolve) => (releaseNext = resolve))
    await type('and the other one?')
    expect(log().scrollTop).toBe(1000)
    await scrollTo(1000 - 100 - 20)
    await act(async () => {
      releaseNext()
      await flush()
    })
    expect(log().scrollTop).toBe(1000)
  })
})


describe('TeammateChat — compact: the message stack', () => {
  /** A thread whose history is `n` messages, "Message 1" (yours) to "Message n", alternating. */
  function stubHistory(n: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/account/chat/eve-session') {
          return okJson({ conversationId: 'conv-tm', workspaceId: 'ws-TM', eveSessionId: null, teammate: { id: 'tm-1', name: 'Writer' } })
        }
        if (url === '/api/account/chat-history/conv-tm') {
          return okJson({
            messages: Array.from({ length: n }, (_, i) => ({
              id: `h${i + 1}`,
              role: i % 2 ? 'assistant' : 'user',
              parts: [{ type: 'text', text: `Message ${i + 1}` }],
            })),
          })
        }
        return okJson({}, 404)
      }),
    )
  }
  async function mount() {
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1', density: 'compact' }))
    })
    await act(async () => {
      await flush()
    })
  }
  const log = () => container.querySelector<HTMLElement>('[role="log"]')!
  const toggle = () => container.querySelector<HTMLButtonElement>('[data-teammate-chat-earlier]')
  const folded = () => [...container.querySelectorAll<HTMLElement>('[data-teammate-chat-stacked]')].map((e) => e.dataset.teammateChatMessage)
  const message = (id: string) => container.querySelector<HTMLElement>(`[data-teammate-chat-message="${id}"]`)!

  it('folds the older messages into the stack, still in the log; the newest show in full; its toggle opens it and folds it back', async () => {
    expect(TEAMMATE_CHAT_STACK_SHOWN).toBe(2)
    stubHistory(5)
    await mount()
    // Every message is in the log, the folded ones too (a screen reader reads them all).
    for (let i = 1; i <= 5; i++) expect(log().textContent).toContain(`Message ${i}`)
    expect(folded()).toEqual(['h1', 'h2', 'h3'])
    // The newest two in full.
    for (const id of ['h4', 'h5']) {
      expect(log().contains(message(id))).toBe(true)
      expect(message(id).hasAttribute('data-teammate-chat-stacked')).toBe(false)
    }
    // The stack's face says what's in it, and drives the log.
    expect(toggle()!.getAttribute('aria-label')).toBe('Show 3 earlier messages')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
    expect(toggle()!.getAttribute('aria-controls')).toBe(log().id)
    // Folded, the log doesn't take the pointer (only its cards do).
    expect(log().classList).not.toContain('pointer-events-auto')

    const button = toggle()!
    button.focus()
    await act(async () => button.click())
    expect(folded()).toEqual([])
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Show less')
    // One button either way: focus stays on it as it turns.
    expect(toggle()).toBe(button)
    expect(document.activeElement).toBe(button)
    // Open, the history takes the pointer, so it scrolls anywhere in it.
    expect(log().classList).toContain('pointer-events-auto')

    await act(async () => button.click())
    expect(folded()).toEqual(['h1', 'h2', 'h3'])
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('never opens history on hover, and a clicked history stays open as the pointer leaves', async () => {
    stubHistory(5)
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const button = toggle()!
      await act(async () => {
        button.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(folded()).toEqual(['h1', 'h2', 'h3'])
      await act(async () => button.click())
      await act(async () => {
        button.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(folded()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens as focus moves into a folded message, and folds back as focus leaves', async () => {
    stubHistory(4)
    await mount()
    expect(folded()).toEqual(['h1', 'h2'])
    // Something focusable in a folded message (the real ChatMessage has its Copy / Read aloud).
    const inside = document.createElement('button')
    message('h1').querySelector('[data-role]')!.append(inside)
    await act(async () => inside.focus())
    expect(folded()).toEqual([])
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')

    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    await act(async () => elsewhere.focus())
    expect(folded()).toEqual(['h1', 'h2'])
    elsewhere.remove()
  })

  it('a message of your own folds an open stack, lands at the bottom, and pushes the one before it into the stack', async () => {
    stubHistory(3)
    await mount()
    expect(folded()).toEqual(['h1'])
    await act(async () => toggle()!.click())
    expect(folded()).toEqual([])

    await type('what did you draft?')
    // Yours and the reply in full; everything before them folded.
    expect(folded()).toEqual(['h1', 'h2', 'h3'])
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
    const shown = [...log().querySelectorAll<HTMLElement>('[data-teammate-chat-message]:not([data-teammate-chat-stacked])')]
    expect(shown.map((e) => e.textContent)).toEqual(['what did you draft?', 'Hi from Writer'])
  })

  it('has no stack in the default density', async () => {
    stubHistory(5)
    await act(async () => {
      root.render(h(TeammateChat, { teammateId: 'tm-1' }))
    })
    await act(async () => {
      await flush()
    })
    expect(log().textContent).toContain('Message 1')
    expect(toggle()).toBeNull()
    expect(container.querySelector('[data-teammate-chat-stacked]')).toBeNull()
  })
})
