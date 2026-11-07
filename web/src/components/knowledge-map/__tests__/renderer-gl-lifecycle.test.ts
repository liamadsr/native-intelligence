// @vitest-environment jsdom
/**
 * Renderer GL lifecycle, against a COUNTING stub context.
 *
 * jsdom has no WebGL2, and the real shaders are exercised by the
 * /dev/knowledge-map bench page — but three properties of this file are pure
 * bookkeeping and go wrong silently, so they are worth pinning without a GPU:
 *
 *   1. GL objects created == GL objects deleted. A renderer that rebuilds its
 *      state on a live context and merely FORGETS the old names orphans ~13 MB
 *      of VRAM per recreation with no reference left to free it. Nothing
 *      throws; the map simply gets more expensive every time the user moves
 *      the window between displays.
 *   2. gl.viewport and the projection describe the SAME rectangle. They are
 *      derived from different places (backing store vs. CSS size) and the
 *      shell deliberately lets those two disagree for up to 180 ms, so a
 *      renderer that trusts the CSS size crops every frame of a resize drag.
 *   3. A lost context is refused loudly at construction. getContext on a
 *      canvas whose context was deliberately lost returns that same dead
 *      object, so a plain null check passes and the failure resurfaces much
 *      later as "shader failed to compile".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMapRenderer } from '@/components/knowledge-map/renderer'
import { LABEL_LINE_HEIGHT_PX } from '@/components/knowledge-map/labels'
import type { Viewport } from '@/components/knowledge-map/types'

// ─── A counting WebGL2 stub ───────────────────────────────────────────────────

interface GlLedger {
  created: { programs: number; buffers: number; vaos: number; textures: number }
  deleted: { programs: number; buffers: number; vaos: number; textures: number }
  viewportCalls: Array<[number, number, number, number]>
  /** uViewportCss values the renderer uploaded, in order. */
  viewportCssUniforms: Array<[number, number]>
  lost: boolean
}

function makeStubGl(ledger: GlLedger, canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const uniformName = new Map<object, string>()
  // Per-CONTEXT, not per-ledger: losing one canvas's context must not make a
  // different canvas look dead, which is exactly the property under test.
  let lost = false
  const gl = {
    // Constants the renderer touches.
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    FLOAT: 0x1406,
    TRIANGLE_STRIP: 5,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_SKIP_ROWS: 0x0cf3,

    get drawingBufferWidth() {
      return canvas.width
    },
    get drawingBufferHeight() {
      return canvas.height
    },

    isContextLost: () => lost,
    getExtension: () => ({
      loseContext: () => {
        lost = true
        ledger.lost = true
      },
    }),

    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => !lost,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => {
      ledger.created.programs++
      return {}
    },
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => !lost,
    getProgramInfoLog: () => '',
    deleteProgram: () => {
      ledger.deleted.programs++
    },
    getUniformLocation: (_p: unknown, name: string) => {
      const loc = {}
      uniformName.set(loc, name)
      return loc
    },
    createBuffer: () => {
      ledger.created.buffers++
      return {}
    },
    deleteBuffer: () => {
      ledger.deleted.buffers++
    },
    createVertexArray: () => {
      ledger.created.vaos++
      return {}
    },
    deleteVertexArray: () => {
      ledger.deleted.vaos++
    },
    createTexture: () => {
      ledger.created.textures++
      return {}
    },
    deleteTexture: () => {
      ledger.deleted.textures++
    },

    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    useProgram: () => {},
    drawArraysInstanced: () => {},
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    disable: () => {},
    enable: () => {},
    blendFunc: () => {},
    clearColor: () => {},
    clear: () => {},
    readPixels: () => {},
    uniform1f: () => {},
    uniform1i: () => {},
    uniform4fv: () => {},
    uniform2f: (loc: object, a: number, b: number) => {
      if (uniformName.get(loc) === 'uViewportCss') ledger.viewportCssUniforms.push([a, b])
    },
    viewport: (x: number, y: number, w: number, h: number) => {
      ledger.viewportCalls.push([x, y, w, h])
    },
  }
  return gl as unknown as WebGL2RenderingContext
}

function freshLedger(): GlLedger {
  return {
    created: { programs: 0, buffers: 0, vaos: 0, textures: 0 },
    deleted: { programs: 0, buffers: 0, vaos: 0, textures: 0 },
    viewportCalls: [],
    viewportCssUniforms: [],
    lost: false,
  }
}

