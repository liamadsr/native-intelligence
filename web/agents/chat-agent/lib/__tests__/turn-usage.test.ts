import { describe, it, expect } from 'vitest'
import {
  autoCompactionsOf,
  contextTokensOf,
  buildCompactionReport,
  buildTurnUsageReport,
  cacheHitRate,
  chatContextLogLine,
  compactionFromRequested,
  emptyTurnUsage,
  foldTurnUsageEvent,
  gatewaySlugOf,
  validModelRoute,
  type TurnUsageAcc,
} from '../turn-usage'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import type { HandleMessageStreamEvent } from 'eve/client'

/**
 * The chat-agent's usage accumulator MIRRORS mapEveTurnUsage (the eve runtime
 * cannot import Next code) on streams without a re-run step. These tests pin
 * the mirror: the same event stream must yield the same tokens / cost / Exa
 * spend / counts through both, plus the per-turn scoping only the accumulator
 * has, the keyed slots that count a step eve re-runs ONCE (the one pinned
 * divergence from the still-additive mapEveTurnUsage), and the compaction
 * report (manual only).
 */

const T = 'turn_3'
const at = (s: number) => `2026-09-25T10:00:${String(s).padStart(2, '0')}.000Z`
const ev = (type: string, data: Record<string, unknown>, sec = 0) => ({
  type,
  data: { sequence: 3, turnId: T, ...data },
  meta: { id: `evt_${type}_${sec}`, at: at(sec) },
})
const turnStarted = (sec = 0) => ev('turn.started', {}, sec)
const stepStarted = (modelId: string, stepIndex = 0) => ev('step.started', { modelId, stepIndex })
const stepCompleted = (usage: Record<string, unknown> | undefined, gid?: string, stepIndex = 0, sec = 1) =>
  ev(
    'step.completed',
    { finishReason: 'stop', stepIndex, usage, ...(gid ? { providerMetadata: { gateway: { generationId: gid } } } : {}) },
    sec,
  )
const actions = (...names: string[]) => ev('actions.requested', { stepIndex: 0, actions: names.map((toolName) => ({ kind: 'tool-call', toolName, callId: toolName })) })
const result = (toolName: string, output: unknown) =>
  ev('action.result', { stepIndex: 0, status: 'completed', result: { kind: 'tool-result', callId: toolName, toolName, output } })

function foldAll(events: unknown[], acc: TurnUsageAcc = emptyTurnUsage()): TurnUsageAcc {
  return events.reduce<TurnUsageAcc>((a, e) => foldTurnUsageEvent(a, e), acc)
}
const end = (over: Partial<Parameters<typeof buildTurnUsageReport>[1]> = {}) => ({
  sessionId: 'sess-1',
  turnId: T,
  outcome: 'completed' as const,
  endedAt: at(9),
  ...over,
})

