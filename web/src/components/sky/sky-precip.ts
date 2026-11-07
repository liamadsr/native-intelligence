/**
 * Rain and snow, crisp: their own small canvas over the sky's and under the
 * grain and the UI, at full resolution (CSS size × devicePixelRatio, capped
 * at 2). The sky itself is drawn at a quarter of the CSS size and scaled up,
 * which is right for soft sky and cloud but smears a one-pixel streak or a
 * two-pixel flake into a blur.
 *
 * It exists only while something is falling: the SkyController creates it
 * (canvas, WebGL context, one static buffer) the first frame the scene has
 * rain, snow or sleet, and disposes it (context handed back, canvas removed)
 * the first frame it has none. A clear or cloudy sky has no canvas and costs
 * nothing.
 *
 * WebGL rather than a 2D canvas: a 2D canvas this size is rasterised and
 * cleared on the CPU in WebKit (5 megapixels on a 2x screen, every frame),
 * where here the clear and a few hundred small quads are GPU work and the
 * main thread only sets a dozen uniforms and issues one or two drawArrays.
 * Every particle lives in ONE static buffer written once: a corner and four
 * random numbers per vertex. Where a drop or flake is at time t is computed
 * in the vertex shader from those numbers and the controller's clock, so
 * there is no particle state, nothing written per frame and nothing
 * allocated per frame. The intensity picks how many of them are drawn.
 *
 * It has no loop of its own: the controller draws it in the same frame as
 * the sky, from the same clock, so it freezes, eases and rests with the sky
 * (sky-activity.ts) and keeps its last frame while frozen.
 *
 * Lit by the sky: each streak or flake takes the colour of the sky behind it
 * (precipBackdrop), lighter against a dark sky and darker against a light
 * one, and the signed-out pages' wash lowers it like the sky.
 */

import type { Rgb } from '@/lib/sky/palette'
import type { SkyScene } from '@/lib/sky/scene'

/** The most particles one draw uses (the buffer's size): a 4K window in a storm. */
export const PRECIP_MAX_PARTICLES = 1_200
/** Rain drops per CSS megapixel at full intensity (about 390 on a 1440×900 window). */
export const RAIN_PER_MPX = 300
/** Snowflakes per CSS megapixel at full intensity (about 490 on a 1440×900 window). */
export const SNOW_PER_MPX = 380
/** Sleet: this share of the rain's count and of the snow's, together. */
export const SLEET_RAIN_SHARE = 0.6
export const SLEET_SNOW_SHARE = 0.5
/** The full-resolution canvas never goes past 2 device pixels per CSS pixel. */
export const PRECIP_MAX_DPR = 2
/**
 * The clock the shader sees wraps at this many seconds of motion, so
 * `time × speed` stays small enough for float precision (well under a pixel).
 * A wrap re-shuffles the field once in sixteen minutes of motion, which in
 * a random field of rain reads as more rain.
 */
export const PRECIP_TIME_WRAP = 1_000
/** How far rain slants: horizontal CSS px per vertical px at full lean (scene.rainLean = ±1). */
export const RAIN_SLANT = 0.5
/** Snow is lighter: it drifts this much further with the same wind. */
export const SNOW_SLANT = 0.9

/** Floats per vertex: corner (2), seed (4). */
const STRIDE = 6
const VERTS_PER_PARTICLE = 6

/** How many rain drops fall on a window this size at this intensity. */
export function rainCount(kind: number, intensity: number, cssWidth: number, cssHeight: number): number {
  if (kind !== 1 && kind !== 3) return 0
  const share = kind === 3 ? SLEET_RAIN_SHARE : 1
  return particleCount(RAIN_PER_MPX * share, intensity, cssWidth, cssHeight)
}

/** How many snowflakes fall on a window this size at this intensity. */
export function snowCount(kind: number, intensity: number, cssWidth: number, cssHeight: number): number {
  if (kind !== 2 && kind !== 3) return 0
  const share = kind === 3 ? SLEET_SNOW_SHARE : 1
  return particleCount(SNOW_PER_MPX * share, intensity, cssWidth, cssHeight)
}

