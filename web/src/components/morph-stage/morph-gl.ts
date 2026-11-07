/**
 * The WebGL1 side of a morph stage: one program, one full-screen triangle,
 * textures uploaded from canvases, and a draw that sets a handful of uniforms
 * and issues one drawArrays. It keeps no frame loop — MorphQueue decides when
 * to draw (only during a morph; a still is drawn once). Same shape as SkyGL.
 */

import { MORPH_FRAGMENT, MORPH_VERTEX } from './morph-shader'

const UNIFORMS = [
  'uFrom', 'uTo', 'uRes', 'uFromSize', 'uToSize', 'uProgress', 'uTime',
  'uIntensity', 'uScale', 'uAberration', 'uReduce',
] as const
type UniformName = (typeof UNIFORMS)[number]

/** A picture on the GPU, with the size it was drawn at (for cover-fit). */
export interface MorphTexture {
  texture: WebGLTexture
  width: number
  height: number
}

/** How strongly the melt warps, its noise frequency and its RGB split. */
export interface MorphLook {
  intensity: number
  scale: number
  aberration: number
}

export const DEFAULT_MORPH_LOOK: MorphLook = { intensity: 0.55, scale: 2.4, aberration: 0.35 }

export class MorphGL {
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>

  private constructor(private gl: WebGLRenderingContext) {}

  static create(canvas: HTMLCanvasElement): MorphGL | null {
    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', {
        // Translucent pictures: what's behind the canvas shows through. The
        // shader works in premultiplied alpha, as the page composites it.
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        // Kept: the stage draws rarely (a morph, then one still that must stay
        // up for minutes), sometimes from a timer when no frame is coming, and
        // the page may be composited again long after (an occluded HUD shown
        // again). With the buffer discarded after presenting, such a still
        // could show the picture before it. A small canvas, only copied while
        // it draws, so it costs next to nothing.
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
      }) as WebGLRenderingContext | null
    } catch {
      gl = null
    }
    if (!gl) return null
    const morph = new MorphGL(gl)
    return morph.init() ? morph : null
  }

  /** (Re)build the GL objects: on create and after a context restore. */
  init(): boolean {
    const gl = this.gl
    if (gl.isContextLost()) return false
    const vs = compile(gl, gl.VERTEX_SHADER, MORPH_VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, MORPH_FRAGMENT)
    if (!vs || !fs) return false
    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (process.env.NODE_ENV !== 'production') console.warn('[morph] link failed', gl.getProgramInfoLog(program))
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
    gl.uniform1i(this.loc.uFrom, 0)
    gl.uniform1i(this.loc.uTo, 1)
    return true
  }

  isLost(): boolean {
    return this.gl.isContextLost()
  }

  /** Upload a picture (a canvas the caller drew). NPOT-safe: no mipmaps, clamped. */
  upload(source: HTMLCanvasElement): MorphTexture | null {
    const gl = this.gl
    if (gl.isContextLost()) return null
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // Canvas rows run top-down, GL's bottom-up; the shader blends premultiplied.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } catch {
      gl.deleteTexture(texture)
      return null
    }
    return { texture, width: Math.max(source.width, 1), height: Math.max(source.height, 1) }
  }

  release(t: MorphTexture): void {
    if (!this.gl.isContextLost()) this.gl.deleteTexture(t.texture)
  }

  /** One frame: `from` melting into `to` at `progress` (0 = `from` as is). */
  draw(
    width: number,
    height: number,
    from: MorphTexture,
    to: MorphTexture,
    progress: number,
    seconds: number,
    reduce: boolean,
    look: MorphLook = DEFAULT_MORPH_LOOK,
  ): void {
    const gl = this.gl
    if (!this.program || gl.isContextLost()) return
    const l = this.loc
    gl.viewport(0, 0, width, height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, from.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, to.texture)
    gl.uniform2f(l.uRes, width, height)
    gl.uniform2f(l.uFromSize, from.width, from.height)
    gl.uniform2f(l.uToSize, to.width, to.height)
    gl.uniform1f(l.uProgress, progress)
    gl.uniform1f(l.uTime, seconds)
    gl.uniform1f(l.uIntensity, look.intensity)
    gl.uniform1f(l.uScale, look.scale)
    gl.uniform1f(l.uAberration, look.aberration)
    gl.uniform1f(l.uReduce, reduce ? 1 : 0)
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
    // Hand the context back now (browsers keep few) — but only once the canvas
    // has left the page: a remount on the same canvas (React's dev double
    // effect) gets this very context back, and a lost one would draw nothing.
    if (!(gl.canvas as HTMLCanvasElement).isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    if (process.env.NODE_ENV !== 'production') console.warn('[morph] compile failed', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
