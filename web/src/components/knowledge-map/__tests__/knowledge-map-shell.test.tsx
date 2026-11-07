// @vitest-environment jsdom
/**
 * The React shell's LIFECYCLE contract — the part of knowledge-map.tsx that is
 * not about pixels and therefore can be pinned without a GPU.
 *
 * Four properties are worth a test because each has a real failure mode that
 * only shows up in the desktop app, where pop-out windows share one WKWebView
 * GPU process:
 *
 *   1. Exactly one live GL context per mounted instance, and it is released on
 *      unmount. React 19 strict mode double-invokes effects in dev, so a
 *      renderer that is created but not disposed leaks a context per mount
 *      until the browser starts killing the oldest ones — which blanks a map
 *      in a DIFFERENT window.
 *   2. An unsupported browser allocates nothing at all: no renderer, no tile
 *      store, no request. It reports `unsupported` and renders an empty box so
 *      the parent can fall back to the legacy renderer.
 *   3. Render on demand: after the map settles, no further frames run. A
 *      perpetual rAF is the default failure mode of canvas components.
 *   4. `setWorld` lands before the first render. Until it does, the renderer's
 *      world size defaults to 1 and every tile above level 0 computes a zoom
 *      alpha of zero — a blank map with no error anywhere (GL layer note).
 *
 * WebGL itself is mocked: jsdom has no WebGL2 context, and the real shaders
 * are exercised by the /dev/knowledge-map benchmark page instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, StrictMode } from 'react'
import type { MapMeta, MapTile } from '@/lib/knowledge/graph-map/types'
import type { MapDataSource, MapStatus } from '../types'
import { cameraLimits, clampCamera, fitRect, worldToScreen } from '../camera'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─── Mocks ────────────────────────────────────────────────────────────────────

interface FakeRenderer {
  /** Creation order, 0-based — which generation this instance is. */
  readonly seq: number
  /** The <canvas> this renderer was built against. */
  readonly canvas: HTMLCanvasElement
  disposed: boolean
  /** Every method call made AFTER dispose() — must always be empty. */
  callsAfterDispose: string[]
  worldCalls: Array<{ size: number; maxZ: number }>
  renderCalls: number
  /** renderCalls at the moment setWorld was first called. */
  rendersBeforeWorld: number | null
  rendersWithoutWorld: number
  paletteCalls: number
  uploaded: string[]
  removed: string[]
  clears: number
  restores: number
  reuploads: string[][]
  resizes: Array<{ width: number; height: number; dpr: number }>
  /** The dpr this instance's atlas would have been built at. */
  readonly builtDpr: number
}

const hoisted = vi.hoisted(() => ({
  probeOk: true,
  /**
   * Every renderer ever created, in order — a FACTORY record rather than a
   * single instance, because the shell creates and destroys renderers many
   * times during one mount (dpr change, idle dispose, strict-mode remount) and
   * the interesting failures are all about which instance a call reached.
   */
  renderers: [] as unknown[],
  /** Next createMapRenderer call throws — the creation-failure path. */
  failNextCreate: false,
}))

vi.mock('../capabilities', () => ({
  probeWebGL2: () => (hoisted.probeOk ? { ok: true } : { ok: false, reason: 'test' }),
}))

