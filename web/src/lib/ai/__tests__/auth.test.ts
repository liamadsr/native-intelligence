import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/ai/auth.ts.
 *
 * This module guards every AI endpoint — if it regresses, we leak model
 * calls (and billing) to unauthenticated requests. We lock in:
 *  - JWT path: Bearer header with valid token returns the user
 *  - Cookie path: when no JWT, fall back to cookie-based session
 *  - 401 Response thrown when both paths fail
 *  - checkUsageLimits: 429 Response thrown when plan limit exceeded,
 *    silent pass-through when the RPC errors (never block on infra)
 *  - extractGatewayCost: prefers marketCost over cost, coerces strings,
 *    returns undefined when no gateway metadata
 */

const hoisted = vi.hoisted(() => ({
  jwtGetUser: vi.fn(),
  cookieGetUser: vi.fn(),
  serviceRpc: vi.fn(),
  captureException: vi.fn(),
  inngestSend: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: hoisted.captureException,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: hoisted.jwtGetUser },
  })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.cookieGetUser },
  }),
}))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    rpc: hoisted.serviceRpc,
  }),
}))

const { authenticateUser, checkUsageLimits, extractGatewayCost, logUsage, detectGatewayCredentialFallback } = await import(
  '@/lib/ai/auth'
)

beforeEach(() => {
  hoisted.jwtGetUser.mockReset()
  hoisted.cookieGetUser.mockReset()
  hoisted.serviceRpc.mockReset()
  hoisted.captureException.mockReset()
  hoisted.inngestSend.mockReset()
  delete process.env.BILLING_FAIL_OPEN
})

describe('authenticateUser', () => {
  function request(authHeader?: string): Request {
    const headers = new Headers()
    if (authHeader) headers.set('authorization', authHeader)
    return new Request('https://nativeintelligence.dev/api/ai', { headers })
  }

  it('uses JWT path when Authorization: Bearer is present and valid', async () => {
    const user = { id: 'u-jwt' }
    hoisted.jwtGetUser.mockResolvedValueOnce({ data: { user }, error: null })

    const result = await authenticateUser(request('Bearer abc123'))
    expect(result.user).toEqual(user)
    expect(hoisted.jwtGetUser).toHaveBeenCalledOnce()
    expect(hoisted.cookieGetUser).not.toHaveBeenCalled()
  })

  it('falls back to cookie path when JWT lookup returns no user', async () => {
    hoisted.jwtGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    })
    hoisted.cookieGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-cookie' } },
      error: null,
    })

    const result = await authenticateUser(request('Bearer bad'))
    expect(result.user.id).toBe('u-cookie')
  })

  it('uses cookie path directly when no Authorization header', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-cookie' } },
      error: null,
    })
    const result = await authenticateUser(request())
    expect(result.user.id).toBe('u-cookie')
    expect(hoisted.jwtGetUser).not.toHaveBeenCalled()
  })

  it('throws a 401 Response when both paths fail', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    })

    await expect(authenticateUser(request())).rejects.toMatchObject({
      status: 401,
    })
  })

  it('ignores non-Bearer Authorization values and falls to cookie', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-cookie' } },
      error: null,
    })

    const result = await authenticateUser(request('Basic abc'))
    expect(result.user.id).toBe('u-cookie')
    expect(hoisted.jwtGetUser).not.toHaveBeenCalled()
  })
})

