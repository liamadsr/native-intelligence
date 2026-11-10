// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import {
  EveChatTransport,
  deriveTurnTimings,
  encodeTurnContext,
  MAX_CTX_WITH_CARDS,
  eveUserContent,
  isUsageRelevantEvent,
  runTokenExpiresAt,
  type ChatRunMintResult,
  type EvePersistBody,
  type TurnTimingMarks,
} from '../eve-chat-transport'
import { TOOL_OUTPUT_MAX_SERIALIZED_CHARS } from '../tool-output-truncation'
import { browserTimeZone } from '@/lib/chat-cards/calendar'
import { turnRouteSignals } from '@/lib/ai/model-route'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
// Pin the HITL fixtures + response assertions to eve's REAL wire contract (the
// exported guards the runtime validates with — eve 0.66 stopped exporting the raw
// zod schemas and points callers at these), so a shape drift in eve fails these
// tests instead of silently regressing the resume in production.
import { isInputRequest, isInputResponse } from 'eve/client'
// Real event streams recorded against eve 0.66.3 (see the file's _source).
import liveStreams from './fixtures/eve-0.66.3-live-streams.json'

/**
 * NDJSON (eve stream events) → UIMessageChunk mapping for the EveChatTransport.
 *
 * The transport is exercised with an INJECTED fake eve Client (opts.createClient)
 * shaped like eve 0.47.7's REAL client surface — `client.sessions.create(input)`
 * for the first turn and `session.send(message, options)` /
 * `session.respond(inputResponses, options)` after that. Each returns a
 * MessageResponse-shaped object: a sessionId + an async-iterable of scripted
 * events. We drain the transport's returned ReadableStream and assert the chunk
 * sequence — the contract chat-message.tsx consumes (text start/delta/end; tool
 * calls as dynamic parts; input.requested branches; a valid start→finish frame).
 *
 * The fake deliberately does NOT carry a `continuationToken` (deleted in eve
 * 0.31.0) and does NOT accept the removed single-object `send({message,...})`
 * form — so a regression back to the pre-0.31 API fails these tests.
 */

// ── Fake eve client plumbing ─────────────────────────────────────────────────

function makeResponse(sessionId: string, events: HandleMessageStreamEvent[]) {
  return {
    sessionId,
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

/**
 * One recorded dispatch against the fake session, normalized across the three
 * 0.47.7 entry points so assertions read uniformly.
 */
type Dispatch = {
  kind: 'create' | 'send' | 'respond'
  message?: string
  inputResponses?: Array<{ requestId: string; optionId?: string; text?: string }>
  options: Record<string, unknown>
}

/**
 * Build a fake eve Client conforming to 0.47.7's `{ sessions: { create, attach } }`
 * surface. `respondTurn(dispatch, index)` scripts the MessageResponse for each
 * dispatch; every dispatch is pushed onto the returned `dispatches` array.
 * A create with NO `message` key is eve 0.66's message-free create (a prewarm):
 * it resolves `{ session }` (after `opts.prewarm`, when given) and dispatches
 * nothing. `{ message: undefined }` still takes the message path and throws.
 */
function makeFakeClient(
  respondTurn: (d: Dispatch, index: number) => unknown,
  opts: { prewarm?: () => Promise<void> } = {},
): {
  client: unknown
  dispatches: Dispatch[]
  create: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
} {
  const dispatches: Dispatch[] = []
  const run = (d: Dispatch) => {
    dispatches.push(d)
    return respondTurn(d, dispatches.length - 1)
  }

  const send = vi.fn(async (message: unknown, options?: Record<string, unknown>) => {
    // 0.47.7's send is POSITIONAL. If a caller regresses to the removed object
    // form, `message` arrives as an object — fail loudly instead of masking it.
    if (typeof message !== 'string') {
      throw new Error(
        `eve 0.47.7 send() takes a positional message; received ${typeof message}`,
      )
    }
    return run({ kind: 'send', message, options: options ?? {} })
  })

  const respond = vi.fn(
    async (
      inputResponses: Array<{ requestId: string; optionId?: string; text?: string }>,
      options?: Record<string, unknown>,
    ) => run({ kind: 'respond', inputResponses, options: options ?? {} }),
  )

  // eve 0.66's ClientSession.cancel({ turnId? }) — Stop's server-side cancel.
  const cancel = vi.fn(async () => ({ status: 'accepted', sessionId: 'wrun_ABC' }))
  const session = { send, respond, cancel, stream: vi.fn(), state: { sessionId: 'wrun_ABC', streamIndex: 0 } }

  const create = vi.fn(async (input: Record<string, unknown>) => {
    if (!('message' in input)) {
      await opts.prewarm?.()
      return { session }
    }
    const { message, ...options } = input
    if (typeof message !== 'string') {
      throw new Error('eve 0.47.7 sessions.create() requires a `message`')
    }
    const response = await run({ kind: 'create', message, options })
    return { response, session }
  })

  const attach = vi.fn(() => session)
  const client = { sessions: { create, attach } }
  return { client, dispatches, create, send, respond, cancel, attach }
}

/**
 * Build a transport whose session yields `events`, capturing register/mint calls.
 * `events` may be one event array (same for every send) or an array of arrays
 * (one per send — send #0 is the initial turn, #1 the resumed answer, …).
 */
function makeTransport(
  events: HandleMessageStreamEvent[] | HandleMessageStreamEvent[][],
  opts?: {
    onRegister?: (a: { conversationId: string; sessionId: string; accessToken: string | null }) => void
    sessionId?: string
    captureSend?: (input: unknown) => void
    onConversationEnsured?: (chatId: string, conversationId: string) => void
    onPersist?: (args: { token: string; accessToken: string | null; body: unknown }) => void
    mintConversationId?: string
    /** Records the conversationId the transport passed to EACH mint call, in order. */
    captureMint?: (conversationId: string | null | undefined) => void
    /** Live panel-tracked conversation id fallback (eveOptions.getConversationId). */
    getConversationId?: () => string | null
    /**
     * Simulate the real mint route's create-on-null behavior: when the transport
     * mints with a NULL conversationId, return a DISTINCT fresh row id each time
     * (like resolveOwnedConversation → insert). This reproduces the production bug
     * where every follow-up turn that minted null forked a new empty conversation.
     */
    freshRowPerNullMint?: boolean
    /** eveOptions.panelNamesChats — whether the host panel names its own chats. */
    panelNamesChats?: () => boolean
    /** eveOptions.teammateId — a bots v2 teammate thread. */
    teammateId?: string
    /** Hand onPersist the send-time user-message write (onSend) too. */
    keepSendWrites?: boolean
  },
) {
  const sessionId = opts?.sessionId ?? 'wrun_ABC'
  const perSend = Array.isArray(events[0]) ? (events as HandleMessageStreamEvent[][]) : null
  const { client, dispatches } = makeFakeClient((d, i) => {
    opts?.captureSend?.(d)
    const evs = perSend ? (perSend[i] ?? []) : (events as HandleMessageStreamEvent[])
    return makeResponse(sessionId, evs)
  })

  let freshRowSeq = 0
  const transport = new EveChatTransport({
    getAccessToken: () => 'jwt-token',
    ...(opts?.getConversationId ? { getConversationId: opts.getConversationId } : {}),
    mintRunToken: async ({ conversationId }) => {
      opts?.captureMint?.(conversationId)
      // A named id echoes back (the route trusts a resolvable owned id). A null id
      // means "create a row": either a stable seed, or — under freshRowPerNullMint
      // — a brand-new distinct id each call (the route's insert path, = the bug).
      const resolved =
        conversationId ??
        (opts?.freshRowPerNullMint
          ? `conv-fresh-${++freshRowSeq}`
          : (opts?.mintConversationId ?? 'conv-new'))
      return { token: 'tok.sig', conversationId: resolved }
    },
    registerEveSession: async (a) => {
      opts?.onRegister?.(a)
    },
    createClient: () => client as never,
    ...(opts?.onConversationEnsured ? { onConversationEnsured: opts.onConversationEnsured } : {}),
    ...(opts?.panelNamesChats ? { panelNamesChats: opts.panelNamesChats } : {}),
    ...(opts?.teammateId ? { teammateId: opts.teammateId } : {}),
    // Inject a persist stub so the default relative-URL fetch never fires in tests.
    // The send-time user-message write (onSend) is not the turn's persist: the
    // tests below pin the reply's; persistUserMessageNow has its own.
    persistTurn: async (args) => {
      if (!args.body.onSend || opts?.keepSendWrites) opts?.onPersist?.(args)
    },
  })
  return { transport, dispatches }
}

/** A send-options builder whose per-send body OMITS conversationId — mirroring the
 *  real panel, where `sendMessage(text, { body })` never carries the durable id
 *  (it lives only on the cloud DefaultChatTransport body getter). Used to prove
 *  the eve path stays on one row WITHOUT relying on the body to carry the id. */
function sendOptsNoConversationId(
  body?: Record<string, unknown>,
): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: { ...(body ?? {}) },
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

/** Read chunks until `pred` matches one (does NOT wait for stream close — for a
 *  turn parked on a HITL request, where the stream deliberately stays open). */
async function readUntil(
  stream: ReadableStream<UIMessageChunk>,
  pred: (c: UIMessageChunk) => boolean,
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    if (pred(value)) break
  }
  reader.releaseLock()
  return chunks
}

function sendOpts(body?: Record<string, unknown>): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: { conversationId: 'conv-1', ...body },
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

// ── Event constructors (match eve/client shapes) ─────────────────────────────

// Partial event constructors (real eve events carry more bookkeeping fields —
// sequence/turnId/etc — that the mapping ignores); cast via unknown for tests.
const ev = (e: object): HandleMessageStreamEvent => e as unknown as HandleMessageStreamEvent
const evTextDelta = (delta: string) =>
  ev({ type: 'message.appended', data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' } })
const evTextDone = (message: string) => ev({ type: 'message.completed', data: { finishReason: 'stop', message } })
const evReasoningDelta = (delta: string) =>
  ev({ type: 'reasoning.appended', data: { reasoningDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' } })
const evToolCall = (callId: string, toolName: string, input: object) =>
  ev({ type: 'actions.requested', data: { actions: [{ kind: 'tool-call', callId, toolName, input }] } })
const evToolResult = (callId: string, output: unknown) =>
  ev({ type: 'action.result', data: { result: { kind: 'tool-result', callId, toolName: 't', output } } })
const evInputRequested = (requests: unknown[]) => ev({ type: 'input.requested', data: { requests } })
const evTurnDone = () => ev({ type: 'turn.completed', data: {} })
const evTurnFailed = (message: string) => ev({ type: 'turn.failed', data: { code: 'x', message } })

beforeEach(() => vi.clearAllMocks())

describe('EveChatTransport — text streaming', () => {
  it('maps message.appended/completed into a valid start → text → finish frame', async () => {
    const { transport } = makeTransport([
      evTextDelta('Hel'),
      evTextDelta('lo'),
      evTextDone('Hello'),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const types = chunks.map((c) => c.type)
    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta)
    expect(deltas).toEqual(['Hel', 'lo'])
    // text-start / text-delta / text-end share one id.
    const ids = new Set(
      chunks.filter((c) => 'id' in c).map((c) => (c as { id: string }).id),
    )
    expect(ids.size).toBe(1)
  })
})

// eve sends the model's reasoning/thinking as a SEPARATE event stream
// (`reasoning.appended`) ahead of the visible reply. Before this mapping
// existed the events were silently dropped by the `default:` case — a live
// trace against DeepSeek V4 Flash found this as the dominant cause of
// "streaming feels stalled": the model could spend a large fraction of a
// turn's wall-clock time reasoning with NOTHING projected to the client.
describe('EveChatTransport — reasoning streaming', () => {
  it('maps reasoning.appended into reasoning-start/delta, closed by the FIRST text delta', async () => {
    const { transport } = makeTransport([
      evReasoningDelta('Let me '),
      evReasoningDelta('think.'),
      evTextDelta('The answer'),
      evTextDelta(' is 4.'),
      evTextDone('The answer is 4.'),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const types = chunks.map((c) => c.type)
    expect(types).toEqual([
      'start',
      'start-step',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    const reasoningDeltas = chunks
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { delta: string }).delta)
    expect(reasoningDeltas).toEqual(['Let me ', 'think.'])
    // reasoning-start/delta/end share one id, DIFFERENT from the text block's id
    // (two independent parts, not one part masquerading as the other).
    const reasoningIds = new Set(
      chunks
        .filter((c) => c.type.startsWith('reasoning-'))
        .map((c) => (c as { id: string }).id),
    )
    const textIds = new Set(
      chunks
        .filter((c) => c.type === 'text-start' || c.type === 'text-delta' || c.type === 'text-end')
        .map((c) => (c as { id: string }).id),
    )
    expect(reasoningIds.size).toBe(1)
    expect(textIds.size).toBe(1)
    expect([...reasoningIds][0]).not.toBe([...textIds][0])
  })

  it('closes an open reasoning block on a tool call, not just on text', async () => {
    // A turn can go straight from reasoning into a tool call with no visible
    // text in between (e.g. "let me search for that" reasoning, then a real
    // search) — closeReasoningIfOpen() must run on actions.requested too, or
    // the reasoning part would stay open (state: 'streaming') forever, stuck
    // showing "Thinking…" even after the tool call starts.
    const { transport } = makeTransport([
      evReasoningDelta('I should search.'),
      evToolCall('call-1', 'find', { query: 'x' }),
      evToolResult('call-1', { ok: true }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const reasoningEndIdx = chunks.findIndex((c) => c.type === 'reasoning-end')
    const toolInputIdx = chunks.findIndex((c) => c.type === 'tool-input-available')
    expect(reasoningEndIdx).toBeGreaterThan(-1)
    expect(toolInputIdx).toBeGreaterThan(-1)
    expect(reasoningEndIdx).toBeLessThan(toolInputIdx)
  })

  it('never emits reasoning chunks for a turn with no reasoning', async () => {
    // The baseline text-only turn (previous describe block) must be COMPLETELY
    // unaffected — no stray reasoning-start/end pair from an event that never
    // fired.
    const { transport } = makeTransport([evTextDelta('Hi'), evTextDone('Hi'), evTurnDone()])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type.startsWith('reasoning-'))).toBe(false)
  })

  it('a turn.failed after reasoning still fails the stream (surfaced, not silently eaten by the reasoning case)', async () => {
    // Ordered error chunks let the SDK apply final part updates before entering
    // its error state; controller.error would discard those queued updates.
    const { transport } = makeTransport([evReasoningDelta('Working on it'), evTurnFailed('boom')])
    const stream = await transport.sendMessages(sendOpts())
    const chunks = await drain(stream)
    expect(chunks).toContainEqual({ type: 'error', errorText: 'boom' })
    expect(chunks.findIndex(chunk => chunk.type === 'reasoning-end')).toBeLessThan(chunks.findIndex(chunk => chunk.type === 'error'))
  })
})

describe('EveChatTransport — tool calls', () => {
  it('emits tool-input-available (dynamic) with toolName for a tool call', async () => {
    const { transport } = makeTransport([
      evToolCall('call-1', 'create_action', { title: 'Ship' }),
      evToolResult('call-1', { id: 'ACT-1' }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const toolIn = chunks.find((c) => c.type === 'tool-input-available') as
      | { toolCallId: string; toolName: string; input: unknown; dynamic: boolean }
      | undefined
    expect(toolIn).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'create_action',
      input: { title: 'Ship' },
      dynamic: true,
    })
    const toolOut = chunks.find((c) => c.type === 'tool-output-available') as
      | { toolCallId: string; output: unknown; dynamic: boolean }
      | undefined
    expect(toolOut).toMatchObject({ toolCallId: 'call-1', output: { id: 'ACT-1' }, dynamic: true })
  })

  it('does not double-announce a tool call with the same callId', async () => {
    const { transport } = makeTransport([
      evToolCall('call-1', 'list_actions', {}),
      evToolCall('call-1', 'list_actions', {}), // duplicate
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.filter((c) => c.type === 'tool-input-available')).toHaveLength(1)
  })

  // Regression: a subagent dispatch ("spin up a sub-agent") is a `subagent-call`
  // action, NOT a `tool-call`. It must be announced as a tool-input-available
  // part so its later subagent-result has a paired input — otherwise useChat's
  // assembler throws "No tool invocation found for tool call ID". Every
  // output-available chunk MUST be preceded by an input-available for its callId.
  it('announces a subagent-call so its result is paired (no orphan output)', async () => {
    const { transport } = makeTransport([
      ev({
        type: 'actions.requested',
        data: { actions: [{ kind: 'subagent-call', callId: 'sub-1', subagentName: 'researcher', input: { task: 'dig' } }] },
      }),
      ev({
        type: 'action.result',
        data: { result: { kind: 'subagent-result', callId: 'sub-1', subagentName: 'researcher', output: { summary: 'done' } } },
      }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const inputs = chunks.filter((c) => c.type === 'tool-input-available') as Array<{ toolCallId: string; toolName: string }>
    const outputs = chunks.filter((c) => c.type === 'tool-output-available') as Array<{ toolCallId: string }>
    expect(inputs).toEqual([expect.objectContaining({ toolCallId: 'sub-1', toolName: 'researcher' })])
    expect(outputs).toEqual([expect.objectContaining({ toolCallId: 'sub-1' })])
    // Every output's callId has a preceding input's callId — the invariant the
    // AI SDK assembler enforces.
    const announced = new Set(inputs.map((i) => i.toolCallId))
    for (const o of outputs) expect(announced.has(o.toolCallId)).toBe(true)
  })

  // A failed tool (thrown execute — e.g. dispatchChatTool surfacing an
  // INPUT_INVALID with Zod details) rides eve's isError flag. It must project as
  // the AI SDK's native error state — tool-output-error + errorText — so the
  // Tool chip shows the red Error state instead of a green "Done" (the parity
  // audit's regression (e): output-error was structurally unreachable on eve).
  it('projects an isError tool-result as tool-output-error with the message as errorText', async () => {
    const persists: Array<{ body: { parts: Array<Record<string, unknown>> } }> = []
    const { transport } = makeTransport(
      [
        evToolCall('call-1', 'find', { types: '["capture"]' }),
        ev({
          type: 'action.result',
          data: {
            result: {
              kind: 'tool-result',
              callId: 'call-1',
              toolName: 'find',
              isError: true,
              output: 'find: input failed tool schema validation [INPUT_INVALID] — types must be an array',
            },
          },
        }),
        evTurnDone(),
      ],
      { onPersist: (a) => persists.push(a as never) },
    )
    const chunks = await drain(await transport.sendMessages(sendOpts()))

    const errChunk = chunks.find((c) => c.type === 'tool-output-error') as
      | { toolCallId: string; errorText: string; dynamic: boolean }
      | undefined
    expect(errChunk).toMatchObject({
      toolCallId: 'call-1',
      errorText: expect.stringContaining('INPUT_INVALID'),
      dynamic: true,
    })
    // No success chunk for that call.
    expect(chunks.find((c) => c.type === 'tool-output-available')).toBeUndefined()

    // The persisted part round-trips the error state (history renders red too).
    const part = persists[0].body.parts.find((p) => p.type === 'dynamic-tool')
    expect(part).toMatchObject({
      toolCallId: 'call-1',
      state: 'output-error',
      errorText: expect.stringContaining('INPUT_INVALID'),
    })
  })

  it('a non-error tool-result still projects as tool-output-available (isError absent)', async () => {
    const { transport } = makeTransport([
      evToolCall('call-2', 'find', { query: 'x' }),
      evToolResult('call-2', { success: true, results: [] }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toBeUndefined()
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'call-2',
    })
  })

  // Defensive self-heal: a subagent-result whose request was never seen (an
  // actions.requested we missed) still gets a synthetic input announced first,
  // so the output is never orphaned.
  it('self-heals a subagent-result with no announced input', async () => {
    const { transport } = makeTransport([
      ev({
        type: 'action.result',
        data: { result: { kind: 'subagent-result', callId: 'sub-x', subagentName: 'coder', output: { ok: true } } },
      }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const input = chunks.find((c) => c.type === 'tool-input-available') as { toolCallId: string; toolName: string } | undefined
    const output = chunks.find((c) => c.type === 'tool-output-available') as { toolCallId: string } | undefined
    expect(input).toMatchObject({ toolCallId: 'sub-x', toolName: 'coder' })
    expect(output).toMatchObject({ toolCallId: 'sub-x' })
  })

  // ── Provider-executed built-ins (web_search) ───────────────────────────────
  //
  // `web_search` is executed by the PROVIDER (Exa via the AI Gateway), not by an
  // authored tool in our agent tree. eve still surfaces it on the session stream
  // as an ordinary action: eve/dist/src/harness/emission.js routes a stream
  // `tool-call` with `providerExecuted === true` through `collectProviderToolCall`
  // → `resolveProviderToolCallRequest` (kind: 'tool-call', toolName, input) →
  // `actions.requested`, and a `tool-result` with `providerExecuted === true`
  // through `createRuntimeToolResultFromStepResult` (kind: 'tool-result') →
  // `action.result`. So NO transport special-casing is needed — these assertions
  // pin that pass-through, because the chat's WebSearchCard keys on exactly this
  // toolName + output shape reaching it unchanged from BOTH runtimes.
  it('passes a provider-executed web_search through as a normal dynamic tool part', async () => {
    const exa = {
      requestId: 'req_abc',
      results: [
        {
          id: 'r0',
          url: 'https://acme.com/pricing',
          title: 'Acme Pricing',
          highlights: ['Plans start at $99 per seat'],
        },
      ],
      costDollars: { total: 0.005 },
    }
    const { transport } = makeTransport([
      evToolCall('ws-1', 'web_search', { query: 'acme pricing' }),
      ev({
        type: 'action.result',
        data: { result: { kind: 'tool-result', callId: 'ws-1', toolName: 'web_search', output: exa } },
      }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))

    // The card reads toolName + input.query for the running line…
    expect(chunks.find((c) => c.type === 'tool-input-available')).toMatchObject({
      toolCallId: 'ws-1',
      toolName: 'web_search',
      input: { query: 'acme pricing' },
      dynamic: true,
    })
    // …and the UNMODIFIED Exa bag for the source list. Truncation only kicks in
    // past 64KB, well above eve's 10-result / 1000-char-highlight Exa config.
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'ws-1',
      output: exa,
      dynamic: true,
    })
  })

  it("projects Exa's error branch as a normal output (not an output-error)", async () => {
    // The Exa error branch ({ error, message }) is a SUCCESSFUL tool result
    // carrying a failure payload — eve does not set isError for it — so it must
    // reach the card as output-available. The card renders it as the plain
    // "Web search unavailable" line rather than a red error chip.
    const errBag = { error: 'rate_limit', message: 'Too many requests', statusCode: 429 }
    const { transport } = makeTransport([
      evToolCall('ws-2', 'web_search', { query: 'q' }),
      ev({
        type: 'action.result',
        data: { result: { kind: 'tool-result', callId: 'ws-2', toolName: 'web_search', output: errBag } },
      }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toBeUndefined()
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'ws-2',
      output: errBag,
    })
  })
})

describe('EveChatTransport — input.requested (HITL)', () => {
  const questions = [
    { question: 'Which env?', header: 'Env', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
  ]
  const askUserPark = evInputRequested([
    {
      requestId: 'req-1',
      display: 'select',
      prompt: 'Which env?',
      action: { kind: 'tool-call', callId: 'call-auq', toolName: 'ask_user', input: { questions } },
    },
  ])

  it('maps an ask_user request into a tool-input-available part with toolName ask_user (the picker), leaving the turn OPEN', async () => {
    // Turn parks on the picker — no turn.completed. The stream deliberately stays
    // OPEN (the reply streams in after the answer), so read until the picker
    // rather than drain-to-close.
    const { transport } = makeTransport([askUserPark])
    const chunks = await readUntil(
      await transport.sendMessages(sendOpts()),
      (c) => c.type === 'tool-input-available',
    )
    const picker = chunks.find((c) => c.type === 'tool-input-available') as
      | { toolName: string; input: { questions: unknown }; dynamic: boolean }
      | undefined
    expect(picker).toBeDefined()
    expect(picker!.toolName).toBe('ask_user')
    expect(picker!.input.questions).toEqual(questions)
    expect(picker!.dynamic).toBe(true)
    // The ask_user part is NEVER force-completed (no tool-output-available for it).
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(false)
  })

  it('the send and the answer name the same reply, the id the turn renders (the reply backup writes under it)', async () => {
    const { transport, dispatches } = makeTransport([
      [askUserPark],
      [evTextDelta('Staging it is.'), evTextDone('Staging it is.'), evTurnDone()],
    ])
    const reader = (await transport.sendMessages(sendOpts())).getReader()
    const seen: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen.push(value)
      if (value.type === 'tool-input-available') break
    }
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answered
    const replyIdOf = (i: number) => (dispatches[i].options.headers as Record<string, string>)['x-chat-reply-id']
    const start = seen.find((c) => c.type === 'start') as { messageId: string }
    expect(replyIdOf(0)).toBe(start.messageId)
    expect(replyIdOf(1)).toBe(start.messageId)
  })

  it('answerPermission resumes the parked turn: the reply streams in and the turn closes', async () => {
    // Dispatch #0 (sessions.create) → the ask_user park; #1 (the respond) → the reply.
    const { transport, dispatches } = makeTransport([
      [askUserPark],
      [evTextDelta('Staging it is.'), evTextDone('Staging it is.'), evTurnDone()],
    ])
    // Kick off the turn and consume up to the picker (turn stays open).
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    const seen: UIMessageChunk[] = []
    // Read the pre-park chunks (start … picker) without blocking on close.
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen.push(value)
      if (value.type === 'tool-input-available') break
    }

    // Answer the picker — the toolCallId is the eve action callId ('call-auq').
    const answerPromise = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })

    // The resumed reply streams into the SAME stream and it then closes.
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen.push(value)
    }
    await answerPromise

    // The resume went through respond() (NOT send()) carrying inputResponses that
    // answer req-1 with the choice.
    expect(dispatches[0].kind).toBe('create')
    expect(dispatches[1].kind).toBe('respond')
    const resumeCall = dispatches[1] as { inputResponses?: Array<{ requestId: string; text: string }> }
    expect(resumeCall.inputResponses?.[0].requestId).toBe('req-1')
    expect(JSON.parse(resumeCall.inputResponses![0].text)).toEqual({ answers: { 'Which env?': 'Staging' } })

    // The reply text + a terminal finish landed in the same stream.
    const deltas = seen.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta)
    expect(deltas).toContain('Staging it is.')
    expect(seen.some((c) => c.type === 'finish')).toBe(true)
  })

  it('a TYPED reply to a one-question approval reads exactly like a picked answer to that question', async () => {
    // The real ask_user pause is an approval (approval: always()).
    const park = evInputRequested([
      {
        requestId: 'req-typed',
        display: 'confirmation',
        kind: 'tool-approval',
        prompt: 'Approve tool call: ask_user',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'cancel', label: 'Cancel' }],
        action: { kind: 'tool-call', callId: 'call-auq', toolName: 'ask_user', input: { questions } },
      },
    ])
    const { transport, dispatches } = makeTransport([
      [park],
      [evTextDelta('Thursday it is.'), evTextDone('Thursday it is.'), evTurnDone()],
    ])
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || value.type === 'tool-input-available') break
    }
    const answered = transport.answerPermission('chat-1', 'call-auq', {}, '  Thursday  ', { typed: true })
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answered

    const resume = dispatches[1] as { kind: string; inputResponses: Array<{ optionId?: string }>; options: { clientContext?: string } }
    expect(resume.kind).toBe('respond')
    expect(resume.inputResponses[0].optionId).toBe('approve')
    // The "Other"-shaped answer the model already acts on, plus why it isn't an option.
    expect(resume.options.clientContext).toBe(
      'I answered the questions:\n- Which env?: Thursday\n(I typed this answer instead of picking one of your options.)',
    )
  })

  it('maps a confirmation-shaped request into a tool part too', async () => {
    const { transport } = makeTransport([
      evInputRequested([
        {
          requestId: 'req-2',
          display: 'confirmation',
          kind: 'tool-approval',
          prompt: 'Delete it?',
          options: [{ id: 'approve', label: 'Approve' }, { id: 'cancel', label: 'Cancel' }],
          action: { kind: 'tool-call', callId: 'call-del', toolName: 'delete_action', input: {} },
        },
      ]),
    ])
    const chunks = await readUntil(
      await transport.sendMessages(sendOpts()),
      (c) => c.type === 'tool-input-available',
    )
    const part = chunks.find((c) => c.type === 'tool-input-available') as
      | { toolName: string } | undefined
    expect(part?.toolName).toBe('delete_action')
  })
})

// ── ask_user HITL: the REAL eve approval-request shape + the dead-Submit race ──
//
// Native Intelligence's ask_user is gated with `approval: always()`, so eve pauses it as an
// APPROVAL request — options [{id:'approve'},{id:'cancel'}], display 'confirmation',
// action.toolName 'ask_user', action.input { questions }, and a requestId that is
// the approvalId (DISTINCT from action.callId). These tests use that exact shape.
describe('EveChatTransport — ask_user approval resume (multi-question)', () => {
  const questions = [
    { question: 'Which env?', header: 'Env', options: [{ label: 'Staging' }, { label: 'Prod' }], multiSelect: false },
    { question: 'Region?', header: 'Region', options: [{ label: 'US' }, { label: 'EU' }], multiSelect: false },
  ]
  // The EXACT approval-request shape eve emits for an `approval: always()` tool
  // (harness/input-extraction.js extractApprovalRequests): requestId is the
  // approvalId (distinct from action.callId), display 'confirmation', options
  // [{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}] — 0.32.0
  // renamed the negative verb 'deny' → 'cancel'. Validated against eve's real
  // input-request contract (isInputRequest) so a drift trips here, not in prod.
  const realApprovalRequest = {
    action: { callId: 'call_real_abc', input: { questions }, kind: 'tool-call' as const, toolName: 'ask_user' },
    allowFreeform: false,
    display: 'confirmation' as const,
    // `kind` is the framework-owned request discriminator, REQUIRED by eve's
    // strict input-request contract (enum question | session-limit | tool-approval).
    kind: 'tool-approval' as const,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'cancel', label: 'Cancel' }],
    prompt: 'Approve tool call: ask_user',
    requestId: 'req-approval-1',
  }
  const askUserApprovalPark = evInputRequested([realApprovalRequest])

  it('the fixture matches eve’s real input-request contract (so these tests prove the real contract)', () => {
    expect(isInputRequest(realApprovalRequest)).toBe(true)
  })

  /**
   * A fake session whose FIRST dispatch returns a park stream that DOES NOT
   * complete until `release()` is called (mimicking eve holding the NDJSON
   * connection open at session.waiting — so the session's stream cursor has not
   * advanced and the turn is still active). The REAL bug: answering before that
   * drain issues a `respond()` against a still-active turn → eve answers HTTP 409
   * session_not_active → no resume, dead button. Here the transport's `drained`
   * gate must make answerPermission WAIT for the release before it responds.
   */
  function makeGatedTransport(opts?: { failResume?: boolean }) {
    let releasePark: () => void = () => {}
    const parkDrained = new Promise<void>((r) => { releasePark = r })
    const { client, dispatches: sends } = makeFakeClient((d, i) => {
      if (d.kind === 'respond' && opts?.failResume) {
        throw new Error('resume POST failed (network)')
      }
      if (i === 0) {
        return {
          sessionId: 'wrun_ABC',
          async *[Symbol.asyncIterator]() {
            yield askUserApprovalPark
            // Suspend at the park until the test releases it (the drain boundary).
            await parkDrained
          },
        }
      }
      return makeResponse('wrun_ABC', [
        evTextDelta('Staging, US.'),
        evTextDone('Staging, US.'),
        evTurnDone(),
      ])
    })
    const persists: Array<{ body: any }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async (a) => { if (!a.body.onSend) persists.push(a as any) },
      createClient: () => client as never,
    })
    return { transport, sends, releasePark, persists }
  }

  async function readToPicker(stream: ReadableStream<UIMessageChunk>) {
    const reader = stream.getReader()
    let picker: any
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') { picker = value; break }
    }
    return { reader, picker }
  }

  it('REGRESSION (live round-3): eve emits turn.completed on a PARKED turn — the stream must stay open and the answer must still resume it', async () => {
    // Observed live on eve 0.22.4 (headless repro against the local dev stack):
    // the event order at an ask_user pause is actions.requested → step.completed
    // → input.requested → turn.completed → session.waiting. eve completes the
    // TURN ledger entry even though the SESSION parks. The pre-fix transport
    // treated turn.completed as an unconditional finish+close, settling the turn
    // (and detaching it) the instant the picker rendered — so Submit found no
    // open turn and the conversation died. This fixture reproduces that exact
    // order; the park must NOT finish the stream, and the answer must resume it.
    const { transport, dispatches } = makeTransport([
      [
        evToolCall('call_real_abc', 'ask_user', { questions }),
        askUserApprovalPark,
        evTurnDone(), // ← the killer: turn.completed WHILE parked
      ],
      [evTextDelta('You chose Staging.'), evTextDone('You chose Staging.'), evTurnDone()],
    ])

    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    const beforeAnswer: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      beforeAnswer.push(value)
      if (value.type === 'tool-input-available') break
    }
    // Let the rest of the park stream (input.requested + turn.completed) drain.
    await new Promise((r) => setTimeout(r, 0))
    expect(beforeAnswer.some((c) => c.type === 'finish')).toBe(false)

    // Submit. Pre-fix: the turn is already settled → answerPermission bails and
    // no resume send ever fires (the dead chat). Post-fix: the resume streams the
    // reply into the SAME still-open stream, then closes it.
    const answerPromise = transport.answerPermission('chat-1', 'call_real_abc', {
      'Which env?': 'Staging',
      Region: 'US',
    })
    const afterAnswer: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      afterAnswer.push(value)
    }
    await answerPromise

    expect(dispatches.length).toBe(2) // initial create + resume respond (pre-fix: 1)
    const deltas = afterAnswer
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { delta: string }).delta)
    expect(deltas).toContain('You chose Staging.') // the reply reached the SAME stream
    expect(afterAnswer.some((c) => c.type === 'finish')).toBe(true) // closed cleanly at the END
    expect(dispatches[1].kind).toBe('respond')
    const resume = dispatches[1] as {
      inputResponses?: Array<{ requestId: string; optionId?: string }>
    }
    expect(resume.inputResponses?.[0]).toMatchObject({
      requestId: 'req-approval-1',
      optionId: 'approve',
    })
  })

  it('the answered picker KEEPS the user’s answers: the resume’s action.result (the execute note) must not clobber { answers } (legacy-parity rendering)', async () => {
    // After the approval resolves, eve executes ask_user and streams an
    // action.result whose output is the tool's internal note ({ asked, note }).
    // Projecting that overwrote the { answers } the panel flipped in, and
    // chat-message's extractQuestionAnswers found nothing → the submitted
    // answers vanished from the thread (they render on the cloud path). The
    // transport must keep the user's answers as the part output, live + persisted.
    const persists: Array<{ body: { parts: Array<Record<string, unknown>> } }> = []
    const { transport } = makeTransport(
      [
        [
          evToolCall('call_real_abc', 'ask_user', { questions }),
          askUserApprovalPark,
          evTurnDone(),
        ],
        [
          evToolResult('call_real_abc', {
            asked: ['Which env?', 'Region?'],
            note: 'The user has answered…',
          }),
          evTextDelta('Staging, US.'),
          evTextDone('Staging, US.'),
          evTurnDone(),
        ],
      ],
      { onPersist: (a) => persists.push(a as never) },
    )

    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') break
    }
    await new Promise((r) => setTimeout(r, 0))

    const answers = { 'Which env?': 'Staging', Region: 'US' }
    const answerPromise = transport.answerPermission('chat-1', 'call_real_abc', answers)
    const afterAnswer: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      afterAnswer.push(value)
    }
    await answerPromise

    // The live chunk carries the USER'S answers, not the execute note.
    const outputChunk = afterAnswer.find((c) => c.type === 'tool-output-available') as
      | { output: unknown }
      | undefined
    expect(outputChunk?.output).toEqual({ answers })

    // The persisted projection carries them too (a reload renders the summary).
    expect(persists.length).toBe(1)
    const askPart = persists[0].body.parts.find(
      (p) => p.type === 'dynamic-tool' && p.toolName === 'ask_user',
    )
    expect(askPart?.state).toBe('output-available')
    expect(askPart?.output).toEqual({ answers })
  })

  it('the picker part carries the REAL eve tool-call callId (not the requestId) + the questions', async () => {
    const { transport, releasePark } = makeGatedTransport()
    const { picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    expect(picker.toolCallId).toBe('call_real_abc') // action.callId, NOT req-approval-1
    expect(picker.toolName).toBe('ask_user')
    expect(picker.input.questions).toEqual(questions)
    releasePark()
  })

  it('ROOT CAUSE: answering BEFORE the park stream drains still fires the resume send (waits for the drain gate, no lost POST)', async () => {
    // This is the dead-Submit reproduction: the picker renders on input.requested,
    // which arrives BEFORE the session.waiting boundary that advances the eve
    // session. A pre-fix transport sent the resume immediately → eve threw before
    // any POST (createHandleMessageBody → null on an un-advanced session). The fix
    // awaits `turn.drained`, so the resume only sends AFTER the park drains.
    const { transport, sends, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))

    // Answer WHILE the park stream is still open (not drained). The resume must NOT
    // have fired yet — it is blocked on the drain gate.
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {
      'Which env?': 'Staging',
      Region: 'US',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(sends.length).toBe(1) // ONLY the initial send — resume is gated

    // Release the park (the drain boundary → session advanced). Now the resume fires.
    releasePark()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answerPromise

    // The resume POST fired (2 dispatches): the dead-Submit bug is fixed, and it
    // went through respond() — the 0.47.7 HITL entry point.
    expect(sends.length).toBe(2)
    expect(sends[1].kind).toBe('respond')
    const resume = sends[1] as { inputResponses?: Array<{ requestId: string; optionId?: string; text?: string }> }
    expect(resume.inputResponses?.[0].requestId).toBe('req-approval-1')
  })

  it('resumes an APPROVAL with the REQUEST’S OWN approve option id (not a blind literal) + a valid eve InputResponse', async () => {
    const { transport, sends, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {
      'Which env?': 'Staging',
      Region: 'US',
    })
    releasePark()
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answerPromise

    expect(sends[1].kind).toBe('respond')
    const resume = sends[1] as {
      inputResponses?: Array<{ requestId: string; optionId?: string; text?: string }>
    }
    const ir = resume.inputResponses![0]
    // The option id is taken from the request's options ('approve'), and the
    // response validates against eve's REAL input-response contract (isInputResponse).
    expect(ir.optionId).toBe('approve')
    expect(ir.requestId).toBe('req-approval-1')
    expect(isInputResponse(ir)).toBe(true)
    // eve DISCARDS `text` on an approval response, so we do NOT send it — the
    // answers ride as clientContext instead (see next test).
    expect(ir.text).toBeUndefined()
  })

  it('THREADS the user’s answers to the model as respond() clientContext (message+inputResponses is a 400 in 0.47.7; text on an approval is discarded)', async () => {
    const { transport, sends, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {
      'Which env?': 'Staging',
      Region: 'US',
    })
    releasePark()
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answerPromise

    expect(sends[1].kind).toBe('respond')
    const resume = sends[1] as {
      inputResponses?: Array<{ requestId: string; optionId?: string }>
      message?: string
      options: { clientContext?: string }
    }
    // The approval is resolved (optionId) and the choice rides as clientContext on
    // the SAME respond(). It must NOT ride as `message`: eve 0.47.7's channel route
    // rejects message + inputResponses together with HTTP 400 (mutually exclusive).
    expect(resume.inputResponses![0].optionId).toBe('approve')
    expect(resume.message).toBeUndefined()
    const ctx = resume.options.clientContext
    expect(typeof ctx).toBe('string')
    expect(ctx).toContain('Which env?')
    expect(ctx).toContain('Staging')
    expect(ctx).toContain('Region')
    expect(ctx).toContain('US')
  })

  it('flips the accumulated ask_user part to output-available (truthful persist) after the answer', async () => {
    const { transport, persists, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {
      'Which env?': 'Staging',
      Region: 'US',
    })
    releasePark()
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answerPromise

    expect(persists).toHaveLength(1)
    const askPart = persists[0].body.parts.find(
      (p: any) => p.type === 'dynamic-tool' && p.toolName === 'ask_user',
    )
    expect(askPart).toMatchObject({
      state: 'output-available',
      output: { answers: { 'Which env?': 'Staging', Region: 'US' } },
    })
  })

  it('DISMISS (X) resumes with optionId "cancel" and the turn closes cleanly', async () => {
    const { transport, sends, releasePark } = makeGatedTransport()
    const stream = await transport.sendMessages(sendOpts())
    const { reader, picker } = await readToPicker(stream)
    // The X path in chat-panel calls answerPermission(id, {}, '(dismissed)').
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {}, '(dismissed)')
    releasePark()
    let closed = false
    for (;;) {
      const { done } = await reader.read()
      if (done) { closed = true; break }
    }
    await answerPromise

    // A resume respond() fired (the parked turn is NOT left hanging) with the cancel
    // id taken from the request's own options, plus clientContext telling the model
    // it was dismissed (so the model resumes rather than stalling on a silent
    // cancel). Never `message` — that combination is a 400 in eve 0.47.7.
    expect(sends.length).toBe(2)
    expect(sends[1].kind).toBe('respond')
    const ir = (sends[1] as any).inputResponses[0]
    expect(ir.optionId).toBe('cancel')
    expect(isInputResponse(ir)).toBe(true)
    expect((sends[1] as any).message).toBeUndefined()
    expect(typeof (sends[1] as any).options.clientContext).toBe('string')
    expect((sends[1] as any).options.clientContext.toLowerCase()).toContain('dismiss')
    // The stream closed → useChat leaves `streaming`.
    expect(closed).toBe(true)
  })

  it('Skip resumes with optionId "cancel" too: only an untyped response dismisses', async () => {
    const { transport, sends, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    // QuestionPopover's Skip calls answerPermission(id, {}, '(skipped)'), no `typed`.
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {}, '(skipped)')
    releasePark()
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answerPromise

    expect((sends[1] as any).inputResponses[0].optionId).toBe('cancel')
    expect((sends[1] as any).options.clientContext.toLowerCase()).toContain('dismiss')
  })

  it('a TYPED reply (the composer, #681 rule) ANSWERS the question: approve, never cancel, and the words reach the model', async () => {
    const { transport, sends, persists, releasePark } = makeGatedTransport()
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))
    // chat-panel's submitTurn: answerPermission(id, {}, typed, { typed: true }).
    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {}, 'Staging, in the EU', {
      typed: true,
    })
    releasePark()
    let closed = false
    for (;;) {
      const { done } = await reader.read()
      if (done) { closed = true; break }
    }
    await answerPromise

    // The approval is APPROVED (the ask_user execute runs and says "the user has
    // answered"), not cancelled ("tool execution was denied" → a second picker).
    expect(sends).toHaveLength(2)
    expect(sends[1].kind).toBe('respond')
    const ir = (sends[1] as any).inputResponses[0]
    expect(ir.optionId).toBe('approve')
    expect(ir.requestId).toBe('req-approval-1')
    expect(isInputResponse(ir)).toBe(true)
    expect((sends[1] as any).message).toBeUndefined()
    // The typed words ride as clientContext: the person's answer to both questions.
    const ctx: string = (sends[1] as any).options.clientContext
    expect(ctx).toContain('Staging, in the EU')
    expect(ctx).toContain('Which env?')
    expect(ctx).toContain('Region?')
    expect(ctx).toMatch(/^I answered the questions/)
    expect(ctx.toLowerCase()).not.toContain('dismiss')
    // The persisted part keeps the typed words as the answer (the receipt).
    const askPart = persists[0].body.parts.find(
      (p: any) => p.type === 'dynamic-tool' && p.toolName === 'ask_user',
    )
    expect(askPart).toMatchObject({ state: 'output-available', output: { response: 'Staging, in the EU' } })
    expect(closed).toBe(true)
  })

  it('FAILED resume send restores the mapping so a retry (Submit again) works', async () => {
    const { transport, sends, releasePark } = makeGatedTransport({ failResume: true })
    const { reader, picker } = await readToPicker(await transport.sendMessages(sendOpts()))

    // First answer: the resume send throws → the mapping must be restored (button
    // not permanently dead). Turn stays open (parked) for the retry.
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = transport.answerPermission('chat-1', picker.toolCallId, { 'Which env?': 'Staging', Region: 'US' })
    releasePark()
    await first
    // The failed send was surfaced (not silent).
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()

    // The retry reaches answerPermission's send again (mapping was restored) — 3rd
    // send call total (initial + failed resume + retry). The retry here also fails
    // (same gated transport), but the key assertion is it ATTEMPTED the send.
    const sendsBefore = sends.length
    await transport.answerPermission('chat-1', picker.toolCallId, { 'Which env?': 'Staging', Region: 'US' })
      .catch(() => {})
    expect(sends.length).toBeGreaterThan(sendsBefore)
    // consume the still-open reader so the test doesn't leak.
    void reader.cancel()
  })

  it('answerPermission with an unknown toolCallId is NON-SILENT (logs, does not send)', async () => {
    const { transport, sends, releasePark } = makeGatedTransport()
    await readToPicker(await transport.sendMessages(sendOpts()))
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await transport.answerPermission('chat-1', 'call-does-not-exist', { x: 'y' })
    expect(consoleErr).toHaveBeenCalled() // surfaced the reason + ids
    expect(sends.length).toBe(1) // no resume send fired
    consoleErr.mockRestore()
    releasePark()
  })

  // ── Client resilience: held-pending re-park + empty resumed stream ────────────

  it('RE-PARK: if the resumed stream re-emits the SAME approval request (held pending), the mapping is re-registered so the user can answer again', async () => {
    // The resume send #1 returns a stream that RE-EMITS the same input.requested
    // (mimicking eve holding the approval pending and re-surfacing it — the
    // held-pending case). answerPermission must leave the turn open AND re-register
    // the callId→requestId mapping so a SECOND answerPermission can resume it.
    const { client, dispatches: sends } = makeFakeClient((d, i) => {
      if (i === 0) {
        return makeResponse('wrun_ABC', [askUserApprovalPark])
      }
      if (d.kind === 'respond' && sends.filter((s) => s.kind === 'respond').length === 1) {
        // FIRST resume → re-park on the same request (held pending).
        return makeResponse('wrun_ABC', [askUserApprovalPark])
      }
      // SECOND resume → the real reply, then close.
      return makeResponse('wrun_ABC', [evTextDelta('OK.'), evTextDone('OK.'), evTurnDone()])
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })

    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    let picker: any
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') { picker = value; break }
    }

    // First answer → resume re-parks on the same request. The turn stays OPEN.
    await transport.answerPermission('chat-1', picker.toolCallId, { 'Which env?': 'Staging', Region: 'US' })

    // The mapping was re-registered (the re-emitted input.requested re-opened it),
    // so a SECOND answer resumes the turn to completion.
    const secondAnswer = transport.answerPermission('chat-1', picker.toolCallId, { 'Which env?': 'Prod', Region: 'EU' })
    for (;;) { const { done } = await reader.read(); if (done) break }
    await secondAnswer

    // Two resume respond()s fired (first re-parked, second completed) — the button
    // was never dead after the re-park.
    const resumes = sends.filter((s) => s.kind === 'respond')
    expect(resumes.length).toBe(2)
    expect((resumes[1] as any).inputResponses[0].requestId).toBe('req-approval-1')
  })

  it('EMPTY resumed stream still CLOSES the turn (no wedge) even when eve streams no events back', async () => {
    // The resume send returns an IMMEDIATELY-empty stream (no events, no
    // turn.completed). The turn must still close so useChat leaves `streaming` —
    // the chat can never wedge on a silent resume.
    const { client } = makeFakeClient((_d, i) => {
      if (i === 0) return makeResponse('wrun_ABC', [askUserApprovalPark])
      return makeResponse('wrun_ABC', []) // empty resumed stream
    })
    const persists: Array<{ body: any }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async (a) => { if (!a.body.onSend) persists.push(a as any) },
      createClient: () => client as never,
    })

    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    let picker: any
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') { picker = value; break }
    }

    const answerPromise = transport.answerPermission('chat-1', picker.toolCallId, {
      'Which env?': 'Staging',
      Region: 'US',
    })
    let closed = false
    for (;;) {
      const { done } = await reader.read()
      if (done) { closed = true; break }
    }
    await answerPromise

    // The turn closed despite the empty resumed stream, and it persisted once.
    expect(closed).toBe(true)
    expect(persists).toHaveLength(1)
  })
})

