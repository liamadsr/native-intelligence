/**
 * The other ways a job's strings or files could reach a filter graph, another file, the network or the worker's own
 * environment: contact sheet labels, mastering numbers, an uploaded sound, earshot's and the analysis' own FFmpeg,
 * their environments, and the kept reference measurements. Made-up media made with FFmpeg's test sources.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { analysisEnv } from '../src/analysis.ts'
import { earshotEnv } from '../src/earshot.ts'
import { labelFilters, labelText, trimCheckRefs } from '../src/jobs/checks.ts'
import { uploadAsWav } from '../src/jobs/sound.ts'
import { loudnessTarget, secondPass } from '../src/master.ts'
import { probe } from '../src/media.ts'

const SECRETS = { STUDIO_WORKER_SECRET: 's', STUDIO_APP_URL: 'http://app', ELEVENLABS_API_KEY: 'k', DEEPGRAM_API_KEY: 'k', OPENAI_API_KEY: 'k' }

test('a contact sheet label is a file FFmpeg reads, never text in the filter graph', () => {
  const hostile = "x':text=y,drawtext=textfile=/etc/hosts[a];[a]null'\\\n%{pts}"
  const filters = labelFilters('/System/Library/Fonts/Supplemental/Arial.ttf', 'label-000.txt', 1280, 720)
  assert.equal(filters.length, 2)
  assert.ok(filters[1]!.endsWith(':expansion=none:textfile=label-000.txt'))
  assert.ok(!filters.join(',').includes('text='.concat("'")), 'no inline text')
  assert.throws(() => labelFilters('/fonts/a.ttf', '../x.txt', 10, 10))
  assert.throws(() => labelFilters("/fonts/a'.ttf", 'label-000.txt', 10, 10))
  const text = labelText(1.25, hostile)
  assert.ok(!/[\n\r]/.test(text) && text.length <= 90)
  assert.ok(text.startsWith('1.3s x'))
})

test('mastering writes only plain numbers into the filter graph', () => {
  assert.equal(loudnessTarget({ lufs: -14, truePeak: -1 }), 'I=-14:TP=-1.5:LRA=11')
  for (const master of [{ lufs: '-14:print_format=json,amovie=/etc/hosts' as never, truePeak: -1 }, { lufs: -14, truePeak: NaN }, { lufs: 5, truePeak: -1 }, {} as never]) assert.throws(() => loudnessTarget(master), JSON.stringify(master))
  const m = { input_i: '-20.1', input_tp: '-3.0', input_lra: '4.5', input_thresh: '-30.2', target_offset: '0.4' }
  assert.match(secondPass('I=-14:TP=-1.5:LRA=11', m), /^loudnorm=I=-14:TP=-1\.5:LRA=11:measured_I=-20\.1:/)
  assert.throws(() => secondPass('I=-14', { ...m, input_i: '-20,amovie=/etc/hosts' }))
})

test('an uploaded sound is decoded to a WAV first; a playlist or concat list is refused before FFmpeg reads what it names', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-upload-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const signal = new AbortController().signal
  const wav = join(dir, 'tone.wav')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-y', join(dir, 'tone.m4a')])
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-y', wav])
  const out = await uploadAsWav(join(dir, 'tone.m4a'), join(dir, 'upload.wav'), signal)
  const p = await probe(out)
  assert.equal(p.format.format_name, 'wav')
  assert.equal(p.streams[0]!.codec_name, 'pcm_f32le')
  // A playlist naming a local file (another workspace's cached sound, say), uploaded under any name.
  const playlist = join(dir, 'upload.bin')
  await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${wav}\n#EXT-X-ENDLIST\n`)
  await assert.rejects(uploadAsWav(playlist, join(dir, 'p.wav'), signal), /not a sound the Studio can read/)
  await writeFile(playlist, `ffconcat version 1.0\nfile '${wav}'\n`)
  await assert.rejects(uploadAsWav(playlist, join(dir, 'c.wav'), signal), /not a sound the Studio can read/)
  await writeFile(playlist, 'just words')
  await assert.rejects(uploadAsWav(playlist, join(dir, 'w.wav'), signal))
})

test('earshot’s and the analysis’ own FFmpeg calls open local files and pipes only; neither keeps a pickle', async () => {
  const py = (name: string) => readFile(resolve(import.meta.dirname, '../python', name), 'utf8')
  const bridge = await py('earshot_bridge.py'), analysis = await py('motion_analysis.py')
  for (const [name, source] of [['earshot_bridge.py', bridge], ['motion_analysis.py', analysis]] as const) {
    const calls = source.match(/\['ffmpeg'[^\]]*\]/g) ?? []
    assert.ok(calls.length > 0, name)
    for (const call of calls) assert.ok(/protocol_whitelist|FFMPEG_FENCE/.test(call), `${name}: ${call}`)
  }
  assert.ok(bridge.includes("FFMPEG_FENCE = ['-protocol_whitelist', 'file,pipe', '-format_whitelist'"))
  assert.ok(!/allow_pickle=True/.test(analysis) && /allow_pickle=False/.test(analysis))
  assert.ok(!/dtype=object/.test(analysis.slice(analysis.indexOf('def load_or_analyse'), analysis.indexOf('def watch('))))
})

test('earshot and the analysis run with a minimal environment', () => {
  const base = { PATH: '/usr/bin', HOME: '/h', TMPDIR: '/t', LANG: 'en_GB.UTF-8', ...SECRETS }
  const e = earshotEnv({ ...base, EARSHOT_THREADS: '2' })
  assert.deepEqual(Object.keys(e).sort(), ['EARSHOT_THREADS', 'HOME', 'LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TMPDIR'])
  assert.equal(e.EARSHOT_THREADS, '2')
  assert.ok(e.PATH!.split(':').includes('/opt/homebrew/bin'))
  const a = analysisEnv(base)
  assert.equal(a.OPENCV_FFMPEG_CAPTURE_OPTIONS, 'protocol_whitelist;file,pipe')
  for (const key of Object.keys(SECRETS)) assert.ok(!(key in a) && !(key in e), key)
})

test('kept reference measurements are trimmed by age, then by size, least recently used first', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'check-refs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now(), day = 86_400_000
  const make = async (mode: string, sha: string, bytes: number, ageDays: number) => {
    const dir = join(root, mode, sha)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'motion.json'), Buffer.alloc(bytes))
    const at = new Date(now - ageDays * day)
    await utimes(dir, at, at)
  }
  await make('watch', 'a'.repeat(32), 100, 40)
  await make('watch', 'b'.repeat(32), 600, 3)
  await make('review', 'c'.repeat(32), 600, 1)
  assert.equal(await trimCheckRefs(root, { maxAgeMs: 30 * day, maxBytes: 1000, now }), 2)
  assert.deepEqual(await readdir(join(root, 'watch')), [])
  assert.deepEqual(await readdir(join(root, 'review')), ['c'.repeat(32)])
})
