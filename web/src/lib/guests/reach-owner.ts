/**
 * The tools a guest's agent always holds (guest access, migration 429,
 * src/lib/guests/tools.ts GUEST_ALWAYS_TOOLS): how the agent the owner made
 * for one person reaches the owner, and remembers that person.
 *
 *   message_owner        a note from the person to the owner, in their own
 *                        words: a `data-guest-message` part in the owner's
 *                        home thread (the chat card, PR4). The router
 *                        (src/lib/reach/route.ts) then takes it to the owner
 *                        where they are: a banner at an app, a text or Slack
 *                        when they are away (their own channel order and
 *                        consent), quiet hours kept, once per note
 *                        (reach_notice 'guest_message'). A note with `by`
 *                        (when the owner must know or act by, an ISO time
 *                        with its offset) is urgent: stored as its
 *                        `urgent_by`, it gets through quiet hours when that
 *                        is before about 10 am the next morning.
 *   ask_owner_agent      a question for the owner's own agent: an
 *                        agent_guest_ask row and a `guest_ask` home turn in the
 *                        owner's home thread (./guest-asks.ts), which answers
 *                        it (answer_guest), declines it, or tells the owner.
 *                        Never while the owner switched the agent off.
 *   remember_about_guest one thing learned about the person, in
 *                        agent_guest_memory: theirs, the owner's to read,
 *                        never the owner's own memory.
 *
 * The guest and the owner come from the verified token and the live guest
 * row (./guest-tools.ts), never from the model's input. Every write is keyed
 * so a retried call lands once. Server only.
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage, resolveHomeConversation } from '@/lib/chat/home-message-writer'
import { HOME_TURN_REQUESTED_EVENT, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { readAgentPausedState } from '@/lib/work/agent-paused'
import { isIsoInstant } from '@/lib/presence/presence'
import { requestRoute } from '@/lib/reach/route'
import { GUEST_MESSAGE_MESSAGE_KIND } from './chat-parts'
import type { AgentGuest, GuestChannelId } from './store'

export { guestVia } from './chat-parts'

export const GUEST_MESSAGE_MAX = 600
export const GUEST_QUESTION_MAX = 1000
export const GUEST_MEMORY_TEXT_MAX = 300
/** Notes one guest may leave the owner in a day. */
export const GUEST_MESSAGES_PER_DAY = 20
/** Questions one guest's agent may ask the owner's agent in a day, and how many may wait at once. */
export const GUEST_ASKS_PER_DAY = 10
export const GUEST_ASKS_PENDING = 3
/** Things one guest's agent may remember about them. */
export const GUEST_MEMORY_CAP = 100

const DAY_MS = 24 * 60 * 60_000

/** The `data-guest-message` part's type (the chat card renders it, PR4). */
export const GUEST_MESSAGE_PART = 'data-guest-message' as const
/** ui_message.metadata.kind of a guest's note in the owner's home thread. */
export const GUEST_MESSAGE_KIND = GUEST_MESSAGE_MESSAGE_KIND

/** What a note's `by` says: when the owner must know or act by, as a full ISO 8601 time with its UTC offset. */
const MESSAGE_OWNER_BY_DESCRIPTION =
  "Only when it can't wait for the owner's morning: when they must know or act by, as an ISO 8601 time with its UTC offset (2026-11-01T09:00:00-04:00). It then reaches them even at night if that is before about 10 am"

export const messageOwnerInputSchema = z.object({
  text: z.string().trim().min(1).max(GUEST_MESSAGE_MAX).describe("The note for the owner, in the person's own words"),
  by: z
    .string()
    .trim()
    .refine((v) => isIsoInstant(v), 'An ISO 8601 time with its UTC offset, like 2026-11-01T09:00:00-04:00')
    .optional()
    .describe(MESSAGE_OWNER_BY_DESCRIPTION),
})

export const askOwnerAgentInputSchema = z.object({
  question: z.string().trim().min(1).max(GUEST_QUESTION_MAX).describe("What you need from the owner's agent, self-contained: it doesn't see this conversation"),
})

