/**
 * A stored chat turn as flywheel evidence (./types.ts ChatTurnEvidence): the
 * person's request, the reply's opening, the tool path and the skills it
 * loaded, built from `chat_messages` rows (`ui_message` jsonb) on the server.
 * The feedback route and the sweep both build it here, never from text a
 * client sent.
 *
 * The stored parts are the ones src/lib/chat/eve-turn-parts.ts writes:
 *   - text parts `{ type: 'text', text }`, joined for the reply;
 *   - tool parts `{ type: 'dynamic-tool', toolName, toolCallId, state, input,
 *     output | errorText }` (and the AI SDK's static `tool-<name>` parts from
 *     the client autosave, same fields). A call failed when its state is
 *     `output-error` (eve's isError: a thrown tool, an INPUT_INVALID refusal)
 *     or its output says `success: false` (REPEATED_FAILURE, a tool's own
 *     refusal);
 *   - the code: the chat-agent's spec client throws
 *     `"<tool>: <error> [<CODE>] — <details>"` (agents/chat-agent/lib/
 *     spec-client.ts), so the first `[CODE]` in errorText, else the output's
 *     `code` (src/lib/chat/tool-repeat-breaker.ts: `{ success: false, code:
 *     'REPEATED_FAILURE' }`).
 *   - skills load through the chat-agent's own `load_skill` tool, input
 *     `{ skill }` (agents/chat-agent/tools/workspace_tools.ts); its output
 *     names the skill it matched.
 *
 * No mail: saved mail tool OUTPUTS are already pointers (mail-tool-scrub.ts),
 * and outputs are never kept here anyway; a mail tool's INPUT can carry a
 * body or subject the agent wrote, so those fields are dropped from it. And a
 * turn that touched mail (a mail tool, or any output the scrub marked
 * `scrubbed: 'mail'`: a search's email rows, a contact's recent threads, a
 * mail card) keeps no reply: the reply would retell the mail, and Dial8 staff
 * read this evidence at /admin/evals. The request and the tool path stay.
 *
 * A turn nobody typed (a home turn the server started, a live agent's own
 * nudge: SERVER_STARTED_KINDS) has no request of its own: the closest earlier
 * message is the person's to some other turn, so it is never read, and the
 * request says what started the turn instead.
 *
 * A nudge also carries POINTERS, never the meeting's words (no mail text is
 * kept, and meeting text gets the same treatment: staff read this): its kind,
 * its capture, when it was shown and the person's goal for the call
 * (nudgePointers). The capture and the goal are read only when someone rates
 * (loadChatTurnEvidence), never on the live path.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HOME_TURN_KIND } from '@/lib/chat/home-turn'
import { findMeetingGoalForCapture } from '@/lib/meetings/meeting-goal'
import { clipJson, clipList, clipText } from './record'
import { FLYWHEEL_LIMITS, type ChatTurnEvidence, type TurnToolStep } from './types'

/** The codes the sweep turns into a candidate. */
export const CHAT_FAILURE_CODES = ['REPEATED_FAILURE', 'INPUT_INVALID'] as const
export type ChatFailureCode = (typeof CHAT_FAILURE_CODES)[number]

/** A `chat_messages` row as the builders read it. */
export interface StoredChatMessage {
  role: string
  ui_message: unknown
  ui_message_id?: string | null
  created_at?: string | null
}

/** What a turn gives the row: its evidence and its columns. */
export interface ChatTurnBuild {
  evidence: ChatTurnEvidence
  /** The skills the turn loaded (eval_candidate.skill_slugs). */
  skillSlugs: string[]
  /** The tools it called, first call order, each once (eval_candidate.tools). */
  tools: string[]
}

type Part = Record<string, unknown> & { type?: unknown }

const LOAD_SKILL_TOOLS = new Set(['load_skill', 'load-skill'])

/** Fields of a tool input that can hold mail text an agent wrote (a draft's body, a subject). */
const MAIL_INPUT_FIELDS = new Set(['body', 'body_text', 'body_html', 'html', 'subject', 'snippet', 'preview', 'text', 'content', 'message'])
const MAIL_TOOL_RE = /(mail|draft|reply|forward)/i

