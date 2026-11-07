/**
 * Layout — online, deterministic, stable under appends.
 *
 * No simulation. Every position is a pure function of rows that do not change
 * when new rows are appended: a claim sits on its hub's phyllotaxis spiral at a
 * slot it owns forever, and a hub is placed against only the hubs born before
 * it. See docs/KNOWLEDGE_MAP_ARCHITECTURE.md §4.2.
 *
 * Internals are struct-of-arrays: 1M nodes must not mean 1M objects.
 */

import {
  buildGraph,
  claimTypeIndex,
  hubTypeWeight,
  UNFILED_RESERVED_CAPACITY,
  type BuiltGraph,
} from './graph-build'
import { hash01 } from './hash'
import {
  DISC_PAD,
  FLAG_CLAIM_TYPE_SHIFT,
  FLAG_SUGGESTED,
  HUB_R0,
  NODE_KIND,
  SLOT_JITTER,
  SPACING,
  type NodeKey,
  type NodeKindCode,
  type SourceRows,
} from './types'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Sentinels for "this claim has no value in that column".
 *
 * Every one is picked so it cannot collide with a real value, which is the
 * whole game: `claim.confidence` is bounded to [0, 1] by a CHECK constraint so
 * any negative is unambiguous, `scope` and `auto_accepted` have two and three
 * inhabitants so 255 is free, and a timestamp of 0 would be 1970 — a date a
 * filter can legitimately ask about — so dates use NaN, which additionally
 * makes every ordered comparison false exactly the way a Postgres null does.
 */
export const NO_CONFIDENCE = -1
export const NO_CODE = 255
export const NO_INDEX = -1

/** `claimScope` codes. Kept next to the sentinel they share an array with. */
export const SCOPE_CODE = { workspace: 0, personal: 1 } as const

/**
 * The laid-out map. Opaque to callers — `tileMap` is the only reader. Node
 * arrays hold claims first (indices `0..claimCount-1`), then hubs.
 */
export interface LaidOutMap {
  /** Node count = claims + hubs. */
  count: number
  claimCount: number

  keys: NodeKey[]
  /**
   * Hubs: the short display label, already truncated in `graph-build`.
   * Claims: the FULL claim text, held as a pointer into the source row.
   *
   * Asymmetric on purpose. A hub label is a name and is short by nature; a
   * claim is a sentence, and the `text` filter has to see all of it or the map
   * answers "contains" differently from the SQL list. `tiling.ts` truncates
   * the claim side once per tile, where the wire actually needs it.
   */
  labels: string[]
  kind: Uint8Array
  /** Index into `entityTypes`; -1 for claims and virtual hubs. */
  etype: Int16Array
  x: Float64Array
  y: Float64Array
  r: Float32Array
  importance: Float32Array
  degree: Uint32Array
  flags: Uint8Array

  /**
   * Per-claim columns the mask filters on (indexed like the first
   * `claimCount` nodes).
   *
   * COST, honestly: the five columns added for the full filter vocabulary are
   * 1 + 1 + 4 + 8 + 8 = 22 bytes per claim (scope, auto_accepted, created_by
   * index, event_at, last_verified_at), plus one string-table entry per
   * DISTINCT author — a handful per workspace, not one per claim. At 10⁵
   * claims that is 2.2 MB on top of the ~3 MB the existing columns take, held
   * once per cached layout. It is paid back twice over by `labels` no longer
   * allocating a truncated copy of every claim's text.
   */
  claimIds: string[]
  /** -1 (`NO_CONFIDENCE`) when the claim has no confidence. */
  claimConfidence: Float32Array
  claimCreatedAt: Float64Array
  claimTypeIdx: Uint8Array
  claimConfirmed: Uint8Array
  /** `SCOPE_CODE` value, or `NO_CODE`. */
  claimScope: Uint8Array
  /** 0 | 1, or `NO_CODE`. */
  claimAutoAccepted: Uint8Array
  /** Index into `claimCreators`, or `NO_INDEX`. */
  claimCreatedBy: Int32Array
  /** Distinct lower-cased author member ids, in first-seen (claim) order. */
  claimCreators: string[]
  /** NaN when unset. */
  claimEventAt: Float64Array
  /** NaN when unset. */
  claimLastVerifiedAt: Float64Array
  /** Node index of each claim's primary hub. */
  claimHub: Uint32Array
  /** CSR adjacency: hub node indices each claim links to (project filter). */
  claimHubOffsets: Uint32Array
  claimHubTargets: Uint32Array

