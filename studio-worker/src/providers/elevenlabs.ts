/**
 * ElevenLabs, with the worker's own key (ELEVENLABS_API_KEY): the account's
 * voices, and text to speech with timestamps for one exact request
 * (`/v1/text-to-speech/{voice}/with-timestamps`), the provider's character
 * alignment turned into words. Also (the end of this file) the voice library
 * search, speech to speech (re-voicing), sound effects and music. The key
 * goes in a header only, never in an error or a log line.
 *
 * No automatic retry, ever: an ambiguous failure can still have been charged,
 * so every error says to check the provider's history first.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { FoundVoice, MusicRequest, ProviderVoice, RevoiceRequest, SoundEffectRequest, TtsRequest, VoiceSearchQuery } from '../../../web/src/lib/studio/server/provider-contract.ts'

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
  const base = checkedBase(opts.baseUrl)
  let res: Response
  try {
    res = await doFetch(`${base}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/with-timestamps?output_format=${request.outputFormat}`, {
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
    res = await doFetch(`${checkedBase(opts.baseUrl)}/v1/voices`, { method: 'GET', headers: { 'xi-api-key': opts.key }, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
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

// ---- the voice library, re-voicing, sound effects and music beds -------------------------------------------------------
//
// Shapes confirmed against the provider's published OpenAPI description (read 2026-11-12):
//   GET  /v1/shared-voices      page_size (≤100), search, gender, age, accent, language, use_cases → { voices, has_more }
//   GET  /v1/voices             the account's voices, with their labels
//   POST /v1/voice-changer/{v}  multipart: audio (file), model_id, remove_background_noise, seed → audio bytes
//   POST /v1/sound-generation   JSON: text, duration_seconds (0.5–30), prompt_influence (0–1), loop, model_id → audio bytes
//   POST /v1/music              JSON: prompt, music_length_ms (3000–600000), model_id, force_instrumental → audio bytes
// None documents a charge header; when one comes (`character-cost`, as text to speech answers) it is the charge.

/** The provider's origin, checked: https, or a server on this machine (a test's fake). Pure. */
export function checkedBase(baseUrl: string): string {
  const url = new URL(baseUrl)
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The voice provider is reached over https only (ELEVENLABS_URL).')
  return baseUrl.replace(/\/+$/, '')
}

/** What a paid request answered: the audio on disk, and what the provider said it charged and called the request. */
export type AudioAnswer = { bytes: number; credits: number | null; requestId: string | null; contentType: string | null }

/** The provider answered (and so charged) but its audio could not be kept: too big, or cut off on the way. */
export class AnsweredButLost extends Error {
  constructor(message: string, readonly credits: number | null, readonly requestId: string | null) {
    super(message)
    this.name = 'AnsweredButLost'
  }
}

/** The largest audio answer kept. */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024

/** A stream that fails once more than `max` bytes have passed through it. */
function capped(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > max) return done(new Error(`The audio is over the ${Math.round(max / 1024 ** 2)} MB the worker keeps`))
      done(null, chunk)
    },
  })
}

/** A refusal's words from the provider's error body, when it gave some. */
async function refusalDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string; msg?: string }[] | { message?: string; status?: string } | string }
    const d = Array.isArray(body.detail) ? body.detail[0] : body.detail
    return typeof d === 'string' ? d : d?.message ?? d?.status ?? (d as { msg?: string } | undefined)?.msg ?? ''
  } catch {
    return ''
  }
}

/**
 * One paid POST answered with audio bytes, streamed to `dest` under a size cap. Never retried, and never cut by a
 * job's signal once sent (a cut request may still be charged): only its own time limit ends it. Three ways out:
 *   - the request failed or timed out: an Error that says it may have been charged;
 *   - the provider refused by status: an Error naming `returned HTTP <status>` (not charged);
 *   - the provider answered but the audio was lost: AnsweredButLost (charged).
 */
