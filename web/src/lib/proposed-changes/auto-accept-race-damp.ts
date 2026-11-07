import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionCandidate } from './resolve-action-target'

/**
 * Extraction auto-accept RACE DAMP (loop-closure Phase 2, E3).
 *
 * The race (F3 / GEN-593/596): two overlapping captures of the same meeting each
 * extract the same commitment minutes apart. The first capture's auto-accept
 * creates the action; the second capture's auto-accept fires BEFORE the Triage
 * loop can dedupe it, so a near-duplicate lands on the board. Triage (act mode,
 * cross-capture context) is the right place to MERGE duplicates — but it can't
 * un-ring an auto-accept that already happened. So we damp at the source: when a
 * create:action proposal near-duplicates an action that was created VERY
 * RECENTLY, we withhold the AUTOMATIC apply and leave the proposal pending — it
 * becomes an attention card / stays in the capture for the human (or Triage) to
 * decide. Nothing is dropped, converted, or merged.
 *
 * WHY THIS IS SAFE WHERE GEN-137 WAS NOT. GEN-137 was pulled because it reused
 * the fuzzy matcher to make an IDENTITY decision at STAGING time — converting or
 * dropping the proposal, so a false positive silently destroyed real work. This
 * damp is different on both axes:
 *   1. It fires at AUTO-APPLY time, not staging. A false positive here only
 *      WITHHOLDS the automatic apply — the exact outcome you'd get with
 *      auto-accept turned off. The proposal is fully preserved as a pending
 *      card; the human still sees it and can accept it. No work is ever lost.
 *   2. It refuses on EXACT normalized-title match ONLY. GEN-137's silent-drop
 *      bug came from fuzzy tiers folding distinct tasks: the loose 0.6
 *      token-overlap tier ("Add API logging" vs "Add BFF logging" = 0.80), but
 *      ALSO — as this feature's own adversarial review found — the CONTAINMENT
 *      tier ("Update the checklist" vs "Update the checklist and record the
 *      loom") and the IDENTIFIER tier ("write tests for GEN-42" vs an unrelated
 *      action that happens to be GEN-42). All three refuse legitimately-DISTINCT
 *      new work. So the damp uses NONE of them: it refuses only when the
 *      proposal's normalized title is EXACTLY EQUAL to a recent action's — the
 *      one relation where "these are the same action" is reliable. And only
 *      against actions created inside the race window (default 6h): an
 *      identical-title action from three months ago is normal recurring work,
 *      not the race, so it never triggers a refusal.
 *
 * Pure + synchronous: the caller supplies the recent-action candidate pool and
 * the clock. Zero I/O here, so it's fully unit-testable.
 */

/** Kill switch, mirroring GEN-138's EXTRACTION_GUARDRAIL_ENABLED. Flip to false
 *  to disable the race damp everywhere (both auto-apply sites read this). */
export const RACE_DAMP_ENABLED = true

/** How recent a matching action must be to count as "the race" and not just
 *  recurring work with a shared title. */
export const RACE_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours

export interface RaceCandidateAction extends ActionCandidate {
  /** ISO timestamp the action was created. Used to bound the race window. */
  created_at: string | null
  /** Workflow-state category — completed/canceled actions never count (a done
   *  item sharing a title is not a live duplicate). */
  status_category?: string | null
}

export interface RaceDampProposal {
  change_type: string
  entity_type: string
  title: string | null
  display_text: string | null
}

export interface RaceDampDecision {
  /** True → withhold the AUTOMATIC apply; leave the proposal pending. */
  refuse: boolean
  /** The action id we matched against (for the marker / audit), when refusing. */
  matched_action_id?: string
  /** Human-readable reason for the guardrail marker. */
  note?: string
}

const NO_REFUSAL: RaceDampDecision = { refuse: false }

/**
 * Decide whether to withhold auto-accept for a create:action proposal because an
 * identically-titled action was JUST created (the overlapping-capture race).
 *
 * Refuses ONLY when ALL hold:
 *   • the proposal is a create:action,
 *   • a candidate action created within RACE_WINDOW_MS of `now` (and not
 *     completed/canceled) has a normalized title EXACTLY EQUAL to the proposal's
 *     normalized title (or display_text).
 *
 * Exact-title-only is deliberate (this feature's adversarial review): the
 * containment and identifier tiers both refuse legitimately-distinct new work (a
 * scoped variant of a task, or a follow-up that references a ticket id), so they
 * are NOT used. Only exact equality reliably means "the same action."
 *
 * Otherwise returns { refuse: false } and the proposal auto-applies as before.
 */