  /** Edges by node index. */
  edgeSource: Uint32Array
  edgeTarget: Uint32Array
  edgeRel: Uint8Array

  entityTypes: string[]
  relations: string[]
  projects: Array<{ id: string; label: string }>
  /** Square world bounds of ALL placed discs, padded — never filtered. */
  world: { minX: number; minY: number; size: number }
}

/**
 * `max(32, nextPow2(ceil(2·n)))` over a hub's claim count.
 *
 * The argument USED TO BE the birth count specifically, because a reserved
 * radius is an input to the placement of every hub after it and so had to be
 * a number that could not grow under an append. The cost was that a hub which
 * outgrew its birth cohort — a project that collects claims for months — kept
 * a disc sized for its first day and spilled its outer slots across its
 * neighbours.
 *
 * Ordering by degree gave that guarantee up anyway (see `layoutBuiltGraph`),
 * and once the layout is rebuilt from current facts the birth count is simply
 * the wrong number: it reserves the middle of the map, where the biggest hubs
 * now sit, for a fraction of what they hold. Sizing from `rowCount` — every
 * row ever homed here, so it matches the outermost slot a claim can occupy —
 * is what keeps those central clusters from overlapping each other.
 *
 * Headroom stays 2× (and the floor 32) so claims arriving between rebuilds
 * still land inside the disc their hub already holds.
 */
export function discCapacity(claimCount: number): number {
  const want = Math.ceil(2 * claimCount)
  let cap = 32
  while (cap < want) cap *= 2
  return cap
}

/** Reserved radius of a hub's disc. The ONLY radius placement ever sees. */
export function discRadius(claimCount: number): number {
  return radiusForCapacity(discCapacity(claimCount))
}

function radiusForCapacity(capacity: number): number {
  return HUB_R0 + SPACING * Math.sqrt(capacity) * (1 + SLOT_JITTER) + DISC_PAD
}

/**
 * Reserved radius of a hub. Virtual `unfiled:` hubs use a fixed capacity: they
 * are per-viewer catch-alls whose membership depends on what the viewer cannot
 * read, so sizing them from their contents would make them the one thing on the
 * map whose geometry varies between viewers.
 */
export function reservedRadius(hub: { virtual: boolean; rowCount: number }): number {
  return hub.virtual
    ? radiusForCapacity(UNFILED_RESERVED_CAPACITY)
    : discRadius(hub.rowCount)
}

/**
 * DEGREE → WORLD RADIUS. The map's only visual statement about importance:
 * a node's area is how connected it is.
 *
 * These were `min(2.6 + √(d+1), 9)` for claims and `min(4 + 1.4·√(d+1), 14)`
 * for hubs, and they failed in two ways that read, from the outside, as the
 * size signal being BACKWARDS.
 *
 * First, `√` saturates almost immediately. A claim hit its ceiling at degree
 * 40 and a hub at 51, so the 1,614-claim project hub that dominates a real
 * workspace painted at exactly the same size as one holding 51 — the map's
 * biggest structures were indistinguishable from its middling ones, and the
 * only nodes still visibly growing were the small ones. `log2` keeps climbing
 * where `√` has flattened: a hub now separates all the way to ~440 links.
 *
 * Second — and this was the actual inversion — a VIRTUAL `unfiled:<month>` hub
 * was a hard-coded 5, whatever it held. An unfiled bucket aggregating 300
 * claims painted SMALLER than a real entity with zero (which starts at 5.7),
 * so on a workspace with unfiled captures the most-connected thing on screen
 * was one of the smallest dots. Virtual hubs now answer to degree like
 * everything else, on a slightly recessive curve because they are a
 * placeholder for filing that has not happened, not a thing in the world.
 *
 * The ceilings are geometry, not taste. A hub is drawn concentric with the
 * phyllotaxis spiral of its own claims, whose innermost slot sits at
 * `HUB_R0 + SPACING·√0.5·(1 − SLOT_JITTER)` ≈ 26.4 world units; a hub drawn
 * past that paints over its own first ring. 17 leaves room for that claim's
 * own radius and a visible gap.
 */