vi.mock('../renderer', () => ({
  createMapRenderer: (
    canvas: HTMLCanvasElement,
    opts: { maxResidentTiles: number; viewport?: { dpr: number } },
  ) => {
    if (hoisted.failNextCreate) {
      hoisted.failNextCreate = false
      throw new Error('shader failed to compile')
    }
    const seq = hoisted.renderers.length
    // Every method routes through `track`, so "no call after dispose" is a
    // property of the fake rather than something each test has to remember.
    const note = (name: string) => {
      if (r.disposed) r.callsAfterDispose.push(name)
    }
    const r: FakeRenderer = {
      seq,
      canvas,
      disposed: false,
      callsAfterDispose: [],
      worldCalls: [],
      renderCalls: 0,
      rendersBeforeWorld: null,
      rendersWithoutWorld: 0,
      paletteCalls: 0,
      uploaded: [],
      removed: [],
      clears: 0,
      restores: 0,
      reuploads: [],
      resizes: [],
      builtDpr: opts.viewport?.dpr ?? 1,
      setWorld(this: FakeRenderer, world: { size: number }, maxZ: number) {
        note('setWorld')
        if (this.rendersBeforeWorld === null) this.rendersBeforeWorld = this.renderCalls
        this.worldCalls.push({ size: world.size, maxZ })
      },
      uploadTile(this: FakeRenderer, tile: { id: string }) {
        note('uploadTile')
        this.uploaded.push(tile.id)
      },
      removeTile(this: FakeRenderer, tile: { id: string }) {
        note('removeTile')
        this.removed.push(tile.id)
      },
      clear(this: FakeRenderer) {
        note('clear')
        this.clears++
      },
      setPalette(this: FakeRenderer) {
        note('setPalette')
        this.paletteCalls++
      },
      setHighlight() {
        note('setHighlight')
      },
      setLabels() {
        note('setLabels')
      },
      render(this: FakeRenderer) {
        note('render')
        // Recorded from the RENDERER's point of view: if a frame ever runs
        // while the world is still unset, the tile alpha for every level above
        // 0 is computed against a world size of 1 and the map paints blank.
        if (this.worldCalls.length === 0) this.rendersWithoutWorld++
        this.renderCalls++
      },
      needsAnotherFrame: () => false,
      resize(this: FakeRenderer, viewport: { width: number; height: number; dpr: number }) {
        note('resize')
        this.resizes.push({ ...viewport })
      },
      isContextLost: () => false,
      restore(this: FakeRenderer) {
        note('restore')
        this.restores++
      },
      reupload(this: FakeRenderer, tiles: Array<{ id: string }>) {
        note('reupload')
        this.reuploads.push(tiles.map((t) => t.id))
        for (const t of tiles) this.uploaded.push(t.id)
      },
      atlasDpr(this: FakeRenderer) {
        return this.builtDpr
      },
      dispose(this: FakeRenderer) {
        this.disposed = true
      },
      stats: () => ({ drawCalls: 1, nodesDrawn: 2, edgesDrawn: 3, labels: 4 }),
      measureLabel: (text: string) => text.length * 6,
    } as unknown as FakeRenderer
    hoisted.renderers.push(r)
    return r
  },
  EDGE_FADE_MIN_NEIGHBOUR_PX: 1.5,
  EDGE_FADE_MAX_NEIGHBOUR_PX: 6,
}))

/** Typed view of the factory's record. */
function instances(): FakeRenderer[] {
  return hoisted.renderers as FakeRenderer[]
}

/** The one renderer that is currently live, or undefined while disposed. */
function live(): FakeRenderer | undefined {
  return instances().find((r) => !r.disposed)
}

// A deterministic palette; readPalette reaches into getComputedStyle otherwise.
vi.mock('../palette', () => ({
  readPalette: () => ({
    claim: [0, 0, 0, 1],
    claimSuggested: [0, 0, 0, 1],
    entity: [0, 0, 0, 1],
    virtual: [0, 0, 0, 1],
    edge: [0, 0, 0, 1],
    accent: [0, 0, 0, 1],
    label: [0, 0, 0, 1],
    dim: 0.28,
    isDark: false,
  }),
}))

const { default: KnowledgeMap } = await import('../knowledge-map')

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<MapMeta> = {}): MapMeta {
  return {
    version: 'v1',
    world: { minX: 0, minY: 0, size: 1024 },
    maxZ: 2,
    counts: { nodes: 3, edges: 1, claims: 2, hubs: 1, totalClaims: 2 },
    entityTypes: ['capture'],
    relations: ['mentions'],
    manifest: [[0, 0, 0, 3, 1]],
    projects: [],
    promote: { total: 0, topClaimIds: [] },
    ...overrides,
  }
}

function makeTile(): MapTile {
  return {
    z: 0,
    x: 0,
    y: 0,
    ox: 0,
    oy: 0,
    size: 1024,
    dropped: 0,
    droppedEdges: 0,
    nodes: {
      id: [1, 2, 3],
      key: ['capture:a', 'claim:b', 'claim:c'],
      kind: [1, 0, 0],
      etype: [0, -1, -1],
      x: [500, 520, 540],
      y: [500, 520, 540],
      r: [8, 4, 4],
      importance: [1000, 2, 1],
      degree: [2, 1, 1],
      flags: [0, 0, 1],
      label: ['Capture A', 'Claim B', 'Claim C'],
    },
    edges: { s: [1], t: [1], tx: [500], ty: [500], rel: [0] },
  }
}

/** An in-memory source that resolves synchronously via microtasks. */
function makeSource(meta = makeMeta(), tiles: MapTile[] = [makeTile()]): MapDataSource {
  return {
    filters: {},
    async loadMap() {
      return { ...meta, tiles }
    },
    async loadTiles() {
      return []
    },
  }
}

