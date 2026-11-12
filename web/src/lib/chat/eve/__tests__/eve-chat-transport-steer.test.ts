// @vitest-environment jsdom
/**
 * Steering the running reply with a held message (UI-2, docs/plans/
 * always-on-agent.md §2b): EveChatTransport.requestSteer POSTs the message to
 * the eve session beside useChat at the first opening (steer-opening.ts),
 * keeps eve's response unread, and the flush's send (`body.steerId`) adopts
 * that response instead of minting and POSTing again.
 *
 * Pinned here, against a fake eve client:
 *  - applied mid-turn: the prior turn settles at the steer point, the adopted
 *    turn renders the rest, nothing twice, each step.completed counted once;
 *  - holds while a tool runs (before output) and while answer text streams;
 *  - fell through (the prior ended first) → the next turn;
 *  - withdraw before and after the POST; a failed POST;
 *  - Send now while posted: a scoped cancel, no drop, the steer adopted —
 *    and the one re-send when eve had folded it into the cancelled turn;
 *  - the park race (a posted steer meets an ask_user park);
 *  - persist order (chained) and metadata (steer, stopped, telemetry);
 *  - one steer in flight at a time;
 *  - the #681 regression with the REAL AI SDK Chat: [u1, a1, u2, a2], unique.
 */
import { describe, it, expect, vi } from 'vitest'
import { Chat } from '@ai-sdk/react'
import { EveChatTransport, STEER_SKIPPED_QUESTION_COPY, type EvePersistBody, type SteerPhase } from '../eve-chat-transport'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'

// ── Fake eve plumbing ─────────────────────────────────────────────────────────

/** An async-iterable event source the test feeds one event at a time. */
function pushable() {
  const queue: HandleMessageStreamEvent[] = []
  let wake: (() => void) | null = null
  let ended = false
  return {
    push(...events: HandleMessageStreamEvent[]) {
      queue.push(...events)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (ended) return
        await new Promise<void>((r) => {
          wake = r
        })
        wake = null
      }
    },
  }
}
type Source = ReturnType<typeof pushable>

type Dispatch = { kind: 'create' | 'send'; message: string; options: Record<string, unknown> }

type HarnessOpts = {
  failSend?: (index: number) => boolean
  /** Hold dispatch `index`'s POST until the returned promise settles. */
  holdSend?: (index: number) => Promise<void> | undefined
  persist?: (body: EvePersistBody) => Promise<void>
  timeouts?: ConstructorParameters<typeof EveChatTransport>[0] extends infer O ? O extends { timeouts?: infer T } ? T : never : never
  /** The main chat's cards and their settling (settleCardContext). */
  cards?: Pick<ConstructorParameters<typeof EveChatTransport>[0], 'getCardContext' | 'settleCardContext'>
}

function harness(sources: Source[], opts: HarnessOpts = {}) {
  const dispatches: Dispatch[] = []
  const response = (i: number) => ({
    sessionId: 'wrun_ABC',
    [Symbol.asyncIterator]: () => sources[i][Symbol.asyncIterator](),
  })
  const send = vi.fn(async (message: string, options: Record<string, unknown> = {}) => {
    dispatches.push({ kind: 'send', message, options })
    const i = dispatches.length - 1
    await opts.holdSend?.(i)
    if (opts.failSend?.(i)) throw Object.assign(new Error('eve refused'), { status: 500 })
    return response(i)
  })
  const cancel = vi.fn(async () => ({ status: 'accepted', sessionId: 'wrun_ABC' }))
  const session = { send, respond: vi.fn(), cancel, state: { sessionId: 'wrun_ABC', streamIndex: 0 } }
  const create = vi.fn(async (input: Record<string, unknown>) => {
    const { message, ...options } = input
    dispatches.push({ kind: 'create', message: message as string, options })
    return { response: response(dispatches.length - 1), session }
  })
  const client = { sessions: { create, attach: vi.fn(() => session) } }
  let n = 0
  const mint = vi.fn(async () => ({ token: `tok-${++n}`, conversationId: 'conv-1' }))
  const persists: EvePersistBody[] = []
  /** Every write in order, the send-time user-message writes (onSend) included. */
  const writes: EvePersistBody[] = []
  const transport = new EveChatTransport({
    getAccessToken: () => 'jwt',
    mintRunToken: mint,
    registerEveSession: async () => {},
    persistTurn: async ({ body }) => {
      writes.push(body)
      if (body.onSend) return
      persists.push(body)
      await opts.persist?.(body)
    },
    createClient: () => client as never,
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.cards ?? {}),
  })
  return { transport, dispatches, cancel, mint, persists, writes, send, client }
}

// ── Events (eve 0.66.3 wire shapes, stamped with the delivery envelope) ───────

const st = (e: object, deliveryIds: string[], id: string): HandleMessageStreamEvent =>
  ({ ...e, meta: { id, at: '2026-10-14T00:00:00.000Z', deliveryIds } }) as unknown as HandleMessageStreamEvent