export function claimRadius(degree: number): number {
  return Math.min(1.6 + 0.75 * Math.log2(degree + 2), 8)
}

export function hubRadius(degree: number, virtual: boolean): number {
  return virtual
    ? Math.min(3.2 + 1.3 * Math.log2(degree + 2), 14)
    : Math.min(4 + 1.5 * Math.log2(degree + 2), 17)
}

/** Phyllotaxis offset of `slot` around a hub whose key seeds the phase. */
export function slotOffset(
  slot: number,
  claimKey: NodeKey,
  hubPhase: number,
): { dx: number; dy: number } {
  const h = hash01(claimKey)
  const radius =
    HUB_R0 + SPACING * Math.sqrt(slot + 0.5) * (1 + SLOT_JITTER * (2 * h - 1))
  const theta = slot * GOLDEN_ANGLE + hubPhase
  return { dx: radius * Math.cos(theta), dy: radius * Math.sin(theta) }
}

/**
 * Uniform spatial hash over placed discs. Cell size is the largest disc
 * diameter seen so far, and every disc is registered in each cell its bounding
 * box touches, so an overlap test only looks at the cells the candidate's own
 * box touches.
 */
class DiscGrid {
  private cell: number
  private buckets = new Map<number, number[]>()
  private cx: number[] = []
  private cy: number[] = []
  private cr: number[] = []

  constructor(cell: number) {
    this.cell = Math.max(cell, 1)
  }

  private key(ix: number, iy: number): number {
    // Interleave-free 2D key: cheap, collision-free for |index| < 2^20.
    return (ix + 0x80000) * 0x100000 + (iy + 0x80000)
  }

  /** Rebuild at a larger cell size when a disc no longer fits the block rule. */
  private rehash(cell: number): void {
    this.cell = cell
    this.buckets = new Map()
    for (let i = 0; i < this.cx.length; i++) this.index(i)
  }

  private index(i: number): void {
    const r = this.cr[i]
    // Register the disc in every cell its bounding box touches, so an overlap
    // test only has to look at the cells the CANDIDATE's own bbox touches.
    const x0 = Math.floor((this.cx[i] - r) / this.cell)
    const x1 = Math.floor((this.cx[i] + r) / this.cell)
    const y0 = Math.floor((this.cy[i] - r) / this.cell)
    const y1 = Math.floor((this.cy[i] + r) / this.cell)
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = this.key(gx, gy)
        const bucket = this.buckets.get(k)
        if (bucket) bucket.push(i)
        else this.buckets.set(k, [i])
      }
    }
  }

  add(x: number, y: number, r: number): void {
    if (2 * r > this.cell) this.rehash(2 * r)
    this.cx.push(x)
    this.cy.push(y)
    this.cr.push(r)
    this.index(this.cx.length - 1)
  }

  /** True when a disc of radius `r` at (x, y) overlaps any placed disc. */
  overlaps(x: number, y: number, r: number): boolean {
    const ix = Math.floor(x / this.cell)
    const iy = Math.floor(y / this.cell)
    // Discs are registered in every cell their bbox touches, so a candidate
    // only has to look at the cells ITS OWN bbox touches.
    const reach = Math.max(1, Math.ceil(r / this.cell))
    for (let gx = ix - reach; gx <= ix + reach; gx++) {
      for (let gy = iy - reach; gy <= iy + reach; gy++) {
        const bucket = this.buckets.get(this.key(gx, gy))
        if (!bucket) continue
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi]
          const dx = this.cx[j] - x
          const dy = this.cy[j] - y
          const rr = this.cr[j] + r
          if (dx * dx + dy * dy < rr * rr) return true
        }
      }
    }
    return false
  }
}

