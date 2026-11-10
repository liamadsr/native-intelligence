/**
 * Tests for GET /api/account/knowledge/map and GET …/map/tiles.
 *
 * The service is mocked — its caching is covered by its own tests. What these
 * lock in is the HTTP contract the client codes against:
 *   - auth failures pass straight through (the route never swallows a 401);
 *   - filters are parsed off the query string and handed to the service, and
 *     `have=` rides along so the realtime revalidation loop works;
 *   - every response carries `Cache-Control: private, no-store` and a `Vary`
 *     naming cookie + Authorization + x-workspace-id. Without that Vary a proxy
 *     could hand one desktop window the map of a window on another workspace;
 *   - tiles: `v` and `t` are required, every id is validated with parseTileId
 *     (a bad id is a 400, never a silently missing tile), the request is capped
 *     at MAX_TILES_PER_REQUEST, and a stale version becomes 409 `stale_map`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'
import { MAX_TILES_PER_REQUEST } from '@/lib/knowledge/graph-map/types'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  getMap: vi.fn(),
  getTiles: vi.fn(),
  parseFilters: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

vi.mock('@/lib/knowledge/graph-map/service', () => ({
  getMap: hoisted.getMap,
  getTiles: hoisted.getTiles,
}))

vi.mock('@/lib/knowledge/graph-map', () => ({ parseFilters: hoisted.parseFilters }))

const { GET: getMapRoute } = await import('@/app/api/account/knowledge/map/route')
const { GET: getTilesRoute } = await import(
  '@/app/api/account/knowledge/map/tiles/route'
)

const UNAUTHED = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

function req(path: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(`https://nativeintelligence.dev/api/account/knowledge/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return Object.assign(buildRequest({ url: url.toString(), method: 'GET' }), {
    nextUrl: url,
  }) as unknown as NextRequest
}

/** A filter set the route only ever passes through, never inspects. */
const CONFIRMED = {
  where: [{ field: 'confirmation', op: 'is', value: ['confirmed'] }],
}

function expectMapHeaders(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  expect(res.headers.get('Vary')).toBe('Cookie, Authorization, x-workspace-id')
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: {},
    user: { id: 'user-1' },
    workspaceId: 'ws-1',
  })
  hoisted.parseFilters.mockReturnValue({ ok: true, filters: {} })
  hoisted.getMap.mockResolvedValue({ version: 'v1', tiles: [] })
  hoisted.getTiles.mockResolvedValue([])
})