function particleCount(perMpx: number, intensity: number, w: number, h: number): number {
  const i = Math.max(0, Math.min(1, intensity))
  return Math.min(PRECIP_MAX_PARTICLES, Math.round((perMpx * i * Math.max(0, w) * Math.max(0, h)) / 1e6))
}

/** A colour the controller refills in place each frame. */
export type MutableRgb = [number, number, number]

/** Something is falling in this scene. */
export function isFalling(scene: Pick<SkyScene, 'precipKind' | 'precipIntensity'>): boolean {
  return scene.precipKind > 0 && scene.precipIntensity > 0
}

/** One frame of rain or snow. The controller owns one and refills it each frame (no allocation). */
export interface PrecipFrame {
  cssWidth: number
  cssHeight: number
  /** Device pixels per CSS pixel, already capped (PRECIP_MAX_DPR). */
  dpr: number
  /** The controller's clock, seconds of eased motion. */
  time: number
  /** 1 rain, 2 snow, 3 sleet. */
  kind: number
  intensity: number
  /** scene.rainLean: -1..1, from the wind the clouds drift with. */
  lean: number
  /** scene.precipAlpha × (1 - the page's wash). */
  alpha: number
  /** The sky as drawn behind the top and the bottom of the screen (precipBackdrop). */
  skyTop: MutableRgb
  skyBottom: MutableRgb
}

/** A frame to refill: the controller makes one and reuses it. */
export function createPrecipFrame(): PrecipFrame {
  return { cssWidth: 0, cssHeight: 0, dpr: 1, time: 0, kind: 0, intensity: 0, lean: 0, alpha: 0, skyTop: [0, 0, 0], skyBottom: [0, 0, 0] }
}

/**
 * The sky as drawn behind the top and the bottom of the screen, into `top`
 * and `bottom` (no allocation): the clear sky's colours under the cloud's
 * average at the scene's cover, mixed over the surface by the drawn
 * strength. A rough stand-in for the pixel behind each drop, good enough to
 * decide lighter or darker and by how much.
 */
export function precipBackdrop(scene: SkyScene, surface: Rgb, strength: number, top: MutableRgb, bottom: MutableRgb): void {
  const cover = Math.max(0, Math.min(1, scene.cloudCover)) * 0.9
  for (let i = 0; i < 3; i++) {
    const cloud = scene.cloudShade[i] * 0.45 + scene.cloudLit[i] * 0.55
    const t = scene.top[i] + (cloud - scene.top[i]) * cover
    const b = scene.horizon[i] + (cloud - scene.horizon[i]) * cover * 0.85
    top[i] = surface[i] + (t - surface[i]) * strength
    bottom[i] = surface[i] + (b - surface[i]) * strength
  }
}

