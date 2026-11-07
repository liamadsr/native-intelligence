import type { SupabaseClient } from '@supabase/supabase-js'
import { NonRetriableError } from 'inngest'
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { generateDeviceToken } from '@/lib/device-tokens'
import { resolveDefaultAgentSlugFromSettings } from '@/lib/live-agent/default-agent'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { indexCaptureFinished } from '@/lib/ai/index-capture-finished'
import { generateCaptureTitle } from '@/lib/captures/generate-title'
import {
  ABANDONED_SWEEP_CAP,
  closeAbandonedCapture,
  findAbandonedCaptures,
  loadAbandonedCapture,
  loadDeclinedCapture,
  needsBatchPass,
  retireStaleCaptures,
  type AbandonedCaptureRow,
  type FinalizeReason,
} from '@/lib/captures/abandoned'

/**
 * The server's Stop for a recording whose recorder died (see
 * src/lib/captures/abandoned.ts for what counts as abandoned, and why).
 *
 *   abandoned-capture-sweep (every 15 min) → one CAPTURE_ABANDONED_EVENT per
 *   capture → finalize-abandoned-capture: close it (CAS), then run the
 *   end-of-meeting pass Stop runs:
 *     - the record still has to be written → the canonical batch, POST
 *       /api/ai/live-agent { mode: 'batch' } as the capture's owner, whose
 *       finalize emits flow/capture.processed (→ Triage) and stamps
 *       batch_processed_at; then the post-extraction work (title + index);
 *     - it was written live → index-content's close (captureProcessed), which
 *       emits flow/capture.processed and stamps batch_processed_at itself.
 *
 * The batch runs through the ROUTE, not a copy of it: the route owns the whole
 * pipeline (persona, tools, auto-apply, summary reconciliation, the batch tail),
 * and the eval lane already drives it server-side the same way — a short-lived
 * device token acting as the owner, pinned to the capture's workspace (the pin
 * is what getCurrentWorkspaceId resolves for a device token), revoked after.
 * `allow_auto_archive` stays false: only the user's own end-of-meeting batch
 * may archive a capture, never a recovery.
 *
 * The same event, with `reason: 'recovery_declined'`, finishes a capture its
 * owner declined to resume (POST /captures/[id]/decline-recovery closed it
 * already): the finalizer re-reads it, skips the close, and runs the same pass.
 *
 * The sweep also retires the open captures the finish never reaches (quiet
 * past the lookback, whatever is in them): closed in the sweep itself, with no
 * event and no pass (retireStaleCaptures).
 */

export const CAPTURE_ABANDONED_EVENT = 'capture/abandoned.finalize'

/** Wait for the batch route this long, inside one step's invocation (the
 *  /api/inngest function's maxDuration is 300s). A longer batch keeps running
 *  in its own invocation — the non-streaming route ignores a caller that went
 *  away — and the function checks for its stamp after BATCH_SETTLE. */
const BATCH_WAIT_MS = 240_000
/** Past the route's own 600s ceiling: by then the batch has stamped or failed. */
const BATCH_SETTLE = '11m'
/** The owner's token lives for the call and is revoked after; this is the backstop. */
const RUN_TOKEN_TTL_MS = 30 * 60 * 1000

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}

