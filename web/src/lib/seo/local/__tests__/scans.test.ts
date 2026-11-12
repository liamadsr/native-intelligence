/**
 * Starting a local rank scan (../scans.ts): the server holds the
 * confirmation line. A scan estimated above CONFIRM_ABOVE_USD is refused
 * without `confirmed`, with the estimate so the caller can show the cost and
 * ask, and nothing is written, checked or bought; a cheap scan starts without
 * asking; a grid that now costs more than the estimate shown is refused even
 * when confirmed; a stuck scan is only replaced once the new one is
 * confirmed and allowed.
 *
 * The grid, business and live-scan reads are stubbed; the estimate is the
 * real price-list maths.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalRankGridView, LocalScanView } from '../view'

const hoisted = vi.hoisted(() => ({
  getGrid: vi.fn(),
  getTrackedBusiness: vi.fn(),
  getLiveScan: vi.fn(),
  failScan: vi.fn(async () => {}),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
  SEO_LOCAL_SCAN_REQUESTED: 'seo/local-scan.requested',
  SEO_LOCAL_SCAN_CANCEL: 'seo/local-scan.cancel',
}))
vi.mock('../queries', async (orig) => ({
  ...(await orig<typeof import('../queries')>()),
  getGrid: hoisted.getGrid,
  getTrackedBusiness: hoisted.getTrackedBusiness,
  getLiveScan: hoisted.getLiveScan,
}))
vi.mock('../scan-engine', async (orig) => ({
  ...(await orig<typeof import('../scan-engine')>()),
  failScan: hoisted.failScan,
}))
vi.mock('../scan-store', () => ({ createLocalScanStore: () => ({}) }))

const { startLocalScan } = await import('../scans')
const { CONFIRM_ABOVE_USD } = await import('../limits')

const WS = '00000000-0000-4000-8000-0000000000aa'
const GRID_ID = '00000000-0000-4000-8000-000000000010'
const BIZ_ID = '00000000-0000-4000-8000-000000000020'
const WHO = { workspaceId: WS, userId: 'user-1' }
const NOW = new Date('2026-11-12T10:00:00.000Z')

function grid(size: number, keywords: string[]): LocalRankGridView {
  return {
    id: GRID_ID,
    business_id: BIZ_ID,
    keywords,
    center_latitude: 45.52,
    center_longitude: -122.68,
    radius_km: 3,
    size,
    spacing_km: 1,
    device: 'mobile',
    language_code: 'en',
    estimate_usd: 0,
    created_by: 'user-1',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  }
}

const BIG = grid(7, ['plumber', 'emergency plumber', 'drain', 'boiler', 'leak'])
const SMALL = grid(3, ['plumber'])

/** A service client whose one write is the scan row's insert. */
function fakeSvc() {
  const inserts: Array<Record<string, unknown>> = []
  const svc = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        const data = {
          id: '00000000-0000-4000-8000-000000000030',
          status: 'queued',
          points_collected: 0,
          points_found: 0,
          cost_usd: 0,
          created_at: NOW.toISOString(),
          ...row,
        }
        return {
          select: () => ({
            single: async () => ({ data, error: null }),
          }),
        }
      },
    }),
  } as unknown as SupabaseClient
  return { svc, inserts }
}

const allowed = vi.fn(async () => ({ ok: true as const }))
const send = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getTrackedBusiness.mockResolvedValue({
    id: BIZ_ID,
    title: 'Fernhill Plumbing',
    cid: '123',
    place_id: 'place-fernhill',
  })
  hoisted.getLiveScan.mockResolvedValue(null)
})

