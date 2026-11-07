/**
 * The client's bounded working set.
 *
 * Owns: the manifest, which tiles are resident, one slab per resident tile,
 * the in-flight fetches, and the `id → (tile, index)` lookup the inspector and
 * hover use. Everything here is plain JS + typed arrays — no WebGL, no React
 * — so the whole streaming/eviction machine is testable in vitest against
 * `createInMemoryDataSource`.
 *
 * The invariants that make `NodeRef` safe to hold across frames:
 *   1. A resident tile keeps ONE slab for its whole residency.
 *   2. Eviction frees that slab and never touches another tile's slab.
 *   3. Typed-array contents never change while a tile is resident.
 * Together they mean the renderer can address a node as `(slab, index)` and
 * the inspector can keep a `NodeRef` without a per-frame revalidation pass.
 */

import {
  HARD_TILE_CAP,
  parseTileId,
  tileId as makeTileId,
  type MapMeta,
  type MapTile,
  type NodeKey,
  type TileId,
} from '@/lib/knowledge/graph-map/types'
import { SlabAllocator } from './slab-allocator'
import { buildTileIndex, computeVisibleTiles, viewportWorldRect, type TileIndex } from './visible-tiles'
import { NeighborIndex } from './neighbors'
import { StaleMapError, type CameraState, type MapDataSource, type NodeRef, type ResidentTile, type Viewport } from './types'

export interface TileStoreCallbacks {
  onTileLoaded(tile: ResidentTile): void
  onTileEvicted(tile: ResidentTile): void
  /** Everything resident is gone — drop all GL state and NodeRefs. */
  onReset(): void
  onMeta(meta: MapMeta): void
  onError(err: unknown): void
  /** Something changed off-frame (a tile arrived); schedule a render. */
  requestFrame(): void
}

export interface TileStoreOptions {
  maxResidentTiles?: number
  concurrency?: number
  now?: () => number
  /**
   * Milliseconds of each `update()` that may be spent ADMITTING tiles that
   * finished downloading since the last frame (see ADMIT BUDGET below).
   * `Infinity` admits everything in one frame, which is what the pure
   * streaming tests want. Default 4 ms.
   */
  admitBudgetMs?: number
}

const DEFAULT_MAX_RESIDENT = 96
const DEFAULT_CONCURRENCY = 4

/**
 * ADMIT BUDGET, in milliseconds per frame.
 *
 * Admitting a tile is not free: the wire columns are copied into typed arrays
 * here, and the shell's `onTileLoaded` then runs `uploadTile` (two
 * bufferSubData), the neighbour-index update and a label invalidation. Four
 * concurrent fetches resolving between two frames used to do all of that work
 * in ONE frame — measured on the 1M-node tour as 5 of 358 frames over 16.7 ms,
 * the worst at 84 ms against a 1.6 ms median.
 *
 * So admission is spread instead: completed fetches wait in a queue and each
 * frame drains it until the budget is spent. Four ms leaves most of a 16.7 ms
 * frame for the render itself while still admitting several tiles per frame.
 */
const DEFAULT_ADMIT_BUDGET_MS = 4

/**
 * Camera movement below this fraction of the viewport (and this much zoom)
 * reuses the previous wanted set. Recomputing the quadtree walk on every
 * sub-pixel inertia frame is pure waste; the 25% viewport padding is what
 * makes skipping safe.
 */
const HYSTERESIS_PAN_FRACTION = 0.08
const HYSTERESIS_ZOOM_RATIO = 1.04

/**
 * Frames an empty answer suppresses a re-request for — roughly 10 s at 60 fps,
 * and far longer in practice because a render-on-demand map only counts frames
 * it actually draws.
 *
 * Big enough that a genuinely empty tile is asked for at most once per window
 * rather than once per frame (the reason the set exists), small enough that a
 * transient empty response heals on its own while the user is still looking at
 * the same region.
 */
const MISSING_RETRY_FRAMES = 600

interface PendingRequest {
  ids: TileId[]
  controller: AbortController
}

/** Packed `(slab, index)` is not enough — evictions must invalidate the entry. */
interface NodeAddress {
  tile: ResidentTile
  index: number
}