export const abandonedCaptureSweep = inngest.createFunction(
  {
    id: 'abandoned-capture-sweep',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => {
    const found = await step.run('find-abandoned', async () => {
      const rows = await findAbandonedCaptures(getServiceClient())
      return rows
        .slice(0, ABANDONED_SWEEP_CAP)
        .map((r) => ({ id: r.id, workspaceId: r.workspace_id as string, quietSince: r.updated_at }))
    })
    if (found.length > 0) {
      await step.sendEvent(
        'finalize-abandoned',
        found.map((c) => ({
          name: CAPTURE_ABANDONED_EVENT,
          // One finalize per quiet spell: a repeat sweep of the same spell is
          // dropped by Inngest, and a capture resumed and abandoned again is a
          // new spell (and the close's CAS makes any duplicate a no-op anyway).
          id: `capture-abandoned:${c.id}:${c.quietSince}`,
          data: { capture_id: c.id, workspace_id: c.workspaceId },
        })),
      )
    }
    // After the finish's events, so a failing retire never holds them back.
    const retired = await step.run('retire-stale', () => retireStaleCaptures(getServiceClient()))
    return { found: found.length, retired }
  },
)

export const finalizeAbandonedCapture = inngest.createFunction(
  {
    id: 'finalize-abandoned-capture',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.capture_id' }],
    triggers: [{ event: CAPTURE_ABANDONED_EVENT }],
  },
  async ({ event, step }) => {
    const { capture_id: captureId, workspace_id: workspaceId, reason: rawReason } = event.data as {
      capture_id: string
      workspace_id: string
      reason?: FinalizeReason
    }
    const reason: FinalizeReason = rawReason === 'recovery_declined' ? 'recovery_declined' : 'recorder_quiet'

    const closed = await step.run('close', async () => {
      const service = getServiceClient()
      let row: AbandonedCaptureRow | null
      if (reason === 'recovery_declined') {
        // The owner declined to resume it and the decline route closed it: only
        // the end-of-meeting pass is left.
        row = await loadDeclinedCapture(service, { captureId, workspaceId })
        if (!row) return null
      } else {
        row = await loadAbandonedCapture(service, { captureId, workspaceId })
        if (!row || !(await closeAbandonedCapture(service, row))) return null
      }
      // The batch persona the route itself would resolve (the workspace's
      // default_agents override, else its edition's): one named means a
      // specific agent writes the finished record, as on Stop.
      const settings = await fetchWorkspaceSettings(service, workspaceId)
      const hasBatchDefault = !!resolveDefaultAgentSlugFromSettings(settings, 'batch')
      return { ownerId: row.user_id as string, runBatch: needsBatchPass(row, hasBatchDefault) }
    })
    if (!closed) return { status: 'skipped' as const }
    const { ownerId } = closed
    // Resumed since it was closed (Start on the same meeting moments after a
    // declined recovery): the live session owns the capture again and its own
    // end runs this pass. Writing the record now would title it and fire
    // Triage on half the meeting while it is still recording.
    const reopened = () => step.run('check-reopened', () => captureReopened(getServiceClient(), { captureId, workspaceId }))

    if (!closed.runBatch) {
      if (await reopened()) return { status: 'reopened' as const }
      await step.run('close-record', () =>
        postExtraction(getServiceClient(), { captureId, workspaceId, ownerId, captureProcessed: true }),
      )
      return { status: 'finalized' as const, batch: 'none' as const }
    }

    const batch = await step.run('batch', () =>
      runOwnerBatch(getServiceClient(), { captureId, workspaceId, ownerId }),
    )
    if (batch === 'in_flight') {
      await step.sleep('let-batch-settle', BATCH_SETTLE)
      const stamped = await step.run('check-batch', () => batchStamped(getServiceClient(), { captureId, workspaceId }))
      if (!stamped) return { status: 'closed' as const, batch }
    }
    if (await reopened()) return { status: 'reopened' as const, batch }
    await step.run('post-extraction', () =>
      postExtraction(getServiceClient(), { captureId, workspaceId, ownerId, captureProcessed: false }),
    )
    return { status: 'finalized' as const, batch }
  },
)

/**
 * The canonical end-of-meeting batch, as the owner. 'completed' once the route
 * answered 2xx (its finalize has run), 'in_flight' when it is still going past
 * BATCH_WAIT_MS. A usage wall or a refusal never retries; any other failure
 * throws so Inngest retries the step (a re-run batch is what Reprocess does).
 */
export async function runOwnerBatch(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string; ownerId: string },
): Promise<'completed' | 'in_flight'> {
  const { token, hash, displayPrefix } = generateDeviceToken()
  const { data: minted, error } = await service
    .from('device_token')
    .insert({
      user_id: args.ownerId,
      active_workspace_id: args.workspaceId,
      name: `Finish capture ${args.captureId.slice(0, 8)}`,
      token_hash: hash,
      token_prefix: displayPrefix,
      expires_at: new Date(Date.now() + RUN_TOKEN_TTL_MS).toISOString(),
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !minted) throw new Error(`capture finalizer: token mint failed: ${error?.message ?? 'no row'}`)

  try {
    const res = await fetch(`${appBaseUrl()}/api/ai/live-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ capture_id: args.captureId, mode: 'batch', allow_auto_archive: false }),
      signal: AbortSignal.timeout(BATCH_WAIT_MS),
    })
    if (res.ok) return 'completed'
    const text = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status >= 400 && res.status < 500 && res.status !== 408) {
      throw new NonRetriableError(`capture finalizer: batch refused (${res.status}) ${text}`)
    }
    if (res.status === 503) throw new NonRetriableError(`capture finalizer: batch refused (503) ${text}`)
    throw new Error(`capture finalizer: batch failed (${res.status}) ${text}`)
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return 'in_flight'
    throw err
  } finally {
    const { error: revokeError } = await service.from('device_token').delete().eq('id', minted.id)
    if (revokeError) console.warn('[capture-finalizer] token revoke failed:', revokeError.message)
  }
}

/** Did the batch finish (its finalize stamps batch_processed_at)? */
/** Is the capture open again (resumed after this finalizer closed it, or after
 *  the decline route did)? */
async function captureReopened(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string },
): Promise<boolean> {
  const { data } = await service
    .from('captures')
    .select('ended_at')
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  return !!data && !(data as { ended_at: string | null }).ended_at
}

async function batchStamped(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string },
): Promise<boolean> {
  const { data } = await service
    .from('captures')
    .select('batch_processed_at')
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  return !!(data as { batch_processed_at: string | null } | null)?.batch_processed_at
}

/**
 * Stop's post-extraction work: name the capture from its summary, then index
 * it (and, with `captureProcessed`, close a record written live: emit
 * flow/capture.processed + stamp batch_processed_at). Title first, so the
 * indexed summary chunk carries it. A title failure never skips the index, and
 * neither failure fails the step.
 */
async function postExtraction(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string; ownerId: string; captureProcessed: boolean },
): Promise<void> {
  try {
    await generateCaptureTitle(service, { captureId: args.captureId, workspaceId: args.workspaceId, userId: args.ownerId })
  } catch (err) {
    console.warn('[capture-finalizer] title failed:', args.captureId, err instanceof Error ? err.message : err)
  }
  const { data: row } = await service
    .from('captures')
    .select('workspace_id, project_id, title, ai_summary, content, metadata, is_eval')
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  // An indexing failure is logged, never thrown: the emit (and stamp) above it
  // already went out, and a step retry would emit capture.processed twice. The
  // index-reconciler heals a summarized capture with no chunks every hour.
  try {
    await indexCaptureFinished({
      supabase: service,
      captureId: args.captureId,
      captureRow: row,
      userId: args.ownerId,
      workspaceId: args.workspaceId,
      captureProcessed: args.captureProcessed,
    })
  } catch (err) {
    console.warn('[capture-finalizer] index failed:', args.captureId, err instanceof Error ? err.message : err)
  }
}
