/**
 * The client a person's agent run moves a card through (agent-finish.ts
 * moveCardForRun): the service role, with the activity headers that make the
 * activity log (migrations 488 / 489, entity_activity_actor) credit the move
 * to that person's agent, not to the system. The card's History then reads
 * "<their name>'s agent". Its own module so tests can hand back their fake.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { agentActivityHeaders } from '@/lib/activity-actor'
import { createStatelessClient } from '@/lib/supabase/stateless'

export function agentWriterFor(userId: string): SupabaseClient {
  return createStatelessClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    global: { headers: agentActivityHeaders(userId) },
  })
}
