import { describe, expect, it } from 'vitest'
import { aggregateDecisionReport, distribution, MAX_VISIBLE_RUNS } from '../aggregate'
import { PARENT_USAGE_PROVIDERS } from '../provenance'
import type { BrowserCommandReportRow, ReportRange, UsageReportRow } from '../types'

const range: ReportRange = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' }
const date = '2026-10-03T10:00:00.000Z'
function decision(overrides: Partial<UsageReportRow> = {}): UsageReportRow {
  return { id: 'usage1', user_id: 'user1', workspace_id: 'workspace1', created_at: date,
    provider: 'typesafe-ai', feature: 'decision.browser.next_action', input_tokens: 100, output_tokens: 1, estimated_cost_usd: 0.001,
    usage_unknown: false, cost_unknown: false, cost_source: 'gateway', outcome: 'accepted',
    provider_ms: 20, total_before_accounting_ms: 35, ...overrides }
}
function command(overrides: Partial<BrowserCommandReportRow> = {}): BrowserCommandReportRow {
  return { id: 'command1', user_id: 'user1', workspace_id: 'workspace1', created_at: date,
    claimed_at: '2026-10-03T10:00:00.100Z', finished_at: '2026-10-03T10:00:01.000Z',
    status: 'completed', task_status: 'verified', executor_ms: 800, setup_ms: 40,
    attribution_version: 1, parent_run_id: 'parent1', ...overrides }
}
function parent(overrides: Partial<UsageReportRow> = {}): UsageReportRow {
  return decision({ id: 'parentUsage1', feature: 'ai_chat', provider: 'claude', inference_id: null, parent_run_id: 'parent1',
    attribution_version: 1, usage_scope: 'eve_turn', usage_key: 'turn1', cost_source: 'eve_reported',
    estimated_cost_usd: 0.15, input_tokens: 1000, output_tokens: 200, ...overrides })
}
function report(decisions: UsageReportRow[] = [], commands: BrowserCommandReportRow[] = [], parents: UsageReportRow[] = []) {
  return aggregateDecisionReport(range, { decisions, browserCommands: commands, parentUsage: parents }, date)
}

