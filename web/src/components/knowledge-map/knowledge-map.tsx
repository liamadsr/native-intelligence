'use client'

/**
 * Knowledge Map — the React shell.
 *
 * Wires the data layer (TileStore, SpatialIndex, NeighborIndex) to the GL
 * layer (renderer, labels, camera, palette) and owns exactly the things React
 * is good at: mounting, unmounting, props, and the DOM node. Everything
 * per-frame lives outside React state — camera, hover, labels and stats are
 * refs, because a `setState` per pointer move would re-render the tree 120
 * times a second on a WKWebView trackpad (architecture §5.1).
 *
 * Four rules this file exists to enforce:
 *
 *   1. ONE GL CONTEXT PER INSTANCE, ON ITS OWN CANVAS. The renderer is created
 *      inside an effect and disposed in its cleanup. React 19 strict mode
 *      double-invokes effects in dev, so a renderer created during render (or
 *      never disposed) leaks a context per mount; browsers cap live contexts
 *      (~16 in Safari) and silently kill the oldest, which would blank a map in
 *      another pop-out window sharing the WKWebView GPU process.
 *
 *      A renderer is created and destroyed MANY times during one mount — a dpr
 *      change, the 10 s idle dispose, a context loss, strict mode's double
 *      mount. Each generation therefore gets its own <canvas>, keyed by
 *      `glGen`. That is what makes `dispose()`'s `loseContext()` safe: a
 *      context lost that way can only be revived via `restoreContext()`, and
 *      `getContext('webgl2')` on that canvas returns the SAME dead object
 *      forever — so reusing one element meant every recreation on it failed
 *      permanently with a shader-compile error. Releasing the context really
 *      does matter (WebKit caps live contexts, pop-outs share one GPU
 *      process), so the canvas moves rather than the loseContext call going.
 *
 *      Because renderers come and go, NOTHING may capture one. The store
 *      callbacks, the canvas listeners and the frame loop all reach the
 *      current renderer through `rendererRef`, which is null while disposed;
 *      tiles keep becoming resident on the CPU meanwhile and `attachRenderer`
 *      re-uploads them when a renderer next exists.
 *   2. RENDER ON DEMAND. No frame runs unless something changed. See
 *      frame-scheduler.ts.
 *   3. PICKING ONCE PER FRAME. Pointer handlers only record a position;
 *      the hit test runs inside the frame loop, so a 120 Hz move burst costs
 *      at most one pick per rendered frame.
 *   4. NOTHING PROMOTES A LAYER. No opacity, filter, transform or will-change
 *      on the container: the dashboard's glass panel uses backdrop-filter, and
 *      a promoted layer inside it breaks the blur (documented twice in
 *      tabs/tab-content.tsx).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import type { MapMeta, NodeKey } from '@/lib/knowledge/graph-map/types'
import { probeWebGL2 } from './capabilities'
import {
  CameraController,
  cameraLimits,
  fitRect,
  fitWorld,
  clampCamera,
} from './camera'
import { FpsMeter, FrameScheduler, SettleTimer } from './frame-scheduler'
import { buildLabelCandidates } from './label-candidates'
import { selectLabels } from './labels'
import { continuousZoom } from './lod'
import { resolveHighlight } from './neighbors'
import { readPalette } from './palette'
import { createMapRenderer, type MapRendererImpl } from './renderer'
import { SpatialIndex } from './spatial-index'
import { StatsOverlay, type MapStats } from './stats-overlay'
import { TileStore } from './tile-store'
import type {
  CameraState,
  KnowledgeMapHandle,
  KnowledgeMapProps,
  LabelSprite,
  MapStatus,
  NodeRef,
  Palette,
  PickedNode,
  ResidentTile,
  Viewport,
} from './types'

/**
 * One constant for both the TileStore's residency cap and the renderer's slab
 * count. They MUST agree: a store that can hold more tiles than the renderer
 * has slabs would hand out a slab index past the end of the GPU buffer.
 */
export const MAX_RESIDENT_TILES = 96

/** Quiet period after the last camera change before labels are recomputed. */
const CAMERA_SETTLE_MS = 120
/**
 * Quiet period before the GL backing store is reallocated. Same value and
 * same reason as the dashboard's PixelCanvas: writing canvas.width allocates a
 * fresh backing store, which in WKWebView is a new remote surface and an IPC
 * round trip, and the ResizeObserver fires once per frame during a splitter
 * drag.
 *
 * The CSS-px viewport updates immediately (picking and camera limits follow
 * the element), but the PROJECTION does not: `renderer.render` derives it from
 * the backing store it is actually drawing into, so a frame inside this window
 * is the old size scaled by CSS rather than the new size cropped to the old
 * buffer. See the resize effect.
 */
const RESIZE_SETTLE_MS = 180
/**
 * A size change bigger than this fraction of the previous edge is treated as a
 * DISCRETE JUMP (window snap, inspector panel toggled, pop-out opened) rather
 * than a drag, and the backing store is reallocated immediately.
 *
 * The debounce exists for continuous drags, where the ResizeObserver fires once
 * a frame and every realloc is a fresh WKWebView surface plus an IPC round
 * trip. A one-off jump fires ONCE, so debouncing it buys nothing and costs the
 * user 180 ms of the map visibly scaled to the wrong size — the most
 * noticeable case, because it is a step rather than a smear. A drag never
 * crosses this threshold in one frame, so it still coalesces.
 */
