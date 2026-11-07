import { describe, it, expect } from 'vitest'
import { buildPausedFlows, isPausedError, type PausedFlowRunRow } from '../paused-flows'

const FLOW_B = { id: 'flow-b', name: 'Daily Triage Sweep' }

function run(id: string, firedAt: string, status: PausedFlowRunRow['status'], errorMessage: string | null): PausedFlowRunRow {
  return { id, flow_id: FLOW_B.id, status, fired_at: firedAt, error_message: errorMessage, action_results: null, flow: FLOW_B }
}

describe('buildPausedFlows', () => {
  it('marks a flow paused when its NEWEST run was a usage-limit failure', () => {
    const paused = buildPausedFlows([run('r-new', '2026-07-08T20:00:00Z', 'failed', 'AI usage limit exceeded — skill run skipped')])
    expect(paused).toEqual([{ flow_id: FLOW_B.id, flow_name: FLOW_B.name, at: '2026-07-08T20:00:00Z' }])
  })

  it('clears a flow that SUCCEEDED after an earlier pause (newest run wins)', () => {
    const paused = buildPausedFlows([
      run('r-new', '2026-07-08T21:00:00Z', 'success', null),
      run('r-old', '2026-07-08T20:00:00Z', 'failed', 'AI usage limit exceeded'),
    ])
    expect(paused).toEqual([])
  })

  it('does not mark a non-usage failure (e.g. timeout) as paused', () => {
    expect(buildPausedFlows([run('r1', '2026-07-08T20:00:00Z', 'failed', 'timed out at 120s')])).toEqual([])
  })

  it('reads the marker off a per-action error too, and tolerates an array-shaped flow embed', () => {
    const row: PausedFlowRunRow = {
      ...run('r2', '2026-07-08T20:00:00Z', 'failed', null),
      action_results: [{ error_message: 'AI usage limit reached' } as never],
      flow: [FLOW_B],
    }
    expect(buildPausedFlows([row])).toEqual([{ flow_id: FLOW_B.id, flow_name: FLOW_B.name, at: '2026-07-08T20:00:00Z' }])
    expect(isPausedError(null, undefined, 'plain failure')).toBe(false)
  })
})
