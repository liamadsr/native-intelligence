/**
 * The fast export's encoder profiles (encoders.ts): the server's stays exactly what it was, every profile labels its
 * file alike. (What each lossy profile makes, against the lossless one: test/encoder-check.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLOUR_TAGS, defaultProfile, encoderArgs, mfBitrate, VIDEOTOOLBOX_QUALITY } from '../src/encoders.ts'
import { FAST_ENCODER } from '../src/fast-export.ts'

test("the server's profile is the Chrome path's encoder, as before", () => {
  assert.deepEqual(FAST_ENCODER, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv'])
  assert.deepEqual(encoderArgs('x264', 2504, 1438, 60), FAST_ENCODER)
})

test('every profile writes the same labels; each its own encoder and quality', () => {
  for (const p of ['x264', 'videotoolbox', 'mf', 'lossless'] as const) {
    const args = encoderArgs(p, 2504, 1438, 60)
    assert.deepEqual(args.slice(-COLOUR_TAGS.length), COLOUR_TAGS, p)
  }
  const vt = encoderArgs('videotoolbox', 2504, 1438, 60)
  assert.deepEqual(vt.slice(0, 4), ['-c:v', 'h264_videotoolbox', '-q:v', String(VIDEOTOOLBOX_QUALITY)])
  assert.ok(vt.includes('-allow_sw') && vt[vt.indexOf('-allow_sw') + 1] === '0', 'the hardware encoder or nothing (a software one would be slow and unmeasured)')
  assert.deepEqual(encoderArgs('lossless', 640, 360, 30).slice(0, 6), ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0'])
  const mf = encoderArgs('mf', 1920, 1080, 30)
  assert.deepEqual(mf.slice(0, 6), ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '70'])
  assert.equal(mf[mf.indexOf('-g') + 1], '60', 'a keyframe every 2 s')
  // The ladder: a bitrate where the quality mode is refused, the software encoder last; High profile, no B-frames on every rung.
  const mfBitrateRung = encoderArgs('mf', 1920, 1080, 30, 'bitrate'), mfSoftware = encoderArgs('mf', 1920, 1080, 30, 'software')
  assert.equal(mfBitrateRung[mfBitrateRung.indexOf('-b:v') + 1], String(mfBitrate(1920, 1080, 30)))
  assert.equal(mfSoftware[mfSoftware.indexOf('-hw_encoding') + 1], '0')
  const vtBitrate = encoderArgs('videotoolbox', 1920, 1080, 30, 'bitrate'), vtSoftware = encoderArgs('videotoolbox', 1920, 1080, 30, 'software')
  assert.ok(!vtBitrate.includes('-q:v') && vtBitrate.includes('-b:v'), 'Intel Macs refuse the quality mode')
  assert.ok(vtSoftware.includes('-require_sw'))
  for (const a of [mf, mfBitrateRung, mfSoftware, vt, vtBitrate, vtSoftware]) {
    assert.equal(a[a.indexOf('-profile:v') + 1], 'high')
    assert.equal(a[a.indexOf('-bf') + 1], '0')
  }
})

test('a bitrate from pixels and rate, never under 4 Mb/s; the profile by machine', () => {
  assert.equal(mfBitrate(2504, 1438, 60), Math.round(2504 * 1438 * 60 * 0.04))
  assert.equal(mfBitrate(640, 360, 30), 4_000_000)
  assert.equal(defaultProfile('darwin'), 'videotoolbox')
  assert.equal(defaultProfile('win32'), 'mf')
  assert.equal(defaultProfile('linux'), 'x264')
})

test("the run-time check's floor follows the encoder", async () => {
  const { checkFloor } = await import('../src/encoders.ts')
  assert.deepEqual(checkFloor('x264'), { frame: 34, bubble: 25 })
  assert.deepEqual(checkFloor('videotoolbox'), { frame: 30, bubble: 25 })
})

test("the Chrome path's pipe labels its picture as every export, without the JPEGs' ICC profile", async () => {
  const { pipeArgs } = await import('../src/chrome-pipe.ts')
  const args = pipeArgs(60, encoderArgs('videotoolbox', 1280, 720, 60), '/tmp/p.mp4')
  const vf = args[args.indexOf('-vf') + 1]!
  assert.match(vf, /^scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,sidedata=mode=delete:type=ICC_PROFILE,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv$/)
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'image2pipe'])
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0')
})
