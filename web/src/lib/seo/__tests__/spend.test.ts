/**
 * The workspace's search data ceiling (../spend.ts): a call is let through
 * on its estimate, written down at the provider's real cost, refused past
 * the ceiling, and never made when the ledger can't be read.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DataforseoChargedTaskError, SeoError } from '../errors'
import { SeoInputError } from '../input-error'
import { createWorkspaceMeter, monthStart, nextMonthStart, readMonthlySeoSpend, SEO_MONTHLY_CAP_DOLLARS, seoSpendSummary } from '../spend'
import { seoErrorMessage } from '../http'
import { createDataforseoClient } from '../dataforseo/client'
import { setupDataforseoTestEnv } from '../dataforseo/__tests__/test-support'

const WS = '0b0f6e0e-3f0a-4a52-9d2b-1f6f0f3f7a01'
const USER = '4d2c7b1a-9a53-4e0f-8f3e-2a6f1c9b7d02'
const NOW = new Date('2026-11-12T08:30:00.000Z')

function ledger(spent: number | { error: string }) {
  const inserts: Array<Record<string, unknown>> = []
  const rpc = vi.fn(async () => (typeof spent === 'number' ? { data: spent, error: null } : { data: null, error: { message: spent.error } }))
  const insertError = { current: null as { message: string } | null }
  const svc = {
    rpc,
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row)
        return { error: insertError.current }
      },
    }),
  } as unknown as SupabaseClient
  return { svc, rpc, inserts, insertError }
}

const paid = <T>(data: T, costUsd: number, path = ['v3', 'dataforseo_labs', 'google', 'keyword_ideas', 'live']) => ({ data, billing: { path, costUsd } })

describe('the month', () => {
  it('starts and ends on the first of the month, UTC', () => {
    expect(monthStart(NOW).toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(nextMonthStart(NOW).toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(nextMonthStart(new Date('2026-12-31T23:59:59.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('reads the spend since the month began, for this workspace', async () => {
    const { svc, rpc } = ledger(3.4)
    expect(await readMonthlySeoSpend(svc, WS, NOW)).toBe(3.4)
    expect(rpc).toHaveBeenCalledWith('seo_spend_since', { p_workspace: WS, p_since: '2026-11-01T00:00:00.000Z' })
    expect(await seoSpendSummary(svc, WS, NOW)).toEqual({ spent_dollars: 3.4, cap_dollars: SEO_MONTHLY_CAP_DOLLARS, resets_at: '2026-12-01T00:00:00.000Z' })
  })

  it('a ledger that answers with something that is no number is a failed read', async () => {
    const { svc } = ledger(Number.NaN)
    await expect(readMonthlySeoSpend(svc, WS, NOW)).rejects.toThrow(/spend read failed/)
  })
})

describe('the meter', () => {
  it('lets a call through on its estimate and writes down what the provider really charged', async () => {
    const { svc, inserts } = ledger(1.25)
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    const exec = vi.fn(async () => paid({ rows: 3 }, 0.0312))
    expect(await meter.run({ feature: 'keywords', estimateUsd: 0.05, exec })).toEqual({ rows: 3 })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(inserts).toEqual([
      { workspace_id: WS, user_id: USER, feature: 'keywords', endpoint: 'v3/dataforseo_labs/google/keyword_ideas/live', cost_usd: 0.0312, estimate_usd: 0.05 },
    ])
  })

  it('refuses a call whose estimate would pass the ceiling, without making it', async () => {
    const { svc, inserts } = ledger(19.98)
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    const exec = vi.fn()
    const refusal = await meter.run({ feature: 'serp', estimateUsd: 0.05, exec }).catch((err: unknown) => err)
    expect(exec).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
    expect(seoErrorMessage(refusal)).toEqual({
      code: 'SPEND_LIMIT_REACHED',
      message: 'This workspace has reached its search data limit for the month ($20). It starts over on 2026-12-01.',
    })
  })

  it('a call that exactly reaches the ceiling is still let through', async () => {
    const { svc } = ledger(19.95)
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    const exec = vi.fn(async () => paid('ok', 0.04))
    expect(await meter.run({ feature: 'serp', estimateUsd: 0.05, exec })).toBe('ok')
  })

  it('never spends blind: a ledger that can’t be read refuses the call', async () => {
    const { svc, inserts } = ledger({ error: 'connection refused' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    const exec = vi.fn()
    const refusal = await meter.run({ feature: 'keywords', estimateUsd: 0.01, exec }).catch((err: unknown) => err)
    expect(exec).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
    // The person reads a plain sentence, never the database's words.
    expect(seoErrorMessage(refusal)).toEqual({ code: 'INTERNAL_ERROR', message: 'Could not look that up just now.' })
  })

  it('a call that failed after the provider billed it is still written down, then rethrown', async () => {
    const { svc, inserts } = ledger(0)
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: null }, { now: () => NOW })
    const charged = new DataforseoChargedTaskError('task failed', { path: ['v3', 'serp', 'google', 'organic', 'task_post'], costUsd: 0.0006 })
    await expect(meter.run({ feature: 'rank_tracking', estimateUsd: 0.001, exec: async () => Promise.reject(charged) })).rejects.toBe(charged)
    expect(inserts).toEqual([{ workspace_id: WS, user_id: null, feature: 'rank_tracking', endpoint: 'v3/serp/google/organic/task_post', cost_usd: 0.0006, estimate_usd: 0.001 }])
  })

  it('a call that failed without being billed writes nothing', async () => {
    const { svc, inserts } = ledger(0)
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    await expect(meter.run({ feature: 'domain', estimateUsd: 0.02, exec: async () => Promise.reject(new Error('socket hang up')) })).rejects.toThrow('socket hang up')
    expect(inserts).toEqual([])
  })

  it('a ledger write that fails does not take away a result the workspace paid for', async () => {
    const { svc, insertError } = ledger(0)
    insertError.current = { message: 'disk full' }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const meter = createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW })
    expect(await meter.run({ feature: 'backlinks', estimateUsd: 0.03, exec: async () => paid([1, 2], 0.024) })).toEqual([1, 2])
    expect(logged).toHaveBeenCalled()
  })

  it('a request we refused ourselves keeps the words we wrote for the person', () => {
    expect(seoErrorMessage(new SeoInputError('Wildcard search isn’t available for this country.'))).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Wildcard search isn’t available for this country.',
    })
    // The provider's own rejection of a field does not: its detail is for the logs.
    expect(seoErrorMessage(new SeoError('VALIDATION_ERROR', 'Invalid Field: location_code'))).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'That lookup isn’t valid. Check the keyword, site or location.',
    })
  })

  it('provider detail never reaches the person', () => {
    expect(seoErrorMessage(new Error('ECONNRESET at api.dataforseo.com'))).toEqual({ code: 'INTERNAL_ERROR', message: 'Could not look that up just now.' })
  })
})

describe('the meter over the provider client', () => {
  setupDataforseoTestEnv()

  const summaryPath = ['v3', 'backlinks', 'summary', 'live']
  const answer = (cost: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          status_code: 20000,
          // A charged task whose result the provider reshaped: rank is now text.
          tasks: [{ status_code: 20000, path: summaryPath, cost, result: [{ target: 'shop.example', rank: 'high' }] }],
        }),
      ),
    )

  it('writes the ledger row for a charged call whose result failed our parsing, and the person still sees an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    answer(0.02)
    const { svc, inserts } = ledger(0)
    const client = createDataforseoClient(createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW }))
    const failure = await client.backlinks.summary({ target: 'shop.example' }).catch((err: unknown) => err)
    expect(seoErrorMessage(failure)).toEqual({ code: 'INTERNAL_ERROR', message: 'Could not look that up just now.' })
    expect(inserts).toEqual([
      expect.objectContaining({ workspace_id: WS, user_id: USER, feature: 'backlinks', endpoint: 'v3/backlinks/summary/live', cost_usd: 0.02 }),
    ])
  })

  it('writes nothing when the provider did not charge the failed call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    answer(0)
    const { svc, inserts } = ledger(0)
    const client = createDataforseoClient(createWorkspaceMeter(svc, { workspaceId: WS, userId: USER }, { now: () => NOW }))
    await expect(client.backlinks.summary({ target: 'shop.example' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(inserts).toEqual([])
  })
})
