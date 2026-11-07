/**
 * Synthetic eve stream events + a fake task-session response, for driving the
 * live-agent route and its eve adapter without an eve server.
 *
 * Event shapes follow eve 0.66.3's protocol (eve/dist/src/protocol/message.d.ts):
 * every event carries `meta { at, id }`; tool calls ride `actions.requested`
 * (kind 'tool-call', validated `input`), their results `action.result` (kind
 * 'tool-result', JSON `output`), streamed tool input `action.input.appended`.
 */
import type { MessageStreamEvent } from 'eve/client'

let seq = 0
const TURN = 'turn-1'

/**
 * One protocol variant WITHOUT its `meta` stamp. Every builder below is checked
 * against eve's own MessageStreamEvent union through this type, so a field
 * rename on the next eve bump breaks `tsc` instead of leaving every test green
 * while production misreads the stream. Only `meta` is added past the checker.
 */
type Unstamped<T extends MessageStreamEvent['type']> = Omit<Extract<MessageStreamEvent, { type: T }>, 'meta'>

/** A tool call's validated input / a tool result's output, as eve types them (JSON). */
type ToolCallInput = Extract<Unstamped<'actions.requested'>['data']['actions'][number], { kind: 'tool-call' }>['input']
type StepUsage = NonNullable<Unstamped<'step.completed'>['data']['usage']>
type ToolResultOutput = Extract<Unstamped<'action.result'>['data']['result'], { kind: 'tool-result' }>['output']

function stamp<T extends MessageStreamEvent['type']>(e: Unstamped<T>): MessageStreamEvent {
  seq++
  const meta = { at: new Date(Date.UTC(2026, 8, 25, 12, 0, seq)).toISOString(), id: `ev-${seq}` }
  return { ...e, meta } as Extract<MessageStreamEvent, { type: T }>
}

export const ev = {
  sessionStarted: () => stamp<'session.started'>({ type: 'session.started', data: {} }),
  turnStarted: () => stamp<'turn.started'>({ type: 'turn.started', data: { sequence: 0, turnId: TURN } }),
  stepStarted: (stepIndex: number) =>
    stamp<'step.started'>({ type: 'step.started', data: { modelId: 'deepseek/deepseek-v4-flash', sequence: 0, stepIndex, turnId: TURN } }),
  stepCompleted: (
    stepIndex: number,
    finishReason: 'stop' | 'tool-calls' | 'length' = 'stop',
    usage: StepUsage = { inputTokens: 100, outputTokens: 10 },
    generationId?: string,
  ) =>
    stamp<'step.completed'>({
      type: 'step.completed',
      data: {
        finishReason,
        sequence: 0,
        stepIndex,
        turnId: TURN,
        usage,
        ...(generationId ? { providerMetadata: { gateway: { generationId } } } : {}),
      },
    }),
  toolCall: (stepIndex: number, callId: string, toolName: string, input: ToolCallInput) =>
    stamp<'actions.requested'>({
      type: 'actions.requested',
      data: { actions: [{ kind: 'tool-call', callId, toolName, input }], sequence: 0, stepIndex, turnId: TURN },
    }),
  toolResult: (stepIndex: number, callId: string, toolName: string, output: ToolResultOutput, isError = false) =>
    stamp<'action.result'>({
      type: 'action.result',
      data: {
        result: { kind: 'tool-result', callId, toolName, output, ...(isError ? { isError: true } : {}) },
        sequence: 0,
        stepIndex,
        status: isError ? 'failed' : 'completed',
        turnId: TURN,
      },
    }),
  inputDelta: (stepIndex: number, callId: string, toolName: string, inputTextDelta: string) =>
    stamp<'action.input.appended'>({ type: 'action.input.appended', data: { callId, inputTextDelta, sequence: 0, stepIndex, toolName, turnId: TURN } }),
  text: (stepIndex: number, messageDelta: string) =>
    stamp<'message.appended'>({ type: 'message.appended', data: { messageDelta, sequence: 0, stepIndex, turnId: TURN } }),
  messageCompleted: (stepIndex: number, message: string, finishReason: 'stop' | 'tool-calls' = 'stop') =>
    stamp<'message.completed'>({ type: 'message.completed', data: { finishReason, message, sequence: 0, stepIndex, turnId: TURN } }),
  turnCompleted: () => stamp<'turn.completed'>({ type: 'turn.completed', data: { sequence: 0, turnId: TURN } }),
  turnCancelled: () => stamp<'turn.cancelled'>({ type: 'turn.cancelled', data: { sequence: 0, turnId: TURN } }),
  sessionCompleted: () => stamp<'session.completed'>({ type: 'session.completed' }),
  sessionWaiting: () =>
    stamp<'session.waiting'>({ type: 'session.waiting', data: { continuationToken: 'ct', wait: 'next-user-message' } }),
  sessionFailed: (code = 'MODEL_ERROR', message = 'boom') =>
    stamp<'session.failed'>({ type: 'session.failed', data: { code, message, sessionId: 'sess-1' } }),
}

/** A complete, successful one-step turn with no tool calls. */
export function quietTurn(): MessageStreamEvent[] {
  return [
    ev.sessionStarted(),
    ev.turnStarted(),
    ev.stepStarted(0),
    ev.messageCompleted(0, 'Nothing new.'),
    ev.stepCompleted(0, 'stop'),
    ev.turnCompleted(),
    ev.sessionCompleted(),
  ]
}

export interface FakeTaskResponse extends AsyncIterable<MessageStreamEvent> {
  sessionId: string
  cancel: () => Promise<{ status: string }>
  /** How many times cancel() was called. */
  cancelled: () => number
}

/**
 * A MessageResponse stand-in over a fixed event list. `hangAfter` (an index)
 * makes the stream stop yielding after that many events and wait forever, to
 * exercise the step-ceiling wind-down and aborts. `onCancel` can append events
 * (e.g. turn.cancelled) once cancel() is called.
 */
export function fakeTaskResponse(
  events: MessageStreamEvent[],
  opts: { hangAfter?: number; afterCancel?: MessageStreamEvent[]; sessionId?: string } = {},
): FakeTaskResponse {
  let cancels = 0
  let release: (() => void) | null = null
  /** Resolves once cancel() has been called (immediately if it already was). */
  const cancelledSignal = () =>
    new Promise<void>((r) => {
      if (cancels > 0) r()
      else release = r
    })
  async function* hang(): AsyncGenerator<MessageStreamEvent> {
    await cancelledSignal()
    if (!opts.afterCancel) await new Promise(() => {})
    for (const e of opts.afterCancel ?? []) yield e
  }
  return {
    sessionId: opts.sessionId ?? 'sess-1',
    cancelled: () => cancels,
    cancel: async () => {
      cancels++
      release?.()
      return { status: 'cancelled' }
    },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (opts.hangAfter === i) {
          yield* hang()
          return
        }
        yield events[i]
      }
      if (opts.hangAfter !== undefined && opts.hangAfter >= events.length) yield* hang()
    },
  }
}