export const PRECIP_VERTEX = /* glsl */ `
precision highp float;
attribute vec2 aCorner;   // rain: x across (-1..1), y along (0 tail .. 1 head); snow: -1..1 each
attribute vec4 aSeed;     // x position, phase, depth (0 far .. 1 near), spare
uniform vec2 uSize;       // CSS px
uniform float uDpr;
uniform float uTime;
uniform float uKind;      // 1 rain, 2 snow
uniform float uLean;      // horizontal px per vertical px
uniform float uSalt;      // decorrelates sleet's two draws from the one buffer
uniform float uAlpha;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
varying vec2 vLocal;      // rain: across (device px), along (0..1); snow: from the centre (device px)
varying float vHalf;      // rain: half width; snow: radius (device px)
varying float vAlpha;
varying vec3 vCol;
varying vec4 vHalo;       // snow: a faint darker ring's colour and strength (rain: none)
varying float vKind;

void main() {
  vec4 s = fract(aSeed + uSalt * vec4(0.6180, 0.4142, 0.7321, 0.2361));
  float d = s.z;
  vec2 pos;
  vec2 local;
  float halfW;
  float a;
  float ring = 0.0;
  if (uKind < 1.5) {
    // Rain: fast thin streaks, the near ones longer, wider, quicker and stronger.
    float speed = mix(520.0, 1150.0, d) * (0.9 + 0.2 * s.w);
    float len = speed * 0.022 * (0.85 + 0.3 * s.w);
    float marginY = len + 6.0;
    float spanY = uSize.y + 2.0 * marginY;
    float fallen = s.y * spanY + uTime * speed;
    float marginX = abs(uLean) * spanY + 6.0;
    float spanX = uSize.x + 2.0 * marginX;
    vec2 head = vec2(mod(s.x * spanX + uLean * fallen, spanX) - marginX, mod(fallen, spanY) - marginY);
    vec2 dir = normalize(vec2(uLean, 1.0));
    vec2 across = vec2(dir.y, -dir.x);
    halfW = mix(0.32, 0.6, d) * uDpr;
    // One device pixel of room either side for the edge's anti-aliasing.
    float w = halfW + 1.0;
    pos = head - dir * len * (1.0 - aCorner.y) + across * (aCorner.x * w / uDpr);
    local = vec2(aCorner.x * w, aCorner.y);
    a = mix(0.16, 0.42, d) * (0.75 + 0.5 * fract(s.w * 7.13));
  } else {
    // Snow: soft round flakes in a few sizes, slow, swaying, drifting with the wind.
    float r = mix(1.0, 3.0, d * d) * (0.8 + 0.4 * s.w);
    float speed = mix(22.0, 62.0, d) * (0.85 + 0.3 * s.w);
    float margin = r + 24.0;
    float spanY = uSize.y + 2.0 * margin;
    float fallen = s.y * spanY + uTime * speed;
    float sway = sin(uTime * (0.45 + 0.6 * s.w) + s.x * 40.0) * mix(4.0, 14.0, d);
    float marginX = abs(uLean) * spanY + margin;
    float spanX = uSize.x + 2.0 * marginX;
    vec2 c = vec2(mod(s.x * spanX + uLean * fallen + sway, spanX) - marginX, mod(fallen, spanY) - margin);
    halfW = r * uDpr;
    // Room for the faint ring round the flake (twice its radius) and the edge.
    float w = halfW * 2.2 + 1.5;
    vec2 corner = vec2(aCorner.x, aCorner.y * 2.0 - 1.0);
    pos = c + corner * (w / uDpr);
    local = corner * w;
    a = mix(0.6, 0.95, d);
    ring = 1.0;
  }

  // The sky behind it (precipBackdrop, top to bottom).
  vec3 bg = mix(uSkyTop, uSkyBottom, clamp(pos.y / uSize.y, 0.0, 1.0));
  float l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
  float bright = smoothstep(0.42, 0.66, l);
  if (ring < 0.5) {
    // Rain: lighter than a dark sky, darker than a light one. The switch is
    // narrow: half way between the two is the sky's own colour, which would
    // hide the rain on a mid-grey storm sky.
    vCol = mix(bg + (vec3(0.93, 0.96, 1.0) - bg) * 0.55, bg * 0.66, smoothstep(0.47, 0.53, l));
    vHalo = vec4(0.0);
  } else {
    // Snow stays white, a touch dimmer on a dark sky, and on a light sky a
    // faint darker ring round each flake keeps it from vanishing into the
    // pale cloud (white on near-white), the way a flake shows against a
    // bright sky.
    vCol = mix(bg + (vec3(0.96, 0.97, 1.0) - bg) * 0.85, vec3(1.0), bright);
    vHalo = vec4(bg * 0.72, 0.3 * smoothstep(0.55, 0.85, l));
  }
  vAlpha = a * uAlpha;
  vLocal = local;
  vHalf = halfW;
  vKind = uKind;
  gl_Position = vec4(pos.x / uSize.x * 2.0 - 1.0, 1.0 - pos.y / uSize.y * 2.0, 0.0, 1.0);
}
`

