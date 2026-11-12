/**
 * End to end for sound design: the jobs' own handlers (src/jobs/sound.ts)
 * against a fake app (./fake-app.ts) that speaks the job contract, with the
 * REAL earshot (STUDIO_EARSHOT_DIR: an installed earshot with its `.venv`),
 * FFmpeg, Remotion and Chrome. Made-up material only: a plain 4 s picture, a
 * synthetic music bed, a synthetic click.
 *
 *   1. sound-bank: the bank and the presets.
 *   2. sounds: the automatic pass over a project with two text entrances (a pop
 *      and a drop) and a zoom-punch transition, levelled against the bed: one
 *      library WAV per cue, and the bed stepped down before the hit. Each take's
 *      sync point (its onset, or its peak for a whoosh) is measured from the
 *      stored file and checked against its cue's time.
 *   3. sound-import: the click placed on its onset at 3.5 s.
 *   4. listen: the project with the sounds applied (as the app applies them),
 *      rendered as sound only and heard: the scorecard, the transcript, and the
 *      sheet image (copied to the output folder for a look).
 *
 *   STUDIO_EARSHOT_DIR=<earshot folder> node --import tsx test/sound-e2e.ts
 *
 * STUDIO_CHROME names a headless shell; outputs go to STUDIO_SOUND_OUT (default
 * <tmp>/studio-sound-e2e). One heavy run at a time: it renders and loads models.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EditorAsset, EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import type { SoundBankResult, SoundImportResult, SoundsInput, SoundsResult, ListenResult } from '../../web/src/lib/studio/server/sound-contract.ts'
import { AppClient, fileSha256 } from '../src/app-client.ts'
import { buildAsset, inspectFile } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { checkEarshot } from '../src/earshot.ts'
import { defaultCaptions, defaultPresentation, parseEditorProject } from '../src/engine.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { runListen, runSoundBank, runSoundImport, runSounds } from '../src/jobs/sound.ts'
import { runBuffer } from '../src/media.ts'
import { pngSize, Renderer } from '../src/render.ts'
import { FakeApp, type FakeJob } from './fake-app.ts'

const require = createRequire(import.meta.url)
const engine = (name: string) => require(`../../web/src/lib/studio/engine/${name}.ts`)
const sound = engine('sound') as typeof import('../../web/src/lib/studio/engine/sound.ts')
const layers = engine('layers') as typeof import('../../web/src/lib/studio/engine/layers.ts')
const automation = engine('automation') as typeof import('../../web/src/lib/studio/engine/automation.ts')

const SECRET = 'sound-e2e-secret-not-real-0123456789'
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

/** Onset and peak (seconds into the file) by the bridge's own envelope rule: 5 ms RMS, onset 30 dB under the peak. */
async function syncPoints(file: string): Promise<{ onset: number; peak: number }> {
  const raw = await runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  const win = 240
  const rms = new Float64Array(x.length)
  let acc = 0
  for (let i = 0; i < x.length; i++) {
    acc += x[i]! * x[i]!
    if (i >= win) acc -= x[i - win]! * x[i - win]!
    rms[Math.max(0, i - win / 2)] = Math.sqrt(Math.max(0, acc) / win)
  }
  let peakI = 0
  for (let i = 0; i < rms.length; i++) if (rms[i]! > rms[peakI]!) peakI = i
  const threshold = rms[peakI]! * 10 ** (-30 / 20)
  let onsetI = 0
  while (onsetI < rms.length && rms[onsetI]! <= threshold) onsetI++
  return { onset: onsetI / 48000, peak: peakI / 48000 }
}

