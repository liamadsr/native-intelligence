/**
 * ElevenLabs, with the worker's own key (ELEVENLABS_API_KEY): the account's
 * voices, and text to speech with timestamps for one exact request
 * (`/v1/text-to-speech/{voice}/with-timestamps`), the provider's character
 * alignment turned into words.
 *
 * No automatic retry, ever: an ambiguous failure can still have been charged,
 * so every error says to check the provider's history first.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProviderVoice, TtsRequest } from '../../../web/src/lib/studio/server/provider-contract.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const NEEDS_ELEVENLABS = 'Narration needs an ElevenLabs key on the studio worker (ELEVENLABS_API_KEY), and it has none.'

const ProviderAlignmentSchema = z
  .object({
    characters: z.array(z.string().min(1)).min(1),
    character_start_times_seconds: z.array(z.number().finite().min(0)).min(1),
    character_end_times_seconds: z.array(z.number().finite().min(0)).min(1),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.characters.length !== a.character_start_times_seconds.length || a.characters.length !== a.character_end_times_seconds.length) ctx.addIssue({ code: 'custom', message: 'Character and timestamp array lengths must match' })
    a.characters.forEach((text, i) => {
      if (/\s/u.test(text) && /\S/u.test(text)) ctx.addIssue({ code: 'custom', path: ['characters', i], message: 'A character entry must not mix whitespace and word text' })
      if ((a.character_end_times_seconds[i] ?? -1) < (a.character_start_times_seconds[i] ?? 0)) ctx.addIssue({ code: 'custom', path: ['character_end_times_seconds', i], message: 'Character end precedes start' })
      if (i > 0 && (a.character_start_times_seconds[i] ?? 0) < (a.character_start_times_seconds[i - 1] ?? 0)) ctx.addIssue({ code: 'custom', path: ['character_start_times_seconds', i], message: 'Character starts must be ordered' })
    })
  })
const RawAlignmentSchema = z
  .object({ alignment: ProviderAlignmentSchema.nullable(), normalized_alignment: ProviderAlignmentSchema.nullable() })
  .strict()
  .refine((v) => v.alignment !== null || v.normalized_alignment !== null, 'Provider returned no character alignment')
export type RawAlignment = z.infer<typeof RawAlignmentSchema>

type CharacterTiming = { text: string; startSeconds: number; endSeconds: number }
export type WordTiming = { text: string; startMs: number; endMs: number }

/** Characters into words: a run of non-space characters is a word, from its first start to its last end. Pure. */
export function wordsFromCharacters(characters: CharacterTiming[]): WordTiming[] {
  const words: WordTiming[] = []
  let start = -1
  const flush = (end: number) => {
    if (start < 0) return
    words.push({ text: characters.slice(start, end).map((c) => c.text).join(''), startMs: characters[start]!.startSeconds * 1000, endMs: characters[end - 1]!.endSeconds * 1000 })
    start = -1
  }
  characters.forEach((c, i) => {
    if (/^\s+$/u.test(c.text)) flush(i)
    else if (start < 0) start = i
  })
  flush(characters.length)
  if (!words.length) throw new Error('Character alignment contains no caption words')
  return words
}

/**
 * The provider's alignment, checked, as words: the normalized alignment when
 * there is one (it matches what was spoken), else the original. Also the
 * alignment as it came, written as the cache keeps it, and its sha256. Pure.
 */
