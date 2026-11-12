/**
 * Judging and making sounds (src/jobs/sound-judge.ts) through the REAL bridge
 * (python/earshot_bridge.py) with a FAKE earshot: a small Python package that
 * answers like earshot's judge, forge, fit and doctor functions (and a stand-in
 * for soundfile), put in front of the bridge by a fake `.venv/bin/python`. So
 * the bridge's new commands run as they do on the worker: one process, JSON in
 * and out, offline flags set, files named by their names and never by a path,
 * failures as sentences. The handlers run against a stub of the app that keeps
 * what they store. No earshot is needed here: test/sound-e2e.ts runs the real one.
 * Skipped where python3 has no numpy (the bridge imports it).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { SoundJudgeInput, SoundMakeInput } from '../../web/src/lib/studio/server/sound-contract.ts'
import { fileSha256 } from '../src/app-client.ts'
import { buildAsset, inspectFile } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { doctorLine, earshotDoctor, EarshotWatch, SOUND_KINDS } from '../src/earshot.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { assetsOf, bridgeSources, forgeBudget, insideJob, plainName, runSoundJudge, runSoundMake } from '../src/jobs/sound-judge.ts'
import { run } from '../src/media.ts'

/** The python3 on the PATH when it has numpy (its full path: the bridge runs with a minimal PATH), else null. */
const PYTHON = (() => {
  try {
    return execFileSync('python3', ['-c', 'import numpy, sys; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
})()
const hasNumpy = !!PYTHON

/** The fake earshot: each function answers what the real one would, with the paths it was given (to check none leak). */
const FAKE_EARSHOT: Record<string, string> = {
  'earshot/__init__.py': '',
  'earshot/api.py': `
import os
OFF = lambda: os.environ.get('HF_HUB_OFFLINE') == '1' and os.environ.get('EARSHOT_OFFLINE') == '1'
def describe(path, start=None, end=None, top=8):
    return {'summary': '0.25 s short transient. Sounds most like: a cork pop (z +4.1).', 'measurements': {'duration': 0.25, 'peak_dbfs': -1.0, 'samples': [1, 2]},
            'top_tags': [{'term': 'a cork pop', 'category': 'foley', 'z': 4.1, 'cosine': 0.4}], 'character': ['bright'], 'audioset': [{'label': 'Plop', 'p': 0.44}]}
def match(path, query, alts=None, start=None, end=None):
    return {'summary': os.path.basename(path) + ': strong (z +3.5).', 'z': 3.56, 'verdict': 'strong', 'percentile': 99.4, 'p_vs_alts': None, 'closest_vocab': [{'term': 'a cork pop'}]}
def rank(paths, query, top=None):
    res = [{'path': p, 'name': os.path.basename(p), 'z': 4.0 - i, 'cosine': 0.3, 'verdict': 'strong' if i == 0 else 'weak', 'sounds_most_like': 'a pop (z +4.0)'} for i, p in enumerate(paths)]
    return {'summary': "Ranked %d files for '%s' (offline %s). Best: %s; read from %s." % (len(paths), query, OFF(), os.path.basename(paths[0]), paths[0]), 'results': res[:top] if top else res}
def find(path, query, top=5, **kw):
    return {'summary': 'Best moments in ' + os.path.basename(path), 'segments': [{'start': 0.1, 'end': 0.3, 'z': 3.1, 'verdict': 'strong', 'cut': ''}]}
def compare(path, refs, k=5, start=None, end=None):
    return {'summary': 'near ' + os.path.basename(refs[0]), 'nearest': [{'path': r, 'cosine': 0.7 - i / 10} for i, r in enumerate(refs)], 'typicality': {'z': 1.2, 'verdict': 'fits the set'}, 'features': {}}
def ab(a, b, query=None, refs=None, **kw):
    return {'summary': 'A = %s, B = %s.' % (os.path.basename(a), os.path.basename(b)), 'cosine_ab': 0.88, 'query': {'closer': 'b', 'a': {'z': 4.2}, 'b': {'z': 4.7}}, 'features': {'a': {}, 'b': {}}}
def realness(path, start=None, end=None, ast=False):
    return {'summary': 'real', 'p_real': 0.8, 'verdict': 'real or pro-produced', 'why': 'CLAP head'}
def realness_many(paths, ast=False, start=None, end=None):
    return {'summary': 'many', 'files': [{'path': p, 'p_real': 0.1, 'verdict': 'likely code-synthesized'} for p in paths]}
`,
  'earshot/features.py': `
def measure(src, music=False, start=None, end=None, light=False):
    return {'duration': 0.5, 'lufs': -14.2, 'true_peak_dbtp': -1.0, 'clipped_samples': 0, 'spectrum': [1, 2, 3]}
`,
  'earshot/mcp_server.py': `
def measure_summary(m):
    return '%.3f s, %s LUFS integrated.' % (m['duration'], m['lufs'])
`,
  'earshot/compare.py': `
def differences(fa, fb, limit=4):
    return ['loudness_lufs'], '2 dB quieter'
`,
  'earshot/doctor.py': `
def check(load=False, fetch_missing=False):
    print('a line earshot prints')
    return {'summary': 'Sound bank made-up-1: 3 sounds. earshot looks healthy.', 'problems': ['a model under /made/up/cache/hf/models is old'], 'notes': [],
            'models_cached': {'clap': True, 'ast': True}, 'bank': {'version': 'made-up-1'}, 'data_files': {'realness_model.json': True}}
`,
  'earshot/forge/__init__.py': `
import os, sys
RECIPES = ['pop', 'whoosh']
def recipes():
    return RECIPES
def forge(recipe, target=None, alts=None, budget=160, pop=16, keep=4, seed=0, out=None, log=print, outputs=True, bank=False, mode='auto', holdout=True, **kw):
    if target == 'offline please':
        raise OSError('We have no connection and HF_HUB_OFFLINE is set: cannot find the requested files in the local cache')
    import soundfile
    os.makedirs(out, exist_ok=True)
    picks = []
    for i in range(keep):
        f = os.path.join(out if target != 'outside' else os.path.dirname(out), '%s_%02d.wav' % (recipe, i + 1))
        soundfile.write(f, [0.1 * ((n * (i + 3)) % 7 - 3) / 3 for n in range(4800)], 48000)
        picks.append({'name': '%s_%02d' % (recipe, i + 1), 'file': f, 'score': {'total': 2.9 - i / 10, 'passes': False, 'match_z': 3.7, 'p_real': 0.96, 'sounds_like': ['a mouth pop'], 'summary': 'total 2.9 in ' + out}})
    log('gen 1/1: made up')
    return {'picks': picks, 'summary': "forge %s: '%s' (budget %d)" % (recipe, target, budget)}
`,
  'earshot/forge/bank.py': `
class BankError(Exception):
    pass
def render(sound, seed=None, checks=True, **kw):
    if not sound.startswith('pop/'):
        raise BankError('unknown sound id %r' % sound)
    return [0.2 * ((n % 40) - 20) / 20 for n in range(4800)], {}
def list_sounds(category=None, kind=None):
    return [{'id': 'pop/%d' % i, 'category': 'pop'} for i in range(3)] if category in (None, 'pop') else []
`,
  'earshot/forge/fit/__init__.py': `
import os, shutil
def run_fit(path, output=None, target=None, verbose=True, **kw):
    wav = os.path.splitext(output)[0] + '.wav'
    shutil.copyfile(path, wav)
    return {'kind': 'modal', 'chosen': 'modal', 'files': {'wav': wav}, 'quality': {'mel_db': 1.537, 'env_corr': 1.0, 'tone_db': 1.36, 'level_db': 0.02, 'onset_err': 0.23, 'len_s': (0.6, 0.6)}}
`,
  // soundfile's write, enough for the bridge: a mono 16-bit WAV.
  'soundfile.py': `
import wave, struct
def write(path, y, sr, subtype=None):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1.0, min(1.0, float(v))) * 32000)) for v in y))
`,
}

/** A fake earshot folder whose `.venv/bin/python` runs the real bridge with the fake package in front. */
async function fakeEarshot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-earshot-'))
  const pkg = join(dir, 'pkg')
  for (const [file, body] of Object.entries(FAKE_EARSHOT)) {
    await mkdir(join(pkg, file, '..'), { recursive: true })
    await writeFile(join(pkg, file), body.trimStart())
  }
  await mkdir(join(dir, '.venv', 'bin'), { recursive: true })
  const python = join(dir, '.venv', 'bin', 'python')
  // Called as `python -I <bridge>`: the bridge runs as __main__ with the fake package first on the path.
  await writeFile(python, `#!/bin/sh\nexec '${PYTHON}' -I -c 'import runpy, sys; sys.path.insert(0, sys.argv[1]); script = sys.argv[2]; sys.argv = [script]; runpy.run_path(script, run_name="__main__")' '${pkg}' "$2"\n`)
  await chmod(python, 0o755)
  return dir
}

/** A job context over a scratch folder, a cache, and a stub of the app that hands out `files` and keeps what is stored. */
async function jobContext<K extends 'sound-judge' | 'sound-make'>(kind: K, input: unknown, earshotDir: string, files: Map<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'sound-judge-job-'))
  const scratch = join(dir, 'scratch')
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const stored: { key: string; bytes: number }[] = []
  const logs: string[] = []
  const client = {
    readBlob: async (_job: string, key: string, dest: string) => {
      await copyFile(files.get(key)!, dest)
      return { bytes: (await stat(dest)).size, sha256: await fileSha256(dest), contentType: 'audio/wav' }
    },
    writeBlob: async (_job: string, key: string, file: string) => {
      stored.push({ key, bytes: (await stat(file)).size })
      return { bytes: (await stat(file)).size }
    },
  }
  const ctx = {
    job: { id: 'job-1', kind, workspaceId: 'ws', videoId: null, attempts: 1, input },
    config: { earshotDir },
    client,
    cache,
    renderer: {},
    scratch,
    signal: new AbortController().signal,
    progress: () => undefined,
    log: (line: string) => logs.push(line),
  } as unknown as JobContext<K>
  return { ctx, stored, logs, scratch }
}

