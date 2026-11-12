/**
 * End to end for judging and making sounds: the jobs' own handlers
 * (src/jobs/sound-judge.ts) against a fake app (./fake-app.ts) that speaks the
 * job contract, with the REAL earshot (STUDIO_EARSHOT_DIR: an installed earshot
 * with its `.venv` and its models fetched) and FFmpeg. Made-up material only: a
 * knock made with FFmpeg stands in for a recording.
 *
 *   1. the doctor, as the worker logs it at start
 *   2. describe (against a description) and measure one bank sound
 *   3. rank three candidates against a description
 *   4. forge two sounds from a description, stored as library assets, then rank
 *      them against the same description (as the agent must before placing one)
 *   5. fit the made-up knock: its resynthesis stored as a library asset
 *
 *   STUDIO_EARSHOT_DIR=<earshot folder> node --import tsx test/sound-judge-e2e.ts
 *
 * Outputs (the made WAVs and every answer) go to STUDIO_SOUND_OUT (default
 * <tmp>/studio-sound-judge-e2e). One heavy run at a time: it loads models.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { SoundJudgeInput, SoundJudgeResult, SoundMakeInput, SoundMakeResult } from '../../web/src/lib/studio/server/sound-contract.ts'
import { AppClient, fileSha256 } from '../src/app-client.ts'
import { buildAsset, inspectFile } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { checkEarshot, doctorLine, earshotDoctor } from '../src/earshot.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { runSoundJudge, runSoundMake } from '../src/jobs/sound-judge.ts'
import { FakeApp } from './fake-app.ts'

const SECRET = 'sound-judge-e2e-secret-not-real-0123'
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

async function main() {
  if (!process.env.STUDIO_EARSHOT_DIR) throw new Error('Set STUDIO_EARSHOT_DIR to an installed earshot (its folder, holding .venv).')
  const dir = await mkdtemp(join(tmpdir(), 'studio-sound-judge-e2e-'))
  const outDir = resolve(process.env.STUDIO_SOUND_OUT ?? join(tmpdir(), 'studio-sound-judge-e2e'))
  await mkdir(outDir, { recursive: true })
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 1024 * 1024 })
  await app.start()
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, NODE_ENV: 'test' })
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const config: WorkerConfig = loaded
  assert.ok(await checkEarshot(config.earshotDir), 'earshot answers (the capability check)')
  const cache = new AssetCache(join(dir, 'work', 'cache'), config.cacheBytes)
  await cache.init()
  const client = new AppClient({ appUrl: app.url, secret: SECRET, workerId: 'sound-judge-e2e' })
  const answers: Record<string, unknown> = {}
  console.log(`[sound-judge-e2e] scratch ${dir}; outputs in ${outDir}`)

  const context = async <K extends 'sound-judge' | 'sound-make'>(kind: K, input: unknown): Promise<JobContext<K>> => {
    const job = app.queue(kind, input)
    job.status = 'running'
    job.workerId = 'sound-judge-e2e'
    const scratch = join(dir, 'jobs', job.id)
    await mkdir(scratch, { recursive: true })
    return {
      job: { id: job.id, kind, workspaceId: job.workspaceId, videoId: null, input, attempts: 1 },
      config, client, cache, renderer: {}, scratch, signal: new AbortController().signal,
      progress: () => undefined,
      log: (line: string) => console.log(`  [${kind}] ${line}`),
    } as unknown as JobContext<K>
  }
  const timed = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    const out = await work()
    console.log(`[sound-judge-e2e] ${what}: ${((Date.now() - t) / 1000).toFixed(1)} s`)
    answers[what] = out
    return out
  }
  const judge = (what: string, input: SoundJudgeInput) => timed(what, async () => runSoundJudge(await context('sound-judge', input))) as Promise<SoundJudgeResult>
  const make = (what: string, input: SoundMakeInput) => timed(what, async () => runSoundMake(await context('sound-make', input))) as Promise<SoundMakeResult>

  // ---- 1. the doctor ---------------------------------------------------------------------------------------------------
  const doctor = await earshotDoctor(config.earshotDir)
  console.log(`[sound-judge-e2e] ${doctorLine(doctor)}`)
  assert.ok(doctor?.summary, 'the doctor answers')

  // ---- 2. describe and measure one bank sound ------------------------------------------------------------------------------
  const described = await judge('describe', { action: 'describe', sounds: [{ sound: 'pop/2' }], description: 'a small bubble pop' })
  assert.ok(described.tags?.length && described.measures?.seconds, 'tags and meters')
  assert.ok(described.match && Number.isFinite(described.match.z), 'a match against the description')
  console.log(`[sound-judge-e2e] describe pop/2: ${described.tags!.slice(0, 3).map((t) => `${t.term} z ${t.z}`).join(', ')}; match '${described.match!.description}' z ${described.match!.z} (${described.match!.verdict})`)
  const measured = await judge('measure', { action: 'measure', sounds: [{ sound: 'pop/2' }] })
  assert.ok(measured.measures?.truePeakDb !== undefined)
  console.log(`[sound-judge-e2e] measure pop/2: ${JSON.stringify(measured.measures)}`)

  // ---- 3. rank three candidates against a description --------------------------------------------------------------------
  const ranked = await judge('rank', { action: 'rank', sounds: [{ sound: 'whoosh_fast/crisp' }, { sound: 'pop/2' }, { sound: 'impact/deep' }], description: 'a fast crisp air whoosh' })
  assert.equal(ranked.ranked?.length, 3)
  assert.equal(ranked.ranked![0]!.sound, 'whoosh_fast/crisp', 'the whoosh ranks first for a whoosh')
  console.log(`[sound-judge-e2e] rank: ${ranked.ranked!.map((r) => `${r.name} z ${r.z} (${r.verdict})`).join('; ')}`)

  // ---- 4. forge two sounds, then rank them -------------------------------------------------------------------------------
  const forged = await make('forge', { mode: 'forge', recipe: 'popin', description: 'a soft round low pop as an icon appears', count: 2 })
  assert.equal(forged.made.length, 2)
  for (const m of forged.made) {
    assert.ok(app.blobs.has(m.asset.file), `${m.asset.file} stored`)
    assert.equal(m.asset.kind, 'audio')
    const copy = join(outDir, m.name.replace(/[^a-z0-9.]+/gi, '_'))
    await app.blobFile(m.asset.file, copy)
    console.log(`[sound-judge-e2e] forged ${m.name}: ${m.asset.durationSeconds} s, ${m.asset.bytes} bytes, score ${JSON.stringify(m.score)} → ${copy}`)
  }
  const forgedRank = await judge('rank-forged', { action: 'rank', sounds: [...forged.made.map((m) => ({ asset: m.asset })), { sound: 'pro_pop_in/round' }], description: 'a soft round low pop as an icon appears' })
  assert.equal(forgedRank.ranked?.length, 3)
  assert.ok(forgedRank.ranked!.filter((r) => r.assetId).length === 2, 'the made sounds are judged as library assets')
  console.log(`[sound-judge-e2e] rank of the made sounds: ${forgedRank.ranked!.map((r) => `${r.name} z ${r.z} (${r.verdict})`).join('; ')}`)

  // ---- 5. fit a made-up recording ----------------------------------------------------------------------------------------
  const knockFile = join(dir, 'knock.wav')
  // A made-up knock: two damped partials and a short burst of noise, 50 ms in.
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='if(lt(t,0.05),0,(0.5*sin(2*PI*660*t)+0.3*sin(2*PI*1320*t)+0.2*(random(0)*2-1)*exp(-(t-0.05)*60))*exp(-(t-0.05)*14))':s=48000:d=0.6", '-c:a', 'pcm_s16le', knockFile])
  const { measured: m, waveform } = await inspectFile(knockFile, 'Made-up knock.wav')
  const knock: EditorAsset = buildAsset(m, { sha256: await fileSha256(knockFile), bytes: (await stat(knockFile)).size }, { name: 'Made-up knock.wav', waveform })
  await app.putBlob(knock.file, knockFile)
  const fitted = await make('fit', { mode: 'fit', asset: knock })
  const fit = fitted.made[0]!
  assert.ok(app.blobs.has(fit.asset.file))
  assert.equal((fit.asset.provenance as { fittedFrom?: string }).fittedFrom, knock.id)
  const fitCopy = join(outDir, 'Made-up_knock_fitted.wav')
  await app.blobFile(fit.asset.file, fitCopy)
  console.log(`[sound-judge-e2e] fitted ${fit.name}: ${fit.asset.durationSeconds} s, quality ${JSON.stringify(fit.quality)} → ${fitCopy}`)
  const ab = await judge('ab-fit', { action: 'ab', sounds: [{ asset: knock }, { asset: fit.asset }] })
  console.log(`[sound-judge-e2e] A/B recording vs fit: ${ab.summary}`)

  await writeFile(join(outDir, 'answers.json'), JSON.stringify(answers, null, 2))
  await app.stop()
  console.log(`[sound-judge-e2e] all passed; outputs in ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
