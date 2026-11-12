/**
 * The local SEO routes that can spend:
 *   - GET /businesses/[id] never spends: `?refresh` is ignored and the
 *     profile is the stored read; the paid profile read is POST
 *     /businesses/[id]/refresh.
 *   - POST /grids/[id]/scans passes `confirmed` and `max_estimate_usd` to the
 *     core, and answers its CONFIRMATION_REQUIRED as 409 with the estimate in
 *     `details`.
 *   - Every access refusal (NOT_A_MEMBER and CHECK_FAILED included) gets its
 *     status from seoRefusalResponse.
 *
 * The cores are mocked: this file tests what each route asks of them and how
 * it answers.
 */
import { buildRequest, readJson } from '@/test/integration'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const BIZ = '00000000-0000-4000-8000-000000000020'
const GRID = '00000000-0000-4000-8000-000000000010'
const WS = '00000000-0000-4000-8000-0000000000aa'

const hoisted = vi.hoisted(() => ({
  readProfile: vi.fn(),
  startLocalScan: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ kind: 'svc' }) }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    workspaceId: WS,
    user: { id: 'user-1' },
  }),
}))
vi.mock('@/lib/seo/local/businesses', () => ({
  readGoogleBusinessProfile: hoisted.readProfile,
  removeTrackedBusiness: vi.fn(),
  resolveBusinessRef: async () => ({ ok: true, ref: { trackedId: BIZ } }),
}))
vi.mock('@/lib/seo/local/grids', () => ({
  listLocalGrids: async () => [],
}))
vi.mock('@/lib/seo/local/queries', () => ({
  getTrackedBusiness: async () => ({ id: BIZ, title: 'Fernhill Plumbing' }),
  getGrid: vi.fn(),
  listScans: vi.fn(),
}))
vi.mock('@/lib/seo/local/scans', () => ({
  startLocalScan: hoisted.startLocalScan,
}))

const business = await import('../businesses/[id]/route')
const refresh = await import('../businesses/[id]/refresh/route')
const scans = await import('../grids/[id]/scans/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const PROFILE = {
  profile: { title: 'Fernhill Plumbing' },
  lookup_id: 'l-1',
  fetched_at: '2026-11-12T10:00:00.000Z',
  from_cache: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.readProfile.mockResolvedValue({ ok: true, result: PROFILE })
})

describe('the tracked business’s profile', () => {
  it('GET reads only what is stored, even with ?refresh=1', async () => {
    const res = await business.GET(
      buildRequest({
        method: 'GET',
        url: `https://nativeintelligence.dev/api/account/seo/local/businesses/${BIZ}?refresh=1`,
      }),
      params(BIZ),
    )
    expect(res.status).toBe(200)
    expect(hoisted.readProfile).toHaveBeenCalledTimes(1)
    expect(hoisted.readProfile.mock.calls[0][3]).toEqual({ storedOnly: true })
    expect(await readJson(res)).toMatchObject({
      business: { id: BIZ },
      profile: PROFILE,
      grids: [],
    })
  })

  it('POST /refresh buys a fresh profile and answers the same shape', async () => {
    const res = await refresh.POST(
      buildRequest({
        url: `https://nativeintelligence.dev/api/account/seo/local/businesses/${BIZ}/refresh`,
      }),
      params(BIZ),
    )
    expect(res.status).toBe(200)
    expect(hoisted.readProfile.mock.calls[0][3]).toEqual({ refresh: true })
    expect(await readJson(res)).toMatchObject({
      business: { id: BIZ },
      profile: PROFILE,
      grids: [],
    })
  })

  it('POST /refresh answers a guest’s refusal 403 and a failed check 503', async () => {
    hoisted.readProfile.mockResolvedValueOnce({
      ok: false,
      code: 'NOT_A_MEMBER',
      message: 'Guests read what is there.',
    })
    const guest = await refresh.POST(
      buildRequest({
        url: `https://nativeintelligence.dev/api/account/seo/local/businesses/${BIZ}/refresh`,
      }),
      params(BIZ),
    )
    expect(guest.status).toBe(403)
    expect(await readJson(guest)).toMatchObject({ code: 'NOT_A_MEMBER' })

    hoisted.readProfile.mockResolvedValueOnce({
      ok: false,
      code: 'CHECK_FAILED',
      message: 'Could not check just now. Try again.',
    })
    const failed = await refresh.POST(
      buildRequest({
        url: `https://nativeintelligence.dev/api/account/seo/local/businesses/${BIZ}/refresh`,
      }),
      params(BIZ),
    )
    expect(failed.status).toBe(503)
    expect(await readJson(failed)).toMatchObject({ code: 'CHECK_FAILED' })
  })
})

describe('starting a scan', () => {
  const url = `https://nativeintelligence.dev/api/account/seo/local/grids/${GRID}/scans`

  it('answers the core’s CONFIRMATION_REQUIRED as 409 with the estimate in details', async () => {
    const estimate = {
      keywords: 5,
      points: 49,
      searches: 245,
      estimate_usd: 0.294,
      needs_confirmation: true,
    }
    hoisted.startLocalScan.mockResolvedValueOnce({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'This scan is 245 searches and costs about $0.29.',
      estimate_usd: 0.294,
      estimate,
    })
    const res = await scans.POST(
      buildRequest({ url, body: { max_estimate_usd: 0.3 } }),
      params(GRID),
    )
    expect(hoisted.startLocalScan).toHaveBeenCalledWith(
      { kind: 'svc' },
      { workspaceId: WS, userId: 'user-1' },
      GRID,
      { confirmed: false, maxEstimateUsd: 0.3 },
    )
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { estimate_usd: 0.294, estimate },
    })
  })

  it('passes confirmed: true on and starts', async () => {
    hoisted.startLocalScan.mockResolvedValueOnce({
      ok: true,
      scan: { id: 'scan-1', status: 'queued' },
    })
    const res = await scans.POST(
      buildRequest({ url, body: { confirmed: true, max_estimate_usd: 0.294 } }),
      params(GRID),
    )
    expect(hoisted.startLocalScan.mock.calls[0][3]).toEqual({
      confirmed: true,
      maxEstimateUsd: 0.294,
    })
    expect(res.status).toBe(202)
  })

  it('takes only a real true as the yes', async () => {
    hoisted.startLocalScan.mockResolvedValueOnce({
      ok: true,
      scan: { id: 'scan-1', status: 'queued' },
    })
    await scans.POST(
      buildRequest({ url, body: { confirmed: 'true' } }),
      params(GRID),
    )
    expect(hoisted.startLocalScan.mock.calls[0][3]).toMatchObject({
      confirmed: false,
    })
  })
})
