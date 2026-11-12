// Generating a storyboard beat's picture: a still first (the cheapest image model that takes the cast references),
// then, once the person approves the still, a draft clip from it (the cheapest video model that starts from an
// image, at its lowest quality), and only when the prompt is settled, the final clip with the good model.
//
// Nothing is spent without the person's yes on the quoted price. POST /projects/:id/beats/:beatId/generate without
// `confirm` answers a QUOTE (a quick `shot-quote` job the request waits on; quotes are free). With a `confirm`
// {model, credits} it queues a `shot` job, which quotes again and spends only when the fresh price is the one
// confirmed (no more credits, the same model); the editor follows that job like an export. The worker runs the
// higgsfield tool on the person's signed-in account, downloads what it made at once and stores each file as a
// library asset, grading a clip toward the camera footage when there is some. Filing the job (fileShot) records
// the charge, then places the result on the beat and saves the video against its digest, keeping the version before
// ("Before a generated shot").
//
// The rules:
//   - a clip needs an approved still (it starts from it); a final clip needs a draft clip first;
//   - a person in the cast needs `consent: true` (made only from their own photos, with their agreement), or the
//     request is refused before anything is asked of the provider;
//   - drafts are always pinned to the cheapest quality (the worker's generation-quality pass);
//   - a decline is an answer: nothing here retries a spend, and a refused price spends nothing.
import type { EditorAsset, EditorProject } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { createLayer } from '../engine/layers'
import { beatEnd, needsRecording, sortBeats, StoryboardSchema, type Beat } from '../engine/storyboard'
import { getAssets, registerAsset } from './assets'
import { requireCapability } from './capabilities'
import { must, type StudioContext } from './context'
import { recordCharge } from './costs'
import { conflictError, notFoundError, StudioError } from './errors'
import { ownAsset, queueJob, toEditorJob, waitForJob, type JobRow } from './jobs'
import type { ContinuityInput, ContinuityResult, MeasureSpan, PlanBlock, ShotAsk, ShotInput, ShotQuote, ShotQuoteResult, ShotResult } from './provider-contract'
import { getRecord, putRecord } from './records'
import { sha256Hex, stableStringify } from './stable'
import { saveVersion } from './versions'
import { openVideo, saveVideo } from './videos'

/** Where learned plan refusals are kept: one record, by model. */
export const PLANS_COLLECTION = 'shot-plans'
const PLANS_KEY = 'blocks'

export type BeatGenerateRequest = { what: 'still' | 'clip'; final?: boolean; confirm?: { model: string; credits: number } }

/** Parameter names the worker fills with media itself; a beat's own params may not set them (nor point at files). */
const MEDIA_PARAMS = new Set(['references', 'start_image', 'end_image', 'image', 'images', 'image_references', 'reference_images', 'input_images', 'video', 'audio', 'mask', 'file'])

/** A request body checked: what, final, and a confirm that names a model and a price. Pure. */
export function checkRequest(body: Record<string, unknown>): BeatGenerateRequest {
  if (body.what !== 'still' && body.what !== 'clip') throw new StudioError('what must be still or clip')
  const req: BeatGenerateRequest = { what: body.what, final: body.final === true }
  if (body.confirm !== undefined && body.confirm !== null) {
    const c = body.confirm as { model?: unknown; credits?: unknown }
    if (!c || typeof c !== 'object' || typeof c.model !== 'string' || !/^[a-z0-9_.-]{2,80}$/i.test(c.model) || typeof c.credits !== 'number' || !Number.isFinite(c.credits) || c.credits < 0 || c.credits > 100_000)
      throw new StudioError('Confirm the quoted price with its model and credits.')
    req.confirm = { model: c.model, credits: c.credits }
  }
  return req
}

/** The frame's shape as the providers name it. Pure. */
export const aspectOf = (p: EditorProject) => {
  const r = p.output.width / p.output.height
  return r > 1.5 ? '16:9' : r < 0.7 ? '9:16' : r < 0.9 ? '4:5' : '1:1'
}

/** A beat's own extra parameters, without anything that names media or a file on the worker's machine. Pure. */
export function safeParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (MEDIA_PARAMS.has(k) || k === 'final' || !/^[a-z][a-z0-9_]{0,40}$/.test(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 2000 && !/^(\/|~|\.{1,2}\/|file:)/i.test(v.trim())) out[k] = v
  }
  return out
}

/**
 * What a beat's still or clip is generated from: the prompt, the shape, the cast's reference images, and for a clip
 * the approved still to start from and the beat's length. Refuses what the rules refuse. Pure over the media given.
 */