describe('EveChatTransport — session-limit prompt (Continue / Stop)', () => {
  // The EXACT request eve 0.79.1 raises at a session's token budget
  // (harness/hitl/budget-request.js createSessionLimitContinuationRequest).
  const sessionLimitRequest = {
    action: {
      callId: 'wrun_ABC:3:limit:input:40044247',
      input: { kind: 'input', limit: 40_000_000, usedTokens: 40_044_247 },
      kind: 'tool-call' as const,
      toolName: 'session_limit_continuation',
    },
    allowFreeform: false,
    display: 'confirmation' as const,
    kind: 'session-limit' as const,
    options: [
      { description: 'Grant a fresh token budget', id: 'continue', label: 'Approve', style: 'primary' as const },
      { description: 'Stop now', id: 'stop', label: 'Stop', style: 'danger' as const },
    ],
    prompt: 'This session has hit the input-token limit (40M) per session.',
    requestId: 'wrun_ABC:3:limit:input:40044247',
  }
  const callId = sessionLimitRequest.action.callId

  function parkedOnLimit(resume: HandleMessageStreamEvent[] = [evTextDelta('Carrying on.'), evTextDone('Carrying on.'), evTurnDone()]) {
    return makeTransport([[evInputRequested([sessionLimitRequest]), evTurnDone()], resume])
  }

  async function readToCard(stream: ReadableStream<UIMessageChunk>) {
    const reader = stream.getReader()
    let card: any
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') { card = value; break }
    }
    await new Promise((r) => setTimeout(r, 0))
    return { reader, card }
  }

  it('the fixture matches eve’s real input-request contract', () => {
    expect(isInputRequest(sessionLimitRequest)).toBe(true)
  })

  it('draws the prompt as a session_limit_continuation part, held open and answerable here', async () => {
    const { transport } = parkedOnLimit()
    const { card } = await readToCard(await transport.sendMessages(sendOpts()))
    expect(card).toMatchObject({ toolName: 'session_limit_continuation', toolCallId: callId, input: { kind: 'input', limit: 40_000_000 } })
    expect(transport.hasOpenInputRequest('chat-1', callId)).toBe(true)
    expect(transport.hasOpenInputRequest('chat-1', 'some-other-call')).toBe(false)
    expect(transport.hasOpenInputRequest('another-chat', callId)).toBe(false)
  })

  it('Continue answers with eve’s `continue` option and tells the model nothing; the reply carries on in the same stream', async () => {
    const { transport, dispatches } = parkedOnLimit()
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    const answered = transport.answerPermission('chat-1', callId, {})
    const after: UIMessageChunk[] = []
    for (;;) { const { value, done } = await reader.read(); if (done) break; after.push(value) }
    await answered

    expect(dispatches[1].kind).toBe('respond')
    const ir = (dispatches[1] as any).inputResponses[0]
    expect(ir).toEqual({ requestId: sessionLimitRequest.requestId, optionId: 'continue' })
    expect(isInputResponse(ir)).toBe(true)
    expect((dispatches[1] as any).options?.clientContext).toBeUndefined()
    expect(after.some((c) => c.type === 'text-delta' && (c as { delta: string }).delta === 'Carrying on.')).toBe(true)
    expect(transport.hasOpenInputRequest('chat-1', callId)).toBe(false)
    // eve sends no result for its own prompt: the answer settles the card's part on the live stream.
    expect(after.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available',
      toolCallId: callId,
      output: { answers: {} },
      dynamic: true,
    })
  })

  it('Stop (the dismissal) answers with eve’s `stop` option, never a text response', async () => {
    const { transport, dispatches } = parkedOnLimit([ev({ type: 'turn.cancelled', data: {} } as never)])
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    const answered = transport.answerPermission('chat-1', callId, {}, 'stop')
    const after: UIMessageChunk[] = []
    for (;;) { const { value, done } = await reader.read(); if (done) break; after.push(value) }
    await answered
    expect(after.find((c) => c.type === 'tool-output-available')).toMatchObject({ toolCallId: callId, output: { response: 'stop' } })

    const ir = (dispatches[1] as any).inputResponses[0]
    expect(ir).toEqual({ requestId: sessionLimitRequest.requestId, optionId: 'stop' })
    expect((dispatches[1] as any).options?.clientContext).toBeUndefined()
  })

  it('typed words still only continue: a session-limit answer never carries words to the model', async () => {
    const { transport, dispatches } = parkedOnLimit()
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    const answered = transport.answerPermission('chat-1', callId, {}, 'keep going', { typed: true })
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answered

    expect((dispatches[1] as any).inputResponses[0].optionId).toBe('continue')
    expect((dispatches[1] as any).options?.clientContext).toBeUndefined()
  })

  /** A transport over a scripted client whose respond can fail, with an injected usage check. */
  function parkedWith(opts: { respondFails?: boolean; checkUsage?: () => Promise<'ok' | 'blocked' | 'unknown'> }) {
    const { client, dispatches } = makeFakeClient((d, i) => {
      if (d.kind === 'respond' && opts.respondFails) throw new Error('resume POST failed (network)')
      if (i === 0) return makeResponse('wrun_ABC', [evInputRequested([sessionLimitRequest]), evTurnDone()])
      return makeResponse('wrun_ABC', [evTextDelta('Carrying on.'), evTextDone('Carrying on.'), evTurnDone()])
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
      ...(opts.checkUsage ? { checkUsage: opts.checkUsage } : {}),
    })
    return { transport, dispatches }
  }

  async function chunksUntilQuiet(reader: ReadableStreamDefaultReader<UIMessageChunk>): Promise<UIMessageChunk[]> {
    const out: UIMessageChunk[] = []
    for (;;) {
      const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 20))])
      if (next === null || next.done) return out
      out.push(next.value)
    }
  }

  it('a Stop whose respond fails stays answerable: no "Stopped" result, the turn not closed (eve still holds the prompt)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { transport } = parkedWith({ respondFails: true })
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    await transport.answerPermission('chat-1', callId, {}, 'stop')
    const after = await chunksUntilQuiet(reader)

    expect(after.some((c) => c.type === 'tool-output-available')).toBe(false)
    expect(after.some((c) => c.type === 'finish')).toBe(false)
    expect(transport.hasOpenInputRequest('chat-1', callId)).toBe(true)
    errors.mockRestore()
  })

  it('a Stop skips the usage check (it runs no model call) and reaches eve even when usage is blocked', async () => {
    const checkUsage = vi.fn(async () => 'blocked' as const)
    const { transport, dispatches } = parkedWith({ checkUsage })
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    const answered = transport.answerPermission('chat-1', callId, {}, 'stop')
    for (;;) { const { done } = await reader.read(); if (done) break }
    await answered

    expect(checkUsage).not.toHaveBeenCalled()
    expect((dispatches[1] as any).inputResponses[0]).toEqual({ requestId: sessionLimitRequest.requestId, optionId: 'stop' })
  })

  it('a Continue while usage is blocked is not sent and stays answerable, with no "Continued" result', async () => {
    const { transport, dispatches } = parkedWith({ checkUsage: async () => 'blocked' })
    const { reader } = await readToCard(await transport.sendMessages(sendOpts()))
    await transport.answerPermission('chat-1', callId, {})
    const after = await chunksUntilQuiet(reader)

    expect(dispatches.filter((d) => d.kind === 'respond')).toHaveLength(0)
    expect(after.some((c) => c.type === 'tool-output-available')).toBe(false)
    expect(transport.hasOpenInputRequest('chat-1', callId)).toBe(true)
  })
})

