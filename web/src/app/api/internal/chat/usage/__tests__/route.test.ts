/**
 * Route tests for POST /api/internal/chat/usage — server-side metering of eve
 * main-chat turns (WS-5a).
 *
 * Pins:
 *   - the internal secret is the gate: a wrong/absent one is a 401 carrying
 *     INTERNAL_SECRET_REJECTED (alerted, and retryable for the hook), never billed;
 *   - WHO PAYS never comes from the body: the user of a token whose HMAC
 *     verifies (EXPIRED included, up to TURN_REPORT_TOKEN_GRACE_MS past its
 *     expiry — expiry gates new work, not attribution; past the grace it counts
 *     as no token),
 *     else — no token, a garbage or foreign-signed one — the eve session's
 *     OWNER (chat_conversations.eve_session_id); an unowned session is a 409
 *     SESSION_UNREGISTERED (kept by the hook), an owner-lookup fault a 500;
 *   - exactly ONE bill per turn: logUsage carries the idempotency key
 *     `ai_chat:<session>:<turn>` (log_ai_usage_once), a duplicate outcome is
 *     reported as such, and a LOST bill is a 500 so the hook re-sends;
 *   - feature 'ai_chat' + original metadata retain their billing meaning, with
 *     trusted runtime/tenancy attribution added; cache / webSearchCostUsd only
 *     when present; model = the app id of the slug the steps actually ran;
 *   - the Exa rule: an Exa-contaminated turn bills tokens at list price (costUsd
 *     omitted) with webSearchCostUsd in metadata;
 *   - a surface (device ask) token whose HMAC verifies (expired or not) is never
 *     billed here (the device route bills device_ask); a FORGED surface claim is
 *     ignored — the turn is billed to the session owner;
 *   - a compaction report bills under its own key with its estimate flags.
 *
 * logUsage is faked: the stand-in below ASSUMES log_ai_usage_once's contract
 * (claim once; a failed bill leaves no claim). These tests pin the ROUTE's
 * handling of each outcome, not the RPC — the RPC's own exactly-once and
 * rollback behavior is exercised by supabase/tests/278_log_ai_usage_once.sql
 * (psql against a database with the migrations applied).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-abcdefghij'

type Outcome = 'logged' | 'duplicate' | 'retry-enqueued' | 'lost'
// A stand-in for log_ai_usage_once: the key claims once, and a failed bill leaves no claim.
const billedKeys = new Set<string>()
const logUsageSpy = vi.fn(async (_userId: string, params: { idempotencyKey?: string }): Promise<Outcome> => {
  if (params.idempotencyKey && billedKeys.has(params.idempotencyKey)) return 'duplicate'
  if (params.idempotencyKey) billedKeys.add(params.idempotencyKey)
  return 'logged'
})
vi.mock('@/lib/ai/auth', () => ({
  logUsage: (userId: string, params: { idempotencyKey?: string }) => logUsageSpy(userId, params),
}))
const sentryMessage = vi.fn()
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: (...a: unknown[]) => sentryMessage(...a) }))

// ── chat_conversations owner lookup (eve_session_id → user_id) ───────────────
const owners = new Map<string, string>()
const ownerFault = { current: null as null | { message: string } }
const ownerLookups: string[] = []
const serviceFrom = vi.fn((table: string) => {
  if (table !== 'chat_conversations') throw new Error(`unexpected table ${table}`)
  let sessionId = ''
  const chain = {
    select: () => chain,
    eq: (col: string, v: string) => {
      if (col === 'eve_session_id') sessionId = v
      return chain
    },
    limit: () => chain,
    maybeSingle: async () => {
      ownerLookups.push(sessionId)
      if (ownerFault.current) return { data: null, error: ownerFault.current }
      const user = owners.get(sessionId)
      return { data: user ? { user_id: user, id: `conversation-${sessionId}`, workspace_id: 'owner-workspace' } : null, error: null }
    },
  }
  return chain
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: serviceFrom }) }))

import { POST } from '@/app/api/internal/chat/usage/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, TURN_REPORT_TOKEN_GRACE_MS } from '@/lib/chat/chat-run-token'

function req(opts: { secret?: string; token?: string; body?: unknown; rawBody?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret) headers[CHAT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/chat/usage', {
    method: 'POST',
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {}),
  })
}

const browserToken = () => mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' })
const deviceToken = () =>
  mintChatRunToken({ conversationId: 'conv-d', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
/** A well-formed token whose signature is not ours (tampered / other secret / expired-looking). */
function unverifiable(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.not-our-signature`
}

/** A token minted 70 minutes ago (validly signed, expired 10 minutes ago: inside the grace). */
function expired(mint: () => string): string {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() - 70 * 60 * 1000)
  try {
    return mint()
  } finally {
    vi.useRealTimers()
  }
}

function report(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    turnId: 'turn_0',
    outcome: 'completed',
    modelId: 'anthropic/claude-haiku-4.5',
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    webSearchCostUsd: null,
    steps: 2,
    toolCalls: 1,
    toolDiscoveries: 0,
    generationIds: ['gen_a', 'gen_b'],
    durationMs: 4200,
    ...over,
  }
}

async function post(body: unknown, token: string | null = browserToken()) {
  return POST(req({ secret: SECRET, token: token ?? undefined, body }))
}
const paramsOf = (i: number) => (logUsageSpy.mock.calls[i] as unknown as [string, Record<string, unknown>])[1]

describe('POST /api/internal/chat/usage', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    billedKeys.clear()
    logUsageSpy.mockClear()
    sentryMessage.mockClear()
    serviceFrom.mockClear()
    owners.clear()
    owners.set('sess-1', 'owner-of-sess-1')
    ownerFault.current = null
    ownerLookups.length = 0
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
  })

  it('401 INTERNAL_SECRET_REJECTED on a wrong/absent secret — alerted, nothing billed, no lookup', async () => {
    for (const r of [
      req({ token: browserToken(), body: report() }),
      req({ secret: 'nope', token: browserToken(), body: report() }),
    ]) {
      const res = await POST(r)
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ code: 'INTERNAL_SECRET_REJECTED' })
    }
    expect(sentryMessage).toHaveBeenCalledTimes(2)
    expect(logUsageSpy).not.toHaveBeenCalled()
    expect(serviceFrom).not.toHaveBeenCalled()
  })

  it('bills ONE ai_chat row with the server-derived numbers and TOKEN tenancy (never the body, no owner lookup)', async () => {
    const res = await post({ ...report(), userId: 'attacker', workspaceId: 'ws-x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ billed: true })
    expect(logUsageSpy).toHaveBeenCalledTimes(1)
    const [userId, params] = logUsageSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    expect(params).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      feature: 'ai_chat',
      inputTokens: 1200,
      outputTokens: 300,
      durationMs: 4200,
      metadata: { toolCalls: 1, steps: 2, toolDiscoveries: 0, runtime: 'eve', generationIds: ['gen_a', 'gen_b'] },
      idempotencyKey: 'ai_chat:sess-1:turn_0',
    })
    expect(params.metadata).toMatchObject({ attribution_version: 1, usage_scope: 'eve_turn',
      parent_run_id: 'ai_chat:sess-1:turn_0', usage_key: 'ai_chat:sess-1:turn_0',
      conversation_id: 'conv-1', workspace_id: 'ws-1', eve_session_id: 'sess-1', eve_turn_id: 'turn_0',
      outcome: 'completed', runtime_first_event_at: null, runtime_terminal_at: null, timing_scope: 'eve_turn_events',
      input_tokens_reported: false, output_tokens_reported: false, usage_unknown: true, cost_source: 'catalog' })
    expect(ownerLookups).toEqual([])
  })

  it("logs a turn on the person's ChatGPT plan at no cost: nothing accrues, nothing is list-priced", async () => {
    const res = await post(report({ modelId: 'chatgpt-plan/gpt-6.1-sol', costUsd: null, generationIds: [] }))
    expect(res.status).toBe(200)
    const params = paramsOf(0)
    // The plan provider: logUsage zeroes its cost (auth.test.ts pins that).
    expect(params).toMatchObject({ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6.1-sol', inputTokens: 1200, outputTokens: 300 })
    expect(params).not.toHaveProperty('costUsd')
    expect(params.metadata).toMatchObject({ cost_source: 'chatgpt_plan' })
    // Everyone else is unchanged.
    await post(report({ turnId: 'turn_1' }))
    expect(paramsOf(1).provider).toBe('claude')
  })

  it("logs a plan turn on the search model (eve names its steps openai/<plan model>) as the plan's, at no cost", async () => {
    const res = await post(report({ modelId: 'openai/gpt-6.1-sol', costUsd: null, generationIds: [] }))
    expect(res.status).toBe(200)
    expect(paramsOf(0)).toMatchObject({ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6.1-sol' })
    expect(paramsOf(0)).not.toHaveProperty('costUsd')
    expect(paramsOf(0).metadata).toMatchObject({ cost_source: 'chatgpt_plan' })
  })

  it('a bot’s turns bill to the person as ai_chat (never a surface turn), and the row names the bot: its thread, or a main-chat conversation (bots-v4 Phase C)', async () => {
    const thread = mintChatRunToken({ conversationId: 'conv-tm', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1' })
    const botConversation = mintChatRunToken({ conversationId: 'conv-bot', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1', teammateIn: 'chat' })
    expect(await (await post(report({ turnId: 'turn_1' }), thread)).json()).toEqual({ billed: true })
    expect(await (await post(report({ turnId: 'turn_2' }), botConversation)).json()).toEqual({ billed: true })
    expect(logUsageSpy.mock.calls.map((c) => c[0])).toEqual(['user-1', 'user-1'])
    expect(paramsOf(0)).toMatchObject({ feature: 'ai_chat', metadata: { teammate_id: 'tm-1', teammate_in: 'thread', conversation_id: 'conv-tm' } })
    expect(paramsOf(1)).toMatchObject({ feature: 'ai_chat', metadata: { teammate_id: 'tm-1', teammate_in: 'chat', conversation_id: 'conv-bot' } })
    // An ordinary chat's row names no bot.
    await post(report({ turnId: 'turn_3' }))
    expect(paramsOf(2).metadata).not.toHaveProperty('teammate_id')
  })

  it('a turn the main chat relayed into the bot’s thread bills to the person as ai_chat (never a surface turn), the row noting the relay (bots-v4 A4)', async () => {
    const relayed = mintChatRunToken({ conversationId: 'conv-tm', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1', relay: 'relay-9' })
    expect(await (await post(report({ turnId: 'turn_4' }), relayed)).json()).toEqual({ billed: true })
    expect(logUsageSpy.mock.calls.map((c) => c[0])).toEqual(['user-1'])
    expect(paramsOf(0)).toMatchObject({ feature: 'ai_chat', metadata: { teammate_id: 'tm-1', teammate_in: 'thread', relay_id: 'relay-9', conversation_id: 'conv-tm' } })
    // The person's own turns in that thread note none.
    await post(report({ turnId: 'turn_5' }), mintChatRunToken({ conversationId: 'conv-tm', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1' }))
    expect(paramsOf(1).metadata).not.toHaveProperty('relay_id')
  })

  it('keeps what the cards note cost in the row metadata, drops a bad figure, and never refuses the bill over it', async () => {
    await post(report({ turnId: 'turn_c1', cardContextTokens: 87 }))
    expect(paramsOf(0).metadata).toMatchObject({ card_context_tokens: 87 })
    expect((await post(report({ turnId: 'turn_c2', cardContextTokens: -3 }))).status).toBe(200)
    expect(paramsOf(1).metadata).not.toHaveProperty('card_context_tokens')
    await post(report({ turnId: 'turn_c3' }))
    expect(paramsOf(2).metadata).not.toHaveProperty('card_context_tokens')
  })

  it('keeps the context size per call and each automatic compaction before and after, drops bad figures, never refuses the bill', async () => {
    await post(report({
      turnId: 'turn_x1',
      inputTokens: 782_415,
      contextTokens: { first: 120_000, last: 185_000, peak: 185_000 },
      autoCompactions: [{ before: 226_000, after: 61_000 }, { before: null, after: null }],
    }))
    expect(paramsOf(0).metadata).toMatchObject({
      context_first_step_input_tokens: 120_000,
      context_last_step_input_tokens: 185_000,
      context_peak_step_input_tokens: 185_000,
      auto_compactions: [{ before_tokens: 226_000, after_tokens: 61_000 }, { before_tokens: null, after_tokens: null }],
    })
    // A peak below the last, a negative side, a non-array: dropped, still billed.
    const bad = await post(report({
      turnId: 'turn_x2',
      contextTokens: { first: 10, last: 50, peak: 20 },
      autoCompactions: [{ before: -1, after: 5 }, 'x', { before: 7, after: 3 }],
    }))
    expect(bad.status).toBe(200)
    expect(paramsOf(1).metadata).not.toHaveProperty('context_last_step_input_tokens')
    expect(paramsOf(1).metadata).toMatchObject({ auto_compactions: [{ before_tokens: 7, after_tokens: 3 }] })
    await post(report({ turnId: 'turn_x3', autoCompactions: 'none' }))
    expect(paramsOf(2).metadata).not.toHaveProperty('auto_compactions')
    expect(paramsOf(2).metadata).not.toHaveProperty('context_first_step_input_tokens')
  })

  it("keeps the agent's own context parts as context_parts (the side panel's Context card); a malformed set is dropped, never refuses the bill", async () => {
    const parts = { system: 9000, skills: 1200, tools: 14_000, memory: 300 }
    // Only the four counts are kept (a fraction floored); anything else on it is not.
    expect((await post(report({ turnId: 'turn_p0', contextParts: { ...parts, memory: 300.9, prompt: 'never kept' } }))).status).toBe(200)
    expect((paramsOf(0).metadata as Record<string, unknown>).context_parts).toEqual(parts)
    const bad: unknown[] = [{ ...parts, tools: -1 }, { system: 9000, skills: 1200, tools: 14_000 }, { ...parts, memory: '300' }, [1, 2, 3, 4], 'parts', 7]
    for (const [i, contextParts] of bad.entries()) {
      const res = await post(report({ turnId: `turn_p${i + 1}`, contextParts }))
      expect(res.status, JSON.stringify(contextParts)).toBe(200)
      expect(paramsOf(i + 1).metadata, JSON.stringify(contextParts)).not.toHaveProperty('context_parts')
    }
    // A runtime that does not measure them sends none.
    await post(report({ turnId: 'turn_p9' }))
    expect(paramsOf(bad.length + 1).metadata).not.toHaveProperty('context_parts')
  })

  it("keeps a quick helper's parent session as helper_of (metadata only; the payer still comes from the token)", async () => {
    await post(report({ turnId: 'turn_h1', sessionId: 'wrun_child', helperOf: 'wrun_parent' }))
    expect(paramsOf(0).metadata).toMatchObject({ helper_of: 'wrun_parent', eve_session_id: 'wrun_child' })
    await post(report({ turnId: 'turn_h2', helperOf: 42 }))
    expect(paramsOf(1).metadata).not.toHaveProperty('helper_of')
  })

  it('omits the generationIds key when the turn carries none', async () => {
    await post(report({ generationIds: [] }))
    expect(paramsOf(0).metadata).not.toHaveProperty('generationIds')
  })

  it('NO token → billed to the eve session OWNER (owner-derivation), same key', async () => {
    const res = await post(report(), null)
    expect(await res.json()).toEqual({ billed: true })
    expect(ownerLookups).toEqual(['sess-1'])
    const [userId, params] = logUsageSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(userId).toBe('owner-of-sess-1')
    expect(params.idempotencyKey).toBe('ai_chat:sess-1:turn_0')
    expect(params.metadata).toMatchObject({ conversation_id: 'conversation-sess-1', workspace_id: 'owner-workspace', parent_run_id: 'ai_chat:sess-1:turn_0' })
  })

  it('records exact runtime timing, reported usage and multiple command links in one unchanged bill', async () => {
    const ids = ['12345678-1234-1234-1234-123456789abc', '12345678-1234-1234-1234-123456789abd']
    const firstEventAt = '2026-10-04T10:00:00.000Z'
    const terminalAt = '2026-10-04T10:00:04.200Z'
    const body = report({ inputTokensReported: true, outputTokensReported: true, costUsd: 0.003,
      firstEventAt, terminalAt,
      browserCommandIds: [...ids, ids[0], 'forged'], parent_run_id: 'forged', conversationId: 'foreign' })
    await post(body)
    await post(body)
    expect([...billedKeys]).toEqual(['ai_chat:sess-1:turn_0'])
    expect(paramsOf(0).metadata).toMatchObject({ parent_run_id: 'ai_chat:sess-1:turn_0', conversation_id: 'conv-1',
      browser_command_ids: ids, input_tokens_reported: true, output_tokens_reported: true, usage_unknown: false,
      cost_source: 'eve_reported', runtime_first_event_at: firstEventAt, runtime_terminal_at: terminalAt })
  })

  it('keeps failed, cancelled and superseded usage as unknown even when their completed steps report tokens', async () => {
    for (const [i, over] of [{ outcome: 'failed' }, { outcome: 'cancelled' }, { supersededGenerationIds: ['old'] }].entries()) {
      await post(report({ turnId: `turn_${i}`, inputTokensReported: true, outputTokensReported: true, ...over }))
      expect(paramsOf(i).metadata).toMatchObject({ usage_unknown: true })
      expect(paramsOf(i)).toMatchObject({ inputTokens: 1200, outputTokens: 300 })
    }
  })

  it('invalid optional observability fields never void a bill or turn unknown usage into reported usage', async () => {
    await post(report({ firstEventAt: 'today', terminalAt: 42, inputTokensReported: 'true', outputTokensReported: 1, browserCommandIds: 'forged' }))
    expect(paramsOf(0).metadata).toMatchObject({ runtime_first_event_at: null, runtime_terminal_at: null,
      input_tokens_reported: false, output_tokens_reported: false, usage_unknown: true })
    expect(paramsOf(0).metadata).not.toHaveProperty('browser_command_ids')
  })

  it('a garbage / foreign-signed token → the session owner pays (never the token’s claimed user)', async () => {
    await post(report(), 'garbage')
    await post(report({ turnId: 'turn_1' }), unverifiable({ conversationId: 'c', workspaceId: 'w', userId: 'attacker', exp: 1 }))
    expect(logUsageSpy.mock.calls.map(([u]) => u)).toEqual(['owner-of-sess-1', 'owner-of-sess-1'])
  })

  it('no valid token and NO owner row → 409 SESSION_UNREGISTERED (kept by the hook), nothing billed', async () => {
    const res = await post(report({ sessionId: 'sess-unknown' }), null)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'SESSION_UNREGISTERED' })
    expect(logUsageSpy).not.toHaveBeenCalled()
  })

  it('an owner-lookup fault → 500 (the hook re-sends), nothing billed', async () => {
    ownerFault.current = { message: 'db down' }
    expect((await post(report(), null)).status).toBe(500)
    expect(logUsageSpy).not.toHaveBeenCalled()
  })

  it('is idempotent on the turn: logUsage’s keyed RPC reports the replay as a duplicate', async () => {
    expect(await (await post(report())).json()).toEqual({ billed: true })
    expect(await (await post(report())).json()).toEqual({ billed: false, reason: 'duplicate' })
    // The same turn via the owner path is the SAME key → still a duplicate.
    expect(await (await post(report({ inputTokens: 999999 }), null)).json()).toEqual({ billed: false, reason: 'duplicate' })
    // A different turn, or the same turn id in another eve session, is a new bill.
    expect(await (await post(report({ turnId: 'turn_1' }))).json()).toEqual({ billed: true })
    expect(await (await post(report({ sessionId: 'sess-2' }))).json()).toEqual({ billed: true })
    expect([...billedKeys]).toEqual(['ai_chat:sess-1:turn_0', 'ai_chat:sess-1:turn_1', 'ai_chat:sess-2:turn_0'])
  })

  it('a LOST bill (RPC failed and the retry could not be queued) answers 500 so the hook re-sends; a queued one is billed', async () => {
    logUsageSpy.mockImplementationOnce(async () => 'lost')
    expect((await post(report())).status).toBe(500)
    // ASSUMED here (the fake never claimed the key): log_ai_usage_once rolls its
    // claim back with a failed bill, so the re-send bills. This checks the
    // route's 500-then-resend contract; the rollback itself is the SQL test's.
    expect(await (await post(report())).json()).toEqual({ billed: true })
    logUsageSpy.mockImplementationOnce(async () => 'retry-enqueued')
    expect(await (await post(report({ turnId: 'turn_1' }))).json()).toEqual({ billed: true })
  })

  it('an Exa-contaminated turn bills tokens at list price (no costUsd) with webSearchCostUsd in metadata', async () => {
    // Even if a runtime sent eve's contaminated cost, the route drops it.
    await post(report({ costUsd: 0.007, webSearchCostUsd: 0.007 }))
    const params = paramsOf(0)
    expect(params).not.toHaveProperty('costUsd')
    expect(params.inputTokens).toBe(1200)
    expect(params.metadata).toMatchObject({ webSearchCostUsd: 0.007, runtime: 'eve' })
  })

  it('a trusted positive eve cost (no Exa) passes through; 0 is omitted', async () => {
    await post(report({ costUsd: 0.0123 }))
    expect(paramsOf(0).costUsd).toBe(0.0123)
    await post(report({ turnId: 'turn_1', costUsd: 0 }))
    expect(paramsOf(1)).not.toHaveProperty('costUsd')
  })

  it('a cached Claude turn carries log_ai_usage’s cache keys; an uncached turn carries neither', async () => {
    await post(report({ inputTokens: 20000, cacheReadTokens: 15000, cacheWriteTokens: 2000 }))
    expect(paramsOf(0).metadata).toMatchObject({ cache_read_input_tokens: 15000, cache_creation_input_tokens: 2000 })
    expect(paramsOf(0)).toMatchObject({ provider: 'claude', inputTokens: 20000 })
    await post(report({ turnId: 'turn_1', cacheReadTokens: 800 }))
    expect(paramsOf(1).metadata).toMatchObject({ cache_read_input_tokens: 800 })
    expect(paramsOf(1).metadata).not.toHaveProperty('cache_creation_input_tokens')
    await post(report({ turnId: 'turn_2' }))
    expect(paramsOf(2).metadata).not.toHaveProperty('cache_read_input_tokens')
    expect(paramsOf(2).metadata).not.toHaveProperty('cache_creation_input_tokens')
  })

  it('writes the turn\'s model route (auto model selection) to metadata.model_route; a malformed one is dropped, never refused', async () => {
    const route = { tier: 'think', by: 'rule', signals: ['explicit_ask'], reasoning: 'high' }
    expect((await post(report({ modelRoute: route }))).status).toBe(200)
    expect(paramsOf(0).metadata).toMatchObject({ model_route: route })
    expect((await post(report({ turnId: 'turn_1', modelRoute: { tier: 'max', by: 'rule' } }))).status).toBe(200)
    expect(paramsOf(1).metadata).not.toHaveProperty('model_route')
    await post(report({ turnId: 'turn_2' }))
    expect(paramsOf(2).metadata).not.toHaveProperty('model_route')
  })

  it('maps the slug the steps ran to the app model id + provider label; unseen model → the main chat\'s (MAIN_MODEL)', async () => {
    await post(report({ modelId: 'anthropic/claude-sonnet-5.5' }))
    await post(report({ turnId: 'turn_1', modelId: null }))
    await post(report({ turnId: 'turn_2', modelId: 'deepseek/deepseek-v4-pro' }))
    await post(report({ turnId: 'turn_3', modelId: 'openai/gpt-5.6-terra' }))
    expect(paramsOf(0)).toMatchObject({ model: 'claude-sonnet-5-5', provider: 'claude' })
    expect(paramsOf(1)).toMatchObject({ model: 'claude-haiku-5-5', provider: 'claude' })
    expect(paramsOf(2)).toMatchObject({ model: 'deepseek-v4-pro', provider: 'deepseek' })
    // A Gateway OpenAI helper is billed to Dial8, never read as the ChatGPT plan.
    expect(paramsOf(3)).toMatchObject({ model: 'gpt-5.6-terra', provider: 'openai' })
  })

  it('a text turn (server channel_turn, surface sms) is the person’s own turn: billed here as ai_chat to the token’s user', async () => {
    const text = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', server: 'channel_turn', surface: 'sms' })
    expect(await (await post(report(), text)).json()).toEqual({ billed: true })
    const [userId, params] = logUsageSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect([userId, params.feature]).toEqual(['user-1', 'ai_chat'])
  })

  it('a surface (device ask) token whose HMAC verifies is never billed here — current or expired', async () => {
    expect(await (await post(report(), deviceToken())).json()).toEqual({ billed: false, reason: 'surface' })
    const expiredDevice = expired(() => deviceToken())
    expect(await (await post(report(), expiredDevice)).json()).toEqual({ billed: false, reason: 'surface' })
    expect(logUsageSpy).not.toHaveBeenCalled()
    expect(serviceFrom).not.toHaveBeenCalled()
  })

  it('a FORGED surface claim (signature not ours) is not a free turn — the session owner is billed', async () => {
    const forged = unverifiable({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask', exp: Date.now() + 1e6 })
    expect(await (await post(report(), forged)).json()).toEqual({ billed: true })
    expect(logUsageSpy.mock.calls.map(([u]) => u)).toEqual(['owner-of-sess-1'])
  })

  it('an EXPIRED but validly signed token on an UNREGISTERED session → 200, billed to the token’s user (not a 409)', async () => {
    const res = await post(report({ sessionId: 'sess-never-registered' }), expired(() => browserToken()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ billed: true })
    expect(logUsageSpy.mock.calls.map(([u]) => u)).toEqual(['user-1'])
    expect(ownerLookups).toEqual([])
  })

  describe('a token past its expiry', () => {
    /** A token, and the time it expires at (exp, as signed). */
    function minted(mint: () => string): { token: string; exp: number } {
      const token = mint()
      const { exp } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { exp: number }
      return { token, exp }
    }
    afterEach(() => vi.useRealTimers())

    it('still names the payer up to the last millisecond of the grace', async () => {
      const { token, exp } = minted(browserToken)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(exp + TURN_REPORT_TOKEN_GRACE_MS - 1)
      const res = await post(report(), token)
      expect(res.status).toBe(200)
      expect(logUsageSpy.mock.calls.map(([u]) => u)).toEqual(['user-1'])
    })

    it('counts as NO token once the grace has run out: the session owner pays, never the token’s user', async () => {
      const { token, exp } = minted(browserToken)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(exp + TURN_REPORT_TOKEN_GRACE_MS)
      expect(await (await post(report(), token)).json()).toEqual({ billed: true })
      vi.setSystemTime(exp + 24 * 60 * 60 * 1000)
      expect(await (await post(report({ turnId: 'turn_1' }), token)).json()).toEqual({ billed: true })
      expect(logUsageSpy.mock.calls.map(([u]) => u)).toEqual(['owner-of-sess-1', 'owner-of-sess-1'])
      expect(ownerLookups).toEqual(['sess-1', 'sess-1'])
    })

    it('past the grace, an unregistered session is a 409 (kept for a retry), not a bill to the token’s user; a device token skips nothing', async () => {
      for (const mint of [browserToken, deviceToken]) {
        const { token, exp } = minted(mint)
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(exp + TURN_REPORT_TOKEN_GRACE_MS)
        const res = await post(report({ sessionId: 'sess-never-registered' }), token)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ code: 'SESSION_UNREGISTERED' })
        vi.useRealTimers()
      }
      expect(logUsageSpy).not.toHaveBeenCalled()
    })

    it('the outbox sweep’s path (resolveChatUsagePayer) applies the same grace', async () => {
      const { resolveChatUsagePayer } = await import('@/lib/chat/chat-usage-meter')
      const { token, exp } = minted(browserToken)
      const db = { from: serviceFrom } as never
      expect(await resolveChatUsagePayer(db, token, { sessionId: 'sess-1' }, exp + TURN_REPORT_TOKEN_GRACE_MS - 1)).toMatchObject({ kind: 'payer', payer: { userId: 'user-1', via: 'token' } })
      expect(await resolveChatUsagePayer(db, token, { sessionId: 'sess-1' }, exp + TURN_REPORT_TOKEN_GRACE_MS)).toMatchObject({ kind: 'payer', payer: { userId: 'owner-of-sess-1', via: 'session-owner' } })
      expect(await resolveChatUsagePayer(db, token, { sessionId: 'sess-never-registered' }, exp + TURN_REPORT_TOKEN_GRACE_MS)).toEqual({ kind: 'unregistered' })
    })

    it('is bounded at 30 minutes', () => {
      expect(TURN_REPORT_TOKEN_GRACE_MS).toBe(30 * 60 * 1000)
    })
  })

  it('a compaction report bills under its own key (beside the turn’s), list-priced, flagged as an estimate', async () => {
    await post(report())
    const res = await post(
      report({ inputTokens: 180000, outputTokens: 0, steps: 1, toolCalls: 0, generationIds: [], compaction: { trigger: 'manual', id: 'mevt_3' } }),
    )
    expect(await res.json()).toEqual({ billed: true })
    const params = paramsOf(1)
    expect(params).toMatchObject({ feature: 'ai_chat', inputTokens: 180000, outputTokens: 0, idempotencyKey: 'ai_chat:sess-1:turn_0:compaction:mevt_3' })
    expect(params).not.toHaveProperty('costUsd')
    expect(params.metadata).toMatchObject({
      toolCalls: 0,
      steps: 1,
      toolDiscoveries: 0,
      runtime: 'eve',
      compaction: true,
      compactionTrigger: 'manual',
      usageEstimated: true,
      outputTokensReported: false,
      usage_scope: 'eve_compaction',
      parent_run_id: 'ai_chat:sess-1:turn_0',
      usage_key: 'ai_chat:sess-1:turn_0:compaction:mevt_3',
      input_tokens_reported: false,
      output_tokens_reported: false,
      usage_unknown: true,
    })
    // A turn report carries none of the compaction keys.
    expect(paramsOf(0).metadata).not.toHaveProperty('compaction')
  })

  it('400 on a malformed compaction ref', async () => {
    for (const compaction of [{ trigger: 'x', id: 'a' }, { trigger: 'manual', id: '' }, { trigger: 'manual', id: 'bad id!' }, 'x']) {
      expect((await post(report({ compaction }))).status).toBe(400)
    }
    expect(logUsageSpy).not.toHaveBeenCalled()
  })

  it('an empty turn (no steps, no tokens) is not billed', async () => {
    const res = await post(report({ steps: 0, inputTokens: 0, outputTokens: 0 }))
    expect(await res.json()).toEqual({ billed: false, reason: 'empty' })
    expect(logUsageSpy).not.toHaveBeenCalled()
  })

  it('an invalid DOLLAR figure never voids the bill: the tokens are billed at list price', async () => {
    // A negative / non-numeric Exa total (e.g. a tool output shaped like Exa's)
    // must not 400 the report — that would drop the whole turn's token bill.
    for (const [i, over] of [
      { webSearchCostUsd: -1, costUsd: 0.01 },
      { webSearchCostUsd: 'x', costUsd: 0.01 },
      { costUsd: -0.1 },
      { costUsd: 'free' },
    ].entries()) {
      const res = await post(report({ turnId: `turn_${i}`, ...over }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ billed: true })
      const params = paramsOf(i)
      expect(params).toMatchObject({ inputTokens: 1200, outputTokens: 300, idempotencyKey: `ai_chat:sess-1:turn_${i}` })
      // eve's cost is never trusted beside an invalid Exa figure, nor when itself invalid.
      expect(params).not.toHaveProperty('costUsd')
      expect(params.metadata).not.toHaveProperty('webSearchCostUsd')
    }
  })

  it('superseded attempts of a re-run step ride metadata for reconciliation (never billed); absent → no key', async () => {
    await post(report({ supersededGenerationIds: ['gen_old', 'gen_old', '', 7] }))
    expect(paramsOf(0).metadata).toMatchObject({ generationIds: ['gen_a', 'gen_b'], supersededGenerationIds: ['gen_old'] })
    expect(paramsOf(0)).toMatchObject({ inputTokens: 1200 })
    await post(report({ turnId: 'turn_1' }))
    expect(paramsOf(1).metadata).not.toHaveProperty('supersededGenerationIds')
  })

  it('400 on a malformed report — never billed on a guess', async () => {
    for (const bad of [
      report({ sessionId: '' }),
      report({ turnId: 5 }),
      report({ outcome: 'weird' }),
      report({ inputTokens: -1 }),
      report({ outputTokens: 'lots' }),
      report({ steps: Number.NaN }),
      report({ cacheReadTokens: -5 }),
    ]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect((await POST(req({ secret: SECRET, token: browserToken(), rawBody: '{nope' }))).status).toBe(400)
    expect(logUsageSpy).not.toHaveBeenCalled()
  })
})
