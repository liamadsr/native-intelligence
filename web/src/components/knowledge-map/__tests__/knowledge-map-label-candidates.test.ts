import { describe, expect, it } from 'vitest'
import {
  buildLabelCandidates,
  CLAIM_LABEL_MIN_K,
  EXAMINE_BUDGET,
  LABEL_MIN_TILE_ALPHA,
} from '../label-candidates'
import {
  MAX_NODE_SCREEN_RADIUS_PX,
  MIN_NODE_SCREEN_RADIUS_PX,
  nodeScreenRadiusPx,
  tileZoomAlpha,
} from '../lod'
import type { CameraState, ResidentTile, Viewport } from '../types'

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 }

interface NodeSpec {
  id: number
  /** Tile-local. */
  x: number
  y: number
  label: string
  /** 0 = claim, 1 = entity, 2 = virtual. */
  kind?: number
  importance?: number
  r?: number
}

/**
 * Build a tile whose node arrays are importance-ASCENDING, as the wire
 * contract guarantees — the backwards walk depends on it, so the fixture must
 * not quietly hand back a differently ordered array.
 */
function makeTile(opts: {
  id?: string
  z?: number
  ox?: number
  oy?: number
  size?: number
  nodes: NodeSpec[]
}): ResidentTile {
  const sorted = [...opts.nodes].sort((a, b) => (a.importance ?? 1) - (b.importance ?? 1))
  const n = sorted.length
  const tile: ResidentTile = {
    id: opts.id ?? `${opts.z ?? 0}.0.0`,
    z: opts.z ?? 0,
    x: 0,
    y: 0,
    ox: opts.ox ?? 0,
    oy: opts.oy ?? 0,
    size: opts.size ?? 1000,
    slab: 0,
    nodeCount: n,
    edgeCount: 0,
    nodeId: Uint32Array.from(sorted.map((s) => s.id)),
    nodeX: Float32Array.from(sorted.map((s) => s.x)),
    nodeY: Float32Array.from(sorted.map((s) => s.y)),
    nodeR: Float32Array.from(sorted.map((s) => s.r ?? 4)),
    nodeImportance: Float32Array.from(sorted.map((s) => s.importance ?? 1)),
    nodeDegree: new Uint32Array(n),
    nodeKind: Uint8Array.from(sorted.map((s) => s.kind ?? 0)),
    nodeFlags: new Uint8Array(n),
    nodeEtype: new Int16Array(n).fill(-1),
    keys: sorted.map((s) => `claim:${s.id}`),
    labels: sorted.map((s) => s.label),
    edgeSource: new Uint16Array(0),
    edgeTarget: new Uint32Array(0),
    edgeTX: new Float32Array(0),
    edgeTY: new Float32Array(0),
    edgeRel: new Uint8Array(0),
    loadedAt: 0,
    lastVisibleFrame: 0,
  }
  return tile
}

/** Camera centred on the tile's middle at a zoom where claims are readable. */
const CAMERA: CameraState = { x: 500, y: 500, k: 2 }