describe('startLocalScan: the confirmation line', () => {
  it('refuses a scan above the line without confirmed, with the estimate, and writes, checks and sends nothing', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(svc, WHO, GRID_ID, {}, {
      checkAccess: allowed,
      send,
      now: () => NOW,
    })

    expect(out).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      estimate: { keywords: 5, points: 49, searches: 245 },
    })
    if (out.ok || out.code !== 'CONFIRMATION_REQUIRED') throw new Error()
    expect(out.estimate_usd).toBeGreaterThan(CONFIRM_ABOVE_USD)
    expect(out.estimate_usd).toBeCloseTo(0.294, 6)
    expect(out.message).toContain('245 searches')
    expect(out.message).toContain('$0.29')
    expect(inserts).toHaveLength(0)
    expect(allowed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    // A max_estimate_usd alone is not a yes.
    const guarded = await startLocalScan(
      svc,
      WHO,
      GRID_ID,
      { maxEstimateUsd: 1 },
      { checkAccess: allowed, send, now: () => NOW },
    )
    expect(guarded).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    expect(inserts).toHaveLength(0)
  })

  it('starts the same scan once confirmed', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(
      svc,
      WHO,
      GRID_ID,
      { confirmed: true },
      { checkAccess: allowed, send, now: () => NOW },
    )
    expect(out).toMatchObject({ ok: true })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ points_total: 245 })
    expect(Number(inserts[0].estimate_usd)).toBeCloseTo(0.294, 6)
    expect(allowed).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('starts a scan under the line without asking', async () => {
    hoisted.getGrid.mockResolvedValue(SMALL)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(svc, WHO, GRID_ID, {}, {
      checkAccess: allowed,
      send,
      now: () => NOW,
    })
    expect(out).toMatchObject({ ok: true })
    expect(inserts).toHaveLength(1)
  })

  it('refuses a confirmed scan whose grid now costs more than the estimate shown', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(
      svc,
      WHO,
      GRID_ID,
      { confirmed: true, maxEstimateUsd: 0.06 },
      { checkAccess: allowed, send, now: () => NOW },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'ESTIMATE_CHANGED',
      estimate: { searches: 245 },
    })
    expect(inserts).toHaveLength(0)
  })

  it('passes the access check’s refusal on and starts nothing', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(
      svc,
      WHO,
      GRID_ID,
      { confirmed: true },
      {
        checkAccess: async () => ({
          ok: false as const,
          code: 'NOT_A_MEMBER' as const,
          message: 'Guests read what is there.',
        }),
        send,
        now: () => NOW,
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(inserts).toHaveLength(0)
  })

  it('replaces a stuck scan only once the new one is confirmed', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    const stuck = {
      id: '00000000-0000-4000-8000-000000000031',
      status: 'running',
      started_at: '2026-11-12T01:00:00.000Z',
      created_at: '2026-11-12T01:00:00.000Z',
    } as LocalScanView
    hoisted.getLiveScan.mockResolvedValue(stuck)
    const { svc, inserts } = fakeSvc()

    const refused = await startLocalScan(svc, WHO, GRID_ID, {}, {
      checkAccess: allowed,
      send,
      now: () => NOW,
    })
    expect(refused).toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(hoisted.failScan).not.toHaveBeenCalled()

    const started = await startLocalScan(
      svc,
      WHO,
      GRID_ID,
      { confirmed: true },
      { checkAccess: allowed, send, now: () => NOW },
    )
    expect(started).toMatchObject({ ok: true })
    expect(hoisted.failScan).toHaveBeenCalledTimes(1)
    expect(inserts).toHaveLength(1)
  })

  it('reports a scan still running before asking for anything', async () => {
    hoisted.getGrid.mockResolvedValue(BIG)
    hoisted.getLiveScan.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000032',
      status: 'running',
      started_at: '2026-11-12T09:58:00.000Z',
      created_at: '2026-11-12T09:58:00.000Z',
    } as LocalScanView)
    const { svc, inserts } = fakeSvc()
    const out = await startLocalScan(svc, WHO, GRID_ID, {}, {
      checkAccess: allowed,
      send,
      now: () => NOW,
    })
    expect(out).toMatchObject({ ok: false, code: 'SCAN_ALREADY_RUNNING' })
    expect(inserts).toHaveLength(0)
    expect(hoisted.failScan).not.toHaveBeenCalled()
  })
})