/** A child tile at z=1 the store will fetch once the camera wants it. */
function makeChildTile(): MapTile {
  return {
    ...makeTile(),
    z: 1,
    x: 0,
    y: 0,
    size: 128,
    nodes: {
      ...makeTile().nodes,
      id: [11, 12, 13],
      key: ['capture:d', 'claim:e', 'claim:f'],
      x: [100, 120, 140],
      y: [100, 120, 140],
    },
  }
}

/**
 * A source whose z=1 tile is served only when the test releases it.
 *
 * This is how a tile that arrives AFTER a renderer swap is produced: the
 * interesting bug is that the store's callbacks pointed at the renderer that
 * existed when the store was built, so anything landing later was uploaded
 * into a corpse and the live renderer showed a hole there forever.
 */
function makeDeferredSource(): MapDataSource & { release(): void; requested: number } {
  let resolveTiles: ((t: MapTile[]) => void) | null = null
  const api = {
    filters: {},
    requested: 0,
    async loadMap() {
      return {
        // A 256-unit world fitted into the 800x600 harness viewport puts the
        // camera at k ≈ 2.3, so the continuous zoom is already past level 1
        // and the store wants the z=1 child from the very first frame — no
        // camera animation needed to make the fetch happen.
        ...makeMeta({
          world: { minX: 0, minY: 0, size: 256 },
          maxZ: 1,
          manifest: [[0, 0, 0, 3, 1], [1, 0, 0, 3, 0]],
        }),
        tiles: [{ ...makeTile(), size: 256, nodes: { ...makeTile().nodes, x: [100, 120, 140], y: [100, 120, 140] } }],
      }
    },
    loadTiles(): Promise<MapTile[]> {
      api.requested++
      return new Promise<MapTile[]>((resolve) => {
        resolveTiles = resolve
      })
    },
    release() {
      resolveTiles?.([makeChildTile()])
      resolveTiles = null
    },
  }
  return api as MapDataSource & { release(): void; requested: number }
}

// ─── Harness ──────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
/** rAF callbacks the component queued, run only when the test says so. */
let rafQueue: Array<(now: number) => void>
let rafTime: number
/** Every live ResizeObserver, so a test can drive a resize by hand. */
let observers: Array<{ el: Element; cb: ResizeObserverCallback }>

/** Fire a contentRect change at whatever the shell is observing. */
function emitResize(width: number, height: number): void {
  for (const o of observers) {
    o.cb(
      [{ target: o.el, contentRect: { width, height } } as unknown as ResizeObserverEntry],
      null as unknown as ResizeObserver,
    )
  }
}

beforeEach(() => {
  hoisted.probeOk = true
  hoisted.failNextCreate = false
  hoisted.renderers.length = 0
  rafQueue = []
  rafTime = 0
  observers = []
  // Default to a non-Retina display; the dpr tests set their own.
  vi.stubGlobal('devicePixelRatio', 1)

  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    rafQueue[handle - 1] = () => {}
  })
  // jsdom has no ResizeObserver; the shell must tolerate it being present, and
  // the resize tests need to drive it.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observers.push({ el, cb: this.cb })
      }
      unobserve() {}
      disconnect() {
        observers = observers.filter((o) => o.cb !== this.cb)
      }
    },
  )
  // The shell measures its OWN inner container inside the mount effect, before
  // a test can get a reference to it — so the size has to be in place on the
  // prototype from the start, not patched onto a node afterwards.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Run queued frames until the map goes idle (or `limit` frames pass). */
async function settle(limit = 20): Promise<number> {
  let ran = 0
  for (let i = 0; i < limit; i++) {
    if (rafQueue.length === 0) {
      // The store's load() is async, so the first frame is armed a microtask
      // or two after the render returns. Give those a chance before deciding
      // the map has gone idle — otherwise a test sees zero frames and the
      // "render on demand" assertions become vacuously true.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    if (rafQueue.length === 0) break
    const queued = rafQueue
    rafQueue = []
    rafTime += 16
    await act(async () => {
      for (const cb of queued) cb(rafTime)
    })
    ran += queued.length
  }
  return ran
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeMap shell — capability fallback', () => {
  it('reports `unsupported` and builds no renderer when WebGL2 is unavailable', async () => {
    hoisted.probeOk = false
    const statuses: MapStatus[] = []
    const loadMap = vi.fn()

    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: { filters: {}, loadMap, loadTiles: vi.fn() } as unknown as MapDataSource,
          onStatus: (s: MapStatus) => statuses.push(s),
        }),
      )
    })

    expect(statuses).toContain('unsupported')
    // Nothing was allocated: no context, and no network request either.
    expect(instances()).toHaveLength(0)
    expect(loadMap).not.toHaveBeenCalled()
    expect(container.querySelector('[data-knowledge-map="unsupported"]')).not.toBeNull()
    expect(container.querySelector('canvas')).toBeNull()
  })
})

