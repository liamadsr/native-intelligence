import { getServiceClient } from '@/lib/admin'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { inngest } from './client'

/**
 * flow/capture.processed → one "Meeting processed" line in the capture
 * OWNER's agent log (src/lib/log/agent-log.ts, migration 329; A2b).
 *
 * Owner only, in the capture's own workspace: the event carries no user, so
 * the owner is read off the row (captures.user_id), and the line is written
 * for that one (workspace, user) and nobody else (decision 2's walls; no fan
 * out to the meeting's other members in v1). A private capture logs too: the
 * line is its owner's alone, and RLS shows it to no one else.
 *
 * Skips: reconciler re-fires (`reconciled: true`, not a new processing
 * completion), demo and archived captures (migration 329's backfill leaves
 * out the same), ownerless rows. A reprocess re-fires the event on purpose;
 * the dedupe key (one line per capture) makes it a no-op, so the log says a
 * meeting was processed once.
 *
 * A write that doesn't land throws inside its step, so Inngest retries it;
 * the dedupe key makes a retry after a write that did land a no-op.
 */
export const agentLogCaptureProcessed = inngest.createFunction(
  {
    id: 'agent-log-capture-processed',
    retries: 2,
    triggers: [{ event: 'flow/capture.processed' }],
  },
  async ({ event, step }) => {
    // snake_case keys (emit-capture-processed.ts).
    const data = event.data as {
      workspace_id?: string
      capture_id?: string
      processed_at?: string
      reconciled?: boolean
    }
    if (data.reconciled === true) return { status: 'skipped', reason: 'reconciled_refire' }
    if (!data.workspace_id || !data.capture_id) return { status: 'skipped', reason: 'bad_event' }
    const workspaceId = data.workspace_id
    const captureId = data.capture_id

    const capture = await step.run('load-capture', async () => {
      const { data: row, error } = await getServiceClient()
        .from('captures')
        .select('id, title, user_id, batch_processed_at, metadata, status')
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (error) throw new Error(`capture read failed: ${error.message}`)
      if (!row) return null
      return {
        title: (row.title as string | null) ?? null,
        userId: (row.user_id as string | null) ?? null,
        processedAt: (row.batch_processed_at as string | null) ?? null,
        isDemo: (row.metadata as { demo?: unknown } | null)?.demo === true,
        isArchived: row.status === 'archived',
      }
    })

    if (!capture) return { status: 'skipped', reason: 'missing_capture' }
    if (capture.isDemo) return { status: 'skipped', reason: 'demo_capture' }
    if (capture.isArchived) return { status: 'skipped', reason: 'archived_capture' }
    const ownerUserId = capture.userId
    if (!ownerUserId) return { status: 'skipped', reason: 'no_owner' }

    const said = logLineFor({ type: 'capture_processed', title: capture.title })
    if (!said) return { status: 'skipped', reason: 'no_line' }

    await step.run('append-log', async () => {
      const written = await appendLogLine({
        workspaceId,
        userId: ownerUserId,
        kind: said.kind,
        area: 'captures',
        line: said.line,
        refType: 'capture',
        refId: captureId,
        dedupeKey: logDedupeKey.captureProcessed(captureId),
        at: data.processed_at ?? capture.processedAt,
      })
      // appendLogLine never throws; a false is a write that didn't land. Throw so Inngest retries.
      if (!written) throw new Error('agent_log write did not land')
      return true
    })
    return { status: 'logged', captureId }
  },
)