/** A made-up library sound: a short tone, as the library would hold it. */
async function libraryTone(dir: string, name: string): Promise<{ asset: EditorAsset; file: string }> {
  const file = join(dir, `${name}.wav`)
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5', '-c:a', 'pcm_s16le', file])
  const { measured, waveform } = await inspectFile(file, `${name}.wav`)
  return { asset: buildAsset(measured, { sha256: await fileSha256(file), bytes: (await stat(file)).size }, { name: `${name}.wav`, waveform }), file }
}

test('the pure parts: sources in order, the search size, plain names, the doctor in one line', () => {
  const a = { id: 'a'.repeat(64), name: 'Made-up pop.wav' } as EditorAsset
  assert.deepEqual(assetsOf([{ asset: a }, { sound: 'pop/2' }, { asset: a }, undefined]), [a])
  assert.deepEqual(bridgeSources([{ asset: a }, { sound: 'pop/2' }], new Map([[a.id, '/scratch/heard/in-01.wav']])), [
    { path: '/scratch/heard/in-01.wav', name: 'Made-up pop.wav', assetId: a.id },
    { sound: 'pop/2', name: 'pop/2' },
  ])
  assert.throws(() => bridgeSources([{ asset: a }], new Map()), /was not decoded/)
  assert.equal(forgeBudget(1), 80)
  assert.equal(forgeBudget(4), 128)
  assert.equal(forgeBudget(9), 128)
  assert.equal(plainName('a soft / rounded "pop" for the logo'), 'a soft rounded pop for the logo')
  assert.equal(plainName('***'), 'Sound')
  assert.ok(SOUND_KINDS.includes('sound-judge') && SOUND_KINDS.includes('sound-make'))
  assert.match(doctorLine({ summary: 'healthy', modelsCached: false, problems: ['old model'] }), /NOT cached.*Problems: old model/)
  assert.equal(doctorLine(null), 'earshot doctor: no answer')
})

