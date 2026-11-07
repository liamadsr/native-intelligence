// @vitest-environment jsdom
/**
 * Replying to an item in the bubble goes to THAT run's chat (bots-v2.md
 * "Items continue their run's chat"): <TeammateChat about={{ runId, title }}>
 * talks to the run's parked session (useRunChat → RunChatTransport →
 * /api/account/agent-runs/[id]/chat), not the teammate's own thread, with a
 * quiet "About: <title>" line and the way back to the teammate's thread (and
 * back again). A run whose chat the route refuses (someone else started it)
 * falls back to the teammate's thread, saying why. The conversation is the
 * run's, shared: the run's view in a tab (RunChat) shows what the bubble sent,
 * and it outlives the bubble. What's typed is kept per run, and stays in the
 * one box when the chat changes under it. A run asking a question: what's
 * sent answers it (the respond route), "Answering: <title>"; one it isn't the
 * user's to answer goes to the teammate. The bubble reads a run's history
 * only once the item has been on show a moment; a read that fails in passing
 * keeps the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/app/account/(dashboard)/chat/chat-message', () => ({
  ChatMessage: ({ message }: { message: { role: string; parts: Array<Record<string, unknown>> } }) =>
    h('div', { 'data-role': message.role }, message.parts.map((p) => (p.type === 'text' ? (p.text as string) : '')).join(' ')),
}))
vi.mock('@/app/account/(dashboard)/chat/question-picker', () => ({
  QuestionPicker: () => h('div', { 'data-testid': 'picker' }),
  AnsweredQuestionsSummary: () => null,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    // A bot's thread's live bridge for relayed messages (bots v4 A4): subscribes, nothing arrives.
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-1', user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}))
// The teammate's own thread: a scripted transport that replies "Hi from Writer".
const mateSends: string[] = []
/** What each send to the teammate's thread was about (bots v3 1d: body.teammateAbout), null for nothing. */
const mateAbouts: unknown[] = []
vi.mock('@/lib/chat/eve/eve-chat-transport', () => ({
  EveChatTransport: class {
    async sendMessages(options: { messages: Array<{ parts: Array<{ type: string; text?: string }> }>; body?: { teammateAbout?: unknown } }) {
      mateSends.push(options.messages.at(-1)!.parts.map((p) => p.text ?? '').join(''))
      mateAbouts.push(options.body?.teammateAbout ?? null)
      return new ReadableStream({
        start(c) {
          c.enqueue({ type: 'start' })
          c.enqueue({ type: 'text-start', id: 't1' })
          c.enqueue({ type: 'text-delta', id: 't1', delta: 'Hi from Writer' })
          c.enqueue({ type: 'text-end', id: 't1' })
          c.enqueue({ type: 'finish' })
          c.close()
        },
      })
    }
    async reconnectToStream() {
      return null
    }
    async disposeAll() {}
  },
}))

import { TeammateChat } from '../teammate-chat'
import { RunChat } from '@/components/agent-run/run-chat'
import { __resetTeammateChatsForTests } from '@/hooks/use-teammate-chat'
import { __resetRunChatsForTests, RUN_CHAT_BUBBLE_REPLAY_MS } from '@/hooks/use-run-chat'

const RUN = 'run-1'
let container: HTMLDivElement
let root: Root
let runPosts: Array<Record<string, unknown>>
let replay: { status: number; code?: string }
let respondPosts: Array<Record<string, unknown>>
let respondStatus: number
let runRead: { status: string; pending_input: unknown }

