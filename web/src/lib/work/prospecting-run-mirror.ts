/**
 * Prospecting runs in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 6): the `prospecting_run` row stays the source of truth;
 * its `tracked_job` row is the Activity projection, keyed `run_key =
 * prospecting_run.id` (kind `prospecting`).
 *
 *   mirrorProspectingRunQueued   createRun's insert — the row appears queued
 *   createProspectingRunMirror   the engine's `deps.work`: a step per progress
 *                                write, the settle at the terminal write
 *   settleProspectingWorkByRun   the writes outside the engine (the queued
 *                                cancel, the Inngest failure, the watchdog)
 *
 * The owner is the run's `started_by`, else the list's creator (a user deleted
 * since the run began). The run comes from a bot (bots-v4.md Phase 5): the
 * workspace's Researcher, else the Assistant (workTeammateId), stamped on the
 * ledger row only. Every function is fail-soft — the ledger never blocks a
 * run — and needs the SERVICE client: `tracked_job` has no client write policy.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, inertWork, startWork, type WorkHandle } from './recorder'
import { resolveMemberId } from './agent-run-mirror'
import { workTeammateId } from './system-teammates'
import { WORK_KINDS, type WorkDeliverable, type WorkProgress } from './types'
import type { ProspectingRunKind, ProspectingRunProgress, ProspectingRunStatus } from '@/lib/prospecting/types'

/** `budget_exhausted` carries one of these (src/lib/prospecting/spend.ts). */
const MONTHLY_CAP = 'monthly_cap'
const RUN_CAP = 'run_cap'

export interface ProspectingRunRef {
  id: string
  workspace_id: string
  list_id: string
  kind: ProspectingRunKind
  started_by: string | null
}

interface ListFacts {
  name: string | null
  createdBy: string | null
}

async function listFacts(supabase: SupabaseClient, workspaceId: string, listId: string): Promise<ListFacts> {
  const { data } = await supabase
    .from('prospect_list')
    .select('name, created_by')
    .eq('id', listId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const row = data as { name?: string | null; created_by?: string | null } | null
  return { name: row?.name ?? null, createdBy: row?.created_by ?? null }
}

/** "Finding companies for Q3 ICP" — what the run is doing, by kind. */
export function prospectingTitle(kind: ProspectingRunKind, listName: string | null): string {
  const list = listName?.trim() || 'a prospect list'
  if (kind === 'account_card') return `Researching accounts in ${list}`
  if (kind === 'people') return `Finding people in ${list}`
  return `Finding companies for ${list}`
}

/** The live step line and counters for a progress write; null when there is
 *  nothing new worth a line (the recorder coalesces bursts anyway). */
export function prospectingStep(
  kind: ProspectingRunKind,
  p: Partial<ProspectingRunProgress>,
): { text: string; progress: WorkProgress } | null {
  if (kind === 'discover') {
    if (p.stage === 'score') return { text: `Scoring ${p.found ?? 0} companies`, progress: { done: p.new ?? 0 } }
    const round = p.round ?? 0
    if (round <= 0) return { text: 'Starting the search', progress: {} }
    const max = p.max_rounds ? ` of ${p.max_rounds}` : ''
    return {
      text: `Round ${round}${max}: ${p.new ?? 0} new of ${p.found ?? 0} found`,
      progress: { done: p.new ?? 0 },
    }
  }
  const total = p.accounts_total ?? 0
  const done = p.accounts_done ?? 0
  if (kind === 'people') {
    return {
      text: `Finding people: ${done} of ${total} companies, ${p.people_found ?? 0} found`,
      progress: { done, total },
    }
  }
  return { text: `Researching account ${Math.min(done + 1, Math.max(total, 1))} of ${total}`, progress: { done, total } }
}

/** One line for the settled row. */
export function prospectingSummary(kind: ProspectingRunKind, newEntries: number, p: Partial<ProspectingRunProgress>): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (kind === 'account_card') return `Researched ${count(p.accounts_done ?? 0, 'company', 'companies')}`
  if (kind === 'people') return `Found ${count(newEntries, 'person', 'people')}`
  return `Found ${count(newEntries, 'new company', 'new companies')}`
}

function listDeliverable(listId: string, listName: string | null): WorkDeliverable {
  return { type: 'prospect_list', id: listId, label: listName?.trim() || 'Prospect list' }
}

async function handleForRun(supabase: SupabaseClient, runId: string): Promise<WorkHandle | null> {
  const row = await findWork(supabase, { runKey: runId, kind: WORK_KINDS.prospecting })
  return row ? attachWork(supabase, row) : null
}