describe('KnowledgeMap shell — GL context lifecycle', () => {
  it('keeps exactly one live context under strict mode and releases it on unmount', async () => {
    await act(async () => {
      root.render(h(StrictMode, null, h(KnowledgeMap, { dataSource: makeSource() })))
    })
    await settle()

    // Strict mode may CREATE two renderers (it double-invokes the effect), but
    // all but one must already be disposed — that is the leak this guards.
    expect(instances().filter((r) => !r.disposed)).toHaveLength(1)

    await act(async () => root.unmount())
    expect(instances().every((r) => r.disposed)).toBe(true)
  })

  it('disposes the renderer when the component unmounts normally', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    expect(instances().filter((r) => !r.disposed)).toHaveLength(1)

    await act(async () => root.unmount())
    expect(instances().every((r) => r.disposed)).toBe(true)
  })
})

describe('KnowledgeMap shell — data wiring', () => {
  it('calls setWorld BEFORE the first render, or every deep tile paints blank', async () => {
    // The interleave has to be FORCED. onMeta is reached from an awaited
    // loadMap, so in a quiet harness any microtask-deferred setWorld still
    // lands before the first frame and the ordering bug hides. Draining the
    // rAF queue from inside onMeta reproduces the real sequence: the store
    // requests a frame the moment meta lands, and that frame must already see
    // the world.
    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: makeSource(),
          onMeta: () => {
            const queued = rafQueue
            rafQueue = []
            rafTime += 16
            for (const cb of queued) cb(rafTime)
          },
        }),
      )
    })
    await settle()

    const r = live()!
    expect(r.worldCalls.length).toBeGreaterThan(0)
    expect(r.worldCalls[0]).toEqual({ size: 1024, maxZ: 2 })
    // No frame had run when setWorld first landed...
    expect(r.rendersBeforeWorld).toBe(0)
    // ...and, symmetrically, no frame ever ran with the world still unset.
    // This is the assertion that catches a DEFERRED setWorld, which the
    // counter above cannot: a microtask-deferred call still records 0 there.
    expect(r.rendersWithoutWorld).toBe(0)
    expect(r.renderCalls).toBeGreaterThan(0)
  })

  it('uploads the inline tiles and reports `ready`', async () => {
    const statuses: MapStatus[] = []
    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: makeSource(),
          onStatus: (s: MapStatus) => statuses.push(s),
        }),
      )
    })
    await settle()

    const r = live()!
    expect(r.uploaded).toContain('0.0.0')
    expect(statuses).toContain('ready')
    expect(r.renderCalls).toBeGreaterThan(0)
  })

  it('reports `empty` rather than `ready` for a map with no nodes', async () => {
    const statuses: MapStatus[] = []
    const meta = makeMeta({
      counts: { nodes: 0, edges: 0, claims: 0, hubs: 0, totalClaims: 0 },
      manifest: [],
    })
    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: makeSource(meta, []),
          onStatus: (s: MapStatus) => statuses.push(s),
        }),
      )
    })
    await settle()
    expect(statuses).toContain('empty')
    expect(statuses).not.toContain('ready')
  })

  it('forwards the loaded meta to onMeta', async () => {
    const onMeta = vi.fn()
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource(), onMeta }))
    })
    await settle()
    expect(onMeta).toHaveBeenCalledTimes(1)
    expect(onMeta.mock.calls[0][0].version).toBe('v1')
  })

  it('keeps what is drawn when a tile fails, rather than blanking to `error`', async () => {
    const statuses: MapStatus[] = []
    const source: MapDataSource = {
      filters: {},
      async loadMap() {
        return { ...makeMeta(), tiles: [makeTile()] }
      },
      async loadTiles() {
        throw new Error('tile 2.1.1 exploded')
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: source,
          onStatus: (s: MapStatus) => statuses.push(s),
        }),
      )
    })
    await settle()
    expect(statuses).toContain('ready')
    expect(statuses).not.toContain('error')
    errorSpy.mockRestore()
  })

  it('reports `error` when the very first load fails with nothing on screen', async () => {
    const statuses: MapStatus[] = []
    const source: MapDataSource = {
      filters: {},
      async loadMap() {
        throw new Error('network down')
      },
      async loadTiles() {
        return []
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(
        h(KnowledgeMap, {
          dataSource: source,
          onStatus: (s: MapStatus) => statuses.push(s),
        }),
      )
    })
    await settle()
    expect(statuses).toContain('error')
    errorSpy.mockRestore()
  })
})