/** `metadata.kind` of the live agent's nudge row (src/lib/live-agent/tools.ts). */
export const NUDGE_KIND = 'say_to_user'

/**
 * `metadata.kind` of an assistant message the agent wrote with nobody typing:
 * a server-written home turn (src/lib/chat/home-turn.ts) and the live agent's
 * say_to_user nudge (src/lib/live-agent/tools.ts).
 */
export const SERVER_STARTED_KINDS: ReadonlySet<string> = new Set([HOME_TURN_KIND, NUDGE_KIND])

/** What only the database knows about a nudge: its capture and the call's goal. */
export interface NudgeContext {
  captureId?: string | null
  meetingGoalId?: string | null
}

function partsOf(message: unknown): Part[] {
  if (!message || typeof message !== 'object') return []
  const parts = (message as { parts?: unknown }).parts
  return Array.isArray(parts) ? (parts.filter((p) => p && typeof p === 'object') as Part[]) : []
}

/** A part's tool name, or null when it is not a tool part. */
function toolNameOf(part: Part): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' && part.toolName ? part.toolName : 'tool'
  if (typeof part.type === 'string' && part.type.startsWith('tool-') && part.type !== 'tool-invocation') return part.type.slice(5) || 'tool'
  return null
}

/** The message's visible text: its text parts, joined. */
export function messageText(message: unknown): string {
  return partsOf(message)
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n\n')
}

function metadataOf(message: unknown): Record<string, unknown> | null {
  const meta = message && typeof message === 'object' ? (message as { metadata?: unknown }).metadata : null
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null
}

/**
 * What started a turn nobody typed (SERVER_STARTED_KINDS), as its request:
 * the home turn's reason, or the nudge. Null for an ordinary turn.
 */
export function serverStartedRequest(message: unknown): string | null {
  const meta = metadataOf(message)
  const kind = meta?.kind
  if (typeof kind !== 'string' || !SERVER_STARTED_KINDS.has(kind)) return null
  if (kind === HOME_TURN_KIND) {
    const reason = typeof meta?.reason === 'string' && meta.reason ? meta.reason : 'unknown'
    return `(nobody typed this: a home turn the server started, reason ${clipText(reason, 40)})`
  }
  return '(nobody typed this: a nudge the live agent sent on its own)'
}

/** Whether a stored message is the live agent's nudge (`metadata.kind = 'say_to_user'`). */
export function isNudgeMessage(message: unknown): boolean {
  return metadataOf(message)?.kind === NUDGE_KIND
}

/**
 * A nudge's pointers for its evidence: the nudge's kind, when it was shown,
 * its capture and the call's goal. Ids, a kind and a timestamp only: never
 * the transcript. Empty for any other message. Pure.
 */
export function nudgePointers(
  assistant: StoredChatMessage,
  context: NudgeContext | null | undefined,
): Pick<ChatTurnEvidence, 'nudge_kind' | 'capture_id' | 'nudge_at' | 'meeting_goal_id'> {
  if (!isNudgeMessage(assistant.ui_message)) return {}
  const out: Pick<ChatTurnEvidence, 'nudge_kind' | 'capture_id' | 'nudge_at' | 'meeting_goal_id'> = {}
  const kind = clipText(metadataOf(assistant.ui_message)?.nudge_kind, 40)
  out.nudge_kind = kind || 'insight'
  if (context?.captureId) out.capture_id = clipText(context.captureId, 60)
  if (assistant.created_at) out.nudge_at = assistant.created_at
  if (context?.meetingGoalId) out.meeting_goal_id = clipText(context.meetingGoalId, 60)
  return out
}

/** Whether an output holds something the mail scrub replaced (`scrubbed: 'mail'`), however deep. */
function holdsScrubbedMail(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => holdsScrubbedMail(v, depth + 1))
  const o = value as Record<string, unknown>
  if (o.scrubbed === 'mail') return true
  return Object.values(o).some((v) => holdsScrubbedMail(v, depth + 1))
}

