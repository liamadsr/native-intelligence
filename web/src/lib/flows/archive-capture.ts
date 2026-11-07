/**
 * Headless archive_capture executor (GEN-134) — a native flow action that
 * archives the capture that triggered the flow. This is the flow-native
 * counterpart to GEN-135's inline finalize-path auto-archive: it lets a
 * capture_processed loop archive junk captures declaratively (e.g. a Capture
 * Groom flow whose condition matched a mis-fire) instead of only via the
 * hard-coded finalize branch.
 *
 * Fences (archiving is destructive-ish and captures have no in-product unarchive
 * yet — see spawned task 509816db):
 *   - Only ever touches the TRIGGERING capture (ctx.capture). No capture on the
 *     fire (schedule / entity_status_change) → clean no-op success.
 *   - The capture must belong to the flow's workspace (service role bypasses
 *     RLS, so scope the UPDATE by workspace_id explicitly).
 *   - Never archives a demo / onboarding-seeded capture (metadata.demo).
 *   - Idempotent: already-archived → success no-op (no redundant write).
 * Reversible: sets captures.status = 'archived' (a soft delete; row + audio
 * stay), same as the GEN-135 path.
 *
 * The runner (runner.ts) stays pure: callers build this executor and inject it
 * via runFlow's `executors` option.
 */
import { getServiceClient } from '@/lib/admin'
import type { ArchiveCaptureExecutor, ArchiveCaptureExecutionResult } from './runner'

export function createArchiveCaptureExecutor(deps: {
  workspaceId: string
}): ArchiveCaptureExecutor {
  return async (_action, ctx) => {
    const startedAt = Date.now()
    const { workspaceId } = deps
    const captureId = ctx.capture?.id ?? null

    const base = (
      overrides: Partial<ArchiveCaptureExecutionResult>,
    ): ArchiveCaptureExecutionResult => ({
      status: 'success',
      request_summary: {
        method: 'ARCHIVE_CAPTURE',
        url: captureId ? `capture://${captureId}` : 'capture://none',
        header_names: [],
        body_byte_length: 0,
      },
      response_status_code: 200,
      response_body_preview: null,
      error_message: null,
      duration_ms: Date.now() - startedAt,
      archived_capture_id: null,
      ...overrides,
    })

    // No triggering capture → nothing to archive. Not a failure: an
    // archive_capture action on a non-capture fire is simply inert.
    if (!captureId) {
      return base({ response_body_preview: 'no triggering capture — nothing to archive' })
    }

    try {
      const supabase = getServiceClient()

      // Load the capture, scoped to the flow's workspace. Read the fields we
      // need to fence: demo flag + current status (for idempotency).
      const { data: capture, error: readError } = await supabase
        .from('captures')
        .select('id, status, metadata')
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
        .maybeSingle<{ id: string; status: string | null; metadata: { demo?: boolean } | null }>()

      if (readError) {
        return base({
          status: 'failed',
          response_status_code: 500,
          error_message: `Capture read failed: ${readError.message}`,
        })
      }
      // Not found in this workspace → a stale / cross-workspace reference. Don't
      // fail the flow; there's simply nothing here to archive.
      if (!capture) {
        return base({
          response_body_preview: `capture ${captureId} not found in workspace — skipped`,
        })
      }

      // Never archive a demo / onboarding-seeded capture.
      if (capture.metadata?.demo === true) {
        return base({ response_body_preview: 'demo capture — not archived' })
      }

      // Idempotent: already archived → success, no redundant write.
      if (capture.status === 'archived') {
        return base({
          response_body_preview: 'capture already archived',
          archived_capture_id: captureId,
        })
      }

      const { error: updateError } = await supabase
        .from('captures')
        .update({ status: 'archived' })
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)

      if (updateError) {
        return base({
          status: 'failed',
          response_status_code: 500,
          error_message: `Archive failed: ${updateError.message}`,
        })
      }

      return base({
        response_body_preview: `archived capture ${captureId}`,
        archived_capture_id: captureId,
      })
    } catch (err) {
      return base({
        status: 'failed',
        response_status_code: 500,
        error_message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
