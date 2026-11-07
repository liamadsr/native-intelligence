import { getServiceClient } from '@/lib/admin'
import { buildIndexableText, indexCapture } from '@/lib/ai/embeddings'
import { MIN_SUMMARY_CHARS } from './capture-ingest'
import { inngest } from './client'

/**
 * capture/reindex.requested → re-embed a capture after a content-changing edit.
 *
 * Sent by PATCH /api/account/captures/[id] whenever title/content/ai_summary
 * changed. This used to run INLINE and awaited in the PATCH handler
 * (reindexCaptureBestEffort): chunk + OpenAI batchEmbed + capture_chunks
 * delete-then-reinsert, 0.5–2s inside every 500ms-debounced summary-save round
 * trip — the post-stop review-latency tax (perf audit finding 3d). Reindexing
 * is explicitly best-effort (a stale index is recoverable; the next edit
 * re-indexes), so it belongs off the request path entirely.
 *
 * Debounce, per capture: an edit burst (each debounced summary save fires one
 * event) coalesces into ONE run ~60s after the LAST event. Correct by
 * construction — the run reads the row's CURRENT values from the DB, not the
 * event payload, so the single run always embeds the freshest text.
 *
 * Mirrors the tagged-chunk shape (summary + transcript sources, plus
 * proposed-change text) that POST /api/ai/index-content produces at recording
 * stop, so the re-index is a faithful refresh rather than a lossy overwrite —
 * indexCapture does a full delete-then-reinsert of capture_chunks, so anything
 * omitted here would be dropped from the index.
 *
 * After a successful re-index it also fires claim/extract-from-source, under
 * the same guards index-capture-finished.ts uses — an edit that changes the
 * body changes what's extractable, and re-indexing alone left captures with
 * fresh chunks and no claims.
 */

export interface CaptureReindexRow {
  title: string | null
  content: string | null
  ai_summary: string | null
  summary: string | null
  project_id: string | null
  /** `captures.is_eval` (migration 252) — an eval capture is never embedded. */
  is_eval?: boolean | null
  /** Only read for the demo guard on the extraction send. */
  metadata?: unknown
}

export interface CaptureReindexProposedChange {
  display_text: string | null
  title: string | null
  description: string | null
  reasoning: string | null
  entity_type: string | null
}

export interface TaggedReindexChunk {
  text: string
  source: 'summary' | 'transcript'
}

/**
 * Build the tagged chunks to (re-)embed for a capture. Pure — extracted from
 * the old inline reindexCaptureBestEffort so the composition rules are
 * testable without a fake Supabase:
 *  - summary chunk = title + ai_summary/summary, with pending/accepted
 *    proposed-change text appended under a "Proposed Changes:" header;
 *  - content (legacy meeting body) is tagged 'transcript', matching the
 *    index-content route's source split.
 * An empty return means nothing indexable remains — the caller must CLEAR
 * capture_chunks so search doesn't keep vectors for deleted text.
 */
