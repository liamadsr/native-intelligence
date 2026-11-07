/**
 * The first-class extraction ledger (One Accept Authority, W-3).
 *
 * The verdict authority (verdict-apply.ts) records exactly what it decided AND
 * did in a VerdictLedger. The extraction authority (live-agent/route.ts, live
 * turns and batch) recorded NOTHING — its board writes were reconstructed
 * on the READ side by a heuristic partitioning auto_accepted+applied proposals by
 * (capture, apply-hour). NORTH-STAR invariant 4: "every fire, skip, pause, and
 * failure has a ledger row in Activity" — a reconstructed row is not a recorded
 * one.
 *
 * This module is the recorder: an extraction apply pass accumulates verdict-
 * shaped entries (the SAME VerdictLedgerEntry shape verdict-apply writes) and
 * flushes ONE `extraction_pass` row per pass, plus the pass's row in the work
 * ledger (the Activity surface reads that one; extraction_pass stays the
 * verdict-shaped audit record).
 *
 * SERVICE-ROLE WRITE. extraction_pass has RLS with a member SELECT policy and NO
 * insert policy (migration 206) — the ledger is server-authored, like flow_run.
 * The flush therefore goes through getServiceClient(), NOT the request-scoped
 * client: the live routes authenticate real web/desktop captures with a Supabase
 * JWT (role `authenticated`), which RLS would silently deny — the ledger would
 * never persist and the read-side heuristic would never retire. Because the
 * service client bypasses RLS, the caller MUST pass workspaceId/captureId from
 * its already-authenticated request context (both routes resolve the workspace
 * server-side and fetch the capture fenced to it) — never from raw client input.
 *
 * BEST-EFFORT: the recorder never throws and the flush swallows its own error.
 * The extraction pass has already committed its board writes by the time it
 * flushes — a failed ledger insert must never fail the pass or roll anything
 * back. A missing pass row degrades to the read-side heuristic, exactly as
 * pre-migration history does.
 */

import { getServiceClient } from '@/lib/supabase/service'
import { recordExtractionTouches } from '@/lib/work/touch'
import { startWork } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import { systemTeammateId } from '@/lib/work/system-teammates'
import type { VerdictLedgerEntry } from '@/lib/flows/types'

/** The verdict-shaped ledger persisted per extraction pass. `entries` reuses the
 *  exact VerdictLedgerEntry shape so the read side maps it with the verdict
 *  path's machinery. */
export interface ExtractionLedger {
  entries: VerdictLedgerEntry[]
  applied_count: number
  staged_count: number
}

/**
 * Accumulates verdict-shaped entries across one extraction apply pass, then
 * flushes a single `extraction_pass` row. One instance per stage/batch call.
 */
export class ExtractionLedgerRecorder {
  private readonly entries: VerdictLedgerEntry[] = []

  /** Record a proposal the gate APPLIED (auto-accepted onto the board). `outcome`
   *  is 'applied' — the same outcome verdict-apply stamps on an auto-applied
   *  accept — so the read side counts it identically. */
  applied(proposalId: string, entityId: string | null | undefined, reason: string): void {
    this.entries.push({
      proposal_id: proposalId,
      decision: 'accept',
      outcome: 'applied',
      reason,
      entity_id: entityId ?? null,
    })
  }

  /**
   * Record a proposal the gate STAGED (left pending for the verdict run / the
   * human). Outcome 'carded' — the item is a card/pending item, the same outcome
   * verdict-apply stamps when its gate declines an accept. This is the surface
   * the heuristic could never see: an item the gate WOULD have applied under a
   * looser policy, now recorded as a deliberate absence.
   */
  staged(proposalId: string, reason: string): void {
    this.entries.push({
      proposal_id: proposalId,
      decision: 'accept',
      outcome: 'carded',
      reason,
    })
  }

  /** True iff nothing was recorded — the caller can skip the flush entirely (an
   *  empty pass is not activity, exactly like a no-op verdict run). */
  isEmpty(): boolean {
    return this.entries.length === 0
  }

