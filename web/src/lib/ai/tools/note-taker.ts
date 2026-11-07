import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { LIVE_DIRECTIVE_MAX_CHARS, checkDirectiveTarget, insertDirective } from '@/lib/live-agent/directives'

/**
 * The meeting chat's line to the live note-taker (docs/plans/live-agent-messaging.md,
 * L2). During a live meeting the user types to the talk-back agent, not to the
 * live turns; when they ask it to get something into the notes ("tell the
 * note-taker to capture that Dana owns the budget"), this passes it on as a
 * directive the next record-writing turn records (L1), and the chat shows it
 * turning "Noted".
 *
 * Only for a person at the keyboard: an unattended run (work-run, skill-run)
 * has no one who asked, so it is refused there. Only the capture's owner, only
 * until the end-of-meeting pass has written the record (checkDirectiveTarget).
 */
export function createNoteTakerTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  unattended = false,
) {
  return {
    tell_note_taker: tool({
      description:
        "During a LIVE meeting the user is recording, pass on something the user asked to have written into this meeting's notes (\"tell the note-taker Dana owns the budget\", \"make sure the notes say we ship Friday\"). The meeting's note-taker records it on its next turn and the user sees it marked Noted in the chat, so do not also restate it as a reply. Only for the user's own request about THIS meeting's record, in their words: never for something you inferred, and never to get anything done. capture_id is the live capture's id from the live meeting context.",
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the live capture (from the live meeting context)'),
        text: z.string().describe(`What to record, in the user's words (at most ${LIVE_DIRECTIVE_MAX_CHARS} characters)`),
      }),
      execute: async ({ capture_id, text }) => {
        if (unattended) return { success: false, error: 'The note-taker only takes requests from the meeting chat' }
        const target = await checkDirectiveTarget(supabase, { captureId: capture_id, workspaceId, userId })
        if (!target.ok) return { success: false, error: target.message }
        const result = await insertDirective(getServiceClient(), {
          captureId: capture_id,
          workspaceId,
          userId,
          source: 'talk_back',
          text,
        })
        if (!result.ok) return { success: false, error: result.message }
        return {
          success: true,
          directive_id: result.directive.id,
          message: 'Passed to the note-taker. The chat shows it as Noted once its next turn records it.',
        }
      },
    }),
  }
}
