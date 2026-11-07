import type { SupabaseClient } from '@supabase/supabase-js'
import { buildIndexableText, indexCapture } from '@/lib/ai/embeddings'
import { inngest } from '@/lib/inngest/client'
import { MIN_SUMMARY_CHARS } from '@/lib/inngest/capture-ingest'
import { emitCaptureProcessed } from '@/lib/flows/emit-capture-processed'

/**
 * Shared "capture-finished" indexing + knowledge-extraction seam.
 *
 * This is the exact logic that POST /api/ai/index-content runs at recording
 * stop, lifted into a helper so the index-reconciler cron can re-run it
 * byte-for-byte against captures that fell through the summary-timing race
 * (a real ai_summary landed AFTER index-content already ran, leaving 0
 * capture_chunks / 0 claims and the capture invisible to vector search).
 *
 * EVAL captures short-circuit before either operation — see the gate at the
 * top of the body.
 *
 * Two operations, in this order (both preserved from the route):
 *  1. Send `claim/extract-from-source` (BEFORE indexing) so an indexing failure
 *     can never strand knowledge extraction. Best-effort — a send failure can't
 *     fail indexing. Guards mirror capture-ingest.ts: demo captures never
 *     extract; bodies under MIN_SUMMARY_CHARS (auto-record blips) skip.
 *  2. Index the capture (delete-then-reinsert of capture_chunks via
 *     indexCapture) with the same tagged-chunk shape (summary + transcript),
 *     proposed-change text folded into the summary chunk.
 *
 * Both operations are idempotent-ish and safe to re-run: indexCapture does a
 * full delete-then-reinsert, and claim-extraction's 0.92 vector dedup collapses
 * a repeat extraction into provenance growth rather than duplicate claims.
 *
 * The caller supplies the already-resolved capture row (source of truth for
 * workspace_id / project_id / title / ai_summary / content / metadata), the
 * resolved workspace id, and the acting user — the route passes the request's
 * user; the cron passes the capture OWNER (captures.user_id), matching
 * capture-ingest.ts's attribution.
 *
 * Body text (title / ai_summary / content) is resolved ONCE from the row with
 * the bare params as fallback, and BOTH operations read that resolution. The
 * cron passes no bare params, so any section reading them alone would see an
 * empty body — which is exactly what made every cron heal a silent no-op.
 */

export interface CaptureFinishedRow {
  workspace_id?: string | null
  project_id?: string | null
  title?: string | null
  ai_summary?: string | null
  content?: string | null
  metadata?: unknown
  /**
   * `captures.is_eval` (migration 252). Callers MUST select it — an absent
   * column reads as undefined and the capture indexes normally, which is the
   * pre-eval behavior but not the fence. See the eval gate in the body.
   */
  is_eval?: boolean | null
}

export interface IndexCaptureFinishedParams {
  supabase: SupabaseClient
  /** Capture id. */
  captureId: string
  /** The resolved capture row (server source of truth). */
  captureRow: CaptureFinishedRow | null
  /** Acting user id: request user (route) or capture owner (cron). */
  userId: string
  /** Resolved workspace id (row workspace preferred, cookie fallback). */
  workspaceId: string | null
  /** Optional body-supplied overrides (route only; cron omits them). */
  title?: string
  content?: string
  summary?: string
  ai_summary?: string
  project_id?: string
  /**
   * The record is FINAL and no batch pass will run: emit `flow/capture.processed`
   * (Triage and the other capture loops) and stamp `batch_processed_at`, exactly
   * as the batch finalize does. Set by the recording provider's stop path when
   * `shouldRunPostLiveBatch` is false — a live-mode capture whose live agent
   * wrote the record window by window. Before this, such captures never fired
   * the loop trigger at all (precondition A4,
   * docs/plans/agent-orchestration-investigation.md §1.1). Same fences as the
   * batch emit: never for a demo or eval capture. The cron never sets it.
   */
  captureProcessed?: boolean
}

