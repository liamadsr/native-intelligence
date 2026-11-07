// @vitest-environment jsdom
/**
 * <LiveChat> + useLiveChat: the call's live agent's own chat, over a real
 * useChat with a scripted eve transport (its own tests pin the wire). Pins:
 *   - every send carries the conversation, the live agent and liveCaptureId,
 *     on a transport built for that conversation;
 *   - the thread loads the conversation's messages, and rows the server writes
 *     (say_to_user, the proposals card) merge in live, by id;
 *   - the ambient loop's question is answered via messages/answer, and the
 *     answer goes as the person's message; typed words answer it too, flagged
 *     typed; a dismissal sends nothing;
 *   - collapsed shows the last two exchanges, expanded (the box focused) all;
 *     Escape collapses;
 *   - a `beforeSend` that never settles holds the send back only its cap;
 *   - a heads-up heard as a broadcast shows once;
 *   - the box wears the glow its host hands it (the HUD's audio-reactive
 *     call glow: ./call-glow.test.tsx), inside the box, and the chat adds
 *     no glow of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/loader', () => ({ Loader: () => h('span', { 'data-loader': '' }) }))
vi.mock('@/app/account/(dashboard)/chat/chat-proposals-card', () => ({
  ChatProposalsCard: ({ proposalIds }: { proposalIds: string[] }) => h('div', { 'data-proposals-card': proposalIds.join(',') }),
}))

// The Realtime channel the thread's live bridge opens: its handlers by event.
const live = vi.hoisted(() => ({ handlers: new Map<string, (p: { new: unknown }) => void>(), topics: [] as string[] }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      live.topics.push(name)
      const ch = {
        on: (_e: string, cfg: { event: string }, handler: (p: { new: unknown }) => void) => {
          live.handlers.set(cfg.event, handler)
          return ch
        },
        subscribe: () => ch,
      }
      return ch
    },
    removeChannel: () => {},
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-1', user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}))

// Set to hold a reply mid-stream (busy) until it resolves.
const streamCtl = vi.hoisted(() => ({ hold: null as null | Promise<void> }))
const transports: Array<{ opts: Record<string, unknown>; sends: Array<{ body?: Record<string, unknown> }> }> = []
vi.mock('@/lib/chat/eve/eve-chat-transport', () => ({
  EveChatTransport: class {
    record: { opts: Record<string, unknown>; sends: Array<{ body?: Record<string, unknown> }> }
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, sends: [] }
      transports.push(this.record)
    }
    async sendMessages(options: { body?: Record<string, unknown> }) {
      this.record.sends.push(options)
      const hold = streamCtl.hold
      return new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'start' })
          controller.enqueue({ type: 'text-start', id: 't1' })
          if (hold) await hold
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'They said **forty**.' })
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

import { LiveChat } from '../live-chat'
import { BEFORE_SEND_CAP_MS, LIVE_CHAT_THROTTLE_MS, __resetLiveChatsForTests } from '../use-live-chat'

const TARGET = { captureId: 'cap-1', conversationId: 'conv-1', agentId: 'agent-7', workspaceId: 'ws-1' }

let container: HTMLDivElement
let root: Root
let history: UIMessage[]
let calls: Array<{ url: string; init?: RequestInit }>

// Past the chat's render throttle too (LIVE_CHAT_THROTTLE_MS): a streamed or merged change shows after it.
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, LIVE_CHAT_THROTTLE_MS + 10)) })

beforeEach(() => {
  streamCtl.hold = null
  transports.length = 0
  live.handlers.clear()
  live.topics.length = 0
  history = []
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.startsWith('/api/account/chat-history/conv-1') && !init?.method) {
      return { ok: true, status: 200, json: async () => ({ messages: history }) } as Response
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
  }))
  // The HUD's box is ~430px wide: wide enough for its placeholder.
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(430)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetLiveChatsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(props: Partial<Parameters<typeof LiveChat>[0]> = {}) {
  await act(async () => root.render(h(LiveChat, { ...TARGET, ...props })))
  await flush()
}

const box = () => container.querySelector('textarea') as HTMLTextAreaElement
async function type(text: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(box(), text)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = () => act(async () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
const rowIds = () => [...container.querySelectorAll('[data-row-id]')].map((el) => el.getAttribute('data-row-id'))

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const reply = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })
const askRow = (state = 'input-available') =>
  ({
    id: 'q-row',
    role: 'assistant',
    parts: [{ type: 'tool-ask_user', toolCallId: 'tc-1', state, input: { questions: [{ header: 'Quick question', question: 'Which project?', options: [{ label: 'Apollo' }, { label: 'Zeus' }], multiSelect: false }] } }],
    metadata: { kind: 'ask_user', live_capture: true },
  }) as unknown as UIMessage

describe('sending', () => {
  it('carries the conversation, the live agent and liveCaptureId', async () => {
    await mount()
    expect(transports).toHaveLength(1)
    const t = transports[0]
    expect((t.opts.getConversationId as () => string)()).toBe('conv-1')
    expect((t.opts.workspaceId as () => string)()).toBe('ws-1')
    await type('what did they say about price?')
    await enter()
    await flush()
    expect(t.sends).toHaveLength(1)
    expect(t.sends[0].body).toMatchObject({
      conversationId: 'conv-1',
      agentId: 'agent-7',
      systemContext: { liveCaptureId: 'cap-1' },
    })
    expect(box().value).toBe('')
    // Yours on the right, the reply as the agent's card, its markdown plain.
    expect(container.querySelector('[data-row-kind="user"]')!.textContent).toBe('what did they say about price?')
    expect(container.querySelector('[data-row-kind="reply"]')!.textContent).toContain('They said forty.')
  })

  it('sends no agent for the built-in Assistant', async () => {
    await mount({ agentId: null })
    await type('hi')
    await enter()
    await flush()
    expect(transports[0].sends[0].body).not.toHaveProperty('agentId')
  })

  it("never waits on beforeSend past its cap, and runs it before each send", async () => {
    const beforeSend = vi.fn(() => new Promise<void>(() => {}))
    await mount({ beforeSend })
    await type('hello')
    await enter()
    await flush()
    expect(beforeSend).toHaveBeenCalledTimes(1)
    expect(transports[0].sends).toHaveLength(0)
    await act(async () => { await new Promise((r) => setTimeout(r, BEFORE_SEND_CAP_MS + 50)) })
    await flush()
    expect(transports[0].sends).toHaveLength(1)
  }, 10_000)
})

describe('the thread', () => {
  it('loads the conversation and merges what the server writes, by id', async () => {
    history = [reply('greet', 'Listening in.')]
    await mount()
    expect(calls.some((c) => c.url === '/api/account/chat-history/conv-1' && (c.init?.headers as Record<string, string>)['x-workspace-id'] === 'ws-1')).toBe(true)
    expect(rowIds()).toEqual(['greet'])
    expect(live.topics.some((t) => t.startsWith('live-convo:conv-1:'))).toBe(true)

    // A heads-up lands, then the proposals card, then the card grows in place.
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: { id: 's1', role: 'assistant', parts: [{ type: 'text', text: 'Ask about timing.' }], metadata: { kind: 'say_to_user', nudge_kind: 'reminder' } } } }))
    const card = (ids: string[]) => ({ id: 'proposals-cap-1', role: 'assistant', parts: [{ type: 'data-proposals', data: { capture_id: 'cap-1', proposal_ids: ids } }], metadata: { kind: 'proposals' } })
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: card(['p1']) } }))
    await act(async () => live.handlers.get('UPDATE')!({ new: { ui_message: card(['p1', 'p2']) } }))
    await flush()
    expect(rowIds()).toEqual(['greet', 's1'])
    expect(container.querySelector('[data-row-kind="say"]')!.textContent).toContain('Reminder')
    const line = container.querySelector('[data-live-proposals] button')!
    expect(line.textContent).toBe('2 items captured')
    // The full card only once opened.
    expect(container.querySelector('[data-proposals-card]')).toBeNull()
    await act(async () => (line as HTMLButtonElement).click())
    expect(container.querySelector('[data-proposals-card]')!.getAttribute('data-proposals-card')).toBe('p1,p2')
  })

  it('collapsed shows the last two exchanges; expanded while the box has focus; Escape collapses', async () => {
    history = [user('u1', 'one'), reply('a1', 'r1'), user('u2', 'two'), reply('a2', 'r2'), user('u3', 'three'), reply('a3', 'r3')]
    const onExpandedChange = vi.fn()
    await mount({ onExpandedChange })
    const root = container.querySelector('[data-live-chat]')!
    expect(root.getAttribute('data-expanded')).toBe('false')
    expect(rowIds()).toEqual(['u2', 'a2', 'u3', 'a3'])
    await act(async () => box().focus())
    expect(root.getAttribute('data-expanded')).toBe('true')
    expect(rowIds()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(onExpandedChange).toHaveBeenLastCalledWith(true)
    await act(async () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(root.getAttribute('data-expanded')).toBe('false')
    expect(onExpandedChange).toHaveBeenLastCalledWith(false)
  })

  it('a controlled hold keeps it expanded', async () => {
    history = [user('u1', 'one'), reply('a1', 'r1'), user('u2', 'two'), reply('a2', 'r2'), user('u3', 'three')]
    await mount({ expanded: true })
    expect(rowIds()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
  })

  it('shows a broadcast heads-up once: dropped when the conversation holds it', async () => {
    history = [user('u1', 'hi')]
    await mount({ nudges: [{ id: 'n1', message: 'Mention the pilot.', kind: 'suggestion' }] })
    expect(rowIds()).toEqual(['u1', 'n1'])
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: { id: 's9', role: 'assistant', parts: [{ type: 'text', text: 'Mention the pilot.' }], metadata: { kind: 'say_to_user' } } } }))
    expect(rowIds()).toEqual(['u1', 's9'])
  })

  it('a broadcast heads-up and its row share one id: the row takes its place, under the same key', async () => {
    history = [user('u1', 'hi')]
    await mount({ nudges: [{ id: 'n1', message: 'Mention the pilot.', kind: 'suggestion' }] })
    expect(rowIds()).toEqual(['u1', 'n1'])
    // Different words on purpose: the id is what matches.
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: { id: 'n1', role: 'assistant', parts: [{ type: 'text', text: 'Mention the pilot, please.' }], metadata: { kind: 'say_to_user' } } } }))
    expect(rowIds()).toEqual(['u1', 'n1'])
  })
})

// The HUD's telemetry (components/live-hud/use-hud-telemetry.ts) counts a
// heads-up as displayed when the chat draws it: told once, with its source.
describe('heads-ups drawn, for the host', () => {
  const say = (id: string, text: string, kind = 'insight') =>
    ({ id, role: 'assistant', parts: [{ type: 'text', text }], metadata: { kind: 'say_to_user', nudge_kind: kind } }) as unknown as UIMessage

  it('tells the host each heads-up once, the first time it is drawn, with where its row came from', async () => {
    history = [user('u1', 'hi')]
    const onSayShown = vi.fn()
    await mount({ nudges: [{ id: 'n1', message: 'Mention the pilot.', kind: 'suggestion' }], onSayShown })
    expect(onSayShown).toHaveBeenCalledTimes(1)
    expect(onSayShown).toHaveBeenLastCalledWith({ id: 'n1', kind: 'suggestion', source: 'broadcast' })

    // Its row lands under the same id: drawn already, not told again.
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: say('n1', 'Mention the pilot.', 'suggestion') } }))
    await flush()
    expect(onSayShown).toHaveBeenCalledTimes(1)

    // One that only ever came as a conversation row.
    await act(async () => live.handlers.get('INSERT')!({ new: { ui_message: say('s2', 'Ask about timing.', 'reminder') } }))
    await flush()
    expect(onSayShown).toHaveBeenCalledTimes(2)
    expect(onSayShown).toHaveBeenLastCalledWith({ id: 's2', kind: 'reminder', source: 'conversation' })
  })

  it('a heads-up collapsed out of view is not drawn, so not told, until the chat expands', async () => {
    history = [say('s0', 'Early one.'), user('u1', 'one'), reply('a1', 'r1'), user('u2', 'two'), reply('a2', 'r2'), user('u3', 'three'), reply('a3', 'r3')]
    const onSayShown = vi.fn()
    await mount({ onSayShown })
    expect(rowIds()).not.toContain('s0')
    expect(onSayShown).not.toHaveBeenCalled()
    await act(async () => box().focus())
    expect(rowIds()).toContain('s0')
    expect(onSayShown).toHaveBeenCalledWith({ id: 's0', kind: 'insight', source: 'conversation' })
  })
})

describe("the call's glow on the box", () => {
  it("wears the host's glow inside the box, and none of its own", async () => {
    await mount()
    expect(container.querySelector('[data-test-glow]')).toBeNull()
    expect(container.querySelector('[data-hud-audio-glow], [data-hud-call-glow]')).toBeNull()
    await mount({ glow: h('div', { 'data-test-glow': '' }) })
    const glow = container.querySelector('[data-test-glow]')!
    expect(glow.parentElement!.contains(box())).toBe(true)
    expect(glow.parentElement!.className).toContain('relative')
    expect(glow.parentElement!.className).toContain('isolate')
  })
})

describe("the ambient loop's question", () => {
  const patches = () => calls.filter((c) => c.init?.method === 'PATCH')

  it('a choice answers it via messages/answer and goes as your message', async () => {
    history = [askRow()]
    await mount()
    expect(container.querySelector('[data-live-question="tc-1"]')!.textContent).toContain('Which project?')
    expect(box().placeholder).toBe('Type your answer…')
    const apollo = [...container.querySelectorAll('[data-live-question] button')].find((b) => b.textContent === 'Apollo') as HTMLButtonElement
    await act(async () => apollo.click())
    await flush()
    expect(patches()).toHaveLength(1)
    expect(patches()[0].url).toBe('/api/account/chat-history/conv-1/messages/answer')
    expect(JSON.parse(patches()[0].init!.body as string)).toEqual({ tool_call_id: 'tc-1', output: { answers: { 'Which project?': 'Apollo' } } })
    expect(container.querySelector('[data-live-question]')).toBeNull()
    expect(transports[0].sends).toHaveLength(1)
    expect(transports[0].sends[0].body).toMatchObject({ systemContext: { liveCaptureId: 'cap-1' }, agentId: 'agent-7' })
    expect(container.querySelector('[data-row-kind="user"]')!.textContent).toBe('Apollo')
  })

  it('typed words answer it too, flagged typed', async () => {
    history = [askRow()]
    await mount()
    await type('the Hermes one')
    await enter()
    await flush()
    expect(JSON.parse(patches()[0].init!.body as string)).toEqual({ tool_call_id: 'tc-1', output: { response: 'the Hermes one', typed: true } })
    expect(transports[0].sends).toHaveLength(1)
  })

  it('a dismissal closes it and sends nothing', async () => {
    history = [askRow()]
    await mount()
    await act(async () => (container.querySelector('[aria-label="Dismiss question"]') as HTMLButtonElement).click())
    await flush()
    expect(JSON.parse(patches()[0].init!.body as string)).toEqual({ tool_call_id: 'tc-1', output: { response: '(dismissed)' } })
    expect(transports[0].sends).toHaveLength(0)
    expect(container.querySelector('[data-live-question]')).toBeNull()
  })
})