export function shouldRefuseAutoAccept(
  proposal: RaceDampProposal,
  candidates: RaceCandidateAction[],
  now: number,
): RaceDampDecision {
  // Scope: only brand-new action creates. Updates/assigns/decisions/external are
  // never damped here (an update TO an existing action is the opposite of a dup).
  if (proposal.change_type !== 'create' || proposal.entity_type !== 'action') {
    return NO_REFUSAL
  }

  // The proposal's normalized title(s). display_text is included because a
  // create:action's display_text is usually the title verbatim.
  const proposalNorms = [proposal.title, proposal.display_text]
    .map((t) => (t ? normalize(t) : ''))
    .filter((n) => n.length > 0)
  if (proposalNorms.length === 0) return NO_REFUSAL
  const proposalSet = new Set(proposalNorms)

  // A recent, live action whose normalized title EXACTLY matches. Window is
  // one-directional (created in the past, within RACE_WINDOW_MS) — a future-
  // dated row is never "the race." Recurring same-title work outside the window,
  // or a completed/canceled item, never matches.
  const match = candidates.find((c) => {
    const cat = c.status_category
    if (cat === 'completed' || cat === 'canceled') return false
    if (!c.title || !c.created_at) return false
    const created = Date.parse(c.created_at)
    if (!Number.isFinite(created)) return false
    const age = now - created
    if (age < 0 || age > RACE_WINDOW_MS) return false
    return proposalSet.has(normalize(c.title))
  })
  if (!match) return NO_REFUSAL

  return {
    refuse: true,
    matched_action_id: match.id,
    note: `auto-accept withheld: same-titled action ${match.identifier ?? match.id} created in the last ${Math.round(
      RACE_WINDOW_MS / 3_600_000,
    )}h — left for review`,
  }
}

/**
 * Load the candidate pool for the race check: recently-created actions in this
 * workspace, bounded to the race window (plus a small margin) so the query stays
 * cheap. Fetched ONCE per auto-apply batch, not per proposal. Completed/canceled
 * are filtered in the predicate (kept here so a title-shared done item is still
 * visible to the ambiguity logic). Fails soft — a query error yields an empty
 * pool, so the damp degrades to "never refuse" rather than blocking auto-accept.
 */
export async function fetchRaceCandidates(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number,
): Promise<RaceCandidateAction[]> {
  try {
    const since = new Date(now - RACE_WINDOW_MS).toISOString()
    const { data, error } = await supabase
      .from('actions')
      .select('id, title, identifier, created_at, workflow_state:workflow_state!status_id(category)')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error || !data) return []
    return (data as unknown as Array<{
      id: string
      title: string | null
      identifier: string | null
      created_at: string | null
      workflow_state: { category: string } | null
    }>).map((r) => ({
      id: r.id,
      title: r.title,
      identifier: r.identifier,
      created_at: r.created_at,
      status_category: r.workflow_state?.category ?? null,
    }))
  } catch {
    return []
  }
}

/**
 * Record that a proposal's auto-accept was withheld by the race damp — a machine
 * marker in extra.guardrail (mirrors GEN-138's calibration marker) so the queue
 * UI / Triage skill can badge "held: possible duplicate" without re-deriving it,
 * and it's fully reversible (the proposal is untouched otherwise, still pending).
 * Best-effort: a failed marker write never blocks the batch — the important part
 * (NOT auto-applying) already happened by the caller `continue`ing.
 */
export async function markRaceDamped(
  supabase: SupabaseClient,
  change: { id: string; extra?: Record<string, unknown> | null; workspace_id?: string },
  matchedActionId: string | undefined,
  note: string | undefined,
): Promise<void> {
  try {
    // Re-read `extra` FRESH immediately before the merge, rather than merging
    // onto the loop's stale snapshot. `extra` is a whole-column JSONB write with
    // no deep-merge, so merging onto a stale copy would clobber any concurrent
    // extra mutation (e.g. an agent-assignee edit) that landed since the batch
    // was read. This read-then-write still has a tiny race window, but it shrinks
    // it from "the whole auto-apply batch" to "a couple of statements," and the
    // marker is best-effort anyway (the withhold already took effect). (Review:
    // the stale-extra clobber.)
    const { data: fresh } = await supabase
      .from('proposed_change')
      .select('extra')
      .eq('id', change.id)
      .maybeSingle()
    const currentExtra = (fresh?.extra as Record<string, unknown> | null) ?? change.extra ?? {}
    const prevGuardrail = (currentExtra.guardrail as Record<string, unknown> | undefined) ?? {}
    await supabase
      .from('proposed_change')
      .update({
        extra: {
          ...currentExtra,
          guardrail: {
            ...prevGuardrail,
            auto_accept_withheld: true,
            race_dup_of: matchedActionId ?? null,
            race_note: note ?? null,
          },
        },
      })
      .eq('id', change.id)
      .eq('status', 'pending')
  } catch {
    /* best-effort marker; the withhold itself already took effect */
  }
}

/**
 * Add an action just auto-applied THIS batch to the in-memory candidate pool, so
 * a second identically-titled create:action LATER in the same batch is caught.
 * The DB pool is fetched once before the loop, so without this the batch is blind
 * to its own just-created actions (the within-batch race). Stamped created_at=now
 * so it's inside the window. Cheap in-memory push; no I/O.
 */
export function appendAppliedToPool(
  pool: RaceCandidateAction[],
  applied: { entityId: string | undefined; title: string | null },
  now: number,
): void {
  if (!applied.entityId || !applied.title) return
  pool.push({
    id: applied.entityId,
    title: applied.title,
    identifier: null,
    created_at: new Date(now).toISOString(),
    status_category: 'unstarted',
  })
}

/** Normalize a title (lowercase, strip punctuation, collapse whitespace) — the
 *  same normalization the action-target matcher uses, so exact-equality here
 *  agrees with how the rest of the system compares titles. */
function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
