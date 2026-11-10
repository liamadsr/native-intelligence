import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'

/**
 * flow/capture.processed → claim/extract-from-source
 *
 * Auto-ingest a finished meeting into the knowledge graph. Before this
 * function existed, `claim/extract-from-source` was only ever sent from
 * document publish, ni_ingest_source, reference-ingest and
 * conversation-ingest — real meetings (the workspace's highest-value source)
 * produced zero claims unless the user explicitly ingested them or accepted
 * decision/action proposals.
 *
 * Seam: `flow/capture.processed` is emitted exactly once per batch-extraction
 * completion, from the batch route's finalize() (see
 * emit-capture-processed.ts), AFTER ai_summary is written/reconciled and
 * auto-applied decision/action rows have landed. That ordering matters: the
 * claim-extraction handler reads ai_summary for the LLM pass and folds the
 * capture's decision/actions rows into claims — firing earlier would silently
 * fold nothing. Consuming the event here (instead of adding a second send at
 * each emit site) keeps the wiring in one server-side place, off the request
 * path, and structurally guarantees a send failure can never fail capture
 * processing (the emit itself is already fire-and-forget with its own catch).
 *
 * Skips, deliberately conservative:
 *  - reconciler re-fires (`reconciled: true` from /api/cron/triage-reconciler)
 *    — those re-run triage loops for stuck proposals, they are not new
 *    processing completions; honoring them would burn extraction on every
 *    reconcile pass.
 *  - demo captures (belt-and-braces; the emit sites already skip them).
 *  - captures with no/short summary (< MIN_SUMMARY_CHARS) — junk auto-record
 *    blips must not spend LLM + embedding calls.
 *
 * Reprocess ("re-run extraction") re-fires the trigger deliberately; that is
 * safe end-to-end because claim-extraction dedupes at DEDUPE_THRESHOLD (0.92
 * cosine) and dedupe hits grow provenance on the existing claim instead of
 * duplicating it (attachClaimProvenance upserts are idempotent). The dedupe
 * read sees only claims the capture's own audience can already see
 * (dedupeRequesterFor: the owner for a private capture, no requester for a
 * workspace one), so a re-run still matches the claims this capture created,
 * while a workspace meeting never attaches itself to its owner's private chat
 * or private-meeting claims (that would widen them to the whole workspace).
 */

/**
 * Minimum trimmed ai_summary/content length (chars) worth extracting from.
 * The extraction handler's own floor is 40 chars INCLUDING the `# title`
 * header — a title alone can clear that and burn a Haiku call on nothing.
 * A real meeting's structured ai_summary (Summary / Decisions / Next Steps)
 * is reliably several hundred chars, while the 45–340s auto-record blips
 * common in prod carry a null or one-line summary. 200 chars sits safely
 * between the two: it never gates a real meeting, and blips never pass.
 */
export const MIN_SUMMARY_CHARS = 200

export const captureIngest = inngest.createFunction(
  {
    id: 'capture-ingest',
    retries: 1,
    concurrency: [{ limit: 3, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/capture.processed' }],
  },
  async ({ event, step }) => {
    // NOTE: this event uses snake_case keys (emit-capture-processed.ts),
    // unlike claim/extract-from-source's camelCase payload.
    const data = event.data as {
      workspace_id: string
      capture_id: string
      processed_at?: string
      reconciled?: boolean
    }

    if (data.reconciled === true) {
      return { status: 'skipped', reason: 'reconciled_refire' }
    }

    const supabase = getServiceClient()

    const capture = await step.run('load-capture', async () => {
      const { data: row } = await supabase
        .from('captures')
        .select('id, title, user_id, ai_summary, content, metadata')
        .eq('id', data.capture_id)
        .eq('workspace_id', data.workspace_id)
        .maybeSingle()
      if (!row) return null
      // Gate on the same body claim-extraction will read (ai_summary preferred,
      // legacy content fallback), excluding the title.
      const body = (
        (row.ai_summary as string | null) ||
        (row.content as string | null) ||
        ''
      ).trim()
      return {
        title: (row.title as string | null) ?? 'Capture',
        userId: (row.user_id as string | null) ?? null,
        bodyLength: body.length,
        isDemo: (row.metadata as { demo?: unknown } | null)?.demo === true,
      }
    })

    if (!capture) return { status: 'skipped', reason: 'missing_capture' }
    if (capture.isDemo) return { status: 'skipped', reason: 'demo_capture' }
    if (capture.bodyLength < MIN_SUMMARY_CHARS) {
      return { status: 'skipped', reason: 'summary_too_short' }
    }
    // The extraction event contract carries the acting userId (usage guard +
    // embedding spend attribution). captures.user_id is the capture OWNER
    // (mig 175) and is set on every real capture; a null owner is pathological
    // — skip rather than run an unattributed LLM job (guardBackgroundUsage
    // fails OPEN on a missing userId, so passing nothing would bypass limits).
    const ownerUserId = capture.userId
    if (!ownerUserId) return { status: 'skipped', reason: 'no_owner' }

    // Same member resolution as conversation-ingest: the owner's member row in
    // this workspace attributes created_by on inserted claims. Null is fine —
    // claim-extraction accepts memberId: null.
    const memberId = await step.run('resolve-member', async () => {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', ownerUserId)
        .eq('workspace_id', data.workspace_id)
        .maybeSingle()
      return (member?.id as string | undefined) ?? null
    })

    await step.sendEvent('send-extraction', {
      name: 'claim/extract-from-source',
      data: {
        workspaceId: data.workspace_id,
        userId: ownerUserId,
        memberId,
        sourceType: 'capture',
        sourceId: data.capture_id,
        sourceLabel: `Meeting: ${capture.title}`,
      },
    })

    // Fan out to HubSpot meeting-logging writeback. The hubspot-log-capture
    // function owns ALL its own gating (workspace opt-in flag, idempotency,
    // whether the workspace even has a HubSpot account) and no-ops cleanly when
    // any of that is absent — so this send is unconditional here, riding the same
    // demo/short-summary/owner gates above that already spared junk blips. It is
    // deliberately a SEPARATE send (not folded into the extraction event) so a
    // HubSpot-side failure can never affect knowledge extraction.
    await step.sendEvent('send-hubspot-log', {
      name: 'crm/hubspot-log-capture',
      data: {
        captureId: data.capture_id,
        workspaceId: data.workspace_id,
        ownerUserId,
      },
    })

    return { status: 'queued', captureId: data.capture_id }
  },
)