/**
 * A downloaded tile waiting for a frame with budget left to admit it.
 *
 * `generation` is carried so a queue entry from a superseded map version (or
 * a swapped data source) can be recognised and dropped: node ids are
 * per-version, so admitting one would address the wrong nodes.
 */
interface PendingAdmission {
  id: TileId
  wire: MapTile
  generation: number
  /** `update()` frame at which the fetch resolved — recency for the ordering. */
  wantedAtFrame: number
}

export class TileStore {
  private source: MapDataSource
  private readonly callbacks: TileStoreCallbacks
  private readonly maxResidentTiles: number
  private readonly concurrency: number
  private readonly now: () => number
  private readonly admitBudgetMs: number

  private allocator: SlabAllocator
  private index: TileIndex | null = null
  private metaValue: MapMeta | null = null

  private readonly resident = new Map<TileId, ResidentTile>()
  private readonly byId = new Map<number, NodeAddress>()
  private readonly byKey = new Map<NodeKey, NodeAddress>()
  private readonly neighbors = new NeighborIndex()

  /** Tiles wanted by the most recent `update()`, ascending z. */
  private wanted: TileId[] = []
  private wantedSet = new Set<TileId>()
  /** Ancestors of wanted tiles — never evicted, they are the visible backdrop. */
  private protectedTiles = new Set<TileId>()

  private readonly inFlight = new Map<TileId, PendingRequest>()
  /** Wanted-but-not-yet-requested, in the order `update()` wanted them. */
  private queue: TileId[] = []
  /** Downloaded, not yet admitted — drained under the per-frame time budget. */
  private admitQueue: PendingAdmission[] = []
  /**
   * Tiles a request came back empty for, and the frame that happened on.
   *
   * A RETRY CACHE, not a permanent verdict. The point is only to stop the
   * queue re-asking for the same tile every frame; it must not turn a
   * transient empty answer into a hole that lasts the whole session. The
   * client cannot tell "this tile genuinely has no nodes" from "this 200 came
   * back with no tiles in it", and the server legitimately produces the latter
   * — a `sinceDays` tiling is rebuilt per hour bucket, so a sparse tile whose
   * last node just aged past the cutoff vanishes without the version moving,
   * and the stale/409 path never fires. Before this, that id was filtered out
   * of every subsequent queue, pump and resume, and only a version change or a
   * remount could bring it back: the nodes were invisible at every zoom and
   * missing from the inspector too.
   */
  private missing = new Map<TileId, number>()

  private paused = false
  private disposed = false
  private frame = 0
  private lastCamera: CameraState | null = null
  private lastViewport: Viewport | null = null

  /** Guards against a late response from a superseded map/source. */
  private generation = 0
  /**
   * Orders map probes (load / revalidate) among themselves. Kept apart from
   * `generation`: a probe that comes back `unchanged` keeps the map, so tile
   * requests in flight under it must still land (and leave `inFlight`).
   */
  private mapLoadSeq = 0
  private loadMapController: AbortController | null = null
  private revalidating: Promise<'unchanged' | 'updated'> | null = null

  constructor(source: MapDataSource, callbacks: TileStoreCallbacks, opts: TileStoreOptions = {}) {
    this.source = source
    this.callbacks = callbacks
    this.maxResidentTiles = opts.maxResidentTiles ?? DEFAULT_MAX_RESIDENT
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
    // `now` is the same performance.now() clock used for tile fade-in, so the
    // admit budget measures with it too rather than reaching for a second one.
    this.admitBudgetMs = opts.admitBudgetMs ?? DEFAULT_ADMIT_BUDGET_MS
    this.allocator = new SlabAllocator(this.maxResidentTiles)
  }

  get meta(): MapMeta | null {
    return this.metaValue
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const generation = this.generation
    const seq = ++this.mapLoadSeq
    this.loadMapController?.abort()
    const controller = new AbortController()
    this.loadMapController = controller
    const stale = () => this.disposed || generation !== this.generation || seq !== this.mapLoadSeq

    try {
      const res = await this.source.loadMap({ signal: controller.signal })
      if (stale()) return
      if ('unchanged' in res && res.unchanged) {
        // Only a revalidate should ever see this; a cold load has no `have`.
        return
      }
      this.adoptMap(res, res.tiles)
    } catch (err) {
      if (stale()) return
      if (isAbort(err)) return
      this.callbacks.onError(err)
    }
  }

