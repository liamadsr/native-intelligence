'use client'

/**
 * RunChatTransport — a `ChatTransport<UIMessage>` (AI SDK v6) that drives a work
 * run's follow-up chat through the run-chat proxy routes, translating W2's reduced
 * NDJSON vocabulary (@/lib/agent-run/run-chat-events → RunChatEvent) into the
 * `UIMessageChunk` stream `useChat` consumes. It exists so the canonical Cloud-run
 * surface (cloud-run-view.tsx, inside the action side panel) can render a work
 * run's follow-up conversation with the MAIN chat's components — chat-message.tsx,
 * the Tool chips, and the QuestionPicker — instead of the bespoke mini-chat
 * (run-follow-up-chat.tsx stays only on the standalone /account/agent-runs/[id]
 * page, which has no MainChatProvider and so cannot mount chat-message.tsx).
 *
 * ── Why a transport and not another bespoke reducer ──────────────────────────
 * chat-message.tsx renders a `UIMessage` (text parts + dynamic-tool parts +
 * an `ask_user` picker part). `useChat` assembles that `UIMessage` from a
 * `UIMessageChunk` stream. The proxy speaks a DIFFERENT, reduced vocabulary
 * (text-delta / tool(name-only) / question / user-message / done / error). This
 * transport is the single translation seam between the two — it mirrors
 * EveChatTransport's SHAPE (sendMessages returning a ReadableStream<UIMessageChunk>,
 * reconnectToStream → null, a custom answerPermission the host invokes by cast)
 * so the host wiring is the same pattern the main chat already uses.
 *
 * ── The reduced `tool` event carries a NAME ONLY ─────────────────────────────
 * W2's privacy fence strips tool inputs/outputs — a `tool` event is just
 * `{type:'tool', name}`. `useChat`'s assembler requires a paired
 * tool-input-available BEFORE any tool-output-available for the same callId, so
 * for each `tool` we mint a stable synthetic toolCallId (per-transport counter),
 * emit input-available (empty input) and IMMEDIATELY output-available (empty
 * output). chat-message.tsx then renders the Tool chip in its `result` (green
 * "used") state — never a perpetual pending spinner, since the proxy never tells
 * us when/whether the tool finished (it already ran server-side).
 *
 * ── A `question` holds the stream OPEN (HITL) ────────────────────────────────
 * A reduced `question` maps to a dynamic `ask_user` tool part (toolName 'ask_user',
 * input {questions}) so the SAME pendingQuestion scan + QuestionPicker the main
 * chat uses light up. On a question we CLOSE any open text block, emit the picker
 * part, remember requestId→{approveOptionId,denyOptionId} keyed by the part's
 * toolCallId, and DO NOT finish the stream. `answerPermission` (invoked by the
 * host when the user submits/skips) resolves that request, emits an
 * output-available for the picker part (so it flips to AnsweredQuestionsSummary),
 * POSTs the resume, and pumps the resumed reduced events into the still-open
 * stream — mirroring how EveChatTransport keeps a parked turn open.
 *
 * ── Errors ───────────────────────────────────────────────────────────────────
 * A reduced `error` with code 'BUSY' is a soft, non-fatal notice (the agent is
 * mid-turn on a double-send race): we surface it as an `error` chunk carrying the
 * softened copy so useChat's `error` state shows it, then close the stream. Any
 * other `error` (FAILED / a non-200) closes the stream with its message. A
 * non-200 POST rejects the returned stream's producer, which useChat surfaces as
 * its `error`.
 */

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import {
  readChatStream,
  type RunChatStreamEvent,
} from '@/components/agent-run/run-chat-stream'
import { BUSY_NOTICE } from '@/components/agent-run/run-chat-stream'
import type { RunChatQuestionPayload, RunChatUserFile } from '@/lib/agent-run/run-chat-events'
import { runChatRoute } from '@/lib/agent-run/run-chat-ref'

/** The clarifying-question tool name the QuestionPicker + pendingQuestion scan key on. */
const ASK_USER_TOOL_NAME = 'ask_user'

/** The run-chat proxy route for a run (POST = send/resume turn, GET = replay): a work
 *  run's, or a loop run's (`loop:` ids, bots v3 Phase 4; run-chat-ref.ts). */
function chatRoute(runId: string): string {
  return runChatRoute(runId)
}

/**
 * The eve `inputResponses` element the /chat POST forwards to `session.send`. An
 * approval-shaped request resolves by requestId + optionId (approve for an answer,
 * deny for a skip); the formatted answers ride as the follow-up `message` the model
 * reads (eve discards text on an approval response). Same choreography as
 * run-follow-up-chat's `InputResponse`.
 */
