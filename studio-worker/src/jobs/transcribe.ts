/**
 * transcribe: an asset's speech as timed words, from Deepgram's prerecorded API
 * (nova-3, smart formatting, punctuation, a time for every word). The fallback
 * path: the person's desktop app transcribes on their own machine first.
 *
 * The first audio stream is taken out as 16 kHz mono (FLAC, half the bytes of
 * WAV and lossless) and sent as it is. No audio stream: `no-audio`. No words:
 * `no-speech`. Otherwise a transcript exactly as the engine's TranscriptSchema
 * takes it: its id from what was asked and what came back (the same audio, model
 * and answer give the same id), word ids from that, times in milliseconds of the
 * source, clamped to it.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { EditorAsset, EditorTranscript } from '../../../web/src/lib/studio/engine/contracts.ts'
import { TranscriptSchema } from '../engine.ts'
import type { TranscribeResult } from '../../../web/src/lib/studio/server/job-contract.ts'
import { stageAssets } from '../assets.ts'
import { mediaTimeout, probe, run } from '../media.ts'
import { checkAborted, JobError, stage, type JobHandler } from './context.ts'

export const NEEDS_DEEPGRAM = 'Transcribing on the server needs a Deepgram key on the studio worker (DEEPGRAM_API_KEY), and it has none.'

/** JSON with every object's keys in order, so equal values give equal text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Canonical values cannot contain undefined')
  return encoded
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** What is asked of Deepgram. */
export function deepgramParams(language?: string): Record<string, string> {
  return {
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    ...(language ? { language } : { detect_language: 'true' }),
  }
}

interface DeepgramWord {
  word?: string
  punctuated_word?: string
  start?: number
  end?: number
}
interface DeepgramAnswer {
  results?: { channels?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] }[] }
}

/**
 * Deepgram's answer as the engine's transcript, or null when it heard no word.
 * Words keep Deepgram's order; a start before the previous one is raised to it
 * (the schema wants them in order), and every time stays inside the source. Pure.
 */
export function toTranscript(answer: DeepgramAnswer, asset: Pick<EditorAsset, 'id' | 'sha256' | 'durationSeconds'>, requestHash: string): EditorTranscript | null {
  const alt = answer.results?.channels?.[0]?.alternatives?.[0]
  const limitMs = Math.max(0, (asset.durationSeconds ?? Number.POSITIVE_INFINITY) * 1000)
  const clamp = (ms: number) => Math.max(0, Math.min(limitMs, ms))
  const words: { text: string; startMs: number; endMs: number }[] = []
  let previous = 0
  for (const w of alt?.words ?? []) {
    const text = (w.punctuated_word ?? w.word ?? '').trim().slice(0, 500)
    if (!text || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    const startMs = Math.max(previous, clamp(Math.round(w.start! * 1000)))
    const endMs = Math.max(startMs, clamp(Math.round(w.end! * 1000)))
    words.push({ text, startMs, endMs })
    previous = startMs
  }
  if (words.length === 0) return null
  const text = (alt?.transcript?.trim() || words.map((w) => w.text).join(' ')).slice(0, 200_000)
  const alignment = { text, words: words.slice(0, 40_000) }
  const alignmentSha256 = sha256(stableStringify(alignment))
  const id = sha256(stableStringify({ sourceSha256: asset.sha256, requestHash, alignmentSha256 }))
  return TranscriptSchema.parse({
    id,
    assetId: asset.id,
    sourceSha256: asset.sha256,
    label: 'Transcript',
    // The schema names no Deepgram origin; 'imported' is the one for text that came from elsewhere.
    origin: 'imported',
    alignmentSha256,
    text: alignment.text,
    words: alignment.words.map((w, i) => ({ ...w, id: `w-${id.slice(0, 20)}-${i}` })),
  })
}

export const runTranscribe: JobHandler<'transcribe'> = async (ctx): Promise<TranscribeResult> => {
  const { asset, language } = ctx.job.input
  if (!asset.hasAudio) return { outcome: 'no-audio' }
  const key = ctx.config.deepgramKey
  if (!key) throw new JobError(NEEDS_DEEPGRAM)
  const release = await stageAssets(ctx, [asset], stage(ctx, 0, 0.3))
  try {
    const source = ctx.cache.pathOf(asset.file)
    const p = await probe(source, { signal: ctx.signal })
    if (!p.streams.some((s) => s.codec_type === 'audio')) return { outcome: 'no-audio' }
    const audio = join(ctx.scratch, 'speech.flac')
    ctx.log('Extracting the sound (16 kHz mono)')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', audio], {
      timeout: mediaTimeout(asset.durationSeconds ?? 3600, 1),
      signal: ctx.signal,
    })
    ctx.progress(0.45)
    checkAborted(ctx.signal)

    const params = deepgramParams(language)
    const url = new URL(ctx.config.deepgramUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    ctx.log('Sending the sound to Deepgram (nova-3)')
    const bytes = (await stat(audio)).size
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Token ${key}`, 'content-type': 'audio/flac', 'content-length': String(bytes) },
        body: Readable.toWeb(createReadStream(audio)) as ReadableStream,
        duplex: 'half',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(10 * 60_000, (asset.durationSeconds ?? 0) * 1000))]),
      } as RequestInit & { duplex: 'half' })
    } catch (err) {
      checkAborted(ctx.signal)
      throw new JobError(`Deepgram could not be reached: ${(err as Error).message}`.slice(0, 300))
    }
    const body = await res.text()
    if (!res.ok) {
      let detail = ''
      try {
        const e = JSON.parse(body) as { err_msg?: string; reason?: string }
        detail = e.err_msg ?? e.reason ?? ''
      } catch {
        // the status says enough
      }
      throw new JobError(`Deepgram answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    ctx.progress(0.9)
    let answer: DeepgramAnswer
    try {
      answer = JSON.parse(body) as DeepgramAnswer
    } catch {
      throw new JobError('Deepgram answered something that is not JSON')
    }
    const transcript = toTranscript(answer, asset, sha256(stableStringify({ provider: 'deepgram', ...params })))
    if (!transcript) return { outcome: 'no-speech' }
    ctx.log(`${transcript.words.length} words`)
    return { outcome: 'transcribed', transcript }
  } finally {
    release()
  }
}