export const PRECIP_FRAGMENT = /* glsl */ `
precision mediump float;
varying vec2 vLocal;
varying float vHalf;
varying float vAlpha;
varying vec3 vCol;
varying vec4 vHalo;
// The vertex shader's uKind, passed on (a uniform shared by both stages
// would need the same precision in each).
varying float vKind;

void main() {
  float cov;
  if (vKind > 1.5) {
    // Snow: a soft edge round a crisp core, never a hard dot nor a blur, over
    // its faint ring; composited here, premultiplied.
    float r = length(vLocal);
    float core = (1.0 - smoothstep(vHalf * 0.45, vHalf + 0.75, r)) * vAlpha;
    float ring = (1.0 - smoothstep(vHalf * 0.9, vHalf * 2.2 + 1.0, r)) * vHalo.a * vAlpha * (1.0 - core);
    gl_FragColor = vec4(vCol * core + vHalo.rgb * ring, core + ring);
    return;
  }
  {
    // Across: exact coverage of a line this wide, at least a pixel's worth
    // (thinner lines get fainter instead of narrower, so they never shimmer).
    float hw = max(vHalf, 0.5);
    cov = clamp(hw + 0.5 - abs(vLocal.x), 0.0, 1.0) * min(1.0, vHalf * 2.0);
    // Along: fades in from the tail, strongest near the head, a soft tip.
    cov *= smoothstep(0.0, 0.7, vLocal.y) * (1.0 - smoothstep(0.9, 1.0, vLocal.y));
  }
  float a = cov * vAlpha;
  gl_FragColor = vec4(vCol * a, a);
}
`

const UNIFORMS = ['uSize', 'uDpr', 'uTime', 'uKind', 'uLean', 'uSalt', 'uAlpha', 'uSkyTop', 'uSkyBottom'] as const
type UniformName = (typeof UNIFORMS)[number]

/** The static buffer: every particle's six vertices, corner and seed (exported for tests). */
export function buildPrecipBuffer(count: number = PRECIP_MAX_PARTICLES, random: () => number = Math.random): Float32Array {
  const data = new Float32Array(count * VERTS_PER_PARTICLE * STRIDE)
  // Two triangles per particle: a quad from (-1, 0) to (1, 1), across and
  // along a rain streak (the shader maps y to -1..1 for a flake).
  const corners = [-1, 0, 1, 0, 1, 1, -1, 0, 1, 1, -1, 1]
  let o = 0
  for (let p = 0; p < count; p++) {
    const seed = [random(), random(), random(), random()]
    for (let v = 0; v < VERTS_PER_PARTICLE; v++) {
      data[o++] = corners[v * 2]
      data[o++] = corners[v * 2 + 1]
      data[o++] = seed[0]
      data[o++] = seed[1]
      data[o++] = seed[2]
      data[o++] = seed[3]
    }
  }
  return data
}