/** Whether a tool part touched mail: a mail tool, or an output carrying mail rows. */
function touchesMail(part: Part, name: string): boolean {
  return MAIL_TOOL_RE.test(name) || holdsScrubbedMail(part.output) || holdsScrubbedMail(part.result)
}

/** The first `[CODE]` in an error text (the spec client's format). */
export function errorCodeOf(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  return /\[([A-Z][A-Z0-9_]{2,})\]/.exec(text)?.[1]
}

/** A tool input as kept: mail text an agent wrote taken out of a mail tool's input. */
function keptInput(name: string, input: unknown): unknown {
  if (!MAIL_TOOL_RE.test(name) || !input || typeof input !== 'object' || Array.isArray(input)) return input
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = MAIL_INPUT_FIELDS.has(k) ? '[mail text not kept]' : v
  return out
}

/** One tool part as a step. */
export function stepOf(part: Part): TurnToolStep | null {
  const name = toolNameOf(part)
  if (!name) return null
  const step: TurnToolStep = { name, ok: true }
  const input = clipJson(keptInput(name, part.input), FLYWHEEL_LIMITS.stepInput)
  if (input) step.input = input
  if (part.state === 'output-error') {
    step.ok = false
    const code = errorCodeOf(part.errorText)
    if (code) step.code = code
    const error = clipText(part.errorText, FLYWHEEL_LIMITS.stepError)
    if (error) step.error = error
    return step
  }
  const output = part.output
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>
    if (o.success === false) step.ok = false
    if (typeof o.code === 'string' && o.code) step.code = o.code
    else if (!step.ok) {
      const code = errorCodeOf(o.error)
      if (code) step.code = code
    }
    if (!step.ok) {
      const error = clipText(o.error, FLYWHEEL_LIMITS.stepError)
      if (error) step.error = error
    }
  }
  // A success carries no code worth keeping.
  if (step.ok) delete step.code
  return step
}

/** The skill a load_skill part loaded: the name it matched, else the one it asked for. */
function loadedSkill(part: Part): string | null {
  const output = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : null
  if (part.state === 'output-available' && typeof output?.skill === 'string' && output.skill) return output.skill
  const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : null
  const asked = input?.skill ?? input?.name
  return typeof asked === 'string' && asked.trim() ? asked.trim() : null
}

/**
 * Build a turn's evidence from its assistant message and the person's message
 * that started it (null when none came before it). A turn nobody typed takes
 * what started it as its request (serverStartedRequest), whatever is passed.
 * A nudge adds its pointers (nudgePointers), its capture and goal from
 * `nudge` when the caller read them.
 */
export function buildChatTurnEvidence(
  assistant: StoredChatMessage,
  request: StoredChatMessage | null,
  nudge?: NudgeContext | null,
): ChatTurnBuild {
  const parts = partsOf(assistant.ui_message)
  const steps: TurnToolStep[] = []
  const loads: string[] = []
  const tools: string[] = []
  let mail = false
  for (const part of parts) {
    const step = stepOf(part)
    if (!step) continue
    if (!mail && touchesMail(part, step.name)) mail = true
    if (!tools.includes(step.name)) tools.push(step.name)
    if (LOAD_SKILL_TOOLS.has(step.name)) {
      const skill = loadedSkill(part)
      if (skill && !loads.includes(skill)) loads.push(skill)
    }
    if (steps.length < FLYWHEEL_LIMITS.steps) steps.push(step)
  }
  const messageId =
    (typeof assistant.ui_message_id === 'string' && assistant.ui_message_id) ||
    (assistant.ui_message && typeof (assistant.ui_message as { id?: unknown }).id === 'string' ? ((assistant.ui_message as { id: string }).id) : '')
  const started = serverStartedRequest(assistant.ui_message)
  const evidence: ChatTurnEvidence = {
    kind: 'chat_turn',
    request: clipText(started ?? (request ? messageText(request.ui_message) : ''), FLYWHEEL_LIMITS.request),
    steps,
    loads: clipList(loads, FLYWHEEL_LIMITS.skillSlugs),
    messageId,
  }
  // A turn that touched mail keeps no reply (see the module header).
  const reply = mail ? '' : clipText(messageText(assistant.ui_message), FLYWHEEL_LIMITS.reply)
  if (reply) evidence.reply = reply
  if (assistant.created_at) evidence.at = assistant.created_at
  Object.assign(evidence, nudgePointers(assistant, nudge))
  return {
    evidence,
    skillSlugs: clipList(loads, FLYWHEEL_LIMITS.skillSlugs),
    tools: clipList(tools, FLYWHEEL_LIMITS.tools),
  }
}

