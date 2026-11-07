import { inngest } from '@/lib/inngest/client'
import { getServiceClient } from '@/lib/admin'

/**
 * Emit the `flow/capture.processed` trigger event after a capture's batch
 * extraction completes (docs/loop-engine/DESIGN.md, "capture_processed
 * trigger"). Single emit point: the live-agent route's finalize(), alongside
 * the batch_processed_at stamp. Reprocess re-fires deliberately — re-running
 * a capture through extraction then re-running its loops is desired behavior.
 *
 * Fire-and-forget, same contract as emit-status-change.ts: the Inngest send
 * is awaited only enough to attach a catch; callers must NOT block their
 * response on flow delivery. The Inngest function
 * (`flowDispatchOnCaptureProcessed`) matches enabled capture_processed flows
 * in the workspace and writes a flow_run row per attempt — delivery is
 * observable in `flow_run` regardless of caller.
 *
 * ── Private captures do not trigger workspace automations ────────────────
 * A private capture ("Only me") must not fire workspace flows: an unattended
 * run's output lands in workspace-readable tables (`document`, proposals), and
 * the run's tools now refuse to read a private capture anyway
 * (`omitPrivateCaptures`), so the fire could only ever produce a report built
 * from the title alone. See docs/design-capture-visibility.md.
 *
 * The gate is a `flow_eligible` flag on the event rather than suppression of
 * the whole send, because several functions consume `flow/capture.processed`
 * and only the flow dispatcher must stop:
 *   - `flowDispatchOnCaptureProcessed` — workspace automations. Gated here.
 *   - `captureIngest` → `claim/extract-from-source` — the creator's own
 *     knowledge graph. Deliberately still runs: the design keeps claims from
 *     private captures and gates them at READ time by source visibility
 *     (design doc, "Derived content rule" + access matrix row 4). Suppressing
 *     the event would silently delete the creator's own claims instead.
 *   - `captureIngest` → `crm/hubspot-log-capture` — external CRM writeback,
 *     which owns all of its own gating.
 *   - `agentLogCaptureProcessed` — one "Meeting processed" line in the
 *     owner's own agent log (agent-log-capture.ts). Deliberately still runs:
 *     the line is the owner's alone.
 *
 * Visibility is resolved here (one cheap service-role read) unless the caller
 * already has it in hand. Fails CLOSED: a missing row or a failed read marks
 * the fire ineligible, matching `isCaptureVisible`'s posture.
 */
export function emitCaptureProcessed(args: {
  workspaceId: string
  captureId: string
  processedAt?: string
  /** Pass when already in hand to skip the visibility read. */
  visibility?: string | null
}): void {
  const { workspaceId, captureId, processedAt, visibility } = args

  const eligible =
    visibility === undefined
      ? resolveFlowEligible(workspaceId, captureId)
      : Promise.resolve(visibility !== 'private')

  eligible
    .then((flowEligible) =>
      inngest.send({
        name: 'flow/capture.processed',
        data: {
          workspace_id: workspaceId,
          capture_id: captureId,
          processed_at: processedAt ?? new Date().toISOString(),
          flow_eligible: flowEligible,
        },
      }),
    )
    .catch((err) => {
      console.error('[flows] inngest.send failed', err)
    })
}

/**
 * Read the capture's visibility on a service-role client. Fails closed —
 * a missing row or any read error yields `false` (no flow fire), because the
 * alternative is firing workspace automations on a capture we could not prove
 * is workspace-visible.
 */
async function resolveFlowEligible(
  workspaceId: string,
  captureId: string,
): Promise<boolean> {
  try {
    const { data } = await getServiceClient()
      .from('captures')
      .select('visibility')
      .eq('id', captureId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return !!data && (data as { visibility?: string | null }).visibility !== 'private'
  } catch {
    return false
  }
}
