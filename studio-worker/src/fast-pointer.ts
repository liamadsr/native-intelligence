/**
 * The recorded pointer in the FFmpeg export (fast-export.ts): where the composition draws it on every frame, from the
 * engine's own functions (web/src/lib/studio/engine/pointer.ts), and the pictures it is drawn with, made by Chrome
 * itself from the composition, so they are the engine's art pixel for pixel.
 *
 * The art: Chrome draws each state the video needs (where in its pixel the pointer sits, how far a click has pressed
 * it, how far its ring has grown) in a small made-up video of the same pointer, once over black and once over white.
 * From the two, each pixel's coverage and colour (alpha = 1 − (white − black) / 255, premultiplied colour = black):
 * laid over any picture, that is what Chrome lays over it. The glass pointer also blurs what is under it (a backdrop
 * filter): a third pass over a fine checkerboard (its blur is its mean, grey) gives how much of the blurred picture
 * each pixel takes, and FFmpeg blurs the frame's own pixels there.
 */
import { createRequire } from 'node:module'
import { crc32, deflateSync } from 'node:zlib'
import { availableParallelism } from 'node:os'
import type { EditorAsset, EditorClip, EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
// Each by its own literal path, so a bundler (scripts/build-local-runner.ts) takes exactly these files in.
const { pointerAt, clickAt, pressScale, CLICK_RING_MS } = require('../../web/src/lib/studio/engine/pointer.ts') as typeof import('../../web/src/lib/studio/engine/pointer.ts')
const { sourceTimeSeconds } = require('../../web/src/lib/studio/engine/timeline.ts') as typeof import('../../web/src/lib/studio/engine/timeline.ts')

/** The pointer on one frame: its tip in output pixels (fractional, as Chrome lays it out), the press scale, the ring's progress (0..1) or null. */
export interface PointerState { x: number; y: number; press: number; ring: number | null }

/** A clip's pointer, frame by frame (null: none drawn on that frame), and the size it is drawn at (px). */
export interface PointerPlan { style: 'arrow' | 'glass'; size: number; states: (PointerState | null)[] }

/**
 * The pointer of a clip of `asset` (the recording, shown whole: the frame is its pane) on each of its `frames` output
 * frames, as the composition draws it (SourceClip: the trace's point at the clip's source time, the click whose ring
 * shows, the press). Null when this clip draws none. Pure.
 */
export function clipPointer(project: EditorProject, clip: EditorClip, asset: EditorAsset, frames: number): PointerPlan | null {
  const trace = asset.sourceCursorHidden ? asset.trace : undefined
  const style = project.cursor.style
  if (!trace || !trace.cursor.length || style === 'none') return null
  const { width: W, height: H, fps } = project.output
  const playbackFrames = frames - clip.holdEndFrames
  const size = project.cursor.size * (W / trace.viewport.width)
  const states = Array.from({ length: frames }, (_, l): PointerState | null => {
    const frame = Math.min(l, frames - 1)
    const ms = sourceTimeSeconds(clip, asset, frame, fps) * 1000
    const at = pointerAt(trace, ms)
    if (!at) return null
    const click = frame < playbackFrames && project.cursor.clickFeedback && clickAt(trace, ms)
    return { x: at[0] * W, y: at[1] * H, press: pressScale(click, ms), ring: click ? (ms - click.t) / CLICK_RING_MS : null }
  })
  return { style, size, states }
}

/**
 * Chrome draws the pointer alike for every tip inside the same 1/16 of a pixel: a tip floored to that is drawn exactly
 * as the tip itself (made-up recordings, test/pointer-probe.ts: the same pixels to the bit floored to 1/16 and to 1/64,
 * Chrome's layout unit; rounding to 1/4 or 1/8 is not). So a pointer moving through a take needs at most 256 pictures
 * between its clicks. Pure.
 */
export const LAYOUT_UNIT = 16
export function drawnState(s: PointerState): PointerState {
  return { ...s, x: Math.floor(s.x * LAYOUT_UNIT) / LAYOUT_UNIT, y: Math.floor(s.y * LAYOUT_UNIT) / LAYOUT_UNIT }
}
/** Which picture a state is drawn with: the tip's place inside its pixel (in 1/16 px), the press and the ring. Pure. */
export function stateKey(s: PointerState): string {
  const d = drawnState(s), f = (v: number) => Math.round((v - Math.floor(v)) * LAYOUT_UNIT)
  return `${f(d.x)},${f(d.y)},${s.press},${s.ring === null ? '-' : s.ring}`
}

/**
 * The window a sprite covers around the tip's pixel (floor of the tip), in pixels: generous for every part of the art
 * (the arrow reaches 1.4 sizes down and right with its shadow; the ring and the glass are centred, up to 0.9 of a size
 * out, with a shadow below). Pure.
 */
export function spriteWindow(size: number): { left: number; top: number; width: number; height: number } {
  const before = Math.ceil(1.0 * size + 16), after = Math.ceil(1.5 * size + 16)
  return { left: -before, top: -before, width: before + after + 1, height: before + after + 1 }
}

/**
 * A pointer state's picture: straight RGB and coverage (RGBA, `w`×`h`), and for the glass how much of the blurred
 * picture under it each pixel takes before the picture is laid on (`blur`, 0..255: k / (1 − α), so the frame becomes
 * frame + k (blur(frame) − frame) under the picture's coverage α, as Chrome draws it).
 */
export interface Sprite { w: number; h: number; rgba: Buffer; blur: Buffer | null }

/** Frames between two click states in the made-up video: their clicks never reach each other (a ring lasts 220 ms). */
export const STATE_GAP = 20, SPRITE_FPS = 60, SPRITE_PAD = 8
/** Chrome tabs drawing the pointer's small pictures (each a few hundred kilobytes of memory). */
export const SPRITE_TABS = 8

/**
 * Where each state sits in the made-up video: the states without a click first, one a frame (no click before them),
 * then those with one, STATE_GAP frames apart (and STATE_GAP after the last plain one); and the frame ranges Chrome
 * draws (`every` frames apart). Pure.
 */
export function stateFrames(states: PointerState[]): { frames: number[]; ranges: { from: number; to: number; every: number }[]; length: number } {
  const plain = states.filter((s) => s.ring === null).length
  let plainAt = 0, clickAt = 0
  const frames = states.map((s) => (s.ring === null ? plainAt++ : plain + STATE_GAP * ++clickAt - 1))
  const clicks = states.length - plain
  const ranges = [...(plain ? [{ from: 0, to: plain - 1, every: 1 }] : []), ...(clicks ? [{ from: plain + STATE_GAP - 1, to: plain + STATE_GAP * clicks - 1, every: STATE_GAP }] : [])]
  return { frames, ranges, length: Math.max(1, ...frames.map((f) => f + 1)) }
}

/**
 * The made-up video Chrome draws the pointer's states in: the clip's recording replaced by a plain picture (`file`, a
 * `width`×`height` video at 60 fps), the pointer at state k on its frame (stateFrames), its tip at the window's tip pixel
 * plus the state's place inside its pixel, its size the clip's, a click started just as long before as the state's. Pure.
 */
export function spriteProject(project: EditorProject, plan: Pick<PointerPlan, 'size'>, states: PointerState[], screen: { file: string; sha256: string; bytes: number }, style: 'pointer' | 'none' = 'pointer'): EditorProject {
  const win = spriteWindow(plan.size)
  // At least 128 px a side (a hardware encoder's smallest picture is well below that), even.
  const even = (v: number) => Math.max(128, v + (v % 2)), width = even(win.width + 2 * SPRITE_PAD), height = even(win.height + 2 * SPRITE_PAD)
  const tipX = SPRITE_PAD - win.left, tipY = SPRITE_PAD - win.top
  // The recording's own points: chosen so the pointer is drawn at the clip's size (size × width / viewport).
  const viewport = { width: project.cursor.size * width / plan.size, height: project.cursor.size * height / plan.size, scale: 1 }
  const at = stateFrames(states), frames = at.length
  const clip = { id: 'pointer', assetId: 'pointer', trimStartSourceFrame: 0, trimEndSourceFrame: frames + 1, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [],
    motion: project.clips[0]!.motion, playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: false } } as unknown as EditorClip
  const asset = { id: 'pointer', kind: 'video', name: 'Pointer.mp4', file: screen.file, sha256: screen.sha256, bytes: screen.bytes, width, height, sourceFps: SPRITE_FPS,
    sourceFrames: frames + 1, durationSeconds: (frames + 1) / SPRITE_FPS, hasAudio: false, sourceCursorHidden: true } as EditorAsset
  const cursor: [number, number, number][] = [], actions: NonNullable<EditorAsset['trace']>['actions'] = []
  for (const [k, s] of states.entries()) {
    const ms = sourceTimeSeconds(clip, asset, at.frames[k]!, SPRITE_FPS) * 1000
    cursor.push([ms, (tipX + s.x - Math.floor(s.x)) / width * viewport.width, (tipY + s.y - Math.floor(s.y)) / height * viewport.height])
    if (s.ring !== null) actions.push({ t: ms - s.ring * CLICK_RING_MS, end: ms, kind: 'click', label: 'Click', box: null })
  }
  cursor.sort((a, b) => a[0] - b[0]); actions.sort((a, b) => a.t - b.t)
  return { ...project, output: { width, height, fps: SPRITE_FPS }, assets: [{ ...asset, trace: { viewport, cursor, actions } }], clips: [clip], presenterTrack: null, audioTracks: [],
    cursor: { ...project.cursor, style: style === 'none' ? 'none' : project.cursor.style, clickFeedback: true } } as EditorProject
}

