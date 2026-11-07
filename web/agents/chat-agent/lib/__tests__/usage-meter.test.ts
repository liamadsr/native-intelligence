import { describe, it, expect, vi, beforeEach } from 'vitest'
import { streamText } from 'ai'

/**
 * The chat-agent's usage-meter hook bills every eve chat turn SERVER-SIDE:
 * it folds the turn's stream events into durable state and, at the turn's end,
 * posts ONE summed report to /api/internal/chat/usage.
 *
 * Pinned (mock eve/context with an in-memory state store and the spec-client's
 * network call at the module boundary; invoke the handlers directly, in the
 * order eve emits them):
 *   1. one POST per turn, carrying the server-derived numbers (tokens, cost per
 *      the rule, generation ids, the step.started model, the eve session + turn);
 *   2. an Exa-contaminated turn reports costUsd null + webSearchCostUsd;
 *   3. a HITL park bills its two halves under their own turn ids;
 *   4. a failed / cancelled turn still bills its completed steps;
 *   5. a retryable failure (incl. the route's 401 / 409, and a THROWING POST) is
 *      retried, then handed to the outbox (the server-side sweep bills it — the
 *      session's LAST turn included); only if the outbox write fails too is it
 *      kept and re-sent at a later turn — with that turn's token; only a final
 *      answer (400) is dropped; the handlers NEVER throw;
 *   6. a settle is bounded: SETTLE_BUDGET_MS on the network, PENDING_PER_SETTLE
 *      old reports per settle;
 *   7. a session with no run token still reports (the route bills the owner);
 *   8. at-least-once: a settle replayed from the pre-settle state re-sends the
 *      byte-identical report (same session + turn → the route's durable key);
 *   9. a device-ask (surface) token is never reported (it bills 'device_ask') —
 *      but only a token whose HMAC verifies counts as one (expiry ignored);
 *  10. a step eve re-runs (same coordinates, new event ids) is billed once;
 *  11. compaction: only a MANUAL one is billed (sent at once, under its own
 *      compaction ref); an automatic one (maybe no model call) is not; under a
 *      device-ask token neither is reported (known follow-up);
 *  12. every settled report logs one `[chat-context]` line (cache hit rate,
 *      context size, the turn's automatic compactions), never prompt text;
 *  13. the agent's own context parts (lib/context-parts.ts) ride only the
 *      report of the turn whose prompt they were measured for.
 *
 * Lives in lib/__tests__/ (NOT hooks/__tests__/): eve's hook discovery treats
 * every path segment under hooks/ as a hook name (see usage-limit-gate.test.ts).
 */

const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

type ReportResult = { ok: true; body: unknown } | { ok: false; status: number | 'network'; retryable: boolean }
const reportTurnUsage = vi.fn<(t: string, r: unknown) => Promise<ReportResult>>()
const runTokenFromAuth = vi.fn(() => BROWSER_TOKEN)

vi.mock('../spec-client', () => ({
  reportTurnUsage: (t: string, r: unknown) => reportTurnUsage(t, r),
  runTokenFromAuth: () => runTokenFromAuth(),
}))

/** The outbox write (Supabase) — by default it FAILS (returns what it got), so the in-state queue is exercised. */
const writeUsageOutbox = vi.fn<(reports: Array<Record<string, unknown>>, token: string) => Promise<unknown[]>>()
vi.mock('../usage-outbox', () => ({
  writeUsageOutbox: (r: Array<Record<string, unknown>>, t: string) => writeUsageOutbox(r, t),
}))