describe('checkUsageLimits', () => {
  it('passes an optional cancellation signal to the read-only usage RPC', async () => {
    const controller = new AbortController()
    const abortSignal = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null })
    hoisted.serviceRpc.mockReturnValueOnce({ abortSignal })
    expect(await checkUsageLimits('u1', controller.signal)).toMatchObject({ allowed: true })
    expect(abortSignal).toHaveBeenCalledWith(controller.signal)
  })

  it('treats caller cancellation as cancellation rather than a billing outage or fail-open allowance', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const abortSignal = vi.fn().mockImplementation(async () => {
      controller.abort(reason)
      return { data: null, error: { message: 'request aborted' } }
    })
    hoisted.serviceRpc.mockReturnValueOnce({ abortSignal })
    process.env.BILLING_FAIL_OPEN = 'true'
    await expect(checkUsageLimits('u1', controller.signal)).rejects.toBe(reason)
    expect(hoisted.captureException).not.toHaveBeenCalled()
  })

  it('runs a free ChatGPT user on their plan only when the caller opts in', async () => {
    hoisted.serviceRpc.mockResolvedValue({ data: [{ allowed: true }], error: null })
    await checkUsageLimits('u1')
    expect(hoisted.serviceRpc).toHaveBeenLastCalledWith('check_ai_usage_limit', { p_user_id: 'u1' })
    await checkUsageLimits('u1', undefined, { chatgptPlan: true })
    expect(hoisted.serviceRpc).toHaveBeenLastCalledWith('check_ai_usage_limit', {
      p_user_id: 'u1',
      p_chatgpt_plan: true,
    })
  })

  it('returns the plan row when the RPC returns allowed=true (for tier-aware callers)', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({
      data: [{ allowed: true, is_paid_plan: true, plan_name: 'subscriber' }],
      error: null,
    })
    const row = await checkUsageLimits('u1')
    expect(row?.allowed).toBe(true)
    expect(row?.is_paid_plan).toBe(true)
  })

  it('throws a 429 Response when the RPC returns allowed=false', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({
      data: [
        {
          allowed: false,
          reason: 'limit_reached',
          plan_name: 'free',
          is_paid_plan: false,
          usage_reset_date: '2026-05-01',
        },
      ],
      error: null,
    })

    const error = await checkUsageLimits('u1').catch((e) => e)
    expect(error).toBeInstanceOf(Response)
    expect(error.status).toBe(429)
    const body = await error.json()
    expect(body.error).toBe('Usage limit exceeded')
    expect(body.reason).toBe('limit_reached')
    expect(body.plan).toBe('free')
  })

  it('fails CLOSED with a 503 when the RPC itself errors (no free AI on infra failure)', async () => {
    // A billing outage must NOT hand out unlimited AI — block, and alert.
    hoisted.serviceRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = await checkUsageLimits('u1').catch((e) => e)
    expect(error).toBeInstanceOf(Response)
    expect(error.status).toBe(503)
    const body = await error.json()
    expect(body.code).toBe('BILLING_UNAVAILABLE')
    expect(hoisted.captureException).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('allows through on RPC error only when BILLING_FAIL_OPEN=true (incident escape hatch)', async () => {
    process.env.BILLING_FAIL_OPEN = 'true'
    hoisted.serviceRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(checkUsageLimits('u1')).resolves.toBeUndefined()
    // Still alerts even when failing open.
    expect(hoisted.captureException).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})

describe('logUsage', () => {
  const params = {
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
    feature: 'ai_chat',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1200,
    costUsd: 0.01,
  }

  it('calls log_ai_usage and does not enqueue a retry on success', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({ data: [{ log_id: 'l1', cost_usd: 0.01 }], error: null })
    await logUsage('u1', params)
    expect(hoisted.serviceRpc).toHaveBeenCalledWith('log_ai_usage', expect.objectContaining({
      p_user_id: 'u1',
      p_provider: 'claude',
      p_cost_usd: 0.01,
    }))
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    expect(hoisted.captureException).not.toHaveBeenCalled()
  })

  it("logs a step on the person's ChatGPT plan at no cost, whatever cost it carries", async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({ data: [{ log_id: 'l2', cost_usd: 0 }], error: null })
    await logUsage('u1', { ...params, provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna', metadata: { kind: 'generate_title' } })
    expect(hoisted.serviceRpc).toHaveBeenCalledWith('log_ai_usage', expect.objectContaining({
      p_provider: 'chatgpt-plan',
      p_cost_usd: 0,
      p_metadata: { kind: 'generate_title', billed_to: 'chatgpt_plan' },
    }))
  })

  it('enqueues a durable Inngest retry + alerts when the RPC fails', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    hoisted.inngestSend.mockResolvedValueOnce(undefined)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await logUsage('u1', params)
    expect(hoisted.captureException).toHaveBeenCalledOnce()
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'billing/usage-log-failed',
      data: { userId: 'u1', params },
    })
    spy.mockRestore()
  })

  it('captures a second alert if even the retry-enqueue fails, and reports the spend as LOST', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(logUsage('u1', params)).resolves.toBe('lost')
    // one for the RPC failure, one for the enqueue failure
    expect(hoisted.captureException).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('returns the outcome: logged on success, retry-enqueued when the durable retry was queued', async () => {
    hoisted.serviceRpc.mockResolvedValueOnce({ data: [{ log_id: 'l1' }], error: null })
    await expect(logUsage('u1', params)).resolves.toBe('logged')
    hoisted.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    hoisted.inngestSend.mockResolvedValueOnce(undefined)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(logUsage('u1', params)).resolves.toBe('retry-enqueued')
    spy.mockRestore()
  })

  describe('with an idempotencyKey (log_ai_usage_once, migration 278)', () => {
    const keyed = { ...params, idempotencyKey: 'ai_chat:sess-1:turn_0' }

    it('calls the keyed RPC with the key + the same args; a fresh key is logged', async () => {
      hoisted.serviceRpc.mockResolvedValueOnce({ data: [{ log_id: 'l1', duplicate: false }], error: null })
      await expect(logUsage('u1', keyed)).resolves.toBe('logged')
      expect(hoisted.serviceRpc).toHaveBeenCalledTimes(1)
      expect(hoisted.serviceRpc).toHaveBeenCalledWith('log_ai_usage_once', expect.objectContaining({
        p_idempotency_key: 'ai_chat:sess-1:turn_0',
        p_user_id: 'u1',
        p_feature: 'ai_chat',
        p_cost_usd: 0.01,
        p_edge_function: 'next-api',
      }))
    })

    it('an already-claimed key is a duplicate: nothing more is written, no retry, no alert', async () => {
      hoisted.serviceRpc.mockResolvedValueOnce({ data: [{ log_id: null, duplicate: true }], error: null })
      await expect(logUsage('u1', keyed)).resolves.toBe('duplicate')
      expect(hoisted.serviceRpc).toHaveBeenCalledTimes(1)
      expect(hoisted.inngestSend).not.toHaveBeenCalled()
      expect(hoisted.captureException).not.toHaveBeenCalled()
    })

    it('a failed keyed RPC queues the durable retry WITH the key (the retry dedupes on it)', async () => {
      hoisted.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down', code: '57014' } })
      hoisted.inngestSend.mockResolvedValueOnce(undefined)
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(logUsage('u1', keyed)).resolves.toBe('retry-enqueued')
      expect(hoisted.inngestSend).toHaveBeenCalledWith({ name: 'billing/usage-log-failed', data: { userId: 'u1', params: keyed } })
      expect(hoisted.serviceRpc).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it.each([
      ['PGRST202', 'PostgREST: not in the schema cache'],
      ['42883', 'Postgres: function does not exist'],
    ])('if the keyed RPC does not exist yet (%s — %s) it bills via plain log_ai_usage and alerts', async (code) => {
      hoisted.serviceRpc
        .mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function', code } })
        .mockResolvedValueOnce({ data: [{ log_id: 'l1' }], error: null })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(logUsage('u1', keyed)).resolves.toBe('logged')
      expect(hoisted.serviceRpc.mock.calls.map(([fn]) => fn)).toEqual(['log_ai_usage_once', 'log_ai_usage'])
      expect(hoisted.serviceRpc.mock.calls[1][1]).not.toHaveProperty('p_idempotency_key')
      expect(hoisted.captureException).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('any OTHER keyed-RPC error is NOT a missing function: no unkeyed fallback (that would bill without the claim)', async () => {
      hoisted.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'deadlock detected', code: '40P01' } })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await logUsage('u1', keyed)
      expect(hoisted.serviceRpc.mock.calls.map(([fn]) => fn)).toEqual(['log_ai_usage_once'])
      spy.mockRestore()
    })
  })
})

describe('extractGatewayCost', () => {
  it('returns undefined when no providerMetadata', () => {
    expect(extractGatewayCost({})).toBeUndefined()
  })

  it('returns undefined when providerMetadata has no gateway key', () => {
    expect(
      extractGatewayCost({ providerMetadata: { anthropic: {} } }),
    ).toBeUndefined()
  })

  it('prefers marketCost over cost (the BYOK/list-price distinction)', () => {
    const n = extractGatewayCost({
      providerMetadata: { gateway: { marketCost: '0.042', cost: '0' } },
    })
    expect(n).toBe(0.042)
  })

  it('coerces string values to number (gateway returns strings)', () => {
    const n = extractGatewayCost({
      providerMetadata: { gateway: { marketCost: '1.5' } },
    })
    expect(n).toBe(1.5)
  })

  it('falls back to cost when marketCost is missing', () => {
    const n = extractGatewayCost({
      providerMetadata: { gateway: { cost: '0.01' } },
    })
    expect(n).toBe(0.01)
  })

  it('returns undefined on non-finite inputs', () => {
    expect(
      extractGatewayCost({
        providerMetadata: { gateway: { marketCost: 'not a number' } },
      }),
    ).toBeUndefined()
  })

  it('returns undefined when marketCost/cost are both null', () => {
    expect(
      extractGatewayCost({
        providerMetadata: { gateway: { marketCost: null, cost: null } },
      }),
    ).toBeUndefined()
  })
})

describe('detectGatewayCredentialFallback (BYOK → system-credential fallback)', () => {
  const trace = (providerAttempts: unknown[]) => ({
    routing: { modelAttempts: [{ canonicalSlug: 'anthropic/claude-haiku-4.5', providerAttempts }] },
  })

  it('returns null when the request ran on the BYOK credential', () => {
    expect(
      detectGatewayCredentialFallback(
        trace([{ provider: 'anthropic', credentialType: 'byok', success: true }]),
      ),
    ).toBeNull()
  })

  it('returns null when there is no BYOK credential at all (system only)', () => {
    expect(
      detectGatewayCredentialFallback(
        trace([{ provider: 'fireworks', credentialType: 'system', success: true }]),
      ),
    ).toBeNull()
  })

  it('reports the provider + BYOK error when BYOK failed and system succeeded', () => {
    // Verbatim shape from a live probe on 2026-09-02 — the outage this guards.
    expect(
      detectGatewayCredentialFallback(
        trace([
          {
            provider: 'anthropic',
            credentialType: 'byok',
            success: false,
            error: 'Your credit balance is too low to access the Anthropic API.',
            statusCode: 400,
          },
          { provider: 'claudeaws', credentialType: 'system', success: true, statusCode: 200 },
        ]),
      ),
    ).toEqual({
      provider: 'claudeaws',
      byokError: 'Your credit balance is too low to access the Anthropic API.',
    })
  })

  it('never throws on a missing or malformed routing trace', () => {
    expect(detectGatewayCredentialFallback(undefined)).toBeNull()
    expect(detectGatewayCredentialFallback({})).toBeNull()
    expect(detectGatewayCredentialFallback({ routing: null })).toBeNull()
    expect(detectGatewayCredentialFallback({ routing: { modelAttempts: 'nope' } })).toBeNull()
    expect(
      detectGatewayCredentialFallback({ routing: { modelAttempts: [{ providerAttempts: [null, 1] }] } }),
    ).toBeNull()
  })
})
