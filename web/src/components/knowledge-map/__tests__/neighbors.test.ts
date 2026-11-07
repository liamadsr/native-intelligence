import { describe, it, expect } from 'vitest'
import { tileId, type MapTile } from '@/lib/knowledge/graph-map/types'
import { NeighborIndex, resolveHighlight, DEFAULT_MAX_HIGHLIGHT_EDGES } from '../neighbors'
import { TileStore } from '../tile-store'
import { createInMemoryDataSource } from '../data-source'
import { buildMap, makeTile } from './fixtures'
import type { ResidentTile } from '../types'

function silentCallbacks() {
  return {
    onTileLoaded: () => {},
    onTileEvicted: () => {},
    onReset: () => {},
    onMeta: () => {},
    onError: () => {},
    requestFrame: () => {},
  }
}

async function loadStore(tiles: MapTile[]): Promise<TileStore> {
  const map = buildMap(
    'v1',
    tiles,
    tiles.map((t) => tileId(t.z, t.x, t.y)),
  )
  const store = new TileStore(createInMemoryDataSource(map), silentCallbacks())
  await store.load()
  return store
}

/**
 * A hub (id 500) in tile 1.0.0, plus claims in two DIFFERENT tiles that all
 * cite it. Outgoing edges live with the source claim (§4.3), so the hub's
 * incoming edges are scattered — exactly the case the reverse index exists for.
 */
function buildHubMap(): MapTile[] {
  const hubTile = makeTile(
    1,
    0,
    0,
    [{ id: 500, x: 200, y: 200, r: 10, kind: 1, etype: 0, key: 'capture:h', importance: 900 }],
    // The hub itself cites nothing.
    [],
  )
  // Claims in 1.1.0 citing the hub. Hub world position = (0+200, 0+200).
  const tileB = makeTile(
    1,
    1,
    0,
    [
      { id: 600, x: 50, y: 50, key: 'claim:b1' },
      { id: 601, x: 60, y: 60, key: 'claim:b2' },
    ],
    [
      // Target tile-local to THIS tile's origin (ox = 512): 200 - 512 = -312.
      { s: 0, t: 500, tx: -312, ty: 200 },
      { s: 1, t: 500, tx: -312, ty: 200 },
    ],
  )
  // Claims in 1.0.1 citing the same hub. oy = 512 → ty = 200 - 512 = -312.
  const tileC = makeTile(
    1,
    0,
    1,
    [{ id: 700, x: 80, y: 80, key: 'claim:c1' }],
    [{ s: 0, t: 500, tx: 200, ty: -312 }],
  )
  return [hubTile, tileB, tileC]
}

describe('resolveHighlight — claim focus (outgoing)', () => {
  it('returns the focus node and its outgoing edges in world coordinates', async () => {
    const tile = makeTile(
      1,
      1,
      0,
      [
        { id: 10, x: 100, y: 100, r: 5, key: 'claim:src' },
        { id: 11, x: 150, y: 120, r: 4, key: 'claim:other' },
      ],
      [
        { s: 0, t: 11, tx: 150, ty: 120 },
        { s: 0, t: 99, tx: -312, ty: 200 },
        // An edge from a DIFFERENT source in the same tile — must be ignored.
        { s: 1, t: 10, tx: 100, ty: 100 },
      ],
    )
    const store = await loadStore([tile])
    const focus = store.findByKey('claim:src')
    expect(focus).not.toBeNull()

    const highlight = resolveHighlight(store, focus!, { dimOthers: true })

    // World = tile origin + local. 1.1.0 origin is (512, 0).
    expect(highlight.focus).toEqual([{ wx: 612, wy: 100, r: 5 }])
    expect(highlight.dimOthers).toBe(true)
    expect(highlight.edges).toHaveLength(3)

    const outgoing = highlight.edges.filter((e) => e.x1 === 612 && e.y1 === 100)
    expect(outgoing).toHaveLength(2)
    expect(outgoing[0]).toEqual({ x1: 612, y1: 100, x2: 662, y2: 120 })
    // The off-tile target resolves through the tile-local offset: 512 - 312 = 200.
    expect(outgoing[1]).toEqual({ x1: 612, y1: 100, x2: 200, y2: 200 })
  })

  it('styles a resident neighbour from its own tile and a non-resident one as a plain dot', async () => {
    const tile = makeTile(
      1,
      1,
      0,
      [
        { id: 10, x: 100, y: 100, r: 5, key: 'claim:src' },
        { id: 11, x: 150, y: 120, r: 9, kind: 1, flags: 3, key: 'capture:x' },
      ],
      [
        { s: 0, t: 11, tx: 150, ty: 120 },
        { s: 0, t: 404, tx: 10, ty: 10 },
      ],
    )
    const store = await loadStore([tile])
    const highlight = resolveHighlight(store, store.findByKey('claim:src')!, { dimOthers: false })

    const resident = highlight.nodes.find((n) => n.wx === 662)
    expect(resident).toMatchObject({ r: 9, kind: 1, flags: 3 })
    // Not resident: still drawn, at the position the edge carried.
    const ghost = highlight.nodes.find((n) => n.wx === 522)
    expect(ghost).toMatchObject({ kind: 0, flags: 0 })
    expect(highlight.dimOthers).toBe(false)
  })

  it('does not list the focus node itself as its own neighbour', async () => {
    const tile = makeTile(
      0,
      0,
      0,
      [{ id: 10, x: 100, y: 100, key: 'claim:self' }],
      // A self-edge, which the weaver can legitimately produce.
      [{ s: 0, t: 10, tx: 100, ty: 100 }],
    )
    const store = await loadStore([tile])
    const highlight = resolveHighlight(store, store.findByKey('claim:self')!, { dimOthers: true })
    expect(highlight.edges).toHaveLength(1)
    expect(highlight.nodes).toHaveLength(0)
  })
})

