import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_RUN_LIVE_STATUSES } from './types'

/**
 * The agent run in flight on an action, if any, of ANY kind — what a second
 * Start (`POST /api/account/actions/[id]/start-agent`) returns instead of
 * starting another run on the same action. A delegated action's Start runs a
 * coding run or a work run (decision 9), and one live run of either kind
 * blocks a second of both: two agents working one action at once is never
 * what a double press, a retried request or a Start from another surface
 * meant.
 *
 * Any teammate's run counts (RLS on `agent_run` is workspace-wide). Live is
 * exactly `AGENT_RUN_LIVE_STATUSES` (a run parked on a question included);
 * `pr_open` is terminal and never blocks.
 */
export async function findLiveActionRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; actionId: string },
): Promise<{ run: { id: string; kind: string | null } | null; error: { message: string } | null }> {
  const { data, error } = await supabase
    .from('agent_run')
    .select('id, kind')
    .eq('workspace_id', args.workspaceId)
    .eq('action_id', args.actionId)
    .in('status', [...AGENT_RUN_LIVE_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return {
    run: data ? { id: (data as { id: string }).id, kind: ((data as { kind?: string | null }).kind as string | null) ?? null } : null,
    error: error ? { message: error.message } : null,
  }
}