const turnStarted = (turnId: string) => ({ type: 'turn.started', data: { turnId } })
const messageReceived = (turnId: string) => ({ type: 'message.received', data: { message: 'x', sequence: 0, turnId } })
const reasoning = (delta: string, turnId = 'turn_0') => ({ type: 'reasoning.appended', data: { reasoningDelta: delta, sequence: 0, stepIndex: 0, turnId } })
const text = (delta: string, turnId = 'turn_0') => ({ type: 'message.appended', data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId } })
const inputDelta = (turnId = 'turn_0') => ({ type: 'action.input.appended', data: { callId: 'c1', inputTextDelta: '{"q"', turnId } })
const toolCall = (callId: string, turnId = 'turn_0', toolName = 'search') => ({
  type: 'actions.requested',
  data: { actions: [{ kind: 'tool-call', callId, toolName, input: {} }], turnId },
})
const toolResult = (callId: string, turnId = 'turn_0') => ({
  type: 'action.result',
  data: { result: { kind: 'tool-result', callId, toolName: 'search', output: { ok: true } }, turnId },
})
const stepDone = (turnId = 'turn_0') => ({
  type: 'step.completed',
  data: { finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, turnId },
})
const turnDone = (turnId = 'turn_0') => ({ type: 'turn.completed', data: { turnId } })
const turnCancelled = (turnId = 'turn_0') => ({ type: 'turn.cancelled', data: { turnId } })
const waiting = { type: 'session.waiting', data: {} }
const askUser = (turnId = 'turn_0') => ({
  type: 'input.requested',
  data: {
    turnId,
    requests: [
      {
        requestId: 'req-1',
        display: 'confirmation',
        options: [{ id: 'approve' }, { id: 'cancel' }],
        action: { kind: 'tool-call', callId: 'call-auq', toolName: 'ask_user', input: { questions: [{ question: 'Which env?' }] } },
      },
    ],
  },
})

// ── Send options ─────────────────────────────────────────────────────────────

const firstSend = (abortSignal?: AbortSignal) =>
  ({
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'draft the email' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    abortSignal,
    body: { conversationId: 'conv-1' },
  }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
/** The flush's send of the held message: useChat appended it after the prior reply. */
const steerSend = (steerId: string | null, text = 'actually, make it shorter') =>
  ({
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'draft the email' }] },
      { id: 'a1', role: 'assistant', parts: [] },
      { id: 'm2', role: 'user', parts: [{ type: 'text', text }] },
    ],
    trigger: 'submit-message',
    messageId: undefined,
    body: { conversationId: 'conv-1', ...(steerId ? { steerId } : {}) },
  }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

const flush = () => new Promise((r) => setTimeout(r, 0))
async function settle() {
  for (let i = 0; i < 5; i++) await flush()
}
async function readUntil(reader: ReadableStreamDefaultReader<UIMessageChunk>, pred: (c: UIMessageChunk) => boolean) {
  const out: UIMessageChunk[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(value)
    if (pred(value)) break
  }
  return out
}
const readAll = (reader: ReadableStreamDefaultReader<UIMessageChunk>) => readUntil(reader, () => false)
const textOf = (chunks: UIMessageChunk[]) =>
  chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('')
const partsText = (b: EvePersistBody) =>
  b.parts.filter((p) => p.type === 'text').map((p) => (p as { text?: string }).text).join('')
const steps = (b: EvePersistBody) => b.usage.events.filter((e) => e.type === 'step.completed').length

function request(t: EveChatTransport, phases: SteerPhase[] = [], id = 's1', words = 'actually, make it shorter') {
  return t.requestSteer('chat-1', { id, text: words, body: { conversationId: 'conv-1' }, onState: (p) => phases.push(p) })
}

