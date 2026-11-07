/**
 * The reduced NDJSON event vocabulary for a work run's follow-up chat + question
 * park (Loops v3 interactive work runs — docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * ── Why a REDUCED vocabulary (a privacy fence, not a convenience) ────────────
 * The follow-up-chat route is a SERVER-SIDE PROXY into a parked eve work-agent
 * session. eve's raw `HandleMessageStreamEvent` union embeds tool INPUTS verbatim
 * (`actions.requested[].input`, `action.result` outputs, the run token nowhere but
 * still — the raw stream is untrusted for the browser), so it must NEVER reach the
 * client. This reducer is the ONE translation seam: it forwards only
 *   - assistant text deltas (`text-delta`)
 *   - the USER's own follow-up message (`user-message`) — see the LIVE-vs-REPLAY
 *     contract below
 *   - tool NAMES (`tool`) — never the tool's input arguments
 *   - a QuestionPicker-shaped payload when the agent asks (`question`)
 *   - the turn boundary (`done`) and failures (`error`)
 * and drops everything else (reasoning, step/session lifecycle, usage, subagent
 * internals). W3 (the chat UI) imports {@link RunChatEvent} and renders from these
 * shapes alone; it can never see a raw eve event, a run token, or the internal
 * secret. This is the module the design doc names as W2-owned; keep the event
 * shapes stable — W3 depends on them.
 *
 * ── The `user-message` event and its LIVE-vs-REPLAY contract ─────────────────
 * eve's durable stream records every user turn as a `message.received` event
 * (`data.message` = the user's own text — verified in eve dist
 * protocol/message.d.ts `MessageReceivedStreamEvent`). The reducer emits it
 * UNCONDITIONALLY as `{type:'user-message', text}` on BOTH the POST live stream
 * and the GET replay. The consuming UI (W3/F3) distinguishes the two contexts:
 *   - LIVE POST turn: the UI already rendered the user's message optimistically
 *     when it sent, so it IGNORES the streamed echo (no duplicate bubble).
 *   - GET replay: the UI has no optimistic turns, so it USES the event to
 *     reconstruct the user bubble — without it, a reloaded transcript is a
 *     disconnected agent monologue (assistant replies with no prompts between).
 * The text is the user's OWN already-known message — no tool inputs, no PII from
 * elsewhere — so it is safe through the privacy fence.
 *
 * ── The reducer is a pure function over ONE event ────────────────────────────
 * {@link reduceStreamEvent} maps a single eve event to zero-or-more reduced
 * events (a `message.completed`/`step.completed`/`session.waiting` maps to none;
 * an `actions.requested` with N tool calls maps to N `tool` events). The route
 * (POST proxy / GET replay) iterates the eve stream and flushes each reduced
 * event as an NDJSON line. Keeping it pure + per-event makes the translation
 * table directly unit-testable without an eve mount.
 */
import type {
  ActionsRequestedStreamEvent,
  HandleMessageStreamEvent,
  InputRequest,
} from 'eve/client'
import type { WorkRunQuestion, AskUserAnswer, PendingInput } from '@/lib/agent-run/types'
import { parseAttachedFileNote } from './run-chat-attachments'

/**
 * Re-export the canonical question-park shapes (types.ts, W1-owned) from this
 * module so the interaction surfaces (the respond route + W3's question section)
 * import them alongside {@link RunChatEvent} from one place. `AskUserAnswer` is
 * `{ question, answer }` — the picker collapses its selection(s) into one answer
 * string before submitting; the resume driver formats them into the follow-up
 * message the model reads.
 */
export type { AskUserAnswer, PendingInput }

/**
 * One eve action request. `RuntimeActionRequest` isn't re-exported from
 * `eve/client`, so derive it from the public `actions.requested` event's
 * `data.actions` element type — same shape, no reach into eve internals.
 */
type ActionRequest = ActionsRequestedStreamEvent['data']['actions'][number]

