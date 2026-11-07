/**
 * A flow fire's outcome → its ledger row (ACTIVITY-AND-REVIEW-DESIGN §5, the
 * flow-dispatcher row of the producer table).
 *
 * The runner's per-action results are the ground truth the dispatchers already
 * persist on flow_run; this module reads THEM to settle the fire's work item —
 * summary, typed deliverables, skip reason or error — so the skill executor only
 * has to feed live steps and never learns about the ledger's terminal shapes.
 * Pure except for the final settle call (and the output documents' titles it
 * reads), so every branch is unit-testable.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionResult, FlowRunStatus, VerdictLedger } from '@/lib/flows/types'
import type { WorkHandle } from './recorder'
import type { WorkDeliverable, WorkNeeds } from './types'

/** Deliverables never exceed this many entries per row. */
const DELIVERABLE_CAP = 20

/** The typed refs the UI routes: output documents, the cards a verdict run
 *  surfaced (keyed on the run they back-link to), actions the engine filed,
 *  captures the fire archived. A document is labelled with its title when
 *  `documentTitles` has it ("Morning Brief — 2026-10-20", what the For you card
 *  and the opened card say; Liam, 10-20), else "Output document". */
export function deliverablesFromActionResults(
  results: ActionResult[],
  flowRunId: string | null,
  documentTitles: Readonly<Record<string, string>> = {},
): WorkDeliverable[] {
  const out: WorkDeliverable[] = []
  for (const r of results) {
    if (r.skipped) continue
    if (r.output_document_id) {
      out.push({ type: 'document', id: r.output_document_id, label: documentTitles[r.output_document_id] ?? 'Output document' })
    }
    if (r.verdict) {
      const n = r.verdict.cards_surfaced
      if (n > 0 && flowRunId) {
        out.push({
          type: 'attention_cards',
          id: flowRunId,
          label: `${n} card${n === 1 ? '' : 's'} for you`,
          count: n,
        })
      }
      for (const entry of r.verdict.entries ?? []) {
        if (entry.outcome === 'applied' && entry.entity_id) {
          out.push({ type: 'action', id: entry.entity_id, label: 'Filed action' })
        }
      }
    }
    if (r.archived_capture_id) {
      out.push({ type: 'capture', id: r.archived_capture_id, label: 'Archived capture' })
    }
    // F4: a step parked on its approval card (back-linked to the run once the run row exists).
    if (r.parked && flowRunId) {
      out.push({ type: 'attention_cards', id: flowRunId, label: 'Waiting for your approval', count: 1 })
    }
    // F3: post drafts are For you cards, back-linked to the run like a verdict's.
    if (r.delivered?.to === 'post_drafts' && r.delivered.delivered > 0 && flowRunId) {
      const n = r.delivered.delivered
      out.push({ type: 'attention_cards', id: flowRunId, label: `${n} post${n === 1 ? '' : 's'} for you`, count: n })
    }
  }
  return out.slice(0, DELIVERABLE_CAP)
}

function verdictSummary(verdict: VerdictLedger): string {
  if (verdict.verdict_missing) return 'ran out of steps — no verdict'
  const counts: Record<string, number> = {}
  for (const e of verdict.entries ?? []) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1
  const parts: string[] = []
  if (counts.applied) parts.push(`filed ${counts.applied}`)
  if (counts.dismissed) parts.push(`dismissed ${counts.dismissed}`)
  if (counts.folded) parts.push(`folded ${counts.folded}`)
  if (verdict.revoked_count > 0) parts.push(`revoked ${verdict.revoked_count}`)
  parts.push(`${verdict.cards_surfaced} for you`)
  return parts.join(' · ')
}

/** The one-line "what happened" for a settled fire. */
export function summarizeActionResults(results: ActionResult[]): string | null {
  const fired = results.filter((r) => !r.skipped)
  const verdict = fired.map((r) => r.verdict).find((v): v is VerdictLedger => !!v)
  if (verdict) return verdictSummary(verdict)
  // F3: a connector's own line ("2 X posts for you", "Updated Messaging in Product").
  const delivered = fired.map((r) => r.delivered?.summary).filter((line): line is string => !!line)
  if (delivered.length) return delivered.join(' · ')
  const docs = fired.filter((r) => r.output_document_id).length
  const agents = fired.filter((r) => r.dispatched === true && r.agent_run_id).length
  const archived = fired.filter((r) => r.archived_capture_id).length
  const parts: string[] = []
  if (docs) parts.push(`${docs} document${docs === 1 ? '' : 's'}`)
  if (agents) parts.push(`${agents} agent run${agents === 1 ? '' : 's'} started`)
  if (archived) parts.push(`${archived} capture${archived === 1 ? '' : 's'} archived`)
  if (parts.length) return `Delivered ${parts.join(' · ')}`
  return fired.length ? `${fired.length} action${fired.length === 1 ? '' : 's'} fired` : null
}