  /**
   * Re-probe the server. `unchanged` leaves everything (and the camera) alone;
   * `updated` swaps the whole map atomically — same keys land on the same
   * positions because the layout is stable under appends, so the camera stays
   * meaningful without being touched.
   */
  async revalidate(): Promise<'unchanged' | 'updated'> {
    // Collapse concurrent revalidations (realtime burst + a StaleMapError from
    // two different tile requests) into one probe.
    if (this.revalidating) return this.revalidating
    const run = this.runRevalidate()
    this.revalidating = run
    try {
      return await run
    } finally {
      if (this.revalidating === run) this.revalidating = null
    }
  }

  private async runRevalidate(): Promise<'unchanged' | 'updated'> {
    const have = this.metaValue?.version
    // Not a bump of `generation`: an `unchanged` answer keeps the map, and the
    // tile requests in flight under it must still land and leave `inFlight`
    // (orphaned, they held every concurrency slot and the map stopped
    // streaming). `adoptMap` resets, which bumps it, when the map does change.
    const generation = this.generation
    const seq = ++this.mapLoadSeq
    this.loadMapController?.abort()
    const controller = new AbortController()
    this.loadMapController = controller
    const stale = () => this.disposed || generation !== this.generation || seq !== this.mapLoadSeq

    try {
      const res = await this.source.loadMap({ have, signal: controller.signal })
      if (stale()) return 'unchanged'
      if ('unchanged' in res && res.unchanged) {
        // An explicit re-probe is a request for a fresh look even when the
        // version hashes match, so retire the retry cache: this is the path a
        // realtime change takes, and it was the one way a transiently empty
        // tile could never come back (`reset` is not reached from here).
        this.missing.clear()
        this.queue = this.queueableWanted()
        this.pump()
        return 'unchanged'
      }
      this.adoptMap(res, res.tiles)
      return 'updated'
    } catch (err) {
      if (stale()) return 'unchanged'
      if (isAbort(err)) return 'unchanged'
      this.callbacks.onError(err)
      return 'unchanged'
    }
  }

  /** Filters changed: abort everything, drop the old map, load the new one. */
  async setSource(source: MapDataSource): Promise<void> {
    this.source = source
    this.reset()
    await this.load()
  }

  private adoptMap(meta: MapMeta, inline: MapTile[]): void {
    // Reset BEFORE adopting so slabs, ids and keys of the old version can
    // never be mistaken for the new one's (node ids are per-version).
    this.reset()
    this.metaValue = meta
    this.index = buildTileIndex(meta)
    this.callbacks.onMeta(meta)
    for (const tile of inline) this.admit(tile)
    this.callbacks.requestFrame()
  }

