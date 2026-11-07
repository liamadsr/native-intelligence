/**
 * The ONE mapping from an eve chat turn's stream events to the UIMessage
 * parts the chat renders and `chat_messages` stores (A4 slice 5).
 *
 * Two readers turn a chat-agent turn into a message:
 *   - the browser transport (src/lib/chat/eve/eve-chat-transport.ts),
 *     which also streams AI SDK chunks into useChat as it goes, and
 *   - the server's home-turn writer (src/lib/chat/home-turn-server.ts), which
 *     reads a turn nobody is watching and persists it.
 * Both run {@link applyEveTurnEvent}, so a turn written by the server is the
 * same message the browser would have written (text, reasoning, tool parts
 * with their outputs or errors, HITL request parts). A recorded-turn test
 * pins it (src/lib/chat/__tests__/eve-turn-parts.test.ts).
 *
 * It can't use the AI SDK's readUIMessageStream: that is a value import from
 * 'ai' outside the tripwire's allow-set (src/lib/ai/__tests__/
 * eve-everywhere-tripwire.test.ts), and adding it is a founder decision.
 *
 * Pure apart from the sink: the state is plain data the caller owns (the
 * transport's TurnState is a structural superset of {@link EveTurnPartsState}),
 * and every side effect (a chunk for useChat, the HITL bookkeeping, closing
 * the stream) goes through {@link EveTurnPartsSink}.
 */
import type { HandleMessageStreamEvent, InputRequest } from 'eve/client'
import type { UIMessageChunk } from 'ai'
import { EVE_WRITTEN_METADATA_KEY, type EveMessagePart } from './eve-message-writer'
import { stripModelOnlyToolFields, truncateToolOutput } from '@/lib/chat/eve/tool-output-truncation'

/** The chat-agent's rich clarifying-question tool (agents/chat-agent/tools/ask_user.ts). */
export const ASK_USER_TOOL_NAME = 'ask_user'

/**
 * How a reply from one of the chat's own eve turns starts its id (the
 * transport's newReplyId; the session-limit card tells a turn's reply from a
 * report written into the thread by it).
 */
export const EVE_REPLY_ID_PREFIX = 'eve-msg-'

/** The error a tool part takes when its turn failed before its result came back. */
export const UNRETURNED_TOOL_ERROR = 'No tool result was received before this chat run failed.'

/** What the reducer reads and writes. The transport's TurnState carries all of it. */
export interface EveTurnPartsState {
  /** The assistant message's id, stamped on the `start` chunk. */
  messageId: string
  /** The accumulated parts: the message as rendered and stored. */
  parts: EveMessagePart[]
  /** Whether the `start` chunk went out. */
  started: boolean
  textId: string | null
  textClosed: boolean
  reasoningId: string | null
  reasoningClosed: boolean
  /** Call ids already announced as a tool part (never announced twice). */
  announcedTools: Set<string>
  /** Call id → its part's index in `parts`. */
  toolPartIndex: Map<string, number>
  /** HITL request ids announced and not yet answered. */
  openInputRequests: Set<string>
}

/** The reducer's side effects. Every hook is optional except none: a server read passes a no-op emit. */
export interface EveTurnPartsSink {
  /** One AI SDK chunk, in order (useChat assembles the same message from them). */
  emit: (chunk: UIMessageChunk) => void
  /**
   * A NEW HITL request (deduped on its id), called before its tool part is
   * announced: the transport records how to answer it.
   */
  onInputRequest?: (request: InputRequest) => void
  /** The turn reported a failure: open tool parts were already settled as errors. */
  onFailed?: (message: string) => void
  /** The turn reached its end (completed with nothing parked, or cancelled): finish chunks already went out. */
  onFinished?: (how: 'completed' | 'cancelled') => void
  /**
   * An ask_user this turn already answered: its answers, which stand as the
   * part's output instead of eve's internal "answers arrive next" note.
   */
  answeredOutput?: (callId: string) => unknown
}

/** A fresh state for an assistant message with this id. */
export function createEveTurnPartsState(messageId: string): EveTurnPartsState {
  return {
    messageId,
    parts: [],
    started: false,
    textId: null,
    textClosed: false,
    reasoningId: null,
    reasoningClosed: false,
    announcedTools: new Set(),
    toolPartIndex: new Map(),
    openInputRequests: new Set(),
  }
}

/** A JSON-safe copy of the state (Inngest step outputs are JSON). */
export interface EveTurnPartsSnapshot {
  messageId: string
  parts: EveMessagePart[]
  started: boolean
  textId: string | null
  textClosed: boolean
  reasoningId: string | null
  reasoningClosed: boolean
  announcedTools: string[]
  toolPartIndex: Array<[string, number]>
  openInputRequests: string[]
}

