/**
 * CRM enrichment in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 11). Enrichment has no run row: each contact / company
 * carries its own `enrichment_status` + `enriched_at` (migration 239), and the
 * work is one Inngest run per record. The ledger gets one kind of row, kind
 * `crm_enrichment`:
 *
 *   A ROW PER REQUEST ("Enriching Dana Lee"): an Enrich click or a yes to the
 *   chat's enrich_contact, owned by the person who asked, started by the
 *   sender and settled by the handler with the run's own outcome (skipped when
 *   the usage guard blocks it; failed when the event cannot be sent). A run
 *   that throws through its retries writes no outcome, so the reaper fails its
 *   row after MANUAL_RUNNING_DEADLINE_MS ("No report back") — which is what
 *   happened.
 *
 * There used to be a SWEEP row per half-hourly cron tick as well. Enrichment
 * no longer runs on its own (src/lib/inngest/crm-enrichment.ts says why), so
 * the sweep, its rows and their settling are gone; a sweep row still open
 * from before is failed by the reaper at its own deadline.
 *
 * Quiet: a failed enrichment is a per-record outcome the CRM already shows on
 * the record; the ledger sends no push for it.
 *
 * The row comes from a bot (bots-v4.md Phase 5, workTeammateId): the
 * workspace's Researcher that the row's owner can reach, else the Assistant,
 * stamped on the ledger row only. So the run sits on that bot's page, not in
 * an "Enrichment" lane.
 *
 * Service client only; every function is fail-soft.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, startWork } from './recorder'
import { resolveMemberId } from './agent-run-mirror'
import { workTeammateId } from './system-teammates'
import { recordWorkTouches } from './touch'
import { WORK_KINDS } from './types'

export type EnrichTable = 'contact' | 'company'

/** A manual run: one record, up to three deep searches in sequence. */
export const MANUAL_RUNNING_DEADLINE_MS = 30 * 60_000

function warn(what: string, err: unknown) {
  console.warn(`[work] enrichment mirror (${what}) failed:`, err instanceof Error ? err.message : err)
}

/** "insufficient identity signal" → "Insufficient identity signal". */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ── A manual Enrich ──────────────────────────────────────────────────────────

export interface ManualEnrich {
  workspaceId: string
  userId: string
  table: EnrichTable
  recordId: string
  name: string | null
}

/**
 * Open the row for one Enrich click; returns the run key the event carries so
 * the handler can settle it (null when there is no row to settle).
 */
export async function openManualEnrichment(supabase: SupabaseClient, m: ManualEnrich): Promise<string | null> {
  try {
    const memberId = await resolveMemberId(supabase, m.workspaceId, m.userId)
    if (!memberId) return null
    // One row per click: two clicks in the same millisecond are still two runs.
    const runKey = `manual:${m.table}:${m.recordId}:${randomUUID()}`
    const aiTeamMemberId = await workTeammateId(supabase, { workspaceId: m.workspaceId, kind: 'crm_enrichment', memberId })
    const handle = await startWork(supabase, {
      workspaceId: m.workspaceId,
      memberId,
      aiTeamMemberId,
      kind: WORK_KINDS.crmEnrichment,
      title: `Enriching ${m.name?.trim() || `a ${m.table}`}`,
      actor: 'system',
      status: 'queued',
      runKey,
      quiet: true,
      deadlines: { running: MANUAL_RUNNING_DEADLINE_MS },
      source: { table: m.table, record_id: m.recordId, entity_type: m.table, entity_id: m.recordId },
    })
    return handle.inert ? null : runKey
  } catch (err) {
    warn('open manual', err)
    return null
  }
}

async function manualHandle(supabase: SupabaseClient, runKey: string) {
  const row = await findWork(supabase, { kind: WORK_KINDS.crmEnrichment, runKey })
  return row ? attachWork(supabase, row, { running: MANUAL_RUNNING_DEADLINE_MS }) : null
}

/** The handler picked the run up. */
export async function stepManualEnrichment(supabase: SupabaseClient, runKey: string | null | undefined): Promise<void> {
  if (!runKey) return
  try {
    const handle = await manualHandle(supabase, runKey)
    if (!handle) return
    await handle.step('Searching the web')
    await handle.flush()
  } catch (err) {
    warn('step manual', err)
  }
}

export interface EnrichOutcomeLike {
  status: 'enriched' | 'failed' | 'skipped'
  applied?: unknown[]
  reason?: string
  error?: string
}

/** Settle the click's row with the run's own outcome. */
export async function settleManualEnrichment(
  supabase: SupabaseClient,
  runKey: string | null | undefined,
  outcome: EnrichOutcomeLike,
  record: { workspaceId: string; table: EnrichTable; recordId: string },
): Promise<void> {
  if (!runKey) return
  try {
    const handle = await manualHandle(supabase, runKey)
    if (!handle) return
    if (outcome.status === 'enriched') {
      const applied = Array.isArray(outcome.applied) ? outcome.applied.length : 0
      if (handle.id) {
        await recordWorkTouches(supabase, [
          {
            workspaceId: record.workspaceId,
            workItemId: handle.id,
            entityType: record.table,
            entityId: record.recordId,
            verb: 'wrote',
            toolName: 'enrichment',
          },
        ])
      }
      await handle.finish({
        summary: applied > 0 ? `Filled ${applied} field${applied === 1 ? '' : 's'}` : 'Refreshed; no empty fields to fill',
      })
    } else if (outcome.status === 'skipped') {
      await handle.skip(outcome.reason ? sentence(outcome.reason.replace(/_/g, ' ')) : 'Nothing to search for')
    } else {
      await handle.fail(outcome.error || 'Enrichment failed')
    }
  } catch (err) {
    warn('settle manual', err)
  }
}
