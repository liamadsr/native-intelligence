import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finishGettingStarted } from '@/lib/onboarding/getting-started'

/**
 * `finish_getting_started` (docs/plans/getting-started-skill.md): the main
 * agent ends the person's getting started, once its steps are done or they
 * said they don't want a walk-through. The `getting-started` turn-context
 * section then goes away (src/lib/onboarding/getting-started.ts). A person
 * not getting started is a no-op success.
 *
 * ATTENDED ONLY (ATTENDED_ONLY_TOOL_NAMES): the person's own turn ends it,
 * never a background update or a bot.
 */
export function createGettingStartedTools(userId: string, supabase: SupabaseClient, workspaceId: string) {
  return {
    finish_getting_started: tool({
      description:
        "End the person's getting started: call it once its steps are done (their first capture's results shown and the calendar offered), or when they say they don't want a walk-through. " +
        "The getting-started section stops after this. Don't announce it.",
      inputSchema: z.object({
        reason: z.enum(['done', 'skipped']).describe("done: the steps are finished. skipped: they didn't want the walk-through"),
      }),
      execute: async ({ reason }) => finishGettingStarted(supabase, { workspaceId, userId, by: reason }),
    }),
  }
}