describe('KnowledgeMap shell — render on demand', () => {
  it('stops scheduling frames once the map has settled', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()

    // Nothing changed, so nothing is armed: an idle map costs zero frames.
    expect(rafQueue).toHaveLength(0)

    const r = live()!
    const before = r.renderCalls
    // Flushing again must not produce a frame out of nowhere.
    await settle()
    expect(r.renderCalls).toBe(before)
  })

  it('does not schedule frames while inactive', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource(), active: false }))
    })
    await settle()
    const r = live()
    // Either no renderer ran a frame, or none is armed — both mean "paused".
    expect(rafQueue).toHaveLength(0)
    expect(r?.renderCalls ?? 0).toBe(0)
  })
})

describe('KnowledgeMap shell — picking', () => {
  it('selects the node under a click and announces it', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource(), onSelect }))
    })
    await settle()

    const app = container.querySelector('[role="application"]') as HTMLElement

    // Click exactly where the camera says the hub is painted, rather than at a
    // hard-coded pixel: a literal here would silently encode one y convention
    // and pass forever once the projection and the hit test agreed on the
    // WRONG one (that is the mirrored-picking defect). The opening view frames
    // the CONTENT of the root tile (its nodes' bbox, radii included), clamped
    // to the zoom limits — not the world square, which reserves empty disc
    // space. The capture hub at world (500,500) is the top-left node of the
    // fixture, so with world +y = screen DOWN it lands up and left of the
    // viewport centre.
    const viewport = { width: 800, height: 600, dpr: 1 }
    const content = { minX: 500 - 8, minY: 500 - 8, maxX: 540 + 4, maxY: 540 + 4 }
    const camera = clampCamera(
      fitRect(content, viewport),
      cameraLimits({ minX: 0, minY: 0, size: 1024 }, viewport),
    )
    const hub = worldToScreen(camera, viewport, 500, 500)
    expect(hub.x).toBeLessThan(viewport.width / 2)
    expect(hub.y).toBeLessThan(viewport.height / 2)
    const centre = { clientX: hub.x, clientY: hub.y }
    await act(async () => {
      app.dispatchEvent(new PointerEvent('pointerdown', { ...centre, pointerId: 1, bubbles: true }))
      app.dispatchEvent(new PointerEvent('pointerup', { ...centre, pointerId: 1, bubbles: true }))
    })
    await settle()

    expect(onSelect).toHaveBeenCalled()
    const node = onSelect.mock.calls.at(-1)![0]
    expect(node).not.toBeNull()
    expect(node.key).toBe('capture:a')
    expect(node.kind).toBe('entity')
    // The live region names the selection for a screen reader.
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live.textContent).toBe('Selected capture: Capture A')
  })

  it('clears the selection when the click lands on empty space', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource(), onSelect }))
    })
    await settle()

    const app = container.querySelector('[role="application"]') as HTMLElement

    const corner = { clientX: 5, clientY: 5 }
    await act(async () => {
      app.dispatchEvent(new PointerEvent('pointerdown', { ...corner, pointerId: 2, bubbles: true }))
      app.dispatchEvent(new PointerEvent('pointerup', { ...corner, pointerId: 2, bubbles: true }))
    })
    await settle()

    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('picks against the DRAWN tiles, so an off-screen resident tile is never selected', async () => {
    // Two tiles: one under the camera, one far away. The far tile stays
    // resident (the LRU keeps ancestors and recent tiles) but is outside the
    // viewport, so a click must never resolve into it.
    const near = makeTile()
    const far: MapTile = {
      ...makeTile(),
      ox: 900_000,
      oy: 900_000,
      nodes: {
        ...makeTile().nodes,
        id: [91, 92, 93],
        key: ['capture:far', 'claim:far1', 'claim:far2'],
        // Same TILE-LOCAL coordinates as the near tile's nodes — so a picker
        // that forgot to offset by the tile origin, or that walked tiles the
        // frame did not draw, would happily return one of these.
        importance: [99_999, 5, 4],
      },
    }
    const onSelect = vi.fn()
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource(makeMeta(), [near, far]), onSelect }))
    })
    await settle()

    const app = container.querySelector('[role="application"]') as HTMLElement

    const centre = { clientX: 400, clientY: 300 }
    await act(async () => {
      app.dispatchEvent(new PointerEvent('pointerdown', { ...centre, pointerId: 3, bubbles: true }))
      app.dispatchEvent(new PointerEvent('pointerup', { ...centre, pointerId: 3, bubbles: true }))
    })
    await settle()

    const node = onSelect.mock.calls.at(-1)?.[0]
    // The far tile's hub has by far the highest importance, so an unfiltered
    // pick would prefer it.
    expect(node?.key).not.toBe('capture:far')
  })
})