  /** Drop every resident tile and all in-flight work, keeping the source. */
  private reset(): void {
    this.generation++
    this.loadMapController?.abort()
    this.loadMapController = null
    for (const req of this.inFlight.values()) req.controller.abort()
    this.inFlight.clear()
    this.queue = []
    // Queued admissions belong to the OLD version: node ids are per-version,
    // so one admitted after the swap would address the wrong nodes.
    this.admitQueue = []
    this.missing.clear()
    this.resident.clear()
    this.byId.clear()
    this.byKey.clear()
    this.neighbors.clear()
    this.wanted = []
    this.wantedSet = new Set()
    this.protectedTiles = new Set()
    this.lastCamera = null
    this.lastViewport = null
    this.metaValue = null
    this.index = null
    // A fresh allocator is the cheapest way to guarantee no stale slab leaks
    // across a version swap.
    this.allocator = new SlabAllocator(this.maxResidentTiles)
    this.callbacks.onReset()
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  update(camera: CameraState, viewport: Viewport, frame: number): ResidentTile[] {
    this.frame = frame
    if (!this.index || !this.metaValue) return []

    if (this.cameraMovedEnough(camera, viewport)) {
      this.lastCamera = { ...camera }
      this.lastViewport = { ...viewport }
      const { wanted } = computeVisibleTiles(this.index, camera, viewport)
      this.setWanted(wanted)
    } else if (this.expireMissing()) {
      // A retry window elapsed under a camera that has not moved. Without this
      // the queue is only ever rebuilt by a camera change, so a tile that came
      // back empty while the user sat still would never be asked for again.
      this.queue = this.queueableWanted()
    }

    // Admit what downloaded since the last frame, under a time budget, and
    // BEFORE the draw list is built so anything admitted here is painted this
    // frame rather than waiting for the next one.
    this.drainAdmissions()

    // Stamp visibility BEFORE eviction so a tile that is on screen this frame
    // is never the LRU victim of this frame's own admission.
    const rect = viewportWorldRect(camera, viewport, 0)
    const draw: ResidentTile[] = []
    for (const tile of this.resident.values()) {
      if (
        tile.ox + tile.size > rect.minX &&
        tile.ox < rect.maxX &&
        tile.oy + tile.size > rect.minY &&
        tile.oy < rect.maxY
      ) {
        tile.lastVisibleFrame = frame
        draw.push(tile)
      }
    }

    this.pump()

    // Ascending z = the renderer's draw order (parents behind children).
    draw.sort((a, b) => a.z - b.z)
    return draw
  }

  private cameraMovedEnough(camera: CameraState, viewport: Viewport): boolean {
    const prev = this.lastCamera
    const prevVp = this.lastViewport
    if (!prev || !prevVp) return true
    if (prevVp.width !== viewport.width || prevVp.height !== viewport.height) return true

    const zoomRatio = camera.k > prev.k ? camera.k / prev.k : prev.k / camera.k
    if (!Number.isFinite(zoomRatio) || zoomRatio > HYSTERESIS_ZOOM_RATIO) return true

    // Pan measured in screen px at the CURRENT scale: the same world delta
    // matters far more when zoomed in.
    const dxPx = Math.abs(camera.x - prev.x) * camera.k
    const dyPx = Math.abs(camera.y - prev.y) * camera.k
    return (
      dxPx > viewport.width * HYSTERESIS_PAN_FRACTION ||
      dyPx > viewport.height * HYSTERESIS_PAN_FRACTION
    )
  }

  /**
   * Is this id still within its retry window? Expired entries are dropped as
   * they are seen, so the map never grows without bound and a tile becomes
   * requestable again the moment the window passes.
   */
  /** Drop every entry past its retry window. True when any were dropped. */
  private expireMissing(): boolean {
    if (this.missing.size === 0) return false
    let dropped = false
    for (const [id, at] of this.missing) {
      if (this.frame - at > MISSING_RETRY_FRAMES) {
        this.missing.delete(id)
        dropped = true
      }
    }
    return dropped
  }

  private isMissing(id: TileId): boolean {
    const at = this.missing.get(id)
    if (at === undefined) return false
    if (this.frame - at > MISSING_RETRY_FRAMES) {
      this.missing.delete(id)
      return false
    }
    return true
  }

  /**
   * The ids worth asking for right now, in wanted order.
   *
   * One helper for `setWanted` and `resume` so the two can never drift: an id
   * already parked in `admitQueue` has been DOWNLOADED and is waiting for a
   * frame with admit budget, so re-queuing it fetches the same bytes twice and
   * `enqueueAdmission` then throws the first copy away.
   */
  private queueableWanted(): TileId[] {
    // Only live entries suppress a fetch: `drainAdmissions` drops entries from
    // a superseded generation, so filtering on a stale one would leave that
    // tile neither queued nor admitted.
    const parked = new Set(
      this.admitQueue.filter((p) => p.generation === this.generation).map((p) => p.id),
    )
    return this.wanted.filter(
      (id) =>
        !this.resident.has(id) &&
        !this.inFlight.has(id) &&
        !this.isMissing(id) &&
        !parked.has(id),
    )
  }

  private setWanted(wanted: TileId[]): void {
    this.wanted = wanted
    this.wantedSet = new Set(wanted)

    // Ancestors of anything wanted stay pinned: they are what is actually
    // painted under a half-loaded deep level, and 0.0.0 is the whole overview.
    const protectedTiles = new Set<TileId>()
    protectedTiles.add(makeTileId(0, 0, 0))
    for (const id of wanted) {
      const parsed = parseTileId(id)
      if (!parsed) continue
      let { z, x, y } = parsed
      while (z > 0) {
        z -= 1
        x >>= 1
        y >>= 1
        protectedTiles.add(makeTileId(z, x, y))
      }
    }
    this.protectedTiles = protectedTiles

    // Cancel work for tiles that are no longer wanted — a fast pan across the
    // map must not keep paying for the tiles it flew over.
    for (const [id, req] of this.inFlight) {
      if (!this.wantedSet.has(id)) {
        req.controller.abort()
        this.inFlight.delete(id)
      }
    }

    this.queue = this.queueableWanted()
  }

  /** Start fetches up to the concurrency cap, parents first. */
  private pump(): void {
    if (this.paused || this.disposed || !this.metaValue) return
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      // One tile per request keeps cancellation precise: a batched request
      // could only be aborted wholesale, so a single still-wanted tile would
      // keep three unwanted ones alive (or cancelling would drop a wanted one).
      const id = this.queue.shift() as TileId
      if (this.resident.has(id) || this.inFlight.has(id) || this.isMissing(id)) continue
      this.request([id])
    }
  }