export function snapshotEveTurnParts(state: EveTurnPartsState): EveTurnPartsSnapshot {
  return {
    messageId: state.messageId,
    parts: structuredClone(state.parts),
    started: state.started,
    textId: state.textId,
    textClosed: state.textClosed,
    reasoningId: state.reasoningId,
    reasoningClosed: state.reasoningClosed,
    announcedTools: [...state.announcedTools],
    toolPartIndex: [...state.toolPartIndex],
    openInputRequests: [...state.openInputRequests],
  }
}

export function restoreEveTurnParts(snapshot: EveTurnPartsSnapshot): EveTurnPartsState {
  return {
    messageId: snapshot.messageId,
    parts: structuredClone(snapshot.parts),
    started: snapshot.started,
    textId: snapshot.textId,
    textClosed: snapshot.textClosed,
    reasoningId: snapshot.reasoningId,
    reasoningClosed: snapshot.reasoningClosed,
    announcedTools: new Set(snapshot.announcedTools),
    toolPartIndex: new Map(snapshot.toolPartIndex),
    openInputRequests: new Set(snapshot.openInputRequests),
  }
}

/**
 * The tool name an action's part shows, or null for a control-plane action
 * with no result the model reads. Every action kind that later yields an
 * action.result the model reads must be announced as a tool part FIRST:
 * useChat's assembler throws "No tool invocation found for tool call ID" if
 * an output chunk arrives for a call id it never saw an input for. That covers
 * tool-call AND the runtime-owned kinds (subagent-call, remote-agent-call,
 * load-skill). Read structurally by kind so we don't couple to eve's exact
 * exported action types.
 */
export function resultProducingActionName(action: {
  kind?: string
  toolName?: string
  subagentName?: string
}): string | null {
  switch (action.kind) {
    case 'tool-call':
      return action.toolName || 'tool'
    case 'subagent-call':
      return action.subagentName || 'subagent'
    case 'remote-agent-call':
      return action.subagentName || 'remote-agent'
    case 'load-skill':
      return 'load-skill'
    default:
      return null
  }
}

/**
 * Announce one tool call: a tool-input-available chunk and a dynamic-tool part
 * in input-available state (the shape useChat assembles and the DB stores).
 * A call id already announced is left alone.
 */
export function announceToolInput(
  state: EveTurnPartsState,
  emit: (chunk: UIMessageChunk) => void,
  callId: string,
  toolName: string,
  input: unknown,
): void {
  if (state.announcedTools.has(callId)) return
  state.announcedTools.add(callId)
  emit({ type: 'tool-input-available', toolCallId: callId, toolName, input, dynamic: true })
  state.toolPartIndex.set(callId, state.parts.length)
  state.parts.push({ type: 'dynamic-tool', toolName, toolCallId: callId, state: 'input-available', input })
}

/** The call id a HITL request's tool part takes. */
export function inputRequestCallId(request: InputRequest): string {
  return request.action?.callId || (request.action?.toolName === ASK_USER_TOOL_NAME ? `auq-${request.requestId}` : `input-${request.requestId}`)
}

/**
 * Surface one HITL request as a tool part: an `ask_user` request renders the
 * rich picker (toolName 'ask_user', its `{ questions }` input); any other
 * request (a confirmation, a select/text question) a tool part under its own
 * tool name. Returns the part's call id. A call id already announced is left
 * alone.
 */
export function announceInputRequest(
  state: EveTurnPartsState,
  emit: (chunk: UIMessageChunk) => void,
  request: InputRequest,
): string {
  const callId = inputRequestCallId(request)
  if (state.announcedTools.has(callId)) return callId
  const toolName = request.action?.toolName
  if (toolName === ASK_USER_TOOL_NAME) {
    announceToolInput(state, emit, callId, ASK_USER_TOOL_NAME, request.action?.input ?? { questions: [] })
  } else {
    announceToolInput(state, emit, callId, toolName || ASK_USER_TOOL_NAME, request.action?.input ?? { prompt: request.prompt, options: request.options })
  }
  return callId
}

/**
 * A runtime-reported failure ends the turn: its unresolved calls never got a
 * result, so each open tool part becomes an output-error. Settled outputs are
 * left alone (a background admission receipt may represent real work that
 * continues after the parent fails).
 */
export function failOpenToolParts(state: EveTurnPartsState, emit: (chunk: UIMessageChunk) => void): void {
  for (const [toolCallId, index] of state.toolPartIndex) {
    const part = state.parts[index]
    if (!part || (part.state !== 'input-available' && part.state !== 'input-streaming')) continue
    state.parts[index] = { ...part, state: 'output-error', errorText: UNRETURNED_TOOL_ERROR }
    emit({ type: 'tool-output-error', toolCallId, errorText: UNRETURNED_TOOL_ERROR, dynamic: true })
  }
}

