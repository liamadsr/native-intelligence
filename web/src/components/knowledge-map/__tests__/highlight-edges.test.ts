// @vitest-environment jsdom
/**
 * Hovering a node highlights its connections by CONTRAST, not by brightness.
 *
 * Everything else dims to a sixth (palette DIM), and the hovered node's
 * connections keep the look every edge has at rest — the same hairline width
 * and pale colour. They used to switch to near-white at 85% and half again as
 * wide, and hovering a hub fanned bright lines across the whole map.
 *
 * A SELECTION with nothing hovered dims nothing, so its connections are still
 * drawn emphasised (accent, wider), or nothing would set them apart.
 */
import { describe, expect, it } from 'vitest'
import { createMapRenderer } from '@/components/knowledge-map/renderer'
import { EDGE_FS } from '@/components/knowledge-map/shaders'
import type { Highlight, Viewport } from '@/components/knowledge-map/types'

/** One instanced draw: the program's uniforms as they stood when it was issued. */
type Draw = Record<string, unknown>

/** A WebGL2 stub that remembers every uniform by name, per program, and
 *  snapshots the current program's uniforms at each draw. */
function makeRecordingCanvas(draws: Draw[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 1200
  const nameOf = new Map<object, string>()
  const programOf = new Map<object, object>()
  const values = new Map<object, Map<string, unknown>>()
  let current: object | null = null
  const set = (loc: object | null, value: unknown) => {
    if (!loc) return
    const program = programOf.get(loc)!
    if (!values.has(program)) values.set(program, new Map())
    values.get(program)!.set(nameOf.get(loc)!, value)
  }
  const gl = {
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8, VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, FLOAT: 0x1406,
    TRIANGLE_STRIP: 5, COLOR_BUFFER_BIT: 0x4000, DEPTH_TEST: 0x0b71, BLEND: 0x0be2, ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303, TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, RGBA: 0x1908, RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_SKIP_ROWS: 0x0cf3,
    get drawingBufferWidth() {
      return canvas.width
    },
    get drawingBufferHeight() {
      return canvas.height
    },
    isContextLost: () => false,
    getExtension: () => ({ loseContext: () => {} }),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    getUniformLocation: (program: object, name: string) => {
      const loc = {}
      nameOf.set(loc, name)
      programOf.set(loc, program)
      return loc
    },
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},
    createTexture: () => ({}),
    deleteTexture: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    useProgram: (program: object) => {
      current = program
    },
    drawArraysInstanced: () => {
      draws.push(Object.fromEntries(values.get(current!) ?? new Map()))
    },
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
    viewport: () => {},
    readPixels: () => {},
    uniform1f: (loc: object, v: number) => set(loc, v),
    uniform1i: (loc: object, v: number) => set(loc, v),
    uniform2f: (loc: object, a: number, b: number) => set(loc, [a, b]),
    uniform4fv: (loc: object, v: Float32Array) => set(loc, v),
  }
  canvas.getContext = ((kind: string) => (kind === 'webgl2' ? gl : null)) as HTMLCanvasElement['getContext']
  return canvas
}

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 2 }

/** The edges the highlight pass drew — the edge program's draws with the
 *  length fade switched off (uHighlight = 1). */
function highlightEdgeDraws(dimOthers: boolean): Draw[] {
  const draws: Draw[] = []
  const r = createMapRenderer(makeRecordingCanvas(draws), { maxResidentTiles: 4, viewport: VIEWPORT })
  const highlight: Highlight = {
    focus: [{ wx: 0, wy: 0, r: 4 }],
    nodes: [{ wx: 40, wy: 0, r: 3, kind: 0, flags: 0 }],
    edges: [{ x1: 0, y1: 0, x2: 40, y2: 0 }],
    dimOthers,
  }
  r.setHighlight(highlight)
  r.render({ x: 0, y: 0, k: 1 }, VIEWPORT, [], 0)
  r.dispose()
  return draws.filter((d) => 'uLenFadeStart' in d && d.uHighlight === 1)
}

describe('the connections of a highlighted node', () => {
  it('on HOVER keep the resting look — resting colour, hairline width, no extra strength', () => {
    const [edges] = highlightEdgeDraws(true)
    expect(edges).toBeDefined()
    expect(edges.uAccent).toBe(0)
    expect(edges.uWidthCss).toBe(1)
    expect(edges.uAlpha).toBe(1)
  })

  it('for a SELECTION with nothing dimmed are still drawn emphasised', () => {
    const [edges] = highlightEdgeDraws(false)
    expect(edges).toBeDefined()
    expect(edges.uAccent).toBe(1)
    expect(edges.uWidthCss).toBeGreaterThan(1)
    expect(edges.uAlpha).toBeLessThan(1)
  })

  it('the edge shader takes the accent only when asked, and the resting edge colour otherwise', () => {
    expect(EDGE_FS).toMatch(/uAccent == 1 \? uPalette\[5\] : uPalette\[4\]/)
  })
})