  private request(ids: TileId[]): void {
    const version = this.metaValue?.version
    if (!version) return
    const generation = this.generation
    const controller = new AbortController()
    const req: PendingRequest = { ids, controller }
    for (const id of ids) this.inFlight.set(id, req)

    this.source
      .loadTiles(version, ids, controller.signal)
      .then((tiles) => {
        if (this.disposed || generation !== this.generation) return
        for (const id of ids) {
          if (this.inFlight.get(id) === req) this.inFlight.delete(id)
        }
        const returned = new Set<TileId>()
        for (const tile of tiles) {
          const id = makeTileId(tile.z, tile.x, tile.y)
          returned.add(id)
          // A tile that stopped being wanted mid-flight is dropped rather than
          // admitted: admitting it would burn a slab the wanted set needs.
          if (!this.wantedSet.has(id) || this.resident.has(id)) continue
          // QUEUED, not admitted: four fetches landing between two frames used
          // to do all their typed-array copying, GPU uploads and neighbour
          // indexing in that one frame (the 84 ms spike). `update()` drains
          // this under a time budget instead.
          this.enqueueAdmission(id, tile, generation)
        }
        // Remember the no-shows so the queue does not spin on them — with the
        // frame it happened on, so a transient empty answer expires instead of
        // blanking the tile for the session. Note the abort/error paths below
        // never reach here, so a cancelled fetch is never recorded as empty.
        for (const id of ids) if (!returned.has(id)) this.missing.set(id, this.frame)
        this.pump()
        this.callbacks.requestFrame()
      })
      .catch((err) => {
        if (this.disposed || generation !== this.generation) return
        for (const id of ids) {
          if (this.inFlight.get(id) === req) this.inFlight.delete(id)
        }
        if (isAbort(err)) return
        if (err instanceof StaleMapError) {
          // The map moved under us; a revalidate is the only correct answer.
          void this.revalidate()
          return
        }
        this.callbacks.onError(err)
        this.pump()
      })
  }

  // ── Admission queue ────────────────────────────────────────────────────────

  /**
   * Park a downloaded tile until a frame has budget for it.
   *
   * Ordered PARENTS FIRST (ascending z) and, within a level, most recently
   * wanted first: the shallow tile is the backdrop for more of the view, so
   * admitting it first paints the most map per millisecond, and among equals
   * the one the camera asked for most recently is the one being looked at.
   */
  private enqueueAdmission(id: TileId, wire: MapTile, generation: number): void {
    const existing = this.admitQueue.findIndex((p) => p.id === id)
    const entry: PendingAdmission = { id, wire, generation, wantedAtFrame: this.frame }
    if (existing >= 0) this.admitQueue[existing] = entry
    else this.admitQueue.push(entry)
    this.admitQueue.sort((a, b) =>
      a.wire.z !== b.wire.z ? a.wire.z - b.wire.z : b.wantedAtFrame - a.wantedAtFrame,
    )
  }

