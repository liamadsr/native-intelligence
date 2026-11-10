import { tool } from 'ai'
import { z } from 'zod'

/**
 * ask_agent (agent links, migration 435): the person's main agent asks
 * another Native Intelligence user's agent something for them, over a link both people set
 * up (People > Their agent). The other side answers through the agent its
 * owner set up for this person, within what they let it share; the answer
 * comes back to this chat on its own (an agent_answer update). A schema twin
 * like answer_guest's: no generic execute, so MCP cannot export it and every
 * other surface treats it as absent (CHAT_NATIVE_TOOL_NAMES). Only the main
 * chat's tool route runs it (/api/internal/chat/tool), through
 * src/lib/agent-links/exchange.ts. Every message is held as the person's
 * approval card and sent only on their yes (approvals.ts executeStoredCall),
 * so their card is what starts an exchange (decision 6), whichever turn
 * proposed it.
 */

export const AGENT_LINK_ASK_TOOL_NAMES = ['ask_agent'] as const
export const AGENT_LINK_ASK_MAX = 1000
/** A handed-off action item's title, at most. */
export const AGENT_LINK_HANDOFF_TITLE_MAX = 200

export const askAgentSchema = z
  .object({
    to: z.string().trim().min(1).max(120).optional().describe("Whose agent to ask: the linked person's name. Needed to start a new conversation"),
    exchange_id: z.string().uuid('must be an exchange id from an earlier answer').optional().describe('Follow up inside this conversation (its id came with the answer) instead of starting a new one'),
    message: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_LINK_ASK_MAX)
      .describe("What to ask, in a few plain sentences, as the person's agent. Only what the other side needs: never the person's mail, private notes or anyone else's details"),
    hand_off: z
      .object({
        title: z.string().trim().min(1).max(AGENT_LINK_HANDOFF_TITLE_MAX).describe('The action item, as a short task title for them (e.g. "Send Acme the revised pricing")'),
        due_date: z.string().trim().max(40).optional().describe('When it is due, ISO 8601, if a date was agreed'),
      })
      .optional()
      .describe("Hand them an action item too (after a call, say): it lands on their board as a suggestion for them to confirm, with `message` as its note. Only when their agent takes tasks; the result says if it doesn't"),
  })
  .refine((v) => !!v.to || !!v.exchange_id, { message: 'name who to ask (to), or the conversation to follow up in (exchange_id)' })
export type AskAgentToolInput = z.infer<typeof askAgentSchema>

export function createAgentLinkAskTools() {
  return {
    ask_agent: tool({
      description:
        "Ask another Native Intelligence user's agent something for the person (someone they linked agents with: a teammate, or someone in another workspace), such as when they're free or the status of something they share. " +
        'Their agent answers within what its owner lets it share; the answer comes back to this chat on its own, so tell the person you asked and do not wait. ' +
        "When the person asks you to ask, message or check with someone's agent, call this with `to` set to that person's name: you don't need to know first whether they're linked, because an unlinked name sends nothing and the result lists who is. " +
        'Start a conversation for something the person asked for (asking that agent, or a request that needs that person\'s answer: a time to meet, the status of work they share), or, in a background update, for work that needs one; follow up with exchange_id. ' +
        'To hand them an action item (one of theirs from a call, say), add hand_off: it lands on their board as a suggestion they confirm. ' +
        'Every message waits for the person\'s yes before it is sent, wherever you are. Never agree to anything for the person over it. Works in main chat and from the person\'s own text or Slack message.',
      inputSchema: askAgentSchema,
    }),
  }
}
