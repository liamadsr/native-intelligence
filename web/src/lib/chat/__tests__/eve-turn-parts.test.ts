// @vitest-environment jsdom
/**
 * The shared event → parts reducer (A4 slice 5): the browser transport and
 * the server's home-turn writer produce IDENTICAL parts for the same turn.
 * Recorded eve 0.66.3 turns (and synthetic tool turns) run through the real
 * transport + useChat assembler on one side and reduceEveTurnParts on the
 * other; the message parts, and the parts the transport persists, must match.
 */
import { Chat } from '@ai-sdk/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { describe, expect, it, vi } from 'vitest'
import fixtures from '@/lib/chat/eve/__tests__/fixtures/eve-0.66.3-live-streams.json'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'
import {
  UNRETURNED_TOOL_ERROR,
  applyEveTurnEvent,
  createEveTurnPartsState,
  eveTurnText,
  reduceEveTurnParts,
  restoreEveTurnParts,
  snapshotEveTurnParts,
} from '../eve-turn-parts'

type Recorded = Record<string, HandleMessageStreamEvent[]>
const recorded = fixtures as unknown as Recorded

const ev = (type: string, data: object): HandleMessageStreamEvent => ({ type, data, meta: { at: '2026-10-14T00:00:00.000Z', id: `e-${type}` } }) as unknown as HandleMessageStreamEvent

/** The events of the first turn in a recording, through its first boundary. */
function firstTurn(events: HandleMessageStreamEvent[]): HandleMessageStreamEvent[] {
  const end = events.findIndex((e) => e.type === 'turn.completed' || e.type === 'turn.cancelled' || e.type === 'turn.failed')
  return end < 0 ? events : events.slice(0, end + 1)
}

/** Drive the real transport (and useChat's assembler) over `events`. */
async function throughTransport(events: HandleMessageStreamEvent[]) {
  const persist = vi.fn(async (..._args: unknown[]) => {})
  const response = {
    sessionId: 'sess-identity',
    async *[Symbol.asyncIterator]() {
      for (const item of events) yield item
    },
  }
  const session = {
    state: { sessionId: response.sessionId, streamIndex: 0 },
    send: vi.fn(async () => response),
    cancel: vi.fn(async () => ({ status: 'accepted' })),
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'synthetic-token',
    mintRunToken: async () => ({ token: 'synthetic.run-token', conversationId: 'synthetic-conversation' }),
    registerEveSession: async () => {},
    // The send-time user-message write (onSend) is not this turn's reply.
    persistTurn: async (args) => { if (!args.body.onSend) await persist(args) },
    createClient: () => ({ sessions: { create: async () => ({ session, response }), attach: () => session } }) as never,
  })
  const chat = new Chat({ id: 'identity-chat', transport, onError: () => {}, sendAutomaticallyWhen: () => false })
  await chat.sendMessage({ text: 'hello' }, { body: { conversationId: 'synthetic-conversation' } })
  const assistant = chat.messages.at(-1)!
  return { chat, assistant, persist }
}

/**
 * useChat's assembled message, minus what only the live assembly adds: its
 * step-start markers, streamed blocks' `state` and `id`, and keys it sets to undefined.
 */
function assembled(parts: readonly unknown[]): unknown[] {
  return parts
    .filter((p) => (p as { type?: unknown }).type !== 'step-start')
    .map((p) => {
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (v !== undefined && k !== 'providerMetadata') rest[k] = v
      if (rest.type === 'text' || rest.type === 'reasoning') {
        delete rest.state
        delete rest.id
      }
      return rest
    })
}

const toolTurn: HandleMessageStreamEvent[] = [
  ev('turn.started', { sequence: 0, turnId: 't1' }),
  ev('reasoning.appended', { reasoningDelta: 'Let me look.' }),
  ev('message.appended', { messageDelta: 'Checking ' }),
  ev('actions.requested', {
    actions: [
      { kind: 'tool-call', callId: 'c1', toolName: 'list_actions', input: { limit: 5 } },
      { kind: 'subagent-call', callId: 'c2', subagentName: 'helper', input: { task: 'x' } },
      { kind: 'approval', callId: 'c-ctl' },
    ],
  }),
  ev('action.result', { result: { kind: 'tool-result', callId: 'c1', toolName: 'list_actions', output: { actions: [{ id: 'a1' }] } } }),
  ev('action.result', { result: { kind: 'subagent-result', callId: 'c2', subagentName: 'helper', output: 'boom', isError: true } }),
  // A result whose request never streamed: announced synthetically first.
  ev('action.result', { result: { kind: 'tool-result', callId: 'c3', toolName: 'get_contact', output: { name: 'Ada' } } }),
  ev('message.appended', { messageDelta: 'Done: one action.' }),
  ev('message.completed', { message: 'Done: one action.' }),
  ev('turn.completed', { sequence: 0, turnId: 't1' }),
]