  /**
   * Admit queued tiles until the time budget is spent.
   *
   * ALWAYS admits at least one tile when the queue is non-empty, so progress
   * is guaranteed however slow a single admission turns out to be — a budget
   * that can admit nothing would stall the map forever. Entries that stopped
   * being wanted, went resident by another path, or belong to a superseded
   * version are dropped as they are reached rather than swept separately.
   */
  private drainAdmissions(): void {
    if (this.admitQueue.length === 0) return
    const start = this.now()
    let admitted = 0

    while (this.admitQueue.length > 0) {
      if (admitted > 0 && this.now() - start >= this.admitBudgetMs) break
      const next = this.admitQueue.shift() as PendingAdmission
      // Stale version / source, no longer wanted, or already here: drop it.
      // Dropping does NOT count against the budget — it costs nothing, and
      // charging for it would let a queue full of stale entries stall the map.
      if (next.generation !== this.generation) continue
      if (!this.wantedSet.has(next.id) || this.resident.has(next.id)) continue
      this.admit(next.wire)
      admitted++
    }

    // Still work left ⇒ come back next frame. Without this a map that finished
    // downloading would sit half-admitted until the user moved the camera.
    if (this.admitQueue.length > 0) this.callbacks.requestFrame()
  }

  // ── Residency ──────────────────────────────────────────────────────────────

  private admit(wire: MapTile): void {
    const id = makeTileId(wire.z, wire.x, wire.y)
    if (this.resident.has(id)) return

    let slab = this.allocator.alloc()
    if (slab < 0) {
      if (!this.evictOne()) return // Everything resident is protected — skip.
      slab = this.allocator.alloc()
      if (slab < 0) return
    }

    const tile = toResidentTile(wire, id, slab, this.now(), this.frame)
    this.resident.set(id, tile)
    for (let i = 0; i < tile.nodeCount; i++) {
      const address: NodeAddress = { tile, index: i }
      this.byId.set(tile.nodeId[i], address)
      this.byKey.set(tile.keys[i], address)
    }
    this.neighbors.addTile(tile)
    this.callbacks.onTileLoaded(tile)
  }

  /**
   * Evict the least-recently-visible tile that is neither wanted this frame
   * nor an ancestor of a wanted tile. Returns false when nothing may go.
   */
  private evictOne(): boolean {
    let victim: ResidentTile | null = null
    for (const tile of this.resident.values()) {
      if (this.wantedSet.has(tile.id) || this.protectedTiles.has(tile.id)) continue
      // Deeper tiles lose ties: a parent is the backdrop for more of the view.
      if (
        !victim ||
        tile.lastVisibleFrame < victim.lastVisibleFrame ||
        (tile.lastVisibleFrame === victim.lastVisibleFrame && tile.z > victim.z)
      ) {
        victim = tile
      }
    }
    if (!victim) return false
    this.evict(victim)
    return true
  }

  private evict(tile: ResidentTile): void {
    this.resident.delete(tile.id)
    for (let i = 0; i < tile.nodeCount; i++) {
      // Only drop the entry if it still points at THIS tile: a node id can
      // legitimately appear in a deeper tile too.
      if (this.byId.get(tile.nodeId[i])?.tile === tile) this.byId.delete(tile.nodeId[i])
      if (this.byKey.get(tile.keys[i])?.tile === tile) this.byKey.delete(tile.keys[i])
    }
    this.neighbors.removeTile(tile)
    this.allocator.free(tile.slab)
    this.callbacks.onTileEvicted(tile)
  }

  residentTiles(): ResidentTile[] {
    return [...this.resident.values()]
  }

  findById(id: number): NodeRef | null {
    const address = this.byId.get(id)
    return address ? { tile: address.tile, index: address.index } : null
  }

  findByKey(key: NodeKey): NodeRef | null {
    const address = this.byKey.get(key)
    return address ? { tile: address.tile, index: address.index } : null
  }