test('the doctor is asked once each time sound design comes on', async () => {
  let examined = 0
  let answers = true
  const watch = new EarshotWatch('/made/up/earshot', async () => answers, async () => {
    examined++
    return { summary: 'made-up healthy', modelsCached: true }
  })
  await watch.refresh()
  await watch.refresh()
  assert.equal(examined, 1)
  assert.equal(watch.doctor?.summary, 'made-up healthy')
  answers = false
  await watch.refresh()
  answers = true
  await watch.refresh()
  assert.equal(examined, 2)
})

test('the bridge answers the doctor short, offline and with no path', { skip: !hasNumpy && 'python3 has no numpy' }, async () => {
  const dir = await fakeEarshot()
  const d = await earshotDoctor(dir)
  assert.deepEqual(d, { summary: 'Sound bank made-up-1: 3 sounds. earshot looks healthy.', problems: ['a model under a file is old'], notes: [], modelsCached: true, bank: 'made-up-1', realness: true })
})

test('a judgement decodes library sounds, renders bank sounds, and answers compact with names, never paths', { skip: !hasNumpy && 'python3 has no numpy' }, async () => {
  const earshot = await fakeEarshot()
  const media = await mkdtemp(join(tmpdir(), 'sound-judge-media-'))
  const pop = await libraryTone(media, 'Made-up pop')
  const input: SoundJudgeInput = { action: 'rank', sounds: [{ asset: pop.asset }, { sound: 'pop/2' }], description: 'a soft rounded pop', top: 2 }
  const { ctx, logs, scratch } = await jobContext('sound-judge', input, earshot, new Map([[pop.asset.file, pop.file]]))
  const out = await runSoundJudge(ctx)
  assert.equal(out.action, 'rank')
  assert.match(out.summary, /Ranked 2 files for 'a soft rounded pop' \(offline True\)\. Best: Made-up pop\.wav; read from Made-up pop\.wav\./)
  assert.deepEqual(out.ranked, [
    { name: 'Made-up pop.wav', assetId: pop.asset.id, z: 4, cosine: 0.3, verdict: 'strong', soundsLike: 'a pop (z +4.0)' },
    { name: 'pop/2', sound: 'pop/2', z: 3, cosine: 0.3, verdict: 'weak', soundsLike: 'a pop (z +4.0)' },
  ])
  assert.ok(!JSON.stringify(out).includes(scratch), 'no worker path in the answer')
  assert.ok(logs.some((l) => /listening/.test(l)))

  const describe = await runSoundJudge((await jobContext('sound-judge', { action: 'describe', sounds: [{ sound: 'pop/1' }], description: 'a small bubble pop' } satisfies SoundJudgeInput, earshot, new Map())).ctx)
  assert.deepEqual(describe.measures, { seconds: 0.25, peakDb: -1 })
  assert.deepEqual(describe.tags, [{ term: 'a cork pop', category: 'foley', z: 4.1 }])
  assert.deepEqual(describe.match, { description: 'a small bubble pop', z: 3.56, verdict: 'strong', percentile: 99.4, soundsLike: ['a cork pop'] })
  assert.match(describe.summary, /pop\/1: strong/)

  const measured = await runSoundJudge((await jobContext('sound-judge', { action: 'measure', sounds: [{ sound: 'pop/1' }] } satisfies SoundJudgeInput, earshot, new Map())).ctx)
  assert.deepEqual(measured, { action: 'measure', summary: 'pop/1: 0.500 s, -14.2 LUFS integrated.', measures: { seconds: 0.5, lufs: -14.2, truePeakDb: -1, clippedSamples: 0 } })

  const bank = await runSoundJudge((await jobContext('sound-judge', { action: 'find', sounds: [], description: 'a pop', category: 'pop', top: 2 } satisfies SoundJudgeInput, earshot, new Map())).ctx)
  assert.deepEqual(bank.ranked?.map((r) => r.sound), ['pop/0', 'pop/1'])
  assert.match(bank.summary, /among 3 sounds/)

  const ab = await runSoundJudge((await jobContext('sound-judge', { action: 'ab', sounds: [{ sound: 'pop/1' }, { sound: 'pop/2' }], description: 'a pop' } satisfies SoundJudgeInput, earshot, new Map())).ctx)
  assert.deepEqual(ab.ab, { a: 'pop/1', b: 'pop/2', closer: 'b', zA: 4.2, zB: 4.7, cosine: 0.88 })
  assert.deepEqual(ab.differences, ['B against A: 2 dB quieter'])

  await assert.rejects(runSoundJudge((await jobContext('sound-judge', { action: 'measure', sounds: [{ sound: 'whoosh/x' }] } satisfies SoundJudgeInput, earshot, new Map())).ctx), /BankError: unknown sound id 'whoosh\/x'/)
  await rm(media, { recursive: true, force: true })
})

