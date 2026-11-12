/**
 * More of the voice provider than narration (./narration.ts), with the same key
 * (ELEVENLABS_API_KEY) and the same rules:
 *
 * voice-search: the account's voices and the shared voice library, by words
 * and filters. Free (two reads).
 *
 * revoice: a library asset's speech, the stretch the app asked for, cut to a
 * mono WAV and re-spoken in another voice (the provider's speech to speech),
 * which keeps every pause, so a generated talking shot's lip sync holds. The
 * audio becomes a library asset.
 *
 * sound-effect, music: one request per candidate the app asked for, each
 * answer a library asset with its provenance (the provider, the description,
 * the terms it states).
 *
 * Never sent twice: a job handed out again (a worker that stopped mid-request)
 * refuses rather than pay a second time. Never retried: a refusal by status
 * was not charged and fails the job; a request that failed or timed out may
 * have been, and says so. Never lost once answered: whatever goes wrong after
 * the provider answered (or a cancel then) comes back as an `undelivered`
 * answer with the charge, which the runner completes. The audio is streamed to
 * disk under a size cap; the key is in a header only.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { AudioUndelivered, GeneratedAudioWorkerResult, MusicInput, ProviderSpend, RevoiceWorkerResult, SoundEffectInput, VoiceSearchResult } from '../../../web/src/lib/studio/server/provider-contract.ts'
import { buildAsset, inspectFile, publishAsset, stageAssets } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { run } from '../media.ts'
import { AnsweredButLost, musicBody, NEEDS_ELEVENLABS, postForAudio, searchVoices, soundEffectBody, voiceChangerForm, voiceChangerPath, type Fetch } from '../providers/elevenlabs.ts'
import { checkAborted, JobError, SpendUnknown, stage, type JobContext, type JobHandler } from './context.ts'

/** A test's fake provider transport (the real one is fetch). */
let transport: Fetch | undefined
export function useVoiceMediaFetch(f: Fetch | undefined): void {
  transport = f
}

export const INTERRUPTED =
  'This was interrupted after its request may have reached the voice provider, so it is not sent again on its own. Check the video’s costs and the voice provider’s history before asking for it again.'

/** The key, or the refusal a keyless worker answers (it never asks for these jobs). */
function keyOf(ctx: JobContext): string {
  if (!ctx.config.elevenLabsKey) throw new JobError(NEEDS_ELEVENLABS)
  return ctx.config.elevenLabsKey
}

/** A spend's first and only attempt: one handed out again refuses before anything is sent. */
function firstAttempt(ctx: JobContext): void {
  if (ctx.job.attempts > 1) throw new JobError(INTERRUPTED)
}

/** True when an error is the provider's refusal by status (not charged). Pure. */
const refusedByStatus = (err: unknown) => /returned HTTP \d+/.test((err as Error)?.message ?? '')

/** The charge of the answers a job got: the provider's own counts when every answer said one, else the estimate. Pure. */
export function spendOf(answered: { credits: number | null; requestId: string | null }[], estimatePerAnswer: number): ProviderSpend {
  const fromProvider = answered.length > 0 && answered.every((a) => a.credits !== null)
  const credits = answered.reduce((sum, a) => sum + (a.credits ?? estimatePerAnswer), 0)
  const ids = answered.map((a) => a.requestId).filter((id): id is string => !!id)
  return { credits: Math.round(credits * 100) / 100, creditsFrom: fromProvider ? 'provider' : 'estimate', ...(ids.length ? { providerRequestIds: ids } : {}) }
}

/** Spent and not delivered: the charge and a sentence that never asks to try again. Pure. */
export function audioUndelivered(why: string, spend: ProviderSpend): AudioUndelivered {
  return { outcome: 'undelivered', error: `The voice provider made this (and charged about ${spend.credits} credits) but it could not be kept: ${why.slice(0, 300)} It is not requested again on its own.`, ...spend }
}

/** Why a job ended after the provider answered, when it was stopped. */
const stoppedWhy = (ctx: JobContext, when: string) => `the job was stopped ${when} (${String((ctx.signal.reason as Error)?.message ?? 'cancelled').slice(0, 160)}).`

