/**
 * The WebGL1 side of the sky: one program, one full-screen triangle, a draw
 * that sets uniforms and issues a single drawArrays. No state between frames
 * beyond the GL objects; the controller decides when to draw.
 */

import type { SkyScene } from '@/lib/sky/scene'
import type { Rgb } from '@/lib/sky/palette'
import { SKY_FRAGMENT, SKY_VERTEX } from './sky-shader'

const UNIFORMS = [
  'uRes', 'uTime', 'uCloud', 'uTop', 'uHorizon', 'uSunCol', 'uSun', 'uVeil', 'uSkyglow', 'uCover',
  'uCloudLit', 'uCloudShade', 'uFog', 'uStorm', 'uBg', 'uStrength',
  'uSunDir', 'uGlow', 'uGlowHigh', 'uBelt', 'uShadow', 'uTwi', 'uTex',
] as const
type UniformName = (typeof UNIFORMS)[number]
const DEG = Math.PI / 180

export interface SkyFrame {
  scene: SkyScene
  /** Theme surface colour, sRGB 0..1. */
  bg: Rgb
  time: number
  cloudX: number
  cloudY: number
}

export class SkyGL {
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>

  private constructor(private gl: WebGLRenderingContext) {}

  static create(canvas: HTMLCanvasElement): SkyGL | null {
    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      }) as WebGLRenderingContext | null
    } catch {
      gl = null
    }
    if (!gl) return null
    const sky = new SkyGL(gl)
    return sky.init() ? sky : null
  }

  /** (Re)build the GL objects: on create and after a context restore. */
  init(): boolean {
    const gl = this.gl
    if (gl.isContextLost()) return false
    const vs = compile(gl, gl.VERTEX_SHADER, SKY_VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, SKY_FRAGMENT)
    if (!vs || !fs) return false
    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (process.env.NODE_ENV !== 'production') console.warn('[sky] link failed', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return false
    }
    this.program = program
    gl.useProgram(program)
    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    // One triangle that covers the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(program, name)
    return true
  }

  isLost(): boolean {
    return this.gl.isContextLost()
  }

  draw(width: number, height: number, f: SkyFrame): void {
    const gl = this.gl
    if (!this.program || gl.isContextLost()) return
    const s = f.scene
    const l = this.loc
    gl.viewport(0, 0, width, height)
    gl.uniform2f(l.uRes, width, height)
    gl.uniform1f(l.uTime, f.time)
    gl.uniform2f(l.uCloud, f.cloudX, f.cloudY)
    rgb(gl, l.uTop, s.top)
    rgb(gl, l.uHorizon, s.horizon)
    rgb(gl, l.uSunCol, s.sun)
    gl.uniform4f(l.uSun, s.sunX, s.sunY, s.sunGlow, s.sunDisc)
    gl.uniform2f(l.uSunDir, s.elevation * DEG, s.sunAzimuthView * DEG)
    rgb(gl, l.uGlow, s.glow)
    rgb(gl, l.uGlowHigh, s.glowHigh)
    rgb(gl, l.uBelt, s.belt)
    rgb(gl, l.uShadow, s.shadow)
    gl.uniform3f(l.uTwi, s.glowAmount, s.beltAmount, s.cirrus)
    gl.uniform3f(l.uTex, s.sunPattern, s.texture, s.strata)
    gl.uniform2f(l.uVeil, s.veil, s.dusk)
    gl.uniform4f(l.uSkyglow, s.skyglow[0], s.skyglow[1], s.skyglow[2], s.skyglowAmount)
    gl.uniform1f(l.uCover, s.cloudCover)
    rgb(gl, l.uCloudLit, s.cloudLit)
    rgb(gl, l.uCloudShade, s.cloudShade)
    gl.uniform1f(l.uFog, s.fog)
    gl.uniform1f(l.uStorm, s.storm)
    rgb(gl, l.uBg, f.bg)
    gl.uniform1f(l.uStrength, s.strength)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    const gl = this.gl
    if (!gl.isContextLost()) {
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.buffer = null
    this.program = null
    // Hand the context back now rather than waiting for GC (the browser keeps
    // few), but only once the canvas has left the page: a remount on the same
    // canvas (React's dev double effect) gets this very context back from
    // getContext, and a lost one would leave it with nothing to draw with.
    if (!(gl.canvas as HTMLCanvasElement).isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function rgb(gl: WebGLRenderingContext, loc: WebGLUniformLocation | null, c: Rgb): void {
  gl.uniform3f(loc, c[0], c[1], c[2])
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    if (process.env.NODE_ENV !== 'production') console.warn('[sky] compile failed', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
