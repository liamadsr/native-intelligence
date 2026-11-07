/**
 * Where a work run came from, and the slice of it the run's brief carries
 * (plan Part 5 row 8, B PR 4): the transcript quote that asked for the work,
 * and a short excerpt of the capture around it.
 *
 * Recorded once, at the start, on the ledger row's `source.provenance`
 * (start-work-item.ts): the auto-attempt gate records the quote that grounded
 * it; a person's Start records the backing proposal's trigger quote, or a
 * quoted span in the card's `why`. The dispatcher (work-run-functions.ts)
 * reads it back and cuts the excerpt at run time, after re-checking that the
 * run's user may still see the capture (visibility can change between the
 * start and the run, as it can for declared packages).
 *
 * Everything here is fail-soft: a failed read yields no provenance and the run
 * proceeds exactly as before, without a quote or an excerpt.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCaptureVisible } from '@/lib/ai/tools/_shared'
import { locateQuote, quotedSpans } from './auto-attempt'
import type { WorkProvenance } from './types'

/** Characters of transcript kept on each side of the quote. */
export const EXCERPT_CONTEXT_CHARS = 600
/** Cap on the quote the brief carries. */
export const SOURCE_QUOTE_MAX_CHARS = 500

/**
 * A person's Start: the backing proposal's capture and trigger quote, else the
 * card's own capture and the first quoted span in its `why`.
 */
export async function startProvenance(
  supabase: SupabaseClient,
  args: { workspaceId: string; proposalId: string | null; payload: { capture_id?: unknown }; why: string | null },
): Promise<WorkProvenance | null> {
  try {
    let captureId = typeof args.payload.capture_id === 'string' && args.payload.capture_id ? args.payload.capture_id : null
    let quote: string | null = null
    if (args.proposalId) {
      const { data } = await supabase
        .from('proposed_change')
        .select('capture_id, trigger_quote')
        .eq('id', args.proposalId)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      const row = data as { capture_id?: string | null; trigger_quote?: string | null } | null
      if (row?.capture_id) captureId = row.capture_id
      if (typeof row?.trigger_quote === 'string' && row.trigger_quote.trim()) quote = row.trigger_quote.trim()
    }
    if (!quote) quote = quotedSpans(args.why ?? '').map((q) => q.trim()).find(Boolean) ?? null
    if (!captureId && !quote) return null
    return { captureId, quote: quote ? quote.slice(0, SOURCE_QUOTE_MAX_CHARS) : null }
  } catch {
    return null
  }
}

/** The brief's `source` block. */
export interface BriefSource {
  quote: string | null
  captureId: string | null
  captureTitle: string | null
  /** The transcript around the quote, or null when it is not there to cut. */
  excerpt: string | null
}

/**
 * The window of `transcript` around `quote` — found as the auto-attempt gate
 * grounds it (case, punctuation, whitespace and speaker labels aside; an
 * elided quote by its pieces in order, locateQuote) — with an ellipsis where
 * it was cut. Null when the quote is not in the transcript.
 */
export function excerptAround(transcript: string, quote: string, context = EXCERPT_CONTEXT_CHARS): string | null {
  if (!transcript || !quote.trim()) return null
  const match = locateQuote(transcript, quote)
  if (!match) return null
  const start = Math.max(0, match.start - context)
  const end = Math.min(transcript.length, match.end + context)
  return `${start > 0 ? '…' : ''}${transcript.slice(start, end).trim()}${end < transcript.length ? '…' : ''}`
}

/**
 * Read a run's provenance back off its ledger row and cut the excerpt. The
 * excerpt needs the capture to be visible to the run's user (`triggeredBy`);
 * the quote rides either way (it came from a proposal or card that user saw).
 * Service-role client, so the visibility check is explicit.
 */
export async function loadBriefSource(
  supabase: SupabaseClient,
  args: { workspaceId: string; agentRunId: string; triggeredBy: string | null },
): Promise<BriefSource | undefined> {
  try {
    const { data: job } = await supabase
      .from('tracked_job')
      .select('source')
      .eq('agent_run_id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const prov = (job?.source as { provenance?: WorkProvenance } | null)?.provenance
    if (!prov || (!prov.captureId && !prov.quote)) return undefined
    const quote = typeof prov.quote === 'string' && prov.quote.trim() ? prov.quote.trim().slice(0, SOURCE_QUOTE_MAX_CHARS) : null
    let captureTitle: string | null = null
    let excerpt: string | null = null
    let captureId: string | null = null
    if (typeof prov.captureId === 'string' && prov.captureId) {
      const { data: cap } = await supabase
        .from('captures')
        .select('id, title, transcript, visibility, user_id, is_eval')
        .eq('id', prov.captureId)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      const row = cap as { id: string; title?: string | null; transcript?: string | null; visibility?: string | null; user_id?: string | null; is_eval?: boolean | null } | null
      if (row && isCaptureVisible(row, args.triggeredBy)) {
        captureId = row.id
        captureTitle = row.title ?? null
        excerpt = quote && typeof row.transcript === 'string' ? excerptAround(row.transcript, quote) : null
      }
    }
    if (!quote && !captureId) return undefined
    return { quote, captureId, captureTitle, excerpt }
  } catch {
    return undefined
  }
}
