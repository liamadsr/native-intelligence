/**
 * Tests for GET /api/cron/billing-reconciliation.
 *
 * Focus of this suite: the per-model GATEWAY COST DRIFT check (section 4). The
 * pre-existing wallet/fallback/overspend checks are stubbed to empty so the
 * drift math is isolated. Invariants locked in:
 *  - Cron auth gate: a bad/missing bearer is 401 and never queries the gateway.
 *  - Drift is per model, matched on the BARE model id (a provider-qualified
 *    gateway slug like 'moonshotai/kimi-k2.6' reconciles against the bare
 *    'kimi-k2.6' our logs store).
 *  - An alert fires only when BOTH the ratio (>10%) AND the absolute gap (>$0.50)
 *    are exceeded; a small gap or a small ratio is reported but not alerted.
 *  - Only models present in the gateway report are compared (Deepgram etc. are
 *    excluded by the join).
 *  - A gateway report failure degrades gracefully: the cron still succeeds and
 *    surfaces gateway_drift_error, and the other checks are unaffected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Gateway report seam (the thing we drive per test) ────────────────────────
const hoisted = vi.hoisted(() => ({
  getGatewayUsageReport: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  captureMessage: vi.fn(),
}))
vi.mock('@/lib/ai/gateway-report', () => ({
  getGatewayUsageReport: (...a: unknown[]) => hoisted.getGatewayUsageReport(...a),
  // Re-export the type-only symbol as a harmless value so the route's
  // `import { ..., type GatewayReportRow }` resolves at runtime.
  GatewayReportError: class GatewayReportError extends Error {},
}))
vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => hoisted.captureMessage(...a),
}))

// ── Supabase fake ────────────────────────────────────────────────────────────
// The route issues, in order:
//   rpc('billing_wallet_drift')                                  → { data: [] }
//   from('ai_usage_logs').select('id',{count,head}).eq().gte()   → { count }
//   rpc('billing_overspenders')                                  → { data: [] }
//   from('ai_usage_logs').select('model, estimated_cost_usd').gte() → { data: rows }
// We distinguish the two ai_usage_logs queries by the select() argument.
let usageRows: Array<{ model: string; estimated_cost_usd: number }> = []
let fallbackCount = 0

function makeSupabase() {
  return {
    rpc: async (_name: string) => ({ data: [] }),
    from: (_table: string) => {
      let isModelSelect = false
      let range: [number, number] | null = null
      const chain: Record<string, unknown> = {
        select: (cols: string, _opts?: unknown) => {
          isModelSelect = cols.includes('estimated_cost_usd')
          return chain
        },
        eq: () => chain,
        // The count query is awaited after .gte(); the model query too. Make the
        // chain a thenable that resolves to the right shape.
        gte: () => chain,
        order: () => chain,
        // The model query pages; honour the range like PostgREST does.
        range: (from: number, to: number) => {
          range = [from, to]
          return chain
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            isModelSelect
              ? { data: range ? usageRows.slice(range[0], range[1] + 1) : usageRows }
              : { count: fallbackCount },
          ),
      }
      return chain
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeSupabase(),
}))

const { GET } = await import('@/app/api/cron/billing-reconciliation/route')

function req(bearer?: string): Request {
  const headers: Record<string, string> = {}
  if (bearer !== undefined) headers.authorization = bearer
  return new Request('https://dial8.ai/api/cron/billing-reconciliation', {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  hoisted.getGatewayUsageReport.mockReset().mockResolvedValue([])
  hoisted.captureMessage.mockReset()
  usageRows = []
  fallbackCount = 0
  process.env.CRON_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/cron/billing-reconciliation — auth gate', () => {
  it('returns 401 on a missing bearer and never queries the gateway', async () => {
    const res = await GET(req() as never)
    expect(res.status).toBe(401)
    expect(hoisted.getGatewayUsageReport).not.toHaveBeenCalled()
  })

  it('returns 401 on a wrong bearer', async () => {
    const res = await GET(req('Bearer nope') as never)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/cron/billing-reconciliation — gateway cost drift', () => {
  it('flags a model whose local cost is far below the gateway market cost', async () => {
    // Gateway reports a provider-qualified slug; our logs store the bare id.
    hoisted.getGatewayUsageReport.mockResolvedValue([
      { model: 'moonshotai/kimi-k2.6', market_cost: 10, total_cost: 10 },
    ])
    usageRows = [
      { model: 'kimi-k2.6', estimated_cost_usd: 1 }, // 90% below → alert
    ]

    const res = await GET(req('Bearer test-secret') as never)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.gatewayDrift).toHaveLength(1)
    const d = body.gatewayDrift[0]
    expect(d.model).toBe('kimi-k2.6')
    expect(d.ours_usd).toBe(1)
    expect(d.gateway_market_usd).toBe(10)
    expect(d.alerted).toBe(true)
    expect(body.gateway_drift_alerted).toBe(1)

    // A warning-level Sentry message with per-model numbers in `extra`.
    const driftAlert = hoisted.captureMessage.mock.calls.find((c) =>
      String(c[0]).includes('gateway cost drift'),
    )
    expect(driftAlert).toBeDefined()
    expect(driftAlert?.[1]).toMatchObject({ level: 'warning' })
    expect((driftAlert?.[1] as { extra: Record<string, unknown> }).extra).toMatchObject({
      model: 'kimi-k2.6',
      ours_usd: 1,
      gateway_market_usd: 10,
    })
  })

  it('does NOT alert when the ratio is high but the absolute gap is under $0.50', async () => {
    hoisted.getGatewayUsageReport.mockResolvedValue([
      { model: 'deepseek-v4-flash', market_cost: 0.4, total_cost: 0.4 },
    ])
    usageRows = [{ model: 'deepseek-v4-flash', estimated_cost_usd: 0.1 }] // 75% but only $0.30 gap

    const res = await GET(req('Bearer test-secret') as never)
    const body = await res.json()
    expect(body.gatewayDrift).toHaveLength(1)
    expect(body.gatewayDrift[0].alerted).toBe(false)
    expect(body.gateway_drift_alerted).toBe(0)
    expect(
      hoisted.captureMessage.mock.calls.some((c) => String(c[0]).includes('gateway cost drift')),
    ).toBe(false)
  })

  it('sums usage rows past the 1000-row page (no false drift)', async () => {
    hoisted.getGatewayUsageReport.mockResolvedValue([
      { model: 'kimi-k3', market_cost: 25, total_cost: 25 },
    ])
    usageRows = Array.from({ length: 2500 }, () => ({ model: 'kimi-k3', estimated_cost_usd: 0.01 }))

    const res = await GET(req('Bearer test-secret') as never)
    const body = await res.json()
    expect(body.gatewayDrift[0].ours_usd).toBeCloseTo(25)
    expect(body.gatewayDrift[0].alerted).toBe(false)
  })

  it('does NOT alert when the two sides agree within 10%', async () => {
    hoisted.getGatewayUsageReport.mockResolvedValue([
      { model: 'kimi-k3', market_cost: 100, total_cost: 100 },
    ])
    usageRows = [{ model: 'kimi-k3', estimated_cost_usd: 95 }] // 5% gap, $5 abs → ratio fails

    const res = await GET(req('Bearer test-secret') as never)
    const body = await res.json()
    expect(body.gatewayDrift[0].alerted).toBe(false)
    expect(body.gateway_drift_alerted).toBe(0)
  })

  it('compares only models present in the gateway report (excludes Deepgram etc.)', async () => {
    hoisted.getGatewayUsageReport.mockResolvedValue([
      { model: 'kimi-k2.6', market_cost: 10, total_cost: 10 },
    ])
    usageRows = [
      { model: 'kimi-k2.6', estimated_cost_usd: 9.5 }, // in report → compared
      { model: 'nova-2', estimated_cost_usd: 999 }, // deepgram, not in report → ignored
    ]

    const res = await GET(req('Bearer test-secret') as never)
    const body = await res.json()
    expect(body.gatewayDrift).toHaveLength(1)
    expect(body.gatewayDrift[0].model).toBe('kimi-k2.6')
    expect(body.gatewayDrift[0].ours_usd).toBe(9.5)
  })

  it('degrades gracefully when the gateway report throws', async () => {
    hoisted.getGatewayUsageReport.mockRejectedValue(new Error('AI_GATEWAY_API_KEY is not set'))

    const res = await GET(req('Bearer test-secret') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.gatewayDrift).toEqual([])
    expect(body.gateway_drift_error).toContain('AI_GATEWAY_API_KEY')
  })

  it('returns an empty drift array when the gateway report has no rows', async () => {
    hoisted.getGatewayUsageReport.mockResolvedValue([])
    usageRows = [{ model: 'kimi-k2.6', estimated_cost_usd: 5 }]

    const res = await GET(req('Bearer test-secret') as never)
    const body = await res.json()
    expect(body.gatewayDrift).toEqual([])
  })
})
