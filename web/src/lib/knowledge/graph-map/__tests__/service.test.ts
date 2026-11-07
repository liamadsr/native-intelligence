/**
 * Tests for the Knowledge Map's cached map service.
 *
 * The properties under test are cache properties, so the pure core and the
 * source reads are both mocked: what matters here is HOW OFTEN each is called
 * and WITH WHICH KEY, not what they compute.
 *
 * Locked in:
 *   - the cache key includes the USER id. Two members of one workspace never
 *     share an entry — a workspace-only key would serve viewer A's map (built
 *     from rows only A can read) to viewer B. This is the security property the
 *     whole per-viewer design exists for (§3), so it gets the first test.
 *   - `have=<current version>` short-circuits to `{ unchanged: true }` without
 *     fetching or laying out anything (the realtime revalidation path).
 *   - concurrent getMap calls for a cold key build ONCE.
 *   - getTiles: cache hit serves tiles; cold cache re-probes and rebuilds on a
 *     matching version, and only reports 'stale' when the version really moved.
 *   - DELTA refresh (tier A+): a version bump extends the viewer's cached rows
 *     with a small delta instead of re-reading the whole workspace, and falls
 *     back to a full read whenever the delta cannot be trusted — count
 *     mismatch (deletions), TTL expiry, or an error inside the delta itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MapFilters, MapTile } from '@/lib/knowledge/graph-map/types'

const hoisted = vi.hoisted(() => ({
  probeParts: vi.fn(),
  fetchSourceRows: vi.fn(),
  fetchSourceDelta: vi.fn(),
  layoutMap: vi.fn(),
  tileMap: vi.fn(),
  filtersKey: vi.fn(),
  hasRelativeFilter: vi.fn(),
  parseFilters: vi.fn(),
}))

vi.mock('@/lib/knowledge/graph-map/source', () => ({
  fetchSourceRows: hoisted.fetchSourceRows,
}))

// Only the I/O half of source-delta is mocked. `snapshotOf`, `applyDelta` and
// `deltaMatchesProbe` are pure and run for REAL here, so the service tests
// exercise the actual merge and the actual validation gate rather than a stub
// that would agree with whatever the service did.
vi.mock('@/lib/knowledge/graph-map/source-delta', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/knowledge/graph-map/source-delta')>()
  return {
    ...actual,
    probeParts: hoisted.probeParts,
    fetchSourceDelta: hoisted.fetchSourceDelta,
  }
})

vi.mock('@/lib/knowledge/graph-map', () => ({
  layoutMap: hoisted.layoutMap,
  tileMap: hoisted.tileMap,
  filtersKey: hoisted.filtersKey,
  hasRelativeFilter: hoisted.hasRelativeFilter,
  parseFilters: hoisted.parseFilters,
}))

const { getMap, getTiles, __resetMapCacheForTests } = await import(
  '@/lib/knowledge/graph-map/service'
)

/** A stand-in for the user-session client; the service only passes it through. */
const supabase = {} as never

function tile(id: string): MapTile {
  const [z, x, y] = id.split('.').map(Number)
  return {
    z,
    x,
    y,
    ox: 0,
    oy: 0,
    size: 1,
    dropped: 0,
    droppedEdges: 0,
    nodes: { id: [], key: [], kind: [], etype: [], x: [], y: [], r: [], importance: [], degree: [], flags: [], label: [] },
    edges: { s: [], t: [], tx: [], ty: [], rel: [] },
  }
}

function built(version: string) {
  return {
    meta: {
      version,
      world: { minX: 0, minY: 0, size: 100 },
      maxZ: 1,
      counts: { nodes: 1, edges: 0, claims: 1, hubs: 0, totalClaims: 1 },
      entityTypes: [],
      relations: [],
      manifest: [[0, 0, 0, 1, 0]],
      projects: [],
      promote: { total: 0, topClaimIds: [] },
    },
    tiles: new Map([
      ['0.0.0', tile('0.0.0')],
      ['1.0.1', tile('1.0.1')],
    ]),
    inline: [tile('0.0.0')],
  }
}

const NO_FILTERS: MapFilters = {}

/**
 * Probe parts for a workspace of `claims` claims and `links` raw links. The
 * version is supplied rather than hashed so a test can move it by hand.
 */
function parts(version: string, claims = 0, links = 0) {
  return {
    claimCount: claims,
    claimMaxUpdatedAt: '2026-01-01T00:00:00Z',
    linkCount: links,
    linkMaxCreatedAt: '2026-01-01T00:00:00Z',
    version,
  }
}

