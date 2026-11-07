/**
 * Eval runs in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 6): the `eval_run` row stays the source of truth; its
 * `tracked_job` row (kind `eval`, `run_key = eval_run.id`) is the Activity
 * projection.
 *
 *   mirrorEvalRunQueued     startEvalRun's insert
 *   stepEvalWork            the lane's claim and per-trial progress writes
 *   settleEvalWorkFromRow   after ANY terminal write (the lane's settle, its
 *                           failRun, cancelEvalRun): reads the row as stored
 *                           and mirrors THAT, so a write that lost a race is
 *                           never projected
 *
 * A completed run with failing trials lands in Needs you (there is something
 * to look at); a clean one is done. The run comes from a bot (bots-v4.md
 * Phase 5, workTeammateId): the teammate that holds the suite's target skill,
 * else the workspace's Developer, else the Assistant, stamped on the ledger
 * row only. Every function is fail-soft and needs the SERVICE client
 * (`tracked_job` has no client write policy).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, inertWork, startWork, type WorkHandle } from './recorder'
import { resolveMemberId } from './agent-run-mirror'
import { workTeammateId } from './system-teammates'
import { WORK_KINDS, type WorkProgress } from './types'

function warn(what: string, err: unknown) {
  console.warn(`[work] eval mirror (${what}) failed:`, err instanceof Error ? err.message : err)
}

async function handleForRun(supabase: SupabaseClient, runId: string): Promise<WorkHandle | null> {
  const row = await findWork(supabase, { runKey: runId, kind: WORK_KINDS.eval })
  return row ? attachWork(supabase, row) : null
}

export interface EvalRunRef {
  id: string
  workspace_id: string
  suite_id: string
  mode: string
  started_by: string | null
}

export async function mirrorEvalRunQueued(supabase: SupabaseClient, run: EvalRunRef): Promise<WorkHandle> {
  try {
    const memberId = await resolveMemberId(supabase, run.workspace_id, run.started_by)
    if (!memberId) return inertWork({ kind: WORK_KINDS.eval, workspaceId: run.workspace_id, memberId: '' })
    const { data: suite } = await supabase
      .from('eval_suite')
      .select('name, target_kind, target_recipe_id')
      .eq('id', run.suite_id)
      .eq('workspace_id', run.workspace_id)
      .maybeSingle()
    const facts = suite as { name?: string | null; target_kind?: string | null; target_recipe_id?: string | null } | null
    const name = (facts?.name ?? '').trim() || 'an eval suite'
    // Who it comes from (Phase 5): the holder of the skill it evaluates, else
    // the Developer, else the Assistant. Attribution on the ledger row only.
    const skillIds = facts?.target_kind === 'skill' && facts.target_recipe_id ? [facts.target_recipe_id] : []
    const aiTeamMemberId = await workTeammateId(supabase, { workspaceId: run.workspace_id, kind: 'eval', memberId, skillIds })
    return await startWork(supabase, {
      workspaceId: run.workspace_id,
      memberId,
      aiTeamMemberId,
      kind: WORK_KINDS.eval,
      title: `Evaluating ${name} (${run.mode})`,
      actor: 'agent',
      status: 'queued',
      runKey: run.id,
      source: { eval_run_id: run.id, suite_id: run.suite_id, mode: run.mode, entity_type: 'eval_suite', entity_id: run.suite_id },
    })
  } catch (err) {
    warn('queued', err)
    return inertWork({ kind: WORK_KINDS.eval, workspaceId: run.workspace_id, memberId: '' })
  }
}

/** A live step on the run's row (flips it queued → running). */
export async function stepEvalWork(supabase: SupabaseClient, runId: string, text: string, progress?: WorkProgress): Promise<void> {
  try {
    const handle = await handleForRun(supabase, runId)
    await handle?.step(text, progress)
  } catch (err) {
    warn('step', err)
  }
}

interface StoredRun {
  status: string
  outcome: string | null
  error_code: string | null
  error_message: string | null
  progress: { trials_done?: number; trials_total?: number } | null
}

/** "12 trials, all passed" — one line for the settled row. */
export function evalSummary(run: StoredRun, failingTrials: number): string {
  const done = run.progress?.trials_done ?? 0
  const total = run.progress?.trials_total ?? done
  const trials = `${done} trial${done === 1 ? '' : 's'}`
  if (run.outcome === 'failed') {
    return failingTrials > 0 ? `${failingTrials} of ${trials} failed` : `Failed — ${trials}`
  }
  if (run.outcome === 'scored') return `${trials}, some soft checks missed`
  if (run.outcome === 'passed') return `${trials}, all passed`
  return total > done ? `${done} of ${total} trials` : trials
}

/** Mirror the run as it is STORED after a terminal write. */
export async function settleEvalWorkFromRow(supabase: SupabaseClient, runId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('eval_run')
      .select('status, outcome, error_code, error_message, progress')
      .eq('id', runId)
      .maybeSingle()
    const run = data as StoredRun | null
    if (!run || run.status === 'queued' || run.status === 'running') return
    const handle = await handleForRun(supabase, runId)
    if (!handle) return

    if (run.status === 'completed') {
      let failing = 0
      if (run.outcome === 'failed') {
        const { count } = await supabase
          .from('eval_trial')
          .select('id', { count: 'exact', head: true })
          .eq('run_id', runId)
          .in('outcome', ['failed', 'errored'])
        failing = count ?? 0
      }
      const summary = evalSummary(run, failing)
      // Failing trials are something to look at: Needs you, not Recent.
      await handle.finish(run.outcome === 'failed' ? { summary, review: { kind: 'review', verb: 'check' } } : { summary })
      return
    }
    if (run.status === 'cancelled') {
      // Stopped at its budget: the trials that ran are real results.
      if (run.error_code === 'budget') {
        await handle.finish({ summary: `Stopped at the eval budget — ${evalSummary(run, 0)}` })
        return
      }
      await handle.cancel('Cancelled')
      return
    }
    if (run.status === 'failed') {
      await handle.fail(
        run.error_code === 'usage_limit'
          ? `AI usage limit reached${run.error_message ? `: ${run.error_message}` : ''}`
          : run.error_message || run.error_code || 'The eval run failed',
      )
    }
  } catch (err) {
    warn('settle', err)
  }
}