describe('EveChatTransport — failures', () => {
  it('a turn.failed event fails the stream (surfaced, not silent)', async () => {
    const { transport } = makeTransport([evTextDelta('partial'), evTurnFailed('boom')])
    const stream = await transport.sendMessages(sendOpts())
    expect(await drain(stream)).toContainEqual({ type: 'error', errorText: 'boom' })
  })
})

describe('EveChatTransport — mint 401 refresh + retry', () => {
  /**
   * Build a transport whose mint fails with a 401 (SESSION_EXPIRED) a set number
   * of times before succeeding. Records the accessToken each mint attempt saw so
   * a test can prove the retry ran with the FRESH token.
   */
  function makeRefreshTransport(opts: {
    failCount: number // how many leading mints 401 before success
    refreshTo: string | null // what refreshAccessToken resolves to
  }) {
    const mintTokens: Array<string | null> = []
    const refreshCalls: number[] = []
    let currentToken: string | null = 'stale-jwt'
    let attempts = 0

    const { client, dispatches } = makeFakeClient(() =>
      makeResponse('wrun_ABC', [evTextDelta('hi'), evTextDone('hi'), evTurnDone()]),
    )

    const transport = new EveChatTransport({
      getAccessToken: () => currentToken,
      refreshAccessToken: async () => {
        refreshCalls.push(1)
        currentToken = opts.refreshTo // mirror the real hook updating the cached ref
        return opts.refreshTo
      },
      mintRunToken: async (args) => {
        mintTokens.push(args.accessToken)
        if (attempts++ < opts.failCount) {
          // Mirror the default fetch path: a 401 error carrying `status`.
          throw Object.assign(new Error('Session expired'), { status: 401, code: 'SESSION_EXPIRED' })
        }
        return { token: 'tok.sig', conversationId: 'conv-1' }
      },
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })
    return { transport, mintTokens, refreshCalls, dispatches }
  }

  it('refreshes once and retries the mint with the fresh token, then the send proceeds', async () => {
    const { transport, mintTokens, refreshCalls, dispatches } = makeRefreshTransport({
      failCount: 1,
      refreshTo: 'fresh-jwt',
    })

    const chunks = await drain(await transport.sendMessages(sendOpts()))

    // refreshAccessToken called exactly once.
    expect(refreshCalls).toHaveLength(1)
    // The first mint used the stale token; the retry used the freshly-refreshed one.
    expect(mintTokens).toEqual(['stale-jwt', 'fresh-jwt'])
    // The turn actually streamed (the send fired after the successful retry).
    expect(dispatches).toHaveLength(1)
    expect(chunks.some((c) => c.type === 'text-delta' || c.type === 'text-start')).toBe(true)
  })

  it('throws the session-expired copy when the retry also 401s (no second retry)', async () => {
    const { transport, mintTokens, refreshCalls, dispatches } = makeRefreshTransport({
      failCount: 2, // both the initial mint AND the retry 401
      refreshTo: 'fresh-but-also-rejected',
    })

    await expect(transport.sendMessages(sendOpts())).rejects.toThrow(
      'Your session expired — reload the page and try again.',
    )
    // Refreshed once, minted exactly twice (initial + one retry — NOT a loop).
    expect(refreshCalls).toHaveLength(1)
    expect(mintTokens).toHaveLength(2)
    // The send never fired — the turn failed before streaming.
    expect(dispatches).toHaveLength(0)
  })

  it('throws the reload copy when the token cannot be refreshed', async () => {
    const { transport, refreshCalls, mintTokens } = makeRefreshTransport({
      failCount: 1,
      refreshTo: null, // refresh yields nothing (no live refresh token)
    })

    await expect(transport.sendMessages(sendOpts())).rejects.toThrow(
      'Your session expired — reload the page and try again.',
    )
    expect(refreshCalls).toHaveLength(1)
    // Only the initial mint ran; no retry, since there was no fresh token.
    expect(mintTokens).toHaveLength(1)
  })

  it('does NOT refresh/retry a 429 usage-limit mint — it surfaces verbatim', async () => {
    const { client, dispatches } = makeFakeClient(() => makeResponse("wrun_ABC", []))
    let refreshed = 0
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      refreshAccessToken: async () => {
        refreshed++
        return 'fresh'
      },
      mintRunToken: async () => {
        throw Object.assign(new Error('Usage limit exceeded. Resets 2026-08-01.'), {
          status: 429,
          code: 'RATE_LIMITED',
        })
      },
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })

    await expect(transport.sendMessages(sendOpts())).rejects.toThrow('Usage limit exceeded')
    // A 429 must NOT trigger the refresh path (it would just 429 again).
    expect(refreshed).toBe(0)
    expect(dispatches).toHaveLength(0)
  })

  it('surfaces the mint error unchanged when no refreshAccessToken hook is provided', async () => {
    const { client, dispatches } = makeFakeClient(() => makeResponse("wrun_ABC", []))
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      // no refreshAccessToken
      mintRunToken: async () => {
        throw Object.assign(new Error('Session expired'), { status: 401, code: 'SESSION_EXPIRED' })
      },
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })

    // Without the hook, the original 401 body error propagates (current behavior).
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow('Session expired')
    expect(dispatches).toHaveLength(0)
  })
})

describe('EveChatTransport — per-turn header refresh', () => {
  it('sends the FRESH token + ctx on every turn, not the seed baked into the cached client', async () => {
    const sends: Array<Record<string, string> | undefined> = []
    let turn = 0
    const { client } = makeFakeClient((d) => {
      sends.push(d.options.headers as Record<string, string> | undefined)
      return makeResponse('wrun_ABC', [evTextDone('ok'), evTurnDone()])
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      // A distinct token per turn — the short-lived token that would otherwise
      // expire on a long-open chat if only the constructor seed were ever used.
      mintRunToken: async () => ({ token: `tok-${++turn}`, conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })

    await drain(await transport.sendMessages(sendOpts({ systemContext: { conversationContext: 'mail' } })))
    await drain(await transport.sendMessages(sendOpts({ systemContext: { conversationContext: 'calendar' } })))

    // Both sends carried per-request headers, and turn 2's token is the fresh one
    // (not tok-1 from the seed) — the bug was the cached client pinning turn 1's token.
    expect(sends[0]?.['x-chat-run-token']).toBe('tok-1')
    expect(sends[1]?.['x-chat-run-token']).toBe('tok-2')
    // And the per-turn ctx differs (a different view per turn → different encoded ctx).
    expect(sends[0]?.['x-chat-run-ctx']).toBeTruthy()
    expect(sends[1]?.['x-chat-run-ctx']).toBeTruthy()
    expect(sends[1]?.['x-chat-run-ctx']).not.toBe(sends[0]?.['x-chat-run-ctx'])
  })
})

describe('EveChatTransport — session ownership registration', () => {
  it('registers eve_session_id the instant the session id lands, BEFORE draining', async () => {
    const registered: Array<{ conversationId: string; sessionId: string }> = []
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()], {
      onRegister: (a) => registered.push(a),
      sessionId: 'wrun_XYZ',
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ conversationId: 'conv-1', sessionId: 'wrun_XYZ' })
  })

  it('registers only ONCE across two turns on the same session', async () => {
    const registered: Array<{ sessionId: string; conversationId: string; accessToken: string | null }> = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      onRegister: (a) => registered.push(a),
    })
    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))
    expect(registered).toHaveLength(1)
  })
})

describe('EveChatTransport — settled-turn safety', () => {
  it('drops events that arrive after the turn already settled (never re-emits into a closed stream)', async () => {
    // turn.completed settles the turn; a trailing text delta must be ignored.
    const { transport } = makeTransport([
      evTextDone('done'),
      evTurnDone(),
      evTextDelta('LATE — should be dropped'),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    // Exactly one finish; the late delta produced no text-delta after it.
    const finishIdx = chunks.findIndex((c) => c.type === 'finish')
    expect(finishIdx).toBeGreaterThanOrEqual(0)
    const afterFinish = chunks.slice(finishIdx + 1)
    expect(afterFinish).toHaveLength(0)
  })
})

describe('EveChatTransport — per-turn ctx encoding', () => {
  it('base64url-encodes systemContext into a decodable ctx, and drops a stray searchSettings and an old model pick', () => {
    const ctx = encodeTurnContext({
      body: {
        systemContext: { conversationContext: 'viewing capture X' },
        // The removed "My captures" picker: an old body may still carry it.
        searchSettings: { timeWindow: 'recent' },
        // Nobody picks a model any more: an old body's model and thinking never ride the ctx.
        model: 'claude-haiku-4-5',
        thinking: 'max',
      },
    })
    expect(ctx).toBeTruthy()
    // Round-trips through the same base64url the spec route decodes.
    const json = Buffer.from(ctx, 'base64url').toString('utf8')
    expect(JSON.parse(json)).toEqual({
      systemContext: { conversationContext: 'viewing capture X' },
    })
    expect(encodeTurnContext({ body: { searchSettings: { timeWindow: 'all' } } })).toBe('')
  })

  it("adds the cards on screen to the turn's systemContext, read at send time", () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    const cards = [{ n: 1, id: 'call_1', kind: 'list', title: 'Mine' }]
    expect(decode(encodeTurnContext({ body: { systemContext: { liveCaptureId: 'cap' } } }, cards))).toEqual({
      systemContext: { liveCaptureId: 'cap', cards },
    })
    expect(decode(encodeTurnContext({ body: {} }, cards))).toEqual({ systemContext: { cards } })
    expect(encodeTurnContext({ body: {} }, [])).toBe('')
  })

  it("says the browser's zone with the turn, so a calendar card's days are counted where they are drawn", () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    expect(decode(encodeTurnContext({ body: { systemContext: { liveCaptureId: 'cap' } } }, undefined, 'America/New_York'))).toEqual({
      systemContext: { liveCaptureId: 'cap', timeZone: 'America/New_York' },
    })
    expect(decode(encodeTurnContext({ body: {} }, [{ n: 1 }], 'Asia/Tokyo'))).toEqual({ systemContext: { timeZone: 'Asia/Tokyo', cards: [{ n: 1 }] } })
  })

  it("carries the person's local conditions in the turn's systemContext when there is a reading", () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    const surroundings = { condition: 'Light rain', temperatureC: 9.4, city: 'Toronto' }
    expect(decode(encodeTurnContext({ body: { systemContext: { liveCaptureId: 'cap' } } }, undefined, 'America/Toronto', surroundings))).toEqual({
      systemContext: { liveCaptureId: 'cap', timeZone: 'America/Toronto', surroundings },
    })
    expect(decode(encodeTurnContext({ body: {} }, undefined, null, surroundings))).toEqual({ systemContext: { surroundings } })
    expect(encodeTurnContext({ body: {} }, undefined, null, null)).toBe('')
  })

  it('sends the turn without its cards rather than an oversized header', () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    const huge = [{ n: 1, id: 'c', kind: 'list', title: 'x'.repeat(20_000) }]
    const ctx = encodeTurnContext({ body: { systemContext: { liveCaptureId: 'cap' } } }, huge)
    expect(ctx.length).toBeLessThanOrEqual(MAX_CTX_WITH_CARDS)
    expect(decode(ctx)).toEqual({ systemContext: { liveCaptureId: 'cap' } })
  })

  it('the reactions since the last message and the message replied to ride the ctx with the rest of systemContext, well inside the cards cap', () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    // The most a turn carries: REACTION_NOTES_MAX notes at REACTION_EXCERPT_CHARS, and a full quote.
    const full = (letter: string) => {
      const reactions = Array.from({ length: 8 }, (_, i) => ({ emoji: '👍🏽', excerpt: letter.repeat(200), asked: i % 2 === 0, at: `2026-10-20T10:0${i}:00.000Z` }))
      const replyTo = { messageId: 'eve-msg-1', role: 'assistant', quote: letter.repeat(600), part: true }
      return { reactions, replyTo }
    }
    const plain = full('e')
    const ctx = encodeTurnContext({ body: { systemContext: plain } }, [{ n: 1 }])
    expect(decode(ctx)).toEqual({ systemContext: { ...plain, cards: [{ n: 1 }] } })
    // Plain text: under a third of the cap. Two-byte letters throughout: still
    // room for the cards (they go without past the cap, never the turn).
    expect(ctx.length).toBeLessThan(MAX_CTX_WITH_CARDS / 3)
    const accented = full('é')
    const wide = encodeTurnContext({ body: { systemContext: accented } }, [{ n: 1 }])
    expect(decode(wide)).toEqual({ systemContext: { ...accented, cards: [{ n: 1 }] } })
    expect(wide.length).toBeLessThan(MAX_CTX_WITH_CARDS * 0.7)
  })

  it('returns empty string when there is no per-turn context', () => {
    expect(encodeTurnContext({ body: { conversationId: 'c' } })).toBe('')
  })

  it('carries the message\'s routing signals (auto model selection) beside the systemContext', () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    const route = turnRouteSignals('think hard about this', [{ fileName: 'a.pdf' }])
    expect(decode(encodeTurnContext({ body: {} }, undefined, null, null, route))).toEqual({ route })
    expect(decode(encodeTurnContext({ body: { systemContext: { liveCaptureId: 'cap' } } }, undefined, null, null, route))).toEqual({
      systemContext: { liveCaptureId: 'cap' },
      route,
    })
    expect(route).toEqual({ excerpt: 'think hard about this', chars: 21, attachmentKinds: ['pdf'], codeFences: 0, listItems: 0 })
    expect(encodeTurnContext({ body: {} }, undefined, null, null, null)).toBe('')
  })

  it('caps the route excerpt at 800 characters on both paths (with and without cards), so the ctx header stays small', () => {
    const decode = (ctx: string) => JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    const route = turnRouteSignals('x'.repeat(20_000))
    expect(route.excerpt.length).toBe(800)
    const plain = encodeTurnContext({ body: {} }, undefined, null, null, route)
    expect(decode(plain).route.excerpt.length).toBe(800)
    expect(plain.length).toBeLessThan(1_400)
    const withCards = encodeTurnContext({ body: {} }, [{ n: 1 }], null, null, route)
    expect(decode(withCards).route.excerpt.length).toBe(800)
  })

  it('a send computes the signals from the message itself, never from a model in the body', async () => {
    const sends: Array<Record<string, string> | undefined> = []
    const { client } = makeFakeClient((d) => {
      sends.push(d.options.headers as Record<string, string> | undefined)
      return makeResponse('wrun_ABC', [evTextDone('ok'), evTurnDone()])
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })
    await drain(await transport.sendMessages(sendOpts({ model: 'claude-sonnet-4-5-20250929', thinking: 'max' })))
    const ctx = JSON.parse(Buffer.from(sends[0]!['x-chat-run-ctx'], 'base64url').toString('utf8'))
    expect(ctx.route).toEqual(turnRouteSignals('hello'))
    expect(ctx.model).toBeUndefined()
    expect(ctx.thinking).toBeUndefined()
  })
})

describe('EveChatTransport — server-written discriminant on the start chunk', () => {
  it('emits start with a stable messageId + eve_written metadata (so autosave skips the assistant turn)', async () => {
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const start = chunks.find((c) => c.type === 'start') as
      | { messageId?: string; messageMetadata?: Record<string, unknown> }
      | undefined
    expect(start).toBeDefined()
    expect(typeof start!.messageId).toBe('string')
    expect(start!.messageId!.length).toBeGreaterThan(0)
    // The eve_written discriminant merges into the useChat message.metadata so
    // use-chat-auto-save's isServerWritten skips it.
    // Beside it, the reply's time as it is born (message-time.ts): its day line.
    expect(start!.messageMetadata).toEqual({ eve_written: true, createdAt: expect.any(String) })
    expect(Number.isFinite(Date.parse(start!.messageMetadata!.createdAt as string))).toBe(true)
  })
})