async function main() {
  const earshotDir = process.env.STUDIO_EARSHOT_DIR
  if (!earshotDir) throw new Error('Set STUDIO_EARSHOT_DIR to an installed earshot (its folder, holding .venv).')
  const dir = await mkdtemp(join(tmpdir(), 'studio-sound-e2e-'))
  const outDir = resolve(process.env.STUDIO_SOUND_OUT ?? join(tmpdir(), 'studio-sound-e2e'))
  await mkdir(outDir, { recursive: true })
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 1024 * 1024 })
  await app.start()
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, NODE_ENV: 'test' })
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const config: WorkerConfig = loaded
  assert.ok(await checkEarshot(config.earshotDir), 'earshot answers (the capability check)')
  const cache = new AssetCache(join(dir, 'work', 'cache'), config.cacheBytes)
  await cache.init()
  const client = new AppClient({ appUrl: app.url, secret: SECRET, workerId: 'sound-e2e' })
  const renderer = new Renderer(config, cache.dir)
  console.log(`[sound-e2e] scratch ${dir}; outputs in ${outDir}`)

  const context = async <K extends string>(kind: K, input: unknown): Promise<{ ctx: JobContext; job: FakeJob }> => {
    const job = app.queue(kind as never, input)
    job.status = 'running'
    job.workerId = 'sound-e2e'
    const scratch = join(dir, 'jobs', job.id)
    await mkdir(scratch, { recursive: true })
    let last = -1
    const ctx = {
      job: { id: job.id, kind, workspaceId: job.workspaceId, videoId: null, input, attempts: 1 },
      config, client, cache, renderer, scratch, signal: new AbortController().signal,
      progress: (f: number) => { if (f - last >= 0.1 || f >= 1) { last = f; console.log(`  [${kind}] ${Math.round(f * 100)}%`) } },
      log: (line: string) => console.log(`  [${kind}] ${line}`),
    } as unknown as JobContext
    return { ctx, job }
  }
  const timed = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    const out = await work()
    console.log(`[sound-e2e] ${what}: ${((Date.now() - t) / 1000).toFixed(1)} s`)
    return out
  }
  const libraryAsset = async (file: string, name: string): Promise<EditorAsset> => {
    const { measured, waveform } = await inspectFile(file, name)
    const asset = buildAsset(measured, { sha256: await fileSha256(file), bytes: (await stat(file)).size }, { name, waveform })
    await app.putBlob(asset.file, file)
    return asset
  }

  // ---- made-up material ----------------------------------------------------------------------------------------------
  const picture = join(dir, 'picture.mp4')
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1d2b3a:s=1280x720:r=30:d=4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', picture])
  const bedFile = join(dir, 'bed.wav')
  // A soft pad (three sines) with a low pulse twice a second: a stand-in for a music bed.
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.05*sin(2*PI*220*t)+0.04*sin(2*PI*277.2*t)+0.035*sin(2*PI*329.6*t)+0.12*sin(2*PI*55*t)*lt(mod(t,0.5),0.12)|0.05*sin(2*PI*220*t)+0.04*sin(2*PI*277.2*t)+0.035*sin(2*PI*329.6*t)+0.12*sin(2*PI*55*t)*lt(mod(t,0.5),0.12)':s=48000:d=6", '-c:a', 'pcm_s16le', bedFile])
  const clickFile = join(dir, 'click.wav')
  // 0.2 s of silence, then a 30 ms burst of noise falling away: its onset is at 0.2 s.
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='if(lt(t,0.2),0,0.6*(random(0)*2-1)*exp(-(t-0.2)*120))':s=48000:d=0.5", '-c:a', 'pcm_s16le', clickFile])
  const video = await libraryAsset(picture, 'Made-up picture.mp4')
  const bed = await libraryAsset(bedFile, 'Made-up bed.wav')
  const click = await libraryAsset(clickFile, 'Made-up click.wav')

  const fps = 30
  let project: EditorProject = parseEditorProject({
    schemaVersion: 4,
    id: 'sound-e2e-project',
    title: 'Sound check',
    output: { width: 1280, height: 720, fps },
    assets: [video, bed],
    clips: [{ id: 'clip-1', assetId: video.id, trimStartSourceFrame: 0, trimEndSourceFrame: video.sourceFrames, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [] }],
    presentation: structuredClone(defaultPresentation),
    cursor: { style: 'none', size: 24, clickFeedback: false },
    audioTracks: [{ id: 'music', name: 'Music', role: 'music', gain: 1, muted: false, segments: [{ id: 'music-1', assetId: bed.id, startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 4 }] }],
    presenterTrack: null,
    transcripts: [],
    captions: { ...defaultCaptions },
    captionCorrections: {},
    voiceoverDraft: { text: '', targetClipIds: [] },
    layers: [
      layers.createLayer('text', 'title-pop', 15, 110, { name: 'Title', style: { text: 'Made-up launch' }, enter: { preset: 'pop', frames: 12 } }, fps),
      layers.createLayer('text', 'title-drop', 60, 118, { name: 'Tagline', style: { text: 'Now in sound' }, enter: { preset: 'drop', frames: 14 } }, fps),
    ],
  })
  project = parseEditorProject(automation.addTransition(project, 90, 'zoom-punch', 120))
  const cues = sound.soundCues(project)
  console.log('[sound-e2e] cues:', cues.map((c) => `${c.id} ${c.kind} @ ${c.t}s (${c.label})`).join('; '))
  assert.deepEqual(cues.map((c) => c.kind), ['pop', 'land', 'hit'], 'two entrances and the transition')

  // ---- 1. the bank -------------------------------------------------------------------------------------------------
  const bankRun = await context('sound-bank', {})
  const bank = (await timed('sound-bank', () => runSoundBank(bankRun.ctx as never))) as SoundBankResult
  assert.ok(bank.sounds.length > 100, 'the bank lists its sounds')
  assert.ok(bank.presets.launch?.roles.pop?.sound, 'the launch preset names a pop')
  console.log(`[sound-e2e] bank ${bank.version}: ${bank.sounds.length} sounds; presets ${Object.keys(bank.presets).join(', ')}`)
  const roles = bank.presets.launch!.roles as Record<string, { sound: string; align?: string; offset_ms?: number }>

  // ---- 2. the sound pass --------------------------------------------------------------------------------------------
  const music = project.audioTracks[0]!.segments[0]!
  const soundsInput: SoundsInput = {
    mode: 'pass',
    preset: 'launch',
    cues,
    bed: [{ asset: bed, atSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 4, gain: 1 }],
    music: { segmentId: music.id, atSeconds: 0, trimStartSeconds: 0, currentAssetId: bed.id, source: bed },
  }
  const passRun = await context('sounds', soundsInput)
  const pass = (await timed('sounds', () => runSounds(passRun.ctx as never))) as SoundsResult
  console.log('[sound-e2e] notes:', pass.notes)
  assert.equal(pass.placed.length, 3, 'one take per cue')
  const report: string[] = []
  for (const placed of pass.placed) {
    assert.ok(app.blobs.has(placed.asset.file), `${placed.asset.file} stored`)
    assert.equal(placed.asset.kind, 'audio')
    assert.equal((placed.asset.provenance as { earshot?: boolean }).earshot, true)
    const file = await app.blobFile(placed.asset.file, join(dir, `${placed.cueId.replace(/[^a-z0-9]/gi, '_')}.wav`))
    await copyFile(file, join(outDir, `${placed.cueId.replace(/[^a-z0-9]/gi, '_')}-${placed.sound.replace('/', '_')}.wav`))
    const cue = cues.find((c) => c.id === placed.cueId)!
    const role = roles[placed.role ?? ''] ?? {}
    const { onset, peak } = await syncPoints(file)
    const point = role.align === 'peak' ? peak : onset
    const landed = placed.startSeconds - placed.trimSeconds + point
    const target = cue.t + (role.offset_ms ?? 0) / 1000
    const off = Math.round((landed - target) * 1000)
    report.push(`${cue.kind} → ${placed.sound} (${placed.role}, ${role.align ?? 'onset'}${role.offset_ms ? ` ${role.offset_ms} ms` : ''}, ${placed.gainDb} dB): cue ${cue.t}s = frame ${Math.round(cue.t * fps)}, lands ${landed.toFixed(3)}s = frame ${(landed * fps).toFixed(1)} (${off >= 0 ? '+' : ''}${off} ms)`)
    assert.ok(Math.abs(landed - target) < 1 / fps, `${cue.kind} lands within a frame of its cue (${off} ms)`)
  }
  console.log('[sound-e2e] sync, measured from the stored files:\n  ' + report.join('\n  '))
  assert.equal(pass.music?.action, 'duck', 'the bed steps down before the hit')
  if (pass.music?.action === 'duck') {
    assert.ok(app.blobs.has(pass.music.asset.file))
    assert.equal((pass.music.asset.provenance as { duckedFrom?: string }).duckedFrom, bed.id)
    console.log(`[sound-e2e] music stepped down at ${pass.music.moments.join(', ')} s (${pass.music.asset.name})`)
    await copyFile(await app.blobFile(pass.music.asset.file, join(dir, 'ducked.wav')), join(outDir, 'music-ducked.wav'))
  }

  // ---- 3. an imported sound on its onset ------------------------------------------------------------------------------
  const importRun = await context('sound-import', { asset: click, name: click.name, at: 3.5, align: 'onset', track: 'sfx', label: 'Made-up click' })
  const imported = (await timed('sound-import', () => runSoundImport(importRun.ctx as never))) as SoundImportResult
  assert.ok(app.blobs.has(imported.asset.file))
  assert.ok(Math.abs(imported.startSeconds - 3.3) < 0.01, `the click starts 0.2 s early so its onset lands on 3.5 s (${imported.startSeconds})`)
  console.log(`[sound-e2e] imported click: starts ${imported.startSeconds}s, trim ${imported.trimSeconds}s, ${imported.durationSeconds}s long`)

  // ---- 4. listening to the mix, with the sounds applied as the app applies them -------------------------------------------
  let mixed = sound.placeSounds(project, pass.placed.map((p) => ({ cueId: p.cueId, asset: p.asset, startSeconds: p.startSeconds, trimSeconds: p.trimSeconds, durationSeconds: p.durationSeconds, sound: p.sound, label: p.label })), { replaceAuto: true })
  mixed = sound.placeSounds(mixed, [{ cueId: 'manual:click', asset: imported.asset, startSeconds: imported.startSeconds, trimSeconds: imported.trimSeconds, durationSeconds: imported.durationSeconds, sound: 'file:click', label: 'Made-up click' }])
  if (pass.music?.action === 'duck') {
    const ducked = pass.music.asset
    mixed = { ...mixed, assets: [...mixed.assets.filter((a) => a.id !== bed.id), ducked], audioTracks: mixed.audioTracks.map((t) => (t.id === 'music' ? { ...t, segments: [{ ...t.segments[0]!, assetId: ducked.id }] } : t)) }
  }
  mixed = parseEditorProject(mixed)
  assert.equal(mixed.audioTracks.find((t) => t.id === 'sfx')?.segments.length, 4)
  const listenRun = await context('listen', { project: mixed, cues: sound.earshotCueFile(mixed), checks: ['timeline', 'critique', 'sheet'] })
  const heard = (await timed('listen', () => runListen(listenRun.ctx as never))) as ListenResult
  assert.equal(heard.sheet?.key, `listen/${listenRun.job.id}/sheet.png`)
  const sheet = await app.blobFile(heard.sheet!.key, join(outDir, 'sheet.png'))
  const { width, height } = pngSize(await (await import('node:fs/promises')).readFile(sheet))
  assert.ok(heard.critique?.text, 'a scorecard')
  assert.ok(heard.timeline?.text, 'a listening transcript')
  await writeFile(join(outDir, 'listen.json'), JSON.stringify(heard, null, 2))
  console.log(`[sound-e2e] verdict: ${heard.critique?.verdict} (score ${heard.critique?.score}); sheet ${width}×${height} at ${sheet}`)
  console.log('---- scorecard ----\n' + heard.critique!.text!.slice(0, 2500))
  console.log('---- transcript ----\n' + heard.timeline!.text!.slice(0, 2500))
  await app.stop()
  console.log(`[sound-e2e] all passed; outputs in ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
