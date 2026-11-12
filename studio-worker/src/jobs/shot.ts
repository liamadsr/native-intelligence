/**
 * Generated shots for storyboard beats, with the higgsfield tool on the
 * person's signed-in account (../providers/higgsfield.ts).
 *
 * shot-quote: the price as it will run. A draft quotes every candidate model
 * that can take the inputs and answers the cheapest (with the others tried); a
 * final quotes the beat's good model at full quality. Free.
 *
 * shot: the spend. It quotes again, and spends only when the fresh price is the
 * one the person confirmed (the same model, no more credits); otherwise nothing
 * is spent and the job says the price changed. Then it waits for the
 * provider's job, downloads every file at once, stores each as a library asset
 * with its provenance (the provider's job id, the model, the prompt, the
 * credits), and grades a clip toward the camera footage when there is some.
 * The app places the result on the beat.
 *
 * Library media the beat names (cast references, the approved still, the
 * camera footage) are downloaded into the cache and handed to the tool as
 * local files; the tool uploads them itself. Paths never leave this worker:
 * the quote it answers names them `asset:<id>`.
 *
 * Never spent twice: a shot job handed out again (a worker that stopped
 * mid-job) refuses rather than start a second generation.
 *
 * Never lost once spent: from `generate create` on, the job finishes whatever
 * happens (a cancel, a deploy, the app taking it back): it answers `made` or
 * `undelivered` with the provider's job id and the credits, and the runner
 * completes it (runner.ts). The media handed to the tool are copies in the
 * job's scratch folder, the tool runs there, and results are streamed to disk
 * with a size limit.
 */
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { ContinuityResult, ShotAsk, ShotInput, ShotQuote, ShotQuoteResult, ShotResult } from '../../../web/src/lib/studio/server/provider-contract.ts'
import { buildAsset, conformVideo, inspectFile, publishAsset, stageAssets } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { continuityIssues, frameStats, gradeToward, spread } from '../providers/grade.ts'
import { Higgsfield, higgsfieldPath, matchesConfirm, MEDIA_PARAMS, toolRunner, type HfRunner } from '../providers/higgsfield.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

/** Download `url` into `dest` (at most `maxBytes`); answers its content type. */
export type Download = (url: string, dest: string, signal: AbortSignal, maxBytes: number) => Promise<{ contentType: string | null }>

/** Test seams: the tool and the result downloads (the real ones run the tool and fetch https links). */
let runnerOverride: HfRunner | undefined
let downloadOverride: Download | undefined
export function useHiggsfield(run: HfRunner | undefined, download?: Download): void {
  runnerOverride = run
  downloadOverride = download
}

export const INTERRUPTED =
  'This generation was interrupted after it may have started (and been charged), so it is not started again on its own. Look for it in your Higgsfield account before generating this shot again.'

/** The largest result file kept. */
export const MAX_RESULT_BYTES = 500 * 1024 * 1024

const download: Download = async (url, dest, signal, maxBytes) => {
  if (!url.startsWith('https://')) throw new Error('A result link that is not https')
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`The result is ${Math.round(declared / 1024 ** 2)} MB, over the ${Math.round(maxBytes / 1024 ** 2)} MB the worker keeps`)
  await pipeline(Readable.fromWeb(res.body as never), capBytes(maxBytes), createWriteStream(dest), { signal })
  return { contentType: res.headers.get('content-type') }
}

/** A stream that fails once more than `max` bytes have passed through it. */
export function capBytes(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > max) return done(new Error(`The result is over the ${Math.round(max / 1024 ** 2)} MB the worker keeps`))
      done(null, chunk)
    },
  })
}

/** A file's extension from its link, else from its type, else from what was asked. Pure. */
export function resultExtension(url: string, contentType: string | null, what: 'still' | 'clip'): string {
  const fromUrl = /\.(mp4|mov|webm|png|jpe?g|webp)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase()
  if (fromUrl) return fromUrl === 'jpeg' ? 'jpg' : fromUrl
  const byType: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
  return byType[(contentType ?? '').split(';')[0]!.trim().toLowerCase()] ?? (what === 'still' ? 'png' : 'mp4')
}

/** Local paths back to the media they are, in what leaves the worker. Pure. */
export function withAssetNames(params: Record<string, unknown>, paths: Map<string, string>): Record<string, unknown> {
  const name = (v: unknown) => (typeof v === 'string' && paths.has(v) ? `asset:${paths.get(v)}` : v)
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.map(name) : name(v)]))
}

/**
 * The ask's media, each copied from the cache into the job's scratch folder (the tool runs there and may only be
 * handed these), and its parameters with those files in. `pathOf` answers an asset's copy (the camera footage's is
 * the cache file: it is graded toward, never handed to the tool).
 */
