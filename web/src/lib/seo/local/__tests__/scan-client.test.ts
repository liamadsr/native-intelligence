/**
 * The scan's client (../scan-client.ts): the workspace's meter in front of
 * every post, and a running total of what the provider charged, which the
 * engine records as the scan's cost (a charge on a failed post included).
 *
 * The meter and the provider client are stubs that hand back a billing.
 */
import { DataforseoChargedTaskError } from '@/lib/seo/errors'
import { describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  meterRuns: [] as Array<{ feature: string; estimateUsd: number }>,
  meters: [] as Array<{ workspaceId: string; userId: string | null }>,
  responses: [] as Array<() => Promise<{ data: unknown; billing: unknown }>>,
}))

vi.mock('@/lib/seo/spend', () => ({
  createWorkspaceMeter: (
    _svc: unknown,
    who: { workspaceId: string; userId: string | null },
  ) => {
    hoisted.meters.push(who)
    return {
      run: async (call: {
        feature: string
        estimateUsd: number
        exec: () => Promise<{ data: unknown }>
      }) => {
        hoisted.meterRuns.push({
          feature: call.feature,
          estimateUsd: call.estimateUsd,
        })
        return (await call.exec()).data
      },
    }
  },
}))
vi.mock('@/lib/seo/dataforseo', async () => {
  const errors = await import('@/lib/seo/errors')
  return {
    DataforseoChargedTaskError: errors.DataforseoChargedTaskError,
    fetchRankCheckTaskResult: vi.fn(),
    resolveGotoUrls: vi.fn(),
    createDataforseoClient: (meter: {
      run: (call: unknown) => Promise<unknown>
    }) => ({
      serp: {
        localTaskPost: () =>
          meter.run({
            feature: 'local_seo',
            estimateUsd: 0.0108,
            exec: hoisted.responses.shift(),
          }),
      },
    }),
  }
})

const { localScanClient } = await import('../scan-client')

describe('localScanClient', () => {
  it('posts through the workspace meter in the starter’s name and adds up what the provider charged', async () => {
    hoisted.responses.push(
      async () => ({
        data: ['t-1'],
        billing: { path: ['serp'], costUsd: 0.0093 },
      }),
      async () => {
        throw new DataforseoChargedTaskError('Task failed', {
          path: ['serp'],
          costUsd: 0.002,
        })
      },
    )
    const client = localScanClient({} as never, {
      workspaceId: 'ws-1',
      userId: 'user-1',
    })
    expect(client.billedUsd?.()).toBe(0)
    await client.serp.localTaskPost({} as never)
    expect(client.billedUsd?.()).toBeCloseTo(0.0093, 6)
    await expect(client.serp.localTaskPost({} as never)).rejects.toBeInstanceOf(
      DataforseoChargedTaskError,
    )
    expect(client.billedUsd?.()).toBeCloseTo(0.0113, 6)
    expect(hoisted.meters).toEqual([{ workspaceId: 'ws-1', userId: 'user-1' }])
    expect(hoisted.meterRuns).toHaveLength(2)
  })
})
