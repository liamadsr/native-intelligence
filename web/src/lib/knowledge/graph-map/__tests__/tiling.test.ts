/**
 * Tiling invariants — the additive quadtree the client zooms through.
 *
 * The client's whole "zooming only ADDS nodes" promise rests on these: each
 * node lives in exactly one tile, a tile's region contains its nodes, and a
 * parent tile never holds a node less important than one in a descendant that
 * covers the same ground.
 */

import { describe, expect, it } from 'vitest'

import { layoutMap } from '../layout'
import { generateSyntheticMap, generateSyntheticRows } from '../synthetic'
import { tileMap } from '../tiling'
import {
  HARD_TILE_CAP,
  INLINE_NODE_BUDGET,
  MAX_Z,
  TILE_CAPACITY,
  TILE_EDGE_CAPACITY,
  tileId,
  type MapTile,
} from '../types'

const NOW = Date.UTC(2026, 8, 21)

/** A map big enough to force several levels of the quadtree. */
function bigMap() {
  return tileMap(layoutMap(generateSyntheticRows({ claims: 6000 })), {
    filters: {},
    version: 'v1',
    nowMs: NOW,
  })
}

describe('tiling invariants', () => {
  const built = bigMap()
  const tiles = Array.from(built.tiles.values())

  it('reaches more than one level (otherwise the rest proves nothing)', () => {
    expect(built.meta.maxZ).toBeGreaterThanOrEqual(1)
    expect(tiles.length).toBeGreaterThan(1)
  })

  it('places every kept node in exactly one tile', () => {
    const seen = new Map<string, number>()
    for (const t of tiles) {
      for (const key of t.nodes.key) seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, n] of seen) expect(n, `${key} appears ${n}×`).toBe(1)
    expect(seen.size).toBe(built.meta.counts.nodes)
  })

  it('respects TILE_CAPACITY, and HARD_TILE_CAP only at MAX_Z', () => {
    for (const t of tiles) {
      const cap = t.z === MAX_Z ? HARD_TILE_CAP : TILE_CAPACITY
      expect(t.nodes.key.length, `tile ${tileId(t.z, t.x, t.y)}`).toBeLessThanOrEqual(cap)
    }
  })

  it('contains each node inside its own tile region', () => {
    for (const t of tiles) {
      for (let i = 0; i < t.nodes.key.length; i++) {
        // Tile-local coords must land inside [0, size]. A small epsilon covers
        // the deliberate Float32 round-trip on the wire.
        expect(t.nodes.x[i]).toBeGreaterThanOrEqual(-1e-3)
        expect(t.nodes.y[i]).toBeGreaterThanOrEqual(-1e-3)
        expect(t.nodes.x[i]).toBeLessThanOrEqual(t.size + 1e-3)
        expect(t.nodes.y[i]).toBeLessThanOrEqual(t.size + 1e-3)
      }
    }
  })

  it('never puts a node in a descendant tile that outranks one in its ancestor', () => {
    // The additive/shallowest-with-capacity property, checked per region: for
    // a tile and each of its ancestors, every node here must be no more
    // important than the LEAST important node up there — otherwise it should
    // have taken that slot instead.
    const byId = new Map(tiles.map((t) => [tileId(t.z, t.x, t.y), t]))
    for (const t of tiles) {
      if (t.nodes.key.length === 0) continue
      const maxHere = Math.max(...t.nodes.importance)
      for (let z = 0; z < t.z; z++) {
        const shift = t.z - z
        const anc = byId.get(tileId(z, t.x >> shift, t.y >> shift))
        if (!anc || anc.nodes.key.length === 0) continue
        // An ancestor with spare capacity should have absorbed this node.
        expect(anc.nodes.key.length).toBe(TILE_CAPACITY)
        const minThere = Math.min(...anc.nodes.importance)
        expect(maxHere).toBeLessThanOrEqual(minThere)
      }
    }
  })

  it('orders each tile\'s columns by importance ASCENDING', () => {
    for (const t of tiles) {
      for (let i = 1; i < t.nodes.importance.length; i++) {
        expect(t.nodes.importance[i]).toBeGreaterThanOrEqual(t.nodes.importance[i - 1])
      }
    }
  })

  it('gives no two nodes the same coordinates', () => {
    const seen = new Set<string>()
    for (const t of tiles) {
      for (let i = 0; i < t.nodes.key.length; i++) {
        const world = `${t.ox + t.nodes.x[i]},${t.oy + t.nodes.y[i]}`
        expect(seen.has(world), `duplicate position ${world}`).toBe(false)
        seen.add(world)
      }
    }
  })

  it('ships edges with valid source indices and existing target ids', () => {
    const allIds = new Set<number>()
    for (const t of tiles) for (const id of t.nodes.id) allIds.add(id)
    for (const t of tiles) {
      expect(t.edges.s.length).toBeLessThanOrEqual(TILE_EDGE_CAPACITY)
      for (let i = 0; i < t.edges.s.length; i++) {
        expect(t.edges.s[i]).toBeGreaterThanOrEqual(0)
        expect(t.edges.s[i]).toBeLessThan(t.nodes.key.length)
        expect(allIds.has(t.edges.t[i]), `edge target ${t.edges.t[i]} missing`).toBe(true)
      }
    }
  })

  it('points each edge\'s (tx, ty) at the target\'s real world position', () => {
    const byId = new Map<number, [number, number]>()
    for (const t of tiles) {
      for (let i = 0; i < t.nodes.id.length; i++) {
        byId.set(t.nodes.id[i], [t.ox + t.nodes.x[i], t.oy + t.nodes.y[i]])
      }
    }
    for (const t of tiles) {
      for (let i = 0; i < t.edges.s.length; i++) {
        const [wx, wy] = byId.get(t.edges.t[i]) as [number, number]
        expect(Math.abs(t.ox + t.edges.tx[i] - wx)).toBeLessThan(0.5)
        expect(Math.abs(t.oy + t.edges.ty[i] - wy)).toBeLessThan(0.5)
      }
    }
  })

  it('matches manifest counts to the tiles, sorted by (z, x, y)', () => {
    expect(built.meta.manifest.length).toBe(tiles.length)
    for (const [z, x, y, nodes, edges] of built.meta.manifest) {
      const t = built.tiles.get(tileId(z, x, y)) as MapTile
      expect(t).toBeDefined()
      expect(t.nodes.key.length).toBe(nodes)
      expect(t.edges.s.length).toBe(edges)
    }
    const sorted = built.meta.manifest
      .slice()
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    expect(built.meta.manifest).toEqual(sorted)
  })

  it('assigns numeric ids by ascending key order', () => {
    const pairs: Array<[string, number]> = []
    for (const t of tiles) {
      for (let i = 0; i < t.nodes.key.length; i++) pairs.push([t.nodes.key[i], t.nodes.id[i]])
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    pairs.forEach(([, id], i) => expect(id).toBe(i))
  })

  it('inlines whole tiles in ascending z within INLINE_NODE_BUDGET', () => {
    let total = 0
    for (const t of built.inline) total += t.nodes.key.length
    // Either everything fits, or the budget stopped it.
    expect(built.inline.length).toBeGreaterThan(0)
    if (built.inline.length < tiles.length) {
      expect(total).toBeLessThanOrEqual(INLINE_NODE_BUDGET)
    }
    for (let i = 1; i < built.inline.length; i++) {
      const a = built.inline[i - 1]
      const b = built.inline[i]
      expect(a.z <= b.z).toBe(true)
    }
    // 0.0.0 is always first when it exists.
    expect(tileId(built.inline[0].z, built.inline[0].x, built.inline[0].y)).toBe('0.0.0')
  })

  it('keeps the world square and independent of filters', () => {
    const map = layoutMap(generateSyntheticRows({ claims: 800 }))
    const all = tileMap(map, { filters: {}, version: 'v', nowMs: NOW })
    const filtered = tileMap(map, {
      filters: { where: [{ field: 'confirmation', op: 'is', value: ['confirmed'] }] },
      version: 'v',
      nowMs: NOW,
    })
    expect(filtered.meta.world).toEqual(all.meta.world)
  })
})

