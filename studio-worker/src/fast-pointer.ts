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
import { resolve } from 'node:path'
import { linkDir, unlinkDir } from './platform.ts'
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

/**
 * How the pointer's passes (over black, over white, and for the glass over a checkerboard and the checkerboard bare)
 * share one budget of Chrome tabs, the pointer's own (jobs/export.ts, spriteTabs: the CPU quota, at most 8): `atOnce`
 * passes at a time, each in `tabs` tabs, so never more than the budget at once; with a budget smaller than the passes,
 * they run one after another. Pure.
 */
export function spriteSchedule(budget: number, passes: number): { atOnce: number; tabs: number } {
  const b = Math.max(1, Math.floor(budget) || 1), atOnce = Math.max(1, Math.min(passes, b))
  return { atOnce, tabs: Math.max(1, Math.floor(b / atOnce)) }
}

/**
 * What the fast export draws a pointer with at most, refused in the plan before Chrome starts (fast-export.ts): the
 * distinct pictures Chrome draws (each a few frames of a made-up video in each pass), the bytes they are held in
 * (coverage and colour, and the glass's blur weight: 5 bytes a pixel of its window), and the places one clip's window
 * takes (each run of one place is a few comparisons in FFmpeg's per-frame expressions, written several times in the
 * clip's graph). A 15.7 s take with clicks needs about 400 pictures; a 10 minute one with 200 clicks about 2,500.
 */
export const POINTER_LIMITS = { pictures: 4000, bytes: 256 * 1024 * 1024, places: 30_000 }

/** The bytes one pointer picture is held in (its window's pixels: RGBA, and the glass's blur weight). Pure. */
export function pictureBytes(plan: Pick<PointerPlan, 'size' | 'style'>): number {
  const crop = spriteCrop(plan.size)
  return crop.w * crop.h * (plan.style === 'glass' ? 5 : 4)
}

/**
 * Why a video's pointer is more than the fast export draws (POINTER_LIMITS), in plain words, or null: `clips` are each
 * clip's pointer states (null: none) and the held pointer under its blend. Pure.
 */
export function pointerBudgetProblem(look: Pick<PointerPlan, 'size' | 'style'>, clips: { states: (PointerState | null)[] | null; held: PointerState | null }[], W: number, H: number): string | null {
  const keys = new Set<string>()
  for (const c of clips) for (const s of [...(c.states ?? []), c.held]) if (s) keys.add(stateKey(s))
  if (keys.size > POINTER_LIMITS.pictures) return `its pointer needs ${keys.size} pictures, more than the ${POINTER_LIMITS.pictures} this path draws`
  const bytes = keys.size * pictureBytes(look)
  if (bytes > POINTER_LIMITS.bytes) return `its pointer's pictures would take ${Math.ceil(bytes / 2 ** 20)} MB, more than the ${POINTER_LIMITS.bytes / 2 ** 20} MB this path holds`
  for (const [i, c] of clips.entries()) {
    if (!c.states) continue
    const places = placements(c.states, look, W, H)
    let runs = 0
    for (let l = 0; l < places.length; l++) if (l === 0 || places[l]!.cx !== places[l - 1]!.cx || places[l]!.cy !== places[l - 1]!.cy) runs++
    if (runs > POINTER_LIMITS.places) return `clip ${i + 1}'s pointer moves for too long (${runs} places, at most ${POINTER_LIMITS.places} in one clip)`
  }
  return null
}

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

/**
 * The glass's measured blur, checked without depending on what any video shows: well inside its disk (0.35 of a size
 * from its centre, inside its rim) Chrome lays 0.85 (its opacity) of the blurred frame under a fill that lets 62 to 88 %
 * through, so the weight there (Sprite.blur) is about 0.8 whatever is under it. The mean over every state's disk must
 * be in GLASS_WEIGHT: an encoder that flattened the made-up checkerboard, or a fit that failed, gives about 0 and is
 * refused (the glass would be drawn with no blur). Pure.
 */