/** An empty delta: nothing changed past the watermark. */
function emptyDelta() {
  return {
    claims: [],
    links: [],
    tailLinks: [],
    hubs: [],
    rawLinksAtBound: 0,
    linksBeforeBound: 0,
    droppedLinkIds: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetMapCacheForTests()
  hoisted.probeParts.mockResolvedValue(parts('v1'))
  hoisted.fetchSourceDelta.mockResolvedValue(emptyDelta())
  hoisted.fetchSourceRows.mockResolvedValue({ claims: [], links: [], hubs: [] })
  hoisted.layoutMap.mockImplementation(() => ({ marker: 'laid-out' }))
  hoisted.tileMap.mockImplementation(
    (_map: unknown, opts: { version: string }) => built(opts.version),
  )
  hoisted.filtersKey.mockImplementation((f: MapFilters) => JSON.stringify(f))
  // The real predicate: the hour bucket exists for ANY clock-dependent filter,
  // not for one named field.
  hoisted.hasRelativeFilter.mockImplementation((f: MapFilters) =>
    (f.where ?? []).some((p) => p.op === 'is_relative'),
  )
})

describe('getMap — per-viewer cache', () => {
  it('never shares a cache entry between two users of the same workspace', async () => {
    await getMap({ supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS })
    await getMap({ supabase, workspaceId: 'ws-1', userId: 'user-B', filters: NO_FILTERS })

    // Two distinct viewers ⇒ two independent source reads + layouts. A shared
    // entry would mean B is looking at rows only A can read.
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
    expect(hoisted.layoutMap).toHaveBeenCalledTimes(2)
  })

  it('reuses one entry for repeated calls by the SAME user', async () => {
    const args = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS }
    await getMap(args)
    await getMap(args)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
  })

  it('re-LAYS OUT when the source version moves', async () => {
    const args = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS }
    await getMap(args)
    hoisted.probeParts.mockResolvedValue(parts('v2'))
    const res = await getMap(args)

    // The layout is version-keyed and is recomputed. The ROWS, however, are
    // now extended by a delta rather than re-read in full — that swap is the
    // whole of tier A+, so the full-read count stays at one.
    expect(hoisted.layoutMap).toHaveBeenCalledTimes(2)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceDelta).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ version: 'v2' })
  })
})

describe('getMap — have= short-circuit', () => {
  it('returns { unchanged: true } without fetching or laying out', async () => {
    const res = await getMap({
      supabase,
      workspaceId: 'ws-1',
      userId: 'user-A',
      filters: NO_FILTERS,
      have: 'v1',
    })

    expect(res).toEqual({ unchanged: true, version: 'v1' })
    expect(hoisted.fetchSourceRows).not.toHaveBeenCalled()
    expect(hoisted.layoutMap).not.toHaveBeenCalled()
    expect(hoisted.tileMap).not.toHaveBeenCalled()
  })

  it('builds normally when have= is a stale version', async () => {
    const res = await getMap({
      supabase,
      workspaceId: 'ws-1',
      userId: 'user-A',
      filters: NO_FILTERS,
      have: 'v0',
    })
    expect(res).not.toHaveProperty('unchanged', true)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
  })

  it('returns the meta plus the inline tiles', async () => {
    const res = await getMap({
      supabase,
      workspaceId: 'ws-1',
      userId: 'user-A',
      filters: NO_FILTERS,
    })
    expect(res).toMatchObject({ version: 'v1', maxZ: 1 })
    expect((res as { tiles: MapTile[] }).tiles).toHaveLength(1)
  })
})

describe('getMap — concurrency', () => {
  it('builds once for concurrent calls with the same key', async () => {
    let release: (() => void) | undefined
    hoisted.fetchSourceRows.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ claims: [], links: [], hubs: [] })
        }),
    )

    const args = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS }
    const both = Promise.all([getMap(args), getMap(args), getMap(args)])
    // Let all three reach the in-flight map before the fetch resolves.
    await new Promise((r) => setTimeout(r, 0))
    release?.()
    await both

    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
    expect(hoisted.layoutMap).toHaveBeenCalledTimes(1)
  })

  it('does not poison the key when a build fails', async () => {
    hoisted.fetchSourceRows.mockRejectedValueOnce(new Error('transient'))
    const args = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS }

    await expect(getMap(args)).rejects.toThrow('transient')
    // The next request must be able to build rather than re-await a dead promise.
    await expect(getMap(args)).resolves.toMatchObject({ version: 'v1' })
  })
})