describe('EveChatTransport — turn-end persist', () => {
  it('saves the person’s message the moment it is sent, before the reply ends (a page that dies mid-turn keeps it)', async () => {
    const writes: Array<{ token: string; body: EvePersistBody }> = []
    const { transport } = makeTransport(
      [evInputRequested([{ requestId: 'req-1', display: 'select', prompt: 'Which?', action: { kind: 'tool-call', callId: 'c-q', toolName: 'ask_user', input: { questions: [] } } }])],
      { onPersist: (a) => writes.push(a as never), keepSendWrites: true },
    )
    // The turn parks on a question: the reply has not ended, its persist has not run.
    await readUntil(await transport.sendMessages(sendOpts()), (c) => c.type === 'tool-input-available')
    await transport.turnPersisted('chat-1')
    expect(writes).toHaveLength(1)
    expect(writes[0].token).toBe('tok.sig')
    expect(writes[0].body).toEqual({
      messageId: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      usage: { events: [], wallMs: 0 },
      onSend: true,
    })
  })

  it('persists the finalized turn with the rendered messageId, parts, and usage', async () => {
    const persists: Array<{ token: string; accessToken: string | null; body: any }> = []
    const { transport } = makeTransport(
      [
        evTextDelta('Hel'),
        evTextDelta('lo'),
        evTextDone('Hello'),
        evToolCall('call-1', 'create_action', { title: 'Ship' }),
        evToolResult('call-1', { id: 'ACT-1' }),
        // A step.completed with usage so the persist body carries billable usage.
        ev({ type: 'step.completed', data: { finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7 } } }),
        evTurnDone(),
      ],
      { onPersist: (a) => persists.push(a as any) },
    )
    const chunks = await drain(
      await transport.sendMessages(sendOpts()),
    )
    const start = chunks.find((c) => c.type === 'start') as { messageId?: string }

    expect(persists).toHaveLength(1)
    const body = persists[0].body
    // The persist messageId is EXACTLY the id stamped on the start chunk.
    expect(body.messageId).toBe(start.messageId)
    expect(body.role).toBe('assistant')
    expect(body.metadata).toEqual({ eve_written: true })
    // Parts: the accumulated text part + the dynamic-tool part flipped to output.
    const textPart = body.parts.find((p: any) => p.type === 'text')
    expect(textPart?.text).toBe('Hello')
    const toolPart = body.parts.find((p: any) => p.type === 'dynamic-tool')
    expect(toolPart).toMatchObject({
      toolName: 'create_action',
      toolCallId: 'call-1',
      state: 'output-available',
      output: { id: 'ACT-1' },
    })
    // Usage: the raw events + the wall clock ride along for mapEveTurnUsage (no picked model any more).
    expect(Array.isArray(body.usage.events)).toBe(true)
    expect(body.usage.events.some((e: any) => e.type === 'step.completed')).toBe(true)
    expect(typeof body.usage.wallMs).toBe('number')
    expect(body.usage.model).toBeUndefined()
    expect(body.usage.thinking).toBeUndefined()
    // The turn-opening USER message rides along (client id + parts) so the server
    // writes it BEFORE the assistant row — created_at ordering matches reading
    // order on reload (without it the end-of-turn autosave races the persist and
    // the reply renders above the question).
    expect(body.userMessage).toEqual({
      messageId: 'm1',
      parts: [{ type: 'text', text: 'hello' }],
    })
    // The freshest run token rode along.
    expect(persists[0].token).toBe('tok.sig')
  })

  it('the turn-opening user message keeps the card it replied to (metadata.replyCard), and nothing else of its metadata', async () => {
    const persists: Array<{ body: any }> = []
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()], { onPersist: (a) => persists.push(a as any) })
    const replyCard = { kind: 'card', id: '22222222-2222-4222-8222-222222222222', workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Fix', sentence: 'the build' }
    const opts = sendOpts()
    ;(opts.messages[0] as { metadata?: unknown }).metadata = { replyCard, skillName: 'Scout' }
    await drain(await transport.sendMessages(opts))
    expect(persists[0].body.userMessage).toEqual({ messageId: 'm1', parts: [{ type: 'text', text: 'hello' }], metadata: { replyCard } })
  })

  it('the turn-opening user message keeps the message it replied to (metadata.replyTo) beside the card, and a reaction turn its kind and reaction', async () => {
    const persists: Array<{ body: any }> = []
    const { transport } = makeTransport([[evTextDone('hi'), evTurnDone()], [evTextDone('ok'), evTurnDone()]], { onPersist: (a) => persists.push(a as any) })
    const replyCard = { kind: 'card', id: '22222222-2222-4222-8222-222222222222', workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Fix', sentence: 'the build' }
    const replyTo = { messageId: 'eve-msg-1', role: 'assistant', quote: 'Shall I send it?', part: false }
    const opts = sendOpts()
    ;(opts.messages[0] as { metadata?: unknown }).metadata = { replyTo, replyCard, createdAt: '2026-10-20T10:00:00.000Z' }
    await drain(await transport.sendMessages(opts))
    expect(persists[0].body.userMessage.metadata).toEqual({ replyCard, replyTo })

    const reaction = { emoji: '👍', messageId: 'eve-msg-1', excerpt: 'Shall I send it?' }
    const turn = sendOpts()
    ;(turn.messages[0] as { metadata?: unknown }).metadata = { kind: 'reaction', reaction, createdAt: '2026-10-20T10:01:00.000Z' }
    await drain(await transport.sendMessages(turn))
    expect(persists.at(-1)!.body.userMessage.metadata).toEqual({ kind: 'reaction', reaction })
  })

  it('a message whose metadata has none of it persists with no metadata; a reaction without its kind keeps nothing', async () => {
    const persists: Array<{ body: any }> = []
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()], { onPersist: (a) => persists.push(a as any) })
    const opts = sendOpts()
    ;(opts.messages[0] as { metadata?: unknown }).metadata = { reaction: { emoji: '👍' }, kind: 'other', skillName: 'Scout' }
    await drain(await transport.sendMessages(opts))
    expect(persists[0].body.userMessage).toEqual({ messageId: 'm1', parts: [{ type: 'text', text: 'hello' }] })
  })

  it('tells the server the panel names this chat (panelTitles) only when the panel says so, read live', async () => {
    const persists: Array<{ body: any }> = []
    let names = true
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()], {
      onPersist: (a) => persists.push(a as any),
      panelNamesChats: () => names,
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(persists[0].body.panelTitles).toBe(true)

    names = false
    await drain(await transport.sendMessages(sendOpts()))
    expect('panelTitles' in persists[1].body).toBe(false)
  })

  it('without panelNamesChats (headless host) the persist never claims panel titles', async () => {
    const persists: Array<{ body: any }> = []
    const { transport } = makeTransport([evTextDone('hi'), evTurnDone()], {
      onPersist: (a) => persists.push(a as any),
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect('panelTitles' in persists[0].body).toBe(false)
  })

  it('does not persist a turn that produced nothing (never started)', async () => {
    const persists: unknown[] = []
    // No events at all → the turn never starts → nothing to persist.
    const { transport } = makeTransport([], { onPersist: (a) => persists.push(a) })
    await drain(await transport.sendMessages(sendOpts()))
    expect(persists).toHaveLength(0)
  })

  describe('a turn stopped before anything rendered', () => {
    const flushAll = () => new Promise((r) => setTimeout(r, 0))

    it('a teammate thread still saves the user’s message (it has no other writer), once, as the user’s', async () => {
      const persists: Array<{ token: string; body: any }> = []
      const { transport } = makeTransport([], {
        onPersist: (a) => persists.push(a as any),
        teammateId: 'tm-1',
        panelNamesChats: () => true,
        keepSendWrites: true,
      })
      const stop = new AbortController()
      const stream = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
      stop.abort()
      expect((await drain(stream)).map((c) => c.type)).toEqual(['abort'])
      await flushAll()
      // Written the moment it was sent (onSend); the stop writes nothing more.
      expect(persists).toHaveLength(1)
      expect(persists[0].token).toBe('tok.sig')
      expect(persists[0].body).toEqual({
        messageId: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
        usage: { events: [], wallMs: 0 },
        panelTitles: true,
        onSend: true,
      })
    })

    it('a teammate thread stopped before the send even started saves it too', async () => {
      const persists: Array<{ body: any }> = []
      const { transport, dispatches } = makeTransport([], { onPersist: (a) => persists.push(a as any), teammateId: 'tm-1' })
      const stop = new AbortController()
      stop.abort()
      const stream = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
      await drain(stream)
      await flushAll()
      expect(dispatches).toEqual([])
      expect(persists).toHaveLength(1)
      expect(persists[0].body).toMatchObject({ messageId: 'm1', role: 'user' })
    })

    it('a teammate turn stopped after it started is persisted as before: the reply, carrying the user’s message', async () => {
      const persists: Array<{ body: any }> = []
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const { client } = makeFakeClient(() => ({
        sessionId: 'wrun_ABC',
        async *[Symbol.asyncIterator]() {
          yield evTextDelta('Working on it')
          await held
          yield evTurnDone()
        },
      }))
      const transport = new EveChatTransport({
        teammateId: 'tm-1',
        getAccessToken: () => 'jwt-token',
        mintRunToken: async ({ conversationId }) => ({ token: 'tok.sig', conversationId: conversationId ?? 'conv-new' }),
        registerEveSession: async () => {},
        createClient: () => client as never,
        persistTurn: async (a) => void (a.body.onSend || persists.push(a as any)),
      })
      const stop = new AbortController()
      const stream = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
      await readUntil(stream, (c) => c.type === 'text-delta')
      stop.abort()
      release()
      await flushAll()
      await flushAll()
      expect(persists).toHaveLength(1)
      expect(persists[0].body).toMatchObject({ role: 'assistant', userMessage: { messageId: 'm1' } })
    })

    it('the main chat leaves it to its own autosave: nothing is persisted', async () => {
      const persists: unknown[] = []
      const { transport } = makeTransport([], { onPersist: (a) => persists.push(a) })
      const stop = new AbortController()
      const stream = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
      stop.abort()
      await drain(stream)
      await flushAll()
      expect(persists).toHaveLength(0)
    })
  })

  it('persists exactly once even across a HITL park + resume (not while parked)', async () => {
    const persists: Array<{ body: any }> = []
    const questions = [{ question: 'Which env?', header: 'Env', options: [{ label: 'A' }], multiSelect: false }]
    const askUserPark = evInputRequested([
      { requestId: 'req-1', display: 'select', prompt: 'Which env?', action: { kind: 'tool-call', callId: 'call-auq', toolName: 'ask_user', input: { questions } } },
    ])
    const { transport } = makeTransport(
      [
        [askUserPark],
        [evTextDelta('Staging.'), evTextDone('Staging.'), evTurnDone()],
      ],
      { onPersist: (a) => persists.push(a as any) },
    )
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available') break
    }
    // While parked on the picker, NOTHING has been persisted yet.
    expect(persists).toHaveLength(0)

    const answerPromise = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answerPromise

    // After the resumed turn closes, persisted exactly once.
    expect(persists).toHaveLength(1)
    expect(persists[0].body.parts.some((p: any) => p.type === 'text' && p.text === 'Staging.')).toBe(true)
  })
})

// ── Recorded-stream helpers (the TTFT and recorded-stream suites) ───────────
type Recorded = HandleMessageStreamEvent & { meta: { deliveryIds?: string[] } }

/** Mirror of eve's client-side per-delivery response scoping. */
function scopeToDelivery(events: Recorded[], deliveryId: string): Recorded[] {
  const out: Recorded[] = []
  let seen = false
  for (const e of events) {
    const ids = e.meta.deliveryIds
    const mine = ids?.includes(deliveryId) === true
    if (!seen && !mine) continue
    if (seen && ids !== undefined && !mine) continue
    seen = true
    out.push(e)
    if (e.type === 'session.waiting' || e.type === 'session.completed' || e.type === 'session.failed') break
  }
  return out
}

function deliveries(events: Recorded[]): string[] {
  const ids: string[] = []
  for (const e of events) for (const id of e.meta.deliveryIds ?? []) if (!ids.includes(id)) ids.push(id)
  return ids
}

// Chat TTFT telemetry (docs/plans/chat-ttft.md, Phase 0). The transport marks
// each turn on two clocks that are never subtracted across: performance.now()
// at its own await points, and eve's server `meta.at` per event type. The
// derived phases ride the persist body once, however the turn ended.
describe('EveChatTransport — TTFT timings', () => {
  /** Marks of a new-session turn that passed every point, on both clocks. */
  const fullMarks = (): TurnTimingMarks => ({
    client: {
      submit: 1000,
      minted: 1040,
      created: 1240,
      registered: 1255,
      firstEvent: 1285,
      firstReasoning: 1290,
      firstText: 1390,
    },
    server: {
      'session.started': 50_000,
      'turn.started': 50_122,
      'message.received': 50_123,
      'step.started': 50_125,
      'reasoning.appended': 50_794,
      'message.appended': 50_824,
    },
    newSession: true,
    prewarmed: false,
    model: 'deepseek/deepseek-v4-flash',
  })

  describe('deriveTurnTimings', () => {
    it('a new session: every phase, in whole non-negative ms', () => {
      expect(deriveTurnTimings(fullMarks())).toEqual({
        new_session: true,
        prewarmed: false,
        model: 'deepseek/deepseek-v4-flash',
        client_first_output_ms: 290,
        client_first_text_ms: 390,
        client_mint_ms: 40,
        client_create_ms: 200,
        client_register_ms: 15,
        client_stream_open_ms: 30,
        server_session_setup_ms: 122,
        server_turn_setup_ms: 1,
        server_first_output_ms: 669,
        server_thinking_ms: 30,
      })
    })

    it('an existing session: no register and no session setup; the stream opens from the create', () => {
      const marks = fullMarks()
      delete marks.client.registered
      delete marks.server['session.started']
      marks.newSession = false
      const t = deriveTurnTimings(marks)
      expect(t.new_session).toBe(false)
      expect(t).not.toHaveProperty('client_register_ms')
      expect(t).not.toHaveProperty('server_session_setup_ms')
      expect(t.client_create_ms).toBe(200)
      expect(t.client_stream_open_ms).toBe(45) // created 1240 → first event 1285
    })

    it('omits every phase whose marks are missing, and a model it never saw', () => {
      expect(
        deriveTurnTimings({ client: { submit: 1000, minted: 1040 }, server: {}, newSession: false, prewarmed: false }),
      ).toEqual({ new_session: false, prewarmed: false, client_mint_ms: 40 })
    })

    it('a prewarmed send that skipped the mint and the register chains its stages from submit', () => {
      expect(
        deriveTurnTimings({
          client: { submit: 1000, created: 1300, firstEvent: 1330, firstText: 1500 },
          server: {},
          newSession: false,
          prewarmed: true,
        }),
      ).toEqual({
        new_session: false,
        prewarmed: true,
        client_create_ms: 300,
        client_stream_open_ms: 30,
        client_first_output_ms: 500,
        client_first_text_ms: 500,
      })
    })

    it('a reasoning-less turn: the first output is the first text, and there is no thinking', () => {
      const marks = fullMarks()
      delete marks.client.firstReasoning
      delete marks.server['reasoning.appended']
      const t = deriveTurnTimings(marks)
      expect(t.client_first_output_ms).toBe(390)
      expect(t.server_first_output_ms).toBe(699) // step.started → the first text
      expect(t).not.toHaveProperty('server_thinking_ms')
    })

    it('a tool-first turn: the first output is the tool input; the first text only comes after the tool ran', () => {
      const marks = fullMarks()
      delete marks.client.firstReasoning
      delete marks.server['reasoning.appended']
      marks.client.firstToolInput = 1350
      marks.client.firstText = 2400
      marks.server['action.input.appended'] = 50_700
      marks.server['actions.requested'] = 50_720
      marks.server['message.appended'] = 52_000
      const t = deriveTurnTimings(marks)
      expect(t.client_first_output_ms).toBe(350)
      expect(t.client_first_text_ms).toBe(1400)
      expect(t.server_first_output_ms).toBe(575)
      expect(t).not.toHaveProperty('server_thinking_ms')
    })

    it('thinking before a tool call ends at the tool input, not at the text after the tool', () => {
      const marks = fullMarks()
      marks.server['reasoning.appended'] = 50_300
      marks.server['action.input.appended'] = 50_700
      marks.server['message.appended'] = 52_000
      expect(deriveTurnTimings(marks).server_thinking_ms).toBe(400)
    })

    it('a tool call whose input was never streamed still ends the wait (actions.requested)', () => {
      const marks = fullMarks()
      delete marks.server['reasoning.appended']
      delete marks.server['message.appended']
      marks.server['actions.requested'] = 50_720
      expect(deriveTurnTimings(marks).server_first_output_ms).toBe(595)
    })

    it('NaN, infinite and backwards marks never produce a span; fractional ms round', () => {
      expect(
        deriveTurnTimings({
          client: { submit: Number.NaN, minted: 1040, created: 1000, registered: 1010, firstEvent: Infinity },
          // turn.started after message.received: skew between server instances.
          server: { 'turn.started': 5000, 'message.received': 4990, 'step.started': 5001, 'message.appended': Number.NaN },
          newSession: false,
          prewarmed: false,
        }),
      ).toEqual({ new_session: false, prewarmed: false, client_register_ms: 10 })

      expect(
        deriveTurnTimings({ client: { submit: 1000.25, minted: 1040.75 }, server: {}, newSession: false, prewarmed: false })
          .client_mint_ms,
      ).toBe(41)
    })
  })

  // ── Through the transport, on a controlled clock ──────────────────────────
  /** One response script: events, with a number advancing the clock that many
   *  ms and a promise holding the stream until it resolves. */
  type Script = Array<HandleMessageStreamEvent | number | Promise<void>>

  let nowSpy: { mockRestore: () => void } | null = null
  afterEach(() => {
    nowSpy?.mockRestore()
    nowSpy = null
  })

  /** A transport whose mint takes 40 ms, each eve POST 200 ms and the register 15 ms. */
  function timedTransport(scripts: Script[]) {
    const clock = { now: 1_000 }
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const { client, dispatches, cancel } = makeFakeClient((_d, i) => {
      clock.now += 200
      const script = scripts[i] ?? []
      return {
        sessionId: 'wrun_TTFT',
        async *[Symbol.asyncIterator]() {
          for (const step of script) {
            if (typeof step === 'number') clock.now += step
            else if (step instanceof Promise) await step
            else yield step
          }
        },
      }
    })
    const persists: Array<{ body: EvePersistBody }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => {
        clock.now += 40
        return { token: 'tok', conversationId: 'conv-1' }
      },
      registerEveSession: async () => {
        clock.now += 15
      },
      persistTurn: async (a) => {
        if (!a.body.onSend) persists.push(a)
      },
      createClient: () => client as never,
    })
    return { transport, dispatches, persists, cancel }
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))
  /** An event stamped at `ms` on the server clock (eve's ISO `meta.at`). */
  const serverAt = (e: object, ms: number): HandleMessageStreamEvent =>
    ({ ...e, meta: { id: `evt-${ms}`, at: new Date(Date.UTC(2026, 8, 30, 12) + ms).toISOString() } }) as unknown as HandleMessageStreamEvent
  const turnStarted = (turnId: string) => ({ type: 'turn.started', data: { sequence: 0, turnId } })
  const messageReceived = (turnId: string) => ({ type: 'message.received', data: { message: 'hi', sequence: 0, turnId } })
  const stepStarted = (turnId: string) => ({
    type: 'step.started',
    data: { modelId: 'deepseek/deepseek-v4-flash', sequence: 0, stepIndex: 0, turnId },
  })
  const reasoning = (delta: string) => ({
    type: 'reasoning.appended',
    data: { reasoningDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' },
  })
  const text = (delta: string, turnId = 'turn_0') => ({
    type: 'message.appended',
    data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId },
  })

  it('a recorded eve 0.66.3 first turn: server phases from its real meta.at, client phases at the transport’s own await points', async () => {
    const events = (liveStreams as unknown as Record<string, HandleMessageStreamEvent[]>).firstTurnWithReasoning
    const firstReasoning = events.findIndex((e) => e.type === 'reasoning.appended')
    const firstText = events.findIndex((e) => e.type === 'message.appended')
    const { transport, dispatches, persists } = timedTransport([
      [30, ...events.slice(0, firstReasoning), 5, ...events.slice(firstReasoning, firstText), 100, ...events.slice(firstText)],
    ])
    await drain(await transport.sendMessages(sendOpts()))
    await flush()

    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    expect(persists).toHaveLength(1)
    expect(persists[0].body.timings).toEqual({
      new_session: true,
      prewarmed: false,
      // step.started's modelId: the model eve actually resolved for the call.
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 200,
      client_register_ms: 15,
      client_stream_open_ms: 30,
      client_first_output_ms: 290,
      client_first_text_ms: 390,
      server_session_setup_ms: 122, // 01:11:55.707 → .829
      server_turn_setup_ms: 1, // .829 → .830
      server_first_output_ms: 669, // step.started .832 → first reasoning 56.501
      server_thinking_ms: 30, // first reasoning 56.501 → first text 56.531
    })
  })

  it('a follow-up turn on the live session: no register, no session setup, and an empty delta is not output', async () => {
    const { transport, dispatches, persists } = timedTransport([
      [
        serverAt({ type: 'session.started', data: {} }, 0),
        serverAt(turnStarted('turn_0'), 100),
        serverAt(text('First.'), 900),
        evTurnDone(),
      ],
      [
        25,
        serverAt(turnStarted('turn_1'), 10_000),
        serverAt(messageReceived('turn_1'), 10_300),
        serverAt(stepStarted('turn_1'), 10_302),
        10,
        serverAt(text('', 'turn_1'), 10_900),
        7,
        serverAt(text('Second.', 'turn_1'), 11_102),
        evTurnDone(),
      ],
    ])
    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))
    await flush()

    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(persists).toHaveLength(2)
    expect(persists[0].body.timings?.new_session).toBe(true)
    expect(persists[1].body.timings).toEqual({
      new_session: false,
      prewarmed: false,
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 200,
      client_stream_open_ms: 25,
      client_first_output_ms: 282, // 40 + 200 + 25 + 10 + 7: the empty delta did not count
      client_first_text_ms: 282,
      server_turn_setup_ms: 300,
      server_first_output_ms: 800, // step.started → the first NON-empty text
    })
  })

  it('a HITL turn reports its own dispatch once: the reply resumed after the picker never lands in a phase', async () => {
    const questions = [{ question: 'Tea or coffee?', header: 'Drink', options: [{ label: 'Tea' }], multiSelect: false }]
    const { transport, persists } = timedTransport([
      [
        20,
        serverAt(turnStarted('turn_0'), 0),
        serverAt(messageReceived('turn_0'), 2),
        serverAt(stepStarted('turn_0'), 3),
        5,
        serverAt(reasoning('I should ask.'), 500),
        50,
        serverAt(
          { type: 'action.input.appended', data: { callId: 'call-auq', inputTextDelta: '{"questions"', sequence: 0, stepIndex: 0, toolName: 'ask_user', turnId: 'turn_0' } },
          800,
        ),
        evInputRequested([
          { requestId: 'req-1', display: 'select', prompt: 'Tea or coffee?', action: { kind: 'tool-call', callId: 'call-auq', toolName: 'ask_user', input: { questions } } },
        ]),
        evTurnDone(),
      ],
      // The resumed turn, a minute later: a new turn.started, then the first text.
      [
        serverAt(turnStarted('turn_1'), 60_000),
        serverAt(stepStarted('turn_1'), 60_001),
        serverAt(text('Tea it is.', 'turn_1'), 60_400),
        evTextDone('Tea it is.'),
        evTurnDone(),
      ],
    ])
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || value.type === 'tool-input-available') break
    }
    await flush() // the park's turn.completed drains, as before any real click
    expect(persists).toHaveLength(0) // parked: nothing persisted yet

    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Tea or coffee?': 'Tea' })
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answered
    await flush()

    expect(persists).toHaveLength(1)
    expect(persists[0].body.parts.some((p) => p.type === 'text' && p.text === 'Tea it is.')).toBe(true)
    const t = persists[0].body.timings
    expect(t).toMatchObject({
      new_session: true,
      client_first_output_ms: 280, // 40 + 200 + 15 + 20 + 5: the reasoning
      server_turn_setup_ms: 2, // the dispatch's own turn.started, not the resume's
      server_first_output_ms: 497,
      server_thinking_ms: 300, // reasoning → the ask_user tool input
    })
    // The only text arrived in the resume, after the user's pause.
    expect(t).not.toHaveProperty('client_first_text_ms')
  })

  it('a failed turn still sends the timings it reached with its persist', async () => {
    const { transport, persists } = timedTransport([
      [
        20,
        serverAt(turnStarted('turn_0'), 0),
        serverAt(messageReceived('turn_0'), 1),
        serverAt(stepStarted('turn_0'), 2),
        5,
        serverAt(reasoning('Hmm.'), 400),
        evTurnFailed('boom'),
      ],
    ])
    expect(await drain(await transport.sendMessages(sendOpts()))).toContainEqual({ type: 'error', errorText: 'boom' })
    await flush()

    expect(persists).toHaveLength(1)
    const t = persists[0].body.timings
    expect(t).toMatchObject({ client_first_output_ms: 280, server_turn_setup_ms: 1, server_first_output_ms: 398 })
    expect(t).not.toHaveProperty('client_first_text_ms')
    expect(t).not.toHaveProperty('server_thinking_ms')
  })

  it('a stopped turn sends the timings it reached before the Stop', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const { transport, persists, cancel } = timedTransport([
      [
        20,
        serverAt(turnStarted('turn_0'), 0),
        serverAt(stepStarted('turn_0'), 3),
        5,
        serverAt(text('Writing a long'), 700),
        held,
        50,
        serverAt(text(' answer'), 900),
        evTurnDone(),
      ],
    ])
    const stop = new AbortController()
    const stream = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    await readUntil(stream, (c) => c.type === 'text-delta')
    stop.abort()
    release()
    await flush()

    expect(cancel).toHaveBeenCalledWith({ turnId: 'turn_0' })
    expect(persists).toHaveLength(1)
    expect(persists[0].body.timings).toMatchObject({
      client_first_output_ms: 280,
      client_first_text_ms: 280,
      server_first_output_ms: 697,
    })
  })

  it('a prewarmed send reports prewarmed and new_session; it minted and registered nothing, so those phases are absent', async () => {
    const clock = { now: 1_000 }
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const token = `${Buffer.from(JSON.stringify({ exp: Date.now() + 60 * 60_000 }), 'utf8').toString('base64url')}.sig`
    const { client, dispatches } = makeFakeClient(() => {
      clock.now += 200
      return {
        sessionId: 'wrun_TTFT',
        async *[Symbol.asyncIterator]() {
          clock.now += 30
          // The prewarm parked before session setup: it runs in this turn.
          yield serverAt({ type: 'session.started', data: {} }, 0)
          yield serverAt(turnStarted('turn_0'), 150)
          yield serverAt(messageReceived('turn_0'), 152)
          yield serverAt(stepStarted('turn_0'), 153)
          clock.now += 70
          yield serverAt(text('Hi.'), 700)
          yield evTurnDone()
        },
      }
    })
    const persists: Array<{ body: EvePersistBody }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => {
        clock.now += 40
        return { token, conversationId: 'conv-pre' }
      },
      registerEveSession: async () => {
        clock.now += 15
      },
      persistTurn: async (a) => {
        if (!a.body.onSend) persists.push(a)
      },
      createClient: () => client as never,
    })
    await transport.prewarm('chat-1')
    clock.now = 5_000 // typing, then Enter
    await drain(await transport.sendMessages(sendOptsNoConversationId()))
    await flush()

    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
    expect(persists).toHaveLength(1)
    expect(persists[0].body.timings).toEqual({
      new_session: true,
      prewarmed: true,
      model: 'deepseek/deepseek-v4-flash',
      client_create_ms: 200, // from submit: the send minted nothing
      client_stream_open_ms: 30,
      client_first_output_ms: 300,
      client_first_text_ms: 300,
      server_session_setup_ms: 150,
      server_turn_setup_ms: 2,
      server_first_output_ms: 547,
    })
  })

  it('a tool call whose input was never streamed ends the wait at actions.requested; empty tool-input and reasoning deltas are not output', async () => {
    const { transport, persists } = timedTransport([
      [
        20,
        serverAt(turnStarted('turn_0'), 0),
        serverAt(messageReceived('turn_0'), 1),
        serverAt(stepStarted('turn_0'), 2),
        10,
        serverAt(reasoning(''), 300),
        serverAt(
          { type: 'action.input.appended', data: { callId: 'call-1', inputTextDelta: '', sequence: 0, stepIndex: 0, toolName: 'list_actions', turnId: 'turn_0' } },
          400,
        ),
        7,
        serverAt(evToolCall('call-1', 'list_actions', {}), 600),
        evToolResult('call-1', { ok: true }),
        evTurnDone(),
      ],
    ])
    await drain(await transport.sendMessages(sendOpts()))
    await flush()

    expect(persists).toHaveLength(1)
    const t = persists[0].body.timings
    expect(t).toMatchObject({
      client_first_output_ms: 292, // 40 + 200 + 15 + 20 + 10 + 7: the tool call, not an empty delta
      server_first_output_ms: 598, // step.started → actions.requested
    })
    expect(t).not.toHaveProperty('client_first_text_ms')
    expect(t).not.toHaveProperty('server_thinking_ms') // the empty reasoning delta marked nothing
  })

  // Steering: two sends read ONE eve turn, split at the first event carrying the
  // steering send's delivery id (see runTurn). Each send persists its own
  // timings, marked from the events it claimed and nothing past the split.
  const live = liveStreams as unknown as Record<string, Recorded[]>
  const steering = () =>
    ({
      ...(sendOpts() as object),
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'steer' }] },
      ],
    }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
  /** A point a scripted stream waits at until the test releases it. */
  const hold = () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    return { held, release }
  }
  const indexOf = (events: Recorded[], type: string) => events.findIndex((e) => e.type === type)

  it('a steer before output (recorded): the steered turn keeps only its own marks; the steering send’s create includes its wait for the prior turn’s identity', async () => {
    const events = live.chatAgentTransportSteerBeforeOutput
    const [d1, d2] = deliveries(events)
    const prior = scopeToDelivery(events, d1)
    const steer = scopeToDelivery(events, d2)
    const priorReasoning = indexOf(prior, 'reasoning.appended')
    const steerReasoning = indexOf(steer, 'reasoning.appended')
    const steerText = indexOf(steer, 'message.appended')
    const opened = hold()
    const identified = hold()
    const { transport, dispatches, persists } = timedTransport([
      // The prior turn's stream opens 500 ms after its register, then holds
      // after its first (identifying) event until the steering send has run.
      [opened.held, 500, prior[0], identified.held, 30, ...prior.slice(1, priorReasoning), 5, ...prior.slice(priorReasoning)],
      [25, ...steer.slice(0, steerReasoning), 10, ...steer.slice(steerReasoning, steerText), 100, ...steer.slice(steerText)],
    ])
    const s1 = await transport.sendMessages(sendOpts())
    await flush()
    const s2 = await transport.sendMessages(steering())
    await flush()
    expect(dispatches).toHaveLength(1) // the steering send waits for the prior turn's identity
    opened.release()
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    identified.release()
    await drain(s1)
    await drain(s2)
    await flush()

    expect(persists).toHaveLength(2)
    const byNewSession = (v: boolean) => persists.find((p) => p.body.timings?.new_session === v)?.body.timings
    // The steered turn: server phases from its own events only (its stream
    // breaks at the steer point, so the steering reply's text never marks it).
    expect(byNewSession(true)).toEqual({
      new_session: true,
      prewarmed: false,
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 200,
      client_register_ms: 15,
      client_stream_open_ms: 540, // registered 1255 → first event 1795 (the steering send's 40 ms mint + the 500 ms hold)
      client_first_output_ms: 1165, // its first reasoning, released after the steering reply ran
      server_session_setup_ms: 119, // 57:52.827 → .946
      server_turn_setup_ms: 2, // .946 → .948
      server_first_output_ms: 2003, // step.started .949 → first reasoning 54.952
    })
    // The steering send: submitted at 1255, minted at 1295; its create spans the
    // 500 ms wait for the prior turn's identity plus its own 200 ms POST. Its
    // stream joins the eve turn mid-way: no session.started, no turn.started,
    // and a live session registers nothing.
    expect(byNewSession(false)).toEqual({
      new_session: false,
      prewarmed: false,
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 700,
      client_stream_open_ms: 25,
      client_first_output_ms: 775,
      client_first_text_ms: 875,
      server_first_output_ms: 1866, // its step.started 55.049 → its first reasoning 56.915
      server_thinking_ms: 493, // → "OK." at 57.408
    })
  })

  it('a steer after output (recorded): eve runs it as the next turn, and each send times only its own turn', async () => {
    const events = live.chatAgentTransportSteerAfterOutput
    const [d1, d2] = deliveries(events)
    const prior = scopeToDelivery(events, d1)
    const steer = scopeToDelivery(events, d2)
    const priorReasoning = indexOf(prior, 'reasoning.appended')
    const priorText = indexOf(prior, 'message.appended')
    const steerReasoning = indexOf(steer, 'reasoning.appended')
    const steerText = indexOf(steer, 'message.appended')
    const paused = hold()
    const { transport, dispatches, persists } = timedTransport([
      [
        20,
        ...prior.slice(0, priorReasoning),
        5,
        prior[priorReasoning],
        paused.held,
        ...prior.slice(priorReasoning + 1, priorText),
        100,
        ...prior.slice(priorText),
      ],
      [25, ...steer.slice(0, steerReasoning), 10, ...steer.slice(steerReasoning, steerText), 100, ...steer.slice(steerText)],
    ])
    const s1 = await transport.sendMessages(sendOpts())
    await flush()
    const s2 = await transport.sendMessages(steering())
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    paused.release()
    await drain(s1)
    await drain(s2)
    await flush()

    expect(persists).toHaveLength(2)
    const byNewSession = (v: boolean) => persists.find((p) => p.body.timings?.new_session === v)?.body.timings
    expect(byNewSession(true)).toEqual({
      new_session: true,
      prewarmed: false,
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 200,
      client_register_ms: 15,
      client_stream_open_ms: 20,
      client_first_output_ms: 280,
      client_first_text_ms: 755, // its own first text, after the steering send's reply ran
      server_session_setup_ms: 103, // 58:05.211 → .314
      server_turn_setup_ms: 2, // .314 → .316
      server_first_output_ms: 2515, // step.started .316 → first reasoning 07.831
      server_thinking_ms: 1746, // → first text 09.577
    })
    // The steering send: the prior turn already knew its identity, so no wait;
    // its stream is eve's NEXT turn, which has a turn.started but no session.started.
    expect(byNewSession(false)).toEqual({
      new_session: false,
      prewarmed: false,
      model: 'deepseek/deepseek-v4-flash',
      client_mint_ms: 40,
      client_create_ms: 200,
      client_stream_open_ms: 25,
      client_first_output_ms: 275,
      client_first_text_ms: 375,
      server_turn_setup_ms: 0, // 58:11.343 → .343
      server_first_output_ms: 1467, // step.started .343 → first reasoning 12.810
      server_thinking_ms: 216, // → "done" at 13.026
    })
  })
})