interface InputResponse {
  requestId: string
  optionId: string
}

/**
 * What the composer adds to a run-chat POST (bots v4, runChatTurnBody in
 * composer-state.ts): the picked skill, the uploads' storage facts and the
 * @-mentions. Passed through unchecked: the route parses and checks each
 * (run-chat-turn.ts) before the turn sees it.
 */
interface RunChatTurnExtrasBody {
  skillId?: string
  files?: unknown[]
  mentions?: Record<string, unknown>
}

/** The /chat POST body: the message, an answer to a park, and the composer's extras. */
type RunChatPostBody = { message: string; inputResponses?: InputResponse[] } & RunChatTurnExtrasBody

/**
 * The facts answerPermission needs to resume an open question, remembered by the
 * picker part's toolCallId. `payload` carries the eve requestId + approve/deny
 * option ids (taken off the request, never hardcoded); `questions` is what the
 * formatter renders into the follow-up message.
 */
interface OpenQuestion {
  payload: RunChatQuestionPayload
}

/** Injectable fetch (test seam); defaults to global fetch. */
type FetchFn = typeof fetch

export interface RunChatTransportOptions {
  /** Test seam: inject fetch. Defaults to the global. */
  fetchImpl?: FetchFn
}

/**
 * Per-open-turn stream state. A turn owns its OWN emit/close closures so a stale
 * event can never cross into a later turn (mirrors EveChatTransport's TurnState).
 * Unlike the eve transport there is no durable session token — each send is a
 * fresh POST — but a `question` keeps ONE turn's stream open across the
 * answerPermission resume POST, so the state must survive that gap.
 */
interface TurnState {
  messageId: string
  /** The open text block's id, or null when no text block is open. */
  textId: string | null
  started: boolean
  settled: boolean
  /** Monotonic counter for synthetic tool callIds within this turn. */
  toolSeq: number
  /**
   * The currently-open question (requestId + option ids + questions), keyed by the
   * picker part's synthetic toolCallId. Non-null while the stream is held open
   * waiting for an answer; answerPermission consumes it.
   */
  openQuestions: Map<string, OpenQuestion>
  emit: (chunk: UIMessageChunk) => void
  close: () => void
  fail: (err: Error) => void
}

export class RunChatTransport implements ChatTransport<UIMessage> {
  private runId: string
  private fetchImpl: FetchFn
  /** The one open turn (or null between turns). A question holds it open across resume. */
  private turn: TurnState | null = null
  /** Global synthetic-id salt so ids are unique across turns of this transport. */
  private idSalt = 0

  constructor(runId: string, opts: RunChatTransportOptions = {}) {
    this.runId = runId
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, abortSignal } = options
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const userText = lastUser ? extractText(lastUser) : ''

    // A REPLAYED final question is answered via a normal sendMessage whose body
    // carries the eve `inputResponses` (the host threads them there — there is no
    // live turn stream to route through answerPermission for a replayed part). A
    // plain follow-up send omits them.
    const inputResponses = readInputResponses(options)
    // What the full composer added (bots v4: the skill, the uploads, the
    // mentions), forwarded as-is: the route checks every one.
    const extras = readTurnExtras(options)

    const turn: TurnState = {
      messageId: this.nextId('run-msg'),
      textId: null,
      started: false,
      settled: false,
      toolSeq: 0,
      openQuestions: new Map(),
      emit: () => {},
      close: () => {},
      fail: () => {},
    }
    this.turn = turn

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const detach = () => {
          if (this.turn === turn) this.turn = null
        }
        turn.emit = (chunk) => {
          if (turn.settled) return
          try {
            controller.enqueue(chunk)
          } catch {
            /* stream already closed */
          }
        }
        turn.close = () => {
          if (turn.settled) return
          turn.settled = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          detach()
        }
        turn.fail = (err) => {
          if (turn.settled) return
          turn.settled = true
          try {
            controller.error(err)
          } catch {
            /* already closed */
          }
          detach()
        }