export function buildCaptureReindexChunks(
  row: CaptureReindexRow,
  proposedChanges: CaptureReindexProposedChange[],
): TaggedReindexChunk[] {
  const summaryText = buildIndexableText({
    title: row.title ?? undefined,
    ai_summary: row.ai_summary ?? undefined,
    summary: row.summary ?? undefined,
  })

  let fullSummary = summaryText
  if (proposedChanges.length) {
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

  const taggedChunks: TaggedReindexChunk[] = []
  if (fullSummary.trim()) taggedChunks.push({ text: fullSummary, source: 'summary' })
  if (row.content?.trim()) taggedChunks.push({ text: row.content, source: 'transcript' })
  return taggedChunks
}

export const captureReindex = inngest.createFunction(
  {
    id: 'capture-reindex',
    retries: 1,
    // Per-capture coalescing: hold until the capture has been quiet for 60s,
    // then run ONCE. Without this every debounced client save (500ms) would
    // burn its own embed run.
    debounce: { key: 'event.data.captureId', period: '60s' },
    // Bound embedding fan-out per workspace (matches capture-ingest).
    concurrency: [{ limit: 3, key: 'event.data.workspaceId' }],
    triggers: [{ event: 'capture/reindex.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as {
      captureId: string
      workspaceId: string
      /** The acting user — embedding spend attribution (batchEmbed → logUsage). */
      userId: string
    }

    const supabase = getServiceClient()

    // Read the row's FULL current values (not any patch payload) so an edit
    // that only touched, say, ai_summary still re-embeds against the real
    // title + content. Workspace-scoped: the event's workspaceId must match
    // the row or we index nothing (service client bypasses RLS).
    const row = await step.run('load-capture', async () => {
      const { data: capture } = await supabase
        .from('captures')
        .select('title, content, ai_summary, summary, project_id, is_eval, metadata')
        .eq('id', data.captureId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle()
      return (capture as CaptureReindexRow | null) ?? null
    })

    // Deleted (or moved workspace) between the edit and the debounced run —
    // nothing to refresh.
    if (!row) return { status: 'skipped', reason: 'missing_capture' }

    // An eval capture (`is_eval`, migration 252) is a synthetic mock meeting —
    // it must never enter the vector index, or a fake sales call becomes
    // semantically searchable next to real ones. Editing one still fires this
    // event (PATCH /api/account/captures/[id] doesn't know about evals), so the
    // fence lives here. Mirrors capture-ingest.ts's demo gate; no chunks are
    // cleared either, because an eval capture never had any to begin with.
    if (row.is_eval === true) {
      console.log('[capture-reindex] skipped: eval capture', data.captureId)
      return { status: 'skipped', reason: 'eval_capture' }
    }

    const proposedChanges = await step.run('load-proposed-changes', async () => {
      const { data: rows } = await supabase
        .from('proposed_change')
        .select('display_text, title, description, reasoning, entity_type, change_type')
        .eq('capture_id', data.captureId)
        .eq('workspace_id', data.workspaceId)
        .in('status', ['pending', 'accepted'])
      return (rows as CaptureReindexProposedChange[] | null) ?? []
    })

    const taggedChunks = buildCaptureReindexChunks(row, proposedChanges)

    // Nothing indexable left — clear stale chunks so search doesn't return
    // vectors for text that no longer exists.
    if (taggedChunks.length === 0) {
      await step.run('clear-stale-chunks', async () => {
        await supabase.from('capture_chunks').delete().eq('capture_id', data.captureId)
      })
      return { status: 'cleared', captureId: data.captureId }
    }

    const result = await step.run('reindex', async () =>
      indexCapture(
        supabase,
        data.captureId,
        data.userId,
        row.project_id ?? null,
        taggedChunks,
        data.workspaceId,
      ),
    )

    // Re-extract knowledge from the edited body. Chunks and claims are two
    // INDEPENDENT gaps: without this, a manual edit refreshed the vectors while
    // extraction never ran, leaving captures with healthy chunks and zero claims
    // forever (PROD capture d79b0039: 17 chunks, no claims ever). Guards mirror
    // index-capture-finished.ts / capture-ingest.ts — demo captures never
    // extract, bodies under MIN_SUMMARY_CHARS skip. Re-extraction is safe by
    // design: claim-extraction's 0.92 cosine dedupe collapses a repeat into
    // provenance growth. Best-effort — a send failure must not fail the reindex
    // (the chunks are already written).
    const isDemo = (row.metadata as { demo?: unknown } | null)?.demo === true
    const bodyText = [row.ai_summary || row.summary || '', row.content || ''].join('\n').trim()
    if (!isDemo && bodyText.length >= MIN_SUMMARY_CHARS) {
      await step.run('send-claim-extraction', async () => {
        try {
          const { data: member } = await supabase
            .from('member')
            .select('id')
            .eq('user_id', data.userId)
            .eq('workspace_id', data.workspaceId)
            .maybeSingle()
          await inngest.send({
            name: 'claim/extract-from-source',
            data: {
              workspaceId: data.workspaceId,
              userId: data.userId,
              memberId: member?.id ?? null,
              sourceType: 'capture',
              sourceId: data.captureId,
              sourceLabel: row.title ? `Meeting: ${row.title}` : undefined,
            },
          })
        } catch (err) {
          console.warn('[capture-reindex] claim extraction send failed (non-fatal):', err)
        }
        return null
      })
    }

    return { status: 'indexed', captureId: data.captureId, chunksCreated: result.chunksCreated }
  },
)
