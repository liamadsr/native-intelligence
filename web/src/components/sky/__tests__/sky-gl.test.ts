// @vitest-environment jsdom
/**
 * The GL wrapper hands the scene to the shader: with a fake WebGL context,
 * each draw sets the uniforms from the scene, the cirrus amount among them
 * (uTwi.z), and the fragment shader draws the close-up cloud's wisps as silky
 * strands by it.
 */
import { describe, expect, it, vi } from 'vitest'
import { SKY_PRESETS } from '@/lib/sky/dev-override'
import { computeSkyScene } from '@/lib/sky/scene'
import { CLEAR_SKY, type SkyWeather } from '@/lib/sky/weather'
import { SkyGL, type SkyFrame } from '../sky-gl'
import { CLOSEUP_WISP_ALPHA, SKY_FRAGMENT } from '../sky-shader'

function fakeGl() {
  const uniforms = new Map<string, number[]>()
  const set = (loc: { name: string }, ...v: number[]) => {
    uniforms.set(loc.name, v)
  }
  const ctx = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    ARRAY_BUFFER: 3,
    STATIC_DRAW: 4,
    FLOAT: 5,
    TRIANGLES: 6,
    COMPILE_STATUS: 7,
    LINK_STATUS: 8,
    isContextLost: () => false,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    deleteShader: () => {},
    getProgramParameter: () => true,
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    viewport: () => {},
    uniform1f: set,
    uniform2f: set,
    uniform3f: set,
    uniform4f: set,
    drawArrays: vi.fn(),
  }
  return { ctx, uniforms }
}

// New York, 10 October 2026, 12:30 local.
const frame = (weather: SkyWeather): SkyFrame => ({
  scene: computeSkyScene({ date: new Date(Date.UTC(2026, 9, 10, 16, 30)), latitude: 40.7, longitude: -74, weather, dark: false }),
  bg: [1, 1, 1],
  time: 0,
  cloudX: 0,
  cloudY: 0,
})

describe('SkyGL', () => {
  it("sends the scene's cirrus to the shader (uTwi.z)", () => {
    const { ctx, uniforms } = fakeGl()
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as WebGLRenderingContext)
    const sky = SkyGL.create(canvas)
    expect(sky).not.toBeNull()

    const veiled = frame(SKY_PRESETS.cirrus)
    sky!.draw(100, 50, veiled)
    expect(veiled.scene.cirrus).toBeGreaterThan(0.8)
    expect(uniforms.get('uTwi')![2]).toBe(veiled.scene.cirrus)
    expect(uniforms.get('uCover')![0]).toBe(0)

    sky!.draw(100, 50, frame(CLEAR_SKY))
    expect(uniforms.get('uTwi')![2]).toBe(0)
  })

  it("sends the scene's soft masses, dusk ramp and skyglow to the shader (uVeil, uSkyglow), and no stars", () => {
    const { ctx, uniforms } = fakeGl()
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as WebGLRenderingContext)
    const sky = SkyGL.create(canvas)
    const veiled = frame(SKY_PRESETS.cirrus)
    sky!.draw(100, 50, veiled)
    expect(uniforms.get('uVeil')).toEqual([veiled.scene.veil, veiled.scene.dusk])
    expect(uniforms.get('uSkyglow')).toEqual([...veiled.scene.skyglow, veiled.scene.skyglowAmount])
    expect(uniforms.has('uStars')).toBe(false)
  })

  it("sends the scene's clear-sky texture amounts to the shader (uTex)", () => {
    const { ctx, uniforms } = fakeGl()
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as WebGLRenderingContext)
    const sky = SkyGL.create(canvas)
    const clear = frame(CLEAR_SKY)
    sky!.draw(100, 50, clear)
    expect(uniforms.get('uTex')).toEqual([clear.scene.sunPattern, clear.scene.texture, clear.scene.strata])
    expect(clear.scene.sunPattern).toBeGreaterThan(0)
  })

  it('the shader draws thin cloud as silky strands by cirrus, see-through', () => {
    expect(SKY_FRAGMENT).toContain('float ci = uTwi.z;')
    // Fibrous with high cloud (and partly for any thin sky's wisps)…
    expect(SKY_FRAGMENT).toContain('float fib = thin * mix(0.55, 1.0, smoothstep(0.2, 0.8, ci));')
    // …drawn out along the wind: wider across the screen than up it.
    expect(SKY_FRAGMENT).toContain('vec2 stretch = vec2(mix(1.0, 0.4, fib), mix(1.0, 1.8, fib));')
    // Thin cloud is see-through: visible enough to watch drift, never a lid.
    expect(SKY_FRAGMENT).toContain('col = mix(col, fcol, fa * mix(SOLID_ALPHA, WISP_ALPHA, thin));')
    expect(SKY_FRAGMENT).toContain(`#define WISP_ALPHA ${CLOSEUP_WISP_ALPHA.toFixed(3)}`)
    expect(CLOSEUP_WISP_ALPHA).toBeGreaterThan(0.3)
    expect(CLOSEUP_WISP_ALPHA).toBeLessThanOrEqual(0.8)
  })
})