export const rememberAboutGuestInputSchema = z.object({
  kind: z.enum(['fact', 'preference']).describe('preference: how they like things done; fact: something about them'),
  text: z.string().trim().min(1).max(GUEST_MEMORY_TEXT_MAX).describe('One short line, in your words'),
})

/** The three tools' inputs as plain JSON Schema, for the guest spec's proxies. */
export const GUEST_REACH_INPUT_JSON_SCHEMAS = {
  message_owner: {
    type: 'object',
    properties: {
      text: { type: 'string', description: "The note for the owner, in the person's own words", maxLength: GUEST_MESSAGE_MAX },
      by: { type: 'string', description: MESSAGE_OWNER_BY_DESCRIPTION },
    },
    required: ['text'],
    additionalProperties: false,
  },
  ask_owner_agent: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "What you need from the owner's agent, self-contained: it doesn't see this conversation", maxLength: GUEST_QUESTION_MAX },
    },
    required: ['question'],
    additionalProperties: false,
  },
  remember_about_guest: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['fact', 'preference'], description: 'preference: how they like things done; fact: something about them' },
      text: { type: 'string', description: 'One short line, in your words', maxLength: GUEST_MEMORY_TEXT_MAX },
    },
    required: ['kind', 'text'],
    additionalProperties: false,
  },
} as const

/** The guest's turn, as the tool route verified it. */
export interface GuestToolScope {
  ownerUserId: string
  workspaceId: string
  /** The guest's own thread (the token's conversation). */
  conversationId: string
  /** eve's ids for this call, when the agent sent them: a retried call lands once. */
  callKey?: string | null
  /** Where the guest is messaging from (the token's surface); 'sms' when absent. */
  channel?: GuestChannel
}

/** How a guest reaches their agent: by text, or on Slack (migration 434). */
export type GuestChannel = GuestChannelId

