import { describe, expect, it } from 'vitest'
import { browserTaskFinishedProperties, type SettledBrowserTaskRow } from '../task-telemetry'

const row: SettledBrowserTaskRow = {
  id: 'command', command: 'run_task', workspace_id: 'workspace', session_id: 'session', status: 'completed',
  created_at: '2026-10-05T16:50:52.000Z', claimed_at: '2026-10-05T16:50:53.000Z', finished_at: '2026-10-05T16:50:54.000Z',
}
const result = {
  status: 'escalate', reason: 'browser_observation_unavailable', steps: 0, elapsedMs: 159,
  timings: { snapshotMs: 78, settlingMs: 0, navigationMs: 81 }, telemetry: { version: 1, setupMs: 580 }, trace: [],
  diagnostics: { snapshotAttempts: 3, startupRetries: 2, lastSnapshotFailure: { phase: 'startup', code: 'runtime_starting' } },
}

describe('browser task terminal telemetry projection', () => {
  it('keeps server queue timing separate from device-reported startup failure and zero attempts', () => {
    expect(browserTaskFinishedProperties(row, result, 'a'.repeat(40))).toEqual({
      schema_version: 1, browser_command_id: 'command', eve_session_id: 'session', queue_status: 'completed',
      queue_created_at: row.created_at, queue_claimed_at: row.claimed_at, queue_finished_at: row.finished_at,
      queue_wait_ms: 1000, queue_execution_ms: 1000, queue_total_ms: 2000,
      outcome_source: 'client_reported', reported_status: 'escalate', reported_reason: 'browser_observation_unavailable',
      reported_steps: 0, reported_elapsed_ms: 159, reported_snapshot_ms: 78, reported_settling_ms: 0,
      reported_navigation_ms: 81, reported_setup_ms: 580, reported_trace_count: 0, build_sha: 'a'.repeat(40),
      reported_snapshot_attempts: 3, reported_startup_retries: 2,
      reported_snapshot_failure_phase: 'startup', reported_snapshot_failure_code: 'runtime_starting',
    })
  })

  it('never forwards raw content, arbitrary reason strings, client IDs or nested trace contents', () => {
    const secret = 'PRIVATE EMAIL https://example.com/?token=secret'
    const properties = browserTaskFinishedProperties(row, {
      ...result, status: secret, reason: secret, url: secret, error: secret, evidence: secret, message: secret,
      task: secret, args: secret, browser_command_id: secret, session_id: secret, workspace_id: secret,
      created_at: secret, build_sha: secret, trace: [{ operation: secret, metrics: { secret } }],
      diagnostics: { ...result.diagnostics, error: secret, lastSnapshotFailure: { ...result.diagnostics.lastSnapshotFailure, message: secret } },
    }, secret)
    expect(properties).toMatchObject({ browser_command_id: 'command', eve_session_id: 'session',
      reported_status: 'unknown', reported_reason: 'unknown', reported_trace_count: 1,
      reported_snapshot_failure_code: 'runtime_starting' })
    expect(JSON.stringify(properties)).not.toContain(secret)
    expect(properties).not.toHaveProperty('build_sha')
    expect(properties).not.toHaveProperty('trace')
    expect(properties).not.toHaveProperty('task')
  })

  it('omits invalid or absent metrics instead of turning unknowns into zero', () => {
    const properties = browserTaskFinishedProperties(row, {
      status: 'verified', reason: 'goal_and_predicates_satisfied', steps: 0.5, elapsedMs: Infinity,
      timings: { snapshotMs: -1, navigationMs: '10', settlingMs: 86_400_001 },
      telemetry: { version: 99, setupMs: 10 }, trace: 'not an array',
      diagnostics: { snapshotAttempts: 1, startupRetries: -1 },
    })
    expect(properties).toMatchObject({ outcome_source: 'client_reported', reported_status: 'verified' })
    expect(Object.keys(properties!).filter(key => key.startsWith('reported_')).sort()).toEqual(['reported_reason', 'reported_status'])
    expect(browserTaskFinishedProperties(row, null)).not.toHaveProperty('reported_trace_count')
  })

  it('rejects unrecognized diagnostic categories rather than copying them into analytics', () => {
    const properties = browserTaskFinishedProperties(row, { ...result,
      diagnostics: { snapshotAttempts: 1, startupRetries: 0, lastSnapshotFailure: { phase: 'private page', code: 'raw error' } },
    })
    expect(properties).not.toHaveProperty('reported_snapshot_failure_phase')
    expect(properties).not.toHaveProperty('reported_snapshot_failure_code')
    expect(JSON.stringify(properties)).not.toContain('raw error')
  })

  it('omits broken server timestamps and negative spans', () => {
    const properties = browserTaskFinishedProperties({ ...row, created_at: 'invalid', claimed_at: row.finished_at, finished_at: row.claimed_at, session_id: null }, null)
    expect(properties).not.toHaveProperty('queue_created_at')
    expect(properties).not.toHaveProperty('queue_wait_ms')
    expect(properties).not.toHaveProperty('queue_total_ms')
    expect(properties).not.toHaveProperty('queue_execution_ms')
    expect(properties).not.toHaveProperty('eve_session_id')
  })

  it('does not report non-task commands or nonterminal rows', () => {
    expect(browserTaskFinishedProperties({ ...row, command: 'read_page' }, result)).toBeNull()
    expect(browserTaskFinishedProperties({ ...row, status: 'running' }, result)).toBeNull()
  })
})