export const GLASS_WEIGHT = { min: 0.65, max: 0.95 }
export function glassWeight(sprites: Sprite[], states: PointerState[], size: number): number {
  const crop = spriteCrop(size)
  let sum = 0, n = 0
  for (const [k, sp] of sprites.entries()) {
    const s = states[k]!, cx = crop.tipX + s.x - Math.floor(s.x), cy = crop.tipY + s.y - Math.floor(s.y), r = 0.35 * size * s.press
    if (!sp.blur) continue
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(sp.h - 1, Math.ceil(cy + r)); y++) for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(sp.w - 1, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue
      sum += sp.blur[y * sp.w + x]! / 255; n++
    }
  }
  return n ? sum / n : NaN
}

/**
 * Where a pointer's window picture changes the frame at all (coverage or blur weight above 0), widened to whole 2×2
 * blocks (the window sits on even pixels, so a block is one 4:2:0 chroma sample): 255 there, 0 elsewhere. Only those
 * pixels are put back from the window; every other one stays the source's, bit for bit. Pure.
 */
export function touchedMask(rgba: Buffer, blur: Buffer | null, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h)
  const hit = (x: number, y: number) => x < w && y < h && (rgba[(y * w + x) * 4 + 3]! > 0 || (!!blur && blur[y * w + x]! > 0))
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (!(hit(x, y) || hit(x + 1, y) || hit(x, y + 1) || hit(x + 1, y + 1))) continue
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) if (x + dx < w && y + dy < h) out[(y + dy) * w + x + dx] = 255
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
 * window's size, the pointer already in its place), and of the window only the pixels the picture touches put back
 * (`masks`: touchedMask); on a frame with no pointer (`shown` false) nothing is. Each frame's pictures are listed in
 * `sprites`, `masks` (and `blur`), FFmpeg concat lists of PNG files.
 */
export interface PointerLayer { cw: number; ch: number; cx: number[]; cy: number[]; shown: boolean[]; sprites: string; masks: string; blur: string | null; sigma: number }

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
 * pointer over it, the window back in 4:2:0, and only its touched pixels laid back on the frame (the mask as its alpha:
 * 255 or 0 on whole 2×2 blocks, so every other luma and chroma sample of the frame is kept exactly); on a frame with no
 * pointer, nothing at all. `sprite`, `mask` and `blur` are the inputs carrying the layer's pictures. Pure.
 */
export function pointerFilters(tag: string, input: string, output: string, sprite: number, mask: number, blur: number | null, layer: Pick<PointerLayer, 'cw' | 'ch' | 'cx' | 'cy' | 'shown' | 'sigma'>, fps: number): string[] {
  // The frame by its time (pts N on a 1/fps clock), not by `n`: overlay's frame count did not follow the frame it laid
  // on (the window was put back a frame or two off where it was cut out).
  const at = `round(t*${fps})`, cx = lookup(layer.cx, at), cy = lookup(layer.cy, at), clock = `settb=1/${fps},setpts=N`
  const out = [
    `[${input}]${clock},split[${tag}a][${tag}b]`,
    `[${tag}b]crop=w=${layer.cw}:h=${layer.ch}:x='${cx}':y='${cy}',scale=in_color_matrix=bt709:in_range=tv,format=gbrp[${tag}w0]`,
    `[${sprite}:v]${clock},format=rgba[${tag}s]`,
    `[${mask}:v]${clock},format=gray[${tag}m]`,
  ]
  let win = `${tag}w0`
  if (blur !== null) {
    out.push(`[${win}]split[${tag}w1][${tag}w2]`, `[${tag}w2]gblur=sigma=${num(layer.sigma)}:steps=6[${tag}g]`, `[${blur}:v]${clock},format=gray[${tag}k]`,
      `[${tag}g][${tag}k]alphamerge[${tag}ga]`, `[${tag}w1][${tag}ga]overlay=format=gbrp:eof_action=pass[${tag}w3]`)
    win = `${tag}w3`
  }
  out.push(`[${win}][${tag}s]overlay=format=gbrp:eof_action=pass,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${tag}p]`,
    `[${tag}p][${tag}m]alphamerge[${tag}pm]`,
    `[${tag}a][${tag}pm]overlay=x='${cx}':y='${cy}':eval=frame:format=yuv420:eof_action=pass:enable='${lookup(layer.shown.map(Number), at)}'[${output}]`)
  return out
}
const num = (x: number) => String(Math.round(x * 1e6) / 1e6)

