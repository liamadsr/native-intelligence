/**
 * The cloud browser idle stop (src/app/api/cron/cloud-browser-idle/route.ts):
 * the cron secret is required before anything runs, it sweeps once and reports,
 * a failed sweep is a 500, and vercel.json is what makes it run at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  sweep: vi.fn(async () => ({ stopped: 2, skipped: 0, failed: 0, reasons: { idle: 2 } })),
  denied: null as Response | null,
}))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => hoisted.denied }))
vi.mock('@/lib/cloud-browser/host', () => ({ sweepIdleCloudBrowsers: hoisted.sweep }))

const { GET } = await import('../route')
const request = () => new NextRequest('http://localhost/api/cron/cloud-browser-idle')

beforeEach(() => {
  hoisted.sweep.mockClear()
  hoisted.denied = null
})

describe('GET /api/cron/cloud-browser-idle', () => {
  it('sweeps once and reports what it stopped', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stopped: 2, skipped: 0, failed: 0, reasons: { idle: 2 } })
    expect(hoisted.sweep).toHaveBeenCalledTimes(1)
  })

  it('refuses without the cron secret, and stops nothing', async () => {
    hoisted.denied = new Response('no', { status: 401 })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.sweep).not.toHaveBeenCalled()
  })

  it('a failed sweep is a 500', async () => {
    hoisted.sweep.mockRejectedValueOnce(new Error('db down'))
    const res = await GET(request())
    expect(res.status).toBe(500)
  })

  it('runs every 5 minutes from vercel.json (its only scheduler)', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    expect(vercel.crons.find(c => c.path === '/api/cron/cloud-browser-idle')?.schedule).toBe('*/5 * * * *')
  })
})