/** Where a sprite sits in its made-up frame (the window, SPRITE_PAD in), and where its tip pixel is in it. Pure. */
export function spriteCrop(size: number): { x: number; y: number; w: number; h: number; tipX: number; tipY: number } {
  const win = spriteWindow(size)
  return { x: SPRITE_PAD, y: SPRITE_PAD, w: win.width, h: win.height, tipX: -win.left, tipY: -win.top }
}

/** A Gaussian blur (σ px, edges clamped) of an RGB picture, as CSS blur(σ) is. Pure. */
export function gaussian(rgb: Buffer, w: number, h: number, sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(sigma * 3)), kern = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const sum = kern.reduce((a, b) => a + b, 0), k = kern.map((x) => x / sum)
  const tmp = new Float64Array(w * h * 3), out = new Float64Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0
    for (let j = -r; j <= r; j++) v += k[j + r]! * rgb[(y * w + Math.max(0, Math.min(w - 1, x + j))) * 3 + c]!
    tmp[(y * w + x) * 3 + c] = v
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0
    for (let j = -r; j <= r; j++) v += k[j + r]! * tmp[(Math.max(0, Math.min(h - 1, y + j)) * w + x) * 3 + c]!
    out[(y * w + x) * 3 + c] = v
  }
  return out
}

/**
 * The sprites from Chrome's drawings of `n` states (RGB, the window only, state after state): over black and over
 * white (coverage α = 1 − (white − black) / 255, premultiplied colour C = black); for the glass also over a
 * checkerboard, with the checkerboard drawn bare (`bare`, one picture) and the blur Chrome applies (σ px): there
 * over = bare (1 − α) + C + k (blur(bare) − bare), which gives k. Pure.
 */
