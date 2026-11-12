/**
 * The hourly Studio sweep's route (../route.ts): the cron secret first, one sweep a call with its counts, a failure
 * a 500 with a sentence (the database's words are logged, never answered), and the schedule in vercel.json, the
 * only thing that makes it run (the server's crontab is generated from it).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  denied: null as Response | null,
  sweep: vi.fn(async (_supabase: unknown) => ({ pendingWrites: 1, uploads: 2, stills: 0, exports: 0, jobs: 3 })),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => hoisted.denied }))
vi.mock('@/lib/studio/server/sweep', () => ({ sweepStudio: hoisted.sweep }))

const { GET } = await import('../route')
const request = () => new NextRequest('http://localhost/api/cron/studio-sweep')

beforeEach(() => {
  hoisted.denied = null
  hoisted.sweep.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('GET /api/cron/studio-sweep', () => {
  it('wants the cron secret', async () => {
    hoisted.denied = new Response('no', { status: 401 })
    expect((await GET(request())).status).toBe(401)
    expect(hoisted.sweep).not.toHaveBeenCalled()
  })

  it('answers 200 skipped, with no error logged, where the Studio is not set up on this server', async () => {
    const { notSetUpError } = await import('@/lib/studio/server/errors')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    hoisted.sweep.mockRejectedValueOnce(notSetUpError())
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: 'not set up' })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('sweeps once and answers what it removed', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removed: { pendingWrites: 1, uploads: 2, stills: 0, exports: 0, jobs: 3 } })
    expect(hoisted.sweep).toHaveBeenCalledTimes(1)
  })

  it('answers a failure as a 500 with a sentence', async () => {
    hoisted.sweep.mockRejectedValueOnce(new Error('permission denied for table studio_blob'))
    const res = await GET(request())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('permission denied')
  })

  it('runs hourly from vercel.json', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    expect(vercel.crons.find((c) => c.path === '/api/cron/studio-sweep')?.schedule).toBe('15 * * * *')
  })
})