  /** The accumulated ledger, ready to persist or inspect (tests read this). */
  build(): ExtractionLedger {
    let applied = 0
    let staged = 0
    for (const e of this.entries) {
      if (e.outcome === 'applied') applied++
      else staged++
    }
    return { entries: [...this.entries], applied_count: applied, staged_count: staged }
  }

  /**
   * Flush the pass to `extraction_pass` through the SERVICE-ROLE client (the
   * table is server-authored: RLS has no insert policy, and the request-scoped
   * client runs as `authenticated` for real web/desktop captures — see the module
   * doc). `workspaceId`/`captureId` MUST come from the caller's authenticated
   * request context, never client input, since the service client bypasses RLS.
   *
   * Best-effort and non-throwing: the board writes already committed, so a failed
   * insert is logged (the '[extraction-ledger] flush failed' breadcrumb) and
   * swallowed — the read side falls back to the heuristic for this capture, as
   * with pre-migration history. No-op when nothing was recorded.
   */
  async flush(opts: {
    workspaceId: string
    captureId: string
    mode: 'live' | 'batch'
    /**
     * The work ledger's view of this pass (ACTIVITY-AND-REVIEW-DESIGN §5): one
     * `extraction` item owned by the member whose extraction ran, recorded in a
     * single write once the pass is over. Omitted when the caller has no member
     * in scope — the extraction_pass row is still written.
     */
    work?: { memberId: string; captureTitle: string | null }
  }): Promise<void> {
    if (this.isEmpty()) return
    let supabase: ReturnType<typeof getServiceClient>
    // The pass row's id, so the work item can name the pass it records (the
    // Activity panel reads the pass's entries back through it). Null when the
    // insert failed — the item still gets written and the read side falls back
    // to matching the pass by capture and time.
    let passId: string | null = null
    try {
      supabase = getServiceClient()
      const { data, error } = await supabase
        .from('extraction_pass')
        .insert({
          workspace_id: opts.workspaceId,
          capture_id: opts.captureId,
          mode: opts.mode,
          ledger: this.build(),
        })
        .select('id')
        .single()
      if (error) {
        console.warn(
          `[extraction-ledger] flush failed (capture ${opts.captureId}): ${error.message}`,
        )
      } else {
        passId = (data as { id?: string } | null)?.id ?? null
      }
    } catch (err) {
      console.warn(
        `[extraction-ledger] flush failed (capture ${opts.captureId}, threw):`,
        err instanceof Error ? err.message : err,
      )
      return
    }
    if (!opts.work) return
    // startWork never throws (an insert failure yields an inert handle and logs).
    const { applied_count, staged_count } = this.build()
    const title = opts.work.captureTitle?.trim() || 'a capture'
    const handle = await startWork(supabase, {
      workspaceId: opts.workspaceId,
      memberId: opts.work.memberId,
      // The Captures face is who ran it (row 4; Extraction until migration 318); null is fine.
      aiTeamMemberId: await systemTeammateId(supabase, opts.workspaceId, 'captures'),
      kind: WORK_KINDS.extraction,
      actor: 'loop',
      title: `Extracting from ${title}`,
      status: 'done',
      resultSummary: summarizeExtraction(applied_count, staged_count),
      progress: { applied: applied_count, staged: staged_count },
      deliverables: [{ type: 'capture', id: opts.captureId, label: title }],
      source: {
        capture_id: opts.captureId,
        mode: opts.mode,
        ...(passId ? { extraction_pass_id: passId } : {}),
      },
    })
    // Sequence step 2: the pass read its capture, created what it applied and
    // proposed what it staged — as touches on the item (fail-soft).
    if (!handle.inert && handle.id) {
      await recordExtractionTouches(supabase, {
        workspaceId: opts.workspaceId,
        workItemId: handle.id,
        captureId: opts.captureId,
        entries: this.entries,
      })
    }
  }
}

/** "Filed 3, staged 2 for review" — the settle line for the Activity row. */
export function summarizeExtraction(applied: number, staged: number): string {
  const parts: string[] = []
  if (applied > 0) parts.push(`Filed ${applied}`)
  if (staged > 0) parts.push(`${applied > 0 ? 'staged' : 'Staged'} ${staged} for review`)
  return parts.length > 0 ? parts.join(', ') : 'Nothing to file'
}