/** The FFmpeg components the pointer's drawing and its check need, by kind (probed before Chrome draws anything: fast-export-run.ts). Pure. */
export function pointerNeeds(style: PointerPlan['style']): { filters: string[]; muxers: string[]; demuxers: string[] } {
  return { filters: ['crop', 'scale', 'format', 'split', 'settb', 'setpts', 'overlay', 'alphamerge', 'select', 'color', 'geq', ...(style === 'glass' ? ['gblur'] : [])],
    muxers: ['rawvideo', 'framemd5'], demuxers: ['concat', 'image2'] }
}

// ---- the pictures, drawn by Chrome ------------------------------------------------------------------------------------

export type ToolRun = (file: string, args: string[], opts: { signal: AbortSignal; input?: Buffer; timeout?: number }) => Promise<Buffer>
/** Each task in turn, `atOnce` of them at a time, their results in order. */
async function inTurn<T>(tasks: (() => Promise<T>)[], atOnce: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(atOnce, tasks.length) }, async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i]!() } }))
  return out
}
const hashLines = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1)!.trim())

/**
 * The sprites of `states` (drawn states, each once), drawn by Chrome: the made-up sprite video (spriteProject) over a
 * black, a white and (the glass) a checkerboard recording, made with this export's own encoder (`encode`: its
 * arguments for a picture this size).
 * - The made-up recordings are written in the job's scratch (scratch/pointer/), and the composition reads them through a
 *   link in its asset folder (`assetsDir`), taken away at the end (and by the asset cache's start after a crash: its
 *   name is not an asset's).
 * - The passes share `tabs` Chrome tabs (spriteSchedule); `render` draws a pass's frames (Remotion's renderFrames in the
 *   export's browser) and hands each picture to `write`, which puts it on disk at once.
 * - Each pass's pictures are decoded to a raw file on disk, one pass at a time, and the sprites made state by state from
 *   those files: what is held is the sprites alone (bounded by POINTER_LIMITS in the plan).
 * - The bare checkerboard is drawn once when every frame of its recording decodes to the same picture (checked), else at
 *   the very frames of the pass over it; the glass's blur is then checked without regard to any content (glassWeight).
 */