describe('getMap — filter builds', () => {
  const CONFIRMED: MapFilters = {
    where: [{ field: 'confirmation', op: 'is', value: ['confirmed'] }],
  }
  /** "Happened in the last 30 days" — unresolved on the wire, by contract. */
  const RELATIVE: MapFilters = {
    where: [
      {
        field: 'event_at',
        op: 'is_relative',
        value: { unit: 'day', direction: 'past', count: 30 },
      },
    ],
  }

  it('tiles once per distinct filter set, reusing the layout', async () => {
    const base = { supabase, workspaceId: 'ws-1', userId: 'user-A' }
    await getMap({ ...base, filters: {} })
    await getMap({ ...base, filters: CONFIRMED })
    await getMap({ ...base, filters: {} })

    expect(hoisted.layoutMap).toHaveBeenCalledTimes(1)
    expect(hoisted.tileMap).toHaveBeenCalledTimes(2)
  })

  it('does NOT bucket a clock-independent filter set by the hour', async () => {
    // The bucket is pure cache churn for a filter whose answer cannot move:
    // a `confirmation is confirmed` map built at 10:00 is still correct at
    // 11:00, and re-tiling it hourly would evict the entries that matter.
    const base = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: CONFIRMED }
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0)
    await getMap({ ...base, nowMs: t0 })
    await getMap({ ...base, nowMs: t0 + 5 * 3_600_000 })
    expect(hoisted.tileMap).toHaveBeenCalledTimes(1)
  })

  it('re-tiles a relative window when the hour bucket rolls over', async () => {
    // Guards the bug the old `filters.sinceDays &&` condition had once the
    // vocabulary opened up: `is_relative` can sit on created_at, event_at OR
    // last_verified_at, and keying the bucket on one named field would freeze
    // the other two at whatever hour they were first built — "happened in the
    // last 30 days" answering from a window that stopped advancing.
    const base = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: RELATIVE }
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0)
    await getMap({ ...base, nowMs: t0 })
    await getMap({ ...base, nowMs: t0 + 60_000 }) // same hour → cached
    expect(hoisted.tileMap).toHaveBeenCalledTimes(1)

    await getMap({ ...base, nowMs: t0 + 3_600_000 }) // next hour → rebuild
    expect(hoisted.tileMap).toHaveBeenCalledTimes(2)
    // The layout is time-independent and is never recomputed.
    expect(hoisted.layoutMap).toHaveBeenCalledTimes(1)
  })

  it('hands the mask a RESOLVED window, never the relative descriptor', async () => {
    // `is_relative` is resolved once, server-side, through the views engine's
    // own resolver — the same one the SQL list uses. If it reached `tileMap`
    // unresolved the mask would throw; if the map resolved it independently,
    // one saved view could mean two different windows in the list and on the
    // canvas.
    await getMap({ supabase, workspaceId: 'ws-1', userId: 'user-A', filters: RELATIVE })

    const passed = hoisted.tileMap.mock.calls[0][1] as { filters: MapFilters }
    const predicate = (passed.filters.where ?? [])[0]
    expect(predicate.op).toBe('between')
    expect(predicate.field).toBe('event_at')
    const range = predicate.value as { from: string; to: string }
    expect(Date.parse(range.from)).toBeLessThan(Date.parse(range.to))

    // ...and the CACHE key still sees the unresolved form, or every request
    // would be its own entry.
    const keyed = hoisted.filtersKey.mock.calls[0][0] as MapFilters
    expect((keyed.where ?? [])[0].op).toBe('is_relative')
  })
})

