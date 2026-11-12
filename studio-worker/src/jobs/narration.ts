/**
 * voices: the ElevenLabs account's voices, for the person to choose from.
 *
 * narration: one exact text-to-speech request (the app built it and hashed
 * it: the same request is the same audio, and the app never sends one it
 * already has). The provider answers audio and a character alignment; the
 * audio becomes a library asset (named by its sha256, as every asset is) and
 * the alignment words in milliseconds, which the app registers as the asset's
 * transcript. What the provider charged comes back with it (its own count when
 * it says one) for the Studio's cost ledger.
 *
 * Never sent twice: a job that was interrupted and handed out again (a worker
 * that stopped mid-request) refuses rather than pay a second time. Never lost
 * once answered: whatever goes wrong after ElevenLabs answered (or a cancel
 * then) comes back as an `undelivered` answer with the charge, which the runner
 * completes.
 */
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NarrationUndelivered, NarrationWorkerResult, VoicesResult } from '../../../web/src/lib/studio/server/provider-contract.ts'
import { buildAsset, inspectFile, publishAsset } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { deriveAlignment, NEEDS_ELEVENLABS, speech, voices, type Fetch } from '../providers/elevenlabs.ts'
import { checkAborted, JobError, SpendUnknown, type JobHandler } from './context.ts'

/** A test's fake provider transport (the real one is fetch). */
let transport: Fetch | undefined
export function useElevenLabsFetch(f: Fetch | undefined): void {
  transport = f
}

export const INTERRUPTED =
  'This narration was interrupted after its request may have reached ElevenLabs, so it is not sent again on its own. Check the ElevenLabs history, then press Generate again.'

export const runVoices: JobHandler<'voices'> = async (ctx): Promise<VoicesResult> => {
  const key = ctx.config.elevenLabsKey
  if (!key) throw new JobError(NEEDS_ELEVENLABS)
  ctx.log('Listing the ElevenLabs voices')
  try {
    return { voices: await voices({ key, baseUrl: ctx.config.elevenLabsUrl, fetch: transport, signal: ctx.signal }) }
  } catch (err) {
    throw new JobError((err as Error).message)
  }
}

/**
 * The answer for a narration ElevenLabs answered (and charged) that could not be kept: the charge and a sentence. It
 * goes back as the job's result (the runner completes it, stopped or not), typed as the job's result until the
 * contract's narration result names it (provider-contract.ts NarrationUndelivered).
 */
export function narrationUndelivered(why: string, characters: number, fromProvider: boolean, requestId?: string | null): NarrationUndelivered {
  const out: NarrationUndelivered = {
    outcome: 'undelivered',
    error: `ElevenLabs made this narration (and charged ${characters} characters) but it could not be kept: ${why.slice(0, 300)} It is not requested again on its own.`,
    characters,
    charactersFrom: fromProvider ? 'provider' : 'request',
    ...(requestId ? { providerRequestId: requestId } : {}),
  }
  return out
}

export const runNarration: JobHandler<'narration'> = async (ctx): Promise<NarrationWorkerResult | NarrationUndelivered> => {
  const { request, requestHash, voiceName, name } = ctx.job.input
  const key = ctx.config.elevenLabsKey
  if (!key) throw new JobError(NEEDS_ELEVENLABS)
  if (ctx.job.attempts > 1) throw new JobError(INTERRUPTED)
  ctx.log(`Asking ElevenLabs for ${request.text.length} characters in ${voiceName}'s voice (${request.modelId})`)
  ctx.progress(0.05)
  checkAborted(ctx.signal)
  // Once sent, the request is never cut by the job's signal (a cut request may still be charged): it runs to its
  // answer or its own time limit, and a stop is looked at after.
  let result
  try {
    result = await speech(request, { key, baseUrl: ctx.config.elevenLabsUrl, fetch: transport })
  } catch (err) {
    const message = (err as Error).message
    // A refusal by status was not charged; a request that failed or timed out may have been.
    if (/returned HTTP \d+/.test(message)) throw new JobError(message)
    throw new SpendUnknown(`${message} It may have been charged: look in the ElevenLabs history before generating this narration again.`)
  }
  // Answered, so charged: from here on every way out carries the charge, and nothing throws for a cancel.
  const characters = result.characters ?? request.text.length
  const lost = (why: string) => narrationUndelivered(why, characters, !!result.characters, result.requestId)
  if (ctx.signal.aborted) return lost(`the job was stopped as the audio arrived (${String((ctx.signal.reason as Error)?.message ?? 'cancelled').slice(0, 160)}).`)
  try {
    ctx.progress(0.6)
    let derived
    try {
      derived = deriveAlignment(result.alignment)
    } catch (err) {
      return lost(`${(err as Error).message}.`)
    }
    const fileName = (name.replace(/\.[^.]+$/, '') || 'Narration') + '.mp3'
    const audio = join(ctx.scratch, 'narration.mp3')
    await writeFile(audio, result.audio)
    const { measured, waveform } = await inspectFile(audio, fileName, ctx.signal)
    if (measured.kind !== 'audio' || !(measured.durationSeconds! > 0)) return lost('the audio it returned cannot be read.')
    if (derived.words.some((w) => w.endMs > measured.durationSeconds! * 1000 + 50)) return lost('the word timings run past the audio.')
    const sha256 = await fileSha256(audio)
    const asset = buildAsset(measured, { sha256, bytes: (await stat(audio)).size }, {
      name: fileName,
      waveform,
      provenance: { narration: { provider: 'elevenlabs', requestHash, voiceId: request.voiceId, modelId: request.modelId, characters, studioJobId: ctx.job.id } },
    })
    ctx.progress(0.8)
    ctx.log(`Storing ${asset.file} (${measured.durationSeconds!.toFixed(2)} s, ${derived.words.length} words)`)
    await publishAsset(ctx, asset, audio)
    ctx.progress(1)
    return {
      asset,
      text: request.text,
      words: derived.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
      alignmentSha256: derived.alignmentSha256,
      characters,
      charactersFrom: result.characters ? 'provider' : 'request',
      ...(result.requestId ? { providerRequestId: result.requestId } : {}),
    }
  } catch (err) {
    return lost(ctx.signal.aborted ? `the job was stopped while it was stored (${String((ctx.signal.reason as Error)?.message ?? 'cancelled').slice(0, 160)}).` : `${(err as Error).message.slice(0, 300)}.`)
  }
}
