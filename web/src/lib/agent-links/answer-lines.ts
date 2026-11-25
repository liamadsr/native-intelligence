/**
 * The asker's side of an exchange (agent links, migration 435): what an
 * `agent_answer` home turn carries into the asker's home thread when the
 * linked agent answered (./exchange.ts gatherAgentAnswers), and what it tells
 * the asker's own agent to do with it. Pure: home-turn.ts builds the turn's
 * body from it, fenced as data.
 */
import { AGENT_LINK_EXCHANGE_MAX_MESSAGES } from './views'

/** One message from the linked agent no turn carried yet. JSON-safe (a step output). */
export interface PlannedAgentAnswer {
  /** agent_link_message.id */
  messageId: string
  exchangeId: string
  linkId: string
  /** The other person, as their workspace names them. */
  peerName: string
  workspaceName: string | null
  kind: 'answer' | 'decline' | 'note'
  body: string
  /** What the exchange is about (the first ask, clipped). */
  topic: string
  /** Messages the exchange still has room for (an ask and its answer take two). */
  left: number
  createdAt: string
}

export interface HomeTurnAgentAnswers {
  answers: PlannedAgentAnswer[]
  /** Marked delivered once the turn carried them. */
  messageIds: string[]
}

/** The most answers one turn carries (the oldest first). */
export const AGENT_ANSWER_TURN_MAX = 8

/** Messages still free in an exchange holding `count`. */
export function exchangeRoom(count: number): number {
  return Math.max(0, AGENT_LINK_EXCHANGE_MAX_MESSAGES - count)
}

/** One line per answer: the exchange to follow up in, who, what about, and their words. */
export function agentAnswerTurnLines(answers: readonly PlannedAgentAnswer[]): string[] {
  return answers.map((a) => {
    const who = a.workspaceName ? `${a.peerName}'s agent (${a.workspaceName})` : `${a.peerName}'s agent`
    const what = a.kind === 'decline' ? 'declined' : a.kind === 'note' ? 'said' : 'answered'
    const room = a.left >= 2 ? `room for ${Math.floor(a.left / 2)} more question${a.left >= 4 ? 's' : ''}` : 'no room for another question'
    return `exchange ${a.exchangeId} · ${who} ${what} (about: ${a.topic}; ${room}): ${a.body}`
  })
}

/**
 * What an agent_answer turn is, for the asker's agent (after the background
 * update's shared opening, src/lib/chat/home-turn.ts): it asked, the other
 * agent answered, and the next step it points to is the agent's to set up for
 * the person's yes (a follow-up in the same exchange, or the invite the answer
 * points to: both held as their card by the tool route and the gate). It
 * speaks by default (the person asked for this exchange), and the one hard
 * rule stays: it never agrees to anything for them.
 */
export const AGENT_ANSWER_GUIDANCE =
  "You asked something for the person, and this came back; they may not remember asking. " +
  'Tell them what the other agent said or proposed; call no_reply and write nothing only when you already told them. ' +
  'A next step it points to is yours to set up for their yes: the invite for a time it offered, or a follow-up with ask_agent and the exchange id while the exchange has room. ' +
  "Never accept, book, promise or agree to anything for the person in a message to the other agent without their yes."
