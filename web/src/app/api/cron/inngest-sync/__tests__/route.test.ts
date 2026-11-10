/**
 * Tests for GET /api/cron/inngest-sync — the Inngest registry self-sync.
 *
 * Invariants locked in:
 *  - Fail-closed auth (503 without a provisioned CRON_SECRET, 401 on a bad
 *    bearer) — the wiki-maintenance/triage-reconciler pattern.
 *  - The PUT targets the CANONICAL production host (VERCEL_PROJECT_PRODUCTION_URL,
 *    nativeintelligence.dev fallback), never a deployment-specific URL — Inngest records the
 *    host the registration arrives on, so a *.vercel.app self-registration
 *    would pin Inngest to a deployment that goes stale on the next deploy.
 *  - Non-production environments never self-register.
 *  - `modified` is passed through but never logged: Inngest answers
 *    `modified: true` to every out-of-band sync of an unchanged app, so it is
 *    not a drift signal (the old "registry was STALE" warning fired every run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

interface FetchStubResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<FetchStubResponse>>(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ message: 'Successfully registered', modified: false }),
}))

function request(bearer?: string) {
  return new NextRequest('https://nativeintelligence.dev/api/cron/inngest-sync', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('CRON_SECRET', 'test-secret')
  vi.stubEnv('VERCEL_ENV', 'production')
  fetchMock.mockClear()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: 'Successfully registered', modified: false }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('GET /api/cron/inngest-sync', () => {
  it('returns 503 when CRON_SECRET is not provisioned', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const res = await GET(request('anything'))
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 401 on a wrong bearer', async () => {
    const res = await GET(request('wrong'))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('PUTs the canonical production host and reports modified, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'nativeintelligence.dev')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'Successfully registered', modified: true }),
    })
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://nativeintelligence.dev/api/inngest', {
      method: 'PUT',
    })
    expect(await res.json()).toMatchObject({ ok: true, modified: true })
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })

  it('falls back to nativeintelligence.dev when VERCEL_PROJECT_PRODUCTION_URL is unset', async () => {
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '')
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(200)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://nativeintelligence.dev/api/inngest')
  })

  it('never self-registers from a non-production environment', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'env preview' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 502 when the registration request fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(502)
  })

  it('returns 502 when Inngest rejects the registration', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid signing key' }),
    })
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(502)
  })
})