export function matte(n: number, w: number, h: number, black: Buffer, white: Buffer, checker?: { over: Buffer; bare: Buffer; sigma: number }): Sprite[] {
  const px = w * h, out: Sprite[] = []
  const blurred = checker ? gaussian(checker.bare, w, h, checker.sigma) : null
  for (let k = 0; k < n; k++) {
    const rgba = Buffer.alloc(px * 4), blur = checker ? Buffer.alloc(px) : null
    // The plain pictures as Chrome shows them (an encoder's black and white need not be 0 and 255): the window's first
    // pixel, which the pointer never reaches.
    const b0 = [0, 1, 2].map((c) => black[k * px * 3 + c]!), w0 = [0, 1, 2].map((c) => white[k * px * 3 + c]!)
    for (let i = 0; i < px; i++) {
      const o = (k * px + i) * 3
      let cover = 0
      for (let c = 0; c < 3; c++) cover += 1 - (white[o + c]! - black[o + c]!) / Math.max(1, w0[c]! - b0[c]!)
      const a = Math.max(0, Math.min(1, cover / 3)) * 255
      for (let c = 0; c < 3; c++) {
        const premultiplied = black[o + c]! - b0[c]! * (1 - a / 255)
        rgba[i * 4 + c] = a > 0 ? Math.max(0, Math.min(255, Math.round(premultiplied * 255 / a))) : 0
      }
      rgba[i * 4 + 3] = Math.round(a)
      if (checker && blur && blurred) {
        let num = 0, den = 0
        for (let c = 0; c < 3; c++) {
          const bare = checker.bare[i * 3 + c]!, d = blurred[i * 3 + c]! - bare
          num += (checker.over[o + c]! - bare * (1 - a / 255) - (black[o + c]! - b0[c]! * (1 - a / 255))) * d
          den += d * d
        }
        const weight = den > 4 ? Math.max(0, num / den) : 0
        // Laid on before the picture, which then covers α of it: k / (1 − α).
        blur[i] = Math.max(0, Math.min(255, Math.round(255 * Math.min(1, a < 255 ? weight / (1 - a / 255) : 0))))
      }
    }
    out.push({ w, h, rgba, blur })
  }
  return out
}