/** createRun's insert: the run is on the ledger from the moment it exists. */
export async function mirrorProspectingRunQueued(supabase: SupabaseClient, run: ProspectingRunRef): Promise<WorkHandle> {
  try {
    const facts = await listFacts(supabase, run.workspace_id, run.list_id)
    const memberId =
      (await resolveMemberId(supabase, run.workspace_id, run.started_by)) ??
      (await resolveMemberId(supabase, run.workspace_id, facts.createdBy))
    if (!memberId) return inertWork({ kind: WORK_KINDS.prospecting, workspaceId: run.workspace_id, memberId: '' })
    // Who it comes from (Phase 5): attribution on the ledger row only.
    const aiTeamMemberId = await workTeammateId(supabase, { workspaceId: run.workspace_id, kind: 'prospecting', memberId })
    return await startWork(supabase, {
      workspaceId: run.workspace_id,
      memberId,
      aiTeamMemberId,
      kind: WORK_KINDS.prospecting,
      title: prospectingTitle(run.kind, facts.name),
      actor: 'agent',
      status: 'queued',
      runKey: run.id,
      source: {
        prospecting_run_id: run.id,
        list_id: run.list_id,
        run_kind: run.kind,
        entity_type: 'prospect_list',
        entity_id: run.list_id,
      },
    })
  } catch (err) {
    console.warn('[work] prospecting mirror (queued) failed:', err instanceof Error ? err.message : err)
    return inertWork({ kind: WORK_KINDS.prospecting, workspaceId: run.workspace_id, memberId: '' })
  }
}

export interface ProspectingSettle {
  status: ProspectingRunStatus
  error?: string | null
  newEntries?: number
  progress?: Partial<ProspectingRunProgress>
}

/** Map a terminal prospecting status onto the ledger row. */
async function settle(
  handle: WorkHandle,
  kind: ProspectingRunKind,
  list: { id: string; name: string | null },
  outcome: ProspectingSettle,
): Promise<void> {
  const summary = prospectingSummary(kind, outcome.newEntries ?? 0, outcome.progress ?? {})
  switch (outcome.status) {
    case 'completed':
      await handle.finish({ summary, deliverables: [listDeliverable(list.id, list.name)] })
      return
    case 'canceled':
      await handle.cancel('Stopped')
      return
    case 'failed':
      await handle.fail(outcome.error || 'The run failed')
      return
    case 'budget_exhausted':
      // Parked before any spend: nothing ran, so the row is skipped, not done.
      if (outcome.error === MONTHLY_CAP) {
        await handle.skip('Monthly prospecting budget reached')
        return
      }
      // Stopped at the run's own budget: what it found is kept (the tool docs
      // call this an outcome, not a failure).
      await handle.finish({
        summary: `Stopped at the run budget — ${summary}`,
        deliverables: [listDeliverable(list.id, list.name)],
      })
      return
    default:
      // queued | running | canceling | needs_input: not terminal.
      return
  }
}

export interface ProspectingRunMirror {
  /** After each progress write. */
  progress(p: ProspectingRunProgress): Promise<void>
  /** After THE terminal write (BaseRunState.finish). */
  settle(outcome: ProspectingSettle): Promise<void>
}

/** The engine's `deps.work`: resolves the ledger row once, lazily. */
export function createProspectingRunMirror(
  supabase: SupabaseClient,
  run: { id: string; workspaceId: string; listId: string; kind: ProspectingRunKind },
): ProspectingRunMirror {
  let resolved: Promise<{ handle: WorkHandle | null; listName: string | null }> | null = null
  const resolve = () =>
    (resolved ??= (async () => {
      const [handle, facts] = await Promise.all([
        handleForRun(supabase, run.id),
        listFacts(supabase, run.workspaceId, run.listId),
      ])
      return { handle, listName: facts.name }
    })().catch(() => ({ handle: null, listName: null })))
  return {
    async progress(p) {
      try {
        const step = prospectingStep(run.kind, p)
        if (!step) return
        const { handle } = await resolve()
        await handle?.step(step.text, step.progress)
      } catch (err) {
        console.warn('[work] prospecting mirror (step) failed:', err instanceof Error ? err.message : err)
      }
    },
    async settle(outcome) {
      try {
        const { handle, listName } = await resolve()
        if (!handle) return
        await settle(handle, run.kind, { id: run.listId, name: listName }, outcome)
      } catch (err) {
        console.warn('[work] prospecting mirror (settle) failed:', err instanceof Error ? err.message : err)
      }
    },
  }
}

/**
 * A terminal write made outside the engine — the queued cancel, the Inngest
 * failure writer, the watchdog. Only `failed` / `canceled` reach here, and the
 * ledger's own CAS keeps a late one honest: a prospecting row is never parked
 * in `needs_review` or `needs_input` (a completed run is `done`), so a failure
 * or cancel that lands after the run settled is refused by `fail()` /
 * `cancel()` exactly as the run row refused it.
 */
export async function settleProspectingWorkByRun(
  supabase: SupabaseClient,
  runId: string,
  outcome: { status: 'failed' | 'canceled'; error?: string | null },
): Promise<void> {
  try {
    const handle = await handleForRun(supabase, runId)
    if (!handle) return
    if (outcome.status === 'canceled') await handle.cancel('Stopped')
    else await handle.fail(outcome.error || 'The run failed')
  } catch (err) {
    console.warn('[work] prospecting mirror (external settle) failed:', err instanceof Error ? err.message : err)
  }
}
