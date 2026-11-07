import { tool } from 'ai'
import { z } from 'zod'

/**
 * answer_guest (guest access, migration 429): the owner's main agent answers
 * a question one of the owner's guests' agents asked it (ask_owner_agent,
 * src/lib/guests/reach-owner.ts). A guest_ask background update names each
 * ask's id; the answer is written into that guest's thread and texted to
 * them. A schema twin like start_local_agent's: no generic execute, so MCP
 * cannot export it and every other surface treats it as absent
 * (CHAT_NATIVE_TOOL_NAMES). Only the main chat's tool route runs it
 * (/api/internal/chat/tool), for the token's owner and their own pending
 * asks, through src/lib/guests/guest-asks.ts. A home turn may call it
 * (serverTurnMayCall); a typed turn's call is the person's outward call.
 */

export const GUEST_ANSWER_TOOL_NAMES = ['answer_guest'] as const
export const GUEST_ANSWER_MAX = 600

export const answerGuestSchema = z.object({
  ask_id: z.string().uuid('must be an ask id from the update').describe("The ask's id, from the update that carried it"),
  answer: z.string().trim().min(1).max(GUEST_ANSWER_MAX).describe('What their agent tells them, in a few plain sentences: it is texted to them as is'),
  outcome: z.enum(['answered', 'declined']).optional().describe("declined: you won't help with this (say so kindly in answer). Default answered"),
})
export type AnswerGuestInput = z.infer<typeof answerGuestSchema>

export function createGuestAnswerTools() {
  return {
    answer_guest: tool({
      description:
        "Answer a question one of the person's guests asked you through the agent the person set up for them (an update names each ask's id). " +
        'The answer is texted to that guest as is: only what their tier may know, never the person\'s mail, private notes or anyone else\'s details. ' +
        'Once per ask. Unsupported outside main chat.',
      inputSchema: answerGuestSchema,
    }),
  }
}