/** An RGBA (or grey, `channels` 1) picture as a PNG file's bytes: no filtering, deflated. Pure. */
export function png(w: number, h: number, pixels: Buffer, channels: 1 | 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 0
  const rows = Buffer.alloc((w * channels + 1) * h)
  for (let y = 0; y < h; y++) pixels.copy(rows, y * (w * channels + 1) + 1, y * w * channels, (y + 1) * w * channels)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * An FFmpeg expression of the frame number `n` giving `values[n]` (the last value past the end): runs of one value
 * folded, then a balanced tree of comparisons, so a frame costs a few of them however long the clip. Pure.
 */
export function lookup(values: number[], v = 'n'): string {
  const runs: { from: number; value: number }[] = []
  for (const [i, x] of values.entries()) if (!runs.length || runs.at(-1)!.value !== x) runs.push({ from: i, value: x })
  const tree = (a: number, b: number): string => {
    if (b - a === 1) return String(runs[a]!.value)
    const m = (a + b) >> 1
    return `if(lt(${v}\\,${runs[m]!.from})\\,${tree(a, m)}\\,${tree(m, b)})`
  }
  return runs.length ? tree(0, runs.length) : '0'
}

// ---- in FFmpeg's graph -----------------------------------------------------------------------------------------------

/**
 * Where a clip's pointer is laid in FFmpeg's graph: on every frame a `cw`×`ch` window of the frame (at cx, cy, even,
 * inside the frame) is made RGB, the glass's blur laid in it, the pointer's picture laid over it (both pictures the
 * window's size, the pointer already in its place), and the window put back. Each frame's pictures are listed in
 * `sprites` (and `blur`), FFmpeg concat lists of PNG files.
 */
export interface PointerLayer { cw: number; ch: number; cx: number[]; cy: number[]; sprites: string; blur: string | null; sigma: number }

/** The blur's reach past the pointer's window (3 σ, CSS blur(size / 9)), and the window's size and margin for a pointer. Pure. */
export function layerWindow(plan: Pick<PointerPlan, 'size' | 'style'>): { margin: number; cw: number; ch: number; sigma: number } {
  const win = spriteWindow(plan.size), sigma = plan.size / 9
  const margin = plan.style === 'glass' ? Math.ceil(3 * sigma) + 2 : 2
  // Even (a 4:2:0 window), with a pixel to spare for the window's even place.
  const even = (v: number) => v + (v % 2)
  return { margin, cw: even(win.width + 2 * margin + 2), ch: even(win.height + 2 * margin + 2), sigma }
}

/**
 * For each frame's state (or none), where the window goes and where the sprite sits in it: the window `margin` before
 * the sprite, rounded down to even (the 4:2:0 chroma lines up), kept inside the W×H frame. Pure.
 */
export function placements(states: (PointerState | null)[], plan: Pick<PointerPlan, 'size' | 'style'>, W: number, H: number): { cx: number; cy: number; ix: number; iy: number }[] {
  const { margin, cw, ch } = layerWindow(plan), crop = spriteCrop(plan.size)
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return states.map((s) => {
    if (!s) return { cx: 0, cy: 0, ix: 0, iy: 0 }
    const d = drawnState(s), x = Math.floor(d.x) - crop.tipX, y = Math.floor(d.y) - crop.tipY
    const cx = clamp((x - margin) & ~1, (W - cw) & ~1), cy = clamp((y - margin) & ~1, (H - ch) & ~1)
    return { cx, cy, ix: x - cx, iy: y - cy }
  })
}

/** A window-sized picture with the sprite (`channels` 4) or its blur weights (1) laid at ix, iy, clipped to the window. Pure. */
export function placed(sprite: Sprite | null, which: 'rgba' | 'blur', cw: number, ch: number, ix: number, iy: number): Buffer {
  const channels = which === 'rgba' ? 4 : 1, out = Buffer.alloc(cw * ch * channels)
  const src = sprite ? (which === 'rgba' ? sprite.rgba : sprite.blur) : null
  if (!sprite || !src) return out
  for (let y = 0; y < sprite.h; y++) {
    const Y = iy + y
    if (Y < 0 || Y >= ch) continue
    for (let x = 0; x < sprite.w; x++) {
      const X = ix + x
      if (X < 0 || X >= cw) continue
      src.copy(out, (Y * cw + X) * channels, (y * sprite.w + x) * channels, (y * sprite.w + x + 1) * channels)
    }
  }
  return out
}

/**
 * The filters laying a pointer layer on stream `input` (a clip's screen, on a 1/fps clock with pts N), giving `output`:
 * the frame's window made RGB (BT.709, limited range, as every source here), the glass's blur under its weights, the
 * pointer over it, the window back in 4:2:0 and put back. `sprite` and `blur` are the inputs carrying the layer's
 * pictures. Pure.
 */
export function pointerFilters(tag: string, input: string, output: string, sprite: number, blur: number | null, layer: Pick<PointerLayer, 'cw' | 'ch' | 'cx' | 'cy' | 'sigma'>, fps: number): string[] {
  // The frame by its time (pts N on a 1/fps clock), not by `n`: overlay's frame count did not follow the frame it laid
  // on (the window was put back a frame or two off where it was cut out).
  const at = `round(t*${fps})`, cx = lookup(layer.cx, at), cy = lookup(layer.cy, at), clock = `settb=1/${fps},setpts=N`
  const out = [
    `[${input}]${clock},split[${tag}a][${tag}b]`,
    `[${tag}b]crop=w=${layer.cw}:h=${layer.ch}:x='${cx}':y='${cy}',scale=in_color_matrix=bt709:in_range=tv,format=gbrp[${tag}w0]`,
    `[${sprite}:v]${clock},format=rgba[${tag}s]`,
  ]
  let win = `${tag}w0`
  if (blur !== null) {
    out.push(`[${win}]split[${tag}w1][${tag}w2]`, `[${tag}w2]gblur=sigma=${num(layer.sigma)}:steps=6[${tag}g]`, `[${blur}:v]${clock},format=gray[${tag}k]`,
      `[${tag}g][${tag}k]alphamerge[${tag}ga]`, `[${tag}w1][${tag}ga]overlay=format=gbrp:eof_action=pass[${tag}w3]`)
    win = `${tag}w3`
  }
  out.push(`[${win}][${tag}s]overlay=format=gbrp:eof_action=pass,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${tag}p]`,
    `[${tag}a][${tag}p]overlay=x='${cx}':y='${cy}':eval=frame:format=yuv420:eof_action=pass[${output}]`)
  return out
}
const num = (x: number) => String(Math.round(x * 1e6) / 1e6)

// ---- the pictures, drawn by Chrome ------------------------------------------------------------------------------------

/**
 * The sprites of `states` (drawn states, each once), drawn by Chrome: the made-up sprite video (spriteProject) over a
 * black, a white and (the glass) a checkerboard recording, made with this export's own encoder (`encode`: its
 * arguments for a picture this size) and put where the composition reads the project's files (`assetsDir`);
 * `render` draws those frames as PNGs (Remotion's renderFrames in the export's browser), keyed by frame.
 */
export async function drawPointerStates(o: {
  project: EditorProject; plan: Pick<PointerPlan, 'size' | 'style'>; states: PointerState[]; assetsDir: string; scratch: string; signal: AbortSignal
  encode: (width: number, height: number) => string[]
  render: (project: EditorProject, ranges: { from: number; to: number; every: number }[]) => Promise<Map<number, Buffer>>
  run: (file: string, args: string[], opts: { signal: AbortSignal; input?: Buffer }) => Promise<Buffer>
}): Promise<Sprite[]> {
  const { createHash } = await import('node:crypto')
  const { readFile, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const probe = spriteProject(o.project, o.plan, o.states, { file: 'assets/x.mp4', sha256: '0'.repeat(64), bytes: 1 })
  const { width, height } = probe.output, at = stateFrames(o.states), frames = at.length
  const crop = spriteCrop(o.plan.size), win = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`
  const made: string[] = []
  const plain = async (name: string, colour: string, after: string[]) => {
    const tmp = join(o.scratch, `pointer-${name}.mp4`)
    await o.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=${width}x${height}:r=${SPRITE_FPS}:d=${(frames + 2) / SPRITE_FPS}`,
      '-vf', [...after, 'format=yuv420p'].join(','), '-an', ...o.encode(width, height), tmp], { signal: o.signal })
    const buf = await readFile(tmp), sha256 = createHash('sha256').update(buf).digest('hex')
    const file = join(o.assetsDir, `${sha256}.mp4`)
    await writeFile(file, buf); made.push(file, tmp)
    return { file: `assets/${sha256}.mp4`, sha256, bytes: buf.length }
  }
  // Each pass's pictures in the states' order (Chrome draws them in the video's order).
  const pass = async (screen: Awaited<ReturnType<typeof plain>>, which: 'pointer' | 'none') => {
    const drawn = await o.render(spriteProject(o.project, o.plan, o.states, screen, which), which === 'none' ? [{ from: 0, to: 0, every: 1 }] : at.ranges)
    const pngs = which === 'none' ? [drawn.get(0)!] : at.frames.map((f) => drawn.get(f)!)
    if (pngs.some((p) => !p)) throw new Error("Chrome did not draw every one of the pointer's pictures")
    return o.run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0', '-vf', win, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { signal: o.signal, input: Buffer.concat(pngs) })
  }
  try {
    // The passes at once (each a browser's tabs on small pictures).
    const glass = o.plan.style === 'glass'
    const [black, white, checker] = await Promise.all([
      plain('black', 'black', []).then((f) => pass(f, 'pointer')),
      plain('white', 'white', []).then((f) => pass(f, 'pointer')),
      glass ? plain('checker', 'black', [`geq=lum='if(mod(X+Y\\,2)\\,235\\,16)':cb=128:cr=128`])
        .then(async (board) => ({ over: await pass(board, 'pointer'), bare: (await pass(board, 'none')).subarray(0, crop.w * crop.h * 3), sigma: o.plan.size / 9 })) : Promise.resolve(undefined),
    ])
    return matte(o.states.length, crop.w, crop.h, black, white, checker)
  } finally {
    for (const f of made) await rm(f, { force: true })
  }
}