test('a forge stores its candidates as library sounds with their scores; a fit stores the recording made again', { skip: !hasNumpy && 'python3 has no numpy' }, async () => {
  const earshot = await fakeEarshot()
  const forged = await jobContext('sound-make', { mode: 'forge', recipe: 'pop', description: 'a soft rounded pop', count: 2 } satisfies SoundMakeInput, earshot, new Map())
  const made = await runSoundMake(forged.ctx)
  assert.equal(made.made.length, 2)
  assert.deepEqual(made.made.map((m) => m.name), ['a soft rounded pop · pop 1.wav', 'a soft rounded pop · pop 2.wav'])
  for (const m of made.made) {
    assert.equal(m.asset.kind, 'audio')
    assert.equal(m.asset.id, m.asset.sha256)
    assert.equal(m.asset.file, `assets/${m.asset.sha256}.wav`)
    assert.deepEqual((m.asset.provenance as { made?: string; recipe?: string }).made, 'forge')
    assert.ok(forged.stored.some((s) => s.key === m.asset.file), 'stored under its bytes')
  }
  assert.deepEqual(made.made[0]!.score, { total: 2.9, passes: false, matchZ: 3.7, pReal: 0.96, soundsLike: ['a mouth pop'], words: 'total 2.9 in a file' })
  assert.match(made.summary, /forge pop: 'a soft rounded pop' \(budget 96\)/)

  const media = await mkdtemp(join(tmpdir(), 'sound-fit-media-'))
  const knock = await libraryTone(media, 'Made-up knock')
  const fitted = await jobContext('sound-make', { mode: 'fit', asset: knock.asset } satisfies SoundMakeInput, earshot, new Map([[knock.asset.file, knock.file]]))
  const fit = await runSoundMake(fitted.ctx)
  assert.equal(fit.mode, 'fit')
  assert.equal(fit.made[0]!.name, 'Made-up knock · fitted.wav')
  assert.deepEqual(fit.made[0]!.quality, { melDb: 1.54, envCorr: 1, toneDb: 1.36, levelDb: 0.02, onsetErr: 0.23, seconds: [0.6, 0.6], fitKind: 'modal' })
  assert.equal((fit.made[0]!.asset.provenance as { fittedFrom?: string }).fittedFrom, knock.asset.id)

  // A model missing from earshot's cache is a sentence, never a download; a file outside the job is refused.
  const offline = await jobContext('sound-make', { mode: 'forge', recipe: 'pop', description: 'offline please', count: 1 } satisfies SoundMakeInput, earshot, new Map())
  await assert.rejects(runSoundMake(offline.ctx), /listening models are not on the worker .*nothing was downloaded/)
  const outside = await jobContext('sound-make', { mode: 'forge', recipe: 'pop', description: 'outside', count: 1 } satisfies SoundMakeInput, earshot, new Map())
  await assert.rejects(runSoundMake(outside.ctx), /a file outside the job/)
  const unknown = await jobContext('sound-make', { mode: 'forge', recipe: 'banjo', description: 'a banjo', count: 1 } satisfies SoundMakeInput, earshot, new Map())
  await assert.rejects(runSoundMake(unknown.ctx), /earshot has no recipe 'banjo' \(it has pop, whoosh\)/)
  await rm(media, { recursive: true, force: true })
})

test('a file earshot answers is inside the job only when it resolves there', () => {
  const out = join(tmpdir(), 'job-1', 'forge')
  assert.equal(insideJob(out, join(out, 'pop-1.wav')), true)
  assert.equal(insideJob(out, join(out, 'sub', 'pop-1.wav')), true)
  assert.equal(insideJob(out, join(out, '..', '..', 'secrets.wav')), false)
  assert.equal(insideJob(out, `${out}-other/pop.wav`), false)
  assert.equal(insideJob(out, out), false)
  assert.equal(insideJob(out, '/etc/hosts'), false)
  assert.equal(insideJob(out, undefined), false)
})