/** A uuid derived from a call's key (stable across retries), else a fresh one. */
export function callUuid(scope: string, callKey: string | null | undefined): string {
  if (!callKey) return randomUUID()
  const hex = createHash('sha256').update(`${scope}:${callKey}`).digest('hex')
  // Shaped as a v4 uuid so the uuid columns take it.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** eve's call key from the tool route's body: `<session>:<turn>:<call>`, or null when any is missing. */
export function callKeyOf(body: { callId?: unknown; turnId?: unknown; sessionId?: unknown }): string | null {
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
  return ok(body.callId) && ok(body.turnId) && ok(body.sessionId) ? `${body.sessionId}:${body.turnId}:${body.callId}` : null
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

// ── message_owner ───────────────────────────────────────────────────────────

/** What a guest's note carries in the owner's home thread (the chat card's data; `guest` is PR4's GuestRef). */
export interface GuestMessageData {
  guest: { id: string; name: string; preset: AgentGuest['preset']; channel: GuestChannel; conversation_id: string }
  text: string
  /** The guest's agent gave it a `by` (the chat card says "Urgent"). */
  urgent: boolean
  /** When the owner must know or act by (ISO 8601 with its offset): what the router reads. */
  urgent_by?: string
  at: string
}

/** Notes this guest left the owner since `sinceMs`. Throws on a failed read. */
async function countGuestMessagesToOwner(supabase: SupabaseClient, scope: GuestToolScope, guestId: string, sinceMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', scope.ownerUserId)
    .eq('workspace_id', scope.workspaceId)
    .eq('ui_message->metadata->>kind', GUEST_MESSAGE_KIND)
    .eq('ui_message->metadata->>guest_id', guestId)
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(error.message)
  return count ?? 0
}

export interface MessageOwnerDeps {
  append?: typeof appendHomeMessage
  /** Ask the router to take the note to the owner (requestRoute). */
  route?: typeof requestRoute
  now?: number
}

/** message_owner (see the header). The output is what the guest's agent reads. */
export async function messageOwner(
  supabase: SupabaseClient,
  scope: GuestToolScope,
  guest: Pick<AgentGuest, 'id' | 'displayName' | 'preset'>,
  input: z.infer<typeof messageOwnerInputSchema>,
  deps: MessageOwnerDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now()
  const sent = await countGuestMessagesToOwner(supabase, scope, guest.id, now - DAY_MS)
  if (sent >= GUEST_MESSAGES_PER_DAY) {
    return { success: false, code: 'DAILY_LIMIT', message: `Not passed on: ${guest.displayName} has left the owner ${GUEST_MESSAGES_PER_DAY} notes today. Tell them to try again tomorrow, or reach the owner directly.` }
  }
  const noteId = callUuid(`guest-message:${guest.id}`, scope.callKey)
  const messageId = `guest-message:${noteId}`
  const urgentBy = input.by && isIsoInstant(input.by) ? input.by : null
  const data: GuestMessageData = {
    guest: { id: guest.id, name: guest.displayName, preset: guest.preset, channel: scope.channel ?? 'sms', conversation_id: scope.conversationId },
    text: input.text,
    urgent: urgentBy !== null,
    ...(urgentBy ? { urgent_by: urgentBy } : {}),
    at: new Date(now).toISOString(),
  }
  const written = await (deps.append ?? appendHomeMessage)(supabase, {
    userId: scope.ownerUserId,
    workspaceId: scope.workspaceId,
    messageId,
    parts: [{ type: GUEST_MESSAGE_PART, id: messageId, data }],
    metadata: { kind: GUEST_MESSAGE_KIND, guest_id: guest.id, guest_conversation_id: scope.conversationId, note_id: noteId, ...(urgentBy ? { urgent_by: urgentBy } : {}) },
  })
  if (!written.written) {
    return { success: false, code: 'NOT_DELIVERED', message: 'Could not pass the note on right now. Tell them to try again in a moment.' }
  }
  // The system takes it to the owner wherever they are (ids only; keyed on the note, so a retried call routes once).
  if (written.conversationId) {
    await (deps.route ?? requestRoute)({ userId: scope.ownerUserId, workspaceId: scope.workspaceId, conversationId: written.conversationId }, `guest-message:${noteId}`)
  }
  return {
    success: true,
    delivered: 'in_app',
    message: urgentBy
      ? "Passed on as urgent. The owner gets it in Dial8, or by text or Slack if they're away from it, even at night when it's due before their morning."
      : "Passed on. The owner gets it in Dial8, or by text or Slack if they're away from it; at night it waits for their morning.",
  }
}

// ── ask_owner_agent ─────────────────────────────────────────────────────────

export interface AskOwnerAgentDeps {
  /** Send the home turn's event (Inngest). */
  send?: (event: { name: typeof HOME_TURN_REQUESTED_EVENT; data: HomeTurnRequestedData; id: string }) => Promise<unknown>
  now?: number
}

/** ask_owner_agent (see the header). The output is what the guest's agent reads. */
export async function askOwnerAgent(
  supabase: SupabaseClient,
  scope: GuestToolScope,
  guest: Pick<AgentGuest, 'id' | 'displayName'>,
  input: z.infer<typeof askOwnerAgentInputSchema>,
  deps: AskOwnerAgentDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now()
  if ((await readAgentPausedState(supabase, scope.workspaceId)) !== 'active') {
    return { success: false, code: 'OWNER_AGENT_OFF', message: "The owner's agent isn't taking requests right now. Use message_owner to pass it on to the owner instead." }
  }
  const { data: recent, error: recentError } = await supabase
    .from('agent_guest_ask')
    .select('id, status, question, created_at')
    .eq('guest_id', guest.id)
    .eq('owner_user_id', scope.ownerUserId)
    .gte('created_at', new Date(now - DAY_MS).toISOString())
  if (recentError) throw new Error(recentError.message)
  const rows = (recent ?? []) as Array<{ id: string; status: string; question: string }>
  const askId = callUuid(`guest-ask:${guest.id}`, scope.callKey)
  // A retried call: the ask already stands.
  if (rows.some((r) => r.id === askId)) return askedOutput(askId)
  if (rows.filter((r) => r.status === 'pending').length >= GUEST_ASKS_PENDING) {
    return { success: false, code: 'TOO_MANY_PENDING', message: `${GUEST_ASKS_PENDING} questions to the owner's agent are still waiting for an answer. Wait for those before asking another.` }
  }
  if (rows.length >= GUEST_ASKS_PER_DAY) {
    return { success: false, code: 'DAILY_LIMIT', message: "That's the most questions for the owner's agent today. Use message_owner to pass it on to the owner instead." }
  }
  const home = await resolveHomeConversation(supabase, { userId: scope.ownerUserId, workspaceId: scope.workspaceId })
  if (!home) return { success: false, code: 'NOT_DELIVERED', message: "Could not reach the owner's agent right now. Use message_owner instead." }
  const { error } = await supabase.from('agent_guest_ask').insert({
    id: askId,
    guest_id: guest.id,
    owner_user_id: scope.ownerUserId,
    workspace_id: scope.workspaceId,
    guest_conversation_id: scope.conversationId,
    question: input.question,
    status: 'pending',
  })
  if (error && error.code !== '23505') throw new Error(error.message)
  const send =
    deps.send ??
    (async (event) => {
      const { inngest } = await import('@/lib/inngest/client')
      return inngest.send(event)
    })
  try {
    await send({
      name: HOME_TURN_REQUESTED_EVENT,
      data: { conversationId: home.conversationId, userId: scope.ownerUserId, workspaceId: scope.workspaceId, workItemIds: [], reason: 'guest_ask' },
      id: `guest-ask-${askId}`,
    })
  } catch (err) {
    // The ask stands: the next guest_ask turn carries every pending one.
    console.warn('[guest-ask] turn not requested:', err instanceof Error ? err.message : String(err))
  }
  return askedOutput(askId)
}

function askedOutput(askId: string): Record<string, unknown> {
  return {
    success: true,
    ask_id: askId,
    status: 'asked',
    message: "Asked. The owner's agent answers in a few minutes, or asks the owner first; the answer comes back here and is sent to them. Tell them you've asked, and don't ask again.",
  }
}

// ── remember_about_guest ────────────────────────────────────────────────────

/** remember_about_guest (see the header). The output is what the guest's agent reads. */
export async function rememberAboutGuest(
  supabase: SupabaseClient,
  scope: GuestToolScope,
  guest: Pick<AgentGuest, 'id' | 'displayName'>,
  input: z.infer<typeof rememberAboutGuestInputSchema>,
): Promise<Record<string, unknown>> {
  const text = clip(input.text, GUEST_MEMORY_TEXT_MAX)
  const { data, error } = await supabase.from('agent_guest_memory').select('text').eq('guest_id', guest.id).eq('owner_user_id', scope.ownerUserId)
  if (error) throw new Error(error.message)
  const known = ((data ?? []) as Array<{ text: string }>).map((r) => r.text.trim().toLowerCase())
  if (known.includes(text.toLowerCase())) return { success: true, remembered: false, message: 'Already known.' }
  if (known.length >= GUEST_MEMORY_CAP) {
    return { success: false, code: 'MEMORY_FULL', message: `You already keep ${GUEST_MEMORY_CAP} things about ${guest.displayName}; the owner can clear some in Dial8.` }
  }
  const { error: insertError } = await supabase.from('agent_guest_memory').insert({ guest_id: guest.id, owner_user_id: scope.ownerUserId, kind: input.kind, text })
  if (insertError) throw new Error(insertError.message)
  return {
    success: true,
    remembered: true,
    // PROD 11-02: a saved "night-before reminders" note was told to the guest as a standing rule that would reach the owner.
    message: `Kept for your own conversations with ${guest.displayName}. It sets nothing up and reaches no one: for something that must happen on the owner's side later, use ask_owner_agent.`,
  }
}