/** Close an open reasoning block, then an open text block. */
export function closeOpenBlocks(state: EveTurnPartsState, emit: (chunk: UIMessageChunk) => void): void {
  closeReasoningIfOpen(state, emit)
  closeTextIfOpen(state, emit)
}

function ensureStarted(state: EveTurnPartsState, emit: (chunk: UIMessageChunk) => void): void {
  if (state.started) return
  state.started = true
  // The stable message id + the eve_written discriminant: `start.messageId`
  // becomes the message's top-level id (→ ui_message_id for the persist
  // dedup), and `messageMetadata` merges into message.metadata so the client
  // autosave (isServerWritten) SKIPS this born-saved turn.
  emit({ type: 'start', messageId: state.messageId, messageMetadata: { [EVE_WRITTEN_METADATA_KEY]: true } })
  emit({ type: 'start-step' })
}

function closeTextIfOpen(state: EveTurnPartsState, emit: (chunk: UIMessageChunk) => void): void {
  if (state.textId && !state.textClosed) {
    emit({ type: 'text-end', id: state.textId })
    state.textClosed = true
  }
  state.textId = null
}

// Mirrors closeTextIfOpen exactly — called at every point that one is, PLUS
// the moment visible text starts (reasoning always precedes the answer it
// belongs to, never overlaps it).
function closeReasoningIfOpen(state: EveTurnPartsState, emit: (chunk: UIMessageChunk) => void): void {
  if (state.reasoningId && !state.reasoningClosed) {
    emit({ type: 'reasoning-end', id: state.reasoningId })
    state.reasoningClosed = true
  }
  state.reasoningId = null
}

/**
 * Append a streamed text delta onto the OPEN text part (the last part, pushed
 * empty when the block opened). Defensive: if the tail isn't a text part, a
 * fresh one opens so the delta is never lost from the projection.
 */
function appendText(state: EveTurnPartsState, delta: string): void {
  const tail = state.parts[state.parts.length - 1]
  if (tail && tail.type === 'text') tail.text = `${(tail.text as string) ?? ''}${delta}`
  else state.parts.push({ type: 'text', text: delta })
}

/** Same shape as appendText, for the OPEN reasoning part. */
function appendReasoning(state: EveTurnPartsState, delta: string): void {
  const tail = state.parts[state.parts.length - 1]
  if (tail && tail.type === 'reasoning') tail.text = `${(tail.text as string) ?? ''}${delta}`
  else state.parts.push({ type: 'reasoning', text: delta })
}

