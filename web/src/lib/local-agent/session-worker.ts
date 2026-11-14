/**
 * Whether a Mac job runs on the person's own coding agent (migration 658's
 * `local_agent_session.worker`), for the doors its session token opens:
 *   - the model relay (/api/local-agent/model/*) refuses it: a coding agent
 *     runs on the person's own account with its vendor, never on ours;
 *   - the Mac body's spec route refuses it (it has no Native Intelligence spec), and the
 *     Studio's product door too;
 *   - the tool route serves it the board tools only (worker-tools.ts).
 * Read on its own, so a database without the column (658 not applied: no job
 * can have a worker yet) reads as none; any other failed read throws, and the
 * door refuses (fail closed).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingColumnError, isWorkerId } from '@/lib/environments/types'

export class SessionWorkerReadError extends Error {}

/** The job's coding agent's id, or null for Native Intelligence's own agent. */
export async function readSessionWorker(svc: SupabaseClient, sessionId: string, userId: string): Promise<string | null> {
  const { data, error } = await svc.from('local_agent_session').select('worker').eq('id', sessionId).eq('user_id', userId).maybeSingle()
  if (error) {
    if (isMissingColumnError(error)) return null
    throw new SessionWorkerReadError(error.message)
  }
  const worker = (data as { worker?: unknown } | null)?.worker
  if (worker === null || worker === undefined) return null
  // A value the column's check would never hold: still not ours to run.
  return isWorkerId(worker) ? worker : String(worker)
}