const RESIZE_JUMP_FRACTION = 0.25
/** Inactive this long ⇒ release the GL context, keeping the CPU tile arrays. */
const IDLE_DISPOSE_MS = 10_000
/** Device pixel ratio ceiling — 4× the fragments for no visible gain above 2. */
const MAX_DPR = 2

interface HoverPosition {
  x: number
  y: number
}

/** The selection we keep pinned outside the tile store (survives eviction). */
interface PinnedSelection {
  key: NodeKey
  wx: number
  wy: number
  r: number
}

const KnowledgeMap = forwardRef<KnowledgeMapHandle, KnowledgeMapProps>(function KnowledgeMap(
  { dataSource, selectedKey, onSelect, onMeta, onStatus, refreshToken, active = true, showStats },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // `unsupported` is decided by the probe before anything else is built, so it
  // is the one piece of status that must live in React state (it changes what
  // is rendered). Everything else is reported through onStatus.
  const [supported, setSupported] = useState<boolean | null>(null)
  const [stats, setStats] = useState<MapStats | null>(null)
  const [announcement, setAnnouncement] = useState('')
  /**
   * GL generation. Bumping it re-keys the <canvas>, so React unmounts the old
   * element (taking its dead context with it) and mounts a fresh one, and the
   * renderer effect below builds a renderer against that new element. This is
   * the ONLY way a second renderer is ever created on this component.
   */
  const [glGen, setGlGen] = useState(0)

  // ── Mutable per-frame state (never React state) ────────────────────────────
  const rendererRef = useRef<MapRendererImpl | null>(null)
  const storeRef = useRef<TileStore | null>(null)
  const spatialRef = useRef<SpatialIndex | null>(null)
  const schedulerRef = useRef<FrameScheduler | null>(null)
  const cameraCtlRef = useRef<CameraController | null>(null)
  const labelSettleRef = useRef<SettleTimer | null>(null)
  const fpsRef = useRef(new FpsMeter())

  const cameraRef = useRef<CameraState>({ x: 0, y: 0, k: 1 })
  const viewportRef = useRef<Viewport>({ width: 1, height: 1, dpr: 1 })
  const metaRef = useRef<MapMeta | null>(null)
  const paletteRef = useRef<Palette | null>(null)
  const labelsRef = useRef<LabelSprite[]>([])
  const frameRef = useRef(0)
  const lastFrameMsRef = useRef(0)
  /**
   * The tiles the last frame actually drew: viewport-intersecting, ascending
   * z. Click picking MUST use this and not `residentTiles()` — the resident
   * set includes off-screen tiles kept for the LRU, so picking against it
   * could select a node the user cannot see and that hover (which runs inside
   * the frame against this same list) would never have targeted.
   */
  const drawnTilesRef = useRef<ResidentTile[]>([])

  const hoverPosRef = useRef<HoverPosition | null>(null)
  /** Set when the pointer moved since the last pick — picking is per frame. */
  const pickDirtyRef = useRef(false)
  const hoveredRef = useRef<PickedNode | null>(null)
  const pinnedRef = useRef<PinnedSelection | null>(null)
  const selectedKeyRef = useRef<NodeKey | null>(selectedKey ?? null)
  /** Nodes whose labels are forced on (focus + its neighbourhood). */
  const forcedIdsRef = useRef<Set<number>>(new Set())
  /** The focus node's id — its label is pinned; neighbours' are only prioritised. */
  const focusIdRef = useRef<number | null>(null)
  /** Labels must be rebuilt on the next frame (tile load, highlight, theme). */
  const labelsDirtyRef = useRef(true)
  const hasContentRef = useRef(false)
  /** Extent of the root tile's nodes — what "fit" frames (see onTileLoaded). */
  const contentRectRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(
    null,
  )
  /** Set on the first meta: the opening view fits the content once it lands. */
  const pendingContentFitRef = useRef(false)
  const statusRef = useRef<MapStatus>('loading')

  // Props the frame loop reads — mirrored into refs so the loop never closes
  // over a stale render's values and never needs to be recreated.
  const onSelectRef = useRef(onSelect)
  const onMetaRef = useRef(onMeta)
  const onStatusRef = useRef(onStatus)
  const showStatsRef = useRef(showStats)
  useEffect(() => {
    onSelectRef.current = onSelect
    onMetaRef.current = onMeta
    onStatusRef.current = onStatus
    showStatsRef.current = showStats
  })

  const markDirty = useCallback(() => {
    schedulerRef.current?.markDirty()
  }, [])

  const emitStatus = useCallback((next: MapStatus) => {
    if (statusRef.current === next) return
    statusRef.current = next
    onStatusRef.current?.(next)
  }, [])

  /**
   * Ask for a brand-new renderer on a brand-new canvas.
   *
   * Idempotent within a generation: two triggers in the same tick (a dpr change
   * arriving while the idle timer fires) must produce ONE canvas, not two.
   * `requestedGenRef` is the guard, because `glGen` itself only updates after
   * React commits.
   */
  const requestedGenRef = useRef(0)
  /**
   * True between the idle timer firing and the next reactivation. While it is
   * set the renderer effect deliberately builds NOTHING: releasing the GL
   * context is the whole point of the idle dispose, and a recycle that
   * immediately re-acquired one would release nothing at all.
   */
  const idleDisposedRef = useRef(false)
  const recycleRenderer = useCallback(() => {
    setGlGen((n) => {
      const next = Math.max(n, requestedGenRef.current) + 1
      requestedGenRef.current = next
      return next
    })
  }, [])

  // ── Capability probe ───────────────────────────────────────────────────────
  // Runs before anything is built: an unsupported browser must never allocate
  // a renderer, a tile store or a network request.
  useEffect(() => {
    const probe = probeWebGL2()
    setSupported(probe.ok)
    if (!probe.ok) emitStatus('unsupported')
  }, [emitStatus])

  // ── Highlight + label recomputation ────────────────────────────────────────

  /**
   * Push the current hover/selection into the renderer.
   *
   * Hover wins over selection and dims everything else; a selection with no
   * hover keeps its neighbourhood in the accent WITHOUT dimming, so the rest of the
   * map stays readable while an inspector is open (§5.1).
   */
  const applyHighlight = useCallback(() => {
    const renderer = rendererRef.current
    const store = storeRef.current
    if (!renderer || !store) return

    const forced = new Set<number>()
    let focusId: number | null = null
    const hovered = hoveredRef.current
    let focusRef: NodeRef | null = hovered ? hovered.ref : null
    let dimOthers = true

    if (!focusRef && selectedKeyRef.current) {
      const found = store.findByKey(selectedKeyRef.current)
      if (found) {
        focusRef = found
        dimOthers = false
      }
    }

    if (focusRef) {
      const highlight = resolveHighlight(store, focusRef, {
        dimOthers,
        neighborIndex: store.neighborIndex,
      })
      // A selection whose tile was evicted still deserves its focus ring, so
      // the pinned copy is appended when it is not the live focus.
      const pinned = pinnedRef.current
      if (pinned && pinned.key !== focusRef.tile.keys[focusRef.index]) {
        highlight.focus.push({ wx: pinned.wx, wy: pinned.wy, r: pinned.r })
      }
      renderer.setHighlight(highlight)

      forced.add(focusRef.tile.nodeId[focusRef.index])
      focusId = focusRef.tile.nodeId[focusRef.index]
      // Neighbour ids are not carried on Highlight (it is pure geometry), so
      // re-derive them from the same edges for the forced-label set.
      const tile = focusRef.tile
      for (let e = 0; e < tile.edgeCount; e++) {
        if (tile.edgeSource[e] === focusRef.index) forced.add(tile.edgeTarget[e])
      }
      for (const { tile: src, edge } of store.neighborIndex.incomingEdges(focusId)) {
        const si = src.edgeSource[edge]
        if (si < src.nodeCount) forced.add(src.nodeId[si])
      }
    } else if (pinnedRef.current) {
      const pinned = pinnedRef.current
      renderer.setHighlight({
        focus: [{ wx: pinned.wx, wy: pinned.wy, r: pinned.r }],
        nodes: [],
        edges: [],
        dimOthers: false,
      })
    } else {
      renderer.setHighlight(null)
    }

    forcedIdsRef.current = forced
    focusIdRef.current = focusId
    labelsDirtyRef.current = true
    markDirty()
  }, [markDirty])

  /** Recompute the label set. Called on settle / tile load / highlight / theme. */
  const rebuildLabels = useCallback(
    (tiles: readonly ResidentTile[]) => {
      const renderer = rendererRef.current
      const meta = metaRef.current
      if (!renderer) return
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const zc = meta ? continuousZoom(camera, meta.world.size, meta.maxZ) : 0

      const candidates = buildLabelCandidates(tiles, camera, viewport, {
        zc,
        forcedIds: forcedIdsRef.current,
        focusId: focusIdRef.current,
      })
      // measureLabel uses the atlas's real font, so collision boxes match the
      // glyphs actually drawn rather than a width estimate.
      const sprites = selectLabels(candidates, camera, viewport, {
        measure: (text, weight) => renderer.measureLabel(text, weight),
      })
      labelsRef.current = sprites
      renderer.setLabels(sprites)
      labelsDirtyRef.current = false
    },
    [],
  )

  // ── The frame ──────────────────────────────────────────────────────────────

  const renderFrame = useCallback(
    (now: number): boolean => {
      const renderer = rendererRef.current
      const store = storeRef.current
      const spatial = spatialRef.current
      if (!renderer || !store || !spatial) return false
      if (renderer.isContextLost()) return false

      const t0 = typeof performance !== 'undefined' ? performance.now() : now
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const frame = ++frameRef.current

      const tiles = store.update(camera, viewport, frame)
      drawnTilesRef.current = tiles
      const meta = metaRef.current
      const zc = meta ? continuousZoom(camera, meta.world.size, meta.maxZ) : 0

      // Picking happens HERE, not in the pointer handler: a trackpad delivers
      // moves at up to 120 Hz and a hit test per event would be pure waste.
      if (pickDirtyRef.current) {
        pickDirtyRef.current = false
        const pos = hoverPosRef.current
        const previous = hoveredRef.current
        const picked = pos
          ? spatial.pick(tiles, camera, viewport, pos.x, pos.y, {
              zc,
              ...(meta ? { meta } : {}),
            })
          : null
        const changed = (previous?.key ?? null) !== (picked?.key ?? null)
        hoveredRef.current = picked
        if (changed) applyHighlight()
      }

      if (labelsDirtyRef.current) rebuildLabels(tiles)

      renderer.render(camera, viewport, tiles, now)

      lastFrameMsRef.current = (typeof performance !== 'undefined' ? performance.now() : now) - t0
      fpsRef.current.sample(now)

      if (!showStatsRef.current) {
        // showStats is off ⇒ the window probes must not exist. They are not
        // merely skipped: a probe left over from a session with stats on would
        // pin the last frame's ResidentTile arrays (and a closure over the
        // spatial index) alive for as long as the page lives, and would keep
        // answering picks against tiles that have since been evicted.
        clearDebugProbes()
        return renderer.needsAnotherFrame()
      }

      // ── Everything below is BENCHMARK ONLY (showStats) ──
      // Hard GPU sync: wall-clock fps is meaningless when the browser
      // throttles rAF (background tab / hidden preview pane), but the cost of
      // ONE frame is not — so that is what the bench reports. It stalls the
      // CPU until the GPU has finished, which is exactly the cost a
      // render-on-demand map exists to avoid: never in production.
      renderer.syncForTiming()
      const syncedFrameMs = (typeof performance !== 'undefined' ? performance.now() : now) - t0
      const s = renderer.stats()
      const next: MapStats = {
        fps: fpsRef.current.fps(),
        frameMs: lastFrameMsRef.current,
        syncedFrameMs,
        residentTiles: store.residentTiles().length,
        drawnTiles: tiles.length,
        nodes: s.nodesDrawn,
        edges: s.edgesDrawn,
        drawCalls: s.drawCalls,
        labels: s.labels,
        zc,
        k: camera.k,
      }
      setStats(next)
      // The orchestrator drives the bench page from a browser automation tool
      // and reads the numbers from here rather than scraping the DOM.
      if (typeof window !== 'undefined') {
        const w = window as unknown as {
          __kmStats?: MapStats
          __kmFrameLog?: number[]
          __kmDebug?: unknown
        }
        w.__kmStats = next
        // Probe so picking can be checked against real geometry from an
        // automated browser. Unreachable unless showStats is on (the early
        // return above), and the app never sets it — only the dev bench page
        // at /dev/knowledge-map does.
        w.__kmDebug = {
          camera,
          viewport,
          hover: hoverPosRef.current,
          hovered: hoveredRef.current?.key ?? null,
          pick: (x: number, y: number) =>
            spatial.pick(tiles, camera, viewport, x, y, { zc, ...(meta ? { meta } : {}) }),
          tiles,
        }
        // Rolling per-frame cost log so a tour can be summarised afterwards.
        const log = (w.__kmFrameLog ??= [])
        log.push(syncedFrameMs)
        if (log.length > 20000) log.splice(0, log.length - 20000)
      }

      return renderer.needsAnotherFrame()
    },
    [applyHighlight, rebuildLabels],
  )

  // ── Renderer + store lifecycle ─────────────────────────────────────────────
  //
  // ONE effect owns the renderer, the store, the scheduler and the camera
  // controller, because they are created and destroyed together. Anything
  // split across effects would let strict mode's double-invoke interleave a
  // create and a dispose of different generations.

  useEffect(() => {
    if (supported !== true) return
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, MAX_DPR)
    viewportRef.current = {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      dpr,
    }

    const spatial = new SpatialIndex()
    spatialRef.current = spatial

    const scheduler = new FrameScheduler({ onFrame: renderFrame })
    schedulerRef.current = scheduler

    const labelSettle = new SettleTimer(CAMERA_SETTLE_MS, () => {
      labelsDirtyRef.current = true
      scheduler.markDirty()
    })
    labelSettleRef.current = labelSettle

    // NOTHING below captures a renderer: every call goes through
    // `rendererRef.current`, which is null while the GL context is released
    // (idle dispose) and points at a different instance after every recycle.
    // Tiles still become resident on the CPU while it is null; `attachRenderer`
    // uploads the whole resident set when the next renderer appears.
    const store = new TileStore(
      dataSource,
      {
        onTileLoaded: (tile) => {
          rendererRef.current?.uploadTile(tile)
          // The root tile holds the most important nodes of the WHOLE map, so
          // its bbox is the content's extent. Frame that, not the world square
          // (which reserves mostly-empty disc space and would leave the graph
          // small and off-centre). Only for the opening view / an explicit
          // refit — a revalidation never touches the camera (§4.5).
          if (tile.z === 0 && tile.nodeCount > 0) {
            let minX = Infinity
            let minY = Infinity
            let maxX = -Infinity
            let maxY = -Infinity
            for (let i = 0; i < tile.nodeCount; i++) {
              const x = tile.ox + tile.nodeX[i]
              const y = tile.oy + tile.nodeY[i]
              const r = tile.nodeR[i]
              if (x - r < minX) minX = x - r
              if (y - r < minY) minY = y - r
              if (x + r > maxX) maxX = x + r
              if (y + r > maxY) maxY = y + r
            }
            contentRectRef.current = { minX, minY, maxX, maxY }
            if (pendingContentFitRef.current) {
              pendingContentFitRef.current = false
              const limits = metaRef.current
                ? cameraLimits(metaRef.current.world, viewportRef.current)
                : null
              const fitted = fitRect(contentRectRef.current, viewportRef.current)
              cameraRef.current = limits ? clampCamera(fitted, limits) : fitted
            }
          }
          hasContentRef.current = true
          labelsDirtyRef.current = true
          // A selection made before its tile was resident is ringed once it is.
          const selected = selectedKeyRef.current
          if (selected && !pinnedRef.current) {
            const found = storeRef.current?.findByKey(selected)
            if (found && found.tile === tile) {
              pinnedRef.current = {
                key: selected,
                wx: tile.ox + tile.nodeX[found.index],
                wy: tile.oy + tile.nodeY[found.index],
                r: tile.nodeR[found.index],
              }
              applyHighlight()
            }
          }
          scheduler.markDirty()
        },
        onTileEvicted: (tile) => {
          rendererRef.current?.removeTile(tile)
          spatial.remove(tile)
          // Drop the evicted tile from the drawn list too: a click arriving
          // between this eviction and the next frame would otherwise pick
          // against a tile whose slab has already been handed to someone else.
          if (drawnTilesRef.current.includes(tile)) {
            drawnTilesRef.current = drawnTilesRef.current.filter((t) => t !== tile)
          }
          // A hover into an evicted tile would keep a dangling NodeRef.
          if (hoveredRef.current?.ref.tile === tile) {
            hoveredRef.current = null
            applyHighlight()
          }
          labelsDirtyRef.current = true
          scheduler.markDirty()
        },
        onReset: () => {
          rendererRef.current?.clear()
          spatial.clear()
          // Every resident tile is gone, so no NodeRef into one may survive:
          // node ids are per-version and would address the wrong node.
          drawnTilesRef.current = []
          hoveredRef.current = null
          forcedIdsRef.current = new Set()
          focusIdRef.current = null
          labelsRef.current = []
          rendererRef.current?.setLabels([])
          rendererRef.current?.setHighlight(null)
          hasContentRef.current = false
          labelsDirtyRef.current = true
          scheduler.markDirty()
        },
        onMeta: (meta) => {
          const isFirst = metaRef.current === null
          const previous = metaRef.current
          metaRef.current = meta
          // MUST land before the first render: until the renderer knows the
          // world size and depth, every tile above level 0 computes a zoom
          // alpha of 0 and the map paints blank (GL layer note). When there is
          // no renderer right now, `attachRenderer` replays it from metaRef.
          rendererRef.current?.setWorld(meta.world, meta.maxZ)

          const viewport = viewportRef.current
          if (isFirst) {
            cameraRef.current = fitWorld(meta.world, viewport)
            pendingContentFitRef.current = true
          } else if (previous && worldMovedAway(previous, meta, cameraRef.current)) {
            // Revalidation NEVER touches the camera (§4.5) — unless the world
            // grew or shifted so far that the camera centre is outside it,
            // which would leave the user staring at empty space.
            cameraRef.current = fitWorld(meta.world, viewport)
          } else {
            cameraRef.current = clampCamera(cameraRef.current, cameraLimits(meta.world, viewport))
          }

          onMetaRef.current?.(meta)
          emitStatus(meta.counts.nodes === 0 ? 'empty' : 'ready')
          labelsDirtyRef.current = true
          scheduler.markDirty()
        },
        onError: (err) => {
          console.error('knowledge map: tile load failed', err)
          // Keep what is already drawn: a failed deep tile must not blank a
          // map the user is reading. Only a total failure is an error state.
          if (!hasContentRef.current) emitStatus('error')
        },
        requestFrame: () => scheduler.markDirty(),
      },
      { maxResidentTiles: MAX_RESIDENT_TILES },
    )
    storeRef.current = store

    const limits = () => {
      const meta = metaRef.current
      return meta
        ? cameraLimits(meta.world, viewportRef.current)
        : { minK: Number.MIN_VALUE, maxK: Number.MAX_VALUE }
    }

    const controller = new CameraController(container, {
      get: () => cameraRef.current,
      set: (next) => {
        cameraRef.current = next
        // The camera moved, so whatever the pointer is over may have changed
        // even without a pointer event.
        if (hoverPosRef.current) pickDirtyRef.current = true
        labelSettle.bump()
        scheduler.markDirty()
      },
      getViewport: () => viewportRef.current,
      limits,
      onClick: (sx, sy) => {
        const picked = spatialRef.current?.pick(
          drawnTilesRef.current,
          cameraRef.current,
          viewportRef.current,
          sx,
          sy,
          {
            zc: metaRef.current
              ? continuousZoom(cameraRef.current, metaRef.current.world.size, metaRef.current.maxZ)
              : 0,
            ...(metaRef.current ? { meta: metaRef.current } : {}),
          },
        )
        if (picked) {
          selectedKeyRef.current = picked.key
          pinnedRef.current = {
            key: picked.key,
            wx: picked.wx,
            wy: picked.wy,
            r: picked.ref.tile.nodeR[picked.ref.index],
          }
          onSelectRef.current?.({
            key: picked.key,
            kind: picked.kind,
            ...(picked.entityType ? { entityType: picked.entityType } : {}),
            label: picked.label,
          })
          setAnnouncement(describeSelection(picked))
        } else {
          selectedKeyRef.current = null
          pinnedRef.current = null
          onSelectRef.current?.(null)
          setAnnouncement('')
        }
        applyHighlight()
      },
      onHover: (sx, sy) => {
        hoverPosRef.current = sx === null || sy === null ? null : { x: sx, y: sy }
        pickDirtyRef.current = true
        scheduler.markDirty()
      },
      onInteraction: () => {
        labelSettle.bump()
      },
    })
    cameraCtlRef.current = controller

    void store.load()
    scheduler.markDirty()

    return () => {
      controller.dispose()
      labelSettle.dispose()
      scheduler.dispose()
      store.dispose()
      cameraCtlRef.current = null
      labelSettleRef.current = null
      schedulerRef.current = null
      storeRef.current = null
      spatialRef.current = null
      metaRef.current = null
      hasContentRef.current = false
      statusRef.current = 'loading'
    }
    // `dataSource` identity changes are handled by a separate effect
    // (store.setSource keeps the camera); rebuilding the whole GL stack for a
    // filter change would drop the context for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported])

  // ── Renderer lifecycle (one generation per <canvas>) ───────────────────────
  //
  // Runs AFTER the effect above (React runs effects in declaration order), so
  // the store, scheduler and spatial index already exist on the first pass and
  // `attachRenderer` can upload whatever is resident.
  //
  // Re-running this effect is the ONLY way a renderer is created or destroyed.
  // Bumping `glGen` re-keys the canvas, which mounts a new element, so
  // `canvasRef.current` here is always an element that has never held a
  // context — the precondition that makes `dispose()`'s `loseContext()` safe.

  /**
   * Bring a renderer up to date with everything the CPU side already knows:
   * size, palette, world, every resident tile, the highlight and the labels.
   * Exactly once, with no double allocation — `reupload`, not `restore`, since
   * the constructor has already built GL state.
   */
  const attachRenderer = useCallback(
    (renderer: MapRendererImpl) => {
      renderer.resize(viewportRef.current)
      const palette = paletteRef.current ?? readPalette()
      paletteRef.current = palette
      renderer.setPalette(palette)
      const meta = metaRef.current
      if (meta) renderer.setWorld(meta.world, meta.maxZ)
      const store = storeRef.current
      if (store) renderer.reupload(store.residentTiles())
      // Highlight and labels are derived state; recomputing them is cheaper
      // than carrying a copy, and `applyHighlight` also re-marks labels dirty.
      applyHighlight()
      labelsDirtyRef.current = true
      schedulerRef.current?.markDirty()
    },
    [applyHighlight],
  )

  useEffect(() => {
    if (supported !== true) return
    // Idle-disposed: the canvas is mounted but must hold no context until the
    // view is looked at again. The reactivation bump clears the flag first, so
    // this only ever skips the generation the dispose itself created.
    if (idleDisposedRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: MapRendererImpl
    try {
      renderer = createMapRenderer(canvas, {
        maxResidentTiles: MAX_RESIDENT_TILES,
        // The label atlas bakes its device-px shelf height from the dpr it is
        // built with, so the very first atlas must already know the real one.
        viewport: viewportRef.current,
      })
    } catch (err) {
      // A shader compile or link failure lands here. Report it as an error
      // status rather than crashing the whole view; the parent falls back.
      console.error('knowledge map: renderer creation failed', err)
      rendererRef.current = null
      emitStatus('error')
      return
    }
    rendererRef.current = renderer
    attachRenderer(renderer)

    // ── Context loss ──
    // The renderer already preventDefaults the loss event (that is what makes
    // a restore possible at all); the shell's job is to re-upload from the
    // CPU arrays the store kept, which is why a restore costs no network.
    const onLost = () => {
      emitStatus('error')
    }
    const onRestored = () => {
      // Read the ref rather than the captured `renderer`: by the time a
      // restore arrives this generation may already have been recycled, and
      // restoring the disposed instance would restore nothing at all.
      const live = rendererRef.current
      if (live !== renderer) return
      live.restore(storeRef.current?.residentTiles() ?? [])
      const p = paletteRef.current
      if (p) live.setPalette(p)
      const meta = metaRef.current
      if (meta) live.setWorld(meta.world, meta.maxZ)
      labelsDirtyRef.current = true
      emitStatus(meta && meta.counts.nodes === 0 ? 'empty' : 'ready')
      schedulerRef.current?.markDirty()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      // Only clear the ref if it still points at THIS generation: an idle
      // dispose already nulled it, and a recycle has not yet run its own
      // create (effects clean up before they re-run).
      if (rendererRef.current === renderer) rendererRef.current = null
      // Dispose unconditionally: a leaked context per strict-mode mount is the
      // bug this ordering exists to prevent. Safe to lose the context here
      // because this canvas element is being discarded with it.
      renderer.dispose()
    }
  }, [supported, glGen, attachRenderer, emitStatus])

  // ── dataSource identity change ⇒ swap the source, keep the camera ──────────
  const firstSourceRef = useRef(true)
  useEffect(() => {
    if (supported !== true) return
    if (firstSourceRef.current) {
      firstSourceRef.current = false
      return
    }
    const store = storeRef.current
    if (!store) return
    void store.setSource(dataSource)
  }, [dataSource, supported])

  // ── refreshToken ⇒ revalidate ──────────────────────────────────────────────
  const pendingRevalidateRef = useRef(false)
  const lastTokenRef = useRef(refreshToken)
  useEffect(() => {
    if (supported !== true) return
    if (lastTokenRef.current === refreshToken) return
    lastTokenRef.current = refreshToken
    const store = storeRef.current
    if (!store) return
    // While inactive the store's network is paused; remember and catch up on
    // reactivation rather than waking the tab to fetch (§4.5).
    if (!active) {
      pendingRevalidateRef.current = true
      return
    }
    void store.revalidate()
  }, [refreshToken, active, supported])

  // ── active / document.hidden ⇒ pause; 10 s inactive ⇒ release the context ──
  //
  // The dispose and the rebuild are both expressed as a GENERATION BUMP rather
  // than as direct createMapRenderer/dispose calls: the renderer effect above
  // is the single owner, so there is exactly one create and one dispose per
  // generation however these two effects interleave. The idle timer is always
  // cleared by this effect's cleanup, so reactivating (or unmounting) before
  // 10 s cannot dispose a renderer that is back in use.
  useEffect(() => {
    if (supported !== true) return
    const scheduler = schedulerRef.current
    const store = storeRef.current
    if (!scheduler || !store) return

    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const applyVisibility = () => {
      const hidden = typeof document !== 'undefined' && document.hidden
      if (!active) {
        scheduler.pause()
        store.pause()
        labelSettleRef.current?.cancel()
        return
      }
      if (hidden) {
        // Hidden but still the active tab: only stop scheduling frames. The
        // network keeps streaming so the map is complete when it reappears.
        scheduler.pause()
        return
      }
      store.resume()
      scheduler.resume()
      scheduler.markDirty()
    }

    if (!active) {
      applyVisibility()
      idleTimer = setTimeout(() => {
        idleTimer = null
        // Release the GPU context but KEEP the tile store: its CPU typed
        // arrays are what makes coming back free of network traffic. The
        // renderer effect's cleanup disposes the instance and unmounts its
        // canvas; the mount half is skipped while inactive.
        if (rendererRef.current) {
          idleDisposedRef.current = true
          recycleRenderer()
        }
      }, IDLE_DISPOSE_MS)
    } else {
      // Coming back after an idle dispose: one bump rebuilds the GL stack on a
      // fresh canvas and `attachRenderer` re-uploads from the store's CPU
      // copies. Guarded on the flag, not on `rendererRef.current`, because a
      // genuine creation failure also leaves the ref null and must not spin.
      if (idleDisposedRef.current) {
        idleDisposedRef.current = false
        recycleRenderer()
      }
      applyVisibility()
      if (pendingRevalidateRef.current) {
        pendingRevalidateRef.current = false
        void store.revalidate()
      }
    }

    const onVisibility = () => applyVisibility()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
    // `recycleRenderer` is a stable useCallback, so listing it re-runs nothing
    // — it just keeps the linter honest about what this effect reaches for.
  }, [active, supported, recycleRenderer])

  // ── Resize ─────────────────────────────────────────────────────────────────
  //
  // The CSS-px viewport updates IMMEDIATELY (picking, camera limits and label
  // placement all work in CSS space and must follow the element), while the
  // backing-store realloc — a fresh WKWebView surface and an IPC round trip —
  // is debounced for CONTINUOUS drags only.
  //
  // Within the debounce window the renderer deliberately renders at the OLD
  // backing-store size and projects against the CSS size that store covers
  // (see renderer.render), so the frame is a clean uniform scale rather than a
  // crop. A drag therefore reads as the map smoothly rescaling and snapping to
  // full sharpness when you let go — which is how every other canvas in the
  // dashboard behaves. A DISCRETE JUMP (panel toggle, window snap) fires once,
  // so there is nothing to coalesce and the soft-then-sharp step would be the
  // only thing the user notices: those realloc immediately.
  useEffect(() => {
    if (supported !== true) return
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const applySize = () => {
      rendererRef.current?.resize(viewportRef.current)
      schedulerRef.current?.markDirty()
    }
    const settle = new SettleTimer(RESIZE_SETTLE_MS, applySize)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, MAX_DPR)
      const prev = viewportRef.current
      if (prev.width === width && prev.height === height && prev.dpr === dpr) return

      viewportRef.current = { width, height, dpr }
      const meta = metaRef.current
      if (meta) {
        cameraRef.current = clampCamera(cameraRef.current, cameraLimits(meta.world, viewportRef.current))
      }
      labelsDirtyRef.current = true
      schedulerRef.current?.markDirty()

      // A dpr change must never go through the debounce: the backing store
      // would be allocated for the wrong ratio and `render` derives the CSS
      // size it projects with from that store, so the map would be drawn at
      // the wrong scale until the timer fired. `resize` rebuilds the label
      // atlas at the new dpr too, which is why a display change no longer
      // needs a whole new renderer.
      const dprChanged = prev.dpr !== dpr
      const jumped =
        Math.abs(width - prev.width) > prev.width * RESIZE_JUMP_FRACTION ||
        Math.abs(height - prev.height) > prev.height * RESIZE_JUMP_FRACTION
      if (dprChanged || jumped) {
        settle.cancel()
        applySize()
      } else {
        settle.bump()
      }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      settle.dispose()
    }
  }, [supported])

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (supported !== true || typeof document === 'undefined') return
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      const palette = readPalette()
      paletteRef.current = palette
      rendererRef.current?.setPalette(palette)
      // Label colour comes from the palette uniform, but the atlas rasterises
      // glyphs in a fixed colour and tints them — so only a repaint is needed.
      labelsDirtyRef.current = true
      schedulerRef.current?.markDirty()
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [supported])

  // ── Externally driven selection ────────────────────────────────────────────
  useEffect(() => {
    if (supported !== true) return
    const key = selectedKey ?? null
    if (selectedKeyRef.current === key) return
    selectedKeyRef.current = key
    const store = storeRef.current
    if (!key) {
      pinnedRef.current = null
      setAnnouncement('')
    } else {
      // Not resident yet: drop the previous pin, or its ring would stay on the
      // old node; onTileLoaded rings the new one when its tile lands.
      const found = store?.findByKey(key)
      pinnedRef.current = found
        ? {
            key,
            wx: found.tile.ox + found.tile.nodeX[found.index],
            wy: found.tile.oy + found.tile.nodeY[found.index],
            r: found.tile.nodeR[found.index],
          }
        : null
    }
    applyHighlight()
  }, [selectedKey, supported, applyHighlight])

  // ── Keyboard: '0' fits, Escape clears ──────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === '0') {
        e.preventDefault()
        const meta = metaRef.current
        if (!meta) return
        cameraCtlRef.current?.flyTo(
          contentRectRef.current
            ? fitRect(contentRectRef.current, viewportRef.current)
            : fitWorld(meta.world, viewportRef.current),
        )
        schedulerRef.current?.markDirty()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (selectedKeyRef.current === null && pinnedRef.current === null) return
        selectedKeyRef.current = null
        pinnedRef.current = null
        onSelectRef.current?.(null)
        setAnnouncement('')
        applyHighlight()
      }
    },
    [applyHighlight],
  )

  // ── Imperative handle ──────────────────────────────────────────────────────
  useImperativeHandle(
    ref,
    (): KnowledgeMapHandle => ({
      flyTo(wx, wy, k) {
        const controller = cameraCtlRef.current
        if (!controller) return
        controller.flyTo({ x: wx, y: wy, k: k ?? cameraRef.current.k })
        schedulerRef.current?.markDirty()
      },
      fitAll() {
        const meta = metaRef.current
        const controller = cameraCtlRef.current
        if (!meta || !controller) return
        controller.flyTo(
          contentRectRef.current
            ? fitRect(contentRectRef.current, viewportRef.current)
            : fitWorld(meta.world, viewportRef.current),
        )
        schedulerRef.current?.markDirty()
      },
    }),
    [],
  )

  // An unsupported browser renders an empty container and nothing else: the
  // parent has already been told via onStatus and swaps in the legacy renderer.
  if (supported === false) {
    return <div ref={containerRef} className="h-full w-full" data-knowledge-map="unsupported" />
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="Knowledge map"
      onKeyDown={onKeyDown}
      // No background, opacity, filter or will-change here: this canvas sits
      // inside the dashboard's backdrop-filter glass panel, and any of those
      // would promote a layer and kill the blur behind it.
      className="relative h-full w-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 active:cursor-grabbing"
      data-knowledge-map="ready"
    >
      {/*
        Keyed by the GL generation: a renderer's dispose() deliberately loses
        its context, and a lost context can never be re-acquired on the same
        element — getContext returns the same dead object forever. So each
        generation gets its own element and React discards the old one.
      */}
      <canvas key={glGen} ref={canvasRef} className="block h-full w-full" />
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {showStats && stats ? <StatsOverlay stats={stats} /> : null}
    </div>
  )
})