export function beatAsk(project: EditorProject, beat: Beat, req: BeatGenerateRequest, media: Map<string, EditorAsset>, blocks: Record<string, PlanBlock>): { ask: ShotAsk; prompt: string } {
  const g = beat.generation ?? {}
  const cast = project.storyboard?.cast ?? []
  const chosen = cast.filter((c) => (g.references ?? []).includes(c.id))
  const unconsented = chosen.find((c) => c.kind === 'person' && c.consent !== true)
  if (unconsented) throw new StudioError(`${unconsented.name} is a person in the cast without their consent (consent: true): only use photos of someone who agreed.`, 400, 'NEEDS_CONSENT')
  const refIds = [...new Set([...chosen.flatMap((c) => c.assetIds), ...(g.references ?? []).filter((id) => !cast.some((c) => c.id === id))])].slice(0, 8)
  const file = (id: string) => {
    const asset = media.get(id) ?? project.assets.find((a) => a.id === id)
    if (!asset) throw new StudioError(`Media ${id} is missing`)
    return asset
  }
  const references = refIds.map(file)
  const extra = safeParams(g.params)
  if (req.final && req.what === 'clip' && g.stage !== 'clip' && g.stage !== 'final') throw new StudioError('Get a draft clip right first; the final runs once the prompt is settled')
  if (req.what === 'still') {
    const prompt = g.stillPrompt ?? g.prompt ?? beat.shot
    if (!prompt) throw new StudioError('Write the shot prompt first (Generation · Prompt)')
    return { prompt, ask: { what: 'still', final: !!req.final, ...(g.model ? { model: g.model } : {}), params: { prompt, aspect_ratio: aspectOf(project), ...extra }, references, blocks } }
  }
  if (!g.stillAssetId || (g.stage !== 'still-approved' && g.stage !== 'clip' && g.stage !== 'final')) throw new StudioError('Approve a still first: the clip starts from it')
  if (!g.prompt) throw new StudioError('Write the shot prompt first (Generation · Prompt)')
  return {
    prompt: g.prompt,
    ask: {
      what: 'clip', final: !!req.final, ...(g.model ? { model: g.model } : {}),
      params: { prompt: g.prompt, aspect_ratio: aspectOf(project), duration: Math.ceil(beat.durationFrames / project.output.fps), ...extra },
      references, startImage: file(g.stillAssetId), blocks,
    },
  }
}

/** The models refused on a plan so far. */
export async function planBlocks(ctx: StudioContext): Promise<Record<string, PlanBlock>> {
  return (await getRecord<Record<string, PlanBlock>>(ctx, PLANS_COLLECTION, PLANS_KEY)) ?? {}
}

/** A beat of a video, its ask, and the video as opened. */
async function prepare(ctx: StudioContext, videoId: string, beatId: string, req: BeatGenerateRequest) {
  const opened = await openVideo(ctx, videoId)
  const beat = opened.project.storyboard?.beats.find((b) => b.id === beatId)
  if (!beat) throw notFoundError(`No beat ${beatId}`)
  const g = beat.generation ?? {}
  const wanted = [...(g.references ?? []), ...(opened.project.storyboard?.cast ?? []).flatMap((c) => c.assetIds), ...(g.stillAssetId ? [g.stillAssetId] : [])]
  const media = await getAssets(ctx, wanted)
  const { ask, prompt } = beatAsk(opened.project, beat, req, media, await planBlocks(ctx))
  return { ...opened, beat, ask, prompt }
}

/** A job's end as an answer, or its failure as the refusal; null while it runs. */
function finished<T>(row: JobRow, what: string): T | null {
  if (row.status === 'completed') return row.result as unknown as T
  if (row.status === 'failed' || row.status === 'cancelled') throw new StudioError(row.error ?? `${what} failed.`, 502, 'PROVIDER')
  return null
}

/** The price of a beat's still or clip as it would run: the cheapest draft (with the others tried), or the final's. */
export async function quoteBeat(ctx: StudioContext, videoId: string, beatId: string, body: Record<string, unknown>, options: { waitMs?: number } = {}): Promise<ShotQuoteResult> {
  const req = checkRequest(body)
  requireCapability(ctx, 'generatedShots')
  const { ask } = await prepare(ctx, videoId, beatId, req)
  const job = await queueJob(ctx, 'shot-quote', ask, videoId)
  const done = finished<ShotQuoteResult>(await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? 100_000, everyMs: 700 }), 'Getting prices')
  if (done) return done
  throw new StudioError('Getting prices is taking longer than usual. Try again in a moment.', 409, 'STILL_RUNNING')
}

