/**
 * The largest graphs the fast export's pointer may write, run through an FFmpeg, with tiny made-up inputs: a clip whose
 * pointer window takes a new place on every frame for POINTER_LIMITS.places frames (the plan's bound), the glass (its
 * blur and weights), the touched mask, the overlay's `enable`, a tap of every frame, and a check tap and a frame-hash
 * select of many sampled frames. FFmpeg refuses an expression deeper than 100 (libavutil/eval.c, MAX_DEPTH: 7.1.5,
 * Debian's 5.1.9; "Cannot allocate memory"); the window's per-frame places are balanced trees and the selects balanced
 * sums, so their depth grows with the logarithm of their size: this proves it on the FFmpeg at hand.
 *
 *   STUDIO_FFMPEG=/usr/bin/ffmpeg node --import tsx test/ffmpeg-limits.ts        (in the worker's image)
 *   STUDIO_FFMPEG=<…/ffmpeg-bin/ffmpeg> node --import tsx test/ffmpeg-limits.ts   (the desktop's build)
 *
 * Prints one line a graph and exits 1 if FFmpeg refuses any, or a tap is not exactly its frames. Also says whether this
 * FFmpeg has the depth limit at all (an unbalanced sum of 120 terms, expected to be refused where it does).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashTaps, selectFrames, tapSelect } from '../src/fast-export.ts'
import { lookup, png, pointerFilters, POINTER_LIMITS } from '../src/fast-pointer.ts'
import { concatLine } from '../src/platform.ts'

const ffmpeg = process.env.STUDIO_FFMPEG || 'ffmpeg'

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-limits-'))
  let failed = 0
  const say = (o: Record<string, unknown>) => console.log(`[ffmpeg-limits] ${JSON.stringify(o)}`)
  try {
    say({ ffmpeg, version: execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0] })
    // Does this FFmpeg limit the depth? (informational)
    const flat = Array.from({ length: 120 }, (_, i) => `eq(n\\,${i})`).join('+')
    const probe = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=60:d=0.1', '-vf', `select='${flat}'`, '-f', 'null', '-'], { encoding: 'utf8' })
    say({ graph: 'an unbalanced sum of 120 terms (not written by the export)', refused: probe.status !== 0, note: probe.status !== 0 ? 'this FFmpeg limits expression depth' : 'no depth limit here' })

    const W = 320, H = 240, fps = 60, cw = 64, ch = 64
    for (const frames of [1000, POINTER_LIMITS.places]) {
      const sub = join(dir, String(frames))
      await mkdir(sub, { recursive: true })
      // The window takes a new place on every frame (each a run of its own in the lookup trees).
      const cx = Array.from({ length: frames }, (_, l) => 2 * (l % 128)), cy = Array.from({ length: frames }, (_, l) => 2 * (Math.floor(l / 128) % 88))
      const shown = Array.from({ length: frames }, (_, l) => l % 7 !== 3)
      const rgba = Buffer.alloc(cw * ch * 4), mask = Buffer.alloc(cw * ch), blur = Buffer.alloc(cw * ch, 200)
      for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) { rgba.set([255, 255, 255, 180], (y * cw + x) * 4); mask[y * cw + x] = 255 }
      await writeFile(join(sub, 's.png'), png(cw, ch, rgba, 4)); await writeFile(join(sub, 'm.png'), png(cw, ch, mask, 1)); await writeFile(join(sub, 'b.png'), png(cw, ch, blur, 1))
      const list = async (name: string, file: string) => { const f = join(sub, name); await writeFile(f, Array(frames).fill(concatLine(join(sub, file))).join('\n') + '\n'); return f }
      const sprites = await list('s.txt', 's.png'), masks = await list('m.txt', 'm.png'), blurs = await list('b.txt', 'b.png')
      const layer = { cw, ch, cx, cy, shown, sigma: 4 }
      // Check taps of many sampled frames (more than the export samples), as segmentArgs writes them.
      const sampled = Array.from({ length: 250 }, (_, k) => Math.floor((k * frames) / 250))
      const at = `round(t*${fps})`
      const graph = [
        `[0:v]format=yuv420p,settb=1/${fps},setpts=N,split[in][hin]`,
        `[hin]${selectFrames(sampled)}[hash]`,
        ...pointerFilters('ptr', 'in', 'drawn', 1, 2, 3, layer, fps),
        `[drawn]split=3[out][tapin][alltapin]`,
        `[tapin]${tapSelect(sampled, frames)}crop=w=${cw}:h=${ch}:x='${lookup(cx, at)}':y='${lookup(cy, at)}',format=yuv420p[tap]`,
        `[alltapin]${tapSelect(Array.from({ length: frames }, (_, l) => l), frames)}crop=w=${cw}:h=${ch}:x='${lookup(cx, at)}':y='${lookup(cy, at)}',format=yuv420p[alltap]`,
      ].join(';')
      const script = join(sub, 'graph.txt')
      await writeFile(script, graph)
      const tapFile = join(sub, 'tap.yuv'), allFile = join(sub, 'all.yuv'), hashFile = join(sub, 'hash.md5')
      const t0 = Date.now()
      const r = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x6080a0:s=${W}x${H}:r=${fps}:d=${frames / fps}`,
        '-f', 'concat', '-safe', '0', '-i', sprites, '-f', 'concat', '-safe', '0', '-i', masks, '-f', 'concat', '-safe', '0', '-i', blurs,
        '-filter_complex_script', script, '-map', '[out]', '-frames:v', String(frames), '-f', 'null', '-',
        '-map', '[tap]', '-fps_mode', 'passthrough', '-f', 'rawvideo', tapFile, '-map', '[alltap]', '-fps_mode', 'passthrough', '-f', 'rawvideo', allFile,
        '-map', '[hash]', '-fps_mode', 'passthrough', '-f', 'framemd5', hashFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const size = cw * ch * 1.5
      const got = r.status === 0 ? { tap: (await stat(tapFile)).size / size, all: (await stat(allFile)).size / size } : null
      const want = { tap: hashTaps(sampled, frames).length, all: frames }
      const ok = r.status === 0 && got!.tap === want.tap && got!.all === want.all
      if (!ok) failed++
      say({ graph: `the pointer, the glass, ${frames} places a clip, its taps and a ${sampled.length}-frame select`, graphBytes: graph.length, ok, seconds: +((Date.now() - t0) / 1000).toFixed(1),
        tapFrames: got, wanted: want, ...(r.status !== 0 ? { error: r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 600) } : {}) })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  console.log(failed ? `[ffmpeg-limits] ${failed} graph(s) REFUSED` : '[ffmpeg-limits] every graph ran')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[ffmpeg-limits] FAILED:', err)
  process.exit(1)
})