async function staged(ctx: JobContext, ask: ShotAsk, extra: EditorAsset[] = []) {
  const forTool = [...new Map([...(ask.references ?? []), ...(ask.startImage ? [ask.startImage] : [])].map((a) => [a.id, a])).values()]
  const all = [...new Map([...forTool, ...extra].map((a) => [a.id, a])).values()]
  const release = await stageAssets(ctx, all, stage(ctx, 0, 0.1))
  try {
    const dir = join(ctx.scratch, 'media')
    await mkdir(dir, { recursive: true })
    const copies = new Map<string, string>()
    for (const [i, a] of forTool.entries()) {
      const ext = (extname(a.file).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ?? [''])[0]
      const copy = join(dir, `${i}${ext}`)
      await copyFile(ctx.cache.pathOf(a.file), copy)
      copies.set(a.id, copy)
    }
    const pathOf = (a: EditorAsset) => copies.get(a.id) ?? ctx.cache.pathOf(a.file)
    const paths = new Map(forTool.map((a) => [pathOf(a), a.id]))
    const params: Record<string, unknown> = { ...ask.params }
    // The media parameters are the worker's own: the ask's names only these two.
    for (const key of Object.keys(params)) if (MEDIA_PARAMS.has(key) || key === 'references') delete params[key]
    if (ask.references?.length) params.references = ask.references.map(pathOf)
    if (ask.startImage) params.start_image = pathOf(ask.startImage)
    return { params, paths, pathOf, staged: new Set(copies.values()), release }
  } catch (err) {
    release()
    throw err
  }
}

/** The quote for an ask: the cheapest draft, or the final. */
async function quoteAsk(hf: Higgsfield, ask: ShotAsk, params: Record<string, unknown>): Promise<{ quote: ShotQuote; tried?: ShotQuoteResult['tried'] }> {
  const kind = ask.what === 'still' ? 'image' : 'video'
  if (ask.final) return { quote: await hf.finalQuote(kind, ask.model, params) }
  return hf.cheapestDraft(kind, params)
}

const toolFor = (ctx: JobContext, ask: ShotAsk, staged: ReadonlySet<string>) =>
  new Higgsfield(runnerOverride ?? toolRunner(higgsfieldPath(ctx.config.higgsfieldBin), ctx.scratch), ask.blocks ?? {}, ctx.signal, staged)

export const runShotQuote: JobHandler<'shot-quote'> = async (ctx): Promise<ShotQuoteResult> => {
  const ask = ctx.job.input
  const { params, paths, staged: files, release } = await staged(ctx, ask)
  try {
    ctx.log(ask.final ? `Pricing the final ${ask.what}` : `Pricing a draft ${ask.what} on the cheapest model that can take it`)
    const { quote, tried } = await quoteAsk(toolFor(ctx, ask, files), ask, params)
    ctx.progress(1)
    return { quote: { ...quote, params: withAssetNames(quote.params, paths) }, ...(tried ? { tried } : {}) }
  } finally {
    release()
  }
}

/** Measure and store a downloaded (or graded) file as a library asset; a clip at a variable rate is conformed first. */
async function importLocal(ctx: JobContext, file: string, name: string, provenance: Record<string, unknown>): Promise<EditorAsset> {
  let path = file
  let inspected
  try {
    inspected = await inspectFile(path, name, ctx.signal)
  } catch (err) {
    if (!(err instanceof JobError) || !/\.(mp4|mov|webm)$/i.test(name)) throw err
    ctx.log(`Conforming ${name} to a constant frame rate`)
    path = join(ctx.scratch, `conformed-${Date.now().toString(36)}.mp4`)
    await conformVideo(file, path, 30, { signal: ctx.signal })
    name = name.replace(/\.[^.]+$/, '.mp4')
    inspected = await inspectFile(path, name, ctx.signal)
  }
  const sha256 = await fileSha256(path)
  const asset = buildAsset(inspected.measured, { sha256, bytes: (await stat(path)).size }, { name, waveform: inspected.waveform, provenance })
  await publishAsset(ctx, asset, path)
  return asset
}

export const runShot: JobHandler<'shot'> = async (ctx): Promise<ShotResult> => {
  const input = ctx.job.input
  if (ctx.job.attempts > 1) return { outcome: 'refused', error: INTERRUPTED }
  const { params, pathOf, staged: files, release } = await staged(ctx, input, input.camera ? [input.camera] : [])
  try {
    const hf = toolFor(ctx, input, files)
    ctx.log('Checking the price before spending')
    let quoted
    try {
      quoted = (await quoteAsk(hf, input, params)).quote
    } catch (err) {
      checkAborted(ctx.signal)
      return { outcome: 'refused', error: `${(err as Error).message} Nothing was spent.` }
    }
    if (!matchesConfirm(quoted, input.confirm)) {
      return { outcome: 'refused', error: `The price changed (${quoted.model}: ${quoted.credits} credits); nothing was spent. Look at the new quote.` }
    }
    checkAborted(ctx.signal)
    ctx.progress(0.15)
    ctx.log(`Spending ${quoted.credits} credits on ${quoted.model} (${quoted.tier})`)
    // From here on money may be spent: nothing below throws for a cancel; every way out names the provider's job.
    const created = await hf.create(quoted)
    if ('refused' in created) {
      return {
        outcome: 'refused',
        error: `${created.refused} Nothing was spent.`,
        block: { model: quoted.model, plans: created.plans, message: created.refused.slice(0, 200), seenOn: quoted.plan ?? 'unknown', at: new Date().toISOString() },
      }
    }
    return await afterSpend(ctx, hf, input, quoted, created.jobId, pathOf)
  } finally {
    release()
  }
}