        // Abort → settle THIS turn (never a later one). No server cancel: the
        // parked session is untouched; the next send re-POSTs.
        abortSignal?.addEventListener(
          'abort',
          () => {
            if (turn.settled) return
            turn.emit({ type: 'abort' })
            turn.close()
          },
          { once: true },
        )
      },
      cancel: () => {
        turn.close()
      },
    })

    // Kick off the turn. A failure here settles the turn (the stream was already
    // returned), never rejects this promise.
    const body: RunChatPostBody = { message: userText, ...extras }
    if (inputResponses && inputResponses.length > 0) body.inputResponses = inputResponses
    void this.runSend(turn, body, abortSignal).catch((err) => {
      turn.fail(err instanceof Error ? err : new Error(String(err)))
    })

    return stream
  }

  /**
   * POST one turn (initial send or a question resume) to the /chat proxy and pump
   * its reduced NDJSON events into `turn`'s stream. Body is `{ message }` for a
   * plain send, `{ message, inputResponses:[…] }` for a question resume. On a
   * question park it returns WITHOUT closing the stream (the stream stays open for
   * answerPermission's resume); otherwise it closes on `done` / EOF.
   */
  private async runSend(
    turn: TurnState,
    body: RunChatPostBody,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (turn.settled || abortSignal?.aborted) return

    const res = await this.fetchImpl(chatRoute(this.runId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      ...(abortSignal ? { signal: abortSignal } : {}),
    })

    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
      const message =
        detail.code === 'BUSY'
          ? BUSY_NOTICE
          : detail.error || `The run agent could not respond (${res.status}).`
      // Surface as an error chunk so useChat's `error` state shows it, then close.
      this.ensureStarted(turn)
      turn.emit({ type: 'error', errorText: message })
      turn.close()
      return
    }
    if (!res.body) {
      this.ensureStarted(turn)
      turn.emit({ type: 'error', errorText: 'The run agent returned no response.' })
      turn.close()
      return
    }

    // Whether this send PARKED on a question (stream held open) — tracked so we
    // don't close/finish after EOF when a picker is awaiting its answer.
    let parked = false

    await readChatStream(res.body, (event) => {
      if (turn.settled) return
      const handled = this.onReducedEvent(turn, event)
      if (handled === 'parked') parked = true
    })

    // Stream ended. If a question is open, leave the turn OPEN for answerPermission.
    // Otherwise finish + close so useChat leaves `streaming`.
    if (turn.settled) return
    if (parked || turn.openQuestions.size > 0) return
    this.finish(turn)
  }

  /**
   * Translate ONE reduced event into UIMessageChunk(s) on the open turn. Returns
   * 'parked' when the event opened a question (the stream must stay open), else
   * undefined.
   */
  private onReducedEvent(
    turn: TurnState,
    event: RunChatStreamEvent,
  ): 'parked' | undefined {
    switch (event.type) {
      case 'text-delta': {
        if (!event.delta) return
        this.ensureStarted(turn)
        if (!turn.textId) {
          turn.textId = this.nextId('txt')
          turn.emit({ type: 'text-start', id: turn.textId })
        }
        turn.emit({ type: 'text-delta', id: turn.textId, delta: event.delta })
        return
      }

      case 'tool': {
        if (!event.name) return
        this.ensureStarted(turn)
        this.closeTextIfOpen(turn)
        // The reduced `tool` carries a NAME ONLY (privacy fence). Mint a stable
        // synthetic callId and emit input-available + IMMEDIATELY output-available
        // (empty objects) so the Tool chip renders in its 'result' (used) state —
        // never a perpetual pending spinner (the tool already ran server-side).
        const callId = `${turn.messageId}-tool-${turn.toolSeq++}`
        turn.emit({
          type: 'tool-input-available',
          toolCallId: callId,
          toolName: event.name,
          input: {},
          dynamic: true,
        })
        turn.emit({
          type: 'tool-output-available',
          toolCallId: callId,
          output: {},
          dynamic: true,
        })
        return
      }

      case 'question': {
        this.ensureStarted(turn)
        this.closeTextIfOpen(turn)
        // Surface the clarifying question as a dynamic `ask_user` tool part so the
        // host's pendingQuestion scan + QuestionPicker render it. Hold the stream
        // OPEN (no finish) and remember the eve HITL facts keyed by the part's
        // callId so answerPermission can resolve it.
        const payload = event.question
        const callId = `${turn.messageId}-q-${turn.toolSeq++}`
        turn.openQuestions.set(callId, { payload })
        turn.emit({
          type: 'tool-input-available',
          toolCallId: callId,
          toolName: ASK_USER_TOOL_NAME,
          // The picker reads input.questions.
          input: { questions: payload.questions },
          dynamic: true,
        })
        return 'parked'
      }

      case 'user-message':
        // Ignored on a LIVE send (the host rendered the user turn optimistically).
        // Only the replay loader (loadRunChatHistory) honours user-message.
        return

      case 'done': {
        // The turn boundary. If a question is open, keep the stream open (the
        // caller handles it); otherwise finish + close.
        if (turn.openQuestions.size > 0) return 'parked'
        this.finish(turn)
        return
      }

      case 'error': {
        this.ensureStarted(turn)
        this.closeTextIfOpen(turn)
        const message =
          event.code === 'BUSY' ? BUSY_NOTICE : event.message || 'The run session hit an error.'
        turn.emit({ type: 'error', errorText: message })
        turn.close()
        return
      }
    }
  }

  /** Emit start + start-step exactly once for a turn. */
  private ensureStarted(turn: TurnState): void {
    if (turn.started) return
    turn.started = true
    turn.emit({ type: 'start', messageId: turn.messageId })
    turn.emit({ type: 'start-step' })
  }

  /** Close the open text block if any. */
  private closeTextIfOpen(turn: TurnState): void {
    if (turn.textId) {
      turn.emit({ type: 'text-end', id: turn.textId })
      turn.textId = null
    }
  }

  /** Emit finish-step + finish and close the turn's stream. */
  private finish(turn: TurnState): void {
    if (turn.settled) return
    this.ensureStarted(turn)
    this.closeTextIfOpen(turn)
    turn.emit({ type: 'finish-step' })
    turn.emit({ type: 'finish' })
    turn.close()
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // A dropped turn re-sends (mirrors EveChatTransport). No reconnectable stream.
    return null
  }

  /**
   * Answer an open ask_user question over the run-chat proxy. `answers` maps each
   * question text → chosen label(s); a defined `response` (with empty answers) is a
   * skip / dismiss. Resolves the remembered question by toolCallId, flips the
   * picker part to output-available (so it renders AnsweredQuestionsSummary), POSTs
   * the resume (`{ message, inputResponses:[{requestId, optionId}] }`), and pumps
   * the resumed reduced events into the STILL-OPEN turn stream.
   *
   * Mirrors EveChatTransport.answerPermission's signature so the host calls it by
   * the same cast the main chat uses.
   */
  async answerPermission(
    _chatId: string,
    toolCallId: string,
    answers: Record<string, string>,
    response?: string,
  ): Promise<void> {
    const turn = this.turn
    if (!turn || turn.settled) {
      console.error('[run chat] answerPermission: no open turn', {
        runId: this.runId,
        toolCallId,
        hasTurn: !!turn,
        settled: turn?.settled,
      })
      return
    }
    const open = turn.openQuestions.get(toolCallId)
    if (!open) {
      console.error('[run chat] answerPermission: no open question for toolCallId', {
        runId: this.runId,
        toolCallId,
        openQuestions: [...turn.openQuestions.keys()],
      })
      return
    }

    // A skip / dismiss: chat-panel signals it with a defined `response` (empty
    // answers). Everything else is a genuine answer.
    const isSkip = response !== undefined && !Object.values(answers).some(Boolean)

    // Consume the question up front so a double-click can't POST twice (eve rejects
    // the second). Restored on a send failure so a genuine retry still works.
    turn.openQuestions.delete(toolCallId)

    // Flip the picker part to output-available so it renders the answered summary
    // (and drops out of the host's pendingQuestion scan → the picker unmounts).
    const output = isSkip ? { response: response ?? '' } : { answers }
    turn.emit({
      type: 'tool-output-available',
      toolCallId,
      output,
      dynamic: true,
    })

    const message = isSkip
      ? 'The user skipped this question.'
      : formatAnswers(open.payload, answers)
    const optionId = isSkip ? open.payload.denyOptionId : open.payload.approveOptionId
    const inputResponse: InputResponse = { requestId: open.payload.requestId, optionId }

    try {
      await this.runSend(turn, { message, inputResponses: [inputResponse] }, undefined)
    } catch (err) {
      // The resume POST failed. Restore the question so a retry can re-answer, and
      // surface the error (unless the turn already settled).
      turn.openQuestions.set(toolCallId, open)
      console.error('[run chat] answerPermission: resume send failed', {
        runId: this.runId,
        toolCallId,
        requestId: open.payload.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!turn.settled) {
        turn.emit({
          type: 'error',
          errorText: 'Could not send your answer — try again.',
        })
      }
    }
  }

  private nextId(prefix: string): string {
    this.idSalt += 1
    return `${prefix}-${this.runId}-${Date.now()}-${this.idSalt}`
  }
}