/**
 * Nearest non-overlapping spot on an Archimedean spiral around `target`.
 *
 * A spiral has to sample about one disc-width apart or it would step over a
 * free pocket, so a search that starts inside an already-packed region costs
 * O(area) probes. Hubs are placed in birth order into one growing blob, so
 * without help that is superlinear over a run.
 *
 * `skipRadius` starts the walk further out. The caller passes how far the
 * packing already reaches (see `packedRadius` in `layoutBuiltGraph`), trading
 * a little packing density for a flat per-hub cost.
 */
function spiralPlace(
  grid: DiscGrid,
  tx: number,
  ty: number,
  r: number,
  phase: number,
  skipRadius: number,
): { x: number; y: number; radius: number } {
  if (skipRadius <= 0 && !grid.overlaps(tx, ty, r)) {
    return { x: tx, y: ty, radius: 0 }
  }
  // Step along the spiral so consecutive candidates are about one disc apart:
  // that is the coarsest sampling that cannot skip a free pocket for a disc of
  // this size.
  const step = Math.max(r, 1)
  let radius = Math.max(step, skipRadius)
  let angle = phase
  // Bound the search so a pathological packing degrades instead of hanging.
  for (let i = 0; i < 1_000_000; i++) {
    const x = tx + radius * Math.cos(angle)
    const y = ty + radius * Math.sin(angle)
    if (!grid.overlaps(x, y, r)) return { x, y, radius }
    // Advance by an arc length of one step; grow the radius a little each turn.
    const dAngle = Math.min(step / radius, Math.PI / 3)
    angle += dAngle
    radius += (step * dAngle) / (2 * Math.PI)
  }
  return { x: tx + radius, y: ty, radius }
}

/** Graph build + layout over the UNFILTERED rows. */
export function layoutMap(rows: SourceRows): LaidOutMap {
  return layoutBuiltGraph(buildGraph(rows))
}