const JOB_FIELDS = 'id, workspace_id, video_id, kind, status, progress, logs, input, result, error, cancel_requested, worker_id, attempts, created_by, created_at, updated_at'

/** The shot job of this beat still queued or running, if any (a second click joins it, never spends twice). */
async function runningShot(ctx: StudioContext, videoId: string, beatId: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', 'shot').eq('video_id', videoId).in('status', ['queued', 'running']).eq('input->>beatId', beatId).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/**
 * The hash of what a shot asks of the provider: what, the quality, the model, the parameters (the prompt among them),
 * the references and the still it starts from (by id and bytes), and the confirmed model and credits. An approval
 * card pins it; the replay spends only when the beat still asks exactly that. Pure.
 */
export function shotAskHash(ask: ShotAsk, confirm?: BeatGenerateRequest['confirm']): string {
  const file = (a: EditorAsset) => ({ id: a.id, sha256: a.sha256 })
  return sha256Hex(stableStringify({
    what: ask.what, final: ask.final, model: ask.model ?? null, params: ask.params, references: ask.references.map(file),
    startImage: ask.startImage ? file(ask.startImage) : null, confirm: confirm ?? null,
  }))
}

/** The hash of what a beat's still or clip would ask of the provider now (shotAskHash), for an approval card. */
export async function shotRequestHash(ctx: StudioContext, videoId: string, beatId: string, body: Record<string, unknown>): Promise<string> {
  const req = checkRequest(body)
  const { ask } = await prepare(ctx, videoId, beatId, req)
  return shotAskHash(ask, req.confirm)
}

/** What the replay of an approval card answers when the beat no longer asks what the card showed. */
export const SHOT_CHANGED = "Nothing was spent. The beat's prompt, references or settings changed since you approved: ask again."

/**
 * Spend on a beat at the price the person confirmed: the job that does it (the one already running for the beat, if
 * any). `expectHash` (an approval card's pinned ask, shotAskHash) refuses (409 CARD_CHANGED) an ask that changed since.
 */
export async function startShot(ctx: StudioContext, videoId: string, beatId: string, body: Record<string, unknown>, options: { expectHash?: string } = {}): Promise<JobRow> {
  const req = checkRequest(body)
  if (!req.confirm) throw new StudioError('Confirm the quoted price first')
  requireCapability(ctx, 'generatedShots')
  const running = await runningShot(ctx, videoId, beatId)
  if (running) return running
  const { project, beat, ask, prompt } = await prepare(ctx, videoId, beatId, req)
  if (options.expectHash !== undefined && options.expectHash !== shotAskHash(ask, req.confirm)) throw new StudioError(SHOT_CHANGED, 409, 'CARD_CHANGED')
  const camera = req.what === 'clip' && project.presenterTrack ? project.assets.find((a) => a.id === project.presenterTrack!.assetId && a.kind === 'video') : undefined
  const input: ShotInput = {
    ...ask,
    confirm: req.confirm,
    beatId: beat.id,
    name: `${beat.label ?? beat.id}-${req.what}${req.final ? '-final' : ''}`.slice(0, 120),
    prompt: prompt.slice(0, 12_000),
    ...(camera ? { camera } : {}),
  }
  return queueJob(ctx, 'shot', input, videoId)
}

/** POST /projects/:id/beats/:beatId/generate: a quote, or with `confirm` the job that spends (followed like an export). */
export async function generateForBeat(ctx: StudioContext, videoId: string, beatId: string, body: Record<string, unknown>): Promise<ShotQuoteResult | { job: EditorJob }> {
  if (body.confirm === undefined || body.confirm === null) return quoteBeat(ctx, videoId, beatId, body)
  return { job: toEditorJob(await startShot(ctx, videoId, beatId, body)) }
}

// ---- placing what was made -----------------------------------------------------------------------------------------------

/** The generated clip fills the frame over the beat's stretch (replacing an earlier one for the same beat). Pure. */
export function placeOnBeat(project: EditorProject, beat: Beat, assetId: string): EditorProject {
  const id = `gen-${beat.id}`.slice(0, 100)
  const layer = createLayer('image', id, beat.startFrame, beatEnd(beat), {
    name: `${beat.label ?? beat.id} · generated`, assetId, x: 0.5, y: 0.5, width: 1, height: 1,
    style: { fill: 'image' }, enter: { preset: 'none', frames: 1 }, exit: { preset: 'none', frames: 1 },
  }, project.output.fps)
  return { ...project, layers: [...(project.layers ?? []).filter((l) => l.id !== id), layer] }
}

/** The edit with a made shot on its beat: the media added, a clip placed, the beat's generation moved on. Pure. */
export function withShot(project: EditorProject, beatId: string, input: Pick<ShotInput, 'what' | 'final'>, made: { assets: EditorAsset[]; asset: EditorAsset; credits: number; tier: 'draft' | 'final'; model: string }): EditorProject {
  const beat = project.storyboard?.beats.find((b) => b.id === beatId)
  if (!beat) throw new StudioError(`Beat ${beatId} is no longer in the storyboard; the shot is in the library.`)
  let next: EditorProject = { ...project, assets: [...project.assets, ...made.assets.filter((a) => !project.assets.some((x) => x.id === a.id))] }
  if (input.what === 'clip' && made.asset.kind === 'video') next = placeOnBeat(next, beat, made.asset.id)
  const g = beat.generation ?? {}
  const generation = {
    ...g,
    ...(input.what === 'still' ? { stillAssetId: made.asset.id, stage: 'still' as const } : { clipAssetId: made.asset.id, stage: input.final ? ('final' as const) : ('clip' as const) }),
    quality: made.tier,
    spentCredits: Math.round(((g.spentCredits ?? 0) + made.credits) * 100) / 100,
    ...(input.final ? { model: made.model } : {}),
  }
  const status = input.what === 'clip' && !needsRecording({ ...beat, source: 'generated' }) && beat.status === 'planned' ? ('generated' as const) : beat.status
  const beats = next.storyboard!.beats.map((b) => (b.id === beatId ? { ...b, generation, status } : b))
  return { ...next, storyboard: StoryboardSchema.parse({ ...next.storyboard!, beats: sortBeats(beats) }) }
}

/** Put a made shot on its beat in the video as it is now, keeping the version before; a save that races another tries again. */
export async function placeShot(ctx: StudioContext, videoId: string, input: ShotInput, made: Parameters<typeof withShot>[3]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const opened = await openVideo(ctx, videoId)
    const next = withShot(opened.project, input.beatId, input, made)
    await saveVersion(ctx, videoId, 'project', 'Before a generated shot', opened.project).catch(() => null)
    try {
      await saveVideo(ctx, next, opened.projectDigest)
      return
    } catch (error) {
      if (!(error instanceof StudioError) || error.code !== 'DIGEST_CONFLICT' || attempt >= 2) throw error
    }
  }
}