/** The sweep's codes present in a turn's steps, each once, in CHAT_FAILURE_CODES order. */
export function failureCodesOf(evidence: Pick<ChatTurnEvidence, 'steps'>): ChatFailureCode[] {
  const present = new Set(evidence.steps.filter((s) => !s.ok && s.code).map((s) => s.code))
  return CHAT_FAILURE_CODES.filter((code) => present.has(code))
}

const MESSAGE_COLUMNS = 'role, ui_message, ui_message_id, created_at'

/**
 * The person's message that started a turn: the closest `user` row before
 * `before` in the conversation. Null when there is none (or the read failed).
 */
export async function loadRequestMessage(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; before: string },
): Promise<StoredChatMessage | null> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', scope.conversationId)
    .eq('user_id', scope.userId)
    .eq('role', 'user')
    .lt('created_at', scope.before)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0] as StoredChatMessage
}

/**
 * A nudge's context, read only when someone rates it: the conversation's
 * capture (`chat_conversations.capture_id`, scoped to its owner) and the
 * person's goal for that call, its id only (findMeetingGoalForCapture, fenced
 * on the conversation's workspace and the person). Best-effort: a failed read
 * leaves that pointer out, never fails the rating.
 */
export async function loadNudgeContext(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string },
): Promise<NudgeContext> {
  try {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('capture_id, workspace_id')
      .eq('id', scope.conversationId)
      .eq('user_id', scope.userId)
      .maybeSingle()
    const row = data as { capture_id?: unknown; workspace_id?: unknown } | null
    const captureId = !error && typeof row?.capture_id === 'string' && row.capture_id ? row.capture_id : null
    if (!captureId) return {}
    const workspaceId = typeof row?.workspace_id === 'string' ? row.workspace_id : null
    let meetingGoalId: string | null = null
    if (workspaceId) {
      try {
        meetingGoalId = (await findMeetingGoalForCapture(supabase, { workspaceId, userId: scope.userId, captureId }))?.id ?? null
      } catch {
        meetingGoalId = null
      }
    }
    return { captureId, meetingGoalId }
  } catch {
    return {}
  }
}

/**
 * One persisted assistant message and the request before it, built into
 * evidence. Scoped to the conversation AND its owner (call with the service
 * client after checking the conversation is the person's). Null when the
 * message is not persisted yet, is not the assistant's, or the read failed.
 * A nudge also reads its capture and goal (loadNudgeContext).
 */
export async function loadChatTurnEvidence(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; messageId: string },
): Promise<ChatTurnBuild | null> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', scope.conversationId)
    .eq('user_id', scope.userId)
    .eq('ui_message_id', scope.messageId)
    .maybeSingle()
  if (error || !data) return null
  const assistant = data as StoredChatMessage
  if (assistant.role !== 'assistant') return null
  // A turn nobody typed has no request to read (see the module header).
  const request =
    assistant.created_at && !serverStartedRequest(assistant.ui_message)
      ? await loadRequestMessage(supabase, { conversationId: scope.conversationId, userId: scope.userId, before: assistant.created_at })
      : null
  const nudge = isNudgeMessage(assistant.ui_message)
    ? await loadNudgeContext(supabase, { conversationId: scope.conversationId, userId: scope.userId })
    : null
  return buildChatTurnEvidence({ ...assistant, ui_message_id: assistant.ui_message_id ?? scope.messageId }, request, nudge)
}