describe('the browser transport and the server reducer write the same parts', () => {
  const cases: Array<[string, HandleMessageStreamEvent[]]> = [
    ['a recorded first turn with reasoning', recorded.firstTurnWithReasoning],
    ['a recorded turn with tool calls', firstTurn(recorded.steerAfterAssistantOutputStartsNextTurn)],
    ['a recorded turn stopped mid-reply', recorded.chatAgentTransportStopMidReply],
    ['a synthetic turn with tools, a failed subagent and an unannounced result', toolTurn],
    [
      'a helpers turn with preliminary progress (action.partial)',
      [
        ev('actions.requested', { actions: [{ kind: 'tool-call', callId: 'h1', toolName: 'helpers', input: { tasks: [] } }] }),
        ev('action.partial', { result: { kind: 'tool-result', callId: 'h1', toolName: 'helpers', output: { done: 1, total: 2 } } }),
        ev('action.result', { result: { kind: 'tool-result', callId: 'h1', toolName: 'helpers', output: { done: 2, total: 2 } } }),
        ev('message.appended', { messageDelta: 'Both done.' }),
        ev('turn.completed', {}),
      ],
    ],
  ]

  it.each(cases)('%s', async (_label, events) => {
    const { assistant, persist } = await throughTransport(events)
    const server = reduceEveTurnParts(assistant.id, events)
    expect(server.length).toBeGreaterThan(0)
    // What is STORED: the transport's persisted parts, exactly.
    await vi.waitFor(() => expect(persist).toHaveBeenCalled())
    const body = (persist.mock.calls[0] as unknown as [{ body: { parts: unknown[] } }])[0].body
    expect(server).toEqual(body.parts)
    // What is SHOWN: the message useChat assembled from the transport's chunks.
    expect(assembled(server)).toEqual(assembled(assistant.parts))
  })

  it('a failed turn: open tool parts settle as errors on both sides', async () => {
    const events = [
      ev('actions.requested', { actions: [{ kind: 'tool-call', callId: 'x1', toolName: 'search', input: {} }] }),
      ev('turn.failed', { code: 'MODEL_CALL_FAILED', message: 'parent failed' }),
    ]
    const { assistant } = await throughTransport(events)
    const server = reduceEveTurnParts(assistant.id, events)
    expect(server).toEqual([expect.objectContaining({ toolCallId: 'x1', state: 'output-error', errorText: UNRETURNED_TOOL_ERROR })])
    expect(assembled(server)).toEqual(assembled(assistant.parts))
  })
})

describe('applyEveTurnEvent', () => {
  it('a parked HITL request stays open: no finish until a later completion with nothing open', () => {
    const state = createEveTurnPartsState('m1')
    const finished = vi.fn()
    const onInputRequest = vi.fn()
    const sink = { emit: () => {}, onFinished: finished, onInputRequest }
    for (const e of recorded.askUserApprovalPark) applyEveTurnEvent(state, e, sink)
    expect(onInputRequest).toHaveBeenCalledOnce()
    expect(finished).not.toHaveBeenCalled()
    expect(state.parts.some((p) => p.type === 'dynamic-tool' && p.toolName === 'ask_user' && p.state === 'input-available')).toBe(true)
    // A re-emitted request is never announced twice.
    const again = recorded.askUserApprovalPark.find((e) => e.type === 'input.requested')!
    applyEveTurnEvent(state, again, sink)
    expect(onInputRequest).toHaveBeenCalledOnce()
  })

  it('an answered ask_user keeps the person’s answers as its output', () => {
    const state = createEveTurnPartsState('m1')
    const answers = { answers: { Q: 'A' } }
    const sink = { emit: () => {}, answeredOutput: (id: string) => (id === 'q1' ? answers : undefined) }
    applyEveTurnEvent(state, ev('actions.requested', { actions: [{ kind: 'tool-call', callId: 'q1', toolName: 'ask_user', input: {} }] }), sink)
    applyEveTurnEvent(state, ev('action.result', { result: { kind: 'tool-result', callId: 'q1', output: 'answers arrive next', isError: true } }), sink)
    expect(state.parts[0]).toMatchObject({ state: 'output-available', output: answers })
  })

  it('a snapshot taken mid-turn and restored continues to the same parts (re-attaching Inngest steps)', () => {
    const events = toolTurn
    const continuous = reduceEveTurnParts('m1', events)
    const sink = { emit: () => {} }
    const first = createEveTurnPartsState('m1')
    for (const e of events.slice(0, 5)) applyEveTurnEvent(first, e, sink)
    const restored = restoreEveTurnParts(JSON.parse(JSON.stringify(snapshotEveTurnParts(first))))
    for (const e of events.slice(5)) applyEveTurnEvent(restored, e, sink)
    expect(restored.parts).toEqual(continuous)
  })

  it('eveTurnText joins the visible text only', () => {
    expect(eveTurnText(reduceEveTurnParts('m1', toolTurn))).toBe('Checking Done: one action.')
  })
})