describe('decision reporting aggregation', () => {
  it('joins field text by command, user and workspace without mixing it into Jev or parent spend', () => {
    const helper = decision({ id: 'text', provider: 'deepseek', feature: 'browser.field_text', run_id: 'command1', estimated_cost_usd: 0.02 })
    const result = aggregateDecisionReport(range, { decisions: [], browserCommands: [command()], parentUsage: [], fieldTextUsage: [
      helper, helper, { ...helper, id: 'wrong-user', user_id: 'another' }, { ...helper, id: 'wrong-workspace', workspace_id: 'another' },
      { ...helper, id: 'forged', provider: 'claude-code-local' }, { ...helper, id: 'wrong-command', run_id: 'another' },
    ] }, date)
    expect(result.browser.fieldText).toMatchObject({ rows: 1, knownCostUsd: 0.02 })
    expect(result.browser.runs[0].fieldText).toMatchObject({ rows: 1, knownCostUsd: 0.02 })
    expect(result.browser.jev.rows).toBe(0)
    expect(result.browser.parent.rows).toBe(0)
  })
  it('retains five feature groups, no empty-sample percentiles, and documents unmeasured caches', () => {
    const result = report()
    expect(result.features.map(row => row.key)).toEqual(['browser', 'email', 'knowledge', 'retrieval', 'automation'])
    expect(result.overview.attempts).toBe(0)
    expect(result.browser.queueMs).toEqual({ samples: 0, p50: null, p95: null })
    expect(result.coverage.notes.join(' ')).toMatch(/Cache hits/)
    expect(result.coverage.notes.join(' ')).toMatch(/not establish savings/)
  })

  it('groups knowledge kinds, keeps unknown kinds, and separates policy outcomes', () => {
    const rows = ['anchor', 'relationship', 'extraction_required'].map((kind, i) => decision({ id: `k${i}`, feature: `decision.knowledge.${kind}`, outcome: ['accepted', 'escalate', 'cancelled'][i] }))
    const result = report([...rows, decision({ id: 'other', feature: 'decision.new.kind', outcome: 'new_outcome' }), decision({ id: 'nonDecision', feature: 'ai_chat' })])
    expect(result.features.find(row => row.key === 'knowledge')).toMatchObject({ attempts: 3, policy: { accepted: 1, escalated: 1, cancelled: 1, other: 0 } })
    expect(result.features.find(row => row.key === 'other')?.attempts).toBe(1)
    expect(result.overview.policy).toEqual({ accepted: 1, escalated: 1, cancelled: 1, other: 1 })
  })

  it('ignores forged local decision and parent metadata before deduplication or attribution', () => {
    const legitimate = decision({ inference_id: 'real-inference', run_id: 'command1' })
    const result = report([
      decision({ id: 'forgedDecision', provider: 'claude-code-local', inference_id: 'real-inference', run_id: 'command1', estimated_cost_usd: 50 }),
      decision({ id: 'wrongProvider', provider: 'claude', estimated_cost_usd: 50 }),
      legitimate,
    ], [command()], [
      parent({ id: 'forgedParent', provider: 'claude-code-local', usage_key: 'turn1', browser_command_ids: ['command1'], estimated_cost_usd: 50 }),
      parent({ id: 'forgedLink', provider: 'claude-code-local', parent_run_id: 'malicious', browser_command_ids: ['command1'], estimated_cost_usd: 50 }),
      parent({ id: 'wrongFeature', feature: 'ai_complete', estimated_cost_usd: 50 }),
      parent({ id: 'wrongParentProvider', provider: 'typesafe-ai', estimated_cost_usd: 50 }),
      parent(),
    ])
    expect(result.overview.attempts).toBe(1)
    expect(result.overview.usage.knownCostUsd).toBe(0.001)
    expect(result.browser.jev.rows).toBe(1)
    expect(result.browser.parent).toMatchObject({ rows: 1, knownCostUsd: 0.15 })
    expect(result.browser.parentTurns.map(row => row.parentRunId)).toEqual(['parent1'])
  })

  it.each(PARENT_USAGE_PROVIDERS)('retains the server chat meter provider %s', provider => {
    const result = report([], [command()], [parent({ provider })])
    expect(result.browser.parent.rows).toBe(1)
  })

  it('does not count ledger placeholder zeroes or unlabelled legacy cost as known', () => {
    const result = report([
      decision(),
      decision({ id: 'missing', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, usage_unknown: true, cost_unknown: true, cost_source: 'unknown' }),
      decision({ id: 'legacy', usage_unknown: undefined, cost_unknown: undefined, cost_source: undefined }),
      decision({ id: 'catalog', estimated_cost_usd: '0.002', cost_source: 'catalog' }),
    ])
    expect(result.overview.usage).toEqual({ rows: 4, knownCostUsd: 0.003, knownInputTokens: 200, knownOutputTokens: 2,
      unknownCostRows: 2, unknownInputTokenRows: 2, unknownOutputTokenRows: 2, incompleteUsageRows: 2, catalogCostRows: 1 })
  })

  it('handles scalar string projections and rejects malformed/negative metrics', () => {
    const result = report([decision({ usage_unknown: 'false', cost_unknown: 'false', provider_ms: '12', total_before_accounting_ms: '19' }),
      decision({ id: 'invalid', provider_ms: '-1', total_before_accounting_ms: '', estimated_cost_usd: 'NaN' })])
    expect(result.features[0].providerMs).toEqual({ samples: 1, p50: 12, p95: 12 })
    expect(result.features[0].serviceBeforeAccountingMs.samples).toBe(1)
    expect(result.overview.usage.unknownCostRows).toBe(1)
  })

  it('deduplicates attempts by row ID and by user-scoped inference identity', () => {
    const one = decision({ inference_id: 'inference1' })
    const result = report([one, one, decision({ id: 'retry', inference_id: 'inference1' }), decision({ id: 'separateUser', user_id: 'user2', inference_id: 'inference1' })])
    expect(result.overview.attempts).toBe(2)
  })

  it('filters the half-open date range and workspace before aggregating', () => {
    const scoped = { ...range, workspaceId: 'workspace1' }
    const result = aggregateDecisionReport(scoped, { decisions: [decision(), decision({ id: 'other', workspace_id: 'workspace2' }),
      decision({ id: 'end', created_at: range.to }), decision({ id: 'bad', created_at: 'no-date' }), decision({ id: 'early', created_at: '2026-09-30T00:00:00Z' })],
    browserCommands: [command(), command({ id: 'c2', workspace_id: 'workspace2' })], parentUsage: [] })
    expect(result.overview.attempts).toBe(1)
    expect(result.browser.commands).toBe(1)
  })

  it('counts final browser verification independently of accepted Jev calls', () => {
    const result = report([decision({ run_id: 'c1' })], [
      command({ id: 'c1', task_status: 'escalate' }), command({ id: 'c2', task_status: 'cancelled' }),
      command({ id: 'c3', status: 'failed', task_status: 'verified' }), command({ id: 'c4', status: 'running', task_status: 'verified' }),
      command({ id: 'c5', task_status: null }), command({ id: 'c6' }),
    ])
    expect(result.overview.policy.accepted).toBe(1)
    expect(result.browser).toMatchObject({ commands: 6, verified: 1, escalated: 1, cancelled: 1, failed: 1, pending: 1, unknown: 1 })
  })

  it('uses only real measured spans and retains unknown historical setup', () => {
    const result = report([], [command(), command({ id: 'older', setup_ms: null, executor_ms: null, claimed_at: null, finished_at: null }),
      command({ id: 'skew', claimed_at: '2026-10-03T09:59:59Z', finished_at: 'invalid', executor_ms: '-5', setup_ms: '-2' })])
    expect(result.browser.queueMs).toEqual({ samples: 1, p50: 100, p95: 100 })
    expect(result.browser.setupMs).toEqual({ samples: 1, p50: 40, p95: 40 })
    expect(result.browser.executorMs).toEqual({ samples: 1, p50: 800, p95: 800 })
    expect(result.browser.endToEndMs).toEqual({ samples: 1, p50: 1000, p95: 1000 })
  })

  it('counts a shared parent turn and compaction once across multiple tasks and duplicate fetch pages', () => {
    const shared = parent()
    const result = report([decision({ run_id: 'c1' }), decision({ id: 'j2', run_id: 'c2' })], [command({ id: 'c1' }), command({ id: 'c2' })],
      [shared, shared, parent({ id: 'duplicateBilling', usage_key: 'turn1' }), parent({ id: 'compact', usage_scope: 'eve_compaction', usage_key: 'turn1:compact', estimated_cost_usd: 0.02 })])
    expect(result.browser.parent.knownCostUsd).toBeCloseTo(0.17)
    expect(result.browser.parent.rows).toBe(2)
    expect(result.browser.jev.rows).toBe(2)
    expect(result.browser.parentTurns).toHaveLength(1)
    expect(result.browser.parentTurns[0].commandIds.sort()).toEqual(['c1', 'c2'])
    expect(result.browser.commandsWithParentUsage).toBe(2)
    expect(result.browser.runs[0]).not.toHaveProperty('parentCost')
  })

  it('links a later wait/read parent turn via trusted command IDs without multiplying its spend', () => {
    const result = report([], [command({ id: 'c1' }), command({ id: 'c2', attribution_version: null, parent_run_id: null })], [
      parent(), parent({ id: 'wait', usage_key: 'wait-turn', parent_run_id: 'parent2', browser_command_ids: ['c1', 'c2'], estimated_cost_usd: 0.3 }),
    ])
    expect(result.browser.parent.knownCostUsd).toBeCloseTo(0.45)
    expect(result.browser.commandsWithParentUsage).toBe(2)
    expect(result.browser.correlatedCommands).toBe(2)
    expect(result.browser.parentTurns.find(row => row.parentRunId === 'parent2')?.commandIds.sort()).toEqual(['c1', 'c2'])
  })

  it('never uses a shared timestamp/session or cross-user/workspace identifier as correlation', () => {
    const result = report([
      decision({ run_id: 'command1', user_id: 'other' }), decision({ id: 'crossWorkspace', run_id: 'command1', workspace_id: 'elsewhere' }),
      decision({ id: 'noRun', run_id: null }),
    ], [command()], [parent({ user_id: 'other' }), parent({ id: 'crossWorkspace', workspace_id: 'elsewhere', browser_command_ids: ['command1'] }),
      parent({ id: 'legacy', attribution_version: null }), parent({ id: 'uncorrelated', parent_run_id: 'other', browser_command_ids: ['not-the-command'] })])
    expect(result.browser.parent.rows).toBe(0)
    expect(result.browser.jev.rows).toBe(0)
    expect(result.browser.commandsWithParentUsage).toBe(0)
  })

  it('preserves partial known parent fields but exposes incomplete failed/superseded attempt coverage', () => {
    const result = report([], [command()], [parent({ usage_unknown: true, input_tokens_reported: true, output_tokens_reported: true })])
    expect(result.browser.parent).toMatchObject({ knownInputTokens: 1000, knownOutputTokens: 200, incompleteUsageRows: 1, unknownInputTokenRows: 0 })
  })

  it('propagates source errors/partial reads and limits displayed runs without altering aggregates', () => {
    const rows = Array.from({ length: MAX_VISIBLE_RUNS + 2 }, (_, i) => command({ id: `command${i}` }))
    const result = aggregateDecisionReport(range, { decisions: [], browserCommands: rows, parentUsage: [], coverage: {
      decisions: { rows: 0, partial: true, truncated: false, error: 'unavailable' },
      browserCommands: { rows: rows.length, partial: true, truncated: true, error: null },
    } })
    expect(result.browser.commands).toBe(MAX_VISIBLE_RUNS + 2)
    expect(result.browser.runs).toHaveLength(MAX_VISIBLE_RUNS)
    expect(result.browser.runsOmitted).toBe(2)
    expect(result.coverage.partial).toBe(true)
    expect(result.coverage.decisions.error).toBe('unavailable')
    expect(result.coverage.notes.at(-1)).toMatch(/incomplete/)
  })
})

describe('distribution', () => {
  it('calculates interpolated quantiles and discards unavailable values', () => {
    expect(distribution([100, null, 200, NaN, -10])).toEqual({ samples: 2, p50: 150, p95: 195 })
    expect(distribution([0])).toEqual({ samples: 1, p50: 0, p95: 0 })
  })
})