/**
 * Load a run's follow-up transcript from the /chat GET replay and fold it into
 * `UIMessage[]` for `useChat`'s initial `messages`. A text/tool run between
 * question/done boundaries is one assistant message; a `user-message` opens a user
 * message. Every question turn becomes a dynamic `ask_user` tool part:
 *   - an ALREADY-ANSWERED question (any turn with a later turn following it, since
 *     the parked session waits on the user after a question) → state
 *     'output-available' with { answered:true } so chat-message renders the inert
 *     AnsweredQuestionsSummary receipt (extractQuestionAnswers finds nothing
 *     structured → renders nothing, matching run-follow-up-chat's inert receipt);
 *   - a still-pending FINAL question → state 'input-available' so the host's
 *     pendingQuestion scan opens the picker. Its requestId/optionIds are returned
 *     in `pendingQuestions` so the caller can seed the transport to answer it.
 *
 * Returns the assembled messages plus a map of pending picker toolCallId →
 * question payload for the final unanswered question (empty when none).
 */
export interface LoadRunChatResult {
  messages: UIMessage[]
  /** Picker toolCallId → payload for a still-pending FINAL question (0 or 1 entry). */
  pendingQuestions: Map<string, RunChatQuestionPayload>
  /**
   * The route said no before it streamed, with its status and code: a real
   * refusal, one that holds until the run changes (isRunChatRefusal: someone
   * else started the run 403, no such run 404, not a workspace run 400, not
   * settled 409 NOT_TERMINAL, no session 409 NO_SESSION). Absent when it
   * replayed, or the read itself failed (`failed`).
   */
  refusal?: { status: number; code: string | null }
  /**
   * The read failed in passing (the network, an expired session 401, a server
   * error 5xx): nothing replayed, but nothing refused either. The caller keeps
   * the composer and asks again (the next send or mount).
   */
  failed?: true
}