/**
 * The charge of a shot the worker spent on (made or undelivered), keyed by the job so recording it twice records it
 * once. Also called for a result that arrives after the job was taken back (jobs.ts). A result without a quote spent
 * nothing it can say.
 */
export async function recordShotCharge(ctx: StudioContext, row: Pick<JobRow, 'id' | 'video_id' | 'input'>, raw: Record<string, unknown>): Promise<boolean> {
  const out = raw as { outcome?: unknown; quote?: Partial<ShotQuote>; providerJobId?: unknown }
  if ((out.outcome !== 'made' && out.outcome !== 'undelivered') || !out.quote || typeof out.quote.credits !== 'number') return false
  const input = row.input as unknown as ShotInput
  await recordCharge(ctx, {
    provider: 'higgsfield',
    credits: out.quote.credits,
    model: String(out.quote.model),
    kind: input.what === 'still' ? 'image' : 'video',
    videoId: row.video_id,
    jobId: row.id,
    providerJobId: String(out.providerJobId).slice(0, 120),
    detail: input.prompt,
    ...(typeof out.quote.balance === 'number' ? { balance: out.quote.balance } : {}),
    ...(out.quote.plan ? { plan: out.quote.plan } : {}),
  })
  return true
}

/**
 * A finished `shot` job. Refused: a learned plan refusal is remembered. Spent: the charge is recorded whatever
 * else happens; made: every file is registered and the shot placed on its beat, unless the person asked the job
 * to stop meanwhile (then it stays in the library only). Answers the result to keep, with `placed` (and why not,
 * when it wasn't: the files stay in the library).
 */
