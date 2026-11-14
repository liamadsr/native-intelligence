/**
 * GET /api/cron/email-scheduled-send: send later's 5-minute sweep, behind
 * the cron secret (the sweep itself: src/lib/email/__tests__/scheduled-send.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ sent: 2, failed: 1, skipped: 0, stale: 0 })) }))
vi.mock('@/lib/email/scheduled-send', () => ({ sweepScheduledSends: h.sweep }))

import { GET } from '../route'

const req = (bearer?: string) =>
  new NextRequest('http://localhost/api/cron/email-scheduled-send', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'test-secret')
  h.sweep.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/cron/email-scheduled-send', () => {
  it('refuses a call without the cron secret, and sends nothing', async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('wrong'))).status).toBe(401)
    expect(h.sweep).not.toHaveBeenCalled()
  })

  it('sweeps the due rows and says what it did', async () => {
    const res = await GET(req('test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sent: 2, failed: 1, skipped: 0, stale: 0 })
  })

  it('a sweep that cannot read is a 500', async () => {
    h.sweep.mockRejectedValueOnce(new Error('scheduled sends unreadable: down'))
    expect((await GET(req('test-secret'))).status).toBe(500)
  })

  it('is scheduled every 5 minutes, in vercel.json and the server’s crontab alike', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> }
    expect(vercel.crons).toContainEqual({ path: '/api/cron/email-scheduled-send', schedule: '*/5 * * * *' })
    const crontab = readFileSync(join(process.cwd(), '../deploy/app/cron/crontab'), 'utf8')
    expect(crontab).toContain('*/5 * * * * node /app/deploy/app/cron/call.mjs /api/cron/email-scheduled-send')
  })
})