/**
 * How the restored history a reopened run chat's first message carries
 * begins (run-chat-reopen.ts: a chat whose eve session expired continues in a
 * new one). It is that message's first part, the app's own, and the replay
 * leaves it out (reduceStreamEvent), so a reload shows the person's words
 * only and a later reopen never restores one history inside another.
 */
export const RUN_CHAT_PRIMER_HEADING = '## Restored history of this chat'

/** Whether a message part is a reopened chat's restored history (RUN_CHAT_PRIMER_HEADING). */
export function isRunChatPrimerText(text: string): boolean {
  return text.startsWith(RUN_CHAT_PRIMER_HEADING)
}

/**
 * The work-agent's ask tool name (agents/work-agent/tools/request_user_input.ts,
 * W1-owned). Deliberately NOT `ask_user` — that name is read-shaped-special-cased
 * in the tool registry. An `input.requested` whose action targets THIS tool is the
 * mid-run question the design surfaces as a `question` reduced event; any other
 * `input.requested` (a bare approval eve might surface) is dropped from the reduced
 * stream (a follow-up chat has no other HITL path in v1).
 */
export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input'

/**
 * One clarifying question, QuestionPicker-shaped. Re-exported from the canonical
 * `WorkRunQuestion` (types.ts, W1-owned) so the reduced `question` event and
 * `pending_input.questions` carry the identical shape and W3 imports one type.
 */
export type RunChatQuestion = WorkRunQuestion

/** The `question` reduced event's payload — the ask tool's input, plus the eve
 *  HITL facts the client's answer must echo back to resolve the approval park
 *  (requestId + the approve/deny option ids — eve will not release an
 *  approval-shaped request without its own optionId; the answer TEXT rides as
 *  the send's `message`, mirroring the resume driver's choreography). The ids
 *  are eve control identifiers ('approve'/'deny'), not content — safe to
 *  forward through the privacy fence. */
export interface RunChatQuestionPayload {
  requestId: string
  approveOptionId: string
  denyOptionId: string
  questions: RunChatQuestion[]
}

/**
 * A file the user attached to a follow-up message (bots v4: the full
 * composer): its name and type only, never a URL, path or bytes, so a reload
 * shows which files went with the message, as chips. A run chat's message
 * names each file in a text note (run-chat-attachments.ts: no file part ever
 * reaches the agent); a file part, should one ever be there, reads the same.
 */
export interface RunChatUserFile {
  filename?: string
  mediaType: string
}

/**
 * The reduced event vocabulary streamed to the browser as NDJSON. A strict,
 * closed union — the browser renders from THIS alone, never a raw eve event.
 *
 *  - `text-delta`   — one assistant text fragment (append to the live bubble).
 *  - `user-message` — the USER's own follow-up message text. Ignored during the
 *                     live POST stream (already rendered optimistically); used on
 *                     GET replay to rebuild the user turns. See the contract above.
 *  - `tool`         — the model called a tool; carries its NAME only (never input).
 *  - `question`     — the agent asked a mid-turn clarifying question (render the picker).
 *  - `done`         — the turn reached its boundary (park / completion); stream ends.
 *  - `error`        — the turn/session failed, or the send hit a busy session.
 */
export type RunChatEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'user-message'; text: string; files?: RunChatUserFile[] }
  | { type: 'tool'; name: string }
  | { type: 'question'; question: RunChatQuestionPayload }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: 'BUSY' | 'FAILED' }

/**
 * Map one eve action-request to the tool NAME the reduced `tool` event carries,
 * or null for a control-plane action with no user-visible name. Mirrors
 * run-work-eve.ts's log-line naming but yields the bare name (no formatting).
 *
 *  - tool-call        → the tool's own name (the ask tool is filtered out by the
 *                       caller so it renders as a `question`, not a `tool` line).
 *  - subagent-call    → the subagent's display name.
 *  - remote-agent-call→ the remote agent's display name.
 *  - load-skill       → null (control-plane; not surfaced as a tool line).
 */