describe('KnowledgeMap shell — accessibility', () => {
  it('exposes an application role, a label, a focusable container and a live region', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()

    const app = container.querySelector('[role="application"]') as HTMLElement
    expect(app).not.toBeNull()
    expect(app.getAttribute('aria-label')).toBe('Knowledge map')
    expect(app.tabIndex).toBe(0)
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('does not promote a compositing layer on the container', async () => {
    // A transform / opacity / filter / will-change here breaks the dashboard's
    // backdrop-filter glass panel (documented twice in tabs/tab-content.tsx).
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    const app = container.querySelector('[role="application"]') as HTMLElement
    const className = app.className
    expect(className).not.toMatch(/\bopacity-/)
    expect(className).not.toMatch(/\bwill-change/)
    expect(className).not.toMatch(/\bbackdrop-/)
    expect(app.style.transform).toBe('')
    expect(app.style.filter).toBe('')
  })
})

// ─── Renderer lifecycle across recreations ────────────────────────────────────
//
// The renderer is not a singleton: one mount creates and destroys it many
// times (a display change, the 10 s idle dispose, a context loss, strict
// mode's double invoke). Every bug in this group had the same shape — some
// piece of wiring captured the FIRST instance and kept talking to it after it
// was disposed, silently, because a disposed renderer's methods return early
// rather than throwing. So these tests are all about WHICH instance a call
// reached, which is why the mock is a factory that records every one.

/**
 * Fake ONLY the timer functions the shell schedules on.
 *
 * vitest's default set includes requestAnimationFrame, which would replace the
 * queue-recording stub the whole harness is built on and leave every frame
 * unrunnable — the map would look permanently idle and these tests would pass
 * for the wrong reason.
 */
function useIdleTimers(): void {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}

/** Drive the idle timer without waiting 10 s of wall clock. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('KnowledgeMap shell — renderer recreation', () => {
  beforeEach(() => {
    useIdleTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases the context after 10 s inactive and rebuilds on a FRESH canvas', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const first = live()!
    const firstCanvas = container.querySelector('canvas')
    expect(firstCanvas).toBe(first.canvas)

    // Go inactive and let the idle timer fire.
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    expect(first.disposed).toBe(true)
    // The whole point of the idle dispose: no context is held while away.
    expect(live()).toBeUndefined()

    // Come back.
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()

    const second = live()!
    expect(second).not.toBe(first)
    // A renderer's dispose() loses its context, and a lost context can NEVER
    // be re-acquired on the same element — getContext hands back the same dead
    // object. Reusing the element made every recreation fail permanently with
    // a shader-compile error, so a new element is the fix, not a nicety.
    expect(second.canvas).not.toBe(first.canvas)
    expect(container.querySelector('canvas')).toBe(second.canvas)
  })

  it('brings the second renderer fully up to date: world, palette and every resident tile', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const first = live()!
    expect(first.uploaded).toContain('0.0.0')

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()

    const second = live()!
    expect(second).not.toBe(first)
    // Without this the map comes back blank: the tiles are resident on the CPU
    // but the new renderer's slabs were never written.
    expect(second.uploaded).toContain('0.0.0')
    expect(second.paletteCalls).toBeGreaterThan(0)
    expect(second.worldCalls[0]).toEqual({ size: 1024, maxZ: 2 })
    expect(second.resizes.length).toBeGreaterThan(0)
    // And no frame ran against it before the world was known.
    expect(second.rendersWithoutWorld).toBe(0)
  })

  it('re-uploads rather than restoring, so a fresh renderer never rebuilds GL state twice', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()

    const second = live()!
    // restore() re-acquires the context and re-runs buildGlState(), then only
    // FORGETS the previous names — on a brand-new renderer whose constructor
    // has already built everything, that orphans a full set of programs,
    // buffers and VAOs (~13 MB of VRAM) per recreation with nothing left to
    // free them. The recycle path must use reupload().
    expect(second.restores).toBe(0)
    expect(second.reuploads.length).toBe(1)
    expect(second.reuploads[0]).toContain('0.0.0')
  })

  it('routes a tile that arrives AFTER a recreation to the LIVE renderer', async () => {
    const source = makeDeferredSource()
    const props = { dataSource: source as unknown as MapDataSource }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const first = live()!
    // The fitted camera already wants the z=1 child, so a fetch is open and
    // the deferred source is holding it.
    expect(source.requested).toBeGreaterThan(0)

    // Recycle: away for 10 s, then back.
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const second = live()!
    expect(second).not.toBe(first)

    const uploadedBefore = second.uploaded.length
    // The tile finishes downloading now — long after the store's callbacks
    // were created, when `first` was the only renderer that existed.
    await act(async () => {
      source.release()
      await Promise.resolve()
    })
    await settle()

    const arrived = second.uploaded.slice(uploadedBefore)
    expect(arrived).toContain('1.0.0')
    // The disposed instance must not have been touched at all: a callback that
    // captured it would upload into a corpse and the live renderer's slab for
    // that tile would stay empty — a permanent hole wherever the user pans.
    expect(first.uploaded).not.toContain('1.0.0')
    expect(first.callsAfterDispose).toEqual([])
  })

  it('sends a filter-change reset to the live renderer, not the disposed one', async () => {
    const a = makeSource()
    const b = makeSource(makeMeta({ version: 'v2' }))
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: a, active: true }))
    })
    await settle()
    const first = live()!
    const firstClears = first.clears

    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: a, active: false }))
    })
    await advance(10_000)
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: a, active: true }))
    })
    await settle()
    const second = live()!
    const secondClears = second.clears

    // Swap the filters: the store resets, and the CLEAR must reach the live
    // renderer — otherwise the previous filter's map stays on screen under the
    // new one forever.
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: b, active: true }))
    })
    await settle()

    expect(second.clears).toBeGreaterThan(secondClears)
    expect(first.clears).toBe(firstClears)
    expect(first.callsAfterDispose).toEqual([])
  })

  it('never calls a renderer after its dispose, through any path', async () => {
    const source = makeDeferredSource()
    const props = { dataSource: source as unknown as MapDataSource }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    // Resize and a late tile arrival while nothing is live.
    await act(async () => {
      emitResize(1200, 900)
      source.release()
      await Promise.resolve()
    })
    await advance(200)
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    await act(async () => root.unmount())

    for (const r of instances()) {
      expect({ seq: r.seq, after: r.callsAfterDispose }).toEqual({ seq: r.seq, after: [] })
    }
  })

  it('keeps exactly one live renderer, and one canvas, at every point', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const check = () => {
      expect(instances().filter((r) => !r.disposed).length).toBeLessThanOrEqual(1)
      expect(container.querySelectorAll('canvas')).toHaveLength(1)
    }
    check()

    // dpr change, idle round trip, resize — each a recreation trigger.
    vi.stubGlobal('devicePixelRatio', 2)
    await act(async () => {
      emitResize(801, 601)
    })
    await settle()
    check()

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(10_000)
    expect(live()).toBeUndefined()
    expect(container.querySelectorAll('canvas')).toHaveLength(1)

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    check()
  })

  it('cancels the idle timer when the view comes back before 10 s', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    await settle()
    const first = live()!

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await advance(9_000)
    expect(first.disposed).toBe(false)

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true }))
    })
    // Past the original deadline: a timer that survived reactivation would
    // dispose the renderer the user is looking at.
    await advance(5_000)
    await settle()
    expect(first.disposed).toBe(false)
    expect(live()).toBe(first)
  })

  it('cancels the idle timer on unmount rather than firing into a dead tree', async () => {
    const props = { dataSource: makeSource() }
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false }))
    })
    await settle()
    await act(async () => root.unmount())
    const created = instances().length
    await advance(20_000)
    // No renderer was built by a late timer, and everything is disposed.
    expect(instances()).toHaveLength(created)
    expect(instances().every((r) => r.disposed)).toBe(true)
  })

  it('under strict mode the second renderer is fully wired, not just created', async () => {
    // Strict mode tears the effects down and runs them again. The second
    // renderer is the one that survives, so IT is the one that must have the
    // world, the palette and the resident tiles.
    await act(async () => {
      root.render(h(StrictMode, null, h(KnowledgeMap, { dataSource: makeSource() })))
    })
    await settle()

    const r = live()!
    expect(instances().filter((x) => !x.disposed)).toHaveLength(1)
    expect(r.uploaded).toContain('0.0.0')
    expect(r.paletteCalls).toBeGreaterThan(0)
    expect(r.worldCalls.length).toBeGreaterThan(0)
    expect(r.rendersWithoutWorld).toBe(0)
    for (const inst of instances()) expect(inst.callsAfterDispose).toEqual([])
  })

  it('reports `error` and builds nothing further when a recreation fails', async () => {
    const props = { dataSource: makeSource() }
    const statuses: MapStatus[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true, onStatus: (s: MapStatus) => statuses.push(s) }))
    })
    await settle()

    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: false, onStatus: (s: MapStatus) => statuses.push(s) }))
    })
    await advance(10_000)
    hoisted.failNextCreate = true
    await act(async () => {
      root.render(h(KnowledgeMap, { ...props, active: true, onStatus: (s: MapStatus) => statuses.push(s) }))
    })
    await settle()

    expect(statuses).toContain('error')
    // A failed create must leave nothing live and must not spin on retries.
    expect(live()).toBeUndefined()
    errorSpy.mockRestore()
  })
})

describe('KnowledgeMap shell — device pixel ratio', () => {
  beforeEach(() => {
    useIdleTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds the first renderer with the REAL dpr, not the default 1', async () => {
    // The label atlas bakes its device-px shelf height from the dpr it is
    // constructed with, and the renderer's viewport field starts at dpr 1. The
    // shell used to call resize() only after the constructor returned, so every
    // atlas rasterised at half resolution on a Retina display and the recreate
    // path that existed to fix it rebuilt at dpr 1 as well.
    vi.stubGlobal('devicePixelRatio', 2)
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    expect(live()!.builtDpr).toBe(2)
  })

  it('clamps dpr to 2 — 4x the fragments buys nothing above that', async () => {
    vi.stubGlobal('devicePixelRatio', 3)
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    expect(live()!.builtDpr).toBe(2)
  })

  it('pushes a dpr change straight through to resize, without recreating the renderer', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    const first = live()!

    // Drag the window onto a Retina display.
    vi.stubGlobal('devicePixelRatio', 2)
    await act(async () => {
      emitResize(800, 600)
    })
    await settle()

    // resize() now rebuilds the atlas at the new dpr, so the whole-renderer
    // recreation this used to need is gone — and with it a full GL teardown
    // and rebuild on every monitor move.
    expect(live()).toBe(first)
    expect(first.resizes.at(-1)!.dpr).toBe(2)
    // Immediately, not after the 180 ms debounce: the backing store must match
    // the ratio the projection is computed against.
    expect(first.resizes.at(-1)).toEqual({ width: 800, height: 600, dpr: 2 })
  })
})

describe('KnowledgeMap shell — resize pacing', () => {
  beforeEach(() => {
    useIdleTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a continuous drag into ONE backing-store realloc', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    const r = live()!
    const before = r.resizes.length

    // A splitter drag: many small steps, one per frame.
    for (let w = 805; w <= 845; w += 5) {
      await act(async () => {
        emitResize(w, 600)
      })
    }
    // Nothing reallocated yet — each realloc is a fresh WKWebView surface and
    // an IPC round trip, and the ResizeObserver fires once a frame.
    expect(r.resizes.length).toBe(before)

    await advance(200)
    expect(r.resizes.length).toBe(before + 1)
    expect(r.resizes.at(-1)).toEqual({ width: 845, height: 600, dpr: 1 })
  })

  it('reallocates immediately for a one-off jump, where there is nothing to coalesce', async () => {
    await act(async () => {
      root.render(h(KnowledgeMap, { dataSource: makeSource() }))
    })
    await settle()
    const r = live()!
    const before = r.resizes.length

    // An inspector panel opening: 800 -> 400 in one step, far past the
    // jump threshold. Debouncing this buys nothing (it fires once) and costs
    // the user 180 ms of a visibly mis-scaled map.
    await act(async () => {
      emitResize(400, 600)
    })
    expect(r.resizes.length).toBe(before + 1)
    expect(r.resizes.at(-1)).toEqual({ width: 400, height: 600, dpr: 1 })
  })
})