export function deriveAlignment(rawInput: unknown): { raw: RawAlignment; words: WordTiming[]; rawText: string; alignmentSha256: string } {
  const parsed = RawAlignmentSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error(`ElevenLabs alignment is invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  const raw = parsed.data
  const selected = raw.normalized_alignment ?? raw.alignment!
  const characters = selected.characters.map((text, i) => ({ text, startSeconds: selected.character_start_times_seconds[i]!, endSeconds: selected.character_end_times_seconds[i]! }))
  const rawText = `${JSON.stringify(raw, null, 2)}\n`
  return { raw, words: wordsFromCharacters(characters), rawText, alignmentSha256: createHash('sha256').update(rawText).digest('hex') }
}

/** The JSON body ElevenLabs takes for a request. Pure. */
export function speechBody(request: TtsRequest): Record<string, unknown> {
  return {
    text: request.text,
    model_id: request.modelId,
    language_code: request.languageCode,
    seed: request.seed,
    apply_text_normalization: request.applyTextNormalization,
    apply_language_text_normalization: request.applyLanguageTextNormalization,
    voice_settings: {
      stability: request.voiceSettings.stability,
      similarity_boost: request.voiceSettings.similarityBoost,
      style: request.voiceSettings.style,
      use_speaker_boost: request.voiceSettings.useSpeakerBoost,
      speed: request.voiceSettings.speed,
    },
    pronunciation_dictionary_locators: request.pronunciationDictionaryLocators.map((l) => ({ pronunciation_dictionary_id: l.pronunciationDictionaryId, version_id: l.versionId })),
  }
}

export type SpeechResult = { audio: Buffer; alignment: unknown; characters: number | null; requestId: string | null }

const SpeechAnswerSchema = z
  .object({ audio_base64: z.string().min(1), alignment: ProviderAlignmentSchema.nullable().optional(), normalized_alignment: ProviderAlignmentSchema.nullable().optional() })
  .passthrough()

/** One paid request. Never retried: an ambiguous failure can have been charged. */
export async function speech(request: TtsRequest, opts: { key: string; baseUrl: string; fetch?: Fetch; signal?: AbortSignal }): Promise<SpeechResult> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
  let res: Response
  try {
    res = await doFetch(`${opts.baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/with-timestamps?output_format=${request.outputFormat}`, {
      method: 'POST',
      headers: { 'xi-api-key': opts.key, 'content-type': 'application/json' },
      body: JSON.stringify(speechBody(request)),
      signal,
    })
  } catch {
    throw new Error('ElevenLabs request failed or timed out. No automatic retry was attempted; check the ElevenLabs history before retrying.')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: { message?: string; status?: string } | string }
      detail = typeof body.detail === 'string' ? body.detail : body.detail?.message ?? body.detail?.status ?? ''
    } catch {
      // the status says enough
    }
    throw new Error(`ElevenLabs returned HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 200)})` : ''}. No automatic retry was attempted; check the key, the voice and model access, the quota and the ElevenLabs history.`)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('ElevenLabs returned malformed JSON; no automatic retry was attempted.')
  }
  const parsed = SpeechAnswerSchema.safeParse(json)
  if (!parsed.success) throw new Error('ElevenLabs answered without audio or alignment; no automatic retry was attempted.')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data.audio_base64)) throw new Error('ElevenLabs returned invalid base64 audio; no automatic retry was attempted.')
  // What the provider says it charged, when it says (its own header), else null: the caller counts the request's characters.
  const cost = Number(res.headers.get('character-cost') ?? res.headers.get('x-character-count') ?? '')
  return {
    audio: Buffer.from(parsed.data.audio_base64, 'base64'),
    alignment: { alignment: parsed.data.alignment ?? null, normalized_alignment: parsed.data.normalized_alignment ?? null },
    characters: Number.isFinite(cost) && cost > 0 ? cost : null,
    requestId: res.headers.get('request-id') ?? res.headers.get('x-request-id'),
  }
}

/** The account's voices (free). */
export async function voices(opts: { key: string; baseUrl: string; fetch?: Fetch; signal?: AbortSignal }): Promise<ProviderVoice[]> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  let res: Response
  try {
    res = await doFetch(`${opts.baseUrl}/v1/voices`, { method: 'GET', headers: { 'xi-api-key': opts.key }, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new Error(`ElevenLabs could not be reached: ${(err as Error).message}`.slice(0, 300))
  }
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status} listing the voices; check the key.`)
  const body = (await res.json().catch(() => ({}))) as { voices?: { voice_id?: unknown; name?: unknown; category?: unknown; description?: unknown; preview_url?: unknown }[] }
  return (Array.isArray(body.voices) ? body.voices : [])
    .filter((v) => typeof v.voice_id === 'string' && typeof v.name === 'string')
    .map((v) => ({
      voiceId: v.voice_id as string,
      name: v.name as string,
      ...(typeof v.category === 'string' ? { category: v.category } : {}),
      ...(typeof v.description === 'string' && v.description ? { description: v.description.slice(0, 200) } : {}),
      ...(typeof v.preview_url === 'string' && v.preview_url.startsWith('https://') ? { previewUrl: v.preview_url } : {}),
    }))
}