describe('EveChatTransport — steering the running reply (UI-2)', () => {
  it('a steer settles the card in front first, as a send does: the cards it carries are read after the save', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const log: string[] = []
    let saved = false
    const h = harness([r1, r2], {
      cards: {
        getCardContext: () => {
          log.push(saved ? 'read cards (saved)' : 'read cards')
          return [{ n: 1, id: 'card-studio', kind: 'studio', title: 'Studio' }]
        },
        settleCardContext: async () => {
          log.push('save started')
          await new Promise((r) => setTimeout(r, 15))
          saved = true
          log.push('saved')
        },
      },
    })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    log.length = 0
    saved = false
    expect(request(h.transport, [], 's1', 'and move it up a little')).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    await settle()
    // Posted once the save is done, with the cards read again after it.
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(log.indexOf('saved')).toBeGreaterThan(-1)
    expect(log.indexOf('read cards (saved)')).toBeGreaterThan(log.indexOf('saved'))
    r1.end()
    r2.end()
  })

  it('a steer whose card cannot settle still goes, with the cards as they were', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2], {
      cards: {
        getCardContext: () => [{ n: 1, id: 'card-studio', kind: 'studio', title: 'Studio' }],
        settleCardContext: async () => {
          throw new Error('offline')
        },
      },
    })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const phases: SteerPhase[] = []
    expect(request(h.transport, phases)).toBe(true)
    await settle()
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(phases).toEqual(['posting', 'posted'])
    r1.end()
    r2.end()
  })

  it('a steer that carries a replied-to card names it in the message eve receives (card-reply.ts)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const card = '22222222-2222-4222-8222-222222222222'
    const replyCard = { kind: 'card', id: card, workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Add', sentence: '“Call Dana”' }
    expect(
      h.transport.requestSteer('chat-1', { id: 's1', text: 'make it Friday', body: { conversationId: 'conv-1', systemContext: { replyCard } }, onState: () => {} }),
    ).toBe(true)
    await settle()
    expect(h.dispatches[1].message).toBe(`make it Friday\n\n[Replying to my card ${card}: read it with get_bot_item, item_id ${card}.]`)
    r1.end()
    r2.end()
  })

  it('a steer that replies to a message in the thread quotes it, before the card it also carries (message-reply.ts)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const card = '22222222-2222-4222-8222-222222222222'
    const replyCard = { kind: 'card', id: card, workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Add', sentence: '“Call Dana”' }
    const replyTo = { messageId: 'eve-msg-chat-1-0', role: 'assistant', quote: 'Option B', part: true }
    expect(
      h.transport.requestSteer('chat-1', { id: 's1', text: 'that one', body: { conversationId: 'conv-1', systemContext: { replyTo, replyCard } }, onState: () => {} }),
    ).toBe(true)
    await settle()
    expect(h.dispatches[1].message).toBe(
      `that one\n\n[Replying to this part of your earlier message: "Option B"]\n\n[Replying to my card ${card}: read it with get_bot_item, item_id ${card}.]`,
    )
    r1.end()
    r2.end()
  })

  it('applied before output: POSTs at once beside useChat, the prior settles at the steer point, the flush adopts the response — nothing twice', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')

    const phases: SteerPhase[] = []
    expect(request(h.transport, phases)).toBe(true)
    await settle()
    // Reasoning is not output: eve would interrupt the call, so it goes now.
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(h.dispatches[1].message).toBe('actually, make it shorter')
    expect(h.dispatches[1].options.turnPolicy).toBe('steer')
    expect((h.dispatches[1].options.headers as Record<string, string>)['x-chat-run-token']).toBe('tok-2')
    expect(phases).toEqual(['posting', 'posted'])

    // eve continues turn_0 with the steer: no turn.started, message.received
    // with the same turnId, and every event from there carries d2 too.
    const tail = [
      st(messageReceived('turn_0'), ['d1', 'd2'], 'e3'),
      st(text('Shorter draft.'), ['d1', 'd2'], 'e4'),
      st(stepDone(), ['d1', 'd2'], 'e5'),
      st(turnDone(), ['d1', 'd2'], 'e6'),
      st(waiting, ['d1', 'd2'], 'e7'),
    ]
    r1.push(...tail)
    r1.end()
    r2.push(...tail)
    r2.end()
    const rest1 = await readAll(reader1)
    expect(textOf(rest1)).toBe('')
    expect(rest1[rest1.length - 1].type).toBe('finish')
    expect(phases).toContain('applied')

    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    const chunks2: UIMessageChunk[] = []
    const reader2 = (await h.transport.sendMessages(steerSend('s1'))).getReader()
    chunks2.push(...(await readAll(reader2)))
    await settle()

    // The adoption POSTed and minted nothing more.
    expect(h.dispatches).toHaveLength(2)
    expect(h.mint).toHaveBeenCalledTimes(2)
    expect(textOf(chunks2)).toBe('Shorter draft.')
    expect(chunks2[chunks2.length - 1].type).toBe('finish')

    // Two rows, in order: the prior's part, then the steering message + continuation.
    expect(h.persists).toHaveLength(2)
    const [prior, adopted] = h.persists
    expect(prior.parts.map((p) => p.type)).toEqual(['reasoning'])
    expect(prior.userMessage?.messageId).toBe('m1')
    expect(prior.userMessage?.metadata).toBeUndefined()
    expect(prior.steer).toBeUndefined()
    expect(partsText(adopted)).toBe('Shorter draft.')
    expect(adopted.userMessage).toMatchObject({ messageId: 'm2', metadata: { steer: 'applied' } })
    expect(adopted.steer).toMatchObject({ outcome: 'applied', opening: 'before_output', steers_in_turn: 1 })
    expect(steps(prior) + steps(adopted)).toBe(1)
    expect(prior.metadata.stopped).toBeUndefined()
  })

  it('the steer names the reply its adopted turn renders, and the first send names its own (the reply backup)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('Planning the draft'), ['d1'], 'e2'))
    const before = await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    expect(request(h.transport)).toBe(true)
    await settle()
    const tail = [
      st(messageReceived('turn_0'), ['d1', 'd2'], 'e3'),
      st(text('Shorter draft.'), ['d1', 'd2'], 'e4'),
      st(turnDone(), ['d1', 'd2'], 'e5'),
      st(waiting, ['d1', 'd2'], 'e6'),
    ]
    r1.push(...tail)
    r1.end()
    r2.push(...tail)
    r2.end()
    await readAll(reader1)
    const chunks2 = await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    await settle()

    const replyIdOf = (i: number) => (h.dispatches[i].options.headers as Record<string, string>)['x-chat-reply-id']
    const startOf = (chunks: UIMessageChunk[]) => (chunks.find((c) => c.type === 'start') as { messageId: string }).messageId
    expect(replyIdOf(0)).toBe(startOf(before))
    expect(replyIdOf(1)).toBe(startOf(chunks2))
    expect(replyIdOf(1)).not.toBe(replyIdOf(0))
    // The adopted turn's reply persists under that same id.
    expect(h.persists.filter((b) => b.role === 'assistant').map((b) => b.messageId)).toEqual([replyIdOf(0), replyIdOf(1)])
  })

  it('holds while a tool executes before any answer text, and POSTs at its result', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(toolCall('c1'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'tool-input-available')
    expect(request(h.transport)).toBe(true)
    await settle()
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create']) // held: Edit still works

    r1.push(st(toolResult('c1'), ['d1'], 'e3'))
    await readUntil(reader1, (c) => c.type === 'tool-output-available')
    await settle()
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    r1.end()
    r2.end()
  })

  it('posts at the tool boundary once answer text started and a tool call starts', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('Looking it up.'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'text-delta')
    expect(request(h.transport)).toBe(true)
    await settle()
    expect(h.dispatches).toHaveLength(1) // answer text streaming, no tool: hold

    r1.push(st(inputDelta(), ['d1'], 'e3'))
    await settle()
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    r1.end()
    r2.end()
    await readAll(reader1)
  })

  it('a turn that ends before an opening sends the held message as the next turn, never POSTed', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('All done.'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'text-delta')
    const phases: SteerPhase[] = []
    expect(request(h.transport, phases)).toBe(true)
    await settle()
    r1.push(st(stepDone(), ['d1'], 'e3'), st(turnDone(), ['d1'], 'e4'), st(waiting, ['d1'], 'e5'))
    r1.end()
    await readAll(reader1)
    await settle()
    expect(h.dispatches).toHaveLength(1)

    // The flush: nothing to adopt → an ordinary send (mint + POST).
    expect(h.transport.steerFlushPlan('chat-1', 's1', false)).toBe('send')
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e6'), st(text('Shorter.', 'turn_1'), ['d2'], 'e7'), st(turnDone('turn_1'), ['d2'], 'e8'))
    r2.end()
    const chunks = await readAll((await h.transport.sendMessages(steerSend(null))).getReader())
    expect(textOf(chunks)).toBe('Shorter.')
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(phases).toEqual([])
  })

  it('fell through: posted, but the prior ended first — the adopted response reads the next turn', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const phases: SteerPhase[] = []
    request(h.transport, phases)
    await settle()
    // eve had already committed the final answer: turn_0 ends with d1 only.
    r1.push(st(text('Here it is.'), ['d1'], 'e3'), st(stepDone(), ['d1'], 'e4'), st(turnDone(), ['d1'], 'e5'), st(waiting, ['d1'], 'e6'))
    r1.end()
    const rest1 = await readAll(reader1)
    expect(textOf(rest1)).toBe('Here it is.')
    expect(phases).toEqual(['posting', 'posted', 'next_turn'])

    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e7'), st(text('Shorter.', 'turn_1'), ['d2'], 'e8'), st(stepDone('turn_1'), ['d2'], 'e9'), st(turnDone('turn_1'), ['d2'], 'e10'))
    r2.end()
    const chunks2 = await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    await settle()
    expect(textOf(chunks2)).toBe('Shorter.')
    expect(h.dispatches).toHaveLength(2)
    expect(h.persists[1].userMessage?.metadata).toEqual({ steer: 'next_turn' })
    expect(h.persists[1].steer?.outcome).toBe('next_turn')
    expect(steps(h.persists[0])).toBe(1)
    expect(steps(h.persists[1])).toBe(1)
  })

  it('Edit: a held steer is withdrawn; once its POST started it cannot be', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('Writing.'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'text-delta')

    request(h.transport, [], 's1')
    await settle()
    expect(h.transport.withdrawSteer('chat-1', 's1')).toBe(true)
    // Withdrawn: an opening later never POSTs it.
    r1.push(st(inputDelta(), ['d1'], 'e3'))
    await settle()
    expect(h.dispatches).toHaveLength(1)

    request(h.transport, [], 's2')
    await settle()
    expect(h.dispatches).toHaveLength(2) // the opening is already there
    expect(h.transport.withdrawSteer('chat-1', 's2')).toBe(false)
    r1.end()
    r2.end()
    await readAll(reader1)
  })

  it('a failed POST hands the message back to wait for the end, and the prior keeps its whole stream', async () => {
    const r1 = pushable()
    const h = harness([r1], { failSend: (i) => i === 1 })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const phases: SteerPhase[] = []
    request(h.transport, phases)
    await settle()
    expect(phases).toEqual(['posting', 'failed'])
    expect(h.transport.steerFlushPlan('chat-1', 's1', false)).toBe('send')
    // Not superseded any more: a foreign id (another tab) is adopted, not a cut.
    r1.push(st(text('Full reply.'), ['d1', 'dX'], 'e3'), st(turnDone(), ['d1', 'dX'], 'e4'))
    r1.end()
    expect(textOf(await readAll(reader1))).toBe('Full reply.')
  })

  it('only one steer is in flight: a second request waits (false) while the first is held or posted', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    expect(request(h.transport, [], 's1')).toBe(true)
    expect(request(h.transport, [], 's2')).toBe(false)
    await settle()
    expect(request(h.transport, [], 's2')).toBe(false)
    expect(h.dispatches).toHaveLength(2)
    r1.end()
    r2.end()
  })

  it('nothing to steer: no running turn, or a turn parked on a question', async () => {
    const r1 = pushable()
    const h = harness([r1])
    expect(request(h.transport)).toBe(false)
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(askUser(), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'tool-input-available')
    expect(request(h.transport)).toBe(false)
    r1.end()
  })

  it('Send now while posted: cancels only the prior turn by its id, keeps the session, and the steer runs next — adopted, not re-sent', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const stop = new AbortController()
    const reader1 = (await h.transport.sendMessages(firstSend(stop.signal))).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('A long'), ['d1'], 'e2'), st(toolCall('c1'), ['d1'], 'e3'))
    await readUntil(reader1, (c) => c.type === 'tool-input-available')
    request(h.transport)
    await settle()
    expect(h.dispatches).toHaveLength(2) // answer started + a tool running: posted

    stop.abort() // Send now → handleStop
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.cancel).toHaveBeenCalledWith({ turnId: 'turn_0' })
    await readAll(reader1)
    // eve cancels turn_0; the queued steer stays and runs as turn_1.
    r1.push(st(turnCancelled(), ['d1'], 'e4'))
    r1.end()
    await settle()

    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e5'), st(text('Short version.', 'turn_1'), ['d2'], 'e6'), st(stepDone('turn_1'), ['d2'], 'e7'), st(turnDone('turn_1'), ['d2'], 'e8'))
    r2.end()
    const chunks2 = await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    await settle()
    expect(textOf(chunks2)).toBe('Short version.')
    // The session survived the stop: no re-mint, no re-attach, no second POST.
    expect(h.dispatches).toHaveLength(2)
    expect(h.mint).toHaveBeenCalledTimes(2)

    const [prior, adopted] = h.persists
    expect(prior.metadata.stopped).toBe(true)
    expect(partsText(prior)).toBe('A long')
    expect(adopted.userMessage?.metadata).toEqual({ steer: 'next_turn' })
    expect(adopted.steer).toMatchObject({ outcome: 'next_turn', sent_now: true })
  })

  it('Send now after eve folded the steer into the cancelled turn: the adopted turn re-sends the words once', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const r3 = pushable()
    const h = harness([r1, r2, r3])
    const stop = new AbortController()
    const reader1 = (await h.transport.sendMessages(firstSend(stop.signal))).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    stop.abort()
    expect(h.cancel).toHaveBeenCalledWith({ turnId: 'turn_0' })
    await readAll(reader1)
    // eve had already taken the steer into turn_0 when the cancel landed.
    const folded = [st(messageReceived('turn_0'), ['d1', 'd2'], 'e3'), st(turnCancelled(), ['d1', 'd2'], 'e4'), st(waiting, ['d1', 'd2'], 'e5')]
    r1.push(...folded)
    r1.end()
    r2.push(...folded)
    r2.end()
    await settle()

    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    r3.push(st(turnStarted('turn_1'), ['d3'], 'e6'), st(text('Short version.', 'turn_1'), ['d3'], 'e7'), st(turnDone('turn_1'), ['d3'], 'e8'))
    r3.end()
    const chunks2 = await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    expect(textOf(chunks2)).toBe('Short version.')
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send', 'send'])
    expect(h.dispatches[2].message).toBe('actually, make it shorter')
  })

  it('the park race: a posted steer meets an ask_user park — the picker is skipped, the turn settles, the steer is adopted as the next turn', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    expect(h.dispatches).toHaveLength(2)
    // The model had already committed to ask_user: the approval parks turn_0.
    r1.push(
      st(toolCall('call-auq', 'turn_0', 'ask_user'), ['d1'], 'e3'),
      st(stepDone(), ['d1'], 'e4'),
      st(askUser(), ['d1'], 'e5'),
      st(turnDone(), ['d1'], 'e6'),
      st(waiting, ['d1'], 'e7'),
    )
    r1.end()
    const rest1 = await readAll(reader1) // closes: not left parked
    const skipped = rest1.find((c) => c.type === 'tool-output-available') as { toolCallId: string; output: unknown } | undefined
    expect(skipped).toMatchObject({ toolCallId: 'call-auq', output: { response: STEER_SKIPPED_QUESTION_COPY } })
    expect(rest1[rest1.length - 1].type).toBe('finish')
    await settle()
    expect(h.persists[0].parts.find((p) => p.type === 'dynamic-tool')).toMatchObject({
      state: 'output-available',
      output: { response: STEER_SKIPPED_QUESTION_COPY },
    })

    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e8'), st(text('OK, shorter.', 'turn_1'), ['d2'], 'e9'), st(turnDone('turn_1'), ['d2'], 'e10'))
    r2.end()
    expect(textOf(await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader()))).toBe('OK, shorter.')
    expect(h.dispatches).toHaveLength(2)
  })

  it('the park race never skips a session-limit prompt: eve holds the steer behind it, so the card stays up to answer', async () => {
    const r1 = pushable()
    const h = harness([r1])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    const callId = 'wrun_1:1:limit:input:40000100'
    r1.push(
      st(
        {
          type: 'input.requested',
          data: {
            turnId: 'turn_0',
            requests: [
              {
                requestId: callId,
                kind: 'session-limit',
                display: 'confirmation',
                allowFreeform: false,
                prompt: 'limit',
                options: [{ id: 'continue', label: 'Approve' }, { id: 'stop', label: 'Stop' }],
                action: { kind: 'tool-call', callId, toolName: 'session_limit_continuation', input: { kind: 'input', limit: 40_000_000, usedTokens: 40_000_100 } },
              },
            ],
          },
        },
        ['d1'],
        'e3',
      ),
      st(turnDone(), ['d1'], 'e4'),
      st(waiting, ['d1'], 'e5'),
    )
    r1.end()
    // The card arrives (waited for), then nothing settles it while the stream idles.
    const seen: Array<{ type: string }> = await readUntil(reader1, (c) => c.type === 'tool-input-available')
    await settle()
    for (;;) {
      const next = await Promise.race([reader1.read(), new Promise<null>((r) => setTimeout(() => r(null), 30))])
      if (next === null || next.done) break
      seen.push(next.value)
    }
    expect(seen.find((c) => c.type === 'tool-input-available')).toMatchObject({ toolCallId: callId, toolName: 'session_limit_continuation' })
    expect(seen.some((c) => c.type === 'tool-output-available')).toBe(false)
    expect(seen.some((c) => c.type === 'finish')).toBe(false)
    expect(h.transport.hasOpenInputRequest('chat-1', callId)).toBe(true)
  })

  it('persist order: the steering message and continuation wait for the prior part’s write (chained)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    let releaseFirst: () => void = () => {}
    const firstWrite = new Promise<void>((r) => {
      releaseFirst = r
    })
    let calls = 0
    const h = harness([r1, r2], { persist: () => (++calls === 1 ? firstWrite : Promise.resolve()) })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    const tail = [st(messageReceived('turn_0'), ['d1', 'd2'], 'e3'), st(text('Short.'), ['d1', 'd2'], 'e4'), st(turnDone(), ['d1', 'd2'], 'e5')]
    r1.push(...tail)
    r1.end()
    r2.push(...tail)
    r2.end()
    await readAll(reader1)
    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    await settle()
    expect(h.persists).toHaveLength(1) // the second waits on the first
    releaseFirst()
    await settle()
    expect(h.persists.map((b) => b.userMessage?.messageId)).toEqual(['m1', 'm2'])
  })
})