export function toolNameForAction(action: ActionRequest): string | null {
  switch (action.kind) {
    case 'tool-call':
      return action.toolName || null
    case 'subagent-call':
      return action.subagentName || action.name || 'subagent'
    case 'remote-agent-call':
      return action.remoteAgentName || action.name || 'agent'
    case 'load-skill':
      return null
    default:
      return null
  }
}

/**
 * Extract the QuestionPicker payload from an `input.requested` request that
 * targets the ask tool. Returns null when the request isn't the ask tool or its
 * input isn't question-shaped (a bare approval, a malformed input) — the caller
 * drops those from the reduced stream.
 */
export function questionPayloadForRequest(
  request: InputRequest,
): RunChatQuestionPayload | null {
  if (request.action?.toolName !== REQUEST_USER_INPUT_TOOL_NAME) return null
  const input = request.action.input as { questions?: unknown } | undefined
  const rawQuestions = input?.questions
  if (!Array.isArray(rawQuestions)) return null
  const questions: RunChatQuestion[] = []
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue
    const qq = q as Record<string, unknown>
    const question = typeof qq.question === 'string' ? qq.question : ''
    const header = typeof qq.header === 'string' ? qq.header : ''
    const multiSelect = qq.multiSelect === true
    const rawOptions = Array.isArray(qq.options) ? qq.options : []
    const options: { label: string; description?: string }[] = []
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue
      const oo = o as Record<string, unknown>
      if (typeof oo.label !== 'string') continue
      options.push({
        label: oo.label,
        ...(typeof oo.description === 'string' ? { description: oo.description } : {}),
      })
    }
    if (!question) continue
    questions.push({ question, header, options, multiSelect })
  }
  if (questions.length === 0) return null
  // Read the approval option ids off the request itself (never hardcoded
  // literals) — the same discipline as the dispatcher's extractPendingInput
  // (run-work-eve.ts, Trap #2: a schema tweak must not desync the resume).
  const opts = request.options
  const approveOptionId =
    opts?.find((o) => o?.id === 'approve')?.id ?? opts?.[0]?.id ?? 'approve'
  // eve 0.32.0 renamed the negative approval verb 'deny' → 'cancel'; 0.47.7 emits
  // [{id:'approve'},{id:'cancel'}]. Accept either id (and fall back to 'cancel')
  // so the resume echoes a verb eve's resolveApprovalOutcome still recognizes.
  const denyOptionId =
    opts?.find((o) => o?.id === 'cancel' || o?.id === 'deny')?.id ?? opts?.[1]?.id ?? 'cancel'
  return { requestId: request.requestId, approveOptionId, denyOptionId, questions }
}

/**
 * Reduce ONE eve stream event to zero-or-more browser-safe reduced events. Pure:
 * no side effects, no accumulated state — the caller flushes the returned events
 * as NDJSON lines in order. The full translation table (verified against eve's
 * `HandleMessageStreamEvent` union):
 *
 *   message.appended       → [{text-delta}]     (empty delta → [])
 *   message.received       → [{user-message}]   (the user's own turn text; live UI ignores, replay uses)
 *   actions.requested      → [{tool} …]          (one per named action; ask tool + control-plane dropped)
 *   input.requested        → [{question} …]      (only ask-tool requests; others dropped)
 *   turn.completed         → [{done}]            (the turn boundary — park or completion)
 *   turn.cancelled         → [{done}]            (protocol 19: cancellation ends the turn, NOT a failure)
 *   session.completed      → [{done}]            (belt: a completed session also ends the stream)
 *   turn.failed            → [{error, FAILED}]
 *   step.failed            → [{error, FAILED}]
 *   session.failed         → [{error, FAILED}]
 *   everything else        → []                  (reasoning, step/session lifecycle,
 *                                                 message.completed, action.result,
 *                                                 subagent internals, usage, waiting)
 *
 * NOTE: `session.waiting` is the park boundary but is NOT mapped to `done` — the
 * `turn.completed` that PRECEDES it (observed live: actions.requested →
 * step.completed → input.requested → turn.completed → session.waiting) is the
 * boundary the client uses. Mapping both would double-emit `done`. `action.result`
 * is intentionally dropped: it carries tool OUTPUT (potential PII / verbatim
 * inputs) and the client only needs the tool NAME (already emitted at request).
 */
