/**
 * The pointer drawn from Chrome's own sprites against Chrome drawing it: a made-up recording with its pointer (arrow or
 * glass, click feedback on), some frames drawn by Chrome with the pointer and without it; the pointer's states drawn
 * by Chrome in the made-up sprite video (fast-pointer.ts) and laid, here in JS, over the frames without it; then each
 * window compared with Chrome's frame with it (PSNR, RGB). Also the same sprite a pixel off and a frame late, which must
 * score lower. A probe for fast-pointer.ts, not a gate.
 *
 *   node --import tsx test/pointer-probe.ts [arrow|glass] [width] [frames,…]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { loadConfig } from '../src/config.ts'
import { Renderer, inputPropsFor, COMPOSITION_ID } from '../src/render.ts'
import { chromePointerArt, clipPointer, spriteCrop, stateKey, type PointerState } from '../src/fast-pointer.ts'
import { runBuffer } from '../src/media.ts'
import { madeUpTrace } from './pointer-fixtures.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

async function cached(cache: string, file: string) {
  const buf = await readFile(file)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  await rename(file, join(cache, `${sha256}.mp4`))
  return { file: `assets/${sha256}.mp4`, sha256, bytes: buf.length }
}
/** PNGs (in order) as raw RGB, cropped. */
function raw(pngs: Buffer[], crop: string | null): Buffer {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0', ...(crop ? ['-vf', crop] : []), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input: Buffer.concat(pngs), maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return r.stdout
}
const psnr = (a: Float64Array | Buffer, b: Float64Array | Buffer) => { let e = 0; for (let i = 0; i < a.length; i++) e += (a[i]! - b[i]!) ** 2; e /= a.length; return e === 0 ? 99 : 10 * Math.log10(255 ** 2 / e) }

/**
 * `tip` mode: how Chrome places a tip just left of (or above) the frame, a negative CSS length. Each x is drawn as the
 * whole composition (the pointer partly outside the frame), and the values whose pictures are the same to the bit are
 * grouped: whether Chrome takes -0.068 px as -0.0625 (its 1/64 unit, toward zero) or as -0.125 (floored to 1/16 as
 * drawnState does) decides which picture the export must lay there.
 *
 *   node --import tsx test/pointer-probe.ts tip
 */
async function tipProbe() {
  const W = 320, H = 240, FPS = 60, S = 1
  const dir = await mkdtemp(join(tmpdir(), 'studio-pointer-tip-'))
  const cache = join(dir, 'cache', 'assets'), media = join(dir, 'media')
  await mkdir(cache, { recursive: true }); await mkdir(media)
  ff(['-f', 'lavfi', '-i', `color=c=0x23232b:s=${W}x${H}:r=${FPS}:d=${S}`, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', join(media, 's.mp4')])
  const s = await cached(cache, join(media, 's.mp4'))
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), NODE_ENV: 'test', STUDIO_COMPOSITOR: 'off' }, () => 4)
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const renderer = new Renderer(loaded, cache)
  const { serveUrl } = await renderer.bundle(() => {})
  const { selectComposition, renderStill } = await import('@remotion/renderer')
  const at = (x: number, y: number, style: 'arrow' | 'glass') => parseEditorProject({ schemaVersion: 4, id: 'tip', title: 'Tip', output: { width: W, height: H, fps: FPS },
    assets: [{ id: 's', kind: 'video', name: 'Screen.mp4', ...s, width: W, height: H, sourceFps: FPS, sourceFrames: FPS * S, durationSeconds: S, hasAudio: false, sourceCursorHidden: true,
      trace: { viewport: { width: W / 2, height: H / 2, scale: 2 }, cursor: [[0, x / 2, y / 2]], actions: [] } }],
    clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 0, trimEndSourceFrame: FPS * S, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(),
      playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: false } }],
    presentation: structuredClone(defaultPresentation), cursor: { style, size: 18, clickFeedback: false },
    transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, audioTracks: [], presenterTrack: null }) as EditorProject
  const common = await renderer.common(() => {}, at(1, 1, 'arrow'))
  const hashOf = async (p: EditorProject, name: string) => {
    const inputProps = inputPropsFor(p), comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
    const out = join(dir, `${name}.png`)
    await renderStill({ serveUrl, composition: comp, inputProps, ...common, frame: 0, output: out, imageFormat: 'png' })
    return createHash('md5').update(raw([await readFile(out)], null)).digest('hex').slice(0, 10)
  }
  // Values around the sixteenths just left of 0 (and, for the same picture's place, just right of a whole pixel).
  const xs = [-0.0625, -0.068, -0.1, -0.125, -0.13, -0.19, -0.1875, -0.25, 0.0625, 0.125, 0.25, 0.5, 3]
  for (const style of ['arrow', 'glass'] as const) for (const axis of ['x', 'y'] as const) {
    const groups = new Map<string, number[]>()
    for (const v of xs) {
      const h = await hashOf(axis === 'x' ? at(v, 120, style) : at(160, v, style), `${style}-${axis}-${v}`)
      groups.set(h, [...(groups.get(h) ?? []), v])
    }
    console.log(`[tip] ${style} ${axis}: ${[...groups.values()].map((g) => `{${g.join(', ')}}`).join(' ')}`)
  }
  await rm(dir, { recursive: true, force: true })
}