describe('turn usage accumulator', () => {
  it('distinguishes reported zero tokens from absent usage and legacy accumulator state', () => {
    const zero = foldAll([turnStarted(), stepCompleted({ inputTokens: 0, outputTokens: 0 })])
    expect(buildTurnUsageReport(zero, end())).toMatchObject({ inputTokensReported: true, outputTokensReported: true })
    const missing = foldAll([turnStarted(), stepCompleted({ inputTokens: 10 })])
    expect(buildTurnUsageReport(missing, end())).toMatchObject({ inputTokens: 10, outputTokens: 0, inputTokensReported: true, outputTokensReported: false })
    const legacy = JSON.parse(JSON.stringify(zero)) as TurnUsageAcc
    for (const step of Object.values(legacy.steps)) { delete step.inputTokensReported; delete step.outputTokensReported }
    expect(buildTurnUsageReport(legacy, end())).toMatchObject({ inputTokensReported: false, outputTokensReported: false })
  })

  it('links completed browser tool results, including waits and failures, without trusting model inputs or other tools', () => {
    const id = '12345678-1234-1234-1234-123456789abc'
    const other = '12345678-1234-1234-1234-123456789abd'
    const acc = foldAll([
      turnStarted(),
      ev('actions.requested', { actions: [{ toolName: 'wait_for_browser_command', callId: 'wait', input: { run_id: other, browser_command_id: other } }] }),
      result('run_browser_task', { success: true, pending: true, browser_command_id: id }),
      result('wait_for_browser_command', { success: false, done: true, browser_command_id: id.toUpperCase() }),
      result('get_browser_text', { success: true, browser_command_id: other }),
      result('unrelated_tool', { success: true, browser_command_id: '12345678-1234-1234-1234-123456789abe' }),
      result('run_browser_task', { browser_command_id: 'not-a-uuid' }),
      result('run_browser_task', { result: { browser_command_id: '12345678-1234-1234-1234-123456789abf' } }),
      stepCompleted({ inputTokens: 10, outputTokens: 2 }),
    ])
    expect(buildTurnUsageReport(acc, end())).toMatchObject({ browserCommandIds: [id, other], inputTokens: 10, outputTokens: 2 })
    const next = foldAll([
      { ...turnStarted(), data: { turnId: 'turn_4' } },
      { ...result('wait_for_browser_command', { success: true, browser_command_id: id }), data: {
        turnId: 'turn_4', status: 'completed', result: { kind: 'tool-result', toolName: 'wait_for_browser_command', output: { browser_command_id: id } },
      } },
      { ...stepCompleted({ inputTokens: 5, outputTokens: 1 }), data: { turnId: 'turn_4', usage: { inputTokens: 5, outputTokens: 1 } } },
    ], acc)
    expect(buildTurnUsageReport(next, end({ turnId: 'turn_4' }))).toMatchObject({ browserCommandIds: [id], inputTokens: 5 })
  })

  it('caps command references and ignores failed invocations even if they contain an ID', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`)
    const acc = foldAll([turnStarted(), ...ids.map((id) => result('run_browser_task', { browser_command_id: id })), stepCompleted({ inputTokens: 1, outputTokens: 1 })])
    expect(buildTurnUsageReport(acc, end())?.browserCommandIds).toEqual(ids.slice(0, 50))
    const failed = result('run_browser_task', { browser_command_id: ids[0] })
    expect(buildTurnUsageReport(foldAll([turnStarted(), { ...failed, data: { ...failed.data, status: 'failed' } }, stepCompleted({ inputTokens: 1, outputTokens: 1 })]), end()))
      .not.toHaveProperty('browserCommandIds')
  })

  it('sums a multi-step turn: tokens, cache, steps, tools, discoveries, generation ids, model, duration', () => {
    const acc = foldAll([
      turnStarted(0),
      stepStarted('anthropic/claude-haiku-4.5'),
      actions('search_tools', 'dial8_list_actions'),
      stepCompleted({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800 }, 'gen_1'),
      stepStarted('anthropic/claude-haiku-4.5', 1),
      stepCompleted({ inputTokens: 1200, outputTokens: 90, cacheWriteTokens: 100 }, 'gen_2', 1, 5),
    ])
    expect(buildTurnUsageReport(acc, end())).toEqual({
      sessionId: 'sess-1',
      turnId: T,
      outcome: 'completed',
      modelId: 'anthropic/claude-haiku-4.5',
      inputTokens: 2200,
      outputTokens: 140,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      costUsd: null,
      webSearchCostUsd: null,
      steps: 2,
      toolCalls: 2,
      toolDiscoveries: 1,
      generationIds: ['gen_1', 'gen_2'],
      durationMs: 9000,
      firstEventAt: at(0),
      terminalAt: at(9),
      inputTokensReported: true,
      outputTokensReported: true,
      compaction: null,
      contextTokens: { first: 1000, last: 1200, peak: 1200 },
    })
  })

  it('Exa-contaminated turn: eve’s cost (which includes the search) is dropped, the Exa spend reported', () => {
    const acc = foldAll([
      turnStarted(),
      result('web_search', { results: [], costDollars: { total: 0.007, search: { neural: 0.007 } } }),
      stepCompleted({ inputTokens: 8100, outputTokens: 120, costUsd: 0.007 }),
    ])
    const r = buildTurnUsageReport(acc, end())!
    expect(r.costUsd).toBeNull()
    expect(r.webSearchCostUsd).toBeCloseTo(0.007)
    expect(r.inputTokens).toBe(8100)
  })

  it('cost rule: trusted only when every token-spending step is positive and there is no Exa spend', () => {
    const all = buildTurnUsageReport(
      foldAll([turnStarted(), stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0.01 }), stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0.02 }, undefined, 1)]),
      end(),
    )!
    expect(all.costUsd).toBeCloseTo(0.03)
    const partial = buildTurnUsageReport(
      foldAll([turnStarted(), stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0.01 }), stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0 }, undefined, 1)]),
      end(),
    )!
    expect(partial.costUsd).toBeNull()
    const byok = buildTurnUsageReport(foldAll([turnStarted(), stepCompleted({ inputTokens: 10, outputTokens: 1 })]), end())!
    expect(byok.costUsd).toBeNull()
  })

  it('mirrors mapEveTurnUsage on the same stream (the rule cannot drift)', () => {
    const streams: unknown[][] = [
      [turnStarted(), stepCompleted({ inputTokens: 100, outputTokens: 20, costUsd: 0.004 }, 'g1')],
      [turnStarted(), result('web_search', { costDollars: { total: 0.005 } }), stepCompleted({ inputTokens: 100, outputTokens: 20, costUsd: 0.005 })],
      [turnStarted(), stepCompleted({ inputTokens: 100, outputTokens: 20, costUsd: 0.004 }), stepCompleted({ inputTokens: 5, outputTokens: 5 }, undefined, 1)],
      [turnStarted(), actions('search_tools', 'x', 'y'), stepCompleted({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 })],
    ]
    for (const events of streams) {
      const mine = buildTurnUsageReport(foldAll(events), end())!
      const theirs = mapEveTurnUsage(events as HandleMessageStreamEvent[])
      expect(mine).toMatchObject({
        inputTokens: theirs.inputTokens,
        outputTokens: theirs.outputTokens,
        cacheReadTokens: theirs.cacheReadTokens,
        cacheWriteTokens: theirs.cacheWriteTokens,
        costUsd: theirs.costUsd,
        webSearchCostUsd: theirs.webSearchCostUsd,
        steps: theirs.steps,
        toolCalls: theirs.toolCalls,
        toolDiscoveries: theirs.toolDiscoveries,
        generationIds: theirs.generationIds,
      })
    }
  })

  it('KNOWN DIVERGENCE (follow-up, low): a replayed step.completed counts once here, twice in mapEveTurnUsage', () => {
    // Same coordinates (sequence 3, stepIndex 0), new event id — an eve re-run.
    const events = [
      turnStarted(),
      stepCompleted({ inputTokens: 100, outputTokens: 20 }, 'g1'),
      { ...stepCompleted({ inputTokens: 100, outputTokens: 20 }, 'g2'), meta: { id: 'evt_rerun', at: at(2) } },
    ]
    expect(buildTurnUsageReport(foldAll(events), end())).toMatchObject({ inputTokens: 100, steps: 1, generationIds: ['g2'] })
    // mapEveTurnUsage is still additive. Keying it on (sequence:stepIndex) —
    // the follow-up — must flip this assertion deliberately.
    expect(mapEveTurnUsage(events as HandleMessageStreamEvent[])).toMatchObject({ inputTokens: 200, steps: 2 })
  })

  it('scopes to one turn: turn.started or a different turn id starts fresh; a mismatched settle reports nothing', () => {
    const prev = foldAll([turnStarted(), stepCompleted({ inputTokens: 999, outputTokens: 9 })])
    const next = foldTurnUsageEvent(prev, { type: 'step.completed', data: { turnId: 'turn_4', sequence: 4, stepIndex: 0, usage: { inputTokens: 5, outputTokens: 1 } } })
    expect(next.turnId).toBe('turn_4')
    expect(buildTurnUsageReport(next, end({ turnId: 'turn_4' }))).toMatchObject({ inputTokens: 5, steps: 1 })
    expect(buildTurnUsageReport(prev, end({ turnId: 'turn_9' }))).toBeNull()
  })

  it('a turn with no completed step and no tokens reports nothing', () => {
    expect(buildTurnUsageReport(foldAll([turnStarted(), stepStarted('m')]), end())).toBeNull()
  })

  it('never throws on malformed events; they are not counted', () => {
    const acc = foldAll([turnStarted(), null, 7, 'x', { type: 'step.completed' }, { type: 'step.completed', data: { turnId: T, usage: { inputTokens: 'lots', outputTokens: -3 } } }])
    expect(buildTurnUsageReport(acc, end())).toMatchObject({ inputTokens: 0, outputTokens: 0, steps: 1 })
    // The accumulator stays JSON-serializable (it lives in eve state).
    expect(JSON.parse(JSON.stringify(acc))).toEqual(acc)
  })

  describe('a step eve re-runs is counted once (keyed on its coordinates, not added)', () => {
    // eve 0.66.3 docs/guides/hooks.md: an interrupted step that re-runs re-emits
    // its events as NEW events (new meta.id) with the SAME turnId / sequence /
    // stepIndex, and the hook runs again for each. Nothing here relies on eve
    // rolling hook state back.
    it('a replayed step.completed with the same coordinates overwrites its slot (the last attempt wins)', () => {
      const once = foldAll([turnStarted(), stepCompleted({ inputTokens: 1000, outputTokens: 50, costUsd: 0.01 }, 'gen_a')])
      const replayed = foldAll([
        turnStarted(),
        stepCompleted({ inputTokens: 1000, outputTokens: 50, costUsd: 0.01 }, 'gen_a'),
        { ...stepCompleted({ inputTokens: 1010, outputTokens: 60, costUsd: 0.011 }, 'gen_b'), meta: { id: 'evt_retry', at: at(2) } },
      ])
      expect(buildTurnUsageReport(once, end())).toMatchObject({ inputTokens: 1000, steps: 1 })
      expect(buildTurnUsageReport(replayed, end())).toMatchObject({
        inputTokens: 1010,
        outputTokens: 60,
        steps: 1,
        costUsd: 0.011,
        generationIds: ['gen_b'],
        // The superseded attempt's generation is not billed but not forgotten.
        supersededGenerationIds: ['gen_a'],
      })
      expect(buildTurnUsageReport(once, end())).not.toHaveProperty('supersededGenerationIds')
    })

    it('an exact re-delivery (same generation id) is not a superseded attempt', () => {
      const acc = foldAll([
        turnStarted(),
        stepCompleted({ inputTokens: 10, outputTokens: 1 }, 'gen_a'),
        { ...stepCompleted({ inputTokens: 10, outputTokens: 1 }, 'gen_a'), meta: { id: 'evt_again', at: at(2) } },
      ])
      expect(buildTurnUsageReport(acc, end())).not.toHaveProperty('supersededGenerationIds')
    })

    it('replayed actions.requested / action.result count their calls and Exa spend once', () => {
      const acc = foldAll([
        turnStarted(),
        actions('web_search', 'search_tools'),
        result('web_search', { costDollars: { total: 0.005 } }),
        actions('web_search', 'search_tools'),
        result('web_search', { costDollars: { total: 0.005 } }),
        stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0.005 }),
      ])
      expect(buildTurnUsageReport(acc, end())).toMatchObject({ toolCalls: 2, toolDiscoveries: 1, webSearchCostUsd: 0.005, costUsd: null })
    })

    it('distinct steps (incl. a steer, which keeps counting stepIndex within the turn) and a later turn’s sequence all count', () => {
      const acc = foldAll([
        turnStarted(),
        stepCompleted({ inputTokens: 10, outputTokens: 1 }, undefined, 0),
        stepCompleted({ inputTokens: 20, outputTokens: 2 }, undefined, 1),
        stepCompleted({ inputTokens: 30, outputTokens: 3 }, undefined, 2),
      ])
      expect(buildTurnUsageReport(acc, end())).toMatchObject({ inputTokens: 60, outputTokens: 6, steps: 3 })
    })

    it('an event without coordinates gets its own slot — counted, never dropped', () => {
      const bare = (n: number) => ({ type: 'step.completed', data: { turnId: T, usage: { inputTokens: n, outputTokens: 1 } } })
      const acc = foldAll([turnStarted(), bare(5), bare(7)])
      expect(buildTurnUsageReport(acc, end())).toMatchObject({ inputTokens: 12, steps: 2 })
    })
  })

  it('a non-positive or non-finite Exa total is not Exa spend (it must never void the bill)', () => {
    for (const total of [-0.5, 0, Number.NaN, 'x']) {
      const r = buildTurnUsageReport(
        foldAll([turnStarted(), result('web_search', { costDollars: { total } }), stepCompleted({ inputTokens: 10, outputTokens: 1, costUsd: 0.002 })]),
        end(),
      )!
      expect(r.webSearchCostUsd).toBeNull()
      expect(r.costUsd).toBe(0.002)
    }
  })

  describe('compaction (a model call with no step.completed)', () => {
    const requested = (usageInputTokens: unknown, sequence = 3, id = 'evt_req', turnId = T) => ({
      type: 'compaction.requested',
      data: { modelId: 'anthropic/claude-sonnet-4.6', sequence, sessionId: 'sess-1', turnId, usageInputTokens },
      meta: { id, at: at(4) },
    })

    it('an AUTOMATIC compaction (inside a step) is NOT billed — eve emits the same pair when it made no model call', () => {
      // eve 0.66.3 compactMessages returns without generateText when the
      // tool-result trim suffices (or nothing is older), and maybeCompact emits
      // the pair for a memory-only canonicalization too; no field says which.
      const acc = foldAll([turnStarted(), stepStarted('anthropic/claude-sonnet-4.6', 2)])
      expect(compactionFromRequested(acc, requested(172_000))).toBeNull()
      expect(compactionFromRequested(acc, requested(172_000, 3, 'evt_other'))).toBeNull()
    })

    it('a MANUAL compaction (between turns, no step for its turn id) is keyed by the request event id', () => {
      // Between turns eve stamps the NEXT turn's id (turn_<sequence>); the meter's accumulator was reset at settle.
      const c = compactionFromRequested(emptyTurnUsage(), requested(40_000, 4, 'evt_m1', 'turn_4'))!
      expect(c).toEqual({
        turnId: 'turn_4',
        modelId: 'anthropic/claude-sonnet-4.6',
        inputTokens: 40_000,
        trigger: 'manual',
        id: 'mevt_m1',
        startedAt: at(4),
      })
      // After a finished turn (the accumulator still holds turn_3's steps), a
      // /compact under turn_4 is manual too.
      const after = foldAll([turnStarted(), stepStarted('m', 0)])
      expect(compactionFromRequested(after, requested(40_000, 4, 'evt_m2', 'turn_4'))).toMatchObject({ trigger: 'manual', id: 'mevt_m2' })
    })

    it('the report is list-priced from the estimate, output unreported, under its own compaction ref', () => {
      const c = compactionFromRequested(emptyTurnUsage(), requested(90_000))!
      expect(buildCompactionReport(c, { sessionId: 'sess-1', turnId: T, endedAt: at(9) })).toEqual({
        sessionId: 'sess-1',
        turnId: T,
        outcome: 'completed',
        modelId: 'anthropic/claude-sonnet-4.6',
        inputTokens: 90_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        webSearchCostUsd: null,
        steps: 1,
        toolCalls: 0,
        toolDiscoveries: 0,
        generationIds: [],
        durationMs: 5000,
        firstEventAt: at(4),
        terminalAt: at(9),
        inputTokensReported: false,
        outputTokensReported: false,
        compaction: { trigger: 'manual', id: 'mevt_req' },
      })
      expect(buildCompactionReport(c, { sessionId: 'sess-1', turnId: 'turn_9', endedAt: null })).toBeNull()
    })

    it('nothing to bill: no estimate, a malformed event, or no turn id', () => {
      const acc = emptyTurnUsage()
      expect(compactionFromRequested(acc, requested(null))).toBeNull()
      expect(compactionFromRequested(acc, requested(0))).toBeNull()
      expect(compactionFromRequested(acc, { type: 'compaction.requested' })).toBeNull()
      expect(compactionFromRequested(acc, null)).toBeNull()
      expect(compactionFromRequested(acc, { ...requested(5), data: { usageInputTokens: 5 } })).toBeNull()
    })

    it('compaction events leave the turn accumulator untouched', () => {
      const acc = foldAll([turnStarted(), stepCompleted({ inputTokens: 10, outputTokens: 1 })])
      expect(foldTurnUsageEvent(acc, requested(5000))).toBe(acc)
    })
  })
})

describe('the billed model is the Gateway slug', () => {
  it('strips the gateway/ prefix eve 0.79 puts on the browser-dispatch live model, and keeps a plain slug', () => {
    expect(gatewaySlugOf('gateway/deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
    expect(gatewaySlugOf('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5')
  })

  it('a step.started from the browser-dispatch model reports the slug', () => {
    const at = (sec: number) => `2026-10-15T10:00:0${sec}.000Z`
    const events = [
      { type: 'turn.started', data: { sequence: 1, turnId: 't' }, meta: { id: 'e0', at: at(0) } },
      { type: 'step.started', data: { sequence: 1, turnId: 't', stepIndex: 0, modelId: 'gateway/deepseek/deepseek-v4-flash' }, meta: { id: 'e1', at: at(1) } },
      { type: 'step.completed', data: { sequence: 1, turnId: 't', stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } }, meta: { id: 'e2', at: at(2) } },
    ]
    const acc = events.reduce<TurnUsageAcc>((a, e) => foldTurnUsageEvent(a, e), emptyTurnUsage())
    expect(acc.modelId).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('context size per call (what compaction decides on)', () => {
  it('first, last and peak step input; a step with no input is skipped; the summed input is not one of them', () => {
    const acc = foldAll([
      turnStarted(),
      stepStarted('m', 0),
      stepCompleted({ inputTokens: 120_000, outputTokens: 10 }, undefined, 0),
      stepStarted('m', 1),
      stepCompleted({ inputTokens: 0, outputTokens: 0 }, undefined, 1),
      stepStarted('m', 2),
      stepCompleted({ inputTokens: 190_000, outputTokens: 10 }, undefined, 2),
      stepStarted('m', 3),
      stepCompleted({ inputTokens: 185_000, outputTokens: 10 }, undefined, 3),
    ])
    expect(contextTokensOf(acc)).toEqual({ first: 120_000, last: 185_000, peak: 190_000 })
    const report = buildTurnUsageReport(acc, end())!
    expect(report.inputTokens).toBe(495_000)
    expect(report.contextTokens).toEqual({ first: 120_000, last: 185_000, peak: 190_000 })
    expect(report).not.toHaveProperty('autoCompactions')
  })

  it('no reported input: no context sizes on the report', () => {
    const acc = foldAll([turnStarted(), stepStarted('m', 0), stepCompleted({ outputTokens: 3 }, undefined, 0)])
    expect(contextTokensOf(acc)).toBeNull()
    expect(buildTurnUsageReport(acc, end())).not.toHaveProperty('contextTokens')
  })

  it('each automatic compaction: eve\'s estimate before, the same step\'s input after (null when unknown)', () => {
    const requested = (usageInputTokens: number) => ev('compaction.requested', { modelId: 'm', usageInputTokens })
    const completed = () => ev('compaction.completed', { modelId: 'm' })
    const acc = foldAll([
      turnStarted(),
      stepStarted('m', 0),
      stepCompleted({ inputTokens: 220_000, outputTokens: 1 }, undefined, 0),
      stepStarted('m', 1),
      requested(231_000),
      completed(),
      stepCompleted({ inputTokens: 58_000, outputTokens: 1 }, undefined, 1),
      stepStarted('m', 2),
      completed(), // a trim with no request seen, and a step that never completed
    ])
    expect(autoCompactionsOf(acc)).toEqual([{ before: 231_000, after: 58_000 }, { before: null, after: null }])
    expect(buildTurnUsageReport(acc, end())!.autoCompactions).toEqual([{ before: 231_000, after: 58_000 }, { before: null, after: null }])
  })
})

describe('[chat-context] telemetry line', () => {
  const compactionDone = (sequence = 3) => ev('compaction.completed', { modelId: 'deepseek/deepseek-v4-flash', sequence })

  it('logs input, cached input, the hit rate, the largest step and the output for a turn', () => {
    const acc = foldAll([
      turnStarted(),
      stepStarted('deepseek/deepseek-v4-flash', 0),
      stepCompleted({ inputTokens: 12_000, outputTokens: 300, cacheReadTokens: 11_000, cacheWriteTokens: 500 }, 'g1', 0),
      stepStarted('deepseek/deepseek-v4-flash', 1),
      stepCompleted({ inputTokens: 14_000, outputTokens: 500, cacheReadTokens: 13_800 }, 'g2', 1),
    ])
    const report = buildTurnUsageReport(acc, end())!
    expect(chatContextLogLine(report, acc)).toBe(
      '[chat-context] session=sess-1 turn=turn_3 model=deepseek/deepseek-v4-flash outcome=completed steps=2 ' +
        'input=26000 cached=24800 hit=0.95 written=500 first=12000 last=14000 peak=14000 output=800 compactions=0 compactedInput=0',
    )
  })

  it('counts each automatic compaction once per step, even when eve re-emits it', () => {
    const acc = foldAll([
      turnStarted(),
      stepStarted('m', 0),
      compactionDone(),
      compactionDone(),
      stepCompleted({ inputTokens: 100, outputTokens: 1 }, undefined, 0),
      stepStarted('m', 1),
      compactionDone(),
      stepCompleted({ inputTokens: 100, outputTokens: 1 }, undefined, 1),
    ])
    expect(Object.keys(acc.compactions ?? {})).toEqual(['3:0', '3:1'])
    expect(chatContextLogLine(buildTurnUsageReport(acc, end())!, acc)).toMatch(/ compactions=2 compactedInput=0 compacted=->100,->100$/)
  })

  it('sums eve\'s input estimate of each automatic compaction that completed, once per step', () => {
    const requestedAuto = (usageInputTokens: number) =>
      ev('compaction.requested', { modelId: 'm', usageInputTokens })
    const acc = foldAll([
      turnStarted(),
      stepStarted('m', 0),
      requestedAuto(150_000),
      requestedAuto(181_000), // re-emitted for the same step: the last attempt wins
      compactionDone(),
      stepCompleted({ inputTokens: 100, outputTokens: 1 }, undefined, 0),
      stepStarted('m', 1),
      requestedAuto(90_000), // requested but never completed (a failed summary): not counted
      stepCompleted({ inputTokens: 100, outputTokens: 1 }, undefined, 1),
    ])
    expect(acc.compactionInputs).toEqual({ '3:0': 181_000, '3:1': 90_000 })
    expect(chatContextLogLine(buildTurnUsageReport(acc, end())!, acc)).toMatch(/ compactions=1 compactedInput=181000 compacted=181000>100$/)
    // A manual request (no step of this turn) is not folded.
    const manual = { ...requestedAuto(60_000), data: { turnId: 'turn_4', sequence: 4, usageInputTokens: 60_000 } }
    expect(foldTurnUsageEvent(acc, manual)).toBe(acc)
  })

  it('reads `-` for cached and hit when no step reported cache reads, and 0 when one reported 0', () => {
    const unknown = foldAll([turnStarted(), stepStarted('m', 0), stepCompleted({ inputTokens: 5_000, outputTokens: 10 }, undefined, 0)])
    expect(chatContextLogLine(buildTurnUsageReport(unknown, end())!, unknown)).toContain(' input=5000 cached=- hit=- written=0 ')
    const zero = foldAll([turnStarted(), stepStarted('m', 0), stepCompleted({ inputTokens: 5_000, outputTokens: 10, cacheReadTokens: 0 }, undefined, 0)])
    expect(chatContextLogLine(buildTurnUsageReport(zero, end())!, zero)).toContain(' input=5000 cached=0 hit=0.00 written=0 ')
  })

  it('does not count a compaction outside this turn\'s steps (manual, another turn, no step yet)', () => {
    const base = foldAll([turnStarted(), stepStarted('m', 0), stepCompleted({ inputTokens: 1 }, undefined, 0)])
    // Manual: between turns, under the NEXT turn's id and sequence.
    expect(foldTurnUsageEvent(base, { ...compactionDone(4), data: { turnId: 'turn_4', sequence: 4 } })).toBe(base)
    expect(foldTurnUsageEvent(base, compactionDone(4))).toBe(base)
    expect(foldTurnUsageEvent(foldAll([turnStarted()]), compactionDone()).compactions).toBeUndefined()
    // Never resets the turn either.
    expect(foldTurnUsageEvent(base, { type: 'compaction.completed', data: { turnId: 'turn_9', sequence: 9 } }).turnId).toBe(T)
  })

  it('reads `-` for the hit rate when no input was reported, and never exceeds 1', () => {
    expect(cacheHitRate(0, 0)).toBe('-')
    expect(cacheHitRate(NaN, 5)).toBe('-')
    expect(cacheHitRate(1000, 0)).toBe('0.00')
    expect(cacheHitRate(1000, 925)).toBe('0.93')
    expect(cacheHitRate(1000, 1200)).toBe('1.00')
  })

  it('a manual compaction report logs as compaction=manual with the estimate', () => {
    const c = compactionFromRequested(emptyTurnUsage(), {
      type: 'compaction.requested',
      data: { turnId: 'turn_4', sequence: 4, modelId: 'deepseek/deepseek-v4-flash', usageInputTokens: 90_000 },
      meta: { id: 'evt_9', at: at(1) },
    })!
    const report = buildCompactionReport(c, { sessionId: 'sess-1', turnId: 'turn_4', endedAt: at(2) })!
    expect(chatContextLogLine(report, null)).toBe(
      '[chat-context] session=sess-1 turn=turn_4 model=deepseek/deepseek-v4-flash compaction=manual estimatedInput=90000',
    )
  })

  it('without a matching accumulator it still logs the report, peak and compactions 0', () => {
    const acc = foldAll([turnStarted(), stepCompleted({ inputTokens: 50, outputTokens: 5 })])
    const report = buildTurnUsageReport(acc, end())!
    expect(chatContextLogLine(report, emptyTurnUsage('other'))).toMatch(/ model=unknown .* cached=- hit=- .* first=0 last=0 peak=0 output=5 compactions=0 compactedInput=0$/)
  })
})

describe('validModelRoute (the turn\'s model route on the report)', () => {
  it('keeps a known tier and decider, short rule names, and a reasoning word; drops everything else', () => {
    expect(validModelRoute({ tier: 'strong', by: 'cap', signals: ['daily_cap', 'Bad Name', 7], reasoning: 'adaptive', extra: 'x' })).toEqual({
      tier: 'strong',
      by: 'cap',
      signals: ['daily_cap'],
      reasoning: 'adaptive',
    })
    expect(validModelRoute({ tier: 'fast', by: 'rule' })).toEqual({ tier: 'fast', by: 'rule', signals: [] })
    for (const junk of [null, 'fast', { tier: 'max', by: 'rule' }, { tier: 'fast', by: 'person' }]) expect(validModelRoute(junk)).toBeNull()
  })
})