process.env.CHAT_INTERNAL_SECRET = 'chat-internal-secret-usage-meter'
function tokenWith(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.sig`
}
const BROWSER_TOKEN = mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u' })
const DEVICE_TOKEN = mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask' })

import { mintChatRunToken } from '@/lib/chat/chat-run-token'
import { recordBrowserDispatchUsage } from '../browser-dispatch-usage-state'
import { recordCardContextSize, sectionTokens } from '../card-context-size'
import { STATIC_INSTRUCTIONS_TOKENS, STATIC_TOOLS_TOKENS, recordMemorySize, recordPromptSize, recordToolsSize } from '../context-parts'
import { browserPermissionHandoffSelection, captureBrowserPermissionHandoff, resetBrowserPermissionHandoff } from '../browser-permission-handoff'

/** A stream step.started as eve 0.79 hands it to a step.started resolver: the previous step's index past step 0. */
function asResolverSees<T extends { data: Record<string, unknown> }>(started: T) {
  const index = typeof started.data.stepIndex === 'number' ? started.data.stepIndex : 0
  return { ...started, data: { ...started.data, stepIndex: Math.max(0, index - 1) } }
}
import meterHook, {
  CURRENT_REPORT_ATTEMPTS,
  MAX_PENDING,
  PENDING_PER_SETTLE,
  SETTLE_BUDGET_MS,
  helperOfSession,
} from '../../hooks/usage-meter'

const STATE_KEY = 'chat-agent.usage-meter'
const pendingTurnIds = () =>
  ((stateStore.get(STATE_KEY) as { pending?: Array<{ turnId: string }> } | undefined)?.pending ?? []).map((r) => r.turnId)

type Handler = (e: unknown, ctx: unknown) => Promise<void>
const hook = meterHook as unknown as { events: Record<string, Handler> }
const ctx = { session: { id: 'sess-1', auth: {} } }

let sec = 0
const ev = (type: string, turnId: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { sequence: 0, turnId, ...data },
  meta: { id: `evt_${++sec}`, at: new Date(Date.UTC(2026, 8, 25, 10, 0, sec)).toISOString() },
})

async function emit(e: { type: string }) {
  const h = hook.events[e.type]
  if (h) await h(e, ctx)
}

/** One ordinary turn, as eve emits it; returns its events. */
async function runTurn(turnId: string, opts: { exa?: boolean; end?: 'turn.completed' | 'turn.failed' | 'turn.cancelled' } = {}) {
  await emit(ev('turn.started', turnId))
  await emit(ev('step.started', turnId, { stepIndex: 0, modelId: 'moonshotai/kimi-k2.6' }))
  await emit(ev('actions.requested', turnId, { stepIndex: 0, actions: [{ kind: 'tool-call', toolName: 'web_search', callId: 'w' }] }))
  if (opts.exa) {
    await emit(ev('action.result', turnId, { stepIndex: 0, result: { kind: 'tool-result', callId: 'w', toolName: 'web_search', output: { results: [], costDollars: { total: 0.007 } } } }))
  }
  await emit(ev('step.completed', turnId, { stepIndex: 0, finishReason: 'tool-calls', usage: { inputTokens: 8100, outputTokens: 40, costUsd: 0.007 }, providerMetadata: { gateway: { generationId: `gen_${turnId}_0` } } }))
  await emit(ev('step.started', turnId, { stepIndex: 1, modelId: 'moonshotai/kimi-k2.6' }))
  await emit(ev('step.completed', turnId, { stepIndex: 1, finishReason: 'stop', usage: { inputTokens: 8300, outputTokens: 210, costUsd: 0.004 }, providerMetadata: { gateway: { generationId: `gen_${turnId}_1` } } }))
  await emit(ev(opts.end ?? 'turn.completed', turnId, opts.end === 'turn.failed' ? { code: 'X', message: 'boom' } : {}))
}

const reports = () => reportTurnUsage.mock.calls.map(([, r]) => r as Record<string, unknown>)

beforeEach(() => {
  stateStore.clear()
  reportTurnUsage.mockReset()
  reportTurnUsage.mockResolvedValue({ ok: true, body: { billed: true } })
  runTokenFromAuth.mockReturnValue(BROWSER_TOKEN)
  writeUsageOutbox.mockReset()
  writeUsageOutbox.mockImplementation(async (r) => r)
  sec = 0
})

describe('usage-meter hook', () => {
  it('bills the local handoff as known zero without rewriting Eve history usage or losing prior spend', async () => {
    await emit(ev('turn.started', 'turn_local'))
    resetBrowserPermissionHandoff('turn_local')
    await emit(ev('step.started', 'turn_local', { stepIndex: 0, modelId: 'deepseek/deepseek-v4-flash' }))
    await emit(ev('step.completed', 'turn_local', { stepIndex: 0, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.03 },
      providerMetadata: { gateway: { generationId: 'gen_paid' } } }))
    captureBrowserPermissionHandoff({ turnId: 'turn_local', toolName: 'run_browser_task', input: {},
      output: { success: true, result: { status: 'cancelled', reason: 'user_stopped' } } })
    const started = ev('step.started', 'turn_local', { stepIndex: 1, modelId: 'deepseek/deepseek-v4-flash' })
    await emit(started)
    // eve 0.79 hands the resolver the previous step's index past step 0 (resolver-step.ts).
    const selected = browserPermissionHandoffSelection('deepseek/deepseek-v4-flash', 'turn_local', asResolverSees(started), [{ role: 'user' }, { role: 'assistant' }])!
    const local = streamText({ model: selected.model, prompt: 'Continue', maxRetries: 0 })
    await local.consumeStream()
    expect(await local.usage).toMatchObject({ inputTokens: undefined, outputTokens: 0 })
    const completed = ev('step.completed', 'turn_local', { stepIndex: 1, usage: { outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } })
    const original = JSON.stringify(completed)
    await emit(completed)
    await emit(completed)
    expect(JSON.stringify(completed)).toBe(original)
    await emit(ev('turn.completed', 'turn_local'))
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toMatchObject({ modelId: 'deepseek/deepseek-v4-flash', inputTokens: 100, outputTokens: 20,
      costUsd: 0.03, generationIds: ['gen_paid'], inputTokensReported: true, outputTokensReported: true, steps: 2 })
  })

  it('cannot fill missing provider usage from a local marker belonging to another step', async () => {
    await emit(ev('turn.started', 'turn_local'))
    resetBrowserPermissionHandoff('turn_local')
    captureBrowserPermissionHandoff({ turnId: 'turn_local', toolName: 'wait_for_browser_command', input: {},
      output: { success: true, result: { status: 'cancelled' } } })
    const started = ev('step.started', 'turn_local', { stepIndex: 1, modelId: 'deepseek/deepseek-v4-flash' })
    await emit(started)
    const local = streamText({ model: browserPermissionHandoffSelection('deepseek/deepseek-v4-flash', 'turn_local', asResolverSees(started), [{ role: 'user' }, { role: 'assistant' }])!.model, prompt: 'Continue', maxRetries: 0 })
    await local.consumeStream()
    await emit(ev('step.started', 'turn_local', { stepIndex: 2, modelId: 'deepseek/deepseek-v4-flash' }))
    await emit(ev('step.completed', 'turn_local', { stepIndex: 2, usage: { outputTokens: 10, costUsd: 0.01 } }))
    await emit(ev('turn.completed', 'turn_local'))
    expect(reports()[0]).toMatchObject({ inputTokens: 0, outputTokens: 10, costUsd: 0.01, inputTokensReported: false, outputTokensReported: true })
  })

  it('restores scoped retry metadata stripped by Eve and preserves it on completed-hook replay', async () => {
    await emit(ev('turn.started', 'turn_0'))
    await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'deepseek/deepseek-v4-flash' }))
    recordBrowserDispatchUsage({ turnId: 'turn_0', sequence: 0, stepIndex: 0 }, {
      version: 1, usageUnknown: true, attempts: [
        { generationId: 'gen_first', inputTokens: null, outputTokens: null, usageKnown: false },
        { generationId: 'gen_retry', inputTokens: 100, outputTokens: 10, usageKnown: true },
      ],
    })
    const completed = ev('step.completed', 'turn_0', {
      stepIndex: 0, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
      providerMetadata: { gateway: { generationId: 'gen_retry' } },
    })
    await emit(completed)
    await emit(completed)
    await emit(ev('turn.completed', 'turn_0'))
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.01,
      generationIds: ['gen_first', 'gen_retry'], inputTokensReported: false, outputTokensReported: false })
  })

  it('clears only the restarted step so a clean rerun cannot inherit prior recovery metadata', async () => {
    await emit(ev('turn.started', 'turn_0'))
    await emit(ev('step.started', 'turn_0', { stepIndex: 0 }))
    recordBrowserDispatchUsage({ turnId: 'turn_0', sequence: 0, stepIndex: 0 }, {
      version: 1, usageUnknown: true, attempts: [{ generationId: 'gen_aborted', usageKnown: false }],
    })
    await emit(ev('step.started', 'turn_0', { stepIndex: 0 }))
    await emit(ev('step.completed', 'turn_0', {
      stepIndex: 0, usage: { inputTokens: 100, outputTokens: 10 },
      providerMetadata: { gateway: { generationId: 'gen_clean' } },
    }))
    await emit(ev('turn.completed', 'turn_0'))
    expect(reports()[0]).toMatchObject({ generationIds: ['gen_clean'], inputTokensReported: true, outputTokensReported: true })
  })

  it('keeps known spend but marks usage incomplete if recovery state cannot be read', async () => {
    await emit(ev('turn.started', 'turn_0'))
    const original = stateStore.get.bind(stateStore)
    const read = vi.spyOn(stateStore, 'get').mockImplementation(key => {
      if (key === 'chat-agent.browser-dispatch-usage') throw new Error('state unreadable')
      return original(key)
    })
    try {
      await emit(ev('step.completed', 'turn_0', { stepIndex: 0, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }))
    } finally { read.mockRestore() }
    await emit(ev('turn.completed', 'turn_0'))
    expect(reports()[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.01,
      inputTokensReported: false, outputTokensReported: false })
  })

  it('subscribes to the usage events and every terminal turn event', () => {
    expect(Object.keys(hook.events).sort()).toEqual(
      [
        'action.result',
        'actions.requested',
        'compaction.completed',
        'compaction.requested',
        'step.completed',
        'step.started',
        'turn.cancelled',
        'turn.completed',
        'turn.failed',
        'turn.started',
      ].sort(),
    )
  })

  it('posts ONE report per turn with the server-derived sums, the model the steps ran, and the eve session + turn', async () => {
    await runTurn('turn_0')
    expect(reportTurnUsage).toHaveBeenCalledTimes(1)
    const [token, report] = reportTurnUsage.mock.calls[0]
    expect(token).toBe(BROWSER_TOKEN)
    expect(report).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn_0',
      outcome: 'completed',
      modelId: 'moonshotai/kimi-k2.6',
      inputTokens: 16400,
      outputTokens: 250,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.011, // every step carried a positive cost, no Exa → trusted
      webSearchCostUsd: null,
      steps: 2,
      toolCalls: 1,
      toolDiscoveries: 0,
      generationIds: ['gen_turn_0_0', 'gen_turn_0_1'],
      durationMs: 6000,
      firstEventAt: '2026-09-25T10:00:01.000Z',
      terminalAt: '2026-09-25T10:00:07.000Z',
      inputTokensReported: true,
      outputTokensReported: true,
      compaction: null,
      // Each call's input, not the sum: what compaction decides on.
      contextTokens: { first: 8100, last: 8300, peak: 8300 },
    })
  })

  it("reports what the cards note cost next to the turn's usage, only for the turn it was measured for", async () => {
    recordCardContextSize('turn_0', 87)
    await runTurn('turn_0')
    await runTurn('turn_1')
    expect(reports().map((r) => [r.turnId, r.cardContextTokens])).toEqual([
      ['turn_0', 87],
      ['turn_1', undefined],
    ])
  })

  it("reports the agent's own context parts (the side panel's Context card) on the turn they were measured for only", async () => {
    // A 400-character prompt with a 100-character skills section, as persona.ts records it.
    recordPromptSize('turn_0', `${'p'.repeat(400)}\n\n## Available skills\n${'s'.repeat(78)}`)
    recordToolsSize('turn_0', 14_000)
    recordMemorySize(300)
    await runTurn('turn_0')
    // The next turn's prompt was never measured (its persona failed): no parts, the bill unchanged.
    await runTurn('turn_1')
    expect(reports().map((r) => [r.turnId, r.contextParts])).toEqual([
      ['turn_0', { system: STATIC_INSTRUCTIONS_TOKENS + 100, skills: 25, tools: STATIC_TOOLS_TOKENS + 14_000, memory: 300 }],
      ['turn_1', undefined],
    ])
    expect(reports()[1]).not.toHaveProperty('contextParts')
  })

  it("carries the turn's model route (kept by the model resolver from the spec) for the usage row; none when there is none", async () => {
    await runTurn('turn_plain')
    stateStore.set('chat-agent.turn-model-route', { tier: 'think', by: 'rule', signals: ['explicit_ask'], reasoning: 'high' })
    await runTurn('turn_routed')
    expect(reports().map((r) => [r.turnId, r.modelRoute])).toEqual([
      ['turn_plain', undefined],
      ['turn_routed', { tier: 'think', by: 'rule', signals: ['explicit_ask'], reasoning: 'high' }],
    ])
  })

  it("a quick helper's turn carries its parent session as helperOf (ctx.session.parent); the main chat's never does", async () => {
    await runTurn('turn_main')
    const childCtx = { session: { id: 'wrun_child', auth: {}, parent: { sessionId: 'wrun_parent', rootSessionId: 'wrun_parent', callId: 'c', turn: { id: 't' } } } }
    for (const e of [
      ev('turn.started', 'turn_child'),
      ev('step.started', 'turn_child', { stepIndex: 0, modelId: 'moonshotai/kimi-k2.6' }),
      ev('step.completed', 'turn_child', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 30 } }),
      ev('turn.completed', 'turn_child'),
    ]) {
      const h = hook.events[e.type]
      if (h) await h(e, childCtx)
    }
    expect(reports().map((r) => [r.sessionId, r.turnId, r.helperOf])).toEqual([
      ['sess-1', 'turn_main', undefined],
      ['wrun_child', 'turn_child', 'wrun_parent'],
    ])
    expect(helperOfSession({ session: { id: 'a', auth: {} as never, parent: { sessionId: 'a' } } })).toBeNull()
    expect(helperOfSession({ session: { id: 'a', auth: {} as never, parent: { sessionId: 42 } } })).toBeNull()
  })

  it('measures the cards section in a rendered block, 0 when the block does not carry it', () => {
    const body = 'x'.repeat(40)
    const block = `<turn-context id="aaaaaaaaaaaa">\n<section key="time" v="bbbbbbbbbbbb">\nnow\n</section>\n<section key="cards" v="cccccccccccc">\n${body}\n</section>\n</turn-context id="aaaaaaaaaaaa">`
    expect(sectionTokens(block, 'cards')).toBe(10)
    expect(sectionTokens(block, 'view')).toBe(0)
    expect(sectionTokens(null, 'cards')).toBe(0)
  })

  it('an Exa-contaminated turn reports costUsd null (tokens list-priced) with webSearchCostUsd', async () => {
    await runTurn('turn_0', { exa: true })
    expect(reports()[0]).toMatchObject({ costUsd: null, webSearchCostUsd: 0.007, inputTokens: 16400 })
  })

  it('consecutive turns (e.g. a HITL park, then the answer as a new turn id) each bill once, never mixed', async () => {
    await runTurn('turn_0')
    await runTurn('turn_1')
    expect(reports().map((r) => [r.turnId, r.inputTokens, r.steps])).toEqual([
      ['turn_0', 16400, 2],
      ['turn_1', 16400, 2],
    ])
  })

  it('a failed or cancelled turn still bills the steps it completed', async () => {
    await runTurn('turn_0', { end: 'turn.failed' })
    await runTurn('turn_1', { end: 'turn.cancelled' })
    expect(reports().map((r) => [r.turnId, r.outcome])).toEqual([
      ['turn_0', 'failed'],
      ['turn_1', 'cancelled'],
    ])
  })

  it('a stray second turn.completed after the reset sends nothing (the accumulator was cleared)', async () => {
    await runTurn('turn_0')
    await emit(ev('turn.completed', 'turn_0'))
    expect(reportTurnUsage).toHaveBeenCalledTimes(1)
  })

  it('at-least-once: a settle REPLAYED from the pre-settle state re-sends the byte-identical report (same key)', async () => {
    // Fold a whole turn, then snapshot the durable state the way eve restores it
    // when the step that ran the settle is interrupted and re-run.
    await emit(ev('turn.started', 'turn_0'))
    await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'moonshotai/kimi-k2.6' }))
    await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 30, costUsd: 0.002 } }))
    const snapshot = structuredClone(stateStore.get(STATE_KEY))
    const end = ev('turn.completed', 'turn_0')
    await emit(end)
    stateStore.set(STATE_KEY, snapshot) // the committed boundary before the settle
    await emit(end) // the replayed hook dispatch
    expect(reportTurnUsage).toHaveBeenCalledTimes(2)
    const [a, b] = reports()
    expect(b).toEqual(a)
    expect([a.sessionId, a.turnId]).toEqual(['sess-1', 'turn_0'])
  })

  it('an empty turn (no completed step) posts nothing', async () => {
    await emit(ev('turn.started', 'turn_0'))
    await emit(ev('turn.failed', 'turn_0', { code: 'X', message: 'hook said no' }))
    expect(reportTurnUsage).not.toHaveBeenCalled()
  })

  it('retries a retryable failure, keeps it, and re-sends it at the next turn’s end', async () => {
    reportTurnUsage.mockResolvedValue({ ok: false, status: 503, retryable: true })
    await runTurn('turn_0')
    expect(reportTurnUsage).toHaveBeenCalledTimes(CURRENT_REPORT_ATTEMPTS)
    expect(pendingTurnIds()).toEqual(['turn_0'])
    reportTurnUsage.mockReset()
    reportTurnUsage.mockResolvedValue({ ok: true, body: { billed: true } })
    await runTurn('turn_1')
    // The fresh turn goes first, then the backlog.
    expect(reports().map((r) => r.turnId)).toEqual(['turn_1', 'turn_0'])
    // Both settled → nothing pending: a third turn sends only itself.
    reportTurnUsage.mockClear()
    await runTurn('turn_2')
    expect(reports().map((r) => r.turnId)).toEqual(['turn_2'])
  }, 10_000)

  it('a 401 (the route rejected the secret) is KEPT and re-sent at the next turn, under that turn’s token', async () => {
    reportTurnUsage.mockResolvedValue({ ok: false, status: 401, retryable: true })
    await runTurn('turn_0')
    expect(pendingTurnIds()).toEqual(['turn_0'])
    const NEXT_TOKEN = mintChatRunToken({ conversationId: 'c2', workspaceId: 'w', userId: 'u' })
    runTokenFromAuth.mockReturnValue(NEXT_TOKEN)
    reportTurnUsage.mockReset()
    reportTurnUsage.mockResolvedValue({ ok: true, body: { billed: true } })
    await runTurn('turn_1')
    expect(reportTurnUsage.mock.calls.map(([t, r]) => [t, (r as { turnId: string }).turnId])).toEqual([
      [NEXT_TOKEN, 'turn_1'],
      [NEXT_TOKEN, 'turn_0'],
    ])
    expect(pendingTurnIds()).toEqual([])
  }, 10_000)

  it('a final answer (400: malformed report) is dropped, not retried', async () => {
    reportTurnUsage.mockResolvedValue({ ok: false, status: 400, retryable: false })
    await runTurn('turn_0')
    expect(reportTurnUsage).toHaveBeenCalledTimes(1)
    expect(pendingTurnIds()).toEqual([])
    reportTurnUsage.mockClear()
    reportTurnUsage.mockResolvedValue({ ok: true, body: {} })
    await runTurn('turn_1')
    expect(reports().map((r) => r.turnId)).toEqual(['turn_1'])
  })

  it('a session with NO run token still reports — the route bills the session’s owner', async () => {
    runTokenFromAuth.mockReturnValue('')
    await runTurn('turn_0')
    expect(reportTurnUsage).toHaveBeenCalledTimes(1)
    expect(reportTurnUsage.mock.calls[0][0]).toBe('')
    expect(reports()[0]).toMatchObject({ sessionId: 'sess-1', turnId: 'turn_0', inputTokens: 16400 })
  })

  it('an unreadable principal (auth throws) still reports without a token', async () => {
    runTokenFromAuth.mockImplementation(() => {
      throw new TypeError('no auth')
    })
    await runTurn('turn_0')
    expect(reportTurnUsage.mock.calls.map(([t]) => t)).toEqual([''])
  })

  it('a settle spends at most SETTLE_BUDGET_MS on the network, keeping the rest for later', async () => {
    vi.useFakeTimers()
    try {
      // Pre-existing backlog, then a POST that hangs until its (spec-client) timeout.
      stateStore.set(STATE_KEY, {
        acc: { turnId: null },
        pending: [0, 1].map((i) => ({ sessionId: 'sess-1', turnId: `old_${i}` })),
      })
      reportTurnUsage.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 'network', retryable: true }), 5_000)),
      )
      const started = Date.now()
      const p = runTurn('turn_0')
      await vi.runAllTimersAsync()
      await p
      expect(Date.now() - started).toBeLessThanOrEqual(SETTLE_BUDGET_MS + 5_000)
      // 5s + 0.25s backoff + 5s + 0.5s backoff = 10.75s → a 3rd attempt starts before 12s,
      // and nothing is attempted after the budget.
      expect(reportTurnUsage.mock.calls.length).toBeLessThanOrEqual(CURRENT_REPORT_ATTEMPTS)
      // The budget was spent on the fresh report; the backlog was not touched.
      expect(reports().every((r) => r.turnId === 'turn_0')).toBe(true)
      expect(pendingTurnIds().sort()).toEqual(['old_0', 'old_1', 'turn_0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-tries at most PENDING_PER_SETTLE old reports per settle; the rest stay queued', async () => {
    stateStore.set(STATE_KEY, {
      acc: { turnId: null },
      pending: Array.from({ length: PENDING_PER_SETTLE + 2 }, (_, i) => ({ sessionId: 'sess-1', turnId: `old_${i}` })),
    })
    await runTurn('turn_0')
    expect(reports().map((r) => r.turnId)).toEqual([
      'turn_0',
      ...Array.from({ length: PENDING_PER_SETTLE }, (_, i) => `old_${i}`),
    ])
    expect(pendingTurnIds()).toEqual([`old_${PENDING_PER_SETTLE}`, `old_${PENDING_PER_SETTLE + 1}`])
  })

  it('bounds the pending queue', async () => {
    vi.useFakeTimers()
    try {
      reportTurnUsage.mockResolvedValue({ ok: false, status: 'network', retryable: true })
      for (let i = 0; i < MAX_PENDING + 3; i++) {
        const p = runTurn(`turn_${i}`)
        await vi.runAllTimersAsync()
        await p
      }
      const state = stateStore.get(STATE_KEY) as { pending: Array<{ turnId: string }> }
      expect(state.pending).toHaveLength(MAX_PENDING)
      expect(state.pending.at(-1)?.turnId).toBe(`turn_${MAX_PENDING + 2}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never throws — not on a throwing network call (the report is KEPT, not lost), not on a broken state store', async () => {
    reportTurnUsage.mockRejectedValue(new Error('kaboom'))
    await expect(runTurn('turn_0')).resolves.toBeUndefined()
    // A throwing POST is a retryable failure: this turn's report waits for a re-send.
    expect(pendingTurnIds()).toEqual(['turn_0'])
    stateStore.set(STATE_KEY, null)
    reportTurnUsage.mockReset()
    reportTurnUsage.mockResolvedValue({ ok: true, body: {} })
    await expect(runTurn('turn_1')).resolves.toBeUndefined()
    // A corrupt slot self-heals: the turn is still metered.
    expect(reports().map((r) => r.turnId)).toEqual(['turn_1'])
  }, 10_000)

  it('a device-ask (surface) token is never reported — /api/device/ask bills its own run', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    await runTurn('turn_0')
    expect(reportTurnUsage).not.toHaveBeenCalled()
    expect(pendingTurnIds()).toEqual([])
  })

  it('a forged surface claim (HMAC does not verify) is NOT a free turn — it is reported', async () => {
    runTokenFromAuth.mockReturnValue(tokenWith({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask', exp: Date.now() + 1e6 }))
    await runTurn('turn_0')
    expect(reportTurnUsage).toHaveBeenCalledTimes(1)
  })

  it('an EXPIRED but validly signed device-ask token is still a surface run (expiry says nothing about who minted it)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000)
    const expired = mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask' })
    vi.useRealTimers()
    runTokenFromAuth.mockReturnValue(expired)
    await runTurn('turn_0')
    expect(reportTurnUsage).not.toHaveBeenCalled()
  })

  describe('the outbox — the server-side backstop for an undeliverable report', () => {
    it('the session’s LAST turn: an undeliverable report goes to the outbox at once (no later turn needed)', async () => {
      reportTurnUsage.mockResolvedValue({ ok: false, status: 503, retryable: true })
      writeUsageOutbox.mockResolvedValue([])
      await runTurn('turn_0')
      expect(reportTurnUsage).toHaveBeenCalledTimes(CURRENT_REPORT_ATTEMPTS)
      expect(writeUsageOutbox).toHaveBeenCalledTimes(1)
      const [written, token] = writeUsageOutbox.mock.calls[0]
      expect(token).toBe(BROWSER_TOKEN)
      expect(written.map((r) => [r.sessionId, r.turnId, r.inputTokens])).toEqual([['sess-1', 'turn_0', 16400]])
      // The sweep owns it now: nothing waits in session state.
      expect(pendingTurnIds()).toEqual([])
    }, 10_000)

    it('a 409 (session not registered yet) and a 401 (secret mismatch) go to the outbox too', async () => {
      writeUsageOutbox.mockResolvedValue([])
      for (const status of [409, 401]) {
        reportTurnUsage.mockReset()
        reportTurnUsage.mockResolvedValue({ ok: false, status, retryable: true })
        await runTurn(`turn_${status}`)
      }
      expect(writeUsageOutbox.mock.calls.map(([r]) => r[0].turnId)).toEqual(['turn_409', 'turn_401'])
    }, 10_000)

    it('a delivered report never touches the outbox', async () => {
      await runTurn('turn_0')
      const outboxed = writeUsageOutbox.mock.calls.flatMap(([r]) => r)
      expect(outboxed).toEqual([])
    })

    it('an OLD pending backlog (left when an earlier outbox write failed) drains to the outbox once it recovers', async () => {
      stateStore.set(STATE_KEY, {
        acc: { turnId: null, steps: {} },
        pending: Array.from({ length: PENDING_PER_SETTLE + 2 }, (_, i) => ({ sessionId: 'sess-1', turnId: `old_${i}` })),
        compaction: null,
      })
      reportTurnUsage.mockResolvedValue({ ok: false, status: 503, retryable: true })
      writeUsageOutbox.mockResolvedValue([])
      await runTurn('turn_0')
      // Every old report — the ones re-tried this settle AND the ones past
      // PENDING_PER_SETTLE — plus this turn's, in one outbox write.
      expect(writeUsageOutbox).toHaveBeenCalledTimes(1)
      expect(writeUsageOutbox.mock.calls[0][0].map((r) => r.turnId).sort()).toEqual(
        [...Array.from({ length: PENDING_PER_SETTLE + 2 }, (_, i) => `old_${i}`), 'turn_0'].sort(),
      )
      expect(pendingTurnIds()).toEqual([])
    }, 10_000)

    it('when the outbox write fails too, the report stays in state for the next turn (the old path)', async () => {
      reportTurnUsage.mockResolvedValue({ ok: false, status: 'network', retryable: true })
      await runTurn('turn_0')
      expect(writeUsageOutbox).toHaveBeenCalledTimes(1)
      expect(pendingTurnIds()).toEqual(['turn_0'])
    }, 10_000)
  })

  it('a step eve RE-RUNS (same coordinates, new event ids) is billed once — the last attempt’s usage', async () => {
    await emit(ev('turn.started', 'turn_0'))
    await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'moonshotai/kimi-k2.6' }))
    await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 30 } }))
    // The step is interrupted after its step.completed was recorded and re-runs:
    await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'moonshotai/kimi-k2.6' }))
    await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 905, outputTokens: 31 } }))
    await emit(ev('turn.completed', 'turn_0'))
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toMatchObject({ inputTokens: 905, outputTokens: 31, steps: 1 })
  })

  describe("a turn on the person's ChatGPT plan", () => {
    const PLAN = { model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' }

    it("reports a step on the search model (openai/<plan model>) under the plan's name, and nothing else", async () => {
      stateStore.set('chatgpt-plan.plan', PLAN)
      await emit(ev('turn.started', 'turn_0'))
      await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'openai/gpt-6.1-sol' }))
      await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 40 } }))
      await emit(ev('turn.completed', 'turn_0'))
      expect(reports()[0]).toMatchObject({ modelId: 'chatgpt-plan/gpt-6.1-sol', inputTokens: 900 })
      // A model that isn't this plan's keeps its id.
      await emit(ev('turn.started', 'turn_1'))
      await emit(ev('step.started', 'turn_1', { stepIndex: 0, modelId: 'openai/gpt-5.6-sol' }))
      await emit(ev('step.completed', 'turn_1', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } }))
      await emit(ev('turn.completed', 'turn_1'))
      expect(reports()[1]).toMatchObject({ modelId: 'openai/gpt-5.6-sol' })
    })

    it('reports a manual compaction on the search model under the plan\'s name', async () => {
      stateStore.set('chatgpt-plan.plan', PLAN)
      await emit(ev('compaction.requested', 'turn_1', { modelId: 'openai/gpt-6-luna', sequence: 1, sessionId: 'sess-1', usageInputTokens: 50_000 }))
      await emit(ev('compaction.completed', 'turn_1', { modelId: 'openai/gpt-6-luna', sequence: 1, sessionId: 'sess-1' }))
      expect(reports()[0]).toMatchObject({ modelId: 'chatgpt-plan/gpt-6-luna' })
    })

    it('leaves an off-plan turn alone, whatever its model is named', async () => {
      await emit(ev('turn.started', 'turn_0'))
      await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'openai/gpt-6.1-sol' }))
      await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } }))
      await emit(ev('turn.completed', 'turn_0'))
      expect(reports()[0]).toMatchObject({ modelId: 'openai/gpt-6.1-sol' })
    })
  })

  describe('compaction', () => {
    const requested = (turnId: string, usageInputTokens: number, sequence = 0) =>
      ev('compaction.requested', turnId, { modelId: 'anthropic/claude-sonnet-4.6', sequence, sessionId: 'sess-1', usageInputTokens })
    const completed = (turnId: string, sequence = 0) =>
      ev('compaction.completed', turnId, { modelId: 'anthropic/claude-sonnet-4.6', sequence, sessionId: 'sess-1' })

    it('an AUTOMATIC compaction inside a step is NOT billed (eve emits the pair even when no model was called)', async () => {
      await emit(ev('turn.started', 'turn_0'))
      await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'anthropic/claude-sonnet-4.6' }))
      await emit(requested('turn_0', 180_000))
      await emit(completed('turn_0'))
      expect(reportTurnUsage).not.toHaveBeenCalled() // no network mid-step
      await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 20_000, outputTokens: 300 } }))
      await emit(ev('turn.completed', 'turn_0'))
      // Only the turn's own report — no 180k-token estimate row.
      expect(reports().map((r) => [r.turnId, r.compaction, r.inputTokens, r.outputTokens])).toEqual([['turn_0', null, 20_000, 300]])
      expect(writeUsageOutbox.mock.calls.flatMap(([r]) => r)).toEqual([])
    })

    it('under a DEVICE-ASK token a manual /compact is not reported (known follow-up: /api/device/ask cannot see it either)', async () => {
      // Pinned so the follow-up (report surface compactions under their own
      // key) flips this deliberately. The session's pending queue is untouched.
      runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
      await emit(requested('turn_0', 60_000))
      await emit(completed('turn_0'))
      await runTurn('turn_0')
      expect(reportTurnUsage).not.toHaveBeenCalled()
      expect(writeUsageOutbox).not.toHaveBeenCalled()
      expect(pendingTurnIds()).toEqual([])
      expect((stateStore.get(STATE_KEY) as { compaction: unknown }).compaction).toBeNull()
    })

    it('a MANUAL /compact (between turns) is sent at once — it may never be followed by a turn.* event', async () => {
      await runTurn('turn_0')
      reportTurnUsage.mockClear()
      const req = requested('turn_1', 60_000, 1)
      await emit(req)
      await emit(completed('turn_1', 1))
      expect(reports()).toHaveLength(1)
      expect(reports()[0]).toMatchObject({
        sessionId: 'sess-1',
        turnId: 'turn_1',
        inputTokens: 60_000,
        compaction: { trigger: 'manual', id: `m${req.meta.id}` },
      })
      // The next turn's own report is unaffected.
      reportTurnUsage.mockClear()
      await runTurn('turn_1')
      expect(reports().map((r) => r.compaction)).toEqual([null])
    })

    it('a compaction that never completes (the summary failed) bills nothing', async () => {
      await emit(ev('turn.started', 'turn_0'))
      await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'm' }))
      await emit(requested('turn_0', 50_000))
      await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } }))
      await emit(ev('turn.completed', 'turn_0'))
      expect(reports().map((r) => r.compaction)).toEqual([null])
    })

    it('logs one [chat-context] line per turn, counting its automatic compaction, and one for a manual compaction', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await emit(ev('turn.started', 'turn_0'))
        await emit(ev('step.started', 'turn_0', { stepIndex: 0, modelId: 'deepseek/deepseek-v4-flash' }))
        await emit(requested('turn_0', 180_000))
        await emit(completed('turn_0'))
        await emit(ev('step.completed', 'turn_0', { stepIndex: 0, finishReason: 'stop',
          usage: { inputTokens: 20_000, outputTokens: 300, cacheReadTokens: 15_000 } }))
        await emit(ev('turn.completed', 'turn_0'))
        await emit(requested('turn_1', 60_000, 1))
        await emit(completed('turn_1', 1))
        const lines = log.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith('[chat-context]'))
        expect(lines).toEqual([
          '[chat-context] session=sess-1 turn=turn_0 model=deepseek/deepseek-v4-flash outcome=completed steps=1 ' +
            'input=20000 cached=15000 hit=0.75 written=0 first=20000 last=20000 peak=20000 output=300 compactions=1 compactedInput=180000 compacted=180000>20000',
          '[chat-context] session=sess-1 turn=turn_1 model=anthropic/claude-sonnet-4.6 compaction=manual estimatedInput=60000',
        ])
        // Billing is unchanged: the turn report and the manual compaction report.
        expect(reports().map((r) => [r.turnId, r.compaction === null ? null : 'manual'])).toEqual([['turn_0', null], ['turn_1', 'manual']])
        // The turn report carries the context size and the compaction's before and after (the usage row's metadata).
        expect(reports()[0]).toMatchObject({
          contextTokens: { first: 20_000, last: 20_000, peak: 20_000 },
          autoCompactions: [{ before: 180_000, after: 20_000 }],
        })
        expect(reports()[1]).not.toHaveProperty('contextTokens')
      } finally {
        log.mockRestore()
      }
    })

    it('an undeliverable manual compaction report goes to the outbox like a turn’s', async () => {
      reportTurnUsage.mockResolvedValue({ ok: false, status: 503, retryable: true })
      writeUsageOutbox.mockResolvedValue([])
      await emit(requested('turn_0', 60_000))
      await emit(completed('turn_0'))
      expect(writeUsageOutbox.mock.calls[0][0].map((r) => r.compaction)).toEqual([{ trigger: 'manual', id: expect.stringMatching(/^mevt_/) }])
    }, 10_000)
  })
})
