/**
 * The person's own words in a loop run's follow-up CHAT (bots v3 Phase 4), for
 * the reviewer (A5, src/lib/safety/action-review.ts): a follow-up turn is the
 * person talking to the loop's bot, so a risky call there is checked against
 * what they said, as in the main chat.
 *
 * Only a delivery on a chat token counts (the `chat` claim: the person's send
 * through /api/account/activity/[id]/chat). Never the run's own invocation
 * message (a run token has no chat claim), never a delivery eve authored
 * (`kind`), and never a turn the main agent RELAYED into the run's chat
 * (`chat.relay`, bots-v4 A3): that is the main agent's message on the
 * person's behalf, not their words. Nor a reopened chat's restored history
 * (RUN_CHAT_PRIMER_HEADING): the app's record of the run and of earlier
 * messages, which leads the first message of a chat whose session expired.
 * Kept in eve's durable session state: the last 3, each its 2,000-character
 * tail, and a monotonic count.
 */
import { defineState } from 'eve/context'

export const SKILL_CHAT_MESSAGES_KEPT = 3
export const SKILL_CHAT_MESSAGE_MAX_CHARS = 2_000

/**
 * How a reopened chat's restored history begins: the first part of the first
 * message in a loop run's chat that continued in a new session after its
 * session expired (the app's loop-run-chat-reopen.ts). Twin of
 * RUN_CHAT_PRIMER_HEADING in src/lib/agent-run/run-chat-events.ts (eve roots
 * cannot share imports; a test pins them equal).
 */
export const RUN_CHAT_PRIMER_HEADING = '## Restored history of this chat'

/**
 * A delivery's own words: its flattened `message`, or, when its first part is
 * a restored history with more parts after it, those other text parts only
 * (the rule the app's replay uses, run-chat-events.ts reduceStreamEvent). A
 * single part is the person's own, whatever it says. Null when the two can't
 * be told apart (a flattened message that starts with the history and no
 * parts to split it by): a lost message only makes a later review block.
 */
function ownWords(d: { message: string; parts?: unknown }): string | null {
  const parts = Array.isArray(d.parts) ? (d.parts as Array<{ type?: unknown; text?: unknown } | null>) : null
  if (parts) {
    const first = parts[0]
    const primed = parts.length > 1 && first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith(RUN_CHAT_PRIMER_HEADING)
    if (!primed) return d.message
    return parts
      .slice(1)
      .flatMap((p) => (p?.type === 'text' && typeof p.text === 'string' ? [p.text] : []))
      .join('\n')
  }
  return d.message.trimStart().startsWith(RUN_CHAT_PRIMER_HEADING) ? null : d.message
}

const recent = defineState<{ messages: string[]; seq?: number }>('skill-runner.person-messages', () => ({ messages: [], seq: 0 }))

/** The chat claim of a run token, read without verifying (a routing hint: it can only take words away). */
export function chatClaimOf(runToken: string): { teammateId: string; relay: boolean } | null {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return null
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as { chat?: unknown }
    const chat = claims?.chat as { teammateId?: unknown; relay?: unknown } | null | undefined
    if (!chat || typeof chat !== 'object' || typeof chat.teammateId !== 'string' || !chat.teammateId) return null
    return { teammateId: chat.teammateId, relay: chat.relay === true }
  } catch {
    return null
  }
}

/** Record one delivered message, when it is the person's own (see the header). Never throws. */
export function noteSkillChatMessage(data: unknown, runToken: string): void {
  try {
    const chat = chatClaimOf(runToken)
    if (!chat || chat.relay) return
    const d = (data ?? {}) as { kind?: unknown; message?: unknown; parts?: unknown }
    if (d.kind !== undefined || typeof d.message !== 'string') return
    const text = ownWords({ message: d.message, parts: d.parts })?.trim()
    if (!text) return
    const tail = text.length > SKILL_CHAT_MESSAGE_MAX_CHARS ? text.slice(-SKILL_CHAT_MESSAGE_MAX_CHARS) : text
    recent.update((prev) => ({
      messages: [...(Array.isArray(prev?.messages) ? prev.messages : []), tail].slice(-SKILL_CHAT_MESSAGES_KEPT),
      seq: (Number.isInteger(prev?.seq) && (prev!.seq as number) >= 0 ? (prev!.seq as number) : 0) + 1,
    }))
  } catch {
    // A lost message only makes a later review block: never break the turn.
  }
}

/**
 * What a follow-up chat turn's tool call carries for the reviewer: the
 * person's latest words and their count. Nothing on a run (no chat claim) or a
 * relayed turn, and nothing before the person spoke. Never throws.
 */
export function skillChatEvidence(runToken: string): { personMessages?: string[]; personMessageSeq?: number } {
  try {
    const chat = chatClaimOf(runToken)
    if (!chat || chat.relay) return {}
    const state = recent.get()
    const messages = Array.isArray(state?.messages) ? state.messages.filter((m): m is string => typeof m === 'string') : []
    if (!messages.length) return {}
    const seq = Number.isInteger(state?.seq) && (state!.seq as number) >= 0 ? (state!.seq as number) : 0
    return { personMessages: messages, personMessageSeq: seq }
  } catch {
    return {}
  }
}
