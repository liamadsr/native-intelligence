/**
 * The two read-only reporting routes added in PR 7.
 *
 * What is under test is the ROUTE's own job — the contract's shape, the
 * mapping from a lib failure to a status, and the two things a reader would
 * otherwise have to take on trust:
 *
 *   * `/spend` computes its number with the ENGINE'S OWN paged sum
 *     (`readMonthlySpend`), not a second query. Two implementations of "what
 *     has this workspace spent this month" would eventually disagree, and the
 *     disagreement surfaces as a UI saying $4.20 of $20 next to a run that
 *     parked at the ceiling.
 *   * A missing list is a 404 on `/angles`, not an empty array. An empty
 *     `angles` legitimately means "no run has stamped an angle yet", so the
 *     two must not look the same.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildRequest } from '@/test/integration'
import { PROSPECTING_MONTHLY_CAP_DOLLARS } from '@/lib/prospecting/spend'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  readMonthlySpend: vi.fn(),
  listAngleTelemetry: vi.fn(),
  listMaybeSingle: vi.fn(),
}))

const WS = 'ws-1'
const USER = { id: 'user-1', email: 'ada@acme.test' }

/** Only the `/angles` existence probe reads through this client directly. */
const supabase = {
  from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: hoisted.listMaybeSingle }) }) }),
  }),
}

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/prospecting/run-shared', () => ({ readMonthlySpend: hoisted.readMonthlySpend }))
vi.mock('@/lib/prospecting/telemetry', () => ({
  listAngleTelemetry: hoisted.listAngleTelemetry,
}))

const spendRoute = await import('@/app/api/account/prospecting/spend/route')
const anglesRoute = await import('@/app/api/account/prospecting/lists/[id]/angles/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function nextRequest(url: string) {
  const req = buildRequest({ url })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// /spend
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/spend', () => {
  it('returns the month-to-date sum, the cap, and the UTC rollover', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T18:30:00.000Z'))
    hoisted.readMonthlySpend.mockResolvedValue(4.2)

    const res = await spendRoute.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      month_spent_dollars: 4.2,
      cap_dollars: PROSPECTING_MONTHLY_CAP_DOLLARS,
      // First instant of the NEXT UTC month, not "30 days from now".
      resets_at: '2026-10-01T00:00:00.000Z',
    })
  })

  it('rolls December over into January of the next year', async () => {
    // Date.UTC normalizes month 12, so December needs no special case — but a
    // hand-rolled `month + 1` that forgot would produce an invalid date here.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-31T23:59:59.000Z'))
    hoisted.readMonthlySpend.mockResolvedValue(0)
    const body = await (await spendRoute.GET()).json()
    expect(body.resets_at).toBe('2027-01-01T00:00:00.000Z')
  })

  it('uses the ENGINE’s paged sum, with no run excluded', async () => {
    // The whole month counts here, including a run that is live right now —
    // there is no run to exclude, unlike in preflight where a retry must not
    // count its own earlier spend against itself.
    hoisted.readMonthlySpend.mockResolvedValue(0)
    await spendRoute.GET()
    expect(hoisted.readMonthlySpend).toHaveBeenCalledTimes(1)
    const [client, workspaceId, runId, now] = hoisted.readMonthlySpend.mock.calls[0]
    expect(client).toBe(supabase)
    expect(workspaceId).toBe(WS)
    expect(runId).toBe('')
    expect(now).toBeInstanceOf(Date)
  })

  it('500s rather than reporting $0 when the sum could not be read', async () => {
    // readMonthlySpend FAILS CLOSED by throwing; it guards real money. A
    // reassuring zero here is the one answer that must never be given.
    hoisted.readMonthlySpend.mockRejectedValue(new Error('boom'))
    const res = await spendRoute.GET()
    expect(res.status).toBe(500)
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await spendRoute.GET()
    expect(res.status).toBe(401)
    expect(hoisted.readMonthlySpend).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /lists/[id]/angles
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/lists/[id]/angles', () => {
  it('returns the per-angle rows', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1' }, error: null })
    hoisted.listAngleTelemetry.mockResolvedValue({
      ok: true,
      angles: [{ angle: 'lookalike', found: 6, new: 2, saved: 1 }],
    })

    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('list-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      angles: [{ angle: 'lookalike', found: 6, new: 2, saved: 1 }],
    })
    expect(hoisted.listAngleTelemetry).toHaveBeenCalledWith(supabase, {
      workspaceId: WS,
      listId: 'list-1',
    })
  })

  it('returns an EMPTY array for a list that has run no angles yet', async () => {
    // Distinct from the 404 below, and deliberately so.
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1' }, error: null })
    hoisted.listAngleTelemetry.mockResolvedValue({ ok: true, angles: [] })
    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('list-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ angles: [] })
  })

  it('404s a cross-workspace list rather than returning an empty table', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: null, error: null })
    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('other-ws-list'))
    expect(res.status).toBe(404)
    // And it never reaches the aggregation.
    expect(hoisted.listAngleTelemetry).not.toHaveBeenCalled()
  })

  it('500s on a lib read failure rather than showing zero angles', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1' }, error: null })
    hoisted.listAngleTelemetry.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('list-1'))
    expect(res.status).toBe(500)
  })

  it('500s when the existence probe itself fails', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('list-1'))
    expect(res.status).toBe(500)
    expect(hoisted.listAngleTelemetry).not.toHaveBeenCalled()
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await anglesRoute.GET(nextRequest('https://dial8.ai/x'), params('list-1'))
    expect(res.status).toBe(401)
    expect(hoisted.listAngleTelemetry).not.toHaveBeenCalled()
  })
})