async function main() {
  if (process.argv[2] === 'tip') return tipProbe()
  const style = (process.argv[2] ?? 'arrow') as 'arrow' | 'glass'
  const W = Number(process.argv[3] ?? 1280), H = Math.round(W * 2266 / 3472 / 2) * 2, FPS = 60, S = 4
  const dir = await mkdtemp(join(tmpdir(), 'studio-pointer-probe-'))
  const cache = join(dir, 'cache', 'assets'), media = join(dir, 'media')
  await mkdir(cache, { recursive: true }); await mkdir(media)
  ff(['-f', 'lavfi', '-i', `color=c=0xf2f3f6:s=${W}x${H}:r=${FPS}:d=${S}`, '-f', 'lavfi', '-i', `testsrc2=s=${W / 2}x${H / 2}:r=${FPS}:d=${S}`, '-filter_complex',
    `[0:v]drawbox=x=0:y=0:w=${Math.round(W * 0.14)}:h=${H}:color=0x23232b:t=fill[bg];[bg][1:v]overlay=x=${Math.round(W * 0.3)}:y=${Math.round(H * 0.3)},format=yuv420p[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', String(FPS), join(media, 's.mp4')])
  const s = await cached(cache, join(media, 's.mp4'))
  const frames = S * FPS
  const project = (pointer: boolean) => parseEditorProject({ schemaVersion: 4, id: 'probe', title: 'Probe', output: { width: W, height: H, fps: FPS },
    assets: [{ id: 's', kind: 'video', name: 'Screen.mp4', ...s, width: W, height: H, sourceFps: FPS, sourceFrames: frames, durationSeconds: S, hasAudio: false, sourceCursorHidden: true, trace: madeUpTrace(S, { width: W / 2, height: H / 2, scale: 2 }) }],
    clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 0, trimEndSourceFrame: frames, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(),
      playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: false } }],
    presentation: structuredClone(defaultPresentation), cursor: { style: pointer ? style : 'none', size: 18, clickFeedback: true },
    transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, audioTracks: [], presenterTrack: null }) as EditorProject
  const real = project(true), bare = project(false)
  const plan = clipPointer(real, real.clips[0]!, real.assets[0]!, frames)!
  // Frames: some moving, some in a click's press and ring (clicks at 650 ms + 1300 k).
  const picks = process.argv[4] ? process.argv[4].split(',').map(Number) : [20, 41, 42, 45, 50, 120, 121, 200]
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), NODE_ENV: 'test', STUDIO_COMPOSITOR: 'off' }, () => 4)
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const renderer = new Renderer(loaded, cache)
  const { serveUrl } = await renderer.bundle(() => {})
  const { selectComposition, renderStill, renderFrames } = await import('@remotion/renderer')
  const common = await renderer.common(() => {}, real)
  const still = async (p: EditorProject, frame: number) => {
    const inputProps = inputPropsFor(p), comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
    const out = join(dir, `still-${p.cursor.style}-${frame}.png`)
    await renderStill({ serveUrl, composition: comp, inputProps, ...common, frame, output: out, imageFormat: 'png' })
    return readFile(out)
  }
  const states = picks.map((f) => plan.states[f]!)
  // The made-up sprite videos: the states, the frames before them (a frame late), over black, white, the checkerboard.
  // STEPS: the sprites drawn with the tip's place inside its pixel rounded to 1/STEPS (0: exact).
  const steps = Number(process.env.STEPS ?? 0)
  const fl = process.env.ROUND === 'floor'
  const q = (s: PointerState): PointerState => steps && fl ? { ...s, x: Math.floor(s.x * steps) / steps, y: Math.floor(s.y * steps) / steps } : steps ? { ...s, x: Math.floor(s.x) + Math.min(steps - 1, Math.round((s.x - Math.floor(s.x)) * steps)) / steps, y: Math.floor(s.y) + Math.min(steps - 1, Math.round((s.y - Math.floor(s.y)) * steps)) / steps } : s
  const all: PointerState[] = [...states, ...picks.map((f) => plan.states[f - 1]!)].map(q)
  const crop = spriteCrop(plan.size)
  const win = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`
  // The sprites as the export draws them (fast-pointer.ts chromePointerArt), the plain pictures encoded nearly losslessly.
  const art = chromePointerArt({ project: real, serveUrl, common, assetsDir: cache, scratch: dir, signal: new AbortController().signal, tabs: 3,
    encode: () => ['-c:v', 'libx264', '-preset', 'slow', '-crf', '1', '-g', '60'], run: (file, args, o) => runBuffer(file, args, { signal: o.signal, input: o.input, maxBuffer: 1 << 30 }),
    remotion: { renderFrames, selectComposition }, inputProps: (p) => inputPropsFor(p), compositionId: COMPOSITION_ID })
  const px = crop.w * crop.h * 3
  const sprites = await art({ plan, states: all })
  // Over a frame without the pointer: bg (1 − α) + colour, and for the glass + k (blur(bg) − bg), the blur Gaussian (CSS blur(r): σ = r).
  const sigma = plan.size / 9
  /** The frame `bg` with the sprite laid on it, as a whole frame (floats). */
  const lay = (bg: Buffer, sprite: (typeof sprites)[number], s: PointerState, dx = 0): Float64Array => {
    const ox = Math.floor(s.x) - crop.tipX + dx, oy = Math.floor(s.y) - crop.tipY
    const full = Float64Array.from(bg)
    const at = (x: number, y: number, c: number) => bg[((Math.max(0, Math.min(H - 1, y))) * W + Math.max(0, Math.min(W - 1, x))) * 3 + c]!
    const r = Math.ceil(sigma * 3), kern = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
    const ks = kern.reduce((a, b) => a + b, 0)
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
      const X = ox + x, Y = oy + y
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      const i = y * crop.w + x, a = sprite.rgba[i * 4 + 3]! / 255, k = sprite.blur ? sprite.blur[i]! / 255 : 0
      for (let c = 0; c < 3; c++) {
        const b0 = at(X, Y, c)
        let blurred = b0
        if (k > 0) { let v = 0; for (let j = 0; j <= 2 * r; j++) { let row = 0; for (let q = 0; q <= 2 * r; q++) row += kern[q]! * at(X + q - r, Y + j - r, c); v += kern[j]! * row } blurred = v / ks / ks }
        full[(Y * W + X) * 3 + c] = Math.round((b0 + k * (blurred - b0)) * (1 - a) + a * sprite.rgba[i * 4 + c]!)
      }
    }
    return full
  }
  /** The window of state `s` out of a whole frame. */
  const cut = (img: ArrayLike<number>, s: PointerState) => {
    const ox = Math.floor(s.x) - crop.tipX, oy = Math.floor(s.y) - crop.tipY, out = new Float64Array(px)
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) for (let c = 0; c < 3; c++) {
      const X = Math.max(0, Math.min(W - 1, ox + x)), Y = Math.max(0, Math.min(H - 1, oy + y))
      out[(y * crop.w + x) * 3 + c] = img[(Y * W + X) * 3 + c]!
    }
    return out
  }
  console.log(`[pointer-probe] ${JSON.stringify({ style, size: W, H, pointerPx: +plan.size.toFixed(3), window: [crop.w, crop.h], states: all.length })}`)
  for (const [k, f] of picks.entries()) {
    const withP = raw([await still(real, f)], null), without = raw([await still(bare, f)], null)
    const s = states[k]!
    const chrome = cut(withP, s)
    const ours = cut(lay(without, sprites[k]!, s), s), off = cut(lay(without, sprites[k]!, s, 1), s), late = cut(lay(without, sprites[states.length + k]!, plan.states[f - 1]!), s)
    console.log(`[pointer-probe] ${JSON.stringify({ frame: f, x: +s.x.toFixed(3), y: +s.y.toFixed(3), press: +s.press.toFixed(3), ring: s.ring === null ? null : +s.ring.toFixed(3), key: stateKey(s),
      ourDb: +psnr(ours, chrome).toFixed(2), withoutPointerDb: +psnr(cut(without, s), chrome).toFixed(2), onePxOffDb: +psnr(off, chrome).toFixed(2), frameLateDb: +psnr(late, chrome).toFixed(2) })}`)
  }
  await rm(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((err) => { console.error('[pointer-probe] FAILED:', err); process.exit(1) })
