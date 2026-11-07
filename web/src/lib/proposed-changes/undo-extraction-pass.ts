/**
 * Extraction's undo of ONE pass (bots v3 Phase 5, `undo_extraction_pass`;
 * docs/plans/bots-v3.md "tell it what to do next"): "undo what you filed from
 * the Acme call" puts back what that one extraction pass applied, and nothing
 * else.
 *
 * What a pass did is its own ledger row (`extraction_pass.ledger.entries`,
 * extraction-ledger.ts): `applied` entries (a proposal the gate applied, with
 * the entity it created) and `carded` ones (staged for the person, never
 * applied). The undo walks ONLY the applied entries of THAT pass, and for each
 * un-applies the proposal (undoAppliedProposal: delete the entity it created,
 * back to pending) only while the proposal is still on the pass's capture and
 * still names the entity this pass created. So:
 *   - another pass's entries on the same capture are never read;
 *   - a proposal the person dismissed or re-applied since is left alone;
 *   - an entity the person worked on since it was applied (edited, moved,
 *     commented on, given sub-actions) is left alone (CHANGED_SINCE,
 *     undo-applied.ts entityChangedSince);
 *   - an `update`/`assign` entry (it changed something that already existed) is
 *     refused, as the per-proposal Undo refuses it;
 *   - a staged entry is untouched (nothing was applied).
 * Running it twice does nothing the second time.
 *
 * OWNER-ONLY: the caller must be the member the pass's work item belongs to
 * (its `extraction` row in the work ledger, source.extraction_pass_id), or, for
 * a pass with no work item, the person who made the capture. Fenced to the
 * caller's workspace. Reads and writes on `supabase` with explicit fences (it
 * may be a service-role client).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { undoAppliedProposal } from './undo-applied'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** At most this many entries are undone in one call (a pass applies a handful). */
export const UNDO_PASS_MAX_ENTRIES = 50

export interface UndoPassEntryOutcome {
  proposal_id: string
  entity_id: string | null
  /** undone: the entity is gone and the proposal pending again; skipped: left as it is, `why`. */
  outcome: 'undone' | 'skipped'
  why?: string
}

export type UndoExtractionPassResult =
  | {
      success: true
      pass_id: string
      capture_id: string
      undone: number
      skipped: number
      entries: UndoPassEntryOutcome[]
      message: string
    }
  | { success: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'FAILED'; error: string }

interface PassRow {
  id: string
  workspace_id: string
  capture_id: string
  ledger: { entries?: unknown } | null
}

/** A pass's applied entries, shape-checked (jsonb a server wrote, read defensively). */
export function appliedEntriesOf(ledger: PassRow['ledger']): Array<{ proposal_id: string; entity_id: string | null }> {
  const entries = Array.isArray(ledger?.entries) ? ledger!.entries : []
  const out: Array<{ proposal_id: string; entity_id: string | null }> = []
  const seen = new Set<string>()
  for (const e of entries as unknown[]) {
    if (!e || typeof e !== 'object') continue
    const entry = e as Record<string, unknown>
    if (entry.outcome !== 'applied') continue
    const proposalId = entry.proposal_id
    if (typeof proposalId !== 'string' || !UUID.test(proposalId) || seen.has(proposalId)) continue
    seen.add(proposalId)
    const entityId = typeof entry.entity_id === 'string' && entry.entity_id ? entry.entity_id : null
    out.push({ proposal_id: proposalId, entity_id: entityId })
  }
  return out
}

export async function undoExtractionPass(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  passId: string,
): Promise<UndoExtractionPassResult> {
  if (typeof passId !== 'string' || !UUID.test(passId)) return { success: false, code: 'NOT_FOUND', error: 'No extraction pass with that id.' }
  try {
    const { data: pass, error: passError } = await supabase
      .from('extraction_pass')
      .select('id, workspace_id, capture_id, ledger')
      .eq('id', passId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<PassRow>()
    if (passError) throw new Error(passError.message)
    if (!pass) return { success: false, code: 'NOT_FOUND', error: 'No extraction pass with that id in this workspace.' }

    if (!(await ownsPass(supabase, userId, workspaceId, pass))) {
      return { success: false, code: 'FORBIDDEN', error: 'Only the person this extraction ran for can undo it.' }
    }

    const outcomes: UndoPassEntryOutcome[] = []
    for (const entry of appliedEntriesOf(pass.ledger).slice(0, UNDO_PASS_MAX_ENTRIES)) {
      const result = await undoAppliedProposal(supabase, {
        workspaceId,
        changeId: entry.proposal_id,
        captureId: pass.capture_id,
        // Only while it still names what THIS pass created.
        expectEntityId: entry.entity_id,
        // Never delete what the person has worked on since.
        refuseIfChangedSince: true,
      })
      outcomes.push(
        result.ok
          ? { proposal_id: entry.proposal_id, entity_id: entry.entity_id, outcome: 'undone' }
          : { proposal_id: entry.proposal_id, entity_id: entry.entity_id, outcome: 'skipped', why: skipWhy(result.code, result.status) },
      )
    }
    const undone = outcomes.filter((o) => o.outcome === 'undone').length
    const skipped = outcomes.length - undone
    return {
      success: true,
      pass_id: pass.id,
      capture_id: pass.capture_id,
      undone,
      skipped,
      entries: outcomes,
      message:
        outcomes.length === 0
          ? 'This pass filed nothing, so there was nothing to undo.'
          : `Undid ${undone} of ${outcomes.length} things this pass filed; their proposals are back for review.${skipped ? ` ${skipped} were left as they are (see each entry).` : ''}`,
    }
  } catch (err) {
    console.warn('[undo-extraction-pass] failed:', err instanceof Error ? err.message : err)
    return { success: false, code: 'FAILED', error: 'The pass could not be undone just now.' }
  }
}

function skipWhy(code: string | undefined, status: number): string {
  if (code === 'NOT_APPLIED') return 'already dismissed or back for review'
  if (code === 'NOT_CREATED_BY_PROPOSAL') return 'it changed something that already existed, which can’t be undone'
  if (code === 'REAPPLIED') return 'it was applied again since'
  if (code === 'CHANGED_SINCE') return 'it was edited, moved or commented on since, so it stays'
  if (status === 404) return 'the proposal is gone'
  return 'it could not be undone just now'
}

/** The pass's work item is the caller's, else (no work item) the capture is theirs. */
async function ownsPass(supabase: SupabaseClient, userId: string, workspaceId: string, pass: PassRow): Promise<boolean> {
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>()
  if (memberError) throw new Error(memberError.message)
  if (!member?.id) return false

  const { data: items, error: itemError } = await supabase
    .from('tracked_job')
    .select('member_id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'extraction')
    .eq('source->>extraction_pass_id', pass.id)
    .limit(1)
  if (itemError) throw new Error(itemError.message)
  const item = (items ?? [])[0] as { member_id?: string | null } | undefined
  if (item) return item.member_id === member.id

  const { data: capture, error: captureError } = await supabase
    .from('captures')
    .select('user_id')
    .eq('id', pass.capture_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ user_id: string | null }>()
  if (captureError) throw new Error(captureError.message)
  return !!capture && capture.user_id === userId
}