function ndjson(lines: unknown[], status = 200): Response {
  const enc = new TextEncoder()
  return {
    ok: status < 400,
    status,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`))
        c.close()
      },
    }),
    json: async () => ({}),
  } as unknown as Response
}
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response

async function flush(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
/** The item on show long enough for the bubble to read its run's chat. */
const shownAMoment = () => act(async () => new Promise((r) => setTimeout(r, RUN_CHAT_BUBBLE_REPLAY_MS + 30)))
const QUESTION = { requestId: 'req-1', approveOptionId: 'approve', denyOptionId: 'cancel', askedAt: 'x', questions: [{ question: 'Which tone?', header: 'Tone', options: [], multiSelect: false }] }

beforeEach(() => {
  runPosts = []
  mateSends.length = 0
  mateAbouts.length = 0
  replay = { status: 200 }
  respondPosts = []
  respondStatus = 200
  runRead = { status: 'needs_input', pending_input: QUESTION }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/account/chat/eve-session') {
        return json({ conversationId: 'conv-tm', workspaceId: 'ws-1', eveSessionId: null, teammate: { id: 'tm-1', name: 'Writer' } })
      }
      if (url === '/api/account/chat-history/conv-tm') return json({ messages: [] })
      if (url === `/api/account/agent-runs/${RUN}/chat`) {
        if (init?.method === 'POST') {
          runPosts.push(JSON.parse(String(init.body)))
          return ndjson([{ type: 'text-delta', delta: 'Made it more formal.' }, { type: 'done' }])
        }
        if (replay.status !== 200) return json({ error: 'no', code: replay.code }, replay.status)
        // The session as it stands: the earlier turn, then every turn sent since.
        const since = runPosts.flatMap((p) => [{ type: 'user-message', text: p.message }, { type: 'text-delta', delta: 'Made it more formal.' }])
        return ndjson([{ type: 'user-message', text: 'Earlier ask' }, { type: 'text-delta', delta: 'Earlier answer' }, ...since, { type: 'done' }])
      }
      if (url === `/api/account/agent-runs/${RUN}`) return json({ run: runRead })
      if (url === `/api/account/agent-runs/${RUN}/respond` && init?.method === 'POST') {
        respondPosts.push(JSON.parse(String(init.body)))
        return json(respondStatus === 200 ? { ok: true } : { code: 'FORBIDDEN' }, respondStatus)
      }
      return json({}, 404)
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  __resetTeammateChatsForTests()
  __resetRunChatsForTests()
  vi.unstubAllGlobals()
})

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
async function typeAndSend(text: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
  })
  await settle()
}
const about = (over: Record<string, unknown> = {}) => ({ runId: RUN, title: 'Reply to Acme', ...over })

describe('a reply about an item goes to its run’s chat', () => {
  it('shows “About: <title>”, the run’s earlier turns, and sends to the run (never the teammate’s thread)', async () => {
    const onAboutChange = vi.fn()
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about(), onAboutChange, density: 'compact' })))
    await shownAMoment()
    const line = container.querySelector('[data-teammate-chat-about]')!
    expect(line.getAttribute('data-teammate-chat-about')).toBe('on')
    expect(line.textContent).toContain('About: Reply to Acme')
    expect(container.textContent).toContain('Earlier answer')
    await typeAndSend('Make it more formal')
    expect(runPosts).toEqual([{ message: 'Make it more formal' }])
    expect(mateSends).toEqual([])
    expect(container.textContent).toContain('Made it more formal.')
    // The way back to the teammate's own thread.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-teammate-chat-about-switch="teammate"]')!.click())
    expect(onAboutChange).toHaveBeenCalledWith(false)
  })

  it('a person’s own run a bot was routed to (bots-v4 Phase 5): “Your run’s chat”, the run’s own chat, never the bot speaking', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about({ own: true }), density: 'compact' })))
    await shownAMoment()
    const line = container.querySelector('[data-teammate-chat-about]')!
    expect(line.textContent).toContain('Your run’s chat: Reply to Acme')
    expect(line.textContent).not.toContain('About:')
    // The box speaks to the run, not to the bot it came through.
    expect(textarea().placeholder).not.toContain('Writer')
    await typeAndSend('Make it more formal')
    expect(runPosts).toEqual([{ message: 'Make it more formal' }])
    expect(mateSends).toEqual([])
  })

  it('switched off for the item: the teammate’s own thread, and the way back to the item’s chat', async () => {
    const onAboutChange = vi.fn()
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about({ off: true }), onAboutChange })))
    await settle()
    expect(container.querySelector('[data-teammate-chat-about]')!.getAttribute('data-teammate-chat-about')).toBe('off')
    await typeAndSend('Anything else today?')
    expect(mateSends).toEqual(['Anything else today?'])
    expect(runPosts).toEqual([])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-teammate-chat-about-switch="item"]')!.click())
    expect(onAboutChange).toHaveBeenCalledWith(true)
  })

  it('a run someone else started (the route says 403): the teammate’s own thread, and the line says why', async () => {
    replay = { status: 403, code: 'FORBIDDEN' }
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about() })))
    await shownAMoment()
    const line = container.querySelector('[data-teammate-chat-about]')!
    expect(line.getAttribute('data-teammate-chat-about')).toBe('refused')
    expect(line.textContent).toBe('Someone else started this run, so this goes to Writer’s own chat.')
    await typeAndSend('Hello')
    expect(mateSends).toEqual(['Hello'])
    expect(runPosts).toEqual([])
  })

  it('with no item about: the teammate’s thread, as before, and no line', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1' })))
    await settle()
    expect(container.querySelector('[data-teammate-chat-about]')).toBeNull()
    await typeAndSend('Hi')
    expect(mateSends).toEqual(['Hi'])
  })

  it('the run’s conversation is shared and outlives the bubble: the run’s view in a tab shows what the bubble sent, read afresh', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about() })))
    await shownAMoment()
    await typeAndSend('Make it more formal')
    // The bubble closes; the run's view opens in a tab.
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(h(RunChat, { runId: RUN })))
    await settle()
    expect(container.textContent).toContain('Make it more formal')
    expect(container.textContent).toContain('Made it more formal.')
    const replays = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(
      ([url, init]) => url === `/api/account/agent-runs/${RUN}/chat` && init?.method !== 'POST',
    )
    // Once as the bubble showed it, once more as the tab showed it again (idle: turns sent elsewhere show).
    expect(replays).toHaveLength(2)
  })

  it('shown again, an idle run chat reads its history afresh: a turn sent from somewhere else shows', async () => {
    await act(async () => root.render(h(RunChat, { runId: RUN })))
    await settle()
    expect(container.textContent).not.toContain('Sent from the run page')
    act(() => root.unmount())
    // Meanwhile, the run's own page (or another device) sent a turn.
    runPosts.push({ message: 'Sent from the run page' })
    root = createRoot(container)
    await act(async () => root.render(h(RunChat, { runId: RUN })))
    await settle()
    expect(container.textContent).toContain('Sent from the run page')
  })

  it('paging past an item reads nothing: the bubble reads its run’s chat only once it has been on show a moment', async () => {
    const reads = () =>
      (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(
        ([url, init]) => url === `/api/account/agent-runs/${RUN}/chat` && init?.method !== 'POST',
      ).length
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about() })))
    await settle()
    // Paged on before the moment was up.
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: null })))
    await shownAMoment()
    expect(reads()).toBe(0)
    // Typed at once: it isn't held up, and the send reads first.
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about() })))
    await settle()
    await typeAndSend('Quick one')
    expect(runPosts).toEqual([{ message: 'Quick one' }])
    expect(reads()).toBe(1)
  })

  it('a history read that fails in passing (500, 401) is no refusal: the composer stays, and the send goes to the run', async () => {
    for (const status of [500, 401]) {
      replay = { status }
      await act(async () => root.render(h(RunChat, { runId: RUN })))
      await settle()
      expect(container.querySelector('[data-run-chat-refused]')).toBeNull()
      expect(textarea()).not.toBeNull()
      act(() => root.unmount())
      __resetRunChatsForTests()
      root = createRoot(container)
    }
    replay = { status: 500 }
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about() })))
    await shownAMoment()
    expect(container.querySelector('[data-teammate-chat-about]')!.getAttribute('data-teammate-chat-about')).toBe('on')
    replay = { status: 200 }
    await typeAndSend('Try again')
    expect(runPosts).toEqual([{ message: 'Try again' }])
    expect(mateSends).toEqual([])
  })

  it('one box: what’s typed stays in it when the chat changes under it (and moves to that chat’s draft); an empty box takes that chat’s draft', async () => {
    const render = (a: ReturnType<typeof about> | null) =>
      act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: a })))
    await render(about())
    await settle()
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(textarea(), 'half a thought')
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
    const box = textarea()
    box.focus()
    await render(null)
    await settle()
    // The same box, still focused, still holding it.
    expect(textarea()).toBe(box)
    expect(document.activeElement).toBe(box)
    expect(textarea().value).toBe('half a thought')
    await typeAndSend('half a thought')
    expect(mateSends).toEqual(['half a thought'])
    // Back on the item: its draft moved with the text, so nothing's waiting there.
    await render(about())
    await settle()
    expect(textarea().value).toBe('')
  })
})

describe('a reply to a run asking a question answers it', () => {
  const asking = (over: Record<string, unknown> = {}) => about({ asking: true, workspaceId: 'ws-2', ...over })

  it('“Answering: <title>”; what’s sent goes to the respond route as the answer, never the run’s chat or the teammate', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: asking() })))
    await shownAMoment()
    const line = () => container.querySelector('[data-teammate-chat-about]')!
    expect(line().getAttribute('data-teammate-chat-about')).toBe('asking')
    expect(line().textContent).toContain('Answering: Reply to Acme')
    await typeAndSend('Use the formal tone')
    expect(respondPosts).toEqual([{ answers: [{ question: 'Which tone?', answer: 'Use the formal tone' }] }])
    // The question is read in the run's own workspace.
    const read = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.find(([url]) => url === `/api/account/agent-runs/${RUN}`)!
    expect(read[1]?.headers).toEqual({ 'x-workspace-id': 'ws-2' })
    expect(runPosts).toEqual([])
    expect(mateSends).toEqual([])
    expect(line().getAttribute('data-teammate-chat-about')).toBe('answered')
    expect(line().textContent).toBe('Answer sent. Writer picks up from there.')
    // Its chat isn't read while it asks (the route would refuse: not settled).
    const replays = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([url]) => url === `/api/account/agent-runs/${RUN}/chat`)
    expect(replays).toHaveLength(0)
  })

  it('one it isn’t the user’s to answer (403), or that stopped asking: the teammate’s own thread, and the line says why', async () => {
    respondStatus = 403
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: asking() })))
    await settle()
    await typeAndSend('Formal please')
    expect(respondPosts).toHaveLength(1)
    expect(mateSends).toEqual(['Formal please'])
    const line = container.querySelector('[data-teammate-chat-about]')!
    expect(line.getAttribute('data-teammate-chat-about')).toBe('refused')
    expect(line.textContent).toBe('Someone else started this run, so this goes to Writer’s own chat.')
    // Further messages go straight to the teammate.
    await typeAndSend('And another')
    expect(respondPosts).toHaveLength(1)
    expect(mateSends).toEqual(['Formal please', 'And another'])
  })

  it('a run no longer asking when the answer goes: nothing posted to respond, the teammate’s thread', async () => {
    runRead = { status: 'queued', pending_input: null }
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: asking() })))
    await settle()
    await typeAndSend('Formal please')
    expect(respondPosts).toEqual([])
    expect(mateSends).toEqual(['Formal please'])
    expect(container.querySelector('[data-teammate-chat-about]')!.textContent).toContain('isn’t waiting on an answer')
  })

  it('switched off for the item: the teammate’s own thread, as any item', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: asking({ off: true }) })))
    await settle()
    await typeAndSend('Unrelated')
    expect(respondPosts).toEqual([])
    expect(mateSends).toEqual(['Unrelated'])
  })
})

describe('talk about this run (bots v3 1d): an item with no run chat', () => {
  const JOB = '77777777-7777-4777-8777-777777777777'
  const loop = (over: Record<string, unknown> = {}) => ({ context: { workItemId: JOB }, title: 'Proposal Triage: 3 need you', ...over })

  it('keeps the teammate’s own thread under the same “About:” line, and every send carries the item', async () => {
    const onAboutChange = vi.fn()
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: loop(), onAboutChange, density: 'compact' })))
    await settle()
    const line = container.querySelector('[data-teammate-chat-about]')!
    expect(line.getAttribute('data-teammate-chat-about')).toBe('on')
    expect(line.textContent).toContain('About: Proposal Triage: 3 need you')
    await typeAndSend('Why did you dismiss the second one?')
    expect(mateSends).toEqual(['Why did you dismiss the second one?'])
    expect(mateAbouts).toEqual([{ workItemId: JOB }])
    // No run chat is read for it.
    const runReads = (fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.filter(([url]) => url.includes('/agent-runs/'))
    expect(runReads).toHaveLength(0)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-teammate-chat-about-switch="teammate"]')!.click())
    expect(onAboutChange).toHaveBeenCalledWith(false)
  })

  it('switched off: the same thread, and the item no longer rides along', async () => {
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: loop({ off: true }), onAboutChange: vi.fn() })))
    await settle()
    expect(container.querySelector('[data-teammate-chat-about]')!.getAttribute('data-teammate-chat-about')).toBe('off')
    await typeAndSend('Anything else?')
    expect(mateAbouts).toEqual([null])
  })

  it('a run whose chat is refused falls back to the teammate’s thread with its item attached', async () => {
    replay = { status: 403, code: 'FORBIDDEN' }
    await act(async () => root.render(h(TeammateChat, { teammateId: 'tm-1', workspaceId: 'ws-1', about: about({ context: { workItemId: JOB } }) })))
    await shownAMoment()
    expect(container.querySelector('[data-teammate-chat-about]')!.getAttribute('data-teammate-chat-about')).toBe('refused')
    await typeAndSend('Hello')
    expect(mateSends).toEqual(['Hello'])
    expect(mateAbouts).toEqual([{ workItemId: JOB }])
  })
})