export class SkyPrecip {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>
  private data: Float32Array
  private width = 0
  private height = 0
  private disposed = false
  private cleanups: Array<() => void> = []

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, onRestored: () => void) {
    this.canvas = canvas
    this.gl = gl
    this.data = buildPrecipBuffer()
    const onLost = (e: Event) => e.preventDefault()
    const onRestore = () => {
      if (!this.disposed && this.init()) onRestored()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestore)
    this.cleanups.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestore)
    })
  }

  /**
   * A canvas in `host` (filling it) with its context and buffer ready, or
   * null with nothing left behind when WebGL is unavailable. `onRestored`:
   * the context came back after a loss, so a frozen sky can draw once.
   */
  static create(host: HTMLElement, onRestored: () => void = () => {}): SkyPrecip | null {
    const canvas = host.ownerDocument.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.dataset.skyPrecip = ''
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      }) as WebGLRenderingContext | null
    } catch {
      gl = null
    }
    if (!gl) return null
    const precip = new SkyPrecip(canvas, gl, onRestored)
    if (!precip.init()) {
      precip.dispose()
      return null
    }
    host.appendChild(canvas)
    return precip
  }

  private init(): boolean {
    const gl = this.gl
    if (gl.isContextLost()) return false
    const vs = compile(gl, gl.VERTEX_SHADER, PRECIP_VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, PRECIP_FRAGMENT)
    if (!vs || !fs) return false
    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (process.env.NODE_ENV !== 'production') console.warn('[sky] precip link failed', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return false
    }
    this.program = program
    gl.useProgram(program)
    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.STATIC_DRAW)
    const aCorner = gl.getAttribLocation(program, 'aCorner')
    const aSeed = gl.getAttribLocation(program, 'aSeed')
    gl.enableVertexAttribArray(aCorner)
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, STRIDE * 4, 0)
    gl.enableVertexAttribArray(aSeed)
    gl.vertexAttribPointer(aSeed, 4, gl.FLOAT, false, STRIDE * 4, 2 * 4)
    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(program, name)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    // A restored context starts with an empty drawing buffer: size it again on the next draw.
    this.width = 0
    this.height = 0
    return true
  }

  draw(f: PrecipFrame): void {
    const gl = this.gl
    if (this.disposed || !this.program || gl.isContextLost()) return
    const w = Math.max(1, Math.round(f.cssWidth * f.dpr))
    const h = Math.max(1, Math.round(f.cssHeight * f.dpr))
    if (w !== this.width || h !== this.height) {
      this.width = w
      this.height = h
      this.canvas.width = w
      this.canvas.height = h
    }
    gl.viewport(0, 0, w, h)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const rain = rainCount(f.kind, f.intensity, f.cssWidth, f.cssHeight)
    const snow = snowCount(f.kind, f.intensity, f.cssWidth, f.cssHeight)
    if (rain + snow === 0 || f.alpha <= 0) return
    const l = this.loc
    gl.uniform2f(l.uSize, f.cssWidth, f.cssHeight)
    gl.uniform1f(l.uDpr, f.dpr)
    gl.uniform1f(l.uTime, f.time % PRECIP_TIME_WRAP)
    // Heavier rain and snow are a little more visible as well as more numerous.
    gl.uniform1f(l.uAlpha, Math.min(1, f.alpha * (0.75 + 0.35 * Math.min(1, f.intensity))))
    gl.uniform3f(l.uSkyTop, f.skyTop[0], f.skyTop[1], f.skyTop[2])
    gl.uniform3f(l.uSkyBottom, f.skyBottom[0], f.skyBottom[1], f.skyBottom[2])
    if (snow > 0) {
      // Under the rain in sleet (drawn first).
      gl.uniform1f(l.uKind, 2)
      gl.uniform1f(l.uLean, f.lean * SNOW_SLANT)
      gl.uniform1f(l.uSalt, 0.37)
      gl.drawArrays(gl.TRIANGLES, 0, snow * VERTS_PER_PARTICLE)
    }
    if (rain > 0) {
      gl.uniform1f(l.uKind, 1)
      gl.uniform1f(l.uLean, f.lean * RAIN_SLANT)
      gl.uniform1f(l.uSalt, 0)
      gl.drawArrays(gl.TRIANGLES, 0, rain * VERTS_PER_PARTICLE)
    }
  }

  /** GL objects deleted, the context handed back, the canvas removed. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const c of this.cleanups.splice(0)) c()
    const gl = this.gl
    if (!gl.isContextLost()) {
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.program) gl.deleteProgram(this.program)
    }
    this.buffer = null
    this.program = null
    this.canvas.remove()
    // This canvas is never reused (a new one each time something falls), so
    // the context can go back at once rather than waiting for GC.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    if (process.env.NODE_ENV !== 'production') console.warn('[sky] precip compile failed', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
