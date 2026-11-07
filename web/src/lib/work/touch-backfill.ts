/**
 * The one-shot `work_touch` backfill (Sequence step 2, plan §2.3).
 *
 * Touches accumulate from the live write points in ./touch.ts from the day
 * they ship; this recovers what durable history can prove for the items that
 * settled before then, so the entity tab is not empty on day one. Reads were
 * never recorded and cannot be recovered — except the two the sources assert
 * by construction: an extraction pass read its capture, and a triggered flow
 * run read its subject. Per source:
 *
 *   tracked_job.deliverables[]                → delivered  (typed refs; `pr` is a
 *                                                URL and rides the agent_run row
 *                                                below; `attention_cards` is a
 *                                                count → one touch on the item's
 *                                                subject capture, none per card)
 *   flow_run.action_results[].verdict.entries → created / proposed / wrote
 *   flow_run.action_results[] output_document_id, archived_capture_id → delivered
 *   extraction_pass.capture_id + ledger.entries → read (the capture), created, proposed
 *   tracked_job.source.{entity_type, entity_id} → read (the triggering entity)
 *   agent_run.action_id (coding runs)         → wrote (the run's action)
 *   agent_run.resources[] with an id          → read, tool_name 'declared'
 *
 * Every other row carries tool_name 'backfill'. Idempotent: the runner skips
 * (work_item_id, entity_type, entity_id, verb) rows that already exist under
 * either marker, and the partial unique index in migration 280 backstops it.
 * The planner is pure and unit-tested; the runner pages tracked_job and joins
 * the four sources per page. DRY-RUN unless `apply` is true.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VerdictLedgerEntry } from '@/lib/flows/types'
import {
  TOUCH_VERBS,
  isUuid,
  touchesForDeliverables,
  touchesForVerdictEntries,
  type TouchVerb,
  type WorkTouchInput,
} from './touch'

export const BACKFILL_TOOL_NAME = 'backfill'
export const DECLARED_TOOL_NAME = 'declared'

/** The `tracked_job` columns the backfill reads. */
export interface BackfillJobRow {
  id: string
  workspace_id: string
  kind: string
  agent_run_id: string | null
  flow_run_id: string | null
  deliverables: unknown
  source: unknown
  created_at: string
}

/** What the runner joined for one job (any of them may be absent). */
export interface BackfillJobContext {
  flowRun?: { action_results: unknown } | null
  extractionPass?: { capture_id: string | null; ledger: unknown } | null
  agentRun?: { action_id: string | null; pr_url: string | null; resources: unknown } | null
  /** proposed_change.id → entity_type, for ledger entries that predate `entity_type`. */
  proposalKinds?: ReadonlyMap<string, string>
}

export type BackfillSource =
  | 'deliverables'
  | 'flow_verdict'
  | 'flow_output'
  | 'extraction'
  | 'source_entity'
  | 'agent_action'
  | 'declared_resources'

export interface PlannedTouch extends WorkTouchInput {
  source: BackfillSource
}

// ── Shape readers (jsonb in, typed out; anything malformed is skipped) ───────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A ledger entry as the jsonb holds it: proposal_id + outcome are required. */
function readLedgerEntries(v: unknown, proposalKinds?: ReadonlyMap<string, string>): VerdictLedgerEntry[] {
  const out: VerdictLedgerEntry[] = []
  for (const raw of asArray(v)) {
    const e = asRecord(raw)
    if (!e) continue
    const proposalId = str(e.proposal_id)
    const outcome = str(e.outcome)
    if (!proposalId || !outcome) continue
    const entityId = str(e.entity_id) ?? null
    const entityType = str(e.entity_type) ?? proposalKinds?.get(proposalId) ?? null
    out.push({
      proposal_id: proposalId,
      decision: (str(e.decision) ?? 'accept') as VerdictLedgerEntry['decision'],
      outcome: outcome as VerdictLedgerEntry['outcome'],
      reason: str(e.reason) ?? '',
      entity_id: entityId,
      entity_type: entityType,
    })
  }
  return out
}

/** The proposal ids of applied entries with no entity_type — what the runner must look up. */
export function proposalIdsNeedingKind(ledgerEntries: unknown): string[] {
  const ids: string[] = []
  for (const raw of asArray(ledgerEntries)) {
    const e = asRecord(raw)
    if (!e) continue
    if (str(e.outcome) === 'applied' && !str(e.entity_type) && isUuid(str(e.proposal_id))) ids.push(str(e.proposal_id)!)
  }
  return ids
}

/** The ledger entries a flow run's action_results carry (verdict-class run_skill actions). */
export function flowRunLedgerEntries(actionResults: unknown): unknown[] {
  const out: unknown[] = []
  for (const raw of asArray(actionResults)) {
    const r = asRecord(raw)
    const verdict = r ? asRecord(r.verdict) : null
    if (verdict) out.push(...asArray(verdict.entries))
  }
  return out
}