// ── Review fixes (UI-2) ──────────────────────────────────────────────────────

describe('EveChatTransport — steering review fixes', () => {
  const deferred = () => {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('text, then ask_user: the approval-gated call counts as parked — no steer POST, no skipped picker, the message waits as today', async () => {
    const r1 = pushable()
    const h = harness([r1])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('Before I book it,'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'text-delta')
    const phases: SteerPhase[] = []
    expect(request(h.transport, phases)).toBe(true)
    // Its input streams, then it is requested: neither is a tool boundary.
    r1.push(st({ type: 'action.input.appended', data: { callId: 'call-auq', toolName: 'ask_user', inputTextDelta: '{"q', turnId: 'turn_0' } }, ['d1'], 'e3'))
    r1.push(st(toolCall('call-auq', 'turn_0', 'ask_user'), ['d1'], 'e4'))
    await readUntil(reader1, (c) => c.type === 'tool-input-available')
    await settle()
    expect(h.dispatches).toHaveLength(1)
    r1.push(st(stepDone(), ['d1'], 'e5'), st(askUser(), ['d1'], 'e6'), st(turnDone(), ['d1'], 'e7'), st(waiting, ['d1'], 'e8'))
    r1.end()
    await settle()
    expect(h.dispatches).toHaveLength(1)
    expect(phases).toEqual([])
    expect(h.persists).toHaveLength(0) // still parked on the picker, not skipped
  })

  it('the flush never blocks on a POST in flight: the adopted turn waits inside its stream, then renders', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const post = deferred()
    const h = harness([r1, r2], { holdSend: (i) => (i === 1 ? post.promise : undefined) })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    // eve ends the prior first; the POST is still out.
    r1.push(st(text('Done.'), ['d1'], 'e3'), st(turnDone(), ['d1'], 'e4'))
    r1.end()
    await readAll(reader1)
    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    const reader2 = (await h.transport.sendMessages(steerSend('s1'))).getReader()
    post.resolve()
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e5'), st(text('Short.', 'turn_1'), ['d2'], 'e6'), st(turnDone('turn_1'), ['d2'], 'e7'))
    r2.end()
    expect(textOf(await readAll(reader2))).toBe('Short.')
    expect(h.dispatches).toHaveLength(2)
  })

  it('a POST eve refused after the flush: the words go as an ordinary send (eve never had them)', async () => {
    const r1 = pushable()
    const r3 = pushable()
    const post = deferred()
    const h = harness([r1, pushable(), r3], { holdSend: (i) => (i === 1 ? post.promise : undefined), failSend: (i) => i === 1 })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    r1.push(st(turnDone(), ['d1'], 'e3'))
    r1.end()
    await readAll(reader1)
    const reader2 = (await h.transport.sendMessages(steerSend('s1'))).getReader()
    post.resolve() // → 500
    r3.push(st(turnStarted('turn_1'), ['d3'], 'e4'), st(text('Short.', 'turn_1'), ['d3'], 'e5'), st(turnDone('turn_1'), ['d3'], 'e6'))
    r3.end()
    expect(textOf(await readAll(reader2))).toBe('Short.')
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send', 'send'])
    expect(h.dispatches[2].message).toBe('actually, make it shorter')
  })

  it('a POST that never confirms (bounded wait): the turn errors and the words are NOT sent again', async () => {
    const r1 = pushable()
    const h = harness([r1, pushable()], { holdSend: (i) => (i === 1 ? new Promise<void>(() => {}) : undefined), timeouts: { steerPostWaitMs: 20 } })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    r1.push(st(turnDone(), ['d1'], 'e3'))
    r1.end()
    await readAll(reader1)
    const reader2 = (await h.transport.sendMessages(steerSend('s1'))).getReader()
    await expect(readAll(reader2)).rejects.toThrow(/Couldn’t confirm/)
    expect(h.dispatches).toHaveLength(2)
  })

  it('a network failure mid-POST is "lost", not "failed": the panel is told never to re-send it', async () => {
    const r1 = pushable()
    const h = harness([r1])
    h.send.mockImplementationOnce(async () => {
      h.dispatches.push({ kind: 'send', message: 'x', options: {} })
      throw new TypeError('Failed to fetch')
    })
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const phases: SteerPhase[] = []
    request(h.transport, phases)
    await settle()
    expect(phases).toEqual(['posting', 'lost'])
    r1.end()
  })

  it('a dropped session (agent switch / reset) tells the panel its posted steer is gone; the flush never re-sends it', async () => {
    const r1 = pushable()
    const h = harness([r1, pushable()])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    const phases: SteerPhase[] = []
    request(h.transport, phases)
    await settle()
    await h.transport.resetSession('chat-1')
    expect(phases).toEqual(['posting', 'posted', 'dropped'])
    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('gone')
    // A held one (never sent) still goes as an ordinary send.
    expect(h.transport.steerFlushPlan('chat-1', 's9', false)).toBe('send')
    r1.end()
  })

  it('one slow write never holds back the rest: the chain waits for it at most the cap', async () => {
    const r1 = pushable()
    const r2 = pushable()
    let calls = 0
    const h = harness([r1, r2], {
      persist: () => (++calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()),
      timeouts: { persistChainCapMs: 150 },
    })
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('One.'), ['d1'], 'e2'), st(turnDone(), ['d1'], 'e3'))
    r1.end()
    await readAll((await h.transport.sendMessages(firstSend())).getReader())
    r2.push(st(turnStarted('turn_1'), ['d2'], 'e4'), st(text('Two.', 'turn_1'), ['d2'], 'e5'), st(turnDone('turn_1'), ['d2'], 'e6'))
    r2.end()
    await readAll((await h.transport.sendMessages(steerSend(null, 'next'))).getReader())
    await settle()
    expect(h.persists).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 250))
    expect(h.persists).toHaveLength(2)
  })

  it('a prior a steer cut off before any output still writes its user message, ahead of the steer (reload order u0, u1, a1)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const reader1 = (await h.transport.sendMessages(firstSend())).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'))
    await settle()
    request(h.transport)
    await settle()
    expect(h.dispatches).toHaveLength(2)
    const tail = [st(messageReceived('turn_0'), ['d1', 'd2'], 'e2'), st(text('Short.'), ['d1', 'd2'], 'e3'), st(turnDone(), ['d1', 'd2'], 'e4')]
    r1.push(...tail)
    r1.end()
    r2.push(...tail)
    r2.end()
    await readAll(reader1)
    await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    await settle()
    // m1 was written when it was sent (onSend), ahead of the steer's reply.
    expect(h.writes.map((b) => [b.role, b.role === 'user' ? b.messageId : b.userMessage?.messageId])).toEqual([
      ['user', 'm1'],
      ['assistant', 'm2'],
    ])
  })

  it('Send now while posted, and the steer never shows: the words go once more after the bounded wait', async () => {
    const r1 = pushable()
    const r3 = pushable()
    const h = harness([r1, pushable(), r3], { timeouts: { sendNowFirstEventMs: 20 } })
    const stop = new AbortController()
    const reader1 = (await h.transport.sendMessages(firstSend(stop.signal))).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    stop.abort()
    r1.push(st(turnCancelled(), ['d1'], 'e3'))
    r1.end()
    await readAll(reader1)
    // R (the steer's own response) stays silent.
    const reader2 = (await h.transport.sendMessages(steerSend('s1'))).getReader()
    r3.push(st(turnStarted('turn_1'), ['d3'], 'e4'), st(text('Short.', 'turn_1'), ['d3'], 'e5'), st(turnDone('turn_1'), ['d3'], 'e6'))
    r3.end()
    expect(textOf(await readAll(reader2))).toBe('Short.')
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send', 'send'])
  })

  it('a fold Send now cancelled after its answer began is not re-sent (one bubble never holds two answers)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const stop = new AbortController()
    const reader1 = (await h.transport.sendMessages(firstSend(stop.signal))).getReader()
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(reasoning('hm'), ['d1'], 'e2'))
    await readUntil(reader1, (c) => c.type === 'reasoning-delta')
    request(h.transport)
    await settle()
    stop.abort()
    const folded = [
      st(messageReceived('turn_0'), ['d1', 'd2'], 'e3'),
      st(text('Short ver'), ['d1', 'd2'], 'e4'),
      st(turnCancelled(), ['d1', 'd2'], 'e5'),
      st(waiting, ['d1', 'd2'], 'e6'),
    ]
    r1.push(...folded)
    r1.end()
    r2.push(...folded)
    r2.end()
    await readAll(reader1)
    const chunks = await readAll((await h.transport.sendMessages(steerSend('s1'))).getReader())
    expect(textOf(chunks)).toBe('Short ver')
    expect(h.dispatches).toHaveLength(2)
  })
})


