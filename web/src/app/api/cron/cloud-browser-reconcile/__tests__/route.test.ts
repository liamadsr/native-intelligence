/**
 * The daily cloud browser reconcile (src/app/api/cron/cloud-browser-reconcile/route.ts):
 * the cron secret is required before anything runs, it reconciles once and
 * reports, a failure is a 500, and vercel.json is what makes it run at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  reconcile: vi.fn(async () => ({ orphans: 1, snapshotsDeleted: 2 })),
  denied: null as Response | null,
}))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => hoisted.denied }))
vi.mock('@/lib/cloud-browser/host', () => ({ reconcileCloudBrowsers: hoisted.reconcile }))

const { GET } = await import('../route')
const request = () => new NextRequest('http://localhost/api/cron/cloud-browser-reconcile')

beforeEach(() => {
  hoisted.reconcile.mockClear()
  hoisted.denied = null
})

describe('GET /api/cron/cloud-browser-reconcile', () => {
  it('reconciles once and reports what it deleted', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, orphans: 1, snapshotsDeleted: 2 })
    expect(hoisted.reconcile).toHaveBeenCalledTimes(1)
  })

  it('refuses without the cron secret, and deletes nothing', async () => {
    hoisted.denied = new Response('no', { status: 401 })
    expect((await GET(request())).status).toBe(401)
    expect(hoisted.reconcile).not.toHaveBeenCalled()
  })

  it('a failed reconcile is a 500', async () => {
    hoisted.reconcile.mockRejectedValueOnce(new Error('api down'))
    expect((await GET(request())).status).toBe(500)
  })

  it('runs daily from vercel.json (its only scheduler)', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    expect(vercel.crons.find(c => c.path === '/api/cron/cloud-browser-reconcile')?.schedule).toBe('40 3 * * *')
  })
})