export function reduceStreamEvent(event: HandleMessageStreamEvent): RunChatEvent[] {
  switch (event.type) {
    case 'message.appended': {
      const delta = event.data.messageDelta
      return delta ? [{ type: 'text-delta', delta }] : []
    }
    case 'message.received': {
      // The user's own follow-up turn text. Emitted unconditionally; the live
      // POST UI ignores it (already rendered optimistically), the GET replay
      // uses it to rebuild user turns. A message that carried files (bots v4)
      // has structured parts: the person's words first, then a note per file
      // (run-chat-attachments.ts), which becomes the file's name and type, a
      // chip (never its storage path). A file part reads the same (never its
      // URL). Otherwise `data.message` is the flattened text summary (no tool
      // inputs). Safe through the privacy fence either way.
      //
      // A reopened chat's first message (run-chat-reopen.ts) leads with the
      // restored history, a part of its own: the app's words, never the
      // person's, so it never shows. The person's words are the part after it.
      const parts = event.data.parts
      if (Array.isArray(parts) && (parts.length > 1 || parts.some((p) => p?.type === 'file'))) {
        const first = parts[0]
        const primed = parts.length > 1 && first?.type === 'text' && typeof first.text === 'string' && isRunChatPrimerText(first.text)
        const own = primed ? parts.slice(1) : parts
        const texts: string[] = []
        const files: RunChatUserFile[] = []
        own.forEach((p, i) => {
          if (p?.type === 'text' && typeof p.text === 'string') {
            // The first part is the person's words, whatever they say.
            const note = i > 0 ? parseAttachedFileNote(p.text) : null
            if (note) files.push({ mediaType: note.mediaType, ...(note.filename ? { filename: note.filename } : {}) })
            else texts.push(p.text)
          } else if (p?.type === 'file' && typeof p.mediaType === 'string') {
            files.push({ mediaType: p.mediaType, ...(typeof p.filename === 'string' && p.filename ? { filename: p.filename } : {}) })
          }
        })
        if (files.length > 0) return [{ type: 'user-message', text: texts.join('\n'), files }]
        // `data.message` flattens the history in too: the person's words alone.
        if (primed) return texts.join('\n').trim() ? [{ type: 'user-message', text: texts.join('\n') }] : []
      }
      const text = event.data.message
      return typeof text === 'string' && text.trim() ? [{ type: 'user-message', text }] : []
    }
    case 'actions.requested': {
      const out: RunChatEvent[] = []
      for (const action of event.data.actions) {
        // The ask tool surfaces as a `question` on input.requested, not a tool line.
        if (action.kind === 'tool-call' && action.toolName === REQUEST_USER_INPUT_TOOL_NAME) {
          continue
        }
        const name = toolNameForAction(action)
        if (name) out.push({ type: 'tool', name })
      }
      return out
    }
    case 'input.requested': {
      const out: RunChatEvent[] = []
      for (const request of event.data.requests) {
        const payload = questionPayloadForRequest(request)
        if (payload) out.push({ type: 'question', question: payload })
      }
      return out
    }
    case 'turn.completed':
    case 'turn.cancelled':
    case 'session.completed':
      return [{ type: 'done' }]
    case 'turn.failed':
    case 'step.failed':
    case 'session.failed':
      return [{ type: 'error', message: reduceFailureMessage(event), code: 'FAILED' }]
    default:
      return []
  }
}

/** The human-readable message for a failure event, clamped so a raw provider
 *  error can't balloon the reduced stream (and never leaks structured details). */
function reduceFailureMessage(event: HandleMessageStreamEvent): string {
  if (
    event.type === 'turn.failed' ||
    event.type === 'step.failed' ||
    event.type === 'session.failed'
  ) {
    const message = event.data.message
    if (typeof message === 'string' && message.trim()) return message.slice(0, 500)
  }
  return 'The run session hit an error.'
}