describe('EveChatTransport — conversation-split fix (onConversationEnsured)', () => {
  it('surfaces the mint conversation id ONCE per chat, with the id the mint resolved', async () => {
    const ensured: Array<{ chatId: string; conversationId: string }> = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      onConversationEnsured: (chatId, conversationId) => ensured.push({ chatId, conversationId }),
    })
    // Two turns on the same chat — onConversationEnsured must fire only once.
    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))
    expect(ensured).toHaveLength(1)
    // sendOpts carries body.conversationId 'conv-1' → the mint echoes it back.
    expect(ensured[0]).toEqual({ chatId: 'chat-1', conversationId: 'conv-1' })
  })

  it('surfaces the SERVER-MINTED id when the client had none (fresh chat)', async () => {
    const ensured: string[] = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      onConversationEnsured: (_c, id) => ensured.push(id),
      mintConversationId: 'conv-server-A',
    })
    // A fresh chat: no body.conversationId → the mint creates the row + returns its id.
    const opts = {
      chatId: 'chat-1',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      trigger: 'submit-message',
      messageId: undefined,
      body: {},
    } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
    await drain(await transport.sendMessages(opts))
    expect(ensured).toEqual(['conv-server-A'])
  })

  // ── The turn-2+ split regression ────────────────────────────────────────────
  // The prod bug: the per-send body never carried conversationId (it lived only on
  // the CLOUD DefaultChatTransport's body getter, which the eve delegate never
  // sees). So on a FRESH chat, turn 1 minted a new row A and surfaced it, but
  // turns 2+ minted with a NULL conversationId and forked a brand-new empty row
  // each — and every follow-up assistant persist landed on those orphan rows
  // instead of A. These tests lock the single-owner invariant: once the session
  // exists, every turn mints (and persists) against the SAME row, WITHOUT the body
  // ever carrying the id.

  it('mints EVERY turn against the SAME row on a fresh chat, even though the body never carries conversationId', async () => {
    const minted: Array<string | null | undefined> = []
    const persistedTokens: string[] = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      captureMint: (id) => minted.push(id),
      onPersist: (a) => persistedTokens.push(a.token),
      // Distinct fresh id per null mint — so a regressed transport that minted null
      // on turn 2 would visibly fork 'conv-fresh-2' instead of reusing 'conv-fresh-1'.
      freshRowPerNullMint: true,
    })

    // Three turns on the same chat, each with a body that OMITS conversationId.
    await drain(await transport.sendMessages(sendOptsNoConversationId()))
    await drain(await transport.sendMessages(sendOptsNoConversationId()))
    await drain(await transport.sendMessages(sendOptsNoConversationId()))

    // Turn 1 minted null (fresh chat → the route creates the row). Turns 2 and 3
    // must reuse the session's resolved id — NOT null — so no second row is forked.
    expect(minted[0]).toBeNull()
    expect(minted[1]).toBe('conv-fresh-1')
    expect(minted[2]).toBe('conv-fresh-1')
    // Exactly ONE fresh row was ever created (seq never advanced past 1).
    expect(minted.filter((id) => id == null)).toHaveLength(1)
    // All three turns persisted (the token scopes tenancy to the one row).
    expect(persistedTokens).toHaveLength(3)
  })

  it('seeds the first turn from the panel-tracked id (getConversationId) when the body omits it — a loaded historical eve chat', async () => {
    const minted: Array<string | null | undefined> = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      captureMint: (id) => minted.push(id),
      // The panel already tracks the loaded conversation's id; the body still omits it.
      getConversationId: () => 'conv-loaded-Z',
    })

    await drain(await transport.sendMessages(sendOptsNoConversationId()))
    await drain(await transport.sendMessages(sendOptsNoConversationId()))

    // Turn 1 seeded from getConversationId (not null → the route trusts the owned
    // id, no new row); turn 2 reuses the session's id. Same row throughout.
    expect(minted[0]).toBe('conv-loaded-Z')
    expect(minted[1]).toBe('conv-loaded-Z')
  })

  it('does NOT re-home once a session is established: a stale panel-tracked id can never override the session row', async () => {
    // getConversationId flips to a foreign id AFTER turn 1 — the transport must
    // ignore it (the session's own resolved id wins) so the thread never splits.
    let tracked: string | null = null
    const minted: Array<string | null | undefined> = []
    const { transport } = makeTransport([evTextDone('a'), evTurnDone()], {
      captureMint: (id) => minted.push(id),
      getConversationId: () => tracked,
      freshRowPerNullMint: true,
    })

    await drain(await transport.sendMessages(sendOptsNoConversationId()))
    // A rogue/stale id appears in the panel ref after the session is bound.
    tracked = 'conv-someone-elses'
    await drain(await transport.sendMessages(sendOptsNoConversationId()))

    expect(minted[0]).toBeNull() // fresh chat, first mint creates the row
    expect(minted[1]).toBe('conv-fresh-1') // session id wins over the stale tracked id
    expect(minted[1]).not.toBe('conv-someone-elses')
  })
})

describe('EveChatTransport — reconnect + reset', () => {
  it('reconnectToStream returns null (no reconnectable stream surfaced)', async () => {
    const { transport } = makeTransport([])
    expect(await transport.reconnectToStream()).toBeNull()
  })

  it('resetSession drops the session so the next send re-attaches (new eve session)', async () => {
    let sessionsMade = 0
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => {
        sessionsMade++
        return makeFakeClient(() => makeResponse("wrun_1", [evTurnDone()])).client as never
      },
    })
    await drain(await transport.sendMessages(sendOpts()))
    await transport.resetSession('chat-1')
    await drain(await transport.sendMessages(sendOpts()))
    // A fresh client (session) was created after reset — no stale context bleed.
    expect(sessionsMade).toBe(2)
  })
})

describe('EveChatTransport — prewarm (a blank chat’s session, made while its first message is typed)', () => {
  /** A run token the transport can read the (unverified) exp of. */
  const runToken = (tag: string, lifeMs = 60 * 60_000) =>
    `${Buffer.from(JSON.stringify({ exp: Date.now() + lifeMs, tag }), 'utf8').toString('base64url')}.sig-${tag}`

  /** Matches the token runToken minted with `tag`. */
  const tagged = (tag: string) => expect.stringMatching(new RegExp(`\\.sig-${tag}$`))

  /** A blank chat's send: the panel's body never carries a conversation id. */
  const blankSend = (chatId = 'chat-1', body: Record<string, unknown> = {}) =>
    ({
      chatId,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      trigger: 'submit-message',
      messageId: undefined,
      body,
    }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

  const flush = () => new Promise((r) => setTimeout(r, 0))

  type MintArgs = { conversationId: string | null; agentId?: string; skillId?: string; wantHistory?: boolean }

  /**
   * A transport whose mint creates `conv-new-<n>` for a null conversation (the
   * route's insert) and echoes a named one. `bound` is the panel's tracked
   * conversation id, which follows onConversationEnsured like the real panel.
   */
  function setup(opts: {
    respond?: (d: Dispatch, i: number) => unknown
    prewarmGate?: () => Promise<void>
    mint?: (args: MintArgs, n: number) => Promise<ChatRunMintResult>
    register?: () => Promise<void>
    bound?: { current: string | null }
    /** The panel's cached Supabase JWT, read live (onAuthStateChange rotates it). */
    jwt?: { current: string }
  } = {}) {
    const fake = makeFakeClient(
      opts.respond ?? (() => makeResponse('wrun_ABC', [evTextDone('hi'), evTurnDone()])),
      { prewarm: opts.prewarmGate },
    )
    const bound = opts.bound ?? { current: null }
    const mints: MintArgs[] = []
    /** The JWT each mint was made with (the credential it seals). */
    const mintJwts: Array<string | null> = []
    const registered: Array<{ conversationId: string; sessionId: string }> = []
    const ensured: string[] = []
    const persists: EvePersistBody[] = []
    const transport = new EveChatTransport({
      getAccessToken: () => opts.jwt?.current ?? 'jwt',
      getConversationId: () => bound.current,
      mintRunToken: async ({ conversationId, agentId, skillId, wantHistory, accessToken }) => {
        const args = { conversationId, agentId, skillId, wantHistory }
        mints.push(args)
        mintJwts.push(accessToken)
        if (opts.mint) return opts.mint(args, mints.length)
        return { token: runToken(`mint-${mints.length}`), conversationId: conversationId ?? `conv-new-${mints.length}` }
      },
      registerEveSession: async (a) => {
        await opts.register?.()
        registered.push({ conversationId: a.conversationId, sessionId: a.sessionId })
      },
      createClient: () => fake.client as never,
      onConversationEnsured: (_chatId, id) => {
        ensured.push(id)
        bound.current = id
      },
      persistTurn: async (a) => {
        if (!a.body.onSend) persists.push(a.body)
      },
    })
    return { transport, ...fake, mints, mintJwts, registered, ensured, persists }
  }

  it('after a prewarm the first send only sends: no create, no register and no mint of its own', async () => {
    const { transport, dispatches, create, mints, registered } = setup()
    await transport.prewarm('chat-1')

    // The prewarm: a mint for a NEW row, a message-free create, its registration.
    expect(mints).toEqual([{ conversationId: null, agentId: undefined, skillId: undefined, wantHistory: undefined }])
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual({ headers: { 'x-chat-run-token': tagged('mint-1') } })
    expect(registered).toEqual([{ conversationId: 'conv-new-1', sessionId: 'wrun_ABC' }])
    expect(dispatches).toEqual([])

    const body = { systemContext: { conversationContext: 'User is viewing: mail' } }
    await drain(await transport.sendMessages(blankSend('chat-1', body)))
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
    expect(create).toHaveBeenCalledTimes(1)
    expect(registered).toHaveLength(1)
    expect(mints).toHaveLength(1)
    // The send carries the prewarm's token and ITS OWN turn context: the
    // channel stamps both onto the principal turn_0 resolves under. Every
    // chat sends the browser's zone (the clock's), card-drawing or not.
    const headers = dispatches[0].options.headers as Record<string, string>
    expect(headers['x-chat-run-token']).toEqual(tagged('mint-1'))
    expect(headers['x-chat-run-ctx']).toBe(encodeTurnContext({ body }, undefined, browserTimeZone(), null, turnRouteSignals('hello')))
    expect(browserTimeZone()).toBeTruthy()
  })

  it('announces the conversation at the send, never at the prewarm, and keeps every turn on the prewarm’s row', async () => {
    const { transport, ensured, mints, persists } = setup()
    await transport.prewarm('chat-1')
    expect(ensured).toEqual([])

    await drain(await transport.sendMessages(blankSend()))
    await drain(await transport.sendMessages(blankSend()))
    await flush()
    expect(ensured).toEqual(['conv-new-1'])
    // The second turn mints against the same row; nothing else was created.
    expect(mints.map((m) => m.conversationId)).toEqual([null, 'conv-new-1'])
    expect(persists).toHaveLength(2)
  })

  it('a skill armed after the prewarm re-mints (same row, no history) but still sends over the prewarmed session', async () => {
    const { transport, dispatches, mints, registered } = setup()
    await transport.prewarm('chat-1', { agentId: 'agent-7' })
    await drain(await transport.sendMessages(blankSend('chat-1', { agentId: 'agent-7', skillId: 'skill-1' })))

    expect(mints[1]).toEqual({ conversationId: 'conv-new-1', agentId: 'agent-7', skillId: 'skill-1', wantHistory: undefined })
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
    expect((dispatches[0].options.headers as Record<string, string>)['x-chat-run-token']).toEqual(tagged('mint-2'))
    expect(registered).toHaveLength(1)
  })

  // The prewarm's mint is also the turn's usage check and seals the JWT it was
  // made with, so the send reuses its token only while both are current.
  describe('reusing the prewarm’s run token', () => {
    let now = 0
    let dateSpy: MockInstance<typeof Date.now> | null = null
    beforeEach(() => {
      now = Date.now()
      dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    })
    afterEach(() => {
      dateSpy?.mockRestore()
      dateSpy = null
    })
    const sentToken = (d: Dispatch) => (d.options.headers as Record<string, string>)['x-chat-run-token']

    it('a prewarm up to 2 minutes old, on the JWT the send still holds, skips the send’s mint', async () => {
      const { transport, dispatches, mints, mintJwts } = setup({ jwt: { current: 'jwt-1' } })
      await transport.prewarm('chat-1')
      now += 2 * 60_000
      await drain(await transport.sendMessages(blankSend()))
      expect(mints).toHaveLength(1)
      expect(mintJwts).toEqual(['jwt-1'])
      expect(dispatches.map((d) => d.kind)).toEqual(['send'])
      expect(sentToken(dispatches[0])).toEqual(tagged('mint-1'))
    })

    it('an older prewarm re-mints (a fresh usage check) and still sends over its session', async () => {
      const { transport, dispatches, mints, registered } = setup()
      await transport.prewarm('chat-1')
      now += 2 * 60_000 + 1
      await drain(await transport.sendMessages(blankSend()))
      expect(mints.map((m) => m.conversationId)).toEqual([null, 'conv-new-1'])
      expect(mints[1].wantHistory).toBeUndefined()
      expect(dispatches.map((d) => d.kind)).toEqual(['send'])
      expect(sentToken(dispatches[0])).toEqual(tagged('mint-2'))
      expect(registered).toHaveLength(1)
    })

    it('a JWT rotated since the prewarm re-mints on the live one (the sealed credential may have lapsed) and still sends over its session', async () => {
      const jwt = { current: 'jwt-1' }
      const { transport, dispatches, mints, mintJwts, registered } = setup({ jwt })
      await transport.prewarm('chat-1')
      jwt.current = 'jwt-2' // Supabase refreshed the session (the panel follows onAuthStateChange)
      await drain(await transport.sendMessages(blankSend()))
      expect(mintJwts).toEqual(['jwt-1', 'jwt-2'])
      expect(mints[1]).toEqual({ conversationId: 'conv-new-1', agentId: undefined, skillId: undefined, wantHistory: undefined })
      expect(dispatches.map((d) => d.kind)).toEqual(['send'])
      expect(sentToken(dispatches[0])).toEqual(tagged('mint-2'))
      expect(registered).toHaveLength(1)
    })
  })

  it('a failed prewarm never rejects; the send takes the ordinary path (mint, create, register)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { transport, dispatches, mints, registered } = setup({
      mint: async (args, n) => {
        if (n === 1) throw Object.assign(new Error('Usage limit exceeded'), { status: 429 })
        return { token: runToken(`mint-${n}`), conversationId: args.conversationId ?? `conv-new-${n}` }
      },
    })
    await expect(transport.prewarm('chat-1')).resolves.toBeUndefined()
    // A failed prewarm is not retried per keystroke.
    await transport.prewarm('chat-1')
    expect(mints).toHaveLength(1)

    await drain(await transport.sendMessages(blankSend()))
    expect(mints[1]).toEqual({ conversationId: null, agentId: undefined, skillId: undefined, wantHistory: true })
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    expect(registered).toEqual([{ conversationId: 'conv-new-2', sessionId: 'wrun_ABC' }])
  })

  it('a refused registration abandons the prewarm: the send creates its own session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let refuse = true
    const { transport, dispatches, registered } = setup({
      register: async () => {
        if (refuse) {
          refuse = false
          throw new Error('eve session register failed (404)')
        }
      },
    })
    await transport.prewarm('chat-1')
    await drain(await transport.sendMessages(blankSend()))
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    expect(registered).toEqual([{ conversationId: 'conv-new-2', sessionId: 'wrun_ABC' }])
  })

  it('a prewarm still in flight after 3 s is abandoned: the send takes the ordinary path, and the late prewarm never registers', async () => {
    vi.useFakeTimers()
    try {
      let releasePrewarm: () => void = () => {}
      const gate = new Promise<void>((r) => {
        releasePrewarm = r
      })
      const { transport, dispatches, mints, registered } = setup({ prewarmGate: () => gate })
      const warming = transport.prewarm('chat-1')
      const sending = transport.sendMessages(blankSend())
      await vi.advanceTimersByTimeAsync(3_000)
      await drain(await sending)

      expect(dispatches.map((d) => d.kind)).toEqual(['create'])
      expect(mints.map((m) => m.conversationId)).toEqual([null, null])
      expect(registered).toEqual([{ conversationId: 'conv-new-2', sessionId: 'wrun_ABC' }])

      releasePrewarm()
      await warming
      expect(registered).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a send waits for a prewarm that finishes within 3 s, then only sends', async () => {
    let releasePrewarm: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releasePrewarm = r
    })
    const { transport, dispatches, mints } = setup({ prewarmGate: () => gate })
    const warming = transport.prewarm('chat-1')
    const sending = transport.sendMessages(blankSend())
    await flush()
    releasePrewarm()
    await drain(await sending)
    await warming
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
    expect(mints).toHaveLength(1)
  })

  it('a prewarm for chat A is never used by chat B', async () => {
    const bound = { current: null as string | null }
    const { transport, dispatches, registered } = setup({ bound })
    await transport.prewarm('chat-A')
    await drain(await transport.sendMessages(blankSend('chat-B')))
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    expect(registered.map((r) => r.conversationId)).toEqual(['conv-new-1', 'conv-new-2'])

    bound.current = null // chat A's panel is still blank (bound tracks chat B's)
    await drain(await transport.sendMessages(blankSend('chat-A')))
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    expect(registered.map((r) => r.conversationId)).toEqual(['conv-new-1', 'conv-new-2'])
  })

  it('a reset keeps the prewarm (the panel resets on an agent pick): the send re-mints for the new agent over the prewarmed session', async () => {
    const { transport, dispatches, mints, registered } = setup()
    await transport.prewarm('chat-1')
    await transport.resetSession('chat-1')
    await drain(await transport.sendMessages(blankSend('chat-1', { agentId: 'agent-sales' })))
    expect(mints).toEqual([
      { conversationId: null, agentId: undefined, skillId: undefined, wantHistory: undefined },
      { conversationId: 'conv-new-1', agentId: 'agent-sales', skillId: undefined, wantHistory: undefined },
    ])
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
    expect((dispatches[0].options.headers as Record<string, string>)['x-chat-run-token']).toEqual(tagged('mint-2'))
    expect(registered).toHaveLength(1)
  })

  it('a reset with nothing changed keeps the prewarm and its token', async () => {
    const { transport, dispatches, mints } = setup()
    await transport.prewarm('chat-1')
    await transport.resetSession('chat-1')
    await drain(await transport.sendMessages(blankSend()))
    expect(mints).toHaveLength(1)
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
  })

  it('a second send while the first waits on the prewarm steers the first turn over the same prewarmed session', async () => {
    let releasePrewarm: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releasePrewarm = r
    })
    const { transport, dispatches, mints, registered, persists } = setup({ prewarmGate: () => gate })
    const warming = transport.prewarm('chat-1')
    const first = transport.sendMessages(blankSend())
    const second = transport.sendMessages(blankSend())
    await flush()
    expect(dispatches).toEqual([])
    releasePrewarm()
    await drain(await first)
    await drain(await second)
    await warming
    await flush()

    // Both sends took the one handle the first installed: no create, one
    // registration, and only the prewarm's mint.
    expect(dispatches.map((d) => d.kind)).toEqual(['send', 'send'])
    expect(registered).toHaveLength(1)
    expect(mints).toHaveLength(1)
    // Only the first send set the prewarmed session up; the second steered it.
    expect(persists.map((p) => p.timings?.prewarmed)).toEqual([true, false])
  })

  it('a second send whose wait outlives the first’s steers the first send’s own session, never the late prewarm', async () => {
    vi.useFakeTimers()
    try {
      let releasePrewarm: () => void = () => {}
      const gate = new Promise<void>((r) => {
        releasePrewarm = r
      })
      const { transport, dispatches, create, mints, registered, ensured, persists } = setup({
        prewarmGate: () => gate,
      })
      const warming = transport.prewarm('chat-1')
      const first = transport.sendMessages(blankSend())
      await vi.advanceTimersByTimeAsync(1_000)
      const second = transport.sendMessages(blankSend())
      // The first send gives up on the prewarm and makes (and registers) its own session.
      await vi.advanceTimersByTimeAsync(2_000)
      await drain(await first)
      expect(dispatches.map((d) => d.kind)).toEqual(['create'])
      expect(registered).toEqual([{ conversationId: 'conv-new-2', sessionId: 'wrun_ABC' }])

      // The prewarm lands while the second send still waits on it: that send
      // takes the session the first installed, not the prewarm's.
      releasePrewarm()
      await warming
      await drain(await second)
      await vi.runAllTimersAsync()

      // The second send minted against the first send's row, as a turn on a live
      // handle (no history), and sent on its own token, never the prewarm's.
      expect(mints).toEqual([
        { conversationId: null, agentId: undefined, skillId: undefined, wantHistory: undefined },
        { conversationId: null, agentId: undefined, skillId: undefined, wantHistory: true },
        { conversationId: 'conv-new-2', agentId: undefined, skillId: undefined, wantHistory: undefined },
      ])
      expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
      expect((dispatches[1].options.headers as Record<string, string>)['x-chat-run-token']).toEqual(tagged('mint-3'))
      // The late prewarm never registered or installed: one registration (the
      // first send's), no create beyond its message-free one and the first send's.
      expect(registered).toHaveLength(1)
      expect(create).toHaveBeenCalledTimes(2)
      expect(ensured).toEqual(['conv-new-2'])
      expect(persists.map((p) => p.timings?.prewarmed)).toEqual([false, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a chat bound to a conversation since its prewarm (a loaded chat) never uses it', async () => {
    const bound = { current: null as string | null }
    const { transport, dispatches, mints } = setup({ bound })
    await transport.prewarm('chat-1')
    bound.current = 'conv-loaded'
    await drain(await transport.sendMessages(blankSend()))
    expect(mints[1]).toMatchObject({ conversationId: 'conv-loaded', wantHistory: true })
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
  })

  it('makes no prewarm for a chat with a session, a bound conversation, or one already made', async () => {
    const bound = { current: 'conv-home' as string | null }
    const { transport, mints, create } = setup({ bound })
    await transport.prewarm('chat-1')
    expect(mints).toHaveLength(0)

    bound.current = null
    await transport.prewarm('chat-2')
    await transport.prewarm('chat-2')
    expect(mints).toHaveLength(1)

    await drain(await transport.sendMessages(blankSend('chat-3')))
    bound.current = null // so only the live session can stop this one
    await transport.prewarm('chat-3')
    expect(mints).toHaveLength(2) // chat-2's prewarm, chat-3's send
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('a prewarmed session that refuses the first send falls back to a fresh session, registered in its place', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { transport, dispatches, registered, persists } = setup({
      respond: (d, i) => {
        if (i === 0) throw Object.assign(new Error('The session is no longer active.'), { status: 409, code: 'session_not_active' })
        return makeResponse('wrun_NEW', [evTextDone('hi'), evTurnDone()])
      },
    })
    await transport.prewarm('chat-1')
    await drain(await transport.sendMessages(blankSend()))
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['send', 'create'])
    expect(registered.map((r) => r.sessionId)).toEqual(['wrun_ABC', 'wrun_NEW'])
    expect(persists[0].timings).toMatchObject({ new_session: true, prewarmed: false })
  })

  it('Stop while the prewarm is still in flight: nothing is POSTed or rejected, and the next send continues the prewarmed session', async () => {
    let releasePrewarm: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releasePrewarm = r
    })
    const { transport, dispatches, registered, attach } = setup({
      prewarmGate: () => gate,
      // The row the prewarm registered its session on hands it back (a re-attach).
      mint: async (args, n) => ({
        token: runToken(`mint-${n}`),
        conversationId: args.conversationId ?? `conv-new-${n}`,
        ...(args.conversationId === 'conv-new-1' ? { eveSessionId: 'wrun_ABC' } : {}),
      }),
    })
    const warming = transport.prewarm('chat-1')
    const stop = new AbortController()
    const sending = transport.sendMessages({ ...blankSend(), abortSignal: stop.signal } as never)
    stop.abort()
    releasePrewarm()
    const chunks = await drain(await sending)
    await warming
    await flush()
    expect(chunks.map((c) => c.type)).toEqual(['abort'])
    expect(dispatches).toEqual([])
    expect(registered).toHaveLength(1)

    await drain(await transport.sendMessages(blankSend()))
    expect(attach).toHaveBeenCalledWith('wrun_ABC')
    expect(dispatches.map((d) => d.kind)).toEqual(['send'])
  })

  it('unmounting mid-prewarm (disposeAll) abandons it: it never registers and never rejects', async () => {
    let releasePrewarm: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releasePrewarm = r
    })
    const { transport, registered, dispatches } = setup({ prewarmGate: () => gate })
    const warming = transport.prewarm('chat-1')
    await flush()
    await transport.disposeAll()
    releasePrewarm()
    await expect(warming).resolves.toBeUndefined()
    expect(registered).toEqual([])
    expect(dispatches).toEqual([])
  })
})

