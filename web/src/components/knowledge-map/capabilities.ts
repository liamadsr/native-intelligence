/**
 * WebGL2 capability probe for the Knowledge Map.
 *
 * The map's whole reason to exist is GPU instancing; when the browser cannot
 * give us a usable WebGL2 context the shell falls back to the legacy
 * force-graph renderer (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §5, "Fallback").
 * A probe that only checked `getContext('webgl2') !== null` would pass on
 * machines where the context exists but instanced drawing is broken or the
 * driver is a blacklisted software path, so we actually run a one-instance
 * instanced draw and read the pixel back.
 *
 * The probe ALWAYS destroys its throwaway context before returning: browsers
 * cap the number of live WebGL contexts (Safari ~16) and silently kill the
 * oldest one when the cap is hit, which would take out a real map rendering
 * in another pane. React 19 strict mode double-invokes effects in dev, so this
 * runs twice per mount in development alone.
 */

/** Smallest atlas we are willing to allocate (labels.ts defaults to 2048). */
const MIN_TEXTURE_SIZE = 2048
/** The renderer binds up to 8 instanced attributes; 16 is the spec floor. */
const MIN_VERTEX_ATTRIBS = 16

const PROBE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aOffset;
void main() {
  gl_Position = vec4(aCorner + aOffset, 0.0, 1.0);
}`

const PROBE_FS = `#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(1.0, 1.0, 1.0, 1.0);
}`

export type WebGL2Probe = { ok: true } | { ok: false; reason: string }

/**
 * Create a throwaway canvas + context, verify limits and a real instanced
 * draw, then lose the context. Never throws — every failure is a `reason`.
 */
export function probeWebGL2(): WebGL2Probe {
  if (typeof document === 'undefined') return { ok: false, reason: 'no document (SSR)' }

  let gl: WebGL2RenderingContext | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null
    if (!gl) return { ok: false, reason: 'webgl2 context unavailable' }

    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (!(maxTexture >= MIN_TEXTURE_SIZE)) {
      return { ok: false, reason: `MAX_TEXTURE_SIZE ${maxTexture} < ${MIN_TEXTURE_SIZE}` }
    }
    const maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number
    if (!(maxAttribs >= MIN_VERTEX_ATTRIBS)) {
      return { ok: false, reason: `MAX_VERTEX_ATTRIBS ${maxAttribs} < ${MIN_VERTEX_ATTRIBS}` }
    }

    return smokeDraw(gl)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    if (gl) loseContext(gl)
  }
}

/**
 * Draw one instance of a full-viewport triangle strip and read the single
 * pixel back. This exercises exactly the path the renderer depends on:
 * GLSL ES 3.00 compile + link, VAO, `vertexAttribDivisor`,
 * `drawArraysInstanced`.
 */
function smokeDraw(gl: WebGL2RenderingContext): WebGL2Probe {
  const vs = gl.createShader(gl.VERTEX_SHADER)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!vs || !fs || !program) return { ok: false, reason: 'could not allocate shader objects' }

  gl.shaderSource(vs, PROBE_VS)
  gl.compileShader(vs)
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    return { ok: false, reason: `vertex shader: ${gl.getShaderInfoLog(vs) ?? 'unknown'}` }
  }
  gl.shaderSource(fs, PROBE_FS)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    return { ok: false, reason: `fragment shader: ${gl.getShaderInfoLog(fs) ?? 'unknown'}` }
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return { ok: false, reason: `link: ${gl.getProgramInfoLog(program) ?? 'unknown'}` }
  }

  const vao = gl.createVertexArray()
  const corners = gl.createBuffer()
  const offsets = gl.createBuffer()
  if (!vao || !corners || !offsets) return { ok: false, reason: 'could not allocate GL buffers' }

  gl.bindVertexArray(vao)
  // A strip covering all of clip space, so the single pixel is certainly hit.
  gl.bindBuffer(gl.ARRAY_BUFFER, corners)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, offsets)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(1, 1)

  gl.viewport(0, 0, 1, 1)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(program)
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1)

  const pixel = new Uint8Array(4)
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  gl.bindVertexArray(null)

  const err = gl.getError()
  if (err !== gl.NO_ERROR) return { ok: false, reason: `gl error 0x${err.toString(16)}` }
  // The shader writes opaque white; anything dark means nothing was rasterised.
  if (pixel[3] < 128 || pixel[0] < 128) {
    return { ok: false, reason: `instanced draw produced no pixel (${pixel.join(',')})` }
  }
  return { ok: true }
}

/**
 * Force the driver to release the context now rather than whenever GC gets to
 * the canvas — the whole point of a *throwaway* context.
 */
function loseContext(gl: WebGL2RenderingContext): void {
  try {
    const ext = gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null
    ext?.loseContext()
  } catch {
    // Losing the context is best effort; never let it mask the probe result.
  }
}