describe('getTiles', () => {
  const base = {
    supabase,
    workspaceId: 'ws-1',
    userId: 'user-A',
    filters: NO_FILTERS,
  }

  it('serves tiles from a warm cache without re-probing', async () => {
    await getMap({ ...base })
    hoisted.probeParts.mockClear()

    const tiles = await getTiles({ ...base, version: 'v1', ids: ['1.0.1'] })
    expect(tiles).not.toBe('stale')
    expect(tiles).toHaveLength(1)
    expect((tiles as MapTile[])[0]).toMatchObject({ z: 1, x: 0, y: 1 })
    expect(hoisted.probeParts).not.toHaveBeenCalled()
  })

  it('rebuilds on a cold cache when the version still matches', async () => {
    // Cold instance (nothing cached) but the workspace has not changed — a
    // 409 here would force every client on a fresh lambda into a full reload.
    const tiles = await getTiles({ ...base, version: 'v1', ids: ['0.0.0'] })
    expect(tiles).not.toBe('stale')
    expect(hoisted.probeParts).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
  })

  it("reports 'stale' when the workspace moved past the requested version", async () => {
    hoisted.probeParts.mockResolvedValue(parts('v2'))
    const tiles = await getTiles({ ...base, version: 'v1', ids: ['0.0.0'] })
    expect(tiles).toBe('stale')
    expect(hoisted.fetchSourceRows).not.toHaveBeenCalled()
  })

  it('skips ids the current filter set emptied out rather than failing', async () => {
    await getMap({ ...base })
    const tiles = await getTiles({
      ...base,
      version: 'v1',
      ids: ['0.0.0', '9.5.5'],
    })
    expect(tiles).toHaveLength(1)
  })

  it('keys its cache per user like getMap does', async () => {
    await getMap({ ...base, userId: 'user-A' })
    hoisted.probeParts.mockClear()

    // user-B has nothing cached, so this must re-probe rather than reuse A's map.
    await getTiles({ ...base, userId: 'user-B', version: 'v1', ids: ['0.0.0'] })
    expect(hoisted.probeParts).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
  })
})