export async function drawPointerStates(o: {
  project: EditorProject; plan: Pick<PointerPlan, 'size' | 'style'>; states: PointerState[]; assetsDir: string; scratch: string; signal: AbortSignal
  /** The Chrome tabs every pass shares (the pointer's own budget). */
  tabs: number
  encode: (width: number, height: number) => string[]
  render: (project: EditorProject, ranges: { from: number; to: number; every: number }[], opts: { concurrency: number; write: (frame: number, png: Buffer) => void }) => Promise<void>
  run: ToolRun
  log?: (line: string) => void
}): Promise<Sprite[]> {
  const { createHash, randomBytes } = await import('node:crypto')
  const { mkdir, open, readFile, rm, stat } = await import('node:fs/promises')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const probe = spriteProject(o.project, o.plan, o.states, { file: 'assets/x.mp4', sha256: '0'.repeat(64), bytes: 1 })
  const { width, height } = probe.output, at = stateFrames(o.states), frames = at.length
  const crop = spriteCrop(o.plan.size), win = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, px = crop.w * crop.h
  // FFmpeg's time limit for these runs: generous for the frames there are (a long take's made-up video is long).
  const timeout = Math.max(180_000, Math.ceil((frames / SPRITE_FPS) * 2000) + 60_000)
  const work = resolve(o.scratch, 'pointer', 'drawing'), madeUp = join(work, 'made-up')
  await mkdir(madeUp, { recursive: true })
  const served = `pointer-${randomBytes(8).toString('hex')}`, link = join(o.assetsDir, served)
  await linkDir(madeUp, link)
  try {
    const plain = async (name: string, colour: string, after: string[]) => {
      const path = join(madeUp, `${name}.mp4`)
      await o.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=${width}x${height}:r=${SPRITE_FPS}:d=${(frames + 2) / SPRITE_FPS}`,
        // Every frame a keyframe: Chrome's tabs take frames out of order, and each then decodes only its own.
        '-vf', [...after, 'format=yuv420p'].join(','), '-an', ...o.encode(width, height), '-g', '1', path], { signal: o.signal, timeout })
      const buf = await readFile(path)
      return { file: `assets/${served}/${name}.mp4`, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, path }
    }
    type Screen = Awaited<ReturnType<typeof plain>>
    type Pass = { name: string; screen: Screen; which: 'pointer' | 'none'; frames: number[]; ranges: typeof at.ranges }
    // Decoded one pass at a time (each FFmpeg run writes to disk, not to memory).
    let decoding: Promise<unknown> = Promise.resolve()
    const draw = async (p: Pass, tabs: number): Promise<string> => {
      const dir = join(work, p.name)
      await mkdir(dir, { recursive: true })
      const index = new Map(p.frames.map((f, k) => [f, k])), got = new Set<number>()
      await o.render(spriteProject(o.project, o.plan, o.states, p.screen, p.which), p.ranges, { concurrency: tabs,
        write: (f, png) => { const k = index.get(f); if (k === undefined) return; writeFileSync(join(dir, `${k}.png`), png); got.add(k) } })
      if (got.size !== p.frames.length) throw new Error("Chrome did not draw every one of the pointer's pictures")
      const raw = join(work, `${p.name}.rgb`)
      const decode = decoding.then(() => o.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'image2', '-framerate', String(SPRITE_FPS), '-start_number', '0', '-i', join(dir, '%d.png'),
        '-vf', win, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { signal: o.signal, timeout }))
      decoding = decode.catch(() => undefined)
      await decode
      await rm(dir, { recursive: true, force: true })
      const bytes = (await stat(raw)).size
      if (bytes !== p.frames.length * px * 3) throw new Error(`the pointer's ${p.name} pictures decoded to ${bytes} bytes, not ${p.frames.length * px * 3}`)
      return raw
    }
    const glass = o.plan.style === 'glass'
    const screens = await Promise.all([plain('black', 'black', []), plain('white', 'white', []),
      ...(glass ? [plain('checker', 'black', [`geq=lum='if(mod(X+Y\\,2)\\,235\\,16)':cb=128:cr=128`])] : [])])
    const passes: Pass[] = [
      { name: 'black', screen: screens[0]!, which: 'pointer', frames: at.frames, ranges: at.ranges },
      { name: 'white', screen: screens[1]!, which: 'pointer', frames: at.frames, ranges: at.ranges },
    ]
    let bareOnce = false
    if (glass) {
      const board = screens[2]!
      // One bare picture serves every state only when the made-up checkerboard's frames all decode alike (a lossy encoder
      // need not keep them so); else the bare board is drawn at the very frames the pass over it is.
      const hashes = hashLines(String(await o.run('ffmpeg', ['-nostdin', '-v', 'error', '-i', board.path, '-map', '0:v:0', '-f', 'framemd5', '-'], { signal: o.signal, timeout })))
      bareOnce = hashes.length > 0 && hashes.every((h) => h === hashes[0])
      passes.push({ name: 'checker', screen: board, which: 'pointer', frames: at.frames, ranges: at.ranges },
        { name: 'bare', screen: board, which: 'none', frames: bareOnce ? [0] : at.frames, ranges: bareOnce ? [{ from: 0, to: 0, every: 1 }] : at.ranges })
    }
    const schedule = spriteSchedule(o.tabs, passes.length)
    o.log?.(`Fast export: the pointer in ${passes.length} passes, ${schedule.atOnce} at a time in ${schedule.tabs} tab${schedule.tabs === 1 ? '' : 's'} each${glass ? `, the bare checkerboard ${bareOnce ? 'drawn once (its frames decode alike)' : 'drawn at every state'}` : ''}`)
    const raws = await inTurn(passes.map((p) => () => draw(p, schedule.tabs)), schedule.atOnce)
    // The sprites, state by state, from the decoded passes on disk.
    const files = await Promise.all(raws.map((f) => open(f, 'r')))
    try {
      const read = async (i: number, k: number) => {
        const b = Buffer.alloc(px * 3), { bytesRead } = await files[i]!.read(b, 0, b.length, k * b.length)
        if (bytesRead !== b.length) throw new Error("the pointer's pictures are cut short")
        return b
      }
      const bare0 = glass && bareOnce ? await read(3, 0) : null
      const sprites: Sprite[] = []
      for (let k = 0; k < o.states.length; k++) {
        const checker = glass ? { over: await read(2, k), bare: bare0 ?? await read(3, k), sigma: o.plan.size / 9 } : undefined
        sprites.push(matte(1, crop.w, crop.h, await read(0, k), await read(1, k), checker)[0]!)
      }
      if (glass) {
        const w = glassWeight(sprites, o.states, o.plan.size)
        if (!(w >= GLASS_WEIGHT.min && w <= GLASS_WEIGHT.max)) throw new Error(`the glass pointer's blur could not be measured (its weight came out ${Number.isFinite(w) ? w.toFixed(2) : 'empty'}, not about 0.8)`)
      }
      return sprites
    } finally {
      for (const f of files) await f.close().catch(() => undefined)
    }
  } finally {
    await unlinkDir(link).catch(() => undefined)
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** drawPointerStates with Remotion drawing the frames (renderFrames, PNG, in `common`'s browser): what the export and its proof use. */
export function chromePointerArt(o: {
  project: EditorProject; serveUrl: string; common: Record<string, unknown>; assetsDir: string; scratch: string; signal: AbortSignal
  /** Chrome tabs for all of the pointer's passes together: its own budget (jobs/export.ts, spriteTabs: the CPUs it may use, at most 8). */
  tabs: number
  encode: (width: number, height: number) => string[]
  run: ToolRun
  remotion: Pick<typeof import('@remotion/renderer'), 'renderFrames' | 'selectComposition'>
  inputProps: (project: EditorProject) => Record<string, unknown>; compositionId: string; cancelSignal?: unknown
  log?: (line: string) => void
}): (a: { plan: Pick<PointerPlan, 'size' | 'style'>; states: PointerState[] }) => Promise<Sprite[]> {
  return ({ plan, states }) => drawPointerStates({ project: o.project, plan, states, assetsDir: o.assetsDir, scratch: o.scratch, signal: o.signal, tabs: o.tabs, encode: o.encode, run: o.run, log: o.log,
    render: async (sprites, ranges, { concurrency, write }) => {
      const inputProps = o.inputProps(sprites)
      const composition = await o.remotion.selectComposition({ serveUrl: o.serveUrl, id: o.compositionId, inputProps, ...o.common })
      for (const r of ranges) {
        // Remotion counts its frames from the range's start: the frame it hands back is the range's own.
        // Remotion refuses more tabs than the cores it counts (a container's 4 on the server).
        await o.remotion.renderFrames({ serveUrl: o.serveUrl, composition, inputProps, ...o.common, imageFormat: 'png', everyNthFrame: r.every, frameRange: [r.from, r.to],
          concurrency: Math.max(1, Math.min(concurrency, availableParallelism())), outputDir: null, ...(o.cancelSignal ? { cancelSignal: o.cancelSignal } : {}), onFrameBuffer: (b: Buffer, f: number) => write(f, b),
          onStart: () => {}, onFrameUpdate: () => {} } as Parameters<typeof o.remotion.renderFrames>[0])
      }
    } })
}
