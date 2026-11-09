import { describe, expect, it } from 'vitest'
import { compactBrowserTaskResult } from '../task-result-summary'

const step = (inputTokens: number, outputTokens: number, costUsd: number, costSource = 'gateway') => ({
  step: 0, operation: 'click', decisionMs: 120, actionMs: 10,
  routeTimingMs: { authorization: 4, provider: 50 }, metrics: { timingMs: { provider: 50 },
    usage: { inputTokens, outputTokens, costUsd, costSource, known: true } },
})
const base = { status: 'verified', reason: 'goal_and_predicates_satisfied', steps: 2, elapsedMs: 300,
  url: 'https://example.com/results', evidence: 'Search results', tabId: 'tab',
  timings: { navigationMs: 40, snapshotMs: 20, settlingMs: 120 },
  trace: [step(100, 10, 0.001), { ...step(200, 20, 0.002), recovery: 'page_changed' }] }

describe('compact browser task results', () => {
  it('returns copyable citations for every captured heading link without inventing clean URLs', () => {
    const freshReadings = { evidence: { documentLinks: [
      { title: 'Third [article]', destination: 'https://example.com/goto?url=opaque', order: 20, section: 'Articles' },
      { title: 'First article', destination: 'https://example.com/first', order: 4, section: 'Articles' },
    ], documentLinksTruncated: true } }
    expect(compactBrowserTaskResult({ ...base, freshReadings })).toMatchObject({ sourceReferences: { truncated: true, citations: [
      '[First article](<https://example.com/first>)', '[Third \\[article\\]](<https://example.com/goto?url=opaque>)',
    ] } })
    // An unverified task still hands its exact links to the parent, with guidance.
    expect(compactBrowserTaskResult({ ...base, status: 'escalate', reason: 'step_budget', freshReadings })).toMatchObject({
      next: expect.stringContaining('Not verified'), sourceReferences: { citations: expect.arrayContaining(['[First article](<https://example.com/first>)']) } })
  })
  it.each(['write_outcome_unknown', 'write_unverified', 'transport_or_write_outcome_unknown'])('warns before continuing after a possible write (%s)', reason => {
    const compact = compactBrowserTaskResult({ ...base, status: 'escalate', reason, trace: [] }) as { next: string }
    expect(compact.next).toMatch(/^The last browser action may have taken effect\. .*never repeat a submit.*no startUrl/)
  })
  it.each(['question_budget', 'incomplete_evidence'])('steers away from the same page when it cannot be decided (%s)', reason => {
    const compact = compactBrowserTaskResult({ ...base, status: 'escalate', reason, trace: [] }) as { next: string }
    expect(compact.next).toMatch(/continuing from it \(tab_id with no startUrl\) stops the same way.*startUrl that skips this step/)
    expect(compact.next).not.toContain('it continues from the current page')
  })
  it.each(['site_blocked', 'budget_unavailable', 'not_authorized', 'taken_over', 'needs_your_mac', 'never_automate'])('offers no continuation for %s', reason => {
    expect(compactBrowserTaskResult({ ...base, status: 'escalate', reason, trace: [] })).not.toHaveProperty('next')
  })
  it('keeps fresh readings and counts the extra completion check independently', () => {
    const freshReadings = { source: 'final_native_observation', url: base.url, observedAt: 10, evidence: { currentFields: [] } }
    expect(compactBrowserTaskResult({ ...base, freshReadings, trace: [{ ...step(100, 10, .001),
      completionMetrics: { usage: { inputTokens: 50, outputTokens: 5, costUsd: .002, costSource: 'gateway', known: true } } }] }))
      .toMatchObject({ freshReadings, summary: { decisionCalls: 2, completionCalls: 1,
        usage: { reportedInputTokens: 150, reportedOutputTokens: 15, costUsd: .003, complete: true } } })
  })
  it('preserves the bounded reading ledger for the parent while dropping execution trace', () => {
    const evidenceLedger = { version: 1, pages: [{ url: 'https://example.com/', links: [{ name: 'Article', url: 'https://example.com/article' }] }] }
    const result = compactBrowserTaskResult({ ...base, evidenceLedger })
    expect(result).toMatchObject({ evidenceLedger })
    expect(result).not.toHaveProperty('trace')
  })
  it('includes field-helper spend and tokens separately from Jev call count', () => {
    expect(compactBrowserTaskResult({ ...base, trace: [{ ...step(100, 10, 0.001),
      textMetrics: { invoked: true, usage: { inputTokens: 200, outputTokens: 20, costUsd: 0.002, costSource: 'gateway', known: true } } }] }))
      .toMatchObject({ summary: { decisionCalls: 1, textCalls: 1, usage: { reportedInputTokens: 300, reportedOutputTokens: 30, costUsd: 0.003, complete: true } } })
  })
  it('retains unknown helper usage without counting pre-provider refusals as calls', () => {
    for (const invoked of [false, true]) {
      const result = compactBrowserTaskResult({ ...base, trace: [{ ...step(100, 10, 0.001), textMetrics: { invoked, usage: { known: false } } }] })
      expect(result).toMatchObject({ summary: { usage: { unknownCostCalls: Number(invoked), unknownTokenCalls: Number(invoked), complete: !invoked } } })
    }
  })
  it.each([undefined, 'https://current.example/search'])('keeps the blocked site separate from actual page evidence (url=%s)', url => {
    const message = 'The user has blocked the agent on blocked.example.'
    expect(compactBrowserTaskResult({ ...base, status: 'escalate', reason: 'site_blocked',
      blockedSite: 'blocked.example', message, url, evidence: url ? 'Current search' : undefined, steps: 0, trace: [] }))
      .toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'blocked.example',
        message, url, evidence: url ? 'Current search' : undefined, steps: 0,
        summary: { decisionCalls: 0, usage: { complete: true } } })
  })
  it('keeps an actionable stop message without inventing provider usage', () => {
    const message = 'example.com turns away browsers in the cloud, so this needs the user\'s Mac with Native Intelligence open.'
    expect(compactBrowserTaskResult({ ...base, status: 'escalate', reason: 'needs_your_mac', message, steps: 0, trace: [] }))
      .toMatchObject({ status: 'escalate', reason: 'needs_your_mac', message, steps: 0,
        summary: { decisionCalls: 0, usage: { unknownTokenCalls: 0, unknownCostCalls: 0, complete: true } } })
  })
  it.each(['verified', 'escalate', 'cancelled'])('preserves %s outcome evidence and aggregates usage without mutating diagnostics', status => {
    const result = { ...base, status }
    const before = JSON.stringify(result)
    const compact = compactBrowserTaskResult(result)
    expect(compact).toEqual({ ...(status === 'escalate' ? { next: expect.stringContaining('no startUrl') } : {}), status, reason: base.reason, steps: 2, elapsedMs: 300,
      url: base.url, evidence: base.evidence, tabId: 'tab', summary: { decisionCalls: 2, localRecoveries: 1,
        usage: { reportedInputTokens: 300, reportedOutputTokens: 30, costUsd: 0.003,
          unknownTokenCalls: 0, unknownCostCalls: 0, catalogCostCalls: 0, complete: true } } })
    expect(JSON.stringify(result)).toBe(before)
    expect(compact).not.toHaveProperty('trace')
    expect(compact).not.toHaveProperty('timings')
    expect(JSON.stringify(compact)).not.toContain('routeTimingMs')
  })
  it('marks partial and missing metrics incomplete without inventing zero usage', () => {
    const result = compactBrowserTaskResult({ ...base, trace: [step(100, 10, 0.001, 'catalog'),
      { metrics: { usage: { inputTokens: 50, known: false } } }, {}, null] })
    expect(result).toMatchObject({ summary: { decisionCalls: 4, usage: {
      reportedInputTokens: 150, reportedOutputTokens: 10, costUsd: 0.001,
      unknownTokenCalls: 3, unknownCostCalls: 3, catalogCostCalls: 1, complete: false,
    } } })
    expect(compactBrowserTaskResult({ ...base, trace: [{}] })).toMatchObject({ summary: {
      usage: { unknownTokenCalls: 1, unknownCostCalls: 1, complete: false },
    } })
    const unknown = compactBrowserTaskResult({ ...base, trace: [{}] }) as { summary: { usage: Record<string, unknown> } }
    expect(unknown.summary.usage).not.toHaveProperty('reportedInputTokens')
    expect(unknown.summary.usage).not.toHaveProperty('reportedOutputTokens')
    expect(unknown.summary.usage).not.toHaveProperty('costUsd')
  })
  it('retains reported zero values and rejects invalid counts', () => {
    expect(compactBrowserTaskResult({ ...base, trace: [step(0, 0, 0)] })).toMatchObject({ summary: { usage: {
      reportedInputTokens: 0, reportedOutputTokens: 0, costUsd: 0, complete: true,
    } } })
    expect(compactBrowserTaskResult({ ...base, trace: [step(-1, NaN, Infinity)] })).toMatchObject({ summary: { usage: {
      unknownTokenCalls: 1, unknownCostCalls: 1, complete: false,
    } } })
  })
  it('leaves non-task and malformed legacy results unchanged', () => {
    for (const value of [null, 'Page text', { text: 'Page text', trace: ['content'] }, { status: 'verified' }]) {
      expect(compactBrowserTaskResult(value)).toBe(value)
    }
  })
})
