import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Graveyard drain (loop-closure Phase 2, E1) + ongoing queue hygiene.
 *
 * The proposal queue accumulates a long tail: extraction stages proposals every
 * meeting, and the ones nobody acts on pile up until the queue is a graveyard
 * nobody trusts (measured 2026-07-03: 1,073 pending on prod, 739 of them older
 * than 30 days — 712 on one workspace). Triage can't sensibly review a
 * months-old item: "the meeting's moment passed." So we age them out by RULE — a
 * pure date sweep, no model calls — dismissing pending proposals older than a
 * horizon, with a machine marker so it's visible and reversible.
 *
 * SAFETY. The sweep only ever touches GENUINELY ABANDONED rows:
 *   • status = 'pending' (never applied/dismissed — the CAS is the .eq),
 *   • untouched: applied_at IS NULL AND result_entity_id IS NULL (a row that was
 *     partially applied is mid-flight, never swept — verified 0 such rows exist),
 *   • older than the horizon,
 *   • not a demo/onboarding proposal (its capture isn't metadata.demo).
 * It only DISMISSES (reversible: status flips back, the proposal is unchanged
 * otherwise) — it never deletes a proposal or touches the board. A dismissed
 * stale proposal that mattered resurfaces in a later meeting; a graveyard makes
 * the user stop looking. Absent beats a pile of noise.
 *
 * DRY RUN. `dryRun: true` returns the exact per-workspace counts WITHOUT writing,
 * so the supervised E1 drain (run with Liam present) previews precisely what it
 * will dismiss before committing.
 */

/** Default recurring-hygiene horizon. The one-time E1 drain passes 30 explicitly;
 *  the automatic cron uses a more conservative default so ongoing hygiene never
 *  races ahead of a user who's slow to triage. */
export const DEFAULT_AGE_OUT_DAYS = 30

export interface AgeOutOptions {
  /** Dismiss pending proposals created strictly before now - olderThanDays. */
  olderThanDays?: number
  /** Preview only — compute counts, write nothing. */
  dryRun?: boolean
  /** Scope to one workspace (the E1 supervised drain targets Corvanne); omit for
   *  the global recurring sweep. */
  workspaceId?: string
  /** Cap the number dismissed in one call (safety valve for the cron so a single
   *  tick can't churn thousands of rows). 0/undefined = no cap. */
  limit?: number
}

export interface AgeOutResult {
  dryRun: boolean
  olderThanDays: number
  cutoffIso: string
  /** Total pending proposals matching the stale predicate. */
  matched: number
  /** How many were actually dismissed (0 in dry run; may be < matched if capped). */
  dismissed: number
  /** Per-workspace matched counts, for the supervised preview. */
  byWorkspace: Array<{ workspace_id: string; matched: number }>
}

interface StaleRow {
  id: string
  workspace_id: string
}

/**
 * Age out stale pending proposals. Returns counts; writes only when !dryRun.
 * Never throws on a per-row basis — the whole sweep is a single guarded UPDATE.
 */
export async function ageOutStaleProposals(
  supabase: SupabaseClient,
  opts: AgeOutOptions = {},
): Promise<AgeOutResult> {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_AGE_OUT_DAYS
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  const cutoffIso = cutoff.toISOString()

  // The stale set: pending, untouched, older than cutoff, optional workspace
  // scope. Demo proposals are excluded via a second query (their capture is a
  // demo) — see filterOutDemo below.
  const rows = await selectStaleRows(supabase, cutoffIso, opts.workspaceId, opts.limit)
  const byWorkspace = tallyByWorkspace(rows)

  if (opts.dryRun || rows.length === 0) {
    return {
      dryRun: !!opts.dryRun,
      olderThanDays,
      cutoffIso,
      matched: rows.length,
      dismissed: 0,
      byWorkspace,
    }
  }

  // Execute via the RPC (migration 168): one atomic, guarded UPDATE that MERGES
  // the aged_out marker into each row's existing `extra` (a whole-column write
  // would clobber load-bearing keys like assignee_ai_member_id) and re-asserts
  // the full stale predicate at write time (CAS). The RPC — not this JS — is the
  // source of truth for what's dismissed, so the count is exactly what changed.
  const { data, error } = await supabase.rpc('age_out_stale_proposals', {
    p_cutoff: cutoffIso,
    p_workspace_id: opts.workspaceId ?? null,
    p_limit: opts.limit && opts.limit > 0 ? opts.limit : null,
  })
  if (error) throw new Error(`age_out_stale_proposals RPC failed: ${error.message}`)
  const dismissedRows = (data as unknown as StaleRow[] | null) ?? []

  return {
    dryRun: false,
    olderThanDays,
    cutoffIso,
    matched: rows.length,
    dismissed: dismissedRows.length,
    byWorkspace: tallyByWorkspace(dismissedRows.length ? dismissedRows : rows),
  }
}

/**
 * Select the stale set. Two-step so we can exclude demo proposals without a
 * fragile embedded filter: pull the candidate pending rows (with capture_id),
 * then drop any whose capture is a demo/onboarding capture.
 */
async function selectStaleRows(
  supabase: SupabaseClient,
  cutoffIso: string,
  workspaceId: string | undefined,
  limit: number | undefined,
): Promise<StaleRow[]> {
  let q = supabase
    .from('proposed_change')
    .select('id, workspace_id, capture_id')
    .eq('status', 'pending')
    .is('applied_at', null)
    .is('result_entity_id', null)
    // Exclude an orphaned partial-apply: a proposal whose side effect fired but
    // whose top-level status write was lost carries a marker in extra.applied_at
    // only. Never age those out (they'd mask an already-fired action). Matches
    // the RPC's guard so dry-run and execute agree. (Review: two-phase gap.)
    .is('extra->>applied_at', null)
    .lt('created_at', cutoffIso)
    .order('created_at', { ascending: true })
  if (workspaceId) q = q.eq('workspace_id', workspaceId)
  if (limit && limit > 0) q = q.limit(limit)

  const { data, error } = await q
  if (error || !data) return []
  const candidates = data as unknown as Array<{ id: string; workspace_id: string; capture_id: string | null }>
  return filterOutDemo(supabase, candidates)
}

/** Drop candidates whose capture is a demo/onboarding capture (metadata.demo).
 *  Fails SAFE: a candidate is swept ONLY if we positively resolved its capture as
 *  non-demo. If the demo lookup errors for a chunk, the captures in that chunk
 *  are treated as unverifiable → their candidates are excluded from the sweep. A
 *  missed age-out is harmless; sweeping a demo proposal is not. */
async function filterOutDemo(
  supabase: SupabaseClient,
  candidates: Array<{ id: string; workspace_id: string; capture_id: string | null }>,
): Promise<StaleRow[]> {
  const captureIds = [...new Set(candidates.map((c) => c.capture_id).filter((c): c is string => !!c))]
  if (captureIds.length === 0) {
    // No captures to check — every candidate is capture-less; none is a demo.
    return candidates.map((c) => ({ id: c.id, workspace_id: c.workspace_id }))
  }

  // Track the captures we could POSITIVELY classify. A capture ends up in
  // `verifiedNonDemo` only if its row came back and metadata.demo !== true.
  const verifiedNonDemo = new Set<string>()
  for (const chunk of chunkArray(captureIds, 200)) {
    const { data, error } = await supabase
      .from('captures')
      .select('id, metadata')
      .in('id', chunk)
    if (error || !data) continue // unverifiable chunk → its captures stay excluded
    for (const row of data as unknown as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      if (row.metadata?.demo !== true) verifiedNonDemo.add(row.id)
    }
  }

  // Sweep a candidate iff it's capture-less, or its capture was verified non-demo.
  return candidates
    .filter((c) => !c.capture_id || verifiedNonDemo.has(c.capture_id))
    .map((c) => ({ id: c.id, workspace_id: c.workspace_id }))
}

function tallyByWorkspace(rows: StaleRow[]): Array<{ workspace_id: string; matched: number }> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.workspace_id, (m.get(r.workspace_id) ?? 0) + 1)
  return [...m.entries()].map(([workspace_id, matched]) => ({ workspace_id, matched })).sort((a, b) => b.matched - a.matched)
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ── Attention-card grooming (the migration-165-promised sweep) ────────────────

/**
 * Expire pending attention cards past their expires_at. Migration 165 documents
 * that the rail's cards are "groomed by the flow-schedule cron so the rail can
 * never become a second graveyard" — this is that sweep. A pending card whose
 * TTL lapsed flips to 'expired' (terminal), so the rail (which filters to
 * pending + unexpired) stops showing it and it can't accumulate.
 */
export async function groomExpiredAttentionCards(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ expired: number }> {
  const nowIso = now.toISOString()
  const { data } = await supabase
    .from('attention_item')
    .update({ status: 'expired', resolved_at: nowIso })
    .eq('status', 'pending')
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso)
    .select('id')
  return { expired: (data as unknown as Array<{ id: string }> | null)?.length ?? 0 }
}