/**
 * A canvas whose getContext behaves like a real one: the SAME context object
 * comes back every time, and it stays lost once lost. That identity is the
 * whole reason the shell mounts a fresh element per renderer.
 */
function makeCanvas(ledger: GlLedger): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  let ctx: WebGL2RenderingContext | null = null
  canvas.getContext = ((kind: string) => {
    if (kind !== 'webgl2') return null
    ctx ??= makeStubGl(ledger, canvas)
    return ctx
  }) as HTMLCanvasElement['getContext']
  return canvas
}

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 2 }

let ledger: GlLedger
beforeEach(() => {
  ledger = freshLedger()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('renderer — GL object accounting', () => {
  it('deletes every object it created when disposed', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    const created = { ...ledger.created }
    expect(created.programs).toBeGreaterThan(0)
    expect(created.buffers).toBeGreaterThan(0)
    expect(created.vaos).toBeGreaterThan(0)

    r.dispose()

    expect(ledger.deleted.programs).toBe(created.programs)
    expect(ledger.deleted.buffers).toBe(created.buffers)
    expect(ledger.deleted.vaos).toBe(created.vaos)
    expect(ledger.deleted.textures).toBe(ledger.created.textures)
  })

  it('reupload() re-points the slabs without allocating a second set', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    const afterConstruct = { ...ledger.created }

    r.reupload([])

    // This is the whole difference from restore(): no new GL state. The old
    // recreate path called restore() on a brand-new renderer, which ran
    // buildGlState() a second time and then only dropped the first set's
    // names — orphaning a full ~13 MB set per display change with nothing
    // left to delete them.
    expect(ledger.created).toEqual(afterConstruct)
    expect(ledger.deleted.programs).toBe(0)

    r.dispose()
    expect(ledger.deleted.programs).toBe(ledger.created.programs)
    expect(ledger.deleted.buffers).toBe(ledger.created.buffers)
    expect(ledger.deleted.vaos).toBe(ledger.created.vaos)
  })

  it('restore() on a still-live context re-uploads rather than rebuilding', () => {
    // restore() is written for a genuine context LOSS. Called while the state
    // it holds is still live — which the recreate paths used to do — it must
    // not double-allocate.
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    const afterConstruct = { ...ledger.created }

    r.restore([])

    expect(ledger.created).toEqual(afterConstruct)

    r.dispose()
    expect(ledger.deleted.programs).toBe(ledger.created.programs)
    expect(ledger.deleted.buffers).toBe(ledger.created.buffers)
    expect(ledger.deleted.vaos).toBe(ledger.created.vaos)
  })

  it('stays balanced across many create/dispose cycles on fresh canvases', () => {
    // The shell's real pattern: one canvas and one renderer per generation.
    for (let i = 0; i < 5; i++) {
      const canvas = makeCanvas(ledger)
      const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
      r.resize(VIEWPORT)
      r.reupload([])
      r.dispose()
    }
    expect(ledger.deleted.programs).toBe(ledger.created.programs)
    expect(ledger.deleted.buffers).toBe(ledger.created.buffers)
    expect(ledger.deleted.vaos).toBe(ledger.created.vaos)
    expect(ledger.deleted.textures).toBe(ledger.created.textures)
  })
})

describe('renderer — a lost context is refused at construction', () => {
  it('throws rather than proceeding into shader compilation', () => {
    const canvas = makeCanvas(ledger)
    const first = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    // dispose() deliberately loses the context so the GPU really gets it back.
    first.dispose()
    expect(ledger.lost).toBe(true)

    // getContext hands back the SAME dead object, so `!gl` is false and the
    // old code walked straight into buildGlState and died with a baffling
    // "shader failed to compile". The shell now gives every renderer a fresh
    // element; this guard makes the contract explicit.
    expect(() => createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })).toThrow(
      /lost/i,
    )
  })

  it('a fresh canvas element works, proving the context is per-element', () => {
    const a = makeCanvas(ledger)
    createMapRenderer(a, { maxResidentTiles: 4, viewport: VIEWPORT }).dispose()

    const bLedger = freshLedger()
    const b = makeCanvas(bLedger)
    expect(() => createMapRenderer(b, { maxResidentTiles: 4, viewport: VIEWPORT })).not.toThrow()
  })
})

