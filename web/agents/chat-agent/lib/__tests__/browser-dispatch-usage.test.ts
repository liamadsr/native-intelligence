import { describe, expect, it } from 'vitest'
import { buildTurnUsageReport, emptyTurnUsage, foldTurnUsageEvent, type TurnUsageAcc } from '../turn-usage'

const end = { sessionId: 'session', turnId: 'turn_0', outcome: 'completed' as const, endedAt: '2026-10-04T23:00:05Z' }
const usage = { inputTokens: 240, outputTokens: 90, cacheReadTokens: 100, cacheWriteTokens: 10, costUsd: 0.03 }
const first = { generationId: 'gen_first', provider: 'wafer', cost: 0.01, inputTokens: 120, outputTokens: 60, usageKnown: true }
const retry = { generationId: 'gen_retry', provider: 'deepinfra', cost: 0.02, inputTokens: 120, outputTokens: 30, usageKnown: true }

function completed(attempts: unknown[], usageUnknown = false, generationId = 'gen_retry') {
  return {
    type: 'step.completed',
    data: {
      turnId: 'turn_0', sequence: 0, stepIndex: 0, usage,
      providerMetadata: { gateway: { generationId }, browserDispatch: { version: 1, retried: true, reason: 'length', attempts, usageUnknown } },
    },
    meta: { at: '2026-10-04T23:00:04Z' },
  }
}

function fold(events: unknown[]): TurnUsageAcc {
  return events.reduce<TurnUsageAcc>(foldTurnUsageEvent, emptyTurnUsage('turn_0', '2026-10-04T23:00:00Z'))
}

describe('browser dispatch retry usage', () => {
  it('bills the combined finish once and preserves both generations across hook replay', () => {
    const event = completed([first, retry])
    const report = buildTurnUsageReport(fold([event, event]), end)
    expect(report).toMatchObject({
      ...usage, steps: 1, generationIds: ['gen_first', 'gen_retry'],
      inputTokensReported: true, outputTokensReported: true,
    })
    expect(report).not.toHaveProperty('supersededGenerationIds')
  })

  it('retains known subtotals but marks the turn incomplete after an interrupted attempt', () => {
    const event = completed([{ ...first, inputTokens: null, outputTokens: null, cost: null, usageKnown: false }, retry], true)
    event.data.usage = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.02 }
    for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
      expect(buildTurnUsageReport(fold([event]), { ...end, outcome })).toMatchObject({
        outcome, inputTokens: 120, outputTokens: 30, costUsd: 0.02,
        generationIds: ['gen_first', 'gen_retry'], inputTokensReported: false, outputTokensReported: false,
      })
    }
  })

  it('cannot present missing attempt usage as a complete aggregate', () => {
    for (const attempts of [[], [first, { ...retry, outputTokens: null }], [first, retry, retry], [first, null]]) {
      expect(buildTurnUsageReport(fold([completed(attempts)]), end)).toMatchObject({
        inputTokensReported: false, outputTokensReported: false,
      })
    }
  })

  it('keeps every superseded retry generation when an Eve step is rerun', () => {
    const rerun = completed([
      { ...first, generationId: 'gen_second_first' },
      { ...retry, generationId: 'gen_second_retry' },
    ], false, 'gen_second_retry')
    expect(buildTurnUsageReport(fold([completed([first, retry]), rerun, rerun]), end)).toMatchObject({
      ...usage, steps: 1, generationIds: ['gen_second_first', 'gen_second_retry'],
      supersededGenerationIds: ['gen_first', 'gen_retry'],
    })
  })

  it('accepts reported zero usage and deduplicates the final generation identity', () => {
    const event = completed([{ ...retry, inputTokens: 0, outputTokens: 0 }])
    event.data.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
    expect(buildTurnUsageReport(fold([event]), end)).toMatchObject({
      inputTokens: 0, outputTokens: 0, costUsd: null, generationIds: ['gen_retry'],
      inputTokensReported: true, outputTokensReported: true,
    })
  })
})
