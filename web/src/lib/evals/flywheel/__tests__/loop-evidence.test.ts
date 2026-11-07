/**
 * Failed jobs as evidence (loop-evidence.ts). Pinned: which failures count
 * (only `failed`, minus the usage limit, the kill switch, a dormant
 * workspace, a cancel and the reaper's no-report-back), the evidence built
 * from the ledger row, its flow run's failed actions and the END of its agent
 * run's log, and the batched context read (owner, flow run, agent run, flow,
 * skill slug).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { buildLoopRunEvidence, loadLoopContext, loopEvidenceFrom, loopSkipReason, type FailedJobRow } from '../loop-evidence'
import { FLYWHEEL_LIMITS } from '../types'
import { AGENT_PAUSED_REASON } from '@/lib/work/agent-paused'
import { NO_REPORT_BACK } from '@/lib/work/reaper'

const job = (over: Partial<FailedJobRow> = {}): FailedJobRow => ({
  id: 'job-1',
  workspace_id: 'ws-1',
  member_id: 'mem-1',
  kind: 'flow_run',
  title: 'Morning triage',
  status: 'failed',
  error_message: 'run_skill: the model returned no verdict',
  source: { flow_id: 'flow-1', capture_id: 'cap-1' },
  flow_run_id: 'fr-1',
  agent_run_id: null,
  finished_at: '2026-10-16T10:00:00.000Z',
  ...over,
})

describe('loopSkipReason', () => {
  it('a real failure counts', () => {
    expect(loopSkipReason(job())).toBeNull()
    expect(loopSkipReason(job({ error_message: null }))).toBeNull()
  })

  it('only failed rows: canceled and skipped are never read', () => {
    expect(loopSkipReason(job({ status: 'canceled' }))).toBe('not_failed')
    expect(loopSkipReason(job({ status: 'skipped' }))).toBe('not_failed')
  })

  it.each([
    ['Usage limit reached for user u-1 (monthly_limit); skipping background AI job.', 'usage_limit'],
    ['subscription_required', 'usage_limit'],
    [`${AGENT_PAUSED_REASON}. Do not call any more tools`, 'kill_switch'],
    ['refused [AGENT_PAUSED]', 'kill_switch'],
    ['workspace inactive for 14d — skipped (no cost)', 'dormant'],
    ['Workspace dormant', 'dormant'],
    ['Run canceled by the person', 'canceled'],
    ['cancelled', 'canceled'],
    [NO_REPORT_BACK, 'no_report_back'],
  ])('%s → %s', (error, reason) => {
    expect(loopSkipReason(job({ error_message: error }))).toBe(reason)
  })
})

describe('buildLoopRunEvidence', () => {
  it('the row, the flow run’s failed actions (by type), the end of the log, the pointers', () => {
    const ev = buildLoopRunEvidence(job({ agent_run_id: 'ar-1' }), {
      flowRun: {
        id: 'fr-1',
        flow_id: 'flow-1',
        action_results: [
          { action_id: 'a1', status: 'success', skipped: false, error_message: null },
          { action_id: 'a2', status: 'failed', skipped: false, error_message: 'no verdict' },
          { action_id: 'a3', status: 'failed', skipped: true, error_message: 'ignored' },
        ],
      },
      flow: { id: 'flow-1', actions: [{ id: 'a2', type: 'run_skill', config: { skill_id: 'rec-1' } }] },
      agentRun: { id: 'ar-1', error_message: null, log_tail: `${'early '.repeat(500)}THE END` },
      skill: 'triage',
    })
    expect(ev).toMatchObject({
      kind: 'loop_run',
      jobKind: 'flow_run',
      title: 'Morning triage',
      error: 'run_skill: the model returned no verdict',
      flowErrors: [{ action: 'run_skill', error: 'no verdict' }],
      flowId: 'flow-1',
      flowRunId: 'fr-1',
      agentRunId: 'ar-1',
      captureId: 'cap-1',
      skill: 'triage',
      at: '2026-10-16T10:00:00.000Z',
    })
    expect(ev.logTail!.endsWith('THE END')).toBe(true)
    expect(ev.logTail!.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.logTail)
  })

  it('a bare row is enough', () => {
    expect(buildLoopRunEvidence(job({ source: null, flow_run_id: null, title: null, finished_at: null }))).toEqual({
      kind: 'loop_run',
      jobKind: 'flow_run',
      error: 'run_skill: the model returned no verdict',
    })
  })
})

describe('loadLoopContext + loopEvidenceFrom', () => {
  it('reads the owner, the flow run, the agent run, the flow and the skill slug in batches', async () => {
    const fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'mem-1', user_id: 'user-1' }])
    fake.seed('flow_run', [{ id: 'fr-1', flow_id: 'flow-1', action_results: [{ action_id: 'a2', status: 'failed', error_message: 'no verdict' }] }])
    fake.seed('agent_run', [{ id: 'ar-9', error_message: 'sandbox died', log_tail: 'tail' }])
    fake.seed('flow', [{ id: 'flow-1', actions: [{ id: 'a2', type: 'run_skill', config: { skill_id: 'rec-1' } }] }])
    fake.seed('recipe', [{ id: 'rec-1', slug: 'triage' }])
    const jobs = [job(), job({ id: 'job-2', kind: 'coding_run', flow_run_id: null, source: {}, agent_run_id: 'ar-9', error_message: null })]
    const context = await loadLoopContext(fake as unknown as SupabaseClient, jobs)
    expect(context.users.get('mem-1')).toBe('user-1')

    const first = loopEvidenceFrom(jobs[0], context)
    expect(first.skill).toBe('triage')
    expect(first.evidence.flowErrors).toEqual([{ action: 'run_skill', error: 'no verdict' }])

    const second = loopEvidenceFrom(jobs[1], context)
    expect(second.skill).toBeNull()
    expect(second.evidence).toMatchObject({ jobKind: 'coding_run', error: 'sandbox died', logTail: 'tail', agentRunId: 'ar-9' })
  })

  it('a failed read leaves the context empty, never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { from: () => { throw new Error('down') } }
    const context = await loadLoopContext(broken as unknown as SupabaseClient, [job()])
    expect(context.users.size).toBe(0)
  })
})