/**
 * Has the world moved so far under the camera that refitting is kinder than
 * leaving the user in the void? Only true when the camera CENTRE falls outside
 * the new world square — an ordinary append grows the bounds slightly and must
 * not disturb the view (§4.5).
 */
function worldMovedAway(previous: MapMeta, next: MapMeta, camera: CameraState): boolean {
  if (
    previous.world.minX === next.world.minX &&
    previous.world.minY === next.world.minY &&
    previous.world.size === next.world.size
  ) {
    return false
  }
  const { minX, minY, size } = next.world
  return (
    camera.x < minX || camera.x > minX + size || camera.y < minY || camera.y > minY + size
  )
}

/**
 * Remove the benchmark probes from `window`.
 *
 * Called on every frame that runs with `showStats` off, so the probes can only
 * ever exist while the dev bench is actually displaying stats. They hold the
 * last frame's tiles and a closure over the spatial index, which must not
 * outlive the benchmark that asked for them.
 */
function clearDebugProbes(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__kmStats === undefined && w.__kmDebug === undefined && w.__kmFrameLog === undefined) {
    return
  }
  delete w.__kmStats
  delete w.__kmDebug
  delete w.__kmFrameLog
}

function describeSelection(node: PickedNode): string {
  const label = node.label || node.key
  if (node.kind === 'claim') return `Selected claim: ${label}`
  if (node.kind === 'virtual') return `Selected group: ${label}`
  return `Selected ${node.entityType ?? 'entity'}: ${label}`
}

export default KnowledgeMap
