/**
 * The live agent's eve adapter (LIVE-AGENT-DESIGN §8/§9): eve events → the
 * GenResult finalize() reads, the step-ceiling reader, and the SSE translator —
 * all over synthetic events shaped like eve 0.66.3's protocol.
 */
import { describe, it, expect, vi } from 'vitest'
import { harvestWebSearchCost } from '@/lib/ai/tools/web-search'
import { createFakeSupabase, eqValue } from './helpers/live-turn-fixture'
import {
  BATCH_STEP_CEILING,
  LIVE_STEP_CEILING,
  createLiveTurnSseTranslator,
  listPriceCostUsd,
  liveTurnCacheMetadata,
  readLiveTurn,
  reconstructSteps,
  toGenResult,
} from '../eve-turn'
import { ev, fakeTaskResponse, quietTurn } from './helpers/fake-eve-turn'
import {
  BATCH_STEP_CEILING as TRIAL_BATCH_STEP_CEILING,
  LIVE_STEP_CEILING as TRIAL_LIVE_STEP_CEILING,
} from '@/lib/evals/run-trial'

describe('toGenResult — the §8 adapter', () => {
  it('tool_call args are the call INPUT from actions.requested, never the action.result output (the commitmentsOf trap)', () => {
    const input = { text: 'Priya will send the deck', owner_label: 'Speaker 2', confidence: 0.9 }
    const output = { success: true, claim_id: 'claim-9', deduped: false }
    const events = [
      ev.stepStarted(0),
      ev.toolCall(0, 'c1', 'record_commitment', input),
      ev.stepCompleted(0, 'tool-calls'),
      ev.toolResult(0, 'c1', 'record_commitment', output),
      ev.stepStarted(1),
      ev.stepCompleted(1, 'stop'),
    ]
    const gen = toGenResult(events)
    expect(gen.steps[0].toolCalls).toEqual([{ toolName: 'record_commitment', input }])
    expect(gen.steps[0].toolCalls[0].input).not.toHaveProperty('claim_id')
    expect(gen.steps[0].toolResults).toEqual([{ toolName: 'record_commitment', output }])
    // The route's own mapping (finalize's toolCallSummaries) over these steps.
    const details = gen.steps.flatMap((s) =>
      s.toolCalls.map((tc) => ({ tool: tc.toolName, args: ('input' in tc ? tc.input : {}) as Record<string, unknown> })),
    )
    expect(details).toEqual([{ tool: 'record_commitment', args: input }])
  })

  it('rebuilds one step per step.completed, in order, with the last step’s finish reason and text', () => {
    const events = [
      ev.stepStarted(0),
      ev.messageCompleted(0, 'Looking things up.', 'tool-calls'),
      ev.toolCall(0, 'a', 'find', { query: 'Acme' }),
      ev.toolCall(0, 'b', 'list_projects', {}),
      ev.stepCompleted(0, 'tool-calls', { inputTokens: 1000, outputTokens: 50 }),
      ev.toolResult(0, 'b', 'list_projects', { projects: [] }),
      ev.toolResult(0, 'a', 'find', { results: [] }),
      ev.stepStarted(1),
      ev.messageCompleted(1, 'Done.'),
      ev.stepCompleted(1, 'stop', { inputTokens: 1200, outputTokens: 30 }),
      ev.sessionCompleted(),
    ]
    const gen = toGenResult(events)
    expect(gen.steps).toHaveLength(2)
    expect(gen.steps.map((s) => s.finishReason)).toEqual(['tool-calls', 'stop'])
    expect(gen.steps[0].toolCalls.map((c) => c.toolName)).toEqual(['find', 'list_projects'])
    expect(gen.steps[0].toolResults.map((r) => r.toolName)).toEqual(['list_projects', 'find'])
    expect(gen.steps[1].toolCalls).toEqual([])
    expect(gen.text).toBe('Done.')
    // Usage is SUMMED across steps.
    expect(gen.usage).toEqual({ inputTokens: 2200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('sums the cached share of input across steps, for log_ai_usage’s cache-aware pricing, and keeps the generation ids', () => {
    const gen = toGenResult([
      ev.stepCompleted(0, 'tool-calls', { inputTokens: 19_500, outputTokens: 120, cacheReadTokens: 17_700, cacheWriteTokens: 1_700 }, 'gen-a'),
      ev.stepCompleted(1, 'stop', { inputTokens: 19_800, outputTokens: 40, cacheReadTokens: 19_400 }, 'gen-b'),
    ])
    expect(gen.usage).toEqual({ inputTokens: 39_300, outputTokens: 160, cacheReadTokens: 37_100, cacheWriteTokens: 1_700 })
    expect(gen.generationIds).toEqual(['gen-a', 'gen-b'])
    // The RPC's own metadata keys (mig 199 log_ai_usage).
    expect(liveTurnCacheMetadata(gen.usage)).toEqual({ cache_read_input_tokens: 37_100, cache_creation_input_tokens: 1_700 })
    // An uncached turn carries no cache keys at all.
    expect(liveTurnCacheMetadata(toGenResult(quietTurn()).usage)).toEqual({})
  })

  it('maxSteps: a step N+1 that completed before the ceiling cancel landed is not a step (stopWhen), but its tokens are billed', () => {
    const events = [
      ev.stepStarted(0),
      ev.messageCompleted(0, 'step one', 'tool-calls'),
      ev.toolCall(0, 'a', 'find', { query: 'x' }),
      ev.stepCompleted(0, 'tool-calls', { inputTokens: 100, outputTokens: 10 }),
      ev.stepStarted(1),
      ev.messageCompleted(1, 'step two', 'tool-calls'),
      ev.toolCall(1, 'b', 'find', { query: 'y' }),
      ev.stepCompleted(1, 'tool-calls', { inputTokens: 200, outputTokens: 20 }),
      // The late step: its model call finished before turn.cancelled arrived.
      ev.stepStarted(2),
      ev.messageCompleted(2, 'too late'),
      ev.toolCall(2, 'c', 'propose_change', { title: 'late' }),
      ev.stepCompleted(2, 'stop', { inputTokens: 300, outputTokens: 30 }),
      ev.turnCancelled(),
    ]
    const gen = toGenResult(events, { maxSteps: 2 })
    expect(gen.steps).toHaveLength(2)
    expect(gen.steps.at(-1)?.finishReason).toBe('tool-calls')
    expect(gen.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName))).toEqual(['find', 'find'])
    expect(gen.text).toBe('step two')
    expect(gen.usage).toMatchObject({ inputTokens: 600, outputTokens: 60 })
    // Unbounded, the same events report all three.
    expect(toGenResult(events).steps).toHaveLength(3)
  })

  it('a step that never completed is not a step; a duplicated call announcement counts once', () => {
    const events = [
      ev.stepStarted(0),
      ev.toolCall(0, 'a', 'find', { query: 'x' }),
      ev.toolCall(0, 'a', 'find', { query: 'x' }),
      ev.stepCompleted(0, 'tool-calls'),
      ev.stepStarted(1),
    ]
    const steps = reconstructSteps(events)
    expect(steps).toHaveLength(1)
    expect(steps[0].toolCalls).toHaveLength(1)
  })

  it('attaches a result to the step that REQUESTED it (by callId), whatever stepIndex the result carries', () => {
    const events = [
      ev.toolCall(0, 'a', 'find', {}),
      ev.stepCompleted(0, 'tool-calls'),
      ev.toolResult(1, 'a', 'find', { ok: true }),
      ev.stepCompleted(1, 'stop'),
    ]
    const steps = reconstructSteps(events)
    expect(steps[0].toolResults).toEqual([{ toolName: 'find', output: { ok: true } }])
    expect(steps[1].toolResults).toEqual([])
  })

  it('eve’s cost signal: 0 (BYOK) or absent → no costUsd; a real non-zero cost passes through', () => {
    const byok = toGenResult([ev.stepCompleted(0, 'stop', { inputTokens: 5, outputTokens: 1, costUsd: 0 })])
    expect(byok).not.toHaveProperty('costUsd')
    const direct = toGenResult([ev.stepCompleted(0, 'stop', { inputTokens: 5, outputTokens: 1 })])
    expect(direct).not.toHaveProperty('costUsd')
    const credits = toGenResult([ev.stepCompleted(0, 'stop', { inputTokens: 5, outputTokens: 1, costUsd: 0.0074 })])
    expect(credits.costUsd).toBeCloseTo(0.0074)
  })

  it('harvestWebSearchCost reads the provider-executed web_search result off the rebuilt steps', () => {
    // eve projects a provider-executed tool result as action.result → tool-result
    // with the provider's JSON output (harness/emission.js → action-result-helpers.js),
    // and Exa's output schema carries costDollars.total (provider-tool-schemas.js).
    const events = [
      ev.toolCall(0, 'ws1', 'web_search', { query: 'Acme Corp funding' }),
      ev.toolResult(0, 'ws1', 'web_search', {
        requestId: 'r',
        results: [{ url: 'https://acme.example', id: '1' }],
        costDollars: { total: 0.005, search: { neural: 0.005 } },
      }),
      ev.stepCompleted(0, 'tool-calls'),
      ev.toolCall(1, 'ws2', 'web_search', { query: 'Acme CEO' }),
      ev.toolResult(1, 'ws2', 'web_search', { results: [], costDollars: { total: 0.007 } }),
      ev.stepCompleted(1, 'stop'),
    ]
    expect(harvestWebSearchCost(toGenResult(events).steps)).toBeCloseTo(0.012)
    expect(harvestWebSearchCost(toGenResult(quietTurn()).steps)).toBeNull()
  })

  it('a turn that ran an Exa-billed web_search drops eve’s cost: it is the Gateway’s billed cost, Exa included', () => {
    // Measured on eve 0.66.3 with the real mount (BYOK Anthropic, one step):
    // step costUsd 0.007 == costDollars.total 0.007, for 8.1k input tokens —
    // the tokens were billed 0 and the whole "cost" was the search.
    const measured = [
      ev.toolCall(0, 'ws1', 'web_search', { query: 'Anthropic latest funding round 2026' }),
      ev.toolResult(0, 'ws1', 'web_search', { requestId: 'r', results: [], costDollars: { total: 0.007, search: { neural: 0.007 } } }),
      ev.messageCompleted(0, 'DONE'),
      ev.stepCompleted(0, 'stop', { inputTokens: 8114, outputTokens: 85, costUsd: 0.007 }),
    ]
    const gen = toGenResult(measured)
    expect(gen).not.toHaveProperty('costUsd')
    expect(gen.usage.inputTokens).toBe(8114)
    expect(harvestWebSearchCost(gen.steps)).toBeCloseTo(0.007)
    // Even when the search ran on a step past the reported ceiling.
    const late = toGenResult(
      [
        ev.stepCompleted(0, 'tool-calls', { inputTokens: 10, outputTokens: 1, costUsd: 0.001 }),
        ev.toolCall(1, 'ws2', 'web_search', { query: 'q' }),
        ev.toolResult(1, 'ws2', 'web_search', { results: [], costDollars: { total: 0.005 } }),
        ev.stepCompleted(1, 'stop', { inputTokens: 10, outputTokens: 1, costUsd: 0.006 }),
      ],
      { maxSteps: 1 },
    )
    expect(late).not.toHaveProperty('costUsd')
    // A web_search result with no Exa cost leaves a real credits cost alone.
    const free = toGenResult([
      ev.toolCall(0, 'ws3', 'web_search', { query: 'q' }),
      ev.toolResult(0, 'ws3', 'web_search', { results: [] }),
      ev.stepCompleted(0, 'stop', { inputTokens: 5, outputTokens: 1, costUsd: 0.0074 }),
    ])
    expect(free.costUsd).toBeCloseTo(0.0074)
  })
})

describe('listPriceCostUsd — an eval turn’s real cost (skipBilling rows are never priced by the RPC)', () => {
  const price = { input_cost_per_million: '1.0', output_cost_per_million: '5.0' }
  const db = (row: unknown, error: { message: string } | null = null) =>
    createFakeSupabase((q) =>
      q.table === 'ai_model_costs' && eqValue(q, 'provider') === 'claude' && eqValue(q, 'model') === 'claude-haiku-4-5-20251001'
        ? { data: row, error }
        : { data: null, error: null },
    ).client

  it("is $0 on the person's own ChatGPT plan (no price row; never the $15/$75 fallback)", async () => {
    for (const a of [{ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna' }, { provider: 'openai', model: 'chatgpt-plan/gpt-6.1-sol' }]) {
      expect(await listPriceCostUsd(db(null), { ...a, inputTokens: 20_000, outputTokens: 400 })).toBe(0)
    }
  })

  it('prices tokens from the current ai_model_costs row, as log_ai_usage would', async () => {
    const cost = await listPriceCostUsd(db(price), {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 20_000,
      outputTokens: 400,
    })
    expect(cost).toBeCloseTo(0.02 + 0.002, 8)
  })

  it('falls back to the RPC’s conservative $15/$75 per million when the model has no price row', async () => {
    const cost = await listPriceCostUsd(db(null), { provider: 'x', model: 'y', inputTokens: 1_000_000, outputTokens: 0 })
    expect(cost).toBe(15)
  })

  it('prices cached tokens exactly as the RPC’s cache-aware claude branch does (regular 1x, write 1.25x, read 0.1x)', async () => {
    const cost = await listPriceCostUsd(db(price), {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 20_000,
      outputTokens: 400,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 1_000,
    })
    // (20000 − 18000 − 1000)×$1 + 1000×$1.25 + 18000×$0.10 + 400×$5, per million.
    expect(cost).toBeCloseTo((1_000 * 1 + 1_000 * 1.25 + 18_000 * 0.1 + 400 * 5) / 1e6, 10)
    // The smoke-measured Gateway marketCost reproduces with the same formula.
    const smoke = await listPriceCostUsd(db(price), {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 139 + 8324,
      outputTokens: 310,
      cacheReadTokens: 8324,
    })
    expect(smoke).toBeCloseTo(0.0025214, 10)
  })

  it('applies no cache discount off the claude provider or without a price row (the RPC doesn’t either)', async () => {
    const other = createFakeSupabase((q) =>
      q.table === 'ai_model_costs' ? { data: price, error: null } : { data: null, error: null },
    ).client
    const deepseek = await listPriceCostUsd(other, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 20_000,
      outputTokens: 0,
      cacheReadTokens: 18_000,
    })
    expect(deepseek).toBeCloseTo(0.02, 10)
    const fallback = await listPriceCostUsd(db(null), {
      provider: 'claude',
      model: 'unknown',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 900_000,
    })
    expect(fallback).toBe(15)
  })

  it('is null when the price read fails (never a made-up number)', async () => {
    const cost = await listPriceCostUsd(db(null, { message: 'denied' }), {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1,
      outputTokens: 1,
    })
    expect(cost).toBeNull()
  })
})

describe('readLiveTurn — boundary + the app-level step ceiling (§9.1)', () => {
  it('keeps the exported ceilings at the turn budgets (8 per tick / 50 batch), and run-trial.ts re-declares the same', () => {
    expect(LIVE_STEP_CEILING).toBe(8)
    expect(BATCH_STEP_CEILING).toBe(50)
    expect(TRIAL_LIVE_STEP_CEILING).toBe(LIVE_STEP_CEILING)
    expect(TRIAL_BATCH_STEP_CEILING).toBe(BATCH_STEP_CEILING)
  })

  it('stops at the terminal boundary (not the stream close) and reports completed', async () => {
    const res = fakeTaskResponse([...quietTurn(), ev.text(9, 'never read')], { hangAfter: quietTurn().length + 1 })
    const onEvent = vi.fn()
    const turn = await readLiveTurn(res, { stepCeiling: 20, cancel: res.cancel, onEvent })
    expect(turn.outcome).toBe('completed')
    expect(turn.stepsCompleted).toBe(1)
    expect(turn.events.at(-1)?.type).toBe('session.completed')
    expect(onEvent).toHaveBeenCalledTimes(turn.events.length)
  })

  it('cancels the turn when the ceiling-th step asks for more tools, and reports it as a normal (ceiling) end', async () => {
    const steps = []
    for (let i = 0; i < 3; i++) {
      steps.push(ev.stepStarted(i), ev.toolCall(i, `c${i}`, 'find', { query: String(i) }), ev.stepCompleted(i, 'tool-calls'))
    }
    const res = fakeTaskResponse(steps, { hangAfter: steps.length, afterCancel: [ev.turnCancelled()] })
    const turn = await readLiveTurn(res, { stepCeiling: 3, cancel: res.cancel })
    expect(res.cancelled()).toBe(1)
    expect(turn.outcome).toBe('ceiling')
    expect(turn.stepsCompleted).toBe(3)
    const gen = toGenResult(turn.events)
    expect(gen.steps).toHaveLength(3)
    expect(gen.steps.at(-1)?.finishReason).toBe('tool-calls')
  })

  it('does NOT cancel a turn whose ceiling-th step simply finished', async () => {
    const events = [ev.stepCompleted(0, 'tool-calls'), ev.stepCompleted(1, 'stop'), ev.sessionCompleted()]
    const res = fakeTaskResponse(events)
    const turn = await readLiveTurn(res, { stepCeiling: 2, cancel: res.cancel })
    expect(res.cancelled()).toBe(0)
    expect(turn.outcome).toBe('completed')
  })

  it('stops waiting for the wind-down after the bound even if eve never confirms the cancel', async () => {
    vi.useFakeTimers()
    try {
      const events = [ev.stepCompleted(0, 'tool-calls')]
      const res = fakeTaskResponse(events, { hangAfter: 1 })
      const cancel = vi.fn(async () => ({ status: 'cancelled' }))
      const read = readLiveTurn(res, { stepCeiling: 1, cancel })
      await vi.advanceTimersByTimeAsync(10_001)
      const turn = await read
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(turn.outcome).toBe('ceiling')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports failed / waiting boundaries, and a stream that ends with no boundary as failed', async () => {
    const failed = await readLiveTurn(fakeTaskResponse([ev.stepStarted(0), ev.sessionFailed()]), {
      stepCeiling: 20,
      cancel: async () => null,
    })
    expect(failed.outcome).toBe('failed')
    const cut = await readLiveTurn(fakeTaskResponse([ev.stepStarted(0)]), { stepCeiling: 20, cancel: async () => null })
    expect(cut.outcome).toBe('failed')
  })

  it('terminal: true only when eve itself reported the turn over', async () => {
    const read = (events: Parameters<typeof fakeTaskResponse>[0], opts?: Parameters<typeof fakeTaskResponse>[1]) =>
      readLiveTurn(fakeTaskResponse(events, opts), { stepCeiling: 20, cancel: async () => null })
    expect((await read(quietTurn())).terminal).toBe(true)
    expect((await read([ev.stepStarted(0), ev.sessionFailed()])).terminal).toBe(true)
    const cut = await read([ev.stepStarted(0)])
    expect([cut.outcome, cut.terminal]).toEqual(['failed', false])
    const parked = await read([ev.stepCompleted(0, 'stop'), ev.sessionWaiting()])
    expect([parked.outcome, parked.terminal]).toEqual(['waiting', false])
    // A ceiling cancel eve confirmed…
    const confirmed = fakeTaskResponse([ev.stepCompleted(0, 'tool-calls')], { hangAfter: 1, afterCancel: [ev.turnCancelled()] })
    expect((await readLiveTurn(confirmed, { stepCeiling: 1, cancel: confirmed.cancel })).terminal).toBe(true)
  })

  it('a ceiling wind-down that times out is NOT terminal (the cancel may never have landed)', async () => {
    vi.useFakeTimers()
    try {
      const res = fakeTaskResponse([ev.stepCompleted(0, 'tool-calls')], { hangAfter: 1 })
      const read = readLiveTurn(res, { stepCeiling: 1, cancel: async () => ({ status: 'cancelled' }) })
      await vi.advanceTimersByTimeAsync(10_001)
      const turn = await read
      expect([turn.outcome, turn.terminal]).toEqual(['ceiling', false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a step N+1 that completes before turn.cancelled arrives is read, and truncated by toGenResult', async () => {
    const events = [
      ev.stepCompleted(0, 'tool-calls'),
      ev.stepStarted(1),
      ev.toolCall(1, 'late', 'propose_change', { title: 'late' }),
      ev.toolResult(1, 'late', 'propose_change', { success: true }),
      ev.stepCompleted(1, 'stop'),
      ev.turnCancelled(),
    ]
    const res = fakeTaskResponse(events)
    const turn = await readLiveTurn(res, { stepCeiling: 1, cancel: res.cancel })
    expect(res.cancelled()).toBe(1)
    expect(turn).toMatchObject({ outcome: 'ceiling', stepsCompleted: 2, terminal: true })
    const gen = toGenResult(turn.events, { maxSteps: 1 })
    expect(gen.steps).toHaveLength(1)
    expect(gen.steps[0].finishReason).toBe('tool-calls')
  })

  it('returns aborted as soon as the signal fires (client gone / wall clock)', async () => {
    const ctl = new AbortController()
    const res = fakeTaskResponse([ev.stepCompleted(0, 'tool-calls')], { hangAfter: 1 })
    const read = readLiveTurn(res, { stepCeiling: 20, cancel: res.cancel, signal: ctl.signal })
    await new Promise((r) => setTimeout(r, 5))
    ctl.abort()
    const turn = await read
    expect(turn.outcome).toBe('aborted')
    expect(turn.terminal).toBe(false)
    expect(turn.stepsCompleted).toBe(1)
  })
})

describe('createLiveTurnSseTranslator — the panel’s SSE contract (§9.2)', () => {
  const run = (events: ReturnType<typeof ev.stepCompleted>[]) => {
    const t = createLiveTurnSseTranslator()
    return events.flatMap((e) => t(e))
  }

  it('streams write_summary’s ai_summary as it is typed, once, and announces the tool first', () => {
    const out = run([
      ev.text(0, 'Now I will write the summary…'),
      ev.inputDelta(0, 's1', 'write_summary', '{"ai_summ'),
      ev.inputDelta(0, 's1', 'write_summary', 'ary":"## Sum'),
      ev.inputDelta(0, 's1', 'write_summary', 'mary\\n- Ship Fri'),
      ev.inputDelta(0, 's1', 'write_summary', 'day"}'),
      ev.toolCall(0, 's1', 'write_summary', { ai_summary: '## Summary\n- Ship Friday' }),
    ])
    expect(out[0]).toEqual({ type: 'tool', tool: 'write_summary' })
    const text = out.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('## Summary\n- Ship Friday')
    // Assistant narration never reaches the editor.
    expect(text).not.toContain('Now I will')
  })

  it('two calls streaming interleaved in one step never cross-contaminate', () => {
    const out = run([
      ev.inputDelta(0, 'A', 'write_summary', '{"ai_summary":"Alpha '),
      ev.inputDelta(0, 'B', 'propose_change', '{"title":"Beta '),
      ev.inputDelta(0, 'A', 'write_summary', 'one"}'),
      ev.inputDelta(0, 'B', 'propose_change', 'two","ai_summary":"NOT A SUMMARY"}'),
    ])
    expect(out.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', tool: 'write_summary' },
      { type: 'tool', tool: 'propose_change' },
    ])
    const text = out.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('Alpha one')
  })

  it('falls back to the requested input for a summary call that streamed nothing', () => {
    const out = run([ev.toolCall(0, 's1', 'write_summary', { ai_summary: 'Whole summary' })])
    expect(out).toEqual([{ type: 'text', text: 'Whole summary' }])
  })

  it('emits an activity hint for a tool that never streams input (provider-executed web_search)', () => {
    const out = run([ev.toolCall(0, 'w1', 'web_search', { query: 'Acme' })])
    expect(out).toEqual([{ type: 'tool', tool: 'web_search' }])
  })

  it('does not stream update_summary (surgical edits) — hint only', () => {
    const out = run([
      ev.inputDelta(0, 'u1', 'update_summary', '{"new_text":"inserted"}'),
      ev.toolCall(0, 'u1', 'update_summary', { new_text: 'inserted' }),
    ])
    expect(out).toEqual([{ type: 'tool', tool: 'update_summary' }])
  })
})