describe('GET /api/account/knowledge/map', () => {
  it('passes an auth failure through untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED)
    const res = await getMapRoute(req('map'))
    expect(res.status).toBe(401)
    expect(hoisted.getMap).not.toHaveBeenCalled()
  })

  it('sets the private, per-viewer cache headers', async () => {
    const res = await getMapRoute(req('map'))
    expect(res.status).toBe(200)
    expectMapHeaders(res)
  })

  it('hands the parsed filters, the viewer id and have= to the service', async () => {
    hoisted.parseFilters.mockReturnValue({ ok: true, filters: CONFIRMED })
    await getMapRoute(req('map', { f: '[["confirmation","is",["confirmed"]]]', have: 'v0' }))

    const params = hoisted.parseFilters.mock.calls[0][0] as URLSearchParams
    expect(params.get('f')).toBe('[["confirmation","is",["confirmed"]]]')
    expect(hoisted.getMap).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        userId: 'user-1',
        filters: CONFIRMED,
        have: 'v0',
      }),
    )
  })

  it('omits have= when the client sent none', async () => {
    await getMapRoute(req('map'))
    expect(hoisted.getMap.mock.calls[0][0].have).toBeUndefined()
  })

  it('serves the unchanged short-circuit body verbatim', async () => {
    hoisted.getMap.mockResolvedValueOnce({ unchanged: true, version: 'v1' })
    const res = await getMapRoute(req('map', { have: 'v1' }))
    expect(await res.json()).toEqual({ unchanged: true, version: 'v1' })
  })

  it('answers 400 for a filter payload the map refuses', async () => {
    // A bad filter payload is a bad REQUEST. Letting it escape as a 500 would
    // push the client into its retry/reload path over something no retry can
    // fix, and would hide a client bug behind "the map is down".
    hoisted.parseFilters.mockReturnValue({ ok: false, error: 'filters must be a list' })
    const res = await getMapRoute(req('map', { f: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/must be a list/)
    expect(hoisted.getMap).not.toHaveBeenCalled()
  })

  it('turns a build failure into a 500 without leaking internals', async () => {
    hoisted.getMap.mockRejectedValueOnce(new Error('permission denied for table claim'))
    const res = await getMapRoute(req('map'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('INTERNAL')
    expect(JSON.stringify(body)).not.toContain('permission denied')
  })
})

describe('GET /api/account/knowledge/map/tiles', () => {
  it('passes an auth failure through untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED)
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: '0.0.0' }))
    expect(res.status).toBe(401)
  })

  it('requires v', async () => {
    const res = await getTilesRoute(req('map/tiles', { t: '0.0.0' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/version/i)
  })

  it('requires at least one tile id', async () => {
    expect((await getTilesRoute(req('map/tiles', { v: 'v1' }))).status).toBe(400)
    expect((await getTilesRoute(req('map/tiles', { v: 'v1', t: ' , ' }))).status).toBe(400)
  })

  it('rejects a malformed or out-of-range tile id rather than dropping it', async () => {
    for (const bad of ['nope', '0.1.0', '11.0.0', '1.2.0', '-1.0.0']) {
      const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: bad }))
      expect(res.status, `tile id ${bad}`).toBe(400)
    }
    expect(hoisted.getTiles).not.toHaveBeenCalled()
  })

  it(`rejects more than ${MAX_TILES_PER_REQUEST} ids`, async () => {
    const ids = Array.from({ length: MAX_TILES_PER_REQUEST + 1 }, (_u, i) => `10.${i}.0`)
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: ids.join(',') }))
    expect(res.status).toBe(400)
  })

  it('accepts exactly the cap and forwards the ids in order', async () => {
    const ids = Array.from({ length: MAX_TILES_PER_REQUEST }, (_u, i) => `10.${i}.0`)
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: ids.join(',') }))
    expect(res.status).toBe(200)
    expect(hoisted.getTiles.mock.calls[0][0].ids).toEqual(ids)
  })

  it('returns 409 stale_map when the service reports a stale version', async () => {
    hoisted.getTiles.mockResolvedValueOnce('stale')
    const res = await getTilesRoute(req('map/tiles', { v: 'v-old', t: '0.0.0' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_map', stale: true })
    expectMapHeaders(res)
  })

  it('returns { tiles } with the per-viewer headers on success', async () => {
    hoisted.getTiles.mockResolvedValueOnce([{ z: 0, x: 0, y: 0 }])
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: '0.0.0' }))
    expect(res.status).toBe(200)
    expect((await res.json()).tiles).toHaveLength(1)
    expectMapHeaders(res)
  })

  it('forwards the parsed filters (they decide which nodes fill which tile)', async () => {
    hoisted.parseFilters.mockReturnValue({ ok: true, filters: CONFIRMED })
    await getTilesRoute(req('map/tiles', { v: 'v1', t: '0.0.0', f: '[]' }))
    expect(hoisted.getTiles).toHaveBeenCalledWith(
      expect.objectContaining({ filters: CONFIRMED, version: 'v1' }),
    )
  })

  it('answers 400 for a filter payload the map refuses', async () => {
    hoisted.parseFilters.mockReturnValue({ ok: false, error: 'filters are not valid JSON' })
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: '0.0.0', f: 'nope' }))
    expect(res.status).toBe(400)
    expect(hoisted.getTiles).not.toHaveBeenCalled()
  })

  it('turns a build failure into a 500', async () => {
    hoisted.getTiles.mockRejectedValueOnce(new Error('boom'))
    const res = await getTilesRoute(req('map/tiles', { v: 'v1', t: '0.0.0' }))
    expect(res.status).toBe(500)
  })
})
