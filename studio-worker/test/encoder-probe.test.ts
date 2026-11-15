/**
 * Which encoder settings work on this computer (encoder-probe.ts), and the facts every local export's file is held to.
 * Real FFmpeg runs, a second of picture each.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFacts, probeEncoder } from '../src/encoder-probe.ts'
import { setTools } from '../src/platform.ts'

// STUDIO_FFMPEG / STUDIO_FFPROBE: the probe and the facts run on that FFmpeg (the desktop's own build).
setTools({ ffmpeg: process.env.STUDIO_FFMPEG, ffprobe: process.env.STUDIO_FFPROBE })

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv']
const LABEL = 'format=yuv420p,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv'

test('the facts of a file: frames at their times, duration, size, colour in the MP4 and in the stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'facts-'))
  const good = join(dir, 'good.mp4'), untagged = join(dir, 'untagged.mp4'), short = join(dir, 'short.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-vf', LABEL, '-c:v', 'libx264', '-preset', 'ultrafast', ...TAGS, good])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', untagged])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=0.5', '-vf', LABEL, '-c:v', 'libx264', '-preset', 'ultrafast', ...TAGS, short])
  const want = { frames: 30, fps: 30, width: 320, height: 240 }
  assert.equal(await exportFacts(good, want), null)
  assert.match((await exportFacts(untagged, want))!, /labelled/)
  assert.match((await exportFacts(short, want))!, /15 frames, not 30/)
  assert.match((await exportFacts(good, { ...want, width: 640 }))!, /320×240/)
})

test("this machine's encoder ladder: the first rung that makes a right file; none, and the computer cannot export", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'))
  if (process.platform === 'darwin') {
    const vt = await probeEncoder('videotoolbox', { width: 1280, height: 720, fps: 60 }, dir)
    assert.equal(vt.rung, 'quality', JSON.stringify(vt.tried))
    assert.ok(vt.tried[0]!.worstDb! >= 32)
  }
  // Media Foundation does not exist here (not Windows): every rung fails, and says why.
  const none = await probeEncoder('mf', { width: 640, height: 360, fps: 30 }, dir)
  if (process.platform !== 'win32') {
    assert.equal(none.rung, null)
    assert.deepEqual(none.tried.map((t) => t.rung), ['quality', 'bitrate', 'software'])
    assert.ok(none.tried.every((t) => !t.ok && t.why))
  }
  // x264: where the FFmpeg has it (a developer's, the server's); the desktop's LGPL build has not, and says so.
  const hasX264 = execFileSync(process.env.STUDIO_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx264')
  const x = await probeEncoder('x264', { width: 640, height: 360, fps: 30 }, dir)
  assert.equal(x.rung, hasX264 ? 'quality' : null)
})
