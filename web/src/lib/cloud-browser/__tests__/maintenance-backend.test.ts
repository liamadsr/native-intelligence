/**
 * An unknown CLOUD_BROWSER_BACKEND (host.ts maintenanceBackend): the idle
 * sweep and the reconcile log it once per run and go on as `hosted`, so hosted
 * browsers are still stopped before their cap; an ensure still refuses it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hosted = vi.hoisted(() => ({ gets: [] as string[] }))
vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    get: vi.fn(async ({ name }: { name: string }) => { hosted.gets.push(name); throw Object.assign(new Error('missing'), { response: { status: 404 } }) }),
    list: vi.fn(async () => ({ toArray: async () => [] })),
  },
  Snapshot: {},
}))
vi.mock('@/lib/cloud-browser/runtime-client', () => ({ loadRuntimeBrowserClient: () => { throw new Error('never the runtime here') } }))
const store = vi.hoisted(() => ({
  listStopCandidates: vi.fn(async () => [{ user_id: 'u1', workspace_id: 'w1', reason: 'idle' }] as unknown[]),
  markStopping: vi.fn(async () => true),
  markStopped: vi.fn(async () => {}),
  sandboxNamesWithRows: vi.fn(async () => new Set<string>()),
  readStatus: vi.fn(async () => null),
  markStarting: vi.fn(async () => {}),
}))
vi.mock('@/lib/cloud-browser/store', () => store)
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async () => {} }))

const host = await import('@/lib/cloud-browser/host')

beforeEach(() => {
  vi.clearAllMocks()
  hosted.gets = []
  vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtme')
})

describe('an unknown CLOUD_BROWSER_BACKEND', () => {
  it('the sweep logs it once and stops as hosted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await host.sweepIdleCloudBrowsers()).toMatchObject({ stopped: 1, failed: 0 })
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/sweep: .*CLOUD_BROWSER_BACKEND.*going on as hosted/)
    expect(hosted.gets).toHaveLength(1)
    expect(store.markStopped).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'idle')
  })

  it('the reconcile logs it once and reconciles as hosted (no expiry, no runtime)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await host.reconcileCloudBrowsers()).toEqual({ orphans: 0, snapshotsDeleted: 0 })
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('an ensure still refuses it, before touching the row', async () => {
    await expect(host.ensureCloudBrowser({ userId: 'u1', workspaceId: 'w1' })).rejects.toThrow(/CLOUD_BROWSER_BACKEND must be/)
    expect(store.markStarting).not.toHaveBeenCalled()
  })
})