/** drawPointerStates with Remotion drawing the frames (renderFrames, PNG, in `common`'s browser): what the export and its proof use. */
export function chromePointerArt(o: {
  project: EditorProject; serveUrl: string; common: Record<string, unknown>; assetsDir: string; scratch: string; signal: AbortSignal; concurrency: number
  encode: (width: number, height: number) => string[]
  run: (file: string, args: string[], opts: { signal: AbortSignal; input?: Buffer }) => Promise<Buffer>
  remotion: Pick<typeof import('@remotion/renderer'), 'renderFrames' | 'selectComposition'>
  inputProps: (project: EditorProject) => Record<string, unknown>; compositionId: string; cancelSignal?: unknown
}): (a: { plan: Pick<PointerPlan, 'size' | 'style'>; states: PointerState[] }) => Promise<Sprite[]> {
  return ({ plan, states }) => drawPointerStates({ project: o.project, plan, states, assetsDir: o.assetsDir, scratch: o.scratch, signal: o.signal, encode: o.encode, run: o.run,
    render: async (sprites, ranges) => {
      const inputProps = o.inputProps(sprites)
      const composition = await o.remotion.selectComposition({ serveUrl: o.serveUrl, id: o.compositionId, inputProps, ...o.common })
      const pngs = new Map<number, Buffer>()
      for (const r of ranges) {
        // Remotion counts its frames from the range's start: the frame it hands back is the range's own.
        // Remotion refuses more tabs than the cores it counts (a container's 4 on the server).
        await o.remotion.renderFrames({ serveUrl: o.serveUrl, composition, inputProps, ...o.common, imageFormat: 'png', everyNthFrame: r.every, frameRange: [r.from, r.to],
          concurrency: Math.max(1, Math.min(o.concurrency, availableParallelism())), outputDir: null, ...(o.cancelSignal ? { cancelSignal: o.cancelSignal } : {}), onFrameBuffer: (b: Buffer, f: number) => { pngs.set(f, b) },
          onStart: () => {}, onFrameUpdate: () => {} } as Parameters<typeof o.remotion.renderFrames>[0])
      }
      return pngs
    } })
}