describe('EveChatTransport — the default register checks the response', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a refused registration is not taken as done: the turn still streams, and the next send registers again', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    const { client } = makeFakeClient(() => makeResponse('wrun_ABC', [evTextDone('a'), evTurnDone()]))
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok.sig', conversationId: 'conv-1' }),
      createClient: () => client as never,
      persistTurn: async () => {},
    })
    // runTurn swallows the refusal (the turn streams on); the next send retries it.
    const firstTurn = await drain(await transport.sendMessages(sendOpts()))
    expect(firstTurn.some((c) => c.type === 'error')).toBe(false)
    expect(firstTurn[firstTurn.length - 1].type).toBe('finish')
    await drain(await transport.sendMessages(sendOpts()))
    const registers = fetchMock.mock.calls.filter((c) =>
      String((c as unknown as [string, RequestInit])[1]?.body).includes('"register"'),
    )
    expect(registers).toHaveLength(2)
  })
})

describe('EveChatTransport — mint failure semantics (usage gate; no retry elsewhere)', () => {
  /**
   * These exercise the DEFAULT mint path (no injected mintRunToken → the real
   * fetch against /api/account/chat/eve-session, spied here). The invariant
   * under test: a failed mint REJECTS sendMessages (→ useChat onError → toast)
   * and makes NO other request — eve is the only cloud chat runtime, there is
   * nothing to fall back to. A 503 means the deployment has no internal secret
   * (CHAT_RUNTIME_UNCONFIGURED) or billing fail-closed (BILLING_UNAVAILABLE),
   * distinguishable by body.code.
   */
  function defaultMintTransport() {
    return new EveChatTransport({
      getAccessToken: () => 'jwt-token',
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => makeFakeClient(() => makeResponse("wrun_1", [evTurnDone()])).client as never,
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mint 429 → rejects with the COMPOSED usage-limit copy (error + reason + reset date)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Usage limit exceeded',
          reason: 'trial_expired',
          plan: 'free',
          isPaidPlan: false,
          usageResetDate: '2026-08-01T00:00:00+00:00',
          creditBalanceUsd: 0,
        }),
        { status: 429 },
      ),
    )
    const transport = defaultMintTransport()
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow(
      'Usage limit exceeded: trial_expired. Resets 2026-08-01T00:00:00+00:00.',
    )
    // The ONLY request is the mint route — nothing else is called on a mint
    // failure of any status.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('/api/account/chat/eve-session')
  })

  it('mint 429 with a bare body still surfaces clean copy (no raw JSON)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }),
    )
    const transport = defaultMintTransport()
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow('Usage limit exceeded.')
  })

  it('mint 503 CHAT_RUNTIME_UNCONFIGURED (secret unset) surfaces its body.error verbatim — regression', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'chat runtime is not configured', code: 'CHAT_RUNTIME_UNCONFIGURED' }),
        { status: 503 },
      ),
    )
    const transport = defaultMintTransport()
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow(
      'chat runtime is not configured',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('/api/account/chat/eve-session')
  })

  it('mint 503 BILLING_UNAVAILABLE surfaces its body.error too (distinct from unconfigured; no fallback)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }),
        { status: 503 },
      ),
    )
    const transport = defaultMintTransport()
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow('Usage check unavailable')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('/api/account/chat/eve-session')
  })

  it('a successful default mint proceeds to the turn (the gate does not break happy path)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'tok.sig', conversationId: 'conv-1' }), {
        status: 200,
      }),
    )
    const transport = defaultMintTransport()
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    expect(chunks.map((c) => c.type)).toContain('finish')
  })
})

describe('EveChatTransport — per-turn event accumulation is usage-only (memory cap)', () => {
  // 2026-08-05 incident analysis: `turn.events.push(event)` recorded EVERY
  // stream event — one retained object per message.appended text delta,
  // O(deltas) held for the whole turn and POSTed to the persist route — purely
  // for a usage mapping that only reads step.completed + actions.requested.
  // The transport now retains just those; this pins that the persist body's
  // events stay lean AND that mapEveTurnUsage still computes identical usage
  // from the retained subset.
  it('retains only step.completed + actions.requested in the persist body — usage still computes correctly', async () => {
    const persists: Array<{ body: any }> = []
    // A delta-heavy turn: 50 text deltas that must NOT be retained.
    const deltas = Array.from({ length: 50 }, (_, i) => evTextDelta(`d${i}`))
    const { transport } = makeTransport(
      [
        ...deltas,
        evTextDone('done'),
        evToolCall('call-1', 'search_tools', { q: 'roadmap' }),
        evToolResult('call-1', { tools: [] }),
        ev({
          type: 'step.completed',
          data: {
            finishReason: 'stop',
            usage: { inputTokens: 12, outputTokens: 7 },
            providerMetadata: { gateway: { generationId: 'gen-1' } },
          },
        }),
        evTurnDone(),
      ],
      { onPersist: (a) => persists.push(a as any) },
    )
    await drain(await transport.sendMessages(sendOpts()))

    expect(persists).toHaveLength(1)
    const kept = persists[0].body.usage.events as Array<{ type: string }>
    // No per-delta retention — only the usage-bearing events survive.
    expect(kept.some((e) => e.type === 'message.appended')).toBe(false)
    expect(kept.every((e) => isUsageRelevantEvent(e as never))).toBe(true)
    expect(kept.map((e) => e.type)).toEqual(['actions.requested', 'step.completed'])

    // The persist route's mapping over the retained subset yields full usage.
    const usage = mapEveTurnUsage(kept as never, { wallMs: persists[0].body.usage.wallMs })
    expect(usage.inputTokens).toBe(12)
    expect(usage.outputTokens).toBe(7)
    expect(usage.steps).toBe(1)
    expect(usage.toolCalls).toBe(1)
    expect(usage.toolDiscoveries).toBe(1) // search_tools counted
    expect(usage.generationIds).toEqual(['gen-1'])
    expect(usage.durationMs).toBe(persists[0].body.usage.wallMs)
  })
})

describe('EveChatTransport — oversized tool outputs truncated at the boundary', () => {
  // The 2026-08-05 incident class: action.result outputs entered
  // useChat state (and the persisted projection) in full. eve executed the tool
  // server-side and the model read the full result there — the client copy is
  // display/history-only, so it is bounded before the chunk is emitted.
  it('truncates a huge action.result in BOTH the emitted chunk and the persisted part', async () => {
    const persists: Array<{ body: any }> = []
    const big = 'x'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 10_000)
    const { transport } = makeTransport(
      [
        evToolCall('call-1', 'get_capture_content', { id: 'cap-1' }),
        evToolResult('call-1', big),
        evTurnDone(),
      ],
      { onPersist: (a) => persists.push(a as any) },
    )
    const chunks = await drain(await transport.sendMessages(sendOpts()))

    const out = chunks.find((c) => c.type === 'tool-output-available') as
      | { output: unknown }
      | undefined
    expect(out).toBeTruthy()
    expect(typeof out!.output).toBe('string')
    expect((out!.output as string).length).toBeLessThan(11_000)
    expect(out!.output).toContain('output truncated for display')

    // The projection persisted the SAME truncated view (a reload matches).
    const part = persists[0].body.parts.find((p: any) => p.type === 'dynamic-tool')
    expect(part.state).toBe('output-available')
    expect(part.output).toContain('output truncated for display')
    expect((part.output as string).length).toBeLessThan(11_000)
  })

  it('leaves a small structured output untouched (same reference in the chunk)', async () => {
    const output = { id: 'ACT-1', success: true }
    const { transport } = makeTransport([
      evToolCall('call-1', 'create_action', { title: 'Ship' }),
      evToolResult('call-1', output),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const out = chunks.find((c) => c.type === 'tool-output-available') as
      | { output: unknown }
      | undefined
    expect(out!.output).toBe(output)
  })

  it('bounds an oversized isError result via errorText too', async () => {
    const bigErr = 'E'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 5_000)
    const { transport } = makeTransport([
      evToolCall('call-1', 'find', { q: 'x' }),
      ev({
        type: 'action.result',
        data: {
          result: { kind: 'tool-result', callId: 'call-1', toolName: 'find', isError: true, output: bigErr },
        },
      }),
      evTurnDone(),
    ])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    const err = chunks.find((c) => c.type === 'tool-output-error') as
      | { errorText: string }
      | undefined
    expect(err).toBeTruthy()
    expect(err!.errorText.length).toBeLessThan(11_000)
    expect(err!.errorText).toContain('output truncated for display')
  })
})

