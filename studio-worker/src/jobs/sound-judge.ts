/**
 * earshot's ears and its sound making, as jobs (../earshot.ts runs the bridge;
 * the contract is web/src/lib/studio/server/sound-contract.ts). Neither edits a
 * video.
 *
 *   sound-judge  library sounds (decoded first with the fenced FFmpeg, as an
 *                upload is) and bank sounds heard by earshot: describe (and a
 *                match against a description), measure, compare, rank, find,
 *                an A/B, realness. The answer is compact and typed
 *                (judgeResultFrom): numbers and short words, files named by
 *                their names, never a path.
 *   sound-make   forge: a recipe's parameters searched toward a description by
 *                earshot's critic, the kept candidates stored as library
 *                assets. fit: a library recording (decoded first, 30 s at
 *                most) turned into code and rendered again, the render stored as
 *                a library asset. Each asset carries its provenance; the app
 *                registers them and never places them.
 *
 * The bridge runs these offline (it sets earshot's offline flags), so a model
 * missing from earshot's cache is a refusal that says so, never a download.
 */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { JudgeSource, MadeSound, SoundJudgeResult, SoundMakeResult } from '../../../web/src/lib/studio/server/sound-contract.ts'
import { stageAssets } from '../assets.ts'
import { ask, earshotDir, publishLocal, uploadAsWav } from './sound.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

// The contract's shapes, shared with the app (loaded as the engine is: the web side is not an ES module package).
const require = createRequire(import.meta.url)
const contract = require('../../../web/src/lib/studio/server/sound-contract.ts') as typeof import('../../../web/src/lib/studio/server/sound-contract.ts')
const { fitQualityFrom, forgeScoreFrom, judgeResultFrom, MAX_FIT_SECONDS, MAX_JUDGED_SECONDS } = contract

/** One sound as the bridge takes it: a WAV the worker decoded, or a bank id it renders itself. */
export type BridgeSource = { path: string; name: string; assetId?: string } | { sound: string; name: string }

/** How long a judgement may take: models load (about half a minute), a whole-bank find renders and hears 252 sounds. */
const JUDGE_TIMEOUT_MS = 15 * 60_000
/** How long a forge or a fit may take. */
const MAKE_TIMEOUT_MS = 20 * 60_000

/** Every library asset a source list names, once each. Pure. */
export function assetsOf(sources: (JudgeSource | undefined)[]): EditorAsset[] {
  const seen = new Map<string, EditorAsset>()
  for (const s of sources) if (s?.asset) seen.set(s.asset.id, s.asset)
  return [...seen.values()]
}

/**
 * The judge's sources as the bridge takes them: library assets as the WAVs `decoded` made of them (by asset id), bank
 * sounds by id. Pure.
 */
export function bridgeSources(sources: JudgeSource[], decoded: ReadonlyMap<string, string>): BridgeSource[] {
  return sources.map((s) => {
    if (s.asset) {
      const path = decoded.get(s.asset.id)
      if (!path) throw new JobError(`${s.asset.name} was not decoded.`)
      return { path, name: s.asset.name, assetId: s.asset.id }
    }
    return { sound: s.sound!, name: s.sound! }
  })
}

/** Each library asset decoded to a 48 kHz WAV in scratch with the fenced FFmpeg (as an upload is), by asset id. */
async function decodeAll(ctx: JobContext, assets: EditorAsset[], maxSeconds: number, from: number, to: number): Promise<Map<string, string>> {
  const decoded = new Map<string, string>()
  if (!assets.length) return decoded
  const release = await stageAssets(ctx, assets, stage(ctx, from, (from + to) / 2))
  try {
    const dir = join(ctx.scratch, 'heard')
    await mkdir(dir, { recursive: true })
    for (const [i, asset] of assets.entries()) {
      checkAborted(ctx.signal)
      const wav = join(dir, `in-${String(i + 1).padStart(2, '0')}.wav`)
      try {
        decoded.set(asset.id, await uploadAsWav(ctx.cache.pathOf(asset.file), wav, ctx.signal, maxSeconds))
      } catch (err) {
        throw err instanceof JobError ? new JobError(`${asset.name}: ${err.message}`) : err
      }
      stage(ctx, (from + to) / 2, to)((i + 1) / assets.length)
    }
  } finally {
    release()
  }
  return decoded
}

