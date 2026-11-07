/**
 * Shared log-tail append + cancel-signal read for the eve `coding-agent` watcher
 * (Phase 3).
 *
 * The internal event route (`/api/internal/agent-run/event`) is the log pump the
 * EVE AGENT posts to. The WATCHER (run-agent-eve.ts) runs in the Next/Inngest
 * runtime and mirrors the streamed session events into the SAME `agent_run.log_tail`
 * projection — but it must NOT import the route handler (a route module is not an
 * in-process callee; importing it from a lib module is a layering inversion and
 * would drag `next/server` into the Inngest bundle). So the watcher appends
 * DIRECTLY via the service client, applying the IDENTICAL tail discipline the
 * event route uses (4000-char tail, first-event → running + started_at) and
 * reading the cancel signal off the same row read.
 *
 * This is a deliberate parallel to the event route's tail logic, not a shared
 * import of it — keep the 4000-char cap and the queued→running transition in sync
 * with src/app/api/internal/agent-run/event/route.ts.
 *
 * Every write is best-effort: log_tail is an observability projection, never
 * authoritative state, so a benign write race (a terminal transition landing
 * between our read and write) must never throw out of the watcher.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beatAgentRunWork } from '@/lib/work/agent-run-mirror'

/** The last-N-chars tail discipline — matches the legacy runner + event route. */
const TAIL_CHARS = 4000

/** Keep only the last N chars. */
function tail(s: string, n = TAIL_CHARS): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

/**
 * Append a chunk to `agent_run.log_tail` (read-append-write, re-tailed), flipping a
 * still-`queued` run to `running` + stamping `started_at` on the FIRST append —
 * the same "the run started" signal the event route emits. Also persists the eve
 * `sandbox_id` when supplied (first flush only; idempotent thereafter).
 *
 * Returns the row's cancel signal: `{ canceling }` is true when the row is
 * `canceling` or already `canceled` (the watcher aborts its stream on this) or the
 * row is gone (a delete race — treated as "stop", nothing left to write to).
 *
 * Never throws — a lost beat is only a UI gap.
 */
export async function appendAgentRunLog(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; text: string; sandboxId?: string },
): Promise<{ canceling: boolean }> {
  const { agentRunId, workspaceId, text, sandboxId } = args

  try {
    const { data: row, error } = await supabase
      .from('agent_run')
      .select('status, log_tail, sandbox_id, kind, triggered_by, task_prompt, action_id')
      .eq('id', agentRunId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    // supabase-js RESOLVES a network/PostgREST failure as { data: null, error }
    // rather than throwing — fail OPEN before the missing-row check, or one DB
    // blip reads as "row gone" and the watcher kills a healthy run as a Stop.
    if (error) return { canceling: false }
    // A missing row (cascade/delete race) → treat as canceling so the watcher stops.
    if (!row) return { canceling: true }

    const status = row.status as string
    // Stop on canceling AND canceled: agentRunCancel settles one into the other
    // within seconds, and the signal must survive that settle.
    const canceling = status === 'canceling' || status === 'canceled'

    const nextLog = tail((typeof row.log_tail === 'string' ? row.log_tail : '') + text)
    const patch: Record<string, unknown> = { log_tail: nextLog }
    // First-event transition — ONLY from 'queued'; never resurrect a terminal row.
    if (status === 'queued') {
      patch.status = 'running'
      patch.started_at = new Date().toISOString()
    }
    // Persist the eve session id the first time we have it (row not yet stamped).
    if (sandboxId && !row.sandbox_id) {
      patch.sandbox_id = sandboxId
    }

    await supabase.from('agent_run').update(patch).eq('id', agentRunId)
    // The same beat feeds the work ledger: a `[tool] …` line becomes the row's
    // live step, anything else its keep-alive (ACTIVITY-AND-REVIEW-DESIGN §3.3).
    await beatAgentRunWork(
      supabase,
      {
        id: agentRunId,
        workspace_id: workspaceId,
        status,
        kind: row.kind as string | null,
        triggered_by: row.triggered_by as string | null,
        task_prompt: row.task_prompt as string | null,
        action_id: row.action_id as string | null,
      },
      text,
    )
    return { canceling }
  } catch {
    // Best-effort — never fail a beat. Report not-canceling so a transient read
    // error doesn't spuriously abort a healthy run.
    return { canceling: false }
  }
}

/**
 * Read ONLY the cancel signal for a run without appending — used between flushes
 * so the watcher can notice a `canceling` transition promptly even when the model
 * is quiet. A missing row reads as canceling (delete race → stop); a failed read
 * (thrown OR resolved with `error`) reads as not-canceling.
 */
export async function readAgentRunCanceling(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<boolean> {
  try {
    const { data: row, error } = await supabase
      .from('agent_run')
      .select('status')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    // A resolved read error is NOT a missing row: fail open (see appendAgentRunLog).
    if (error) return false
    if (!row) return true
    const status = row.status as string
    return status === 'canceling' || status === 'canceled'
  } catch {
    return false
  }
}