// ── eve 0.57+ steer semantics: one durable turn, partitioned by deliveryIds ──
//
// Since eve 0.57 a message steered into a running turn does NOT cancel it (no
// turn.cancelled, no new turn id): eve continues the SAME turn and appends the
// steering message's delivery id to every later event's `meta.deliveryIds`.
// eve's client scopes the steering send's response to start at the first event
// carrying its delivery id, so BOTH the steered turn's response and the
// steering send's response read the tail. These tests pin the transport's
// partition: the steered turn settles at exactly that event, the steering send
// renders the rest, and nothing is rendered, persisted or billed twice.
describe('EveChatTransport — steer (eve 0.57+: same turn, deliveryIds partition)', () => {
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
          await new Promise<void>((r) => { wake = r })
          wake = null
        }
      },
    }
  }

  /** Stamp an event with eve's delivery envelope (v25 wire shape). */
  const stamped = (e: object, deliveryIds: string[], id: string): HandleMessageStreamEvent =>
    ({ ...e, meta: { id, at: '2026-09-24T00:00:00.000Z', deliveryIds } }) as unknown as HandleMessageStreamEvent
  const turnStarted = { type: 'turn.started', data: { turnId: 'turn_0' } }
  const text = (delta: string) => ({
    type: 'message.appended',
    data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' },
  })
  const stepDone = {
    type: 'step.completed',
    data: { finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, turnId: 'turn_0' },
  }
  const turnDone = { type: 'turn.completed', data: { turnId: 'turn_0' } }
  const waiting = { type: 'session.waiting', data: {} }

  function secondSendOpts() {
    const o = sendOpts() as unknown as { messages: unknown[] }
    return {
      ...o,
      messages: [
        ...o.messages,
        { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'no, do X instead' }] },
      ],
    } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
  }

  function setup(responses: Array<AsyncIterable<HandleMessageStreamEvent>>, extra: { checkUsage?: () => Promise<'ok' | 'blocked' | 'unknown'> } = {}) {
    const { client, dispatches, cancel } = makeFakeClient((_d, i) => ({
      sessionId: 'wrun_ABC',
      [Symbol.asyncIterator]: () => responses[i][Symbol.asyncIterator](),
    }))
    const persists: Array<{ body: EvePersistBodyLike }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async (a) => { if (!a.body.onSend) persists.push(a as unknown as { body: EvePersistBodyLike }) },
      createClient: () => client as never,
      ...extra,
    })
    return { transport, dispatches, persists, cancel }
  }
  type EvePersistBodyLike = {
    messageId: string
    parts: Array<{ type: string; text?: string }>
    usage: { events: Array<{ type: string }> }
    userMessage?: { messageId: string }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const textOf = (chunks: UIMessageChunk[]) =>
    chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('')

  it('steer folded into the running turn: the prior turn settles at the steer point, the steering send renders the tail — nothing twice', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, persists } = setup([r1, r2])

    const s1 = await transport.sendMessages(sendOpts())
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('Drafting the'), ['d1'], 'e2'))
    const reader1 = s1.getReader()
    const firstChunks: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      firstChunks.push(value)
      if (value.type === 'text-delta') break
    }

    // The user types a correction while the reply streams → a steering send.
    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    expect(dispatches).toHaveLength(2)
    expect(dispatches[1].kind).toBe('send')
    expect(dispatches[1].options.turnPolicy).toBe('steer')

    // eve applies the steer in the SAME turn: later events carry [d1, d2]. The
    // steered turn's response still yields them (it owns d1)…
    const tail = [
      stamped(text(' X version'), ['d1', 'd2'], 'e3'),
      stamped(stepDone, ['d1', 'd2'], 'e4'),
      stamped(turnDone, ['d1', 'd2'], 'e5'),
      stamped(waiting, ['d1', 'd2'], 'e6'),
    ]
    r1.push(...tail)
    r1.end()
    // …and eve's client starts the steering send's response at the first d2 event.
    r2.push(...tail)
    r2.end()

    const rest1: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      rest1.push(value)
    }
    const chunks2 = await drain(s2)
    await flush()

    const all1 = [...firstChunks, ...rest1]
    // Prior turn: only what streamed before the steer point, then a graceful finish.
    expect(textOf(all1)).toBe('Drafting the')
    expect(all1.map((c) => c.type)).toContain('text-end')
    expect(all1[all1.length - 1].type).toBe('finish')
    // Steering send: exactly the tail, once.
    expect(textOf(chunks2)).toBe(' X version')
    expect(chunks2[chunks2.length - 1].type).toBe('finish')

    // Two persists, disjoint content, usage counted once.
    expect(persists).toHaveLength(2)
    const [p1, p2] = persists.map((p) => p.body)
    expect(p1.messageId).not.toBe(p2.messageId)
    expect(p1.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).toBe('Drafting the')
    expect(p2.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).toBe(' X version')
    expect(p2.userMessage?.messageId).toBe('m2')
    const steps = (b: EvePersistBodyLike) => b.usage.events.filter((e) => e.type === 'step.completed').length
    expect(steps(p1) + steps(p2)).toBe(1)
    expect(steps(p2)).toBe(1)
  })

  it('steer that lands after the prior turn settled: the prior turn finishes normally and the send renders the NEXT turn', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, persists } = setup([r1, r2])

    const s1 = await transport.sendMessages(sendOpts())
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('Done: A.'), ['d1'], 'e2'))
    const reader1 = s1.getReader()
    for (;;) {
      const { value, done } = await reader1.read()
      if (done || value.type === 'text-delta') break
    }

    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    // eve had already settled turn_0 (only d1) — d2 starts turn_1.
    r1.push(stamped(stepDone, ['d1'], 'e3'), stamped(turnDone, ['d1'], 'e4'), stamped(waiting, ['d1'], 'e5'))
    r1.end()
    r2.push(
      stamped({ ...turnStarted, data: { turnId: 'turn_1' } }, ['d2'], 'e6'),
      stamped(text('Now X.'), ['d2'], 'e7'),
      stamped(stepDone, ['d2'], 'e8'),
      stamped(turnDone, ['d2'], 'e9'),
      stamped(waiting, ['d2'], 'e10'),
    )
    r2.end()

    const rest1: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      rest1.push(value)
    }
    const chunks2 = await drain(s2)
    await flush()

    expect(rest1.map((c) => c.type)).toEqual(['text-end', 'finish-step', 'finish'])
    expect(textOf(chunks2)).toBe('Now X.')
    expect(persists).toHaveLength(2)
    const steps = persists.map(
      (p) => p.body.usage.events.filter((e) => e.type === 'step.completed').length,
    )
    expect(steps).toEqual([1, 1])
  })

  it('the steering send does not POST until the prior turn knows its own deliveryIds (no fold into the turn start)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches } = setup([r1, r2])

    const s1 = await transport.sendMessages(sendOpts())
    await flush()
    expect(dispatches).toHaveLength(1)

    // Second send BEFORE the first turn produced any stamped event.
    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    expect(dispatches).toHaveLength(1) // held back

    r1.push(stamped(turnStarted, ['d1'], 'e1'))
    await flush()
    await flush()
    expect(dispatches).toHaveLength(2) // released once d1 is known

    r1.push(stamped(turnDone, ['d1'], 'e2'), stamped(waiting, ['d1'], 'e3'))
    r1.end()
    r2.push(stamped(turnDone, ['d2'], 'e4'), stamped(waiting, ['d2'], 'e5'))
    r2.end()
    await drain(s1)
    await drain(s2)
  })

  it('events without deliveryIds are never treated as a steer point', async () => {
    const r1 = pushable()
    const { transport } = setup([r1])
    const s1 = await transport.sendMessages(sendOpts())
    r1.push(ev({ type: 'message.appended', data: { messageDelta: 'plain', sequence: 0, stepIndex: 0, turnId: 'turn_0' } }))
    r1.push(evTurnDone())
    r1.end()
    const chunks = await drain(s1)
    expect(textOf(chunks)).toBe('plain')
    expect(chunks[chunks.length - 1].type).toBe('finish')
  })

  // ── Answer-then-steer: the resume loop partitions exactly like runTurn ──
  const askUserRequested = {
    type: 'input.requested',
    data: {
      requests: [
        {
          requestId: 'req-1',
          display: 'select',
          prompt: 'Which env?',
          action: {
            kind: 'tool-call',
            callId: 'call-auq',
            toolName: 'ask_user',
            input: { questions: [{ question: 'Which env?', options: [{ label: 'Staging' }, { label: 'Prod' }] }] },
          },
        },
      ],
    },
  }
  const partsText = (b: EvePersistBodyLike) =>
    b.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
  const stepsIn = (b: EvePersistBodyLike) => b.usage.events.filter((e) => e.type === 'step.completed').length

  async function readUntilChunk(
    reader: ReadableStreamDefaultReader<UIMessageChunk>,
    pred: (c: UIMessageChunk) => boolean,
  ): Promise<UIMessageChunk[]> {
    const out: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      out.push(value)
      if (pred(value)) break
    }
    return out
  }

  it('steer while an ANSWERED ask_user resume is streaming: the resumed turn settles at the steer point inside answerPermission — nothing rendered, persisted or billed twice', async () => {
    const r1 = pushable()
    const rResume = pushable()
    const r2 = pushable()
    const { transport, dispatches, persists } = setup([r1, rResume, r2])

    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(askUserRequested, ['d1'], 'e2'),
      stamped(waiting, ['d1'], 'e3'),
    )
    r1.end()
    const beforeAnswer = await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')

    // The user answers the picker → answerPermission resumes the SAME turn.
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    await flush()
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond'])
    rResume.push(stamped({ ...text('Staging it is.'), data: { ...text('Staging it is.').data, turnId: 'turn_1' } }, ['d1'], 'e4'))
    const resumedHead = await readUntilChunk(reader1, (c) => c.type === 'text-delta')

    // …and types a correction while the resumed reply streams → a steering send.
    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond', 'send'])

    // eve folds the correction into the resumed turn: its tail carries [d1, d2].
    // The resume response still yields it (owns d1); the steering send's response
    // starts at the first d2 event.
    const tail = [
      stamped({ ...text(' Actually X.'), data: { ...text(' Actually X.').data, turnId: 'turn_1' } }, ['d1', 'd2'], 'e5'),
      stamped({ ...stepDone, data: { ...stepDone.data, turnId: 'turn_1' } }, ['d1', 'd2'], 'e6'),
      stamped({ ...turnDone, data: { turnId: 'turn_1' } }, ['d1', 'd2'], 'e7'),
      stamped(waiting, ['d1', 'd2'], 'e8'),
    ]
    rResume.push(...tail)
    rResume.end()
    r2.push(...tail)
    r2.end()

    const rest1 = await readUntilChunk(reader1, () => false)
    const chunks2 = await drain(s2)
    await answered
    await flush()

    const all1 = [...beforeAnswer, ...resumedHead, ...rest1]
    // The answered turn renders only what streamed before the steer point.
    expect(textOf(all1)).toBe('Staging it is.')
    expect(all1[all1.length - 1].type).toBe('finish')
    // The steering send renders the tail exactly once.
    expect(textOf(chunks2)).toBe(' Actually X.')

    expect(persists).toHaveLength(2)
    const [p1, p2] = persists.map((p) => p.body)
    expect(partsText(p1)).toBe('Staging it is.')
    expect(partsText(p2)).toBe(' Actually X.')
    expect(stepsIn(p1) + stepsIn(p2)).toBe(1)
  })

  it('a turn that was NOT superseded adopts a foreign delivery id (steered from elsewhere) and renders through to turn.completed, persisted once', async () => {
    const r1 = pushable()
    const { transport, persists } = setup([r1])
    const s1 = await transport.sendMessages(sendOpts())
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(text('Half'), ['d1'], 'e2'),
      // Another tab steered this chat: eve appends ITS delivery id. This transport
      // sent nothing, so there is no steering response here to hand off to.
      stamped(text(' and the rest.'), ['d1', 'dX'], 'e3'),
      stamped(stepDone, ['d1', 'dX'], 'e4'),
      stamped(turnDone, ['d1', 'dX'], 'e5'),
      stamped(waiting, ['d1', 'dX'], 'e6'),
    )
    r1.end()
    const chunks = await drain(s1)
    await flush()

    expect(textOf(chunks)).toBe('Half and the rest.')
    expect(chunks[chunks.length - 1].type).toBe('finish')
    expect(persists).toHaveLength(1)
    expect(partsText(persists[0].body)).toBe('Half and the rest.')
    expect(stepsIn(persists[0].body)).toBe(1)
  })

  it('an ADOPTED foreign id stays owned after a later local steer: the turn settles only at the first event carrying the local steer id', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, persists } = setup([r1, r2])
    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(text('Half'), ['d1'], 'e2'),
      // Steered from another tab (dX) — adopted, since nothing here superseded it.
      stamped(text(' and'), ['d1', 'dX'], 'e3'),
    )
    await readUntilChunk(reader1, (c) => c.type === 'text-delta' && (c as { delta: string }).delta === ' and')

    // Now THIS tab steers (d2): the turn is superseded.
    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])

    // Without the adoption, this [d1, dX] event would read as the steer point
    // and cut the turn one event early.
    r1.push(stamped(text(' more'), ['d1', 'dX'], 'e4'))
    const tail = [
      stamped(text(' X'), ['d1', 'dX', 'd2'], 'e5'),
      stamped(stepDone, ['d1', 'dX', 'd2'], 'e6'),
      stamped(turnDone, ['d1', 'dX', 'd2'], 'e7'),
      stamped(waiting, ['d1', 'dX', 'd2'], 'e8'),
    ]
    r1.push(...tail)
    r1.end()
    r2.push(...tail)
    r2.end()

    const rest1 = await readUntilChunk(reader1, () => false)
    const chunks2 = await drain(s2)
    await flush()

    expect(textOf(rest1)).toBe(' more')
    expect(rest1[rest1.length - 1].type).toBe('finish')
    expect(textOf(chunks2)).toBe(' X')
    expect(persists).toHaveLength(2)
    const texts = persists.map((p) => partsText(p.body)).sort()
    expect(texts).toEqual([' X', 'Half and more'].sort())
    expect(persists.reduce((n, p) => n + stepsIn(p.body), 0)).toBe(1)
  })

  it('a send arriving while a turn is PARKED on an open ask_user is dispatched at once (no identity wait) and renders its own turn', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches } = setup([r1, r2])
    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(askUserRequested, ['d1'], 'e2'),
      stamped(waiting, ['d1'], 'e3'),
    )
    r1.end()
    const parked = await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')
    expect(parked.some((c) => c.type === 'tool-input-available')).toBe(true)
    await flush()

    const s2 = await transport.sendMessages(secondSendOpts())
    await flush()
    // Dispatched straight away: a parked turn is never superseded, so the send
    // is not held behind the 15s identity wait.
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])

    // eve runs the unrelated text as its OWN turn (only d2) while the approval stays pending.
    r2.push(
      stamped({ ...turnStarted, data: { turnId: 'turn_1' } }, ['d2'], 'e4'),
      stamped({ ...text('Sure.'), data: { ...text('Sure.').data, turnId: 'turn_1' } }, ['d2'], 'e5'),
      stamped({ ...turnDone, data: { turnId: 'turn_1' } }, ['d2'], 'e6'),
      stamped(waiting, ['d2'], 'e7'),
    )
    r2.end()
    expect(textOf(await drain(s2))).toBe('Sure.')
    reader1.releaseLock()
  })

  // KNOWN GAP (predates WS-0): answerPermission looks the request up on
  // `active.turn`, which the intervening send replaced, so the earlier picker can
  // no longer be answered (no resume is sent; the parked turn is never settled or
  // persisted). `it.fails` keeps this visible: it starts failing — and must be
  // flipped to `it` — the day the transport tracks parked turns per chat.
  it.fails('KNOWN GAP: a picker parked BEFORE an intervening send can still be answered afterwards', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r1 = pushable()
      const r2 = pushable()
      const rResume = pushable()
      const { transport, dispatches } = setup([r1, r2, rResume])
      const s1 = await transport.sendMessages(sendOpts())
      const reader1 = s1.getReader()
      r1.push(
        stamped(turnStarted, ['d1'], 'e1'),
        stamped(askUserRequested, ['d1'], 'e2'),
        stamped(waiting, ['d1'], 'e3'),
      )
      r1.end()
      await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')
      await flush()
      const s2 = await transport.sendMessages(secondSendOpts())
      r2.push(stamped({ ...turnDone, data: { turnId: 'turn_1' } }, ['d2'], 'e4'), stamped(waiting, ['d2'], 'e5'))
      r2.end()
      await drain(s2)

      await transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
      await flush()
      expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send', 'respond'])
      reader1.releaseLock()
    } finally {
      quiet.mockRestore()
    }
  })

  // ── Stop: the durable eve turn is cancelled server-side (eve 0.57+ steer no
  //    longer cancels it, so a detached turn would run on unobserved/unbilled).
  //    The cancel is ALWAYS scoped to the turn this send started or steered. ──
  it('Stop mid-reply cancels the server turn exactly once, scoped to the observed eve turn id', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, cancel } = setup([r1, r2])
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    const reader1 = s1.getReader()
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('Writing a long'), ['d1'], 'e2'))
    await readUntilChunk(reader1, (c) => c.type === 'text-delta')

    stop.abort()
    await flush()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith({ turnId: 'turn_0' })
    const rest = await readUntilChunk(reader1, () => false)
    expect(rest.map((c) => c.type)).toContain('abort')

    // A late event on the detached stream never re-triggers anything.
    r1.push(stamped(text(' answer'), ['d1'], 'e3'))
    r1.end()
    await flush()

    // The next message starts cleanly (fresh create) and does not cancel again.
    const s2 = await transport.sendMessages(secondSendOpts())
    r2.push(stamped({ ...turnDone, data: { turnId: 'turn_1' } }, ['d2'], 'e4'), stamped(waiting, ['d2'], 'e5'))
    r2.end()
    await drain(s2)
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'create'])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('Stop before any turn-scoped event never cancels unscoped: the response keeps draining (nothing rendered) until it names its turn, then cancels exactly that turn', async () => {
    const r1 = pushable()
    const { transport, cancel } = setup([r1])
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    stop.abort()
    await flush()
    expect(cancel).not.toHaveBeenCalled()
    const chunks = await drain(s1)
    expect(chunks.map((c) => c.type)).toContain('abort')

    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('unseen'), ['d1'], 'e2'))
    await flush()
    await flush()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith({ turnId: 'turn_0' })
    r1.end()
    await flush()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('Stop on a steering send before its first event (eve runs it as the NEXT turn): cancels the NEW turn, never the previous reply and never unscoped', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, cancel } = setup([r1, r2])
    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('Streaming turn_0'), ['d1'], 'e2'))
    await readUntilChunk(reader1, (c) => c.type === 'text-delta')

    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(secondSendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])
    stop.abort()
    await flush()
    // The only turn with a known id is turn_0 (the previous reply). It must not be touched.
    expect(cancel).not.toHaveBeenCalled()
    await drain(s2)

    // turn_0 finishes normally on its own response…
    r1.push(stamped(stepDone, ['d1'], 'e3'), stamped(turnDone, ['d1'], 'e4'), stamped(waiting, ['d1'], 'e5'))
    r1.end()
    // …and eve runs the correction as turn_1, which the stopped send drains to find.
    r2.push(
      stamped({ ...turnStarted, data: { turnId: 'turn_1' } }, ['d2'], 'e6'),
      stamped({ ...text('never shown'), data: { ...text('never shown').data, turnId: 'turn_1' } }, ['d2'], 'e7'),
    )
    const rest1 = await readUntilChunk(reader1, () => false)
    await flush()
    await flush()

    expect(textOf(rest1)).toBe('')
    expect(rest1[rest1.length - 1].type).toBe('finish')
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_1' }]])
    r2.end()
  })

  // For a FOLDED correction the previous reply and the correction are ONE eve
  // turn, so Stop cancels that shared turn: the previous reply's turn id. eve
  // has already redirected that turn's remaining work to the correction when it
  // folded (before output: pending generation stopped; after output: from the
  // next committed boundary on), so what the cancel ends is the correction's
  // work on it. Replayed from a live recording in the recorded-streams suite.
  it('Stop on a steering send that eve FOLDED into the running turn cancels that SHARED turn (the previous reply\'s turn id, which now carries the stopped correction)', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, cancel } = setup([r1, r2])
    const s1 = await transport.sendMessages(sendOpts())
    r1.push(stamped(turnStarted, ['d1'], 'e1'))
    await flush()
    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(secondSendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    stop.abort()
    await flush()
    expect(cancel).not.toHaveBeenCalled()
    await drain(s2)

    const folded = stamped(text('corrected'), ['d1', 'd2'], 'e2')
    r1.push(folded, stamped(turnDone, ['d1', 'd2'], 'e3'), stamped(waiting, ['d1', 'd2'], 'e4'))
    r1.end()
    r2.push(folded)
    await drain(s1)
    await flush()
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])
    r2.end()
  })

  it('Stop on an answered ask_user cancels the held turn by its id at once (eve 0.70+: the answer resumes the SAME turn)', async () => {
    const r1 = pushable()
    const rResume = pushable()
    const { transport, dispatches, cancel } = setup([r1, rResume])
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    const reader1 = s1.getReader()
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(askUserRequested, ['d1'], 'e2'),
      stamped(waiting, ['d1'], 'e3'),
    )
    r1.end()
    await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')
    await flush()
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    await flush()
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond'])

    stop.abort()
    await flush()
    // The held turn's id is the resumed turn's: no wait for a turn.started that never comes.
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])

    // The resume stream continues the same turn.
    rResume.push(stamped({ type: 'input.resolved', data: { requestId: 'req-1', turnId: 'turn_0' } }, ['d1'], 'e4'))
    await flush()
    await flush()
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])
    rResume.end()
    await answered
    reader1.releaseLock()
  })

  it('an ask_user answer while over the usage limit is not resumed (eve 0.70+ resumes with no turn.started, so the hook never checks it)', async () => {
    const r1 = pushable()
    const rResume = pushable()
    const checkUsage = vi.fn(async (): Promise<'ok' | 'blocked' | 'unknown'> => 'blocked')
    const { transport, dispatches } = setup([r1, rResume], { checkUsage })
    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(askUserRequested, ['d1'], 'e2'), stamped(waiting, ['d1'], 'e3'))
    r1.end()
    await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')
    await flush()
    await transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    expect(checkUsage).toHaveBeenCalledTimes(1)
    // No respond: the held turn waits, and the answer stays answerable.
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    checkUsage.mockResolvedValue('ok')
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    await flush()
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond'])
    rResume.end()
    await answered
    reader1.releaseLock()
  })

  it('a sent turn cancelled with no answer and no Stop asks the usage check (the gate hook cancels a blocked turn); a Stop does not', async () => {
    const checkUsage = vi.fn(async () => 'blocked' as const)
    const r1 = pushable()
    const { transport } = setup([r1], { checkUsage })
    const s1 = await transport.sendMessages(sendOpts())
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped({ type: 'turn.cancelled', data: { turnId: 'turn_0' } }, ['d1'], 'e2'), stamped(waiting, ['d1'], 'e3'))
    r1.end()
    const reader = s1.getReader()
    for (;;) if ((await reader.read()).done) break
    expect(checkUsage).toHaveBeenCalledTimes(1)

    const r2 = pushable()
    const stopped = setup([r2], { checkUsage: vi.fn(async () => 'ok' as const) })
    const stop = new AbortController()
    const s2 = await stopped.transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    r2.push(stamped(turnStarted, ['d1'], 'e1'))
    await flush()
    stop.abort()
    r2.push(stamped({ type: 'turn.cancelled', data: { turnId: 'turn_0' } }, ['d1'], 'e2'), stamped(waiting, ['d1'], 'e3'))
    r2.end()
    const reader2 = s2.getReader()
    for (;;) if ((await reader2.read()).done) break
    await flush()
    expect((stopped.transport as unknown as { opts: { checkUsage: ReturnType<typeof vi.fn> } }).opts.checkUsage).not.toHaveBeenCalled()
  })

  it('Stop while the answered ask_user resume POST (respond) is still in flight cancels the held turn by id, and the late response is drained', async () => {
    const r1 = pushable()
    const rResume = pushable()
    let releaseRespond: () => void = () => {}
    const respondGate = new Promise<void>((r) => { releaseRespond = r })
    const { client, dispatches, cancel } = makeFakeClient(async (_d, i) => {
      if (i === 1) await respondGate
      const src = i === 0 ? r1 : rResume
      return { sessionId: 'wrun_ABC', [Symbol.asyncIterator]: () => src[Symbol.asyncIterator]() }
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    const reader1 = s1.getReader()
    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(askUserRequested, ['d1'], 'e2'),
      stamped(waiting, ['d1'], 'e3'),
    )
    r1.end()
    await readUntilChunk(reader1, (c) => c.type === 'tool-input-available')
    await flush()
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'Staging' })
    await flush()
    await flush()
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond']) // respond POST still pending

    // Stop lands while the respond POST is in flight: the turn settles for the
    // UI now, before answerPermission has a response to read.
    stop.abort()
    await flush()
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])

    releaseRespond()
    await flush()
    rResume.push(stamped({ type: 'input.resolved', data: { requestId: 'req-1', turnId: 'turn_0' } }, ['d1'], 'e4'))
    await flush()
    await flush()
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])
    rResume.end()
    await answered
    reader1.releaseLock()
  })

  it('Stop while the first turn’s create POST is in flight: the POST is not aborted, and the turn it started is cancelled once create AND registration have settled', async () => {
    let releaseCreate: () => void = () => {}
    const createGate = new Promise<void>((r) => { releaseCreate = r })
    let releaseRegister: () => void = () => {}
    const registerGate = new Promise<void>((r) => { releaseRegister = r })
    let registered = false
    const r1 = pushable()
    const { client, create, cancel } = makeFakeClient(async () => {
      await createGate
      return { sessionId: 'wrun_ABC', [Symbol.asyncIterator]: () => r1[Symbol.asyncIterator]() }
    })
    const registeredWhenCancelled: boolean[] = []
    cancel.mockImplementation(async () => {
      registeredWhenCancelled.push(registered)
      return { status: 'accepted', sessionId: 'wrun_ABC' }
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {
        await registerGate
        registered = true
      },
      persistTurn: async () => {},
      createClient: () => client as never,
    })
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    expect(create).toHaveBeenCalledTimes(1)
    const createOptions = create.mock.calls[0][0] as Record<string, unknown>
    expect(createOptions.signal).toBeUndefined()

    stop.abort()
    await drain(s1)
    releaseCreate()
    await flush()
    r1.push(stamped(turnStarted, ['d1'], 'e1'))
    await flush()
    expect(cancel).not.toHaveBeenCalled() // registration still pending

    releaseRegister()
    await flush()
    await flush()
    expect(cancel.mock.calls).toEqual([[{ turnId: 'turn_0' }]])
    expect(registeredWhenCancelled).toEqual([true])
    r1.end()
  })

  it('Stop on a steering send that never POSTed (still waiting for the prior turn’s identity) cancels nothing server-side', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, cancel } = setup([r1, r2])
    await transport.sendMessages(sendOpts())
    await flush()
    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(secondSendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    expect(dispatches).toHaveLength(1) // held behind the identity wait
    stop.abort()
    await flush()
    expect(cancel).not.toHaveBeenCalled()
    expect(dispatches).toHaveLength(1)
    await drain(s2)
    r1.end()
  })

  it('a steering send stopped BEFORE its POST releases the prior turn: a later foreign delivery id (another tab) is ADOPTED there, not taken as a steer point', async () => {
    const r1 = pushable()
    const r2 = pushable()
    const { transport, dispatches, persists, cancel } = setup([r1, r2])
    const s1 = await transport.sendMessages(sendOpts())
    await flush()
    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(secondSendOpts() as object), abortSignal: stop.signal } as never)
    await flush()
    expect(dispatches).toHaveLength(1) // held behind the identity wait
    stop.abort()
    await drain(s2)
    await flush()

    r1.push(
      stamped(turnStarted, ['d1'], 'e1'),
      stamped(text('Half'), ['d1'], 'e2'),
      // Another tab steered this chat. This transport's own steer never POSTed,
      // so this is not a local steer point: the prior turn must keep it.
      stamped(text(' and the rest.'), ['d1', 'dX'], 'e3'),
      stamped(stepDone, ['d1', 'dX'], 'e4'),
      stamped(turnDone, ['d1', 'dX'], 'e5'),
      stamped(waiting, ['d1', 'dX'], 'e6'),
    )
    r1.end()
    const chunks = await drain(s1)
    await flush()

    expect(textOf(chunks)).toBe('Half and the rest.')
    expect(chunks[chunks.length - 1].type).toBe('finish')
    expect(dispatches).toHaveLength(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(persists).toHaveLength(1)
    expect(partsText(persists[0].body)).toBe('Half and the rest.')
    expect(stepsIn(persists[0].body)).toBe(1)
    r2.end()
  })

  it('a steering send whose POST FAILS releases the prior turn too: a later foreign delivery id is adopted, the tail still renders', async () => {
    const r1 = pushable()
    const { client, dispatches } = makeFakeClient((_d, i) => {
      if (i === 1) throw new Error('eve send failed (503)')
      return { sessionId: 'wrun_ABC', [Symbol.asyncIterator]: () => r1[Symbol.asyncIterator]() }
    })
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => client as never,
    })
    const s1 = await transport.sendMessages(sendOpts())
    r1.push(stamped(turnStarted, ['d1'], 'e1'), stamped(text('Half'), ['d1'], 'e2'))
    await flush()
    const s2 = await transport.sendMessages(secondSendOpts())
    await expect(drain(s2)).rejects.toThrow(/eve send failed/)
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'send'])

    r1.push(
      stamped(text(' and the rest.'), ['d1', 'dX'], 'e3'),
      stamped(turnDone, ['d1', 'dX'], 'e4'),
      stamped(waiting, ['d1', 'dX'], 'e5'),
    )
    r1.end()
    const chunks = await drain(s1)
    expect(textOf(chunks)).toBe('Half and the rest.')
    expect(chunks[chunks.length - 1].type).toBe('finish')
  })

  it('targets the eve 0.58+ named-agent mount (/eve/chat-agent → /eve/chat-agent/v1/*)', async () => {
    let host = ''
    const { client } = makeFakeClient(() => makeResponse('wrun_ABC', [evTurnDone()]))
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: (args) => { host = args.host; return client as never },
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(host).toBe('/eve/chat-agent')
  })
})

