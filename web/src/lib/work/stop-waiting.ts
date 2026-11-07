/**
 * "Stop waiting" on a question nobody can answer any more, from the client
 * (the bot's bubble and the item panel): PATCH /api/account/activity/[id]
 * { action: 'stop_waiting' } (work/stale-questions.ts on the server). The
 * row's realtime UPDATE carries the change to every window.
 *
 * When to offer it (questionIsStale): the row waits on an answer
 * (`needs_input`) and its run is gone (no `agent_run_id`: deleted with its
 * action) or, when the run's status is known, no longer parked on it. A
 * question its run still waits on is answered, or its run stopped: the server
 * refuses it (409) too.
 */
import { toast } from 'sonner'

/** Whether a waiting row's question can no longer be answered. `runStatus`: undefined when unknown, null for no run. */
export function questionIsStale(
  row: { status: string; agent_run_id?: string | null } | null | undefined,
  runStatus?: string | null,
): boolean {
  if (!row || row.status !== 'needs_input') return false
  if (!row.agent_run_id) return true
  return runStatus !== undefined && runStatus !== 'needs_input'
}

/** Ask the server to stop waiting on the question; true when it no longer waits. Says so when it can't. */
export async function requestStopWaiting(workId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/activity/${encodeURIComponent(workId)}`, {
      method: 'PATCH',
      // No workspace header: the route admits a row from any of the caller's memberships.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop_waiting' }),
    })
    if (res.ok) return true
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    toast.error(res.status === 409 ? 'It’s still waiting on your answer' : 'Could not stop waiting', {
      description: err?.error || undefined,
    })
    return false
  } catch (e) {
    toast.error('Network error', { description: e instanceof Error ? e.message : undefined })
    return false
  }
}