describe('buildLabelCandidates', () => {
  it('returns nodes importance-DESC, which is what selectLabels requires', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 480, y: 500, label: 'low', importance: 1 },
        { id: 2, x: 500, y: 500, label: 'high', importance: 9 },
        { id: 3, x: 520, y: 500, label: 'mid', importance: 5 },
      ],
    })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0 })
    expect(out.map((c) => c.text)).toEqual(['high', 'mid', 'low'])
  })

  it('skips nodes with an empty label', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: '', importance: 9 },
        { id: 2, x: 510, y: 500, label: 'kept', importance: 5 },
      ],
    })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0 })
    expect(out.map((c) => c.text)).toEqual(['kept'])
  })

  it('drops claims below CLAIM_LABEL_MIN_K but keeps entities and virtual hubs', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'claim', kind: 0, importance: 9 },
        { id: 2, x: 505, y: 500, label: 'entity', kind: 1, importance: 8 },
        { id: 3, x: 510, y: 500, label: 'virtual', kind: 2, importance: 7 },
      ],
    })
    const zoomedOut: CameraState = { x: 500, y: 500, k: CLAIM_LABEL_MIN_K - 0.2 }
    const out = buildLabelCandidates([tile], zoomedOut, VIEWPORT, { zc: 0 })
    expect(out.map((c) => c.text)).toEqual(['entity', 'virtual'])

    const zoomedIn: CameraState = { x: 500, y: 500, k: CLAIM_LABEL_MIN_K }
    const inOut = buildLabelCandidates([tile], zoomedIn, VIEWPORT, { zc: 0 })
    expect(inOut.map((c) => c.text)).toContain('claim')
  })

  it('assigns weight 0 to claims and weight 1 to entities and hubs', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'claim', kind: 0, importance: 3 },
        { id: 2, x: 505, y: 500, label: 'entity', kind: 1, importance: 2 },
        { id: 3, x: 510, y: 500, label: 'virtual', kind: 2, importance: 1 },
      ],
    })
    const byText = new Map(
      buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0 }).map((c) => [c.text, c.weight]),
    )
    expect(byText.get('claim')).toBe(0)
    expect(byText.get('entity')).toBe(1)
    expect(byText.get('virtual')).toBe(1)
  })

  it('skips nodes outside the viewport', () => {
    const tile = makeTile({
      size: 100_000,
      nodes: [
        { id: 1, x: 500, y: 500, label: 'onscreen', importance: 5 },
        // 50k world units away at k=2 is 100k CSS px off-screen.
        { id: 2, x: 50_000, y: 500, label: 'offscreen', importance: 9 },
      ],
    })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0 })
    expect(out.map((c) => c.text)).toEqual(['onscreen'])
  })

  it('converts world radius to a clamped screen radius', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'tiny', r: 0.01, importance: 2 },
        { id: 2, x: 505, y: 500, label: 'huge', r: 1000, importance: 1 },
      ],
    })
    const byText = new Map(
      buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0 }).map((c) => [
        c.text,
        c.screenRadiusPx,
      ]),
    )
    expect(byText.get('tiny')).toBe(MIN_NODE_SCREEN_RADIUS_PX)
    expect(byText.get('huge')).toBe(MAX_NODE_SCREEN_RADIUS_PX)
  })

  it('hangs a label off the radius the RENDERER paints, floor and all', () => {
    // The label offset is `screenRadiusPx + LABEL_GAP_PX`, so if this used a
    // plain `r * k` it would tuck a hub's name inside the hub's own disc at
    // every zoom below NODE_RADIUS_FLOOR_K — which is most of the time on a
    // real workspace. Pinned against the shared function, not a literal.
    // Entities, because at this zoom claim labels are switched off entirely
    // (CLAIM_LABEL_MIN_K) and the hubs are the signposts that still carry one.
    const zoomedOut: CameraState = { x: 500, y: 500, k: 0.05 }
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'small hub', kind: 1, r: 5.4, importance: 2 },
        { id: 2, x: 502, y: 500, label: 'big hub', kind: 1, r: 14, importance: 9 },
      ],
    })
    const byText = new Map(
      buildLabelCandidates([tile], zoomedOut, VIEWPORT, { zc: 0 }).map((c) => [
        c.text,
        c.screenRadiusPx,
      ]),
    )
    // Close-to, not exact: the tile stores radii as Float32, so 5.4 comes back
    // as 5.400000095… and an exact compare would be testing IEEE754.
    expect(byText.get('small hub')).toBeCloseTo(nodeScreenRadiusPx(5.4, 0.05), 6)
    expect(byText.get('big hub')).toBeCloseTo(nodeScreenRadiusPx(14, 0.05), 6)
    // And the point of the floor: the big hub is still visibly bigger out here,
    // where a plain `r * k` clamp would have made both exactly MIN.
    expect(byText.get('big hub')!).toBeGreaterThan(byText.get('small hub')!)
  })

  it('skips a whole tile whose zoom alpha is at or below LABEL_MIN_TILE_ALPHA', () => {
    // A z=3 tile at zc=2 has alpha 0 — it is not on screen yet.
    const deep = makeTile({ id: '3.0.0', z: 3, nodes: [{ id: 1, x: 500, y: 500, label: 'deep' }] })
    expect(tileZoomAlpha(2, 3)).toBeLessThanOrEqual(LABEL_MIN_TILE_ALPHA)
    expect(buildLabelCandidates([deep], CAMERA, VIEWPORT, { zc: 2 })).toEqual([])

    // Level 0 is always opaque, so it always contributes.
    const shallow = makeTile({ z: 0, nodes: [{ id: 2, x: 500, y: 500, label: 'overview' }] })
    expect(buildLabelCandidates([shallow], CAMERA, VIEWPORT, { zc: 2 })).toHaveLength(1)
  })

  it('still labels a FORCED node inside an otherwise faded tile', () => {
    const deep = makeTile({
      id: '3.0.0',
      z: 3,
      nodes: [
        { id: 1, x: 500, y: 500, label: 'forced', importance: 1 },
        { id: 2, x: 520, y: 500, label: 'ordinary', importance: 9 },
      ],
    })
    const out = buildLabelCandidates([deep], CAMERA, VIEWPORT, {
      zc: 2,
      forcedIds: new Set([1]),
    })
    expect(out.map((c) => c.text)).toEqual(['forced'])
    expect(out[0].forced).toBe(true)
  })

  it('forces a claim label even when the zoom is below CLAIM_LABEL_MIN_K', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'hovered claim', kind: 0, importance: 1 },
        { id: 2, x: 520, y: 500, label: 'other claim', kind: 0, importance: 9 },
      ],
    })
    const zoomedOut: CameraState = { x: 500, y: 500, k: 0.2 }
    const out = buildLabelCandidates([tile], zoomedOut, VIEWPORT, {
      zc: 0,
      forcedIds: new Set([1]),
    })
    expect(out.map((c) => c.text)).toEqual(['hovered claim'])
  })

  it('puts forced candidates first, ahead of more important unforced ones', () => {
    const tile = makeTile({
      nodes: [
        { id: 1, x: 500, y: 500, label: 'forced-low', importance: 1 },
        { id: 2, x: 510, y: 500, label: 'unforced-high', importance: 99 },
      ],
    })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, {
      zc: 0,
      forcedIds: new Set([1]),
    })
    expect(out[0].text).toBe('forced-low')
    expect(out[0].forced).toBe(true)
    expect(out[1].forced).toBeUndefined()
  })

  it('stops after the examine budget rather than walking the whole resident set', () => {
    const nodes: NodeSpec[] = []
    for (let i = 0; i < 4000; i++) {
      nodes.push({ id: i, x: 500, y: 500, label: `n${i}`, importance: i })
    }
    const tile = makeTile({ nodes })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0, examineBudget: 10 })
    // At most 10 nodes were looked at, so at most 10 came back — and because
    // the walk is backwards over an ascending array, they are the top 10.
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out[0].importance).toBe(3999)
  })

  it('caps the kept candidates independently of the examine budget', () => {
    const nodes: NodeSpec[] = []
    for (let i = 0; i < 1000; i++) {
      nodes.push({ id: i, x: 500, y: 500, label: `n${i}`, importance: i })
    }
    const tile = makeTile({ nodes })
    const out = buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0, maxCandidates: 12 })
    expect(out).toHaveLength(12)
  })

  it('stays bounded across many tiles (the 96-tile resident set)', () => {
    const tiles: ResidentTile[] = []
    for (let t = 0; t < 96; t++) {
      const nodes: NodeSpec[] = []
      for (let i = 0; i < 4000; i++) {
        nodes.push({ id: t * 4000 + i, x: 500, y: 500, label: 'x', importance: i })
      }
      tiles.push(makeTile({ id: `0.${t}.0`, nodes }))
    }
    const started = performance.now()
    const out = buildLabelCandidates(tiles, CAMERA, VIEWPORT, { zc: 0 })
    const elapsed = performance.now() - started
    // 96 × 4000 = 384k nodes exist; the budget means only EXAMINE_BUDGET are
    // inspected. This assertion is the whole point of the module.
    expect(out.length).toBeLessThanOrEqual(EXAMINE_BUDGET)
    expect(elapsed).toBeLessThan(120)
  })

  it('returns nothing for a degenerate camera or a zero budget', () => {
    const tile = makeTile({ nodes: [{ id: 1, x: 500, y: 500, label: 'a' }] })
    expect(buildLabelCandidates([tile], { x: 0, y: 0, k: 0 }, VIEWPORT, { zc: 0 })).toEqual([])
    expect(
      buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0, examineBudget: 0 }),
    ).toEqual([])
    expect(
      buildLabelCandidates([tile], CAMERA, VIEWPORT, { zc: 0, maxCandidates: 0 }),
    ).toEqual([])
  })

  it('handles an empty tile list', () => {
    expect(buildLabelCandidates([], CAMERA, VIEWPORT, { zc: 0 })).toEqual([])
  })

  it('anchors candidates in WORLD coordinates (tile origin + local offset)', () => {
    const tile = makeTile({ ox: 1000, oy: 2000, nodes: [{ id: 1, x: 10, y: 20, label: 'a' }] })
    const camera: CameraState = { x: 1010, y: 2020, k: 2 }
    const [c] = buildLabelCandidates([tile], camera, VIEWPORT, { zc: 0 })
    expect(c.wx).toBe(1010)
    expect(c.wy).toBe(2020)
  })
})