// ── Recorded eve 0.66.3 streams (live, local eve dev — see the fixture's _source) ──
//
// Replays REAL event sequences through the transport, each response scoped the
// way eve's client scopes a send (ClientSession.#i in eve/dist/src/client/
// session.js): skip events until the first one whose meta.deliveryIds include
// the send's delivery id, then read to the turn boundary; events carrying only
// other deliveries are skipped.
describe('EveChatTransport — recorded eve 0.66.3 streams', () => {
  const live = liveStreams as unknown as Record<string, Recorded[]>

  function gated(events: Recorded[], gateAfter: number) {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    return {
      release,
      iterable: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < events.length; i++) {
            if (i === gateAfter) await gate
            yield events[i]
          }
        },
      },
    }
  }

  function transportFor(responses: Array<AsyncIterable<HandleMessageStreamEvent>>) {
    const { client, dispatches, cancel } = makeFakeClient((_d, i) => ({
      sessionId: 'wrun_01M3B1WXDTZJR01FD9C2V8F0P3',
      [Symbol.asyncIterator]: () => responses[i][Symbol.asyncIterator](),
    }))
    const persists: Array<{ body: { parts: Array<{ type: string; text?: string }>; usage: { events: Array<{ type: string }> } } }> = []
    /** Every write, the send-time user-message writes (onSend) included. */
    const writes: EvePersistBody[] = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async (a) => {
        writes.push(a.body)
        if (!a.body.onSend) persists.push(a as never)
      },
      createClient: () => client as never,
    })
    return { transport, dispatches, persists, writes, cancel }
  }
  const textOf = (chunks: UIMessageChunk[], type: 'text-delta' | 'reasoning-delta') =>
    chunks.filter((c) => c.type === type).map((c) => (c as { delta: string }).delta).join('')
  const second = () =>
    ({
      ...(sendOpts() as object),
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'steer' }] },
      ],
    }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

  it('reasoning/message appends are delta-only on 0.66.3 and accumulate into one reasoning part + one text part', async () => {
    const events = live.firstTurnWithReasoning
    const reasoningEvents = events.filter((e) => e.type === 'reasoning.appended')
    expect(reasoningEvents.length).toBeGreaterThan(1)
    for (const e of reasoningEvents) {
      expect(Object.keys((e as { data: object }).data).sort()).toEqual(['reasoningDelta', 'sequence', 'stepIndex', 'turnId'])
    }
    const completedReasoning = (events.find((e) => e.type === 'reasoning.completed') as { data: { reasoning: string } }).data.reasoning
    const completedMessage = (events.find((e) => e.type === 'message.completed') as { data: { message: string } }).data.message

    const { transport, persists } = transportFor([{ async *[Symbol.asyncIterator]() { yield* events } }])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    await new Promise((r) => setTimeout(r, 0))

    // Appending the deltas reproduces eve's own authoritative completed blocks.
    expect(textOf(chunks, 'reasoning-delta')).toBe(completedReasoning)
    expect(textOf(chunks, 'text-delta')).toBe(completedMessage)
    expect(persists).toHaveLength(1)
    expect(persists[0].body.parts.map((p) => p.type)).toEqual(['reasoning', 'text'])
  })

  it('steer folded into the SAME turn (recorded): the prior turn yields nothing past the steer point, the steering send renders the corrected reply once', async () => {
    const events = live.steerFoldedIntoSameTurn
    const [d1, d2] = deliveries(events)
    const turnIds = new Set(events.map((e) => (e as { data?: { turnId?: string } }).data?.turnId).filter(Boolean))
    expect(turnIds.size).toBe(1) // eve 0.57+: same turn id, no turn.cancelled
    expect(events.some((e) => e.type === 'turn.cancelled')).toBe(false)

    const r1 = gated(scopeToDelivery(events, d1), 1) // pause after turn.started
    const r2 = scopeToDelivery(events, d2)
    const { transport, dispatches, persists, writes } = transportFor([
      r1.iterable,
      { async *[Symbol.asyncIterator]() { yield* r2 } },
    ])
    const s1 = await transport.sendMessages(sendOpts())
    await new Promise((r) => setTimeout(r, 0))
    const s2 = await transport.sendMessages(second())
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatches).toHaveLength(2)
    r1.release()

    const c1 = await drain(s1)
    const c2 = await drain(s2)
    await new Promise((r) => setTimeout(r, 0))

    expect(textOf(c1, 'text-delta')).toBe('')
    expect(textOf(c2, 'text-delta')).toBe('OK')
    expect(c2[c2.length - 1].type).toBe('finish')
    // Only the steering turn rendered anything → one reply persist, one step.
    // The prior's own user message keeps its row: it was written when it was
    // sent (onSend). The steering message was not (it steered a running
    // reply): the reply's persist carries it.
    expect(persists).toHaveLength(1)
    expect(writes.filter((b) => b.onSend).map((b) => b.messageId)).toEqual(['m1'])
    const reply = persists[0].body as unknown as EvePersistBody
    expect(reply.role).toBe('assistant')
    expect(reply.userMessage?.messageId).toBe('m2')
    expect(reply.usage.events.filter((e) => e.type === 'step.completed')).toHaveLength(1)
  })

  it('ask_user HITL round-trip (recorded): park renders the picker, answerPermission resumes with the request’s own approve id + clientContext, the reply lands in the same bubble', async () => {
    const park = live.askUserApprovalPark
    const resume = live.askUserApprovalResume
    const request = (park.find((e) => e.type === 'input.requested') as unknown as {
      data: { requests: Array<{ requestId: string; action: { callId: string } }> }
    }).data.requests[0]
    expect(isInputRequest(request)).toBe(true)

    const { client, dispatches } = makeFakeClient((_d, i) => ({
      sessionId: 'wrun_01M3B28JYVATZTB9H719BS9MV6',
      async *[Symbol.asyncIterator]() { yield* (i === 0 ? park : resume) },
    }))
    const persists: Array<{ body: { parts: Array<{ type: string; state?: string; text?: string }> } }> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async (a) => { if (!a.body.onSend) persists.push(a as never) },
      createClient: () => client as never,
    })
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    let picker: { toolCallId: string; toolName: string } | undefined
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'tool-input-available' && value.toolName === 'ask_user') {
        picker = value as never
        break
      }
    }
    expect(picker?.toolCallId).toBe(request.action.callId)
    await new Promise((r) => setTimeout(r, 0))

    const answered = transport.answerPermission('chat-1', picker!.toolCallId, {
      'Do you prefer tea or coffee?': 'Tea',
    })
    const rest: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest.push(value)
    }
    await answered
    await new Promise((r) => setTimeout(r, 0))

    const respond = dispatches[1] as {
      kind: string
      inputResponses?: Array<{ requestId: string; optionId?: string }>
      options: { clientContext?: string }
    }
    expect(respond.kind).toBe('respond')
    expect(respond.inputResponses).toEqual([{ requestId: request.requestId, optionId: 'approve' }])
    expect(respond.options.clientContext).toContain('Tea')
    expect(textOf(rest, 'text-delta')).toContain('tea')
    expect(rest[rest.length - 1].type).toBe('finish')
    expect(persists).toHaveLength(1)
    const askPart = persists[0].body.parts.find((p) => p.type === 'dynamic-tool')
    expect(askPart?.state).toBe('output-available')
  })

  // Recorded on the CHAT-AGENT itself, driven live through this transport
  // (fixture _source). Live verdicts at recording time matched these replays:
  // one bubble per send, disjoint persisted text, persisted step.completed ==
  // the session's own step.completed count.
  it.each([
    ['chatAgentTransportSteerBeforeOutput', 3, '', 'OK.', [0, 1]],
    ['chatAgentTransportSteerAfterOutput', 6, '60 sixty', 'done', [1, 1]],
  ] as const)('chat-agent recorded steer (%s): each send renders only its own part; usage counted once', async (key, gateAfter, text1Contains, text2, steps) => {
    const events = live[key]
    const [d1, d2] = deliveries(events)
    const serverSteps = events.filter((e) => e.type === 'step.completed').length
    const r1 = gated(scopeToDelivery(events, d1), gateAfter)
    const r2 = scopeToDelivery(events, d2)
    const { transport, persists } = transportFor([
      r1.iterable,
      { async *[Symbol.asyncIterator]() { yield* r2 } },
    ])
    const s1 = await transport.sendMessages(sendOpts())
    await new Promise((r) => setTimeout(r, 0))
    const s2 = await transport.sendMessages(second())
    await new Promise((r) => setTimeout(r, 0))
    r1.release()
    const c1 = await drain(s1)
    const c2 = await drain(s2)
    await new Promise((r) => setTimeout(r, 0))

    expect(textOf(c1, 'text-delta')).toContain(text1Contains)
    expect(textOf(c1, 'text-delta')).not.toContain(text2)
    expect(textOf(c2, 'text-delta')).toBe(text2)
    expect(c1.filter((c) => c.type === 'start')).toHaveLength(1)
    expect(c2.filter((c) => c.type === 'start')).toHaveLength(1)
    expect(c2[c2.length - 1].type).toBe('finish')
    const persistedSteps = persists.map((p) => p.body.usage.events.filter((e) => e.type === 'step.completed').length)
    expect(persistedSteps.reduce((a, b) => a + b, 0)).toBe(serverSteps)
    // Same per-bubble split the live run persisted (the folded turn's first
    // bubble carries only reasoning, so zero steps). Persist order is async.
    expect([...persistedSteps].sort()).toEqual([...steps].sort())
  })

  it('steer that arrives after assistant output started (recorded): eve runs it as the NEXT turn; each send renders its own turn', async () => {
    const events = live.steerAfterAssistantOutputStartsNextTurn
    const [d1, d2] = deliveries(events)
    const r1 = gated(scopeToDelivery(events, d1), 3)
    const r2 = scopeToDelivery(events, d2)
    expect(r2.every((e) => !(e.meta.deliveryIds ?? []).includes(d1))).toBe(true)

    const { transport, persists } = transportFor([
      r1.iterable,
      { async *[Symbol.asyncIterator]() { yield* r2 } },
    ])
    const s1 = await transport.sendMessages(sendOpts())
    await new Promise((r) => setTimeout(r, 0))
    const s2 = await transport.sendMessages(second())
    r1.release()
    const c1 = await drain(s1)
    const c2 = await drain(s2)
    await new Promise((r) => setTimeout(r, 0))

    expect(textOf(c1, 'text-delta')).toContain('Node.js')
    expect(textOf(c2, 'text-delta')).toContain('Python')
    expect(textOf(c2, 'text-delta')).not.toContain('Node.js')
    expect(persists).toHaveLength(2)
    expect(persists.map((p) => p.body.usage.events.filter((e) => e.type === 'step.completed').length)).toEqual([1, 1])
  })

  // ── Recorded Stop (chat-agent, driven live through this transport) ──
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const firstTextIndex = (events: Recorded[]) => events.findIndex((e) => e.type === 'message.appended')
  const turnIdOf = (events: Recorded[], type: string) =>
    (events.find((e) => e.type === type) as unknown as { data: { turnId: string } }).data.turnId

  it('Stop mid-reply (recorded): cancels the recorded turn by id; eve ends it turn.cancelled → session.waiting with no step.completed', async () => {
    const events = live.chatAgentTransportStopMidReply
    const cancelledTurn = turnIdOf(events, 'turn.cancelled')
    expect(events.map((e) => e.type).slice(-2)).toEqual(['turn.cancelled', 'session.waiting'])
    expect(events.some((e) => e.type === 'step.completed')).toBe(false)

    const [d1] = deliveries(events)
    const scoped = scopeToDelivery(events, d1)
    const r1 = gated(scoped, firstTextIndex(scoped) + 1) // pause right after the first text
    const { transport, cancel } = transportFor([r1.iterable])
    const stop = new AbortController()
    const s1 = await transport.sendMessages({ ...(sendOpts() as object), abortSignal: stop.signal } as never)
    const reader = s1.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || value.type === 'text-delta') break
    }
    stop.abort()
    await tick()
    expect(cancel.mock.calls).toEqual([[{ turnId: cancelledTurn }]])

    r1.release()
    const rest: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest.push(value)
    }
    await tick()
    expect(rest.map((c) => c.type)).toEqual(['abort'])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('a recorded turn.cancelled reaching a LIVE turn (cancelled elsewhere) settles it gracefully: finish, not an error', async () => {
    const events = live.chatAgentTransportStopMidReply
    const { transport, persists } = transportFor([{ async *[Symbol.asyncIterator]() { yield* events } }])
    const chunks = await drain(await transport.sendMessages(sendOpts()))
    await tick()
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.slice(-2).map((c) => c.type)).toEqual(['finish-step', 'finish'])
    expect(textOf(chunks, 'text-delta').length).toBeGreaterThan(0)
    expect(persists).toHaveLength(1)
  })

  it('Stop on a steering send before its first event (recorded): the previous reply streams to its own turn.completed and only the NEW turn is cancelled, by id', async () => {
    const events = live.chatAgentTransportStopSteerBeforeFirstEvent
    const [d1, d2] = deliveries(events)
    const cancelledTurn = turnIdOf(events, 'turn.cancelled')
    const completedTurn = turnIdOf(events, 'turn.completed')
    expect(cancelledTurn).not.toBe(completedTurn)

    const scoped1 = scopeToDelivery(events, d1)
    const r1 = gated(scoped1, firstTextIndex(scoped1) + 1)
    const r2 = gated(scopeToDelivery(events, d2), 0) // nothing until released
    const { transport, dispatches, cancel } = transportFor([r1.iterable, r2.iterable])

    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    const c1: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      c1.push(value)
      if (value.type === 'text-delta') break
    }
    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(second() as object), abortSignal: stop.signal } as never)
    await tick()
    expect(dispatches).toHaveLength(2)
    stop.abort()
    await tick()
    expect(cancel).not.toHaveBeenCalled()
    expect((await drain(s2)).map((c) => c.type)).toContain('abort')

    r1.release()
    r2.release()
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      c1.push(value)
    }
    await tick()
    await tick()

    expect(textOf(c1, 'text-delta')).toContain('80 eighty')
    expect(c1[c1.length - 1].type).toBe('finish')
    expect(cancel.mock.calls).toEqual([[{ turnId: cancelledTurn }]])
  })

  it('Stop on a correction eve FOLDED into the running turn (recorded): cancels the SHARED turn by id — the previous reply\'s turn, which eve had already redirected to the correction', async () => {
    const events = live.chatAgentTransportStopFoldedSteer
    const [d1, d2] = deliveries(events)
    // The recording really is a fold: the correction's message.received is on
    // the previous reply's turn and carries both delivery ids; that one turn is
    // what eve cancelled, and it never completed.
    const previousTurn = turnIdOf(events, 'turn.started')
    const correction = events.find((e) => e.type === 'message.received' && e.meta.deliveryIds?.includes(d2))!
    expect((correction as unknown as { data: { turnId: string } }).data.turnId).toBe(previousTurn)
    expect(correction.meta.deliveryIds).toEqual([d1, d2])
    expect(turnIdOf(events, 'turn.cancelled')).toBe(previousTurn)
    expect(events.some((e) => e.type === 'turn.completed' || e.type === 'step.completed')).toBe(false)

    const scoped1 = scopeToDelivery(events, d1)
    const firstReasoning = scoped1.findIndex((e) => e.type === 'reasoning.appended')
    const r1 = gated(scoped1, firstReasoning + 1)
    const r2 = gated(scopeToDelivery(events, d2), 0) // nothing until released
    const { transport, dispatches, cancel, persists } = transportFor([r1.iterable, r2.iterable])

    const s1 = await transport.sendMessages(sendOpts())
    const reader1 = s1.getReader()
    const c1: UIMessageChunk[] = []
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      c1.push(value)
      if (value.type === 'reasoning-delta') break
    }
    const stop = new AbortController()
    const s2 = await transport.sendMessages({ ...(second() as object), abortSignal: stop.signal } as never)
    await tick()
    expect(dispatches).toHaveLength(2)
    stop.abort()
    await tick()
    expect(cancel).not.toHaveBeenCalled() // no turn id seen by the stopped send yet
    expect((await drain(s2)).map((c) => c.type)).toContain('abort')

    r1.release()
    r2.release()
    for (;;) {
      const { value, done } = await reader1.read()
      if (done) break
      c1.push(value)
    }
    await tick()
    await tick()

    // The previous send settled at the steer point: reasoning only, then finish.
    expect(textOf(c1, 'text-delta')).toBe('')
    expect(textOf(c1, 'reasoning-delta').length).toBeGreaterThan(0)
    expect(c1[c1.length - 1].type).toBe('finish')
    expect(persists).toHaveLength(1)
    // Stop cancelled exactly the shared turn, by id.
    expect(cancel.mock.calls).toEqual([[{ turnId: previousTurn }]])
  })

})

// ── A HITL respond starts a new eve turn → it needs a CURRENT run token ────────
//
// The chat-agent channel refuses a turn-starting request (create / send /
// respond) whose chat-run token is missing, expired or not this user's (403).
// Every send re-mints, but an ask_user picker can stay open past the token's
// 60-minute TTL — so answerPermission re-mints a token that is (nearly) expired
// before the respond, and sends the fresh one.
describe('EveChatTransport — a HITL respond re-mints a stale run token', () => {
  const tokenExpiring = (inMs: number, tag: string) =>
    `${Buffer.from(JSON.stringify({ conversationId: 'conv-1', exp: Date.now() + inMs, tag }), 'utf8').toString('base64url')}.sig-${tag}`

  const park = evInputRequested([
    {
      requestId: 'req-1',
      display: 'select',
      prompt: 'Which env?',
      action: {
        kind: 'tool-call',
        callId: 'call-auq',
        toolName: 'ask_user',
        input: { questions: [{ question: 'Which env?', header: 'Env', options: [{ label: 'A' }], multiSelect: false }] },
      },
    },
  ])

  function setup(mints: Array<() => Promise<{ token: string; conversationId: string }>>) {
    const mintArgs: Array<Record<string, unknown>> = []
    const { client, dispatches } = makeFakeClient((_d, i) =>
      makeResponse('wrun_ABC', i === 0 ? [park] : [evTextDone('ok'), evTurnDone()]),
    )
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt-token',
      mintRunToken: async (args) => {
        mintArgs.push(args as unknown as Record<string, unknown>)
        const next = mints.shift()
        if (!next) throw new Error('unexpected mint')
        return next()
      },
      registerEveSession: async () => {},
      createClient: () => client as never,
      persistTurn: async () => {},
    })
    return { transport, dispatches, mintArgs }
  }

  async function parkThenAnswer(transport: EveChatTransport) {
    const stream = await transport.sendMessages(sendOpts({ agentId: 'agent-7' }))
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || value.type === 'tool-input-available') break
    }
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'A' })
    void (async () => {
      for (;;) if ((await reader.read()).done) break
    })()
    await answered
  }

  it('a token that expires within the margin is re-minted (same conversation + agent) and the respond carries the FRESH token', async () => {
    const stale = tokenExpiring(30_000, 'stale')
    const fresh = tokenExpiring(60 * 60_000, 'fresh')
    const { transport, dispatches, mintArgs } = setup([
      async () => ({ token: stale, conversationId: 'conv-1' }),
      async () => ({ token: fresh, conversationId: 'conv-1' }),
    ])
    await parkThenAnswer(transport)
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond'])
    expect((dispatches[1].options.headers as Record<string, string>)['x-chat-run-token']).toBe(fresh)
    expect(mintArgs).toHaveLength(2)
    expect(mintArgs[1]).toMatchObject({ chatId: 'chat-1', conversationId: 'conv-1', agentId: 'agent-7' })
  })

  it('a token with plenty of life left is NOT re-minted; the respond carries it', async () => {
    const live = tokenExpiring(50 * 60_000, 'live')
    const { transport, dispatches, mintArgs } = setup([async () => ({ token: live, conversationId: 'conv-1' })])
    await parkThenAnswer(transport)
    expect(mintArgs).toHaveLength(1)
    expect((dispatches[1].options.headers as Record<string, string>)['x-chat-run-token']).toBe(live)
  })

  it('a failed re-mint (e.g. usage limit) sends no respond and leaves the picker answerable', async () => {
    const stale = tokenExpiring(10_000, 'stale')
    const { transport, dispatches } = setup([
      async () => ({ token: stale, conversationId: 'conv-1' }),
      async () => {
        throw Object.assign(new Error('Usage limit exceeded'), { status: 429 })
      },
      async () => ({ token: tokenExpiring(60 * 60_000, 'retry'), conversationId: 'conv-1' }),
    ])
    const stream = await transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || value.type === 'tool-input-available') break
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'A' })
    expect(dispatches.map((d) => d.kind)).toEqual(['create'])
    // Submit again: the mapping was restored, the re-mint now succeeds, the respond goes out.
    const answered = transport.answerPermission('chat-1', 'call-auq', { 'Which env?': 'A' })
    void (async () => {
      for (;;) if ((await reader.read()).done) break
    })()
    await answered
    expect(dispatches.map((d) => d.kind)).toEqual(['create', 'respond'])
  })

  it('runTokenExpiresAt reads the unverified exp; malformed → null (→ re-mint)', () => {
    const t = tokenExpiring(1000, 'x')
    expect(runTokenExpiresAt(t)).toBeGreaterThan(Date.now())
    expect(runTokenExpiresAt('tok.sig')).toBeNull()
    expect(runTokenExpiresAt('')).toBeNull()
  })
})

describe('EveChatTransport — conversation history survives a fresh handle (reload, Stop, loaded chat, restored tab)', () => {
  /** A fake client whose session records every message (string or UserContent) it is sent. */
  function historyClient(opts: { failSendOnce?: boolean } = {}) {
    const sent: Array<{ kind: 'create' | 'send'; message: unknown }> = []
    let failNext = !!opts.failSendOnce
    const session = {
      send: vi.fn(async (message: unknown) => {
        sent.push({ kind: 'send', message })
        if (failNext) {
          failNext = false
          throw new Error('session_not_active')
        }
        return makeResponse('wrun_prior', [evTextDone('ok'), evTurnDone()])
      }),
      respond: vi.fn(),
      cancel: vi.fn(async () => ({ status: 'accepted' })),
      stream: vi.fn(),
      state: { sessionId: 'wrun_prior', streamIndex: 0 },
    }
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push({ kind: 'create', message: input.message })
      return { response: makeResponse('wrun_new', [evTextDone('ok'), evTurnDone()]), session }
    })
    const attach = vi.fn(() => session)
    return { client: { sessions: { create, attach } }, sent, attach, create }
  }

  function transportWith(
    fake: ReturnType<typeof historyClient>,
    mintResult: { eveSessionId?: string | null; historyPrimer?: string | null },
    mintCalls: Array<{ wantHistory?: boolean }>,
    registered: string[] = [],
  ) {
    return new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async (args) => {
        mintCalls.push({ wantHistory: args.wantHistory })
        return {
          token: 'tok.sig',
          conversationId: 'conv-1',
          ...(args.wantHistory ? mintResult : { eveSessionId: mintResult.eveSessionId }),
        }
      },
      registerEveSession: async (a) => {
        registered.push(a.sessionId)
      },
      persistTurn: async () => {},
      createClient: () => fake.client as never,
    })
  }

  it("a chat with no live handle RE-ATTACHES to the conversation's registered session (no new session, no re-register)", async () => {
    const fake = historyClient()
    const mints: Array<{ wantHistory?: boolean }> = []
    const registered: string[] = []
    const transport = transportWith(fake, { eveSessionId: 'wrun_prior', historyPrimer: 'PRIMER' }, mints, registered)

    await drain(await transport.sendMessages(sendOpts()))

    expect(fake.attach).toHaveBeenCalledWith('wrun_prior')
    expect(fake.create).not.toHaveBeenCalled()
    expect(fake.sent).toEqual([{ kind: 'send', message: 'hello' }])
    expect(registered).toEqual([])
    expect(mints[0]).toEqual({ wantHistory: true })
  })

  it('asks for history only when there is no live handle; a follow-up turn on the live handle does not', async () => {
    const fake = historyClient()
    const mints: Array<{ wantHistory?: boolean }> = []
    const transport = transportWith(fake, { eveSessionId: 'wrun_prior' }, mints)
    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))
    expect(mints.map((m) => m.wantHistory)).toEqual([true, undefined])
  })

  it('after Stop, the next send continues the SAME eve session', async () => {
    const fake = historyClient()
    const transport = transportWith(fake, { eveSessionId: 'wrun_prior' }, [])
    const ac = new AbortController()
    const stream = await transport.sendMessages({ ...sendOpts(), abortSignal: ac.signal })
    ac.abort()
    await drain(stream).catch(() => {})
    await drain(await transport.sendMessages(sendOpts()))
    expect(fake.create).not.toHaveBeenCalled()
    expect(fake.attach.mock.calls.every((c) => (c as unknown[])[0] === 'wrun_prior')).toBe(true)
  })

  it('a conversation with messages but no eve session starts a NEW session whose first message carries the primer, once', async () => {
    const fake = historyClient()
    const registered: string[] = []
    const transport = transportWith(fake, { eveSessionId: null, historyPrimer: '<conversation-so-far>PRIOR</conversation-so-far>' }, [], registered)

    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))

    expect(fake.sent[0]).toEqual({ kind: 'create', message: '<conversation-so-far>PRIOR</conversation-so-far>\n\nhello' })
    expect(fake.sent[1]).toEqual({ kind: 'send', message: 'hello' })
    expect(registered).toEqual(['wrun_new'])
  })

  it('a registered session that refuses the turn falls back to a new, primed session and registers it', async () => {
    const fake = historyClient({ failSendOnce: true })
    const registered: string[] = []
    const transport = transportWith(fake, { eveSessionId: 'wrun_dead', historyPrimer: 'PRIMER' }, [], registered)

    const chunks = await drain(await transport.sendMessages(sendOpts()))

    expect(fake.sent.map((s) => s.kind)).toEqual(['send', 'create'])
    expect(fake.sent[1].message).toBe('PRIMER\n\nhello')
    expect(registered).toEqual(['wrun_new'])
    expect(chunks.some((c) => c.type === 'text-delta' || c.type === 'text-start' || c.type === 'finish')).toBe(true)
  })
})

describe('EveChatTransport — attachments reach the model', () => {
  it('a photo is named in the text with its storage_path, never sent as a file part (eve would provision a sandbox for one)', async () => {
    const sent: unknown[] = []
    const session = { send: vi.fn(), respond: vi.fn(), cancel: vi.fn(), stream: vi.fn(), state: {} }
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push(input.message)
      return { response: makeResponse('wrun_1', [evTurnDone()]), session }
    })
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
    })
    const opts = {
      ...sendOpts({
        systemContext: {
          chatFiles: [
            { storagePath: 'u-1/chat-uploads/a.png', fileName: 'shot.png', fileSize: 1000, mimeType: 'image/png' },
            { storagePath: 'u-1/chat-uploads/n.md', fileName: 'notes.md', fileSize: 10, mimeType: 'text/markdown' },
            { storagePath: 'u-1/chat-uploads/b.jpg', fileName: 'two\nlines".jpg', fileSize: 2000, mimeType: 'image/jpeg' },
            { storagePath: 42, fileName: 'broken.png', mimeType: 'image/png' },
          ],
        },
      }),
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [
            { type: 'text', text: 'what is in this screenshot?' },
            { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'https://x.supabase.co/storage/v1/object/sign/a.png?token=t' },
            { type: 'file', mediaType: 'text/markdown', filename: 'notes.md', url: 'https://x.supabase.co/storage/v1/object/sign/n.md?token=t' },
          ],
        },
      ],
    } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

    await drain(await transport.sendMessages(opts))

    // Text only: the signed URL (dead in an hour) never enters eve's history.
    expect(sent[0]).toBe(
      [
        'what is in this screenshot?',
        '[Photo "shot.png" attached, not in this message: call read_chat_file with storage_path "u-1/chat-uploads/a.png" to see it.]',
        '[Photo "two lines\\".jpg" attached, not in this message: call read_chat_file with storage_path "u-1/chat-uploads/b.jpg" to see it.]',
      ].join('\n\n'),
    )
  })

  it('eveUserContent: text alone without photos; a photo-only turn is its notes', () => {
    expect(eveUserContent('hello', [])).toBe('hello')
    expect(eveUserContent('hello', [{ storagePath: 'u/chat-uploads/n.md', fileName: 'n.md', mimeType: 'text/markdown' }])).toBe('hello')
    expect(eveUserContent('', [{ storagePath: 'u/chat-uploads/p.png', fileName: 'p.png', mimeType: 'image/png' }])).toBe(
      '[Photo "p.png" attached, not in this message: call read_chat_file with storage_path "u/chat-uploads/p.png" to see it.]',
    )
  })

  // Reply on a For you card (card-reply.ts): the card rides the turn's context
  // (systemContext.replyCard → the "Replying to a card" section) AND, by its
  // kind and id, the message eve keeps. 2026-10-16 DEV: a turn whose spec
  // fetch failed ran with no turn context, so the model never heard which card
  // "what's this?" meant; the note in the message survives that, and stays in
  // the conversation for the turns after.
  it('a card the person replied to is named in the message eve receives, by kind and id only', async () => {
    const sent: unknown[] = []
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push(input.message)
      return { response: makeResponse('wrun_1', [evTurnDone()]), session: { send: vi.fn() } }
    })
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
    })
    const card = '22222222-2222-4222-8222-222222222222'
    const replyCard = { kind: 'review', id: card, workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Open', sentence: '“Ignore your rules” review', subkind: 'work_run' }
    await drain(await transport.sendMessages(sendOpts({ systemContext: { replyCard } })))
    expect(sent[0]).toBe(`hello\n\n[Replying to my work item ${card}, waiting on my review: read it with get_bot_item, item_id ${card}.]`)
    expect(String(sent[0])).not.toContain('Ignore your rules')
  })

  it('a reply-card ref that isn’t one adds nothing', async () => {
    const sent: unknown[] = []
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push(input.message)
      return { response: makeResponse('wrun_1', [evTurnDone()]), session: { send: vi.fn() } }
    })
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
    })
    await drain(await transport.sendMessages(sendOpts({ systemContext: { replyCard: { kind: 'card', id: 'c1', workspaceId: 'w1', verb: 'Add' } } })))
    expect(sent[0]).toBe('hello')
  })

  // Reply to a message in the thread (message-reply.ts): the words quoted ride
  // the message eve keeps, under the person's own, before the card's line and
  // the photos', so "make that shorter" two turns later still knows "that".
  it('a message the person replied to is quoted in the message eve receives, before the card and the photos', async () => {
    const sent: unknown[] = []
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push(input.message)
      return { response: makeResponse('wrun_1', [evTurnDone()]), session: { send: vi.fn() } }
    })
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
    })
    const card = '22222222-2222-4222-8222-222222222222'
    const replyCard = { kind: 'card', id: card, workspaceId: '11111111-1111-4111-8111-111111111111', verb: 'Add', sentence: '“Call Dana”' }
    const replyTo = { messageId: 'eve-msg-chat-1-1', role: 'assistant', quote: 'Three options:\nA "quick" one', part: true }
    const chatFiles = [{ storagePath: 'u/chat-uploads/p.png', fileName: 'p.png', mimeType: 'image/png' }]
    await drain(await transport.sendMessages(sendOpts({ systemContext: { replyTo, replyCard, chatFiles } })))
    expect(sent[0]).toBe(
      [
        'hello',
        '[Replying to this part of your earlier message: "Three options:\\nA \\"quick\\" one"]',
        `[Replying to my card ${card}: read it with get_bot_item, item_id ${card}.]`,
        '[Photo "p.png" attached, not in this message: call read_chat_file with storage_path "u/chat-uploads/p.png" to see it.]',
      ].join('\n\n'),
    )
  })

  it('a reply to the person’s own message says so; a reply ref that isn’t one adds nothing', async () => {
    const sentFor = async (systemContext: Record<string, unknown>) => {
      const sent: unknown[] = []
      const create = vi.fn(async (input: { message: unknown }) => {
        sent.push(input.message)
        return { response: makeResponse('wrun_1', [evTurnDone()]), session: { send: vi.fn() } }
      })
      const transport = new EveChatTransport({
        mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
        registerEveSession: async () => {},
        persistTurn: async () => {},
        createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
      })
      await drain(await transport.sendMessages(sendOpts({ systemContext })))
      return sent[0]
    }
    expect(await sentFor({ replyTo: { messageId: 'm0', role: 'user', quote: 'Book the room' } })).toBe('hello\n\n[Replying to my own earlier message: "Book the room"]')
    expect(await sentFor({ replyTo: { messageId: 'bad id!', role: 'assistant', quote: 'x' } })).toBe('hello')
    expect(await sentFor({ replyTo: { messageId: 'm0', role: 'assistant', quote: '   ' } })).toBe('hello')
  })

  it('eveUserContent: the reply notes go first, under the words, then the photos', () => {
    const photo = { storagePath: 'u/chat-uploads/p.png', fileName: 'p.png', mimeType: 'image/png' }
    expect(eveUserContent('hi', [photo], ['[A]', '[B]'])).toBe(
      'hi\n\n[A]\n\n[B]\n\n[Photo "p.png" attached, not in this message: call read_chat_file with storage_path "u/chat-uploads/p.png" to see it.]',
    )
    expect(eveUserContent('', [], ['[A]'])).toBe('[A]')
    expect(eveUserContent('hi', [], [])).toBe('hi')
  })

  it('a text-only message is still sent as a plain string', async () => {
    const sent: unknown[] = []
    const create = vi.fn(async (input: { message: unknown }) => {
      sent.push(input.message)
      return { response: makeResponse('wrun_1', [evTurnDone()]), session: { send: vi.fn() } }
    })
    const transport = new EveChatTransport({
      mintRunToken: async () => ({ token: 't', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      persistTurn: async () => {},
      createClient: () => ({ sessions: { create, attach: vi.fn() } }) as never,
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(sent[0]).toBe('hello')
  })
})