describe('renderer — viewport follows the backing store, not the CSS size', () => {
  it('renders the OLD size while the backing store is stale, never a crop', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    r.resize({ width: 800, height: 600, dpr: 2 })
    expect(canvas.width).toBe(1600)

    ledger.viewportCalls.length = 0
    ledger.viewportCssUniforms.length = 0
    // The shell updates the CSS viewport immediately and debounces the
    // realloc, so a frame lands here with a LARGER css size than the buffer.
    r.render({ x: 0, y: 0, k: 1 }, { width: 1200, height: 600, dpr: 2 }, [], 0)

    // Rasterise into the whole buffer...
    expect(ledger.viewportCalls[0]).toEqual([0, 0, 1600, 1200])
    // ...and project against the CSS rectangle THAT buffer covers, so the two
    // describe the same space. Using 1200 here (the not-yet-applied CSS size)
    // would clip the image to the left two thirds of the buffer and let CSS
    // stretch the result — the wobble on every splitter drag.
    for (const [w, h] of ledger.viewportCssUniforms) {
      expect(w).toBe(800)
      expect(h).toBe(600)
    }
    expect(ledger.viewportCssUniforms.length).toBeGreaterThan(0)
  })

  it('agrees with the CSS size again once the realloc lands', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    const next: Viewport = { width: 1200, height: 600, dpr: 2 }
    r.resize(next)
    ledger.viewportCalls.length = 0
    ledger.viewportCssUniforms.length = 0

    r.render({ x: 0, y: 0, k: 1 }, next, [], 0)

    expect(ledger.viewportCalls[0]).toEqual([0, 0, 2400, 1200])
    for (const [w, h] of ledger.viewportCssUniforms) expect(w).toBe(1200)
  })

  it('skips the frame entirely when the backing store has no area', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    canvas.width = 0
    canvas.height = 0
    ledger.viewportCalls.length = 0

    r.render({ x: 0, y: 0, k: 1 }, VIEWPORT, [], 0)
    expect(ledger.viewportCalls).toHaveLength(0)
  })
})

describe('renderer — label atlas tracks the device pixel ratio', () => {
  it('builds the first atlas at the viewport dpr, not the default 1', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    // Built at dpr 1, every label would be rasterised into a 15-device-row
    // shelf and then magnified 2x onto a 30-device-px quad — visibly soft next
    // to the crisp DOM text around the canvas.
    expect(r.atlasDpr()).toBe(2)
  })

  it('rebuilds the atlas when a resize changes the dpr, both ways', () => {
    const canvas = makeCanvas(ledger)
    const one: Viewport = { width: 800, height: 600, dpr: 1 }
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: one })
    expect(r.atlasDpr()).toBe(1)

    // Window dragged onto a Retina display. Every cached AtlasEntry's UVs and
    // sizes were derived from the old ratio, so the atlas is replaced rather
    // than reused — which is what lets a display change be a plain resize
    // instead of a whole new renderer.
    r.resize({ width: 800, height: 600, dpr: 2 })
    expect(r.atlasDpr()).toBe(2)

    // And back again — the old code only ever went one way (it never went at
    // all, in fact: the atlas was always built at the field-initialiser dpr).
    r.resize({ width: 800, height: 600, dpr: 1 })
    expect(r.atlasDpr()).toBe(1)
  })

  it('leaves the atlas alone when only the CSS size changes', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: VIEWPORT })
    r.render({ x: 0, y: 0, k: 1 }, VIEWPORT, [], 0)
    const deletedBefore = ledger.deleted.textures

    // A splitter drag fires resize many times; re-rasterising every label on
    // each would be exactly the per-frame Canvas2D cost the atlas exists to
    // avoid (every fillText is an IPC message in WKWebView).
    for (let w = 810; w <= 900; w += 10) r.resize({ width: w, height: 600, dpr: 2 })
    expect(r.atlasDpr()).toBe(2)
    expect(ledger.deleted.textures).toBe(deletedBefore)
  })

  it('clamps to at least 1x so glyphs are never clipped by a short shelf', () => {
    const canvas = makeCanvas(ledger)
    const r = createMapRenderer(canvas, { maxResidentTiles: 4, viewport: { width: 800, height: 600, dpr: 0 } })
    expect(r.atlasDpr()).toBe(1)
    // And the shelf is a whole line box, not a fraction of one.
    expect(LABEL_LINE_HEIGHT_PX).toBeGreaterThan(0)
  })
})