export async function fileShot(ctx: StudioContext, row: Pick<JobRow, 'id' | 'video_id' | 'input'> & Partial<Pick<JobRow, 'cancel_requested'>>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as ShotInput
  const out = raw as unknown as ShotResult
  if (out.outcome === 'refused') {
    if (out.block?.model && Array.isArray(out.block.plans)) {
      const blocks = await planBlocks(ctx)
      const { model, ...block } = out.block
      blocks[model] = { plans: block.plans.map(String).slice(0, 4), message: String(block.message).slice(0, 200), seenOn: String(block.seenOn), at: String(block.at) }
      await putRecord(ctx, PLANS_COLLECTION, PLANS_KEY, blocks)
    }
    return { outcome: 'refused', error: String(out.error ?? 'Nothing was spent.') }
  }
  if (out.outcome !== 'made' && out.outcome !== 'undelivered') throw new StudioError('A shot ends made, refused or undelivered.')
  await recordShotCharge(ctx, row, raw)
  if (out.outcome === 'undelivered') return { outcome: 'undelivered', error: String(out.error), providerJobId: out.providerJobId, credits: out.quote.credits, model: out.quote.model }
  if (!Array.isArray(out.assets)) throw new StudioError('A made shot lists its files.')
  // Every file checked against what the job stored before any is registered.
  const checked: EditorAsset[] = []
  for (const value of out.assets) checked.push(await ownAsset(ctx, value, 'generated file'))
  const assets: EditorAsset[] = []
  for (const parsed of checked) assets.push(await registerAsset(ctx, parsed))
  const asset = assets.find((a) => a.id === out.asset.id)
  if (!asset) throw new StudioError('The shot to place is not among the stored files.')
  const answer = { outcome: 'made', assetId: asset.id, assetIds: assets.map((a) => a.id), credits: out.quote.credits, model: out.quote.model, tier: out.quote.tier, providerJobId: out.providerJobId, graded: out.graded === true }
  if (!row.video_id) return { ...answer, placed: false, placeError: 'No video to place it on; the shot is in the library.' }
  // Made after the person asked to stop: it was paid for, so it is kept in the library, but not put on the beat.
  if (row.cancel_requested) return { ...answer, placed: false, placeError: 'You cancelled this shot while it was being made. It was already paid for, so it is in the library, but it was not placed on the beat.' }
  try {
    await placeShot(ctx, row.video_id, input, { assets, asset, credits: out.quote.credits, tier: out.quote.tier, model: out.quote.model })
    return { ...answer, placed: true }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    console.error('[studio] placing a generated shot failed:', why)
    return { ...answer, placed: false, placeError: `${why.slice(0, 300)} The shot is in the library.` }
  }
}

// ---- continuity ---------------------------------------------------------------------------------------------------------

/** Each generated beat next to a recorded one, as the stretches to measure. Pure. */
export function continuityPairs(project: EditorProject): ContinuityInput['pairs'] {
  const beats = project.storyboard?.beats ?? []
  const fps = project.output.fps
  const camera = project.presenterTrack ? project.assets.find((a) => a.id === project.presenterTrack!.assetId) : undefined
  const span = (beat: Beat): MeasureSpan | null => {
    const clipId = beat.generation?.clipAssetId
    const asset = project.assets.find((a) => a.id === clipId) ?? (beat.status === 'recorded' ? camera : undefined)
    if (!asset || asset.kind !== 'video') return null
    return { asset, from: 0, to: Math.min(asset.durationSeconds ?? 1, beat.durationFrames / fps) }
  }
  const pairs: ContinuityInput['pairs'] = []
  for (const [i, beat] of beats.entries()) {
    if (!beat.generation?.clipAssetId) continue
    const neighbour = [beats[i + 1], beats[i - 1]].find((b) => b?.status === 'recorded')
    if (!neighbour) continue
    const a = span(beat)
    const b = span(neighbour)
    if (a && b) pairs.push({ beat: beat.label ?? beat.id, against: neighbour.label ?? neighbour.id, a, b })
  }
  return pairs
}

/** GET /projects/:id/continuity: light, colour and brightness mismatches between generated beats and the recorded ones they cut to. */
export async function videoContinuity(ctx: StudioContext, videoId: string, options: { waitMs?: number } = {}): Promise<ContinuityResult> {
  const { project } = await openVideo(ctx, videoId)
  const pairs = continuityPairs(project)
  if (!pairs.length) return { issues: [] }
  const job = await queueJob(ctx, 'continuity', { pairs }, videoId)
  const done = finished<ContinuityResult>(await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? 90_000, everyMs: 700 }), 'Measuring the shots')
  if (done) return { issues: Array.isArray(done.issues) ? done.issues : [] }
  throw conflictError('Measuring the shots is taking a while; try again in a moment.', 'STILL_RUNNING')
}