/** A downloaded answer checked and stored as a library audio asset. */
async function storeAudio(ctx: JobContext, file: string, name: string, provenance: Record<string, unknown>): Promise<EditorAsset> {
  const { measured, waveform } = await inspectFile(file, name, ctx.signal)
  if (measured.kind !== 'audio' || !measured.hasAudio || !(measured.durationSeconds! > 0)) throw new Error('the audio it returned cannot be read.')
  const asset = buildAsset(measured, { sha256: await fileSha256(file), bytes: (await stat(file)).size }, { name, waveform, provenance })
  await publishAsset(ctx, asset, file)
  return asset
}

export const runVoiceSearch: JobHandler<'voice-search'> = async (ctx): Promise<VoiceSearchResult> => {
  const key = keyOf(ctx)
  ctx.log('Searching the voice library')
  try {
    return await searchVoices(ctx.job.input.query, { key, baseUrl: ctx.config.elevenLabsUrl, fetch: transport, signal: ctx.signal })
  } catch (err) {
    throw new JobError((err as Error).message)
  }
}

/** The stretch of the source asset to re-voice, as a mono 44.1 kHz WAV in the job's folder. */
async function cutStretch(ctx: JobContext<'revoice'>): Promise<Buffer> {
  const { source, request } = ctx.job.input
  const release = await stageAssets(ctx, [source], stage(ctx, 0, 0.15))
  try {
    const wav = join(ctx.scratch, 'speech.wav')
    const seconds = request.source.toSeconds - request.source.fromSeconds
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(request.source.fromSeconds), '-t', String(seconds), '-i', ctx.cache.pathOf(source.file), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav], { signal: ctx.signal, timeout: 120_000 })
    return await readFile(wav)
  } finally {
    release()
  }
}

export const runRevoice: JobHandler<'revoice'> = async (ctx): Promise<RevoiceWorkerResult | AudioUndelivered> => {
  const { request, requestHash, voiceName, name, estimatedCredits, terms, speaker } = ctx.job.input
  const key = keyOf(ctx)
  firstAttempt(ctx)
  if (ctx.job.input.source.id !== request.source.assetId) throw new JobError('The re-voice names another file than the one it was given.')
  const audio = await cutStretch(ctx)
  checkAborted(ctx.signal)
  ctx.log(`Re-voicing ${(request.source.toSeconds - request.source.fromSeconds).toFixed(2)} s into ${voiceName}'s voice (${request.modelId})`)
  ctx.progress(0.2)
  const out = join(ctx.scratch, 'revoice.mp3')
  let answer
  try {
    answer = await postForAudio(voiceChangerPath(request), voiceChangerForm(request, audio), out, { key, baseUrl: ctx.config.elevenLabsUrl, fetch: transport })
  } catch (err) {
    if (err instanceof AnsweredButLost) return audioUndelivered(`${err.message}.`, spendOf([err], estimatedCredits))
    if (refusedByStatus(err)) throw new JobError((err as Error).message)
    throw new SpendUnknown(`${(err as Error).message} It may have been charged: look in the voice provider’s history before re-voicing this again.`)
  }
  // Answered, so charged: from here on every way out carries the charge, and nothing throws for a cancel.
  const spend = spendOf([answer], estimatedCredits)
  if (ctx.signal.aborted) return audioUndelivered(stoppedWhy(ctx, 'as the audio arrived'), spend)
  try {
    ctx.progress(0.7)
    const asset = await storeAudio(ctx, out, name, {
      revoice: { provider: 'elevenlabs', requestHash, voiceId: request.voiceId, modelId: request.modelId, sourceAssetId: request.source.assetId, from: request.source.fromSeconds, to: request.source.toSeconds, speaker, credits: spend.credits, terms, studioJobId: ctx.job.id },
    })
    ctx.progress(1)
    return { asset, seconds: asset.durationSeconds ?? 0, ...spend }
  } catch (err) {
    return audioUndelivered(ctx.signal.aborted ? stoppedWhy(ctx, 'while it was stored') : `${(err as Error).message.slice(0, 300)}`, spend)
  }
}

