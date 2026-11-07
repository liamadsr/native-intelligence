import { describe, it, expect } from 'vitest'
import { canShowCloudRunTab, cloudRunTabMarker } from '../cloud-run-gate'

/**
 * Loops v3 interactive-work rework: the action detail panel's Cloud-run tab must
 * be reachable for a work-run action AT ALL TIMES — including after the run
 * completes, when the action has NO AI assignee and agent_run_status is no longer
 * live. `canShowCloudRunTab` is the gate; these tests lock its three signals.
 */
describe('canShowCloudRunTab', () => {
  it('shows the tab for a coding action (AI assignee), regardless of run status', () => {
    expect(canShowCloudRunTab({ assignedToAi: true, hasWorkRun: false, agentRunStatus: 'idle' })).toBe(true)
  })

  it('shows the tab for a work-run action AFTER completion (no AI assignee, status idle) via hasWorkRun', () => {
    // The durable signal: a workspace-kind run exists. This is the completed
    // work-run case Liam flagged — the tab must NOT vanish once it settles.
    expect(canShowCloudRunTab({ assignedToAi: false, hasWorkRun: true, agentRunStatus: 'idle' })).toBe(true)
  })

  it('shows the tab on the first render (before hasWorkRun resolves) when the status is live', () => {
    for (const status of ['queued', 'running', 'needs_input', 'canceling']) {
      expect(canShowCloudRunTab({ assignedToAi: false, hasWorkRun: false, agentRunStatus: status })).toBe(true)
    }
  })

  it('shows the tab for a parked work run (needs_input) even before hasWorkRun resolves', () => {
    expect(canShowCloudRunTab({ assignedToAi: false, hasWorkRun: false, agentRunStatus: 'needs_input' })).toBe(true)
  })

  it('does NOT show the tab for a plain action (no AI assignee, no work run, idle)', () => {
    expect(canShowCloudRunTab({ assignedToAi: false, hasWorkRun: false, agentRunStatus: 'idle' })).toBe(false)
  })

  it('does NOT show the tab for a plain action whose status is a terminal coding outcome', () => {
    // pr_open / completed / failed / canceled are terminal — not live. Without an
    // AI assignee or a work run, a plain action never gets the tab.
    for (const status of ['pr_open', 'completed', 'failed', 'canceled']) {
      expect(canShowCloudRunTab({ assignedToAi: false, hasWorkRun: false, agentRunStatus: status })).toBe(false)
    }
  })
})

/**
 * A failed run is surfaced as a red ! on the Cloud-run tab rather than a note
 * in the properties sidebar, because the tab is where the logs explaining the
 * failure live.
 *
 * The marker is single-slot, so precedence is the whole design: 'needs_input'
 * and live runs describe what the run is doing NOW, while 'failed' describes a
 * run that already ended. Getting this backwards would leave a stale failure
 * marker on a run that has since restarted.
 */
describe('cloudRunTabMarker', () => {
  it('flags a failed run', () => {
    expect(cloudRunTabMarker('failed')).toBe('failed')
  })

  it('prefers the live signals over a failure', () => {
    // A restarted run must not still read as failed.
    expect(cloudRunTabMarker('needs_input')).toBe('needs_input')
    for (const status of ['queued', 'running', 'canceling']) {
      expect(cloudRunTabMarker(status)).toBe('live')
    }
  })

  it('shows nothing for idle or successfully settled runs', () => {
    for (const status of ['idle', 'completed', 'pr_open', 'canceled']) {
      expect(cloudRunTabMarker(status), `${status} should carry no marker`).toBeNull()
    }
  })
})
