/**
 * Sound design's pure parts and the earshot bridge's protocol, against a fake
 * bridge (a small Python script standing in for earshot_bridge.py, run the
 * same way: `python -I script`, JSON in, JSON out). No earshot is needed here;
 * test/sound-e2e.ts runs the real one.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import { bridge, BridgeError, checkEarshot, EarshotWatch, parseBridgeAnswer, soundKindsFor } from '../src/earshot.ts'
import { bedArgs, placedFrom, stopDownTimes, type BridgeCue } from '../src/jobs/sound.ts'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'

const FAKE = `
import json, sys, time
req = json.load(sys.stdin)
cmd = req.get('cmd')
if cmd == 'presets':
    print('a warning line that is not JSON')
    print(json.dumps({'presets': {'launch': {'note': 'made up', 'roles': {'pop': {'sound': 'pop/round'}}}}}))
elif cmd == 'echo':
    print(json.dumps({'echo': req}))
elif cmd == 'fail':
    sys.stderr.write('Traceback (most recent call last):\\nValueError: made-up failure\\n')
    print(json.dumps({'error': 'ValueError: made-up failure'}))
    sys.exit(1)
elif cmd == 'crash':
    sys.stderr.write('line one\\nline two\\nSegmentation fault\\n')
    sys.exit(139)
elif cmd == 'sleep':
    time.sleep(30)
    print(json.dumps({'slept': True}))
else:
    print(json.dumps({'error': 'unknown cmd %r' % cmd}))
    sys.exit(1)
`

async function fakeBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'sound-bridge-'))
  const script = join(dir, 'fake_bridge.py')
  await writeFile(script, FAKE)
  return { dir, opts: { python: 'python3', script } }
}

test('the bridge answer is the last line of what it prints; a failure says why', () => {
  assert.deepEqual(parseBridgeAnswer(0, 'noise\n{"ok": 1}\n', ''), { ok: 1 })
  assert.throws(() => parseBridgeAnswer(1, '{"error": "KeyError: x"}', 'Traceback…'), /earshot: KeyError: x/)
  assert.throws(() => parseBridgeAnswer(0, '{"error": "bad"}', ''), /earshot: bad/)
  assert.throws(() => parseBridgeAnswer(139, '', 'a\nb\nc\nSegmentation fault'), /earshot: b c Segmentation fault/)
  assert.throws(() => parseBridgeAnswer(2, 'not json', ''), /exit 2/)
})

test('a request goes in as JSON and the answer comes back, through a fake bridge', async () => {
  const { dir, opts } = await fakeBridge()
  const answer = await bridge<{ echo: Record<string, unknown> }>(dir, { cmd: 'echo', cues: [{ id: 'auto:a:0', t: 1.25, kind: 'pop' }] }, opts)
  assert.deepEqual(answer.echo, { cmd: 'echo', cues: [{ id: 'auto:a:0', t: 1.25, kind: 'pop' }] })
  await assert.rejects(bridge(dir, { cmd: 'fail' }, opts), (e: Error) => e instanceof BridgeError && /made-up failure/.test(e.message))
  await assert.rejects(bridge(dir, { cmd: 'crash' }, opts), /Segmentation fault/)
  await assert.rejects(bridge(dir, { cmd: 'echo' }, { ...opts, python: join(dir, 'no-python-here') }), /Python is not at/)
})

test('a cancelled job stops the bridge, and so does its time limit', async () => {
  const { dir, opts } = await fakeBridge()
  const abort = new AbortController()
  const started = Date.now()
  setTimeout(() => abort.abort(), 200)
  await assert.rejects(bridge(dir, { cmd: 'sleep' }, { ...opts, signal: abort.signal }), /stopped: the job was cancelled/)
  await assert.rejects(bridge(dir, { cmd: 'sleep' }, { ...opts, timeout: 300 }), /stopped: timed out/)
  assert.ok(Date.now() - started < 10_000)
})

test('the capability holds while the presets answer', async () => {
  const { dir, opts } = await fakeBridge()
  assert.equal(await checkEarshot(dir, opts), true)
  assert.equal(await checkEarshot(null, opts), false)
  // A folder without earshot's Python is not checked at all.
  assert.equal(await checkEarshot(dir), false)
  const broken = { python: 'python3', script: join(dir, 'missing.py') }
  assert.equal(await checkEarshot(dir, broken), false)

  let answers = true
  const watch = new EarshotWatch('/made/up/earshot', async () => answers)
  assert.deepEqual(watch.capabilities(), [])
  await watch.refresh()
  assert.deepEqual(watch.capabilities(), ['sound'])
  answers = false
  await watch.refresh()
  assert.deepEqual(watch.capabilities(), [])
  const unset = new EarshotWatch(null, async () => true)
  await unset.start()
  assert.equal(unset.usable, false)
  unset.stop()
})

test('sound kinds are asked for only while earshot answers: the bank in the quick slot, the rest in the media slots', () => {
  const all = ['import', 'export', 'continuity', 'sounds', 'sound-import', 'listen', 'sound-bank'] as StudioJobKind[]
  const media = ['import', 'export', 'sounds', 'sound-import', 'listen', 'sound-bank'] as StudioJobKind[]
  assert.deepEqual(soundKindsFor('media', media, all, false), ['import', 'export'])
  assert.deepEqual(soundKindsFor('media', media, all, true), ['import', 'export', 'sounds', 'sound-import', 'listen'])
  assert.deepEqual(soundKindsFor('provider', ['continuity'], all, true), ['continuity', 'sound-bank'])
  assert.deepEqual(soundKindsFor('provider', ['continuity'], all, false), ['continuity'])
  // Not configured (STUDIO_WORKER_KINDS): never asked for.
  assert.deepEqual(soundKindsFor('media', ['export'], ['export'], true), ['export'])
})

const cue = (over: Partial<BridgeCue>): BridgeCue => ({ id: 'auto:x:0', file: '/scratch/sfx/000.wav', start_s: 1, trim_s: 0, dur_s: 0.4, sound: 'pop/round', role: 'pop', gain_db: -6, ...over })

test('the music steps down before each big moment, on the bed\'s own clock', () => {
  const rendered = [
    cue({ id: 'a', role: 'hit', start_s: 2.5, trim_s: 0 }),
    cue({ id: 'b', role: 'pop', start_s: 3 }),
    cue({ id: 'c', role: 'whoosh.long', start_s: 5.2, trim_s: 0.2 }),
    cue({ id: 'd', role: 'swell', start_s: 1.1 }), // 1.1 - 1 + 0 = 0.1: too early to duck
    cue({ id: 'e', role: 'hit', file: undefined, skipped: 'no sound' }),
    cue({ id: 'f', role: 'drop', start_s: 2.5 }), // the same moment as a: once
  ]
  assert.deepEqual(stopDownTimes(rendered, { atSeconds: 1, trimStartSeconds: 0 }), [1.5, 4])
  // A bed that starts 2 s into its file: the file's clock is ahead by 2 s.
  assert.deepEqual(stopDownTimes(rendered, { atSeconds: 1, trimStartSeconds: 2 }), [2.1, 3.5, 6])
})

test('the bed is the music segments trimmed, gained and delayed onto the timeline, mixed without normalising', () => {
  const asset = { id: 'm'.repeat(64), file: `assets/${'m'.repeat(64)}.mp3` } as EditorAsset
  const args = bedArgs([
    { path: '/cache/m.mp3', piece: { asset, atSeconds: 0.5, trimStartSeconds: 2, trimEndSeconds: 6, gain: 0.8 } },
    { path: '/cache/m.mp3', piece: { asset, atSeconds: 7, trimStartSeconds: 0, trimEndSeconds: 1.5, gain: 1 } },
  ], '/scratch/bed.wav')
  assert.deepEqual(args.slice(4, 12), ['-ss', '2.0000', '-t', '4.0000', '-i', '/cache/m.mp3', '-ss', '0.0000'])
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.equal(graph, '[0:a]volume=0.8000,adelay=500:all=1[m0];[1:a]volume=1.0000,adelay=7000:all=1[m1];[m0][m1]amix=inputs=2:normalize=0[out]')
  assert.deepEqual(args.slice(-5), ['-map', '[out]', '-ar', '48000', '/scratch/bed.wav'])
})

test('rendered cues become placed sounds with their labels; skipped ones and warnings become notes', () => {
  const asset = { id: 'a'.repeat(64) } as EditorAsset
  const rendered = [cue({ id: 'auto:t1:0', warnings: ['a bit late', null] }), cue({ id: 'auto:t2:0', file: undefined, skipped: "no sound for kind 'xyz' in preset launch" })]
  const { placed, notes } = placedFrom(rendered, [{ id: 'auto:t1:0', t: 1, kind: 'pop', label: 'text pops · Title' }], () => asset)
  assert.deepEqual(placed, [{ cueId: 'auto:t1:0', asset, startSeconds: 1, trimSeconds: 0, durationSeconds: 0.4, sound: 'pop/round', role: 'pop', gainDb: -6, label: 'text pops · Title' }])
  assert.deepEqual(notes, ['auto:t1:0: a bit late', "auto:t2:0: no sound for kind 'xyz' in preset launch"])
})