/** Why a paid generation stopped short, for its `undelivered` sentence. */
const stoppedWhy = (ctx: JobContext, err?: unknown) =>
  ctx.signal.aborted ? `the job was stopped (${String((ctx.signal.reason as Error)?.message ?? 'cancelled').slice(0, 160)})` : String((err as Error)?.message ?? err ?? 'it stopped').slice(0, 300)

/** Wait, download, store and grade a generation that was paid for: always an answer, never a throw. */
async function afterSpend(ctx: JobContext, hf: Higgsfield, input: ShotInput, quoted: ShotQuote, providerJobId: string, pathOf: (a: EditorAsset) => string): Promise<ShotResult> {
  const shown: ShotQuote = { ...quoted, params: withAssetNames(quoted.params, new Map([...input.references, ...(input.startImage ? [input.startImage] : [])].map((a) => [pathOf(a), a.id]))) }
  const undelivered = (why: string): ShotResult => ({
    outcome: 'undelivered',
    error: `The generation was paid for (${quoted.credits} credits) but did not arrive here: ${why} Look for Higgsfield job ${providerJobId} in your account; it is not generated again on its own.`,
    quote: shown,
    providerJobId,
  })
  if (ctx.signal.aborted) return undelivered(`${stoppedWhy(ctx)}.`)
  ctx.log(`Generating (Higgsfield job ${providerJobId})`)
  ctx.progress(0.2)
  let urls: string[]
  try {
    urls = await hf.wait(providerJobId)
  } catch (err) {
    return undelivered(`${stoppedWhy(ctx, err)}.`)
  }
  if (!urls.length) return undelivered('it finished with no file link in its result.')
  ctx.progress(0.75)
  const base = input.name.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'shot'
  const generated = { by: 'higgsfield', model: quoted.model, jobId: providerJobId, tier: quoted.tier, credits: quoted.credits, prompt: input.prompt.slice(0, 2000), studioJobId: ctx.job.id }
  const assets: EditorAsset[] = []
  try {
    for (const [i, url] of urls.entries()) {
      const local = join(ctx.scratch, `result-${i}.download`)
      const got = await (downloadOverride ?? download)(url, local, ctx.signal, MAX_RESULT_BYTES)
      const ext = resultExtension(url, got.contentType, input.what)
      const name = `${base}${i ? `-${i + 1}` : ''}-${providerJobId.slice(0, 8)}.${ext}`
      const file = join(ctx.scratch, `result-${i}.${ext}`)
      await copyFile(local, file)
      await rm(local, { force: true })
      ctx.log(`Storing ${name}`)
      assets.push(await importLocal(ctx, file, name, { generated }))
    }
  } catch (err) {
    if (!assets.length) return undelivered(`its file could not be kept (${stoppedWhy(ctx, err)}).`)
    ctx.log(`Kept ${assets.length} of ${urls.length} files: ${stoppedWhy(ctx, err)}`)
  }
  let asset = assets[0]!
  let graded = false
  if (input.what === 'clip' && asset.kind === 'video' && input.camera && !ctx.signal.aborted) {
    ctx.log('Grading the clip toward your camera footage')
    try {
      const out = join(ctx.scratch, 'graded.mp4')
      const g = await gradeToward({ file: ctx.cache.pathOf(asset.file), seconds: asset.durationSeconds ?? 1 }, { file: pathOf(input.camera), seconds: input.camera.durationSeconds ?? 1 }, out, { signal: ctx.signal })
      const name = `${asset.name.replace(/\.\w+$/, '')} · graded.mp4`
      asset = await importLocal(ctx, out, name, { generated, graded: { from: assets[0]!.id, toward: input.camera.id, strength: g.strength, before: g.before, reference: g.reference } })
      assets.push(asset)
      graded = true
    } catch (err) {
      asset = assets[0]!
      ctx.log(`Grade skipped: ${stoppedWhy(ctx, err)}`)
    }
  }
  ctx.progress(1)
  return { outcome: 'made', quote: shown, providerJobId, assets, asset, graded }
}

export const runContinuity: JobHandler<'continuity'> = async (ctx): Promise<ContinuityResult> => {
  const { pairs } = ctx.job.input
  const assets = [...new Map(pairs.flatMap((p) => [p.a.asset, p.b.asset]).map((a) => [a.id, a])).values()]
  const release = await stageAssets(ctx, assets, stage(ctx, 0, 0.5))
  try {
    const measured = []
    for (const p of pairs) {
      checkAborted(ctx.signal)
      const a = await frameStats(ctx.cache.pathOf(p.a.asset.file), spread(p.a.from, p.a.to), ctx.signal)
      const b = await frameStats(ctx.cache.pathOf(p.b.asset.file), spread(p.b.from, p.b.to), ctx.signal)
      measured.push({ beat: p.beat, against: p.against, a, b })
    }
    ctx.progress(1)
    return { issues: continuityIssues(measured) }
  } finally {
    release()
  }
}