/** Apply one stream event. See the module header. */
export function applyEveTurnEvent(state: EveTurnPartsState, event: HandleMessageStreamEvent, sink: EveTurnPartsSink): void {
  const emit = sink.emit
  switch (event.type) {
    // Streaming reasoning ("thinking") deltas, ahead of `message.appended` for
    // the same step, surfaced as the AI SDK's native reasoning part.
    case 'reasoning.appended': {
      const delta = event.data.reasoningDelta
      if (!delta) return
      ensureStarted(state, emit)
      if (!state.reasoningId) {
        state.reasoningId = `rsn-${Date.now()}`
        state.reasoningClosed = false
        emit({ type: 'reasoning-start', id: state.reasoningId })
        state.parts.push({ type: 'reasoning', text: '' })
      }
      emit({ type: 'reasoning-delta', id: state.reasoningId, delta })
      appendReasoning(state, delta)
      return
    }

    // Streaming assistant text deltas. Real text closes the reasoning block at once.
    case 'message.appended': {
      const delta = event.data.messageDelta
      if (!delta) return
      ensureStarted(state, emit)
      closeReasoningIfOpen(state, emit)
      if (!state.textId) {
        state.textId = `txt-${Date.now()}`
        state.textClosed = false
        emit({ type: 'text-start', id: state.textId })
        state.parts.push({ type: 'text', text: '' })
      }
      emit({ type: 'text-delta', id: state.textId, delta })
      appendText(state, delta)
      return
    }

    // A finalized assistant text block (interim completions before a tool call
    // close it too; the next delta opens a fresh one).
    case 'message.completed': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      return
    }

    // Actions the model requested, streamed before execution: every
    // result-producing kind is announced as a tool part first.
    case 'actions.requested': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      for (const action of event.data.actions) {
        const name = resultProducingActionName(action)
        if (name === null) continue
        announceToolInput(state, emit, action.callId, name, action.input)
      }
      return
    }

    // An action returned. Results the model reads (authored tools + subagents)
    // become output-available, or output-error when eve marked them failed. A
    // result whose request we never saw announces a synthetic input first.
    case 'action.result': {
      const { result } = event.data
      if (result.kind !== 'tool-result' && result.kind !== 'subagent-result') return
      if (!state.announcedTools.has(result.callId)) {
        const name = result.kind === 'subagent-result' ? result.subagentName || 'subagent' : result.toolName || 'tool'
        announceToolInput(state, emit, result.callId, name, {})
      }
      const idx = state.toolPartIndex.get(result.callId)
      // An ask_user this turn already answered keeps the person's answers.
      const answered = sink.answeredOutput?.(result.callId)

      // A failed tool rides eve's `isError` flag with the error as `output`:
      // the AI SDK's native error state, bounded like any output. Never for an
      // answered ask_user (the answers won).
      if (result.isError === true && answered === undefined) {
        const errorText = truncateToolOutput(
          typeof result.output === 'string'
            ? result.output
            : result.output === undefined
              ? 'Tool call failed.'
              : JSON.stringify(result.output),
        )
        emit({ type: 'tool-output-error', toolCallId: result.callId, errorText, dynamic: true })
        if (idx !== undefined && state.parts[idx]) state.parts[idx] = { ...state.parts[idx], state: 'output-error', errorText }
        return
      }

      // Bounded at the boundary: the model read the FULL result server-side;
      // this copy exists only for display + the stored projection. An
      // expertise pack the chat-agent attached is the model's alone.
      const output = truncateToolOutput(answered ?? stripModelOnlyToolFields(result.output))
      emit({ type: 'tool-output-available', toolCallId: result.callId, output, dynamic: true })
      if (idx !== undefined && state.parts[idx]) state.parts[idx] = { ...state.parts[idx], state: 'output-available', output }
      return
    }

    // A preliminary snapshot from a running tool generator: a workflow tool's
    // `yield` (eve emit-workflow-tool-run-report-step.js), today the main
    // chat's `helpers` progress (A4 slice 3: "2 of 3 done"). Projected as the
    // AI SDK's preliminary tool output, so the part shows it while the call
    // runs and the final action.result replaces it (useChat clears
    // `preliminary` on that chunk). It never enters the accumulated parts:
    // the stored history keeps only the final result, and a turn that fails
    // mid-run still errors the call (failOpenToolParts reads them).
    case 'action.partial': {
      const { result } = event.data
      if (result.kind !== 'tool-result' || result.isError === true) return
      ensureStarted(state, emit)
      if (!state.announcedTools.has(result.callId)) announceToolInput(state, emit, result.callId, result.toolName || 'tool', {})
      emit({
        type: 'tool-output-available',
        toolCallId: result.callId,
        output: truncateToolOutput(stripModelOnlyToolFields(result.output)),
        dynamic: true,
        preliminary: true,
      })
      return
    }

    // HITL pause: each NEW request becomes a tool part (the picker / approval
    // rail). The turn is not closed: it is answered over the same session.
    case 'input.requested': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      for (const request of event.data.requests) {
        if (state.openInputRequests.has(request.requestId)) continue
        state.openInputRequests.add(request.requestId)
        sink.onInputRequest?.(request)
        announceInputRequest(state, emit, request)
      }
      return
    }

    case 'turn.failed':
    case 'step.failed': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      failOpenToolParts(state, emit)
      sink.onFailed?.(event.data.message || `chat turn failed (${event.type})`)
      return
    }

    // A settled reply — EXCEPT on a HITL park: eve completes the turn ledger
    // entry even when the session parks on an open input request, so a parked
    // turn stays open until the resumed turn completes with nothing open.
    case 'turn.completed': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      if (state.openInputRequests.size > 0) return
      emit({ type: 'finish-step' })
      emit({ type: 'finish' })
      sink.onFinished?.('completed')
      return
    }

    // Cancellation is not failure: settle gracefully, whatever was parked.
    case 'turn.cancelled': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      emit({ type: 'finish-step' })
      emit({ type: 'finish' })
      sink.onFinished?.('cancelled')
      return
    }

    case 'session.failed': {
      ensureStarted(state, emit)
      closeOpenBlocks(state, emit)
      failOpenToolParts(state, emit)
      sink.onFailed?.('chat session failed')
      return
    }

    default:
      // session.started, turn.started, step.*, message.received, subagent.*,
      // compaction.*, authorization.*, session.waiting/completed: no part.
      return
  }
}

/** The parts a whole recorded turn reduces to (no chunks, no HITL bookkeeping). */
export function reduceEveTurnParts(messageId: string, events: Iterable<HandleMessageStreamEvent>): EveMessagePart[] {
  const state = createEveTurnPartsState(messageId)
  const sink: EveTurnPartsSink = { emit: () => {} }
  for (const event of events) applyEveTurnEvent(state, event, sink)
  return state.parts
}

/** The reply's visible text: its text parts, joined. */
export function eveTurnText(parts: readonly EveMessagePart[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
