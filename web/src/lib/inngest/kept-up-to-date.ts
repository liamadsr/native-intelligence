import { getServiceClient } from '@/lib/admin'
import { keptFromCapture } from '@/lib/kept-up-to-date/sources'
import { inngest } from './client'

/**
 * flow/capture.processed → a finished meeting keeps its owner's records up
 * to date (tables phase 8, src/lib/kept-up-to-date/sources.ts
 * keptFromCapture): after the batch extraction, the one change the meeting
 * states in plain words is applied, with Undo in the owner's home thread.
 *
 * The extraction's own proposals stay the meeting's cards: to-dos they name
 * are left alone. Skips the reconciler's re-fires (`reconciled: true`, not a
 * new extraction). A reprocess re-fires on purpose: the engine changes
 * nothing twice for one capture (kept_change, migration 539), so a re-run is
 * a no-op once it has changed something.
 *
 * One step; the engine never throws, so a retry only follows a crash, and
 * then the unique row keeps it from changing anything twice.
 */
export const keptUpToDateOnCaptureProcessed = inngest.createFunction(
  {
    id: 'kept-up-to-date-capture-processed',
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.capture_id' }],
    triggers: [{ event: 'flow/capture.processed' }],
  },
  async ({ event, step }) => {
    // snake_case keys (emit-capture-processed.ts).
    const data = event.data as { workspace_id?: string; capture_id?: string; reconciled?: boolean }
    if (data.reconciled === true) return { status: 'skipped', reason: 'reconciled_refire' }
    if (!data.workspace_id || !data.capture_id) return { status: 'skipped', reason: 'bad_event' }
    const workspaceId = data.workspace_id
    const captureId = data.capture_id
    const outcome = await step.run('keep-up-to-date', () => keptFromCapture(getServiceClient(), { workspaceId, captureId }))
    return { status: outcome }
  },
)