/** Why nothing ran, from the first skipped action (the dormancy gate stamps its
 *  reason on every action's preview). */
export function skipReasonFromResults(results: ActionResult[]): string {
  const first = results.find((r) => r.skipped)
  if (!first) return 'Nothing to do'
  if (first.response_body_preview && /inactive|skipped/i.test(first.response_body_preview)) {
    return first.response_body_preview
  }
  if (first.disabled) return 'Action disabled'
  if (first.incomplete) return 'Action needs setup'
  return 'Conditions not met'
}

export function firstErrorFromResults(results: ActionResult[]): string {
  const failed = results.find((r) => !r.skipped && r.status === 'failed')
  return failed?.error_message?.trim() || 'The run failed'
}

/**
 * The titles of the documents the fire delivered, keyed by id. Best-effort: a
 * failed read leaves them out, and their deliverables say "Output document".
 */
export async function outputDocumentTitles(
  supabase: SupabaseClient,
  results: ActionResult[],
): Promise<Record<string, string>> {
  const ids = [...new Set(results.flatMap((r) => (!r.skipped && r.output_document_id ? [r.output_document_id] : [])))]
  if (ids.length === 0) return {}
  try {
    const { data, error } = await supabase.from('document').select('id, title').in('id', ids)
    if (error) return {}
    const titles: Record<string, string> = {}
    for (const row of (data ?? []) as Array<{ id: string; title: string | null }>) {
      const title = row.title?.replace(/\s+/g, ' ').trim()
      if (title) titles[row.id] = title
    }
    return titles
  } catch {
    return {}
  }
}

/**
 * Settle a fire's ledger row from the runner's outcome:
 *   • nothing fired          → skipped, with the reason;
 *   • a failed action        → failed, with its error;
 *   • otherwise              → done, with summary + deliverables.
 * `status` is the flow_run status the dispatcher persists; `supabase` reads the
 * delivered documents' titles for their labels.
 */
export async function settleFlowWork(
  work: WorkHandle,
  args: { status: FlowRunStatus; actionResults: ActionResult[]; flowRunId: string | null; supabase?: SupabaseClient },
): Promise<void> {
  const { status, actionResults, flowRunId, supabase } = args
  const fired = actionResults.filter((r) => !r.skipped)
  if (fired.length === 0) {
    await work.skip(skipReasonFromResults(actionResults))
    return
  }
  // F4: a run parked on an approval card: what ran so far is done, and the
  // card is what it needs from the person (the run carries on from it).
  const parked = actionResults.find((r) => r.parked)?.parked
  if (status === 'pending' && parked) {
    const deliverables = deliverablesFromActionResults(actionResults, flowRunId)
    await work.finish({ summary: `Waiting for your yes: ${parked.title}`, deliverables })
    return
  }
  const summary = summarizeActionResults(actionResults)
  if (status === 'failed' || fired.some((r) => r.status === 'failed')) {
    await work.fail(firstErrorFromResults(actionResults), { summary })
    return
  }
  const titles = supabase ? await outputDocumentTitles(supabase, actionResults) : {}
  const deliverables = deliverablesFromActionResults(actionResults, flowRunId, titles)
  // A prose run (a skill that wrote a document, no verdict) hands the user
  // something to CHECK, so it waits in "Needs you" rather than dropping silently
  // into Recent. A verdict run's cards are the review unit, not the run.
  const review = reviewFor(actionResults, deliverables)
  await work.finish({ summary, deliverables, ...(review ? { review } : {}) })
}

/** The review a settled fire owes the user, if any. */
export function reviewFor(
  results: ActionResult[],
  deliverables: WorkDeliverable[],
): Extract<WorkNeeds, { kind: 'review' }> | null {
  const verdict = results.some((r) => !r.skipped && !!r.verdict)
  if (verdict) return null
  return deliverables.some((d) => d.type === 'document') ? { kind: 'review', verb: 'check' } : null
}