/** Whether a non-OK answer from the chat route is a refusal that holds (not one that passes: 401, 5xx, …). */
export function isRunChatRefusal(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 409
}

export async function loadRunChatHistory(
  runId: string,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<LoadRunChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const empty: LoadRunChatResult = { messages: [], pendingQuestions: new Map() }

  let res: Response
  try {
    res = await fetchImpl(chatRoute(runId), { cache: 'no-store', credentials: 'include' })
  } catch {
    return { ...empty, failed: true }
  }
  if (!res.ok) {
    if (!isRunChatRefusal(res.status)) return { ...empty, failed: true }
    const detail = (await Promise.resolve(res.json?.()).catch(() => ({}))) as { code?: unknown } | undefined
    return { ...empty, refusal: { status: res.status, code: typeof detail?.code === 'string' ? detail.code : null } }
  }
  if (!res.body) return empty

  // Build a flat list of "raw turns" first, then finalize (which question is
  // pending depends on whether a later turn follows it).
  type RawAssistant = {
    role: 'assistant'
    text: string
    tools: string[]
    question?: RunChatQuestionPayload
  }
  type RawUser = { role: 'user'; text: string; files?: RunChatUserFile[] }
  type RawTurn = RawAssistant | RawUser

  const built: RawTurn[] = []
  let open: RawAssistant | null = null
  const openAssistant = (): RawAssistant => {
    if (!open) {
      open = { role: 'assistant', text: '', tools: [] }
      built.push(open)
    }
    return open
  }

  try {
    await readChatStream(res.body, (event) => {
      switch (event.type) {
        case 'text-delta':
          if (event.delta) openAssistant().text += event.delta
          return
        case 'tool':
          if (event.name) openAssistant().tools.push(event.name)
          return
        case 'question':
          openAssistant().question = event.question
          open = null // a question closes the assistant turn
          return
        case 'user-message':
          open = null
          built.push({ role: 'user', text: event.text, ...(event.files?.length ? { files: event.files } : {}) })
          return
        case 'done':
          open = null
          return
        case 'error':
          return
      }
    })
  } catch {
    return empty
  }

  // Drop empty assistant turns (a boundary with no content).
  const kept = built.filter(
    (t) => t.role === 'user' || t.text || t.tools.length > 0 || t.question,
  )
  const lastIndex = kept.length - 1

  const messages: UIMessage[] = []
  const pendingQuestions = new Map<string, RunChatQuestionPayload>()
  let seq = 0
  const mkId = (role: string) => `replay-${runId}-${role}-${seq++}`

  kept.forEach((turn, i) => {
    if (turn.role === 'user') {
      // The files that went with it, as chips: names and types only (no URL
      // reaches the replay; chat-message.tsx draws a file part without one as
      // a plain chip).
      const files = (turn.files ?? []).map(
        (f) => ({ type: 'file', mediaType: f.mediaType, ...(f.filename ? { filename: f.filename } : {}), url: '' }) as UIMessage['parts'][number],
      )
      messages.push({
        id: mkId('user'),
        role: 'user',
        parts: [...(turn.text ? [{ type: 'text', text: turn.text } as UIMessage['parts'][number]] : []), ...files],
      } as UIMessage)
      return
    }
    // Assistant turn: text part (if any), then tool parts (used), then the question.
    const parts: UIMessage['parts'] = []
    if (turn.text) parts.push({ type: 'text', text: turn.text } as UIMessage['parts'][number])
    turn.tools.forEach((name, ti) => {
      const callId = `${mkId('tool')}-${ti}`
      parts.push({
        type: 'dynamic-tool',
        toolName: name,
        toolCallId: callId,
        state: 'output-available',
        input: {},
        output: {},
      } as unknown as UIMessage['parts'][number])
    })
    if (turn.question) {
      const callId = `${mkId('q')}`
      // The parked session waits on the user after a question, so only the FINAL
      // renderable turn's question can still be pending; any earlier question was
      // already answered in a prior session → render it as an inert receipt
      // (output-available, no structured answers so AnsweredQuestionsSummary shows
      // nothing) and never re-arm its (stale) requestId.
      const isPending = i === lastIndex
      if (isPending) {
        parts.push({
          type: 'dynamic-tool',
          toolName: ASK_USER_TOOL_NAME,
          toolCallId: callId,
          state: 'input-available',
          input: { questions: turn.question.questions },
        } as unknown as UIMessage['parts'][number])
        pendingQuestions.set(callId, turn.question)
      } else {
        parts.push({
          type: 'dynamic-tool',
          toolName: ASK_USER_TOOL_NAME,
          toolCallId: callId,
          state: 'output-available',
          input: { questions: turn.question.questions },
          output: { answered: true },
        } as unknown as UIMessage['parts'][number])
      }
    }
    if (parts.length === 0) return
    messages.push({ id: mkId('assistant'), role: 'assistant', parts } as UIMessage)
  })

  return { messages, pendingQuestions }
}