describe('delta refresh (tier A+)', () => {
  const base = { supabase, workspaceId: 'ws-1', userId: 'user-A', filters: NO_FILTERS }

  function claimRow(id: string, confirmation = 'suggested') {
    return {
      id,
      text: `claim ${id}`,
      type: 'fact',
      confidence: 0.7,
      confirmation,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    }
  }

  /** Rows the layout was actually built from, for the Nth layoutMap call. */
  function laidOutRows(call: number) {
    return hoisted.layoutMap.mock.calls[call][0] as {
      claims: Array<{ id: string; confirmation: string }>
      links: unknown[]
      hubs: unknown[]
    }
  }

  it('extends the cached rows with a NEW claim instead of re-reading the workspace', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({
      claims: [claimRow('c-1')],
      links: [],
      hubs: [],
    })
    await getMap(base)

    // One claim added: the probe count moves with it, so the merge validates.
    hoisted.probeParts.mockResolvedValue(parts('v2', 2, 0))
    hoisted.fetchSourceDelta.mockResolvedValue({
      ...emptyDelta(),
      claims: [claimRow('c-2')],
    })
    await getMap(base)

    // THE point of the feature: no second full read.
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceDelta).toHaveBeenCalledTimes(1)
    expect(laidOutRows(1).claims.map((c) => c.id)).toEqual(['c-1', 'c-2'])
  })

  it('applies a MODIFIED claim (confirmation flip) in place, with no full fetch', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({
      claims: [claimRow('c-1', 'suggested')],
      links: [],
      hubs: [],
    })
    await getMap(base)

    // A confirmation flip does not change the COUNT, only updated_at.
    hoisted.probeParts.mockResolvedValue(parts('v2', 1, 0))
    hoisted.fetchSourceDelta.mockResolvedValue({
      ...emptyDelta(),
      claims: [claimRow('c-1', 'confirmed')],
    })
    await getMap(base)

    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
    const rows = laidOutRows(1)
    expect(rows.claims).toHaveLength(1) // upserted, not appended
    expect(rows.claims[0].confirmation).toBe('confirmed')
  })

  it('falls back to exactly ONE full fetch when a claim was deleted (count mismatch)', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 2, 0))
    hoisted.fetchSourceRows.mockResolvedValue({
      claims: [claimRow('c-1'), claimRow('c-2')],
      links: [],
      hubs: [],
    })
    await getMap(base)

    // The probe says one claim now; the delta cannot see the deletion, so the
    // merged rows still hold two and validation must reject them.
    hoisted.probeParts.mockResolvedValue(parts('v2', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('c-1')], links: [], hubs: [] })
    await getMap(base)

    expect(hoisted.fetchSourceDelta).toHaveBeenCalledTimes(1)
    // Exactly one MORE full fetch — not zero (the map would be wrong) and not
    // two (the fallback must not also re-run for the same refresh).
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
    expect(laidOutRows(1).claims.map((c) => c.id)).toEqual(['c-1'])
  })

  it('falls back to a full fetch when the DELTA ITSELF errors', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('c-1')], links: [], hubs: [] })
    await getMap(base)

    hoisted.probeParts.mockResolvedValue(parts('v2', 1, 0))
    hoisted.fetchSourceDelta.mockRejectedValue(new Error('PostgREST 500'))
    await expect(getMap(base)).resolves.toMatchObject({ version: 'v2' })

    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
  })

  it('forces a full fetch once the cached rows pass the TTL', async () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0)
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('c-1')], links: [], hubs: [] })
    await getMap({ ...base, nowMs: t0 })

    // Just inside the 10-minute TTL: still a delta.
    hoisted.probeParts.mockResolvedValue(parts('v2', 1, 0))
    await getMap({ ...base, nowMs: t0 + 9 * 60_000 })
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceDelta).toHaveBeenCalledTimes(1)

    // Past it: a full read, which is what converges hub renames and label
    // edits — changes no delta can observe.
    hoisted.probeParts.mockResolvedValue(parts('v3', 1, 0))
    await getMap({ ...base, nowMs: t0 + 21 * 60_000 })
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
  })

  it('never lets one viewer’s rows reach another viewer', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('a-1')], links: [], hubs: [] })
    await getMap({ ...base, userId: 'user-A' })

    // B has no snapshot of its own, so it must do a FULL read under its own
    // RLS — never extend A's rows by a delta. This is §3, and a shared rows
    // cache would be the same leak a shared layout cache would be.
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('b-1')], links: [], hubs: [] })
    await getMap({ ...base, userId: 'user-B' })

    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(2)
    expect(hoisted.fetchSourceDelta).not.toHaveBeenCalled()
    expect(laidOutRows(0).claims.map((c) => c.id)).toEqual(['a-1'])
    expect(laidOutRows(1).claims.map((c) => c.id)).toEqual(['b-1'])
  })

  it('shares ONE refresh between concurrent callers for the same viewer', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('c-1')], links: [], hubs: [] })
    await getMap(base)

    // Hold the delta open so getMap and getTiles both reach the in-flight slot.
    let release: (() => void) | undefined
    hoisted.probeParts.mockResolvedValue(parts('v2', 1, 0))
    hoisted.fetchSourceDelta.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(emptyDelta()) }),
    )

    const both = Promise.all([
      getMap(base),
      getTiles({ ...base, version: 'v2', ids: ['0.0.0'] }),
    ])
    await new Promise((r) => setTimeout(r, 0))
    release?.()
    await both

    // Two callers, one read of the workspace.
    expect(hoisted.fetchSourceDelta).toHaveBeenCalledTimes(1)
    expect(hoisted.fetchSourceRows).toHaveBeenCalledTimes(1)
  })

  it('does not let a delta for an OLD version overwrite a newer full refresh', async () => {
    hoisted.probeParts.mockResolvedValue(parts('v1', 1, 0))
    hoisted.fetchSourceRows.mockResolvedValue({ claims: [claimRow('c-1')], links: [], hubs: [] })
    await getMap(base)

    // A slow delta for v2 starts first...
    let releaseDelta: (() => void) | undefined
    hoisted.fetchSourceDelta.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDelta = () => resolve({ ...emptyDelta(), claims: [claimRow('c-2')] })
        }),
    )
    hoisted.probeParts.mockResolvedValue(parts('v2', 2, 0))
    const slow = getMap(base)
    await new Promise((r) => setTimeout(r, 0))

    // ...and a TTL-expired full refresh for v3 lands while it is still open.
    hoisted.probeParts.mockResolvedValue(parts('v3', 3, 0))
    hoisted.fetchSourceRows.mockResolvedValue({
      claims: [claimRow('c-1'), claimRow('c-2'), claimRow('c-3')],
      links: [],
      hubs: [],
    })
    await getMap({ ...base, nowMs: Date.now() + 30 * 60_000 })

    releaseDelta?.()
    await slow

    // The newer rows must survive: a later call sees three claims, not the
    // two the stale delta would have reinstated. (Back to an empty delta so
    // this last refresh does not hang on the fixture above.)
    hoisted.fetchSourceDelta.mockResolvedValue(emptyDelta())
    hoisted.probeParts.mockResolvedValue(parts('v4', 3, 0))
    await getMap(base)
    const last = hoisted.layoutMap.mock.calls.length - 1
    expect(laidOutRows(last).claims.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3'])
  })
})