// ── The planner ─────────────────────────────────────────────────────────────

/**
 * Every touch the durable history proves for one job. Pure. Deduped by
 * (entity_type, entity_id, verb) — the first source to name a touch wins, so a
 * declared resource that a tool later read is one `read` row.
 */
export function planJobTouches(job: BackfillJobRow, ctx: BackfillJobContext = {}): PlannedTouch[] {
  const out: PlannedTouch[] = []
  const seen = new Set<string>()
  const add = (source: BackfillSource, entityType: string, entityId: unknown, verb: TouchVerb, toolName = BACKFILL_TOOL_NAME) => {
    if (!isUuid(entityId) || !TOUCH_VERBS.includes(verb)) return
    const id = (entityId as string).toLowerCase()
    const key = `${entityType}\u0000${id}\u0000${verb}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      source,
      workspaceId: job.workspace_id,
      workItemId: job.id,
      agentRunId: job.agent_run_id,
      entityType,
      entityId: id,
      verb,
      toolName,
      at: job.created_at,
    })
  }

  const source = asRecord(job.source) ?? {}
  const sourceType = str(source.entity_type)
  const sourceId = str(source.entity_id)

  // 1. Deliverables — the same mapping the live recorder uses. `attention_cards`
  //    carries a count, not ids: one delivered touch on the subject capture.
  const deliverables = asArray(job.deliverables)
    .map(asRecord)
    .filter((d): d is Record<string, unknown> => !!d && typeof d.type === 'string' && typeof d.id === 'string')
  for (const t of touchesForDeliverables(deliverables as Array<{ type: string; id: string; entity_type?: string }>)) {
    add('deliverables', t.entityType, t.entityId, t.verb)
  }
  if (deliverables.some((d) => d.type === 'attention_cards') && sourceType === 'capture') {
    add('deliverables', 'capture', sourceId, 'delivered')
  }

  // 2 + 3. A flow run's verdict ledger and its output/archive fields.
  if (ctx.flowRun) {
    const results = asArray(ctx.flowRun.action_results)
    for (const t of touchesForVerdictEntries(readLedgerEntries(flowRunLedgerEntries(results), ctx.proposalKinds))) {
      add('flow_verdict', t.entityType, t.entityId, t.verb)
    }
    for (const raw of results) {
      const r = asRecord(raw)
      if (!r) continue
      add('flow_output', 'document', r.output_document_id, 'delivered')
      add('flow_output', 'capture', r.archived_capture_id, 'delivered')
    }
  }

  // 4. An extraction pass: it read its capture by definition; applied entries
  //    created, staged entries proposed (the live hook's exact rules).
  if (ctx.extractionPass) {
    const ledger = asRecord(ctx.extractionPass.ledger)
    add('extraction', 'capture', ctx.extractionPass.capture_id ?? source.capture_id, 'read')
    for (const t of touchesForVerdictEntries(readLedgerEntries(ledger?.entries, ctx.proposalKinds))) {
      add('extraction', t.entityType, t.entityId, t.verb)
    }
  } else if (str(source.extraction_pass_id) || job.kind === 'extraction') {
    // The pass row is gone (or was never written): the capture read still holds.
    add('extraction', 'capture', source.capture_id, 'read')
  }

  // 5. The triggering entity of a flow run (startFlowWork stamps it).
  if (sourceType && sourceId) add('source_entity', sourceType, sourceId, 'read')

  // 6 + 7. The agent run: a coding run wrote its action; declared resources were read.
  if (ctx.agentRun) {
    if (ctx.agentRun.action_id) add('agent_action', 'action', ctx.agentRun.action_id, 'wrote')
    for (const raw of asArray(ctx.agentRun.resources)) {
      const r = asRecord(raw)
      if (!r || typeof r.type !== 'string' || r.type === 'package') continue
      add('declared_resources', r.type, r.id, 'read', DECLARED_TOOL_NAME)
    }
  }

  return out
}

// ── The runner ──────────────────────────────────────────────────────────────

export interface BackfillSummary {
  jobsScanned: number
  jobsWithTouches: number
  planned: number
  skippedExisting: number
  written: number
  byVerb: Record<string, number>
  bySource: Record<string, number>
}

export interface BackfillOptions {
  apply: boolean
  workspaceId?: string | null
  pageSize?: number
  log?: (line: string) => void
}

const IN_CHUNK = 200

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

async function selectIn<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  ids: string[],
): Promise<T[]> {
  const rows: T[] = []
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await supabase.from(table).select(columns).in(column, part)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
  }
  return rows
}

/**
 * Page tracked_job, join the sources per page, plan, drop what already exists,
 * insert (when `apply`). Throws on a read error (a partial backfill is fine to
 * re-run; a silently short one is not).
 */
export async function runWorkTouchBackfill(supabase: SupabaseClient, opts: BackfillOptions): Promise<BackfillSummary> {
  const log = opts.log ?? (() => {})
  const pageSize = opts.pageSize ?? 500
  const summary: BackfillSummary = {
    jobsScanned: 0,
    jobsWithTouches: 0,
    planned: 0,
    skippedExisting: 0,
    written: 0,
    byVerb: {},
    bySource: {},
  }

  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from('tracked_job')
      .select('id, workspace_id, kind, agent_run_id, flow_run_id, deliverables, source, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId)
    const { data, error } = await q
    if (error) throw new Error(`tracked_job: ${error.message}`)
    const jobs = (data ?? []) as BackfillJobRow[]
    if (jobs.length === 0) break
    summary.jobsScanned += jobs.length

    // Joins for the page.
    const flowRunIds = jobs.map((j) => j.flow_run_id).filter(isUuid) as string[]
    const agentRunIds = jobs.map((j) => j.agent_run_id).filter(isUuid) as string[]
    const passIds = jobs
      .map((j) => str(asRecord(j.source)?.extraction_pass_id))
      .filter(isUuid) as string[]
    const flowRuns = new Map(
      (await selectIn<{ id: string; action_results: unknown }>(supabase, 'flow_run', 'id, action_results', 'id', flowRunIds)).map((r) => [r.id, r]),
    )
    const agentRuns = new Map(
      (
        await selectIn<{ id: string; action_id: string | null; pr_url: string | null; resources: unknown }>(
          supabase,
          'agent_run',
          'id, action_id, pr_url, resources',
          'id',
          agentRunIds,
        )
      ).map((r) => [r.id, r]),
    )
    const passes = new Map(
      (
        await selectIn<{ id: string; capture_id: string | null; ledger: unknown }>(supabase, 'extraction_pass', 'id, capture_id, ledger', 'id', passIds)
      ).map((r) => [r.id, r]),
    )
    const needKind: string[] = []
    for (const fr of flowRuns.values()) needKind.push(...proposalIdsNeedingKind(flowRunLedgerEntries(fr.action_results)))
    for (const p of passes.values()) needKind.push(...proposalIdsNeedingKind(asRecord(p.ledger)?.entries))
    const proposalKinds = new Map(
      (await selectIn<{ id: string; entity_type: string }>(supabase, 'proposed_change', 'id, entity_type', 'id', needKind)).map((r) => [
        r.id,
        r.entity_type,
      ]),
    )

    // Plan.
    const planned: PlannedTouch[] = []
    for (const job of jobs) {
      const touches = planJobTouches(job, {
        flowRun: job.flow_run_id ? flowRuns.get(job.flow_run_id) ?? null : null,
        agentRun: job.agent_run_id ? agentRuns.get(job.agent_run_id) ?? null : null,
        extractionPass: (() => {
          const id = str(asRecord(job.source)?.extraction_pass_id)
          return id ? passes.get(id) ?? null : null
        })(),
        proposalKinds,
      })
      if (touches.length > 0) summary.jobsWithTouches += 1
      planned.push(...touches)
    }
    summary.planned += planned.length

    // Drop what an earlier run already wrote.
    const existing = new Set<string>()
    const existingRows = await selectIn<{ work_item_id: string; entity_type: string; entity_id: string; verb: string; tool_name: string | null }>(
      supabase,
      'work_touch',
      'work_item_id, entity_type, entity_id, verb, tool_name',
      'work_item_id',
      jobs.map((j) => j.id),
    )
    for (const r of existingRows) {
      if (r.tool_name === BACKFILL_TOOL_NAME || r.tool_name === DECLARED_TOOL_NAME) {
        existing.add(`${r.work_item_id}\u0000${r.entity_type}\u0000${r.entity_id}\u0000${r.verb}`)
      }
    }
    const fresh = planned.filter((t) => !existing.has(`${t.workItemId}\u0000${t.entityType}\u0000${t.entityId}\u0000${t.verb}`))
    summary.skippedExisting += planned.length - fresh.length
    for (const t of fresh) {
      summary.byVerb[t.verb] = (summary.byVerb[t.verb] ?? 0) + 1
      summary.bySource[t.source] = (summary.bySource[t.source] ?? 0) + 1
    }
    log(`page ${from / pageSize + 1}: ${jobs.length} jobs, ${planned.length} planned, ${fresh.length} to write`)

    if (opts.apply && fresh.length > 0) {
      for (const part of chunk(fresh, 500)) {
        const { error: insertError } = await supabase.from('work_touch').insert(
          part.map((t) => ({
            workspace_id: t.workspaceId,
            work_item_id: t.workItemId,
            agent_run_id: isUuid(t.agentRunId) ? t.agentRunId : null,
            entity_type: t.entityType,
            entity_id: t.entityId,
            verb: t.verb,
            tool_name: t.toolName ?? null,
            at: t.at,
          })),
        )
        if (insertError) throw new Error(`work_touch insert: ${insertError.message}`)
        summary.written += part.length
      }
    }

    if (jobs.length < pageSize) break
  }

  return summary
}