/** Encode one reduced event as an NDJSON line (`<json>\n`) for the wire. */
export function encodeRunChatEvent(event: RunChatEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * What one turn said, read on the SERVER from its reduced events (bots v4
 * Phase A3: the main agent's relay, src/lib/bots/bot-relay.ts, runs a turn on
 * a run's parked session and keeps the bot's reply instead of streaming it to
 * a browser). The same vocabulary the run chat streams, so the relay reads
 * exactly what the person would see in that chat, and nothing more (no tool
 * inputs or outputs).
 */
export interface RunChatReply {
  /**
   * The turn's last reply: the text it wrote after its last tool call or
   * question (a turn that says "on it", acts, then reports, keeps the
   * report), else the last text it wrote before them. Empty when it wrote
   * none.
   */
  text: string
  /** The tools it called, by name, in order. */
  tools: string[]
  /** What it asked (a work run's request_user_input), one line per question. */
  questions: string[]
  /** The turn reached its boundary (`done`): it finished, or was cancelled and stopped. */
  ended: boolean
  /** The turn failed (`error`): its generic message. */
  error?: string
}

/**
 * Collect a turn's reply from its reduced events, in order. Pure: the relay
 * calls it on whatever it has read, a whole turn or one cut short. A
 * `user-message` (the turn's own message echoed back) is never a reply.
 */
export function readRunChatReply(events: readonly RunChatEvent[]): RunChatReply {
  const segments: string[] = []
  const tools: string[] = []
  const questions: string[] = []
  let current = ''
  let ended = false
  let error: string | undefined
  const close = () => {
    if (current.trim()) segments.push(current.trim())
    current = ''
  }
  for (const event of events) {
    switch (event.type) {
      case 'text-delta':
        current += event.delta
        break
      case 'tool':
        close()
        tools.push(event.name)
        break
      case 'question':
        close()
        for (const q of event.question.questions) questions.push(q.question)
        break
      case 'done':
        ended = true
        break
      case 'error':
        error = event.message
        break
      default:
        break
    }
  }
  close()
  return { text: segments.at(-1) ?? '', tools, questions, ended, ...(error !== undefined ? { error } : {}) }
}

/** One message of a run chat's history, as the person saw it. */
export interface RunChatHistoryMessage {
  /** `person`: what was sent into the chat (a relayed message too); `agent`: what the run's agent wrote. */
  from: 'person' | 'agent'
  text: string
}

/**
 * A run chat's messages, oldest first, from its reduced events (a whole
 * replay, or a stretch of one): what the person sent (with the names of the
 * files they attached) and what the agent wrote, one message per turn, its
 * questions included. The same vocabulary the chat streams, so nothing the
 * person couldn't see (no tool inputs or outputs) and never a restored
 * history (the reducer drops it). Pure; run-chat-reopen.ts reads the last few
 * into a reopened chat's primer.
 */
export function readRunChatHistory(events: readonly RunChatEvent[]): RunChatHistoryMessage[] {
  const out: RunChatHistoryMessage[] = []
  let current = ''
  const close = () => {
    if (current.trim()) out.push({ from: 'agent', text: current.trim() })
    current = ''
  }
  for (const event of events) {
    switch (event.type) {
      case 'user-message': {
        close()
        const names = (event.files ?? []).map((f) => f.filename ?? f.mediaType)
        const text = [event.text.trim(), ...(names.length > 0 ? [`(attached: ${names.join(', ')})`] : [])].filter(Boolean).join('\n')
        if (text) out.push({ from: 'person', text })
        break
      }
      case 'text-delta':
        current += event.delta
        break
      case 'question':
        current += `${current.trim() ? '\n' : ''}${event.question.questions.map((q) => `[asked: ${q.question}]`).join('\n')}`
        break
      case 'done':
      case 'error':
        close()
        break
      default:
        break
    }
  }
  close()
  return out
}