export async function indexCaptureFinished({
  supabase,
  captureId,
  captureRow,
  userId,
  workspaceId,
  title,
  content,
  summary,
  ai_summary,
  project_id,
  captureProcessed = false,
}: IndexCaptureFinishedParams): Promise<{ chunksCreated: number }> {
  const id = captureId
  const wsId = workspaceId

  // ── Eval gate (BEFORE extraction and BEFORE indexing) ──
  // An eval capture (`is_eval`, migration 252) is a synthetic mock meeting the
  // Evals surface replays through the real engine. Neither half of this helper
  // may run for one: claim extraction would file mock commitments into the
  // knowledge graph, and capture_chunks would make a fake sales call
  // semantically searchable next to real ones. Every eval capture also carries
  // metadata.demo = true, so the extraction half is already gated below — this
  // return is what additionally spares the EMBEDDING half, which the demo flag
  // has never covered (chunks are written unconditionally further down).
  if (captureRow?.is_eval === true) {
    console.log('[index-content] skipped: eval capture', id)
    return { chunksCreated: 0 }
  }

  // Body text, resolved ONCE for both operations: the capture row wins, the
  // bare params (route-only overrides) are the fallback. The cron passes only
  // captureRow — before this, the chunk-building section below read the bare
  // params alone, so every heal indexed an empty body and returned a silent
  // { chunksCreated: 0 }.
  const rowTitle = captureRow?.title || title
  const rowAiSummary = captureRow?.ai_summary || ai_summary
  const rowContent = captureRow?.content || content

  // ── Knowledge extraction trigger (the universal capture-finished seam) ──
  // index-content is the ONE server call every capture-stop path makes
  // (cloud batch, live mode, web mic), and it runs AFTER the
  // summary + decision/action extraction have landed — unlike
  // flow/capture.processed, which only the cloud-batch finalize emits
  // (live-mode captures never fire it, and the triage reconciler is
  // env-gated + triage-scoped). Sent BEFORE indexing so an indexing
  // failure can't strand extraction, and best-effort so a send failure
  // can't fail indexing. Guards mirror capture-ingest.ts: demo captures
  // never extract; bodies under MIN_SUMMARY_CHARS (auto-record blips)
  // skip. A capture that ALSO fired flow/capture.processed gets a second
  // extraction — claim-extraction's 0.92 vector dedup collapses the
  // repeat into provenance growth, so redundancy is safe by design.
  try {
    const isDemo = (captureRow?.metadata as { demo?: unknown } | null)?.demo === true
    const bodyText = [rowAiSummary || summary || '', rowContent || ''].join('\n').trim()
    if (!isDemo && wsId && bodyText.length >= MIN_SUMMARY_CHARS) {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', userId)
        .eq('workspace_id', wsId)
        .maybeSingle()
      await inngest.send({
        name: 'claim/extract-from-source',
        data: {
          workspaceId: wsId,
          userId,
          memberId: member?.id ?? null,
          sourceType: 'capture',
          sourceId: id,
          sourceLabel: rowTitle ? `Meeting: ${rowTitle}` : undefined,
        },
      })
    }
  } catch (err) {
    console.warn('[index-content] claim extraction send failed (non-fatal):', err)
  }

  // ── The loop trigger for a capture no batch pass will close (A4) ──
  // Mirrors the batch finalize's tail (live-agent route): emit, then stamp
  // batch_processed_at so a reconciler / Reprocess can tell the capture was
  // closed. Both fire-and-forget; the eval gate above already returned for a
  // mock call, and a demo capture never fires loops.
  if (captureProcessed && wsId) {
    const isDemo = (captureRow?.metadata as { demo?: unknown } | null)?.demo === true
    if (!isDemo) {
      try {
        emitCaptureProcessed({ workspaceId: wsId, captureId: id, processedAt: new Date().toISOString() })
        void supabase
          .from('captures')
          .update({ batch_processed_at: new Date().toISOString() })
          .eq('id', id)
          .eq('workspace_id', wsId)
          .then(({ error }) => {
            if (error) console.warn('[index-content] batch_processed_at stamp failed (non-fatal):', error.message)
          })
      } catch (err) {
        console.warn('[index-content] capture_processed emit failed (non-fatal):', err)
      }
    }
  }

  // Build tagged chunks: summary content vs transcript content
  const taggedChunks: Array<{ text: string; source: 'summary' | 'transcript' }> = []

  // Summary chunks: title + AI summary + proposed changes
  const summaryText = buildIndexableText({ title: rowTitle, summary, ai_summary: rowAiSummary })

  // Fetch proposed changes and append to summary text
  let pcQuery = supabase
    .from('proposed_change')
    .select('display_text, title, description, reasoning, entity_type, change_type')
    .eq('capture_id', id)
    .in('status', ['pending', 'accepted'])

  if (wsId) {
    pcQuery = pcQuery.eq('workspace_id', wsId)
  }

  const { data: proposedChanges } = await pcQuery

  let fullSummary = summaryText
  if (proposedChanges?.length) {
    const pcText = proposedChanges
      .map((pc) => {
        const parts = [`[${pc.entity_type}] ${pc.display_text}`]
        if (pc.title && pc.title !== pc.display_text) parts.push(pc.title)
        if (pc.description) parts.push(pc.description)
        if (pc.reasoning) parts.push(pc.reasoning)
        return parts.join(' — ')
      })
      .join('\n')
    fullSummary = fullSummary ? `${fullSummary}\n\nProposed Changes:\n${pcText}` : `Proposed Changes:\n${pcText}`
  }

  if (fullSummary.trim()) {
    taggedChunks.push({ text: fullSummary, source: 'summary' })
  }

  // Transcript chunks: raw content/transcript (tagged separately)
  if (rowContent?.trim()) {
    taggedChunks.push({ text: rowContent, source: 'transcript' })
  }

  if (taggedChunks.length === 0) {
    return { chunksCreated: 0 }
  }

  const result = await indexCapture(
    supabase,
    id,
    userId,
    project_id || captureRow?.project_id || null,
    taggedChunks,
    wsId || null,
  )

  return result
}
