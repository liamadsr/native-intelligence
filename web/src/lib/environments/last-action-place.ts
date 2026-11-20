/**
 * Where a person last ran an action's agent, and with whom: what the action
 * panel's Start opens on for a retry or a re-run (the owner's rule, 11-19: a
 * task remembers its own place and agent; the project's "Run my work here"
 * applies only to an action they never ran). Read from what the runs already
 * record, so nothing new is stored:
 *
 *   - their latest Mac job for it (local_agent_session, their Starts' key
 *     `local-agent-action:<action>:start:…`): the Mac it ran on (the Mac
 *     environment of its device, while they still have it) and its agent;
 *   - their latest cloud coding run for it (agent_run, triggered_by them; a
 *     work run is not a place they chose, so it is skipped).
 *
 * The newer of the two wins. A Mac job on a Mac since removed reads as no
 * memory (the default applies), never as the cloud. Only their own rows: a
 * teammate's runs never decide where this person's Start goes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTION_JOB_KEY_PREFIX } from '@/lib/local-agent/unattended'
import { isUuid } from '@/lib/local-agent/store'

type Svc = SupabaseClient

export interface LastActionPlace {
  /** The Mac environment it last ran on, or null: the cloud. */
  environmentId: string | null
  /** The coding agent of the person's own it ran with (Mac only), or null: Native Intelligence's own agent. */
  worker: string | null
}

/** Throws on a database error. */
export async function lastActionPlace(
  svc: Svc,
  args: { userId: string; workspaceId: string; actionId: string },
): Promise<LastActionPlace | null> {
  if (!isUuid(args.actionId)) return null
  const [jobs, runs] = await Promise.all([
    svc
      .from('local_agent_session')
      .select('created_at, device_id, worker')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .like('idempotency_key', `${ACTION_JOB_KEY_PREFIX}${args.actionId.toLowerCase()}:start:%`)
      .order('created_at', { ascending: false })
      .limit(1),
    svc
      .from('agent_run')
      .select('created_at, kind')
      .eq('workspace_id', args.workspaceId)
      .eq('action_id', args.actionId)
      .eq('triggered_by', args.userId)
      .order('created_at', { ascending: false })
      .limit(5),
  ])
  if (jobs.error) throw new Error(`last Mac job read failed: ${jobs.error.message}`)
  if (runs.error) throw new Error(`last cloud run read failed: ${runs.error.message}`)
  const job = ((jobs.data ?? []) as Array<{ created_at: string; device_id: string | null; worker?: string | null }>)[0]
  // A work run (kind 'workspace') is not a place they picked; an older coding run has no kind.
  const run = ((runs.data ?? []) as Array<{ created_at: string; kind?: string | null }>).find((r) => r.kind !== 'workspace')
  if (!job && !run) return null
  if (run && (!job || Date.parse(run.created_at) > Date.parse(job.created_at))) return { environmentId: null, worker: null }
  if (!job.device_id) return null
  const { data: env, error } = await svc
    .from('environment')
    .select('id')
    .eq('kind', 'mac')
    .eq('device_id', job.device_id)
    .eq('owner_user_id', args.userId)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`last Mac read failed: ${error.message}`)
  const id = (env as { id?: string } | null)?.id
  return id ? { environmentId: id, worker: job.worker ?? null } : null
}