export async function postForAudio(path: string, body: BodyInit, dest: string, opts: { key: string; baseUrl: string; contentType?: string; fetch?: Fetch; timeoutMs?: number; maxBytes?: number }): Promise<AudioAnswer> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 300_000)
  let res: Response
  try {
    res = await doFetch(`${checkedBase(opts.baseUrl)}${path}`, { method: 'POST', headers: { 'xi-api-key': opts.key, ...(opts.contentType ? { 'content-type': opts.contentType } : {}) }, body, signal })
  } catch {
    throw new Error('The voice provider’s request failed or timed out. No automatic retry was attempted.')
  }
  if (!res.ok) {
    const detail = await refusalDetail(res)
    throw new Error(`ElevenLabs returned HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 200)})` : ''}. No automatic retry was attempted; check the voice, the model access and the quota.`)
  }
  const said = Number(res.headers.get('character-cost') ?? res.headers.get('x-character-count') ?? '')
  const credits = Number.isFinite(said) && said > 0 ? said : null
  const requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? res.headers.get('song-id')
  const max = opts.maxBytes ?? MAX_AUDIO_BYTES
  try {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) throw new Error(`The audio is ${Math.round(declared / 1024 ** 2)} MB, over the ${Math.round(max / 1024 ** 2)} MB the worker keeps`)
    if (!res.body) throw new Error('The answer had no audio')
    await pipeline(Readable.fromWeb(res.body as never), capped(max), createWriteStream(dest))
    const bytes = (await stat(dest)).size
    if (!bytes) throw new Error('The answer had no audio')
    return { bytes, credits, requestId, contentType: res.headers.get('content-type') }
  } catch (err) {
    throw new AnsweredButLost((err as Error).message.slice(0, 300), credits, requestId)
  }
}

/** The multipart form the voice changer takes for a re-voice of `audio` (a WAV file's bytes). Pure. */
export function voiceChangerForm(request: RevoiceRequest, audio: Buffer): FormData {
  const form = new FormData()
  form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav')
  form.append('model_id', request.modelId)
  form.append('remove_background_noise', request.removeBackgroundNoise ? 'true' : 'false')
  if (request.seed !== null) form.append('seed', String(request.seed))
  return form
}

/** The path of a re-voice. Pure. */
export const voiceChangerPath = (request: RevoiceRequest) => `/v1/voice-changer/${encodeURIComponent(request.voiceId)}?output_format=${request.outputFormat}`

/** The JSON body the sound generation takes (one candidate; `variants` and `take` are never sent). Pure. */
export function soundEffectBody(request: SoundEffectRequest): Record<string, unknown> {
  return { text: request.text, duration_seconds: request.durationSeconds, prompt_influence: request.promptInfluence, loop: request.loop, model_id: request.modelId }
}

/** The JSON body music takes (one candidate; `variants` and `take` are never sent). Pure. */
export function musicBody(request: MusicRequest): Record<string, unknown> {
  return { prompt: request.prompt, music_length_ms: request.lengthMs, model_id: request.modelId, force_instrumental: request.forceInstrumental }
}

/** A text label of a voice, when it is one. Pure. */
const label = (value: unknown, max = 60) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)

/** A voice from either list, as a search answers it. Pure. */
function foundVoice(v: Record<string, unknown>, source: 'account' | 'library'): FoundVoice | null {
  if (typeof v.voice_id !== 'string' || typeof v.name !== 'string') return null
  const labels = (v.labels && typeof v.labels === 'object' ? v.labels : {}) as Record<string, unknown>
  const out: FoundVoice = { voiceId: v.voice_id, name: v.name.slice(0, 100), source }
  const extra = {
    category: label(v.category, 40), description: label(v.description, 200), gender: label(v.gender ?? labels.gender), age: label(v.age ?? labels.age),
    accent: label(v.accent ?? labels.accent), language: label(v.language ?? labels.language, 20), useCase: label(v.use_case ?? labels.use_case ?? labels['use case']),
    previewUrl: typeof v.preview_url === 'string' && v.preview_url.startsWith('https://') ? v.preview_url : undefined,
  }
  for (const [key, value] of Object.entries(extra)) if (value) (out as Record<string, unknown>)[key] = value
  return out
}

/** The query string the shared library takes. Pure. */
export function sharedVoicesQuery(q: VoiceSearchQuery): string {
  const params = new URLSearchParams({ page_size: String(Math.min(30, Math.max(1, q.pageSize))) })
  if (q.search) params.set('search', q.search)
  if (q.gender) params.set('gender', q.gender)
  if (q.age) params.set('age', q.age)
  if (q.accent) params.set('accent', q.accent)
  if (q.language) params.set('language', q.language)
  if (q.useCase) params.set('use_cases', q.useCase)
  return params.toString()
}

/** Whether an account voice matches a search's words and filters (the account list has no search of its own). Pure. */
export function matchesQuery(v: FoundVoice, q: VoiceSearchQuery): boolean {
  const words = (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hay = [v.name, v.gender, v.age, v.accent, v.useCase, v.description, v.category].join(' ').toLowerCase()
  const same = (a: string | undefined, b: string | undefined) => !b || (a ?? '').toLowerCase() === b.toLowerCase()
  return (!words.length || words.some((w) => hay.includes(w))) && same(v.gender, q.gender) && same(v.age, q.age) && same(v.accent, q.accent) && same(v.language, q.language)
}

/** Search the account's voices and the shared library (free: two reads). The account's matches come first. */
export async function searchVoices(q: VoiceSearchQuery, opts: { key: string; baseUrl: string; fetch?: Fetch; signal?: AbortSignal }): Promise<{ voices: FoundVoice[]; hasMore: boolean }> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const base = checkedBase(opts.baseUrl)
  const get = async (path: string) => {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, { method: 'GET', headers: { 'xi-api-key': opts.key }, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    } catch (err) {
      throw new Error(`The voice provider could not be reached: ${(err as Error).message}`.slice(0, 300))
    }
    if (!res.ok) throw new Error(`ElevenLabs answered ${res.status} searching the voices; check the key.`)
    return (await res.json().catch(() => ({}))) as { voices?: Record<string, unknown>[]; has_more?: unknown }
  }
  const library = await get(`/v1/shared-voices?${sharedVoicesQuery(q)}`)
  // The account's own: a failure there leaves the library's answer.
  const account = await get('/v1/voices').catch(() => ({ voices: [] as Record<string, unknown>[] }))
  const own = (account.voices ?? []).map((v) => foundVoice(v, 'account')).filter((v): v is FoundVoice => !!v && matchesQuery(v, q))
  const shared = (library.voices ?? []).map((v) => foundVoice(v, 'library')).filter((v): v is FoundVoice => !!v)
  return { voices: [...own.slice(0, 10), ...shared.slice(0, q.pageSize)], hasMore: library.has_more === true }
}
