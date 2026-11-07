import type { SupabaseClient } from '@supabase/supabase-js'
import { startWork } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import { systemTeammateId } from '@/lib/work/system-teammates'

// Age-out horizon + marker (plan WS-4d). Kept distinct from the recurring
// flow-schedule hygiene sweep (45d, RPC-driven, all change types): this is the
// deterministic 30d floor for CREATE proposals, the queue's true drain.
export const AGE_OUT_DAYS = 30
export const AGE_OUT_DISMISS_REASON = 'aged_out_30d'
// Per-tick cap so a single tick can't churn thousands of rows.
export const AGE_OUT_BATCH = 500
// Chunk size for the per-row merge-updates (bounded write concurrency).
const UPDATE_CHUNK = 25

/**
 * Merge the aged-out marker into a proposal's existing `extra` — never clobber.
 * A whole-column write would drop load-bearing keys (e.g. assignee_ai_member_id)
 * and break reversibility, so the marker is merged. PostgREST can't express a
 * per-row `extra || marker` in one bulk update, hence the per-row read+merge in
 * ageOutCreateProposals. Pure so the merge shape is unit-tested directly.
 */
export function mergeAgeOutExtra(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(extra ?? {}), dismiss_reason: AGE_OUT_DISMISS_REASON }
}

/**
 * Distinct workspaces holding at least one stale CREATE proposal — the cron's
 * discovery query when no explicit `workspace` scope is given. Mirrors
 * ageOutCreateProposals' predicate exactly (pending, change_type='create', older
 * than cutoff) so a workspace appears here iff its per-workspace sweep would find
 * work. Ordered so discovery is deterministic tick to tick. `distinct` isn't a
 * PostgREST verb, so we page workspace_id ordered and dedupe in code; the scan is
 * bounded by `scanLimit` (a tick can't scan unboundedly on a large eligible set —
 * swept rows leave the set, so later ticks reach the tail).
 */
export async function discoverAgeOutWorkspaces(
  supabase: SupabaseClient,
  args: { cutoffIso: string; scanLimit: number },
): Promise<string[]> {
  const { data, error } = await supabase
    .from('proposed_change')
    .select('workspace_id')
    .eq('status', 'pending')
    .eq('change_type', 'create')
    .lt('created_at', args.cutoffIso)
    .order('workspace_id', { ascending: true })
    .limit(args.scanLimit)
  // The whole cron mode hangs off this one query — a swallowed error would
  // return an empty sweep indistinguishable from "nothing stale". Throw so the
  // route 500s and the failure is visible in cron monitoring.
  if (error) throw new Error(`age-out discovery failed: ${error.message}`)

  const rows = (data ?? []) as Array<{ workspace_id: string }>
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (!seen.has(r.workspace_id)) {
      seen.add(r.workspace_id)
      out.push(r.workspace_id)
    }
  }
  return out
}

/**
 * Dismiss stale CREATE proposals for one workspace. Selects the candidate set
 * (pending, change_type='create', older than cutoff) capped at `limit`, then
 * per-row CAS-updates status→dismissed with the merged marker. Never deletes,
 * never touches non-pending or non-create rows. Returns the count dismissed.
 */
export async function ageOutCreateProposals(
  supabase: SupabaseClient,
  args: { workspaceId: string; cutoffIso: string; limit: number },
): Promise<{ dismissed: number }> {
  const { data: candidates } = await supabase
    .from('proposed_change')
    .select('id, extra')
    .eq('status', 'pending')
    .eq('change_type', 'create')
    .eq('workspace_id', args.workspaceId)
    .lt('created_at', args.cutoffIso)
    .order('created_at', { ascending: true })
    .limit(args.limit)

  const rows = (candidates ?? []) as Array<{ id: string; extra: Record<string, unknown> | null }>
  if (rows.length === 0) return { dismissed: 0 }

  let dismissed = 0
  for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
    const chunk = rows.slice(i, i + UPDATE_CHUNK)
    const results = await Promise.all(
      chunk.map(async (row) => {
        // CAS on status='pending': a row applied/dismissed between the scan and
        // this write is skipped, never masked.
        const { data } = await supabase
          .from('proposed_change')
          .update({ status: 'dismissed', extra: mergeAgeOutExtra(row.extra) })
          .eq('id', row.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle()
        return data ? 1 : 0
      }),
    )
    for (const r of results) dismissed += r
  }
  return { dismissed }
}

export interface AgeOutWorkspaceResult {
  workspace_id: string
  dismissed: number
  job_recorded: boolean
}

/**
 * Run the per-workspace sweep across `workspaceIds` under a SHARED per-tick
 * budget. Each workspace consumes from `budget` (its own sweep is capped at the
 * remaining budget, never above AGE_OUT_BATCH), and iteration stops the instant
 * the budget is exhausted — a later workspace in the list is simply not reached
 * this tick. The next tick resumes naturally: swept rows leave the eligible set
 * (dismissed ≠ pending), so re-discovery skips finished workspaces and the tail
 * gets its turn. No cursor is needed. Per-workspace tracked_job rows and the
 * per-row CAS semantics of ageOutCreateProposals are preserved.
 */
export async function sweepWorkspaces(
  supabase: SupabaseClient,
  args: { workspaceIds: string[]; cutoffIso: string; budget: number },
): Promise<AgeOutWorkspaceResult[]> {
  const results: AgeOutWorkspaceResult[] = []
  let remaining = args.budget
  for (const workspaceId of args.workspaceIds) {
    if (remaining <= 0) break
    // Cap each workspace at AGE_OUT_BATCH (a single workspace can't churn more
    // than the batch cap in one tick) AND at the remaining shared budget.
    const { dismissed } = await ageOutCreateProposals(supabase, {
      workspaceId,
      cutoffIso: args.cutoffIso,
      limit: Math.min(remaining, AGE_OUT_BATCH),
    })
    remaining -= dismissed

    // Record ONE tracked_job as the Activity record for this sweep — the row
    // proves the sweep ran even when it dismissed nothing (observability).
    const memberId = await resolveOwnerMemberId(supabase, workspaceId)
    let jobRecorded = false
    if (memberId) {
      const job = await startWork(supabase, {
        workspaceId,
        memberId,
        // The Captures face is who ran it (row 4; the Reconciler until migration 318); null is fine.
        aiTeamMemberId: await systemTeammateId(supabase, workspaceId, 'captures'),
        kind: WORK_KINDS.proposalAgeOut,
        actor: 'loop',
        status: 'done',
        title: 'Age out stale proposals',
        resultSummary: `aged out ${dismissed} stale proposals`,
        source: { workspace_id: workspaceId, cutoff: args.cutoffIso, dismissed },
      })
      jobRecorded = !job.inert
    }
    results.push({ workspace_id: workspaceId, dismissed, job_recorded: jobRecorded })
  }
  return results
}

/** The workspace owner member — the Activity owner for a workspace-level sweep. */
async function resolveOwnerMemberId(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}