export function layoutBuiltGraph(graph: BuiltGraph): LaidOutMap {
  const { claims, hubs, edges } = graph
  const claimCount = claims.length
  const hubCount = hubs.length
  const count = claimCount + hubCount

  /**
   * Hub order: DEGREE DESCENDING, then firstSeen, then key.
   *
   * Placement order IS the radial order. Hubs are packed into one growing
   * blob from the origin outward, and `packedRadius` starts each search at
   * the frontier the last one reached — so whatever is placed first takes the
   * middle and whatever is placed last takes the rim. Sorting by degree is
   * therefore the whole of "the more connections a node has, the more toward
   * the centre it sits"; there is no separate centrality pass.
   *
   * THIS ORDER USED TO BE `firstSeen`, and that was a deliberate, documented
   * property, not an oversight: a hub's birth time cannot change, so the
   * layout was a pure function of immutable facts and an appended row could
   * never move a node already on the map. Degree is not immutable, so that
   * guarantee is gone by construction — a hub that overtakes another in
   * connections will swap places with it the next time the layout is built.
   *
   * That was the trade accepted when this changed: the map now encodes what
   * the graph looks like NOW rather than the order it was assembled in, at
   * the cost of re-arranging when the graph materially changes (a weaver run,
   * a batch of captures). It costs nothing at render time — positions are
   * still computed once, server-side, and the frame path never sees this.
   *
   * Age remains the tie-break, so two equally-connected hubs still land in a
   * stable, replayable order.
   */
  const order = new Uint32Array(hubCount)
  for (let i = 0; i < hubCount; i++) order[i] = i
  const orderArr = Array.from(order)
  orderArr.sort((a, b) => {
    const da = hubs[a].degree
    const db = hubs[b].degree
    if (da !== db) return db - da
    const fa = hubs[a].firstSeen
    const fb = hubs[b].firstSeen
    if (fa !== fb) return fa - fb
    return hubs[a].key < hubs[b].key ? -1 : hubs[a].key > hubs[b].key ? 1 : 0
  })

  const hubX = new Float64Array(hubCount)
  const hubY = new Float64Array(hubCount)
  const hubR = new Float64Array(hubCount)
  const placed = new Uint8Array(hubCount)

  let maxR = 0
  for (let i = 0; i < hubCount; i++) {
    hubR[i] = reservedRadius(hubs[i])
    if (hubR[i] > maxR) maxR = hubR[i]
  }

  const grid = new DiscGrid(2 * Math.max(maxR, 1))

  /**
   * How far the packing has already spread from the world origin.
   *
   * Hubs are placed in birth order into a single growing blob, so a search
   * that has to escape the blob crosses the same frontier whatever its target.
   * Without this memo each hub re-walks that blob from the inside: the spiral
   * must sample about one disc-width apart (or it would step over a free
   * pocket), so the cost per hub grows with the blob's area — measured at
   * ~2000 probes per hub at 10k hubs, and still climbing.
   *
   * Every hub that settled at distance D from the origin proves the disc of
   * radius D was full at that moment, and discs are never removed. So a later
   * search may begin its spiral that far out. Measured: ~10 probes per hub,
   * flat from 2.5k to 50k hubs.
   *
   * The trade is density, not correctness: hubs no longer backfill pockets
   * their predecessors left behind, so the packing settles at roughly 1.6× the
   * theoretical minimum radius. On a map that gets panned and zoomed rather
   * than measured, that is invisible — and it is what buys the 100k-hub target.
   *
   * Monotonic, and a function only of the RESERVED radii of hubs placed
   * earlier in THIS build. It is what turns placement order into radial
   * order: a hub arriving after the blob has spread to D starts its spiral at
   * D, so it cannot backfill toward the middle. Combined with the
   * degree-descending order above, that is the whole "well-connected in the
   * centre, loners at the rim" arrangement.
   *
   * It no longer carries an append-stability guarantee — it used to, when the
   * order and the reserved radii were both functions of immutable birth-time
   * facts. A replay over identical rows is still exactly deterministic, which
   * is what the cache and the tests rely on; what changed is that appending
   * rows is no longer identical rows.
   */
  let packedRadius = 0

  const neighbourWeight = new Map<number, number>()
  for (const hi of orderArr) {
    // Target = co-citation-weighted barycentre of already-placed BIRTH
    // neighbours; none → world origin. Birth neighbours are frozen in
    // graph-build from links inside the hub's 24 h birth window, so a link
    // written later can never re-target a hub that is already on the map.
    neighbourWeight.clear()
    for (const [t, w] of graph.birthNeighbours[hi]) {
      if (t === hi || !placed[t]) continue
      neighbourWeight.set(t, w)
    }

    let tx = 0
    let ty = 0
    let wsum = 0
    // Iterate a sorted key list: Map iteration order follows insertion, which
    // follows the (deterministic) claim order — but sorting makes it explicit.
    const neighbours = Array.from(neighbourWeight.keys()).sort((a, b) => a - b)
    for (const n of neighbours) {
      const w = neighbourWeight.get(n) as number
      tx += hubX[n] * w
      ty += hubY[n] * w
      wsum += w
    }
    const atOrigin = wsum === 0
    if (!atOrigin) {
      tx /= wsum
      ty /= wsum
    } else {
      tx = 0
      ty = 0
    }

    const phase = 2 * Math.PI * hash01(hubs[hi].key, 0x9e3779b9)
    // `packedRadius` is measured from the origin; the spiral is centred on the
    // target, so the skip is how far the spiral must reach to clear the blob.
    const distToOrigin = Math.hypot(tx, ty)
    const skip = Math.max(0, packedRadius - distToOrigin)
    const spot = spiralPlace(grid, tx, ty, hubR[hi], phase, skip)
    hubX[hi] = spot.x
    hubY[hi] = spot.y
    grid.add(spot.x, spot.y, hubR[hi])
    placed[hi] = 1
    const reach = Math.hypot(spot.x, spot.y)
    if (reach > packedRadius) packedRadius = reach
  }

  // ── Node arrays: claims first, then hubs. ──
  const keys: NodeKey[] = new Array(count)
  const labels: string[] = new Array(count)
  const kind = new Uint8Array(count)
  const etype = new Int16Array(count)
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const r = new Float32Array(count)
  const importance = new Float32Array(count)
  const degree = new Uint32Array(count)
  const flags = new Uint8Array(count)

  const etypeIndex = new Map<string, number>()
  graph.entityTypes.forEach((t, i) => etypeIndex.set(t, i))

  const hubPhase = new Float64Array(hubCount)
  for (let h = 0; h < hubCount; h++) {
    hubPhase[h] = 2 * Math.PI * hash01(hubs[h].key)
  }

  const claimIds: string[] = new Array(claimCount)
  const claimConfidence = new Float32Array(claimCount)
  const claimCreatedAt = new Float64Array(claimCount)
  const claimTypeIdx = new Uint8Array(claimCount)
  const claimConfirmed = new Uint8Array(claimCount)
  const claimScope = new Uint8Array(claimCount)
  const claimAutoAccepted = new Uint8Array(claimCount)
  const claimCreatedBy = new Int32Array(claimCount)
  const claimEventAt = new Float64Array(claimCount)
  const claimLastVerifiedAt = new Float64Array(claimCount)
  const claimHub = new Uint32Array(claimCount)

  // Authors are a tiny closed set (workspace members plus a few agents), so
  // they go in a string table and the per-claim column holds an index. A
  // `string[]` of uuids would be 36 bytes and one object header per claim for
  // a value with, in practice, under a hundred distinct inhabitants.
  const claimCreators: string[] = []
  const creatorIndex = new Map<string, number>()

  for (let c = 0; c < claimCount; c++) {
    const claim = claims[c]
    const h = claim.hub
    const off = slotOffset(claim.slot, claim.key, hubPhase[h])
    keys[c] = claim.key
    labels[c] = claim.text
    kind[c] = NODE_KIND.claim
    etype[c] = -1
    x[c] = hubX[h] + off.dx
    y[c] = hubY[h] + off.dy
    r[c] = claimRadius(claim.degree)
    importance[c] =
      (claim.confirmed ? 2 : 1) +
      (claim.confidence ?? 0.5) +
      Math.log2(1 + claim.degree)
    degree[c] = claim.degree
    let f = claim.confirmed ? 0 : FLAG_SUGGESTED
    const typeIdx = claimTypeIndex(claim.type)
    f |= typeIdx << FLAG_CLAIM_TYPE_SHIFT
    flags[c] = f

    claimIds[c] = claim.id
    claimConfidence[c] = claim.confidence === null ? NO_CONFIDENCE : claim.confidence
    claimCreatedAt[c] = claim.createdAt
    claimTypeIdx[c] = typeIdx < 0 ? 0 : typeIdx
    claimConfirmed[c] = claim.confirmed ? 1 : 0
    claimScope[c] = claim.scope === null ? NO_CODE : SCOPE_CODE[claim.scope]
    claimAutoAccepted[c] =
      claim.autoAccepted === null ? NO_CODE : claim.autoAccepted ? 1 : 0
    claimEventAt[c] = claim.eventAt
    claimLastVerifiedAt[c] = claim.lastVerifiedAt
    // Lower-cased once, here, so the mask compares ids without re-casing a
    // uuid per claim per predicate. Postgres hands uuids back lower-case but
    // a filter value arrives however the client wrote it.
    if (claim.createdBy === null) {
      claimCreatedBy[c] = NO_INDEX
    } else {
      const author = claim.createdBy.toLowerCase()
      let at = creatorIndex.get(author)
      if (at === undefined) {
        at = claimCreators.length
        claimCreators.push(author)
        creatorIndex.set(author, at)
      }
      claimCreatedBy[c] = at
    }
    claimHub[c] = claimCount + h
  }

  for (let h = 0; h < hubCount; h++) {
    const hub = hubs[h]
    const n = claimCount + h
    keys[n] = hub.key
    labels[n] = hub.label
    kind[n] = hub.virtual ? NODE_KIND.virtual : NODE_KIND.entity
    etype[n] = hub.virtual ? -1 : (etypeIndex.get(hub.type) ?? -1)
    x[n] = hubX[h]
    y[n] = hubY[h]
    r[n] = hubRadius(hub.degree, hub.virtual)
    importance[n] =
      1000 +
      (hub.virtual ? 0.5 : hubTypeWeight(hub.type)) +
      Math.log2(1 + hub.degree)
    degree[n] = hub.degree
    flags[n] = 0
  }

  // ── CSR adjacency for the project filter. ──
  const claimHubOffsets = new Uint32Array(claimCount + 1)
  for (let c = 0; c < claimCount; c++) {
    claimHubOffsets[c + 1] = claimHubOffsets[c] + graph.claimHubTargets[c].length
  }
  const claimHubTargets = new Uint32Array(claimHubOffsets[claimCount])
  for (let c = 0; c < claimCount; c++) {
    const base = claimHubOffsets[c]
    const list = graph.claimHubTargets[c]
    for (let i = 0; i < list.length; i++) claimHubTargets[base + i] = claimCount + list[i]
  }

  // ── Edges in node-index space. ──
  const edgeSource = new Uint32Array(edges.length)
  const edgeTarget = new Uint32Array(edges.length)
  const edgeRel = new Uint8Array(edges.length)
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    edgeSource[i] = e.source
    edgeTarget[i] = e.targetIsClaim ? e.target : claimCount + e.target
    edgeRel[i] = Math.min(e.rel, 255)
  }

  return {
    count,
    claimCount,
    keys,
    labels,
    kind: kind as Uint8Array & { [k: number]: NodeKindCode },
    etype,
    x,
    y,
    r,
    importance,
    degree,
    flags,
    claimIds,
    claimConfidence,
    claimCreatedAt,
    claimTypeIdx,
    claimConfirmed,
    claimScope,
    claimAutoAccepted,
    claimCreatedBy,
    claimCreators,
    claimEventAt,
    claimLastVerifiedAt,
    claimHub,
    claimHubOffsets,
    claimHubTargets,
    edgeSource,
    edgeTarget,
    edgeRel,
    entityTypes: graph.entityTypes,
    relations: graph.relations,
    projects: graph.projects,
    // Over every node, plus each hub's RESERVED disc — a claim that overflowed
    // its hub's disc must still be inside the world box, and an empty hub must
    // still contribute the disc it reserved.
    world: unionBounds(
      worldBounds(x, y, r, count),
      worldBounds(hubX, hubY, hubR, hubCount),
    ),
  }
}