/**
 * Read eve `inputResponses` off a sendMessage's `body` (the host threads them
 * there to answer a REPLAYED final question through a normal send). Returns
 * undefined when absent/malformed — a plain follow-up send carries no responses.
 */
function readInputResponses(options: { body?: unknown }): InputResponse[] | undefined {
  const body = options.body
  if (!body || typeof body !== 'object' || !('inputResponses' in body)) return undefined
  const raw = (body as { inputResponses?: unknown }).inputResponses
  if (!Array.isArray(raw)) return undefined
  const out: InputResponse[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const requestId = (r as { requestId?: unknown }).requestId
    const optionId = (r as { optionId?: unknown }).optionId
    if (typeof requestId === 'string' && typeof optionId === 'string') {
      out.push({ requestId, optionId })
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Read the composer's extras off a sendMessage's `body` (runChatTurnBody), by
 * shape only: a string skill id, an array of files, a mentions object.
 * Anything else is left out; the route checks what's kept. A plain follow-up
 * send (or an answer) carries none.
 */
function readTurnExtras(options: { body?: unknown }): RunChatTurnExtrasBody {
  const body = options.body
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  return {
    ...(typeof b.skillId === 'string' && b.skillId ? { skillId: b.skillId } : {}),
    ...(Array.isArray(b.files) && b.files.length > 0 ? { files: b.files } : {}),
    ...(isObject(b.mentions) ? { mentions: b.mentions } : {}),
  }
}

/** Flatten a UIMessage's text parts into a single string. */
function extractText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * Render the picker's answers map into the plain-text follow-up message the parked
 * model reads (mirrors run-follow-up-chat's formatAnswers + the server's
 * formatter). `answers` maps each question text → the chosen label(s).
 */
export function formatAnswers(
  payload: RunChatQuestionPayload,
  answers: Record<string, string>,
): string {
  const lines = (payload.questions ?? []).map((q) => {
    const label = (q.header?.trim() || q.question.trim() || 'Question').replace(/\s+/g, ' ')
    const value = (answers[q.question] ?? '').trim() || '(no selection)'
    return `- ${label}: ${value}`
  })
  return `Here are my answers:\n${lines.join('\n')}`
}
