import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { aggregateDecisionReport } from '@/lib/ai/decisions/reporting/aggregate'
import type { ReportRows, UsageReportRow } from '@/lib/ai/decisions/reporting/types'
import { DecisionReportView } from '../report-view'
import DecisionsError from '../error'

const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }
const usage = (overrides: Partial<UsageReportRow> = {}): UsageReportRow => ({
  id: 'usage-1', user_id: 'user-1', workspace_id: 'workspace-1', created_at: '2026-10-04T10:00:00.000Z',
  feature: 'decision.browser.next_action', provider: 'typesafe-ai', input_tokens: 120, output_tokens: 3, estimated_cost_usd: 0.0008,
  usage_unknown: false, cost_unknown: false, cost_source: 'gateway', outcome: 'accepted',
  provider_ms: 150, total_before_accounting_ms: 250, run_id: 'command-1', ...overrides,
})
const render = (rows: Partial<ReportRows> = {}) => renderToStaticMarkup(createElement(DecisionReportView, {
  report: aggregateDecisionReport(range, { decisions: [], browserCommands: [], parentUsage: [], ...rows }, '2026-10-04T12:00:00Z'),
}))

describe('Jev performance report', () => {
  it('shows empty data without inventing successful work or zero latency', () => {
    const html = render()
    expect(html).toContain('No logged Jev attempts in this range.')
    expect(html).toContain('No browser task commands in this range.')
    expect(html).toContain('Unknown — no samples')
    expect(html).not.toContain('0 ms')
    for (const feature of ['Browser', 'Email', 'Knowledge', 'Retrieval', 'Automation']) expect(html).toContain(feature)
    expect(html).toContain('Policy acceptance means')
    expect(html).toContain('not a measure of accuracy')
    expect(html).toContain('cache hit rate or effective suppression rate cannot be inferred')
  })

  it('does not present unavailable sources as an empty, successful report', () => {
    const unavailable = { rows: 0, partial: true, truncated: false, error: 'unavailable' as const }
    const html = render({ coverage: { decisions: unavailable, browserCommands: unavailable, parentUsage: unavailable } })
    expect(html).toContain('Partial report')
    expect(html).toContain('unavailable; 0 rows loaded')
    expect(html).not.toContain('No logged Jev attempts')
    expect(html).not.toContain('No browser task commands')
    expect(html).not.toContain('$0.00')
    expect(html).toContain('Unknown')
  })

  it('retains partial usage and its unknown counts, while distinguishing task verification from policy acceptance', () => {
    const html = render({ decisions: [usage(), usage({ id: 'usage-2', input_tokens: 0, output_tokens: 0,
      estimated_cost_usd: 0, usage_unknown: true, cost_unknown: true, provider_ms: null })],
    browserCommands: [{ id: 'command-1', user_id: 'user-1', workspace_id: 'workspace-1',
      created_at: '2026-10-04T10:00:00.000Z', claimed_at: '2026-10-04T10:00:00.100Z', finished_at: '2026-10-04T10:00:02.000Z',
      status: 'completed', task_status: 'escalate', executor_ms: 1500 }],
    coverage: { decisions: { rows: 2, partial: true, truncated: true, error: null } },
    })
    expect(html).toContain('$0.0008')
    expect(html).toContain('1 rows with unknown cost')
    expect(html).toContain('0 / 1 (0%)')
    expect(html).toContain('100 ms')
    expect(html).toContain('1.50 s')
    expect(html).toContain('2.00 s')
    expect(html).toContain('row/time limit reached')
    expect(html).toContain('User-submit to final-answer latency is not measured')
    expect(html).toContain('cost or token savings are unknown')
  })

  it('shows exact parent coverage and each parent’s spend only once across multiple commands', () => {
    const commands = ['command-1', 'command-2'].map(id => ({ id, user_id: 'user-1', workspace_id: 'workspace-1',
      created_at: '2026-10-04T10:00:00.000Z', claimed_at: null, finished_at: '2026-10-04T10:00:02.000Z',
      status: 'completed', task_status: 'verified', attribution_version: 1, parent_run_id: 'parent-1' }))
    const html = render({ browserCommands: commands,
      parentUsage: [usage({ id: 'parent-usage', feature: 'ai_chat', provider: 'claude', estimated_cost_usd: 0.02,
        attribution_version: 1, parent_run_id: 'parent-1', usage_scope: 'eve_turn', usage_key: 'meter-1' })],
    })
    expect(html).toContain('2 / 2 (100%)')
    expect(html).toContain('1 parent turns with matched usage')
    expect(html).toContain('$0.02 known')
    expect(html).not.toContain('$0.04')
  })

  it('keeps dependent parent usage unknown when command loading is incomplete', () => {
    const html = render({ coverage: {
      browserCommands: { rows: 0, partial: true, truncated: false, error: 'timeout' },
      parentUsage: { rows: 0, partial: true, truncated: false, error: null },
    } })
    expect(html).toContain('Attribution coverage unavailable')
    const parentSection = html.slice(html.indexOf('Matched parent model usage'))
    expect(parentSection).toContain('Unknown')
    expect(parentSection).not.toContain('$0.00 known')
  })

  it('does not count a correlated parent turn without a usage row as matched spend', () => {
    const html = render({ browserCommands: [{ id: 'command-1', user_id: 'user-1', workspace_id: 'workspace-1',
      created_at: '2026-10-04T10:00:00.000Z', claimed_at: null, finished_at: null,
      status: 'running', attribution_version: 1, parent_run_id: 'parent-unbilled' }] })
    expect(html).toContain('1 commands have explicit run correlation')
    expect(html).toContain('0 parent turns with matched usage')
    expect(html).toContain('0 / 1 (0%)')
  })

  it('renders a safe retry state without leaking thrown details or fabricated metrics', () => {
    const html = renderToStaticMarkup(createElement(DecisionsError, { error: new Error('private database details'), reset: () => {} }))
    expect(html).toContain('The report could not be loaded')
    expect(html).toContain('Try again')
    expect(html).not.toContain('private database details')
    expect(html).not.toContain('$0')
  })
})