describe('resolveHighlight — hub focus (incoming from several tiles)', () => {
  it('collects citing claims from every resident tile', async () => {
    const store = await loadStore(buildHubMap())
    const focus = store.findByKey('capture:h')
    expect(focus).not.toBeNull()

    const highlight = resolveHighlight(store, focus!, {
      dimOthers: true,
      neighborIndex: store.neighborIndex,
    })

    // Three claims across two other tiles all point at the hub at (200, 200).
    expect(highlight.edges).toHaveLength(3)
    for (const edge of highlight.edges) {
      expect(edge.x2).toBeCloseTo(200)
      expect(edge.y2).toBeCloseTo(200)
    }
    // Sources: 1.1.0 origin (512,0) + (50,50)/(60,60); 1.0.1 origin (0,512) + (80,80).
    const sources = highlight.edges.map((e) => `${e.x1},${e.y1}`).sort()
    expect(sources).toEqual(['562,50', '572,60', '80,592'].sort())
    expect(highlight.nodes).toHaveLength(3)
  })

  it('produces the same result with and without the reverse index', async () => {
    const store = await loadStore(buildHubMap())
    const focus = store.findByKey('capture:h')!

    const withIndex = resolveHighlight(store, focus, {
      dimOthers: true,
      neighborIndex: store.neighborIndex,
    })
    const scanned = resolveHighlight(store, focus, { dimOthers: true })

    expect(scanned.edges).toHaveLength(withIndex.edges.length)
    expect(new Set(scanned.edges.map((e) => `${e.x1},${e.y1}`))).toEqual(
      new Set(withIndex.edges.map((e) => `${e.x1},${e.y1}`)),
    )
  })

  it('caps the edge count', async () => {
    // One hub cited by 600 claims in a single tile.
    const hub = makeTile(1, 0, 0, [
      { id: 500, x: 200, y: 200, r: 10, kind: 1, key: 'capture:h', importance: 900 },
    ])
    const claims = makeTile(
      1,
      1,
      0,
      Array.from({ length: 600 }, (_, i) => ({ id: 1000 + i, x: i % 100, y: Math.floor(i / 100), key: `claim:${i}` })),
      Array.from({ length: 600 }, (_, i) => ({ s: i, t: 500, tx: -312, ty: 200 })),
    )
    const store = await loadStore([hub, claims])
    const focus = store.findByKey('capture:h')!

    const capped = resolveHighlight(store, focus, {
      dimOthers: true,
      neighborIndex: store.neighborIndex,
    })
    expect(capped.edges).toHaveLength(DEFAULT_MAX_HIGHLIGHT_EDGES)

    const tighter = resolveHighlight(store, focus, {
      dimOthers: true,
      maxEdges: 25,
      neighborIndex: store.neighborIndex,
    })
    expect(tighter.edges).toHaveLength(25)
  })

  it('returns an empty neighbourhood for an isolated node', async () => {
    const store = await loadStore([makeTile(0, 0, 0, [{ id: 1, x: 10, y: 10, key: 'claim:lonely' }])])
    const highlight = resolveHighlight(store, store.findByKey('claim:lonely')!, { dimOthers: true })
    expect(highlight.edges).toHaveLength(0)
    expect(highlight.nodes).toHaveLength(0)
    expect(highlight.focus).toHaveLength(1)
  })
})

describe('NeighborIndex', () => {
  function tileWithEdges(z: number, x: number, y: number, targets: number[]): MapTile {
    return makeTile(
      z,
      x,
      y,
      [{ id: 1000 + x * 10 + y, x: 10, y: 10 }],
      targets.map((t) => ({ s: 0, t, tx: 0, ty: 0 })),
    )
  }

  async function residentTiles(tiles: MapTile[]): Promise<ResidentTile[]> {
    const store = await loadStore(tiles)
    return store.residentTiles()
  }

  it('indexes incoming edges by target across tiles', async () => {
    const tiles = await residentTiles([
      tileWithEdges(1, 0, 0, [7, 7, 9]),
      tileWithEdges(1, 1, 0, [7]),
    ])
    const index = new NeighborIndex()
    for (const tile of tiles) index.addTile(tile)

    expect(index.incomingEdges(7)).toHaveLength(3)
    expect(index.incomingEdges(9)).toHaveLength(1)
    expect(index.incomingEdges(12345)).toHaveLength(0)
  })

  it('drops a tile’s entries on removal, keeping the others', async () => {
    const tiles = await residentTiles([
      tileWithEdges(1, 0, 0, [7, 9]),
      tileWithEdges(1, 1, 0, [7]),
    ])
    const index = new NeighborIndex()
    for (const tile of tiles) index.addTile(tile)

    index.removeTile(tiles[0])
    expect(index.incomingEdges(7)).toHaveLength(1)
    expect(index.incomingEdges(7)[0].tile).toBe(tiles[1])
    // 9 was only cited by the removed tile — the bucket is gone entirely.
    expect(index.incomingEdges(9)).toHaveLength(0)

    index.clear()
    expect(index.incomingEdges(7)).toHaveLength(0)
  })

  it('the store keeps its own index in step with residency', async () => {
    const store = await loadStore(buildHubMap())
    expect(store.neighborIndex.incomingEdges(500)).toHaveLength(3)
  })
})