// ── The #681 regression, with the real AI SDK Chat ───────────────────────────

describe('steering never runs two useChat requests at once (#681 duplicate reply)', () => {
  it('[u1, a1, u2, a2]: one copy of each reply, unique ids, with the real Chat', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const h = harness([r1, r2])
    const chat = new Chat({ id: 'chat-1', transport: h.transport, sendAutomaticallyWhen: () => false })
    const first = chat.sendMessage({ text: 'draft the email' }, { body: { conversationId: 'conv-1' } })
    r1.push(st(turnStarted('turn_0'), ['d1'], 'e1'), st(text('Dear team,'), ['d1'], 'e2'), st(toolCall('c1'), ['d1'], 'e3'))
    await vi.waitFor(() => expect(chat.status).toBe('streaming'))
    await settle()

    // The held message steers beside useChat: no chat.sendMessage over the running reply.
    expect(request(h.transport)).toBe(true)
    await settle()
    // The tool finishes first (its result is still turn_0's alone); eve takes
    // the steer in at that boundary.
    const tail = [
      st(toolResult('c1'), ['d1'], 'e4'),
      st(messageReceived('turn_0'), ['d1', 'd2'], 'e5'),
      st(text('Short: hi team.'), ['d1', 'd2'], 'e6'),
      st(stepDone(), ['d1', 'd2'], 'e7'),
      st(turnDone(), ['d1', 'd2'], 'e8'),
      st(waiting, ['d1', 'd2'], 'e9'),
    ]
    r1.push(...tail)
    r1.end()
    r2.push(...tail.slice(1))
    r2.end()
    await first
    expect(chat.status).toBe('ready')

    // The flush: adopt the posted steer's response.
    expect(h.transport.steerFlushPlan('chat-1', 's1', true)).toBe('adopt')
    await chat.sendMessage({ text: 'actually, make it shorter' }, { body: { conversationId: 'conv-1', steerId: 's1' } })

    const msgs = chat.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(new Set(msgs.map((m) => m.id)).size).toBe(4)
    const textIn = (m: UIMessage) => m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
    expect(textIn(msgs[1])).toBe('Dear team,')
    expect(textIn(msgs[3])).toBe('Short: hi team.')
    await settle()
    // How it landed comes from the transport's reading of the steer's response.
    expect(h.persists[1].userMessage?.metadata).toEqual({ steer: 'applied' })
    expect(h.dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
  })
})