describe('synthetic fast path', () => {
  it('tiles a 200k-node map and reaches z ≥ 3', () => {
    const map = generateSyntheticMap({ nodes: 200_000 })
    const built = tileMap(map, { filters: {}, version: 'v', nowMs: NOW })
    expect(built.meta.maxZ).toBeGreaterThanOrEqual(3)
    expect(built.tiles.size).toBeGreaterThan(10)

    // The same one-tile-per-node invariant must hold at this size too.
    let nodes = 0
    for (const t of built.tiles.values()) nodes += t.nodes.key.length
    expect(nodes + sumDropped(built)).toBe(map.count)
  })

  it('keeps the hub-and-spoke shape (~10 claims per hub)', () => {
    const map = generateSyntheticMap({ nodes: 11_000 })
    const hubs = map.count - map.claimCount
    expect(map.claimCount / hubs).toBeGreaterThan(8)
    expect(map.claimCount / hubs).toBeLessThan(12)
  })
})

function sumDropped(built: ReturnType<typeof tileMap>): number {
  let n = 0
  for (const t of built.tiles.values()) n += t.dropped
  return n
}

describe('performance', () => {
  it('lays out and tiles 20k synthetic claims in under 3 s', () => {
    const rows = generateSyntheticRows({ claims: 20_000 })
    const start = performance.now()
    const built = tileMap(layoutMap(rows), { filters: {}, version: 'v', nowMs: NOW })
    const elapsed = performance.now() - start
    expect(built.meta.counts.nodes).toBeGreaterThan(15_000)
    // Asserted loosely: this machine does it in ~150 ms, CI is much slower.
    expect(elapsed).toBeLessThan(3000)
  })
})