/**
 * Square bbox of ACTUAL node positions (+ radii), padded 5% (§4.3).
 *
 * Not the reserved discs: a hub that outgrows the disc it reserved at birth
 * keeps spiralling outward, so its late claims can sit beyond it. The world box
 * may therefore grow under an append — tiles are rebuilt per version, so that
 * is fine, and no node's own `(x, y)` changes. Never filtered.
 */
export function worldBounds(
  nodeX: Float64Array,
  nodeY: Float64Array,
  nodeR: Float64Array | Float32Array,
  count: number,
): { minX: number; minY: number; size: number } {
  if (count === 0) return { minX: -100, minY: -100, size: 200 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i++) {
    if (nodeX[i] - nodeR[i] < minX) minX = nodeX[i] - nodeR[i]
    if (nodeY[i] - nodeR[i] < minY) minY = nodeY[i] - nodeR[i]
    if (nodeX[i] + nodeR[i] > maxX) maxX = nodeX[i] + nodeR[i]
    if (nodeY[i] + nodeR[i] > maxY) maxY = nodeY[i] + nodeR[i]
  }
  const side = Math.max(maxX - minX, maxY - minY, 1)
  const size = side * 1.05
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { minX: cx - size / 2, minY: cy - size / 2, size }
}

type Bounds = { minX: number; minY: number; size: number }

/** Smallest square covering both boxes. Already-padded inputs stay padded. */
function unionBounds(a: Bounds, b: Bounds): Bounds {
  const minX = Math.min(a.minX, b.minX)
  const minY = Math.min(a.minY, b.minY)
  const maxX = Math.max(a.minX + a.size, b.minX + b.size)
  const maxY = Math.max(a.minY + a.size, b.minY + b.size)
  const size = Math.max(maxX - minX, maxY - minY, 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { minX: cx - size / 2, minY: cy - size / 2, size }
}