/**
 * Sound effects or music: one request per candidate, one after another. The first refused by status fails the job
 * (nothing spent); a later one ends the asking with what was made. A request that may have been charged with nothing
 * to show fails the job when nothing was answered before it, else is said in the note.
 */
async function runGenerated(ctx: JobContext<'sound-effect'> | JobContext<'music'>, kind: 'sound-effect' | 'music'): Promise<GeneratedAudioWorkerResult | AudioUndelivered> {
  const input = ctx.job.input as SoundEffectInput | MusicInput
  const { request, requestHash, name, estimatedCredits, terms } = input
  const key = keyOf(ctx)
  firstAttempt(ctx)
  checkAborted(ctx.signal)
  const path = kind === 'music' ? `/v1/music?output_format=${request.outputFormat}` : `/v1/sound-generation?output_format=${request.outputFormat}`
  const body = JSON.stringify(kind === 'music' ? musicBody(request as MusicInput['request']) : soundEffectBody(request as SoundEffectInput['request']))
  const perAnswer = estimatedCredits / request.variants
  const answered: { credits: number | null; requestId: string | null }[] = []
  const assets: EditorAsset[] = []
  const notes: string[] = []
  ctx.log(`Asking the voice provider for ${request.variants} ${kind === 'music' ? 'music bed' : 'sound effect'}${request.variants === 1 ? '' : 's'} (${request.modelId})`)
  for (let i = 1; i <= request.variants; i++) {
    // Stopped: before anything was asked, nothing was spent (the job fails as stopped); after, what was made is kept.
    if (ctx.signal.aborted) {
      if (!answered.length) checkAborted(ctx.signal)
      break
    }
    const out = join(ctx.scratch, `${kind}-${i}.mp3`)
    let answer
    try {
      answer = await postForAudio(path, body, out, { key, baseUrl: ctx.config.elevenLabsUrl, contentType: 'application/json', fetch: transport })
    } catch (err) {
      if (err instanceof AnsweredButLost) {
        answered.push(err)
        notes.push(`Candidate ${i} was made and charged but could not be kept: ${err.message}.`)
        continue
      }
      if (refusedByStatus(err)) {
        if (!answered.length) throw new JobError((err as Error).message)
        notes.push(`Candidate ${i} was refused (nothing charged for it): ${(err as Error).message.slice(0, 200)}`)
        break
      }
      if (!answered.length) throw new SpendUnknown(`${(err as Error).message} It may have been charged: look in the voice provider’s history before asking for it again.`)
      notes.push(`Candidate ${i} failed on the way and may have been charged: check the voice provider’s history.`)
      break
    }
    answered.push(answer)
    try {
      const fileName = `${name}${request.variants > 1 ? ` ${i}` : ''}.mp3`.slice(0, 250)
      const description = 'text' in request ? request.text : request.prompt
      assets.push(await storeAudio(ctx, out, fileName, { [kind === 'music' ? 'music' : 'soundEffect']: { provider: 'elevenlabs', requestHash, modelId: request.modelId, description, variant: i, terms, studioJobId: ctx.job.id } }))
    } catch (err) {
      notes.push(`Candidate ${i} was made and charged but could not be kept: ${ctx.signal.aborted ? stoppedWhy(ctx, 'while it was stored') : (err as Error).message.slice(0, 200)}`)
    }
    ctx.progress(i / request.variants)
  }
  const spend = spendOf(answered, perAnswer)
  if (!assets.length) return audioUndelivered(notes.join(' ') || stoppedWhy(ctx, 'before anything was kept'), spend)
  return { assets, ...spend, ...(notes.length ? { note: notes.join(' ').slice(0, 500) } : {}) }
}

export const runSoundEffect: JobHandler<'sound-effect'> = (ctx) => runGenerated(ctx, 'sound-effect')
export const runMusic: JobHandler<'music'> = (ctx) => runGenerated(ctx, 'music')