export const runSoundJudge: JobHandler<'sound-judge'> = async (ctx): Promise<SoundJudgeResult> => {
  earshotDir(ctx)
  const input = ctx.job.input
  const sources = input.sounds ?? []
  const decoded = await decodeAll(ctx, assetsOf([...sources, input.target]), MAX_JUDGED_SECONDS, 0, 0.2)
  const request: Record<string, unknown> = {
    cmd: 'judge',
    action: input.action,
    out: join(ctx.scratch, 'judge'),
    sounds: bridgeSources(sources, decoded),
    ...(input.target ? { target: bridgeSources([input.target], decoded)[0] } : {}),
    ...Object.fromEntries((['description', 'alts', 'start', 'end', 'category', 'top'] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]])),
  }
  ctx.log(input.action === 'measure' ? 'earshot is measuring' : 'earshot is listening (the first time loads its models, about 30 s)')
  ctx.progress(0.25)
  const raw = await ask<unknown>(ctx, request, JUDGE_TIMEOUT_MS)
  checkAborted(ctx.signal)
  const result = judgeResultFrom(raw, input.action)
  ctx.progress(1)
  ctx.log(result.summary.slice(0, 300) || 'Judged')
  return result
}

/**
 * Whether a file earshot answered lies inside the job's own folder `out`: resolved first, so `out/../x` and a sibling
 * folder named like it (`out-x`) are outside. Pure.
 */
export function insideJob(out: string, file: unknown): file is string {
  if (typeof file !== 'string' || !file) return false
  const rel = relative(resolve(out), resolve(out, file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The forge's search size for a count of candidates: more kept, more heard. Pure. */
export const forgeBudget = (count: number) => Math.min(128, 64 + 16 * Math.max(1, Math.min(4, count)))

/** A file name from earshot's own words (a recipe, a description), short and plain. Pure. */
export const plainName = (text: string, max = 48) => text.replace(/[^a-zA-Z0-9 ,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() || 'Sound'

type Forged = { recipe: string; description: string; summary?: string; made: { file: string; name?: string; score?: unknown }[] }
type Fitted = { file: string; quality?: unknown; summary?: string }

export const runSoundMake: JobHandler<'sound-make'> = async (ctx): Promise<SoundMakeResult> => {
  earshotDir(ctx)
  const input = ctx.job.input
  const published = new Map<string, EditorAsset>()
  if (input.mode === 'forge') {
    const count = Math.max(1, Math.min(4, input.count || 1))
    ctx.log(`earshot is making ${count === 1 ? 'a sound' : `${count} sounds`} with its ${input.recipe} recipe (the first time loads its models)`)
    ctx.progress(0.05)
    const out = join(ctx.scratch, 'forge')
    const forged = await ask<Forged>(ctx, { cmd: 'forge', recipe: input.recipe, description: input.description, ...(input.alts?.length ? { alts: input.alts } : {}), count, budget: forgeBudget(count), out }, MAKE_TIMEOUT_MS)
    checkAborted(ctx.signal)
    ctx.progress(0.85)
    const made: MadeSound[] = []
    for (const [i, pick] of (forged.made ?? []).slice(0, count).entries()) {
      if (!insideJob(out, pick.file)) throw new JobError('earshot answered a file outside the job.')
      const score = forgeScoreFrom(pick.score)
      const name = `${plainName(input.description)} · ${input.recipe} ${i + 1}.wav`
      const asset = await publishLocal(ctx, pick.file, name, { earshot: true, made: 'forge', recipe: input.recipe, description: input.description.slice(0, 300), score }, published)
      made.push({ asset, name, score })
    }
    if (!made.length) throw new JobError(`earshot kept no sound for that description with its ${input.recipe} recipe.`)
    ctx.progress(1)
    return { mode: 'forge', recipe: input.recipe, description: input.description, made, summary: String(forged.summary ?? '').slice(0, 1500) }
  }
  const asset = input.asset
  if (!asset) throw new JobError('A fit names the recording to turn into code.')
  const decoded = await decodeAll(ctx, [asset], MAX_FIT_SECONDS, 0, 0.2)
  ctx.log(`earshot is turning ${asset.name} into code`)
  const out = join(ctx.scratch, 'fit')
  const fitted = await ask<Fitted>(ctx, { cmd: 'fit', file: decoded.get(asset.id), out, ...(input.description ? { description: input.description } : {}) }, MAKE_TIMEOUT_MS)
  checkAborted(ctx.signal)
  if (!insideJob(out, fitted.file)) throw new JobError('earshot answered a file outside the job.')
  ctx.progress(0.85)
  const quality = fitQualityFrom(fitted.quality)
  const name = `${plainName(asset.name.replace(/\.[a-z0-9]+$/i, ''))} · fitted.wav`
  const made = await publishLocal(ctx, fitted.file, name, { earshot: true, made: 'fit', fittedFrom: asset.id, quality }, published)
  ctx.progress(1)
  return { mode: 'fit', made: [{ asset: made, name, quality }], summary: String(fitted.summary ?? '').slice(0, 1500), ...(input.description ? { description: input.description } : {}) }
}