  /** Reverse edge lookup (target id → citing edges), for hover neighbourhoods. */
  get neighborIndex(): NeighborIndex {
    return this.neighbors
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Tab hidden: stop the network, keep everything resident. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    for (const [id, req] of this.inFlight) {
      req.controller.abort()
      // Still wanted, so resume() re-queues it in wanted order.
      this.inFlight.delete(id)
      if (this.wantedSet.has(id) && !this.isMissing(id)) this.queue.push(id)
    }
    // Preserve parents-first order after the re-queue.
    const order = new Map(this.wanted.map((id, i) => [id, i]))
    this.queue.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    // Coming back to the view is the user's own "try again": clear the retry
    // cache so a tile that came back empty while they were away is asked for
    // once more straight away rather than after the window. Nothing was being
    // fetched while paused, so this costs at most one round trip per
    // still-wanted-and-genuinely-empty tile.
    this.missing.clear()
    this.queue = this.queueableWanted()
    this.pump()
    this.callbacks.requestFrame()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.loadMapController?.abort()
    this.loadMapController = null
    for (const req of this.inFlight.values()) req.controller.abort()
    this.inFlight.clear()
    this.queue = []
    this.admitQueue = []
    this.resident.clear()
    this.byId.clear()
    this.byKey.clear()
    this.neighbors.clear()
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

/**
 * Wire columns → typed arrays.
 *
 * `edgeSource` is Uint16 because it indexes within one tile and a tile holds
 * at most HARD_TILE_CAP (4000) nodes. `nodeCount` is reported truthfully even
 * when it exceeds TILE_CAPACITY — only MAX_Z tiles can, and the renderer sizes
 * its node slabs at HARD_TILE_CAP for exactly that case.
 */
function toResidentTile(
  wire: MapTile,
  id: TileId,
  slab: number,
  loadedAt: number,
  frame: number,
): ResidentTile {
  const n = Math.min(wire.nodes.id.length, HARD_TILE_CAP)
  const m = wire.edges.s.length

  const nodeId = new Uint32Array(n)
  const nodeX = new Float32Array(n)
  const nodeY = new Float32Array(n)
  const nodeR = new Float32Array(n)
  const nodeImportance = new Float32Array(n)
  const nodeDegree = new Uint32Array(n)
  const nodeKind = new Uint8Array(n)
  const nodeFlags = new Uint8Array(n)
  const nodeEtype = new Int16Array(n)
  const keys: NodeKey[] = new Array(n)
  const labels: string[] = new Array(n)

  for (let i = 0; i < n; i++) {
    nodeId[i] = wire.nodes.id[i]
    nodeX[i] = wire.nodes.x[i]
    nodeY[i] = wire.nodes.y[i]
    nodeR[i] = wire.nodes.r[i]
    nodeImportance[i] = wire.nodes.importance[i]
    nodeDegree[i] = wire.nodes.degree[i]
    nodeKind[i] = wire.nodes.kind[i]
    nodeFlags[i] = wire.nodes.flags[i]
    nodeEtype[i] = wire.nodes.etype[i]
    keys[i] = wire.nodes.key[i]
    labels[i] = wire.nodes.label[i] ?? ''
  }

  const edgeSource = new Uint16Array(m)
  const edgeTarget = new Uint32Array(m)
  const edgeTX = new Float32Array(m)
  const edgeTY = new Float32Array(m)
  const edgeRel = new Uint8Array(m)
  for (let i = 0; i < m; i++) {
    edgeSource[i] = wire.edges.s[i]
    edgeTarget[i] = wire.edges.t[i]
    edgeTX[i] = wire.edges.tx[i]
    edgeTY[i] = wire.edges.ty[i]
    edgeRel[i] = wire.edges.rel[i]
  }

  return {
    id,
    z: wire.z,
    x: wire.x,
    y: wire.y,
    ox: wire.ox,
    oy: wire.oy,
    size: wire.size,
    slab,
    nodeCount: n,
    edgeCount: m,
    nodeId,
    nodeX,
    nodeY,
    nodeR,
    nodeImportance,
    nodeDegree,
    nodeKind,
    nodeFlags,
    nodeEtype,
    keys,
    labels,
    edgeSource,
    edgeTarget,
    edgeTX,
    edgeTY,
    edgeRel,
    loadedAt,
    lastVisibleFrame: frame,
  }
}
