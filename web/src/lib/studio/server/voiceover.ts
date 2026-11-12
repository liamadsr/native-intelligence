// Narration in a chosen voice: text to speech with word timings (ElevenLabs), as a library asset with its words
// registered as a transcript, ready for the editor's "Rewrite voiceover" (its staged result is the engine's
// VoiceoverResult: transcript.ts applyVoiceover).
//
// The voice is the workspace's choice (studio_record `voice`/`default`): the provider's voice id, its name, the
// model, optional settings and pronunciation substitutions ("Acme" read as "Ack me"). The account's voices are
// listed through a quick worker job and kept an hour (`voice`/`list`).
//
// The same text in the same voice, model and settings is the same audio: the request, written in a fixed key order,
// is hashed, and that hash keys the narration cache (studio_record `narration`/<hash>: the asset and transcript it
// made). A cached narration is never paid for again; an uncached one is made only when the person said so
// (`allowPaid`), by a `narration` job the worker runs with its own key, and every paid one is a charge in the
// Studio's ledger (costs.ts) with the provider's character count. Two asks for one request while it is being made
// share the one job.
import type { EditorTranscript } from '../engine/contracts'
import type { VoiceoverResult } from '../engine/transcript'
import { getAssets, registerAsset, registerTranscript, toTranscript } from './assets'
import { currentCapabilities, requireCapability } from './capabilities'
import { isUuid, must, type StudioContext } from './context'
import { recordCharge } from './costs'
import { StudioError } from './errors'
import { ownAsset, queueJob, waitForJob, type JobRow } from './jobs'
import { TtsRequestSchema, VoiceSettingsSchema, type NarrationInput, type NarrationUndelivered, type NarrationWorkerResult, type ProviderVoice, type TtsRequest, type VoiceSettings, type VoicesResult } from './provider-contract'
import { getRecord, getRecords, putRecord } from './records'
import { saveVersion } from './versions'
import { openVideo, saveVideo } from './videos'
import { sha256Hex, stableStringify } from './stable'

export const VOICE_COLLECTION = 'voice'
export const NARRATION_COLLECTION = 'narration'
const VOICE_KEY = 'default'
const VOICES_KEY = 'list'

/** How long the account's voice list is kept before it is read again. */
export const VOICES_FRESH_MS = 60 * 60_000

// What a voice reads with when the workspace set nothing else. These were the local product's settings; the
// provider's own defaults may change, and the workspace can override each one.
export const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'
export const DEFAULT_SETTINGS: VoiceSettings = { stability: 0.55, similarityBoost: 0.75, style: 0.1, useSpeakerBoost: true, speed: 1 }
const DEFAULT_REQUEST = { languageCode: 'en' as string | null, seed: 8 as number | null, applyTextNormalization: 'off' as const }

/** The workspace's narration voice. */
export type StudioVoice = {
  provider: 'elevenlabs'
  voiceId: string
  name: string
  modelId: string
  settings?: Partial<VoiceSettings> & { seed?: number | null; languageCode?: string | null; applyTextNormalization?: 'auto' | 'on' | 'off' }
  /** Words read differently: { "Acme": "Ack me" } (whole words, case as written). */
  substitutions?: Record<string, string>
}

/** The cache's record of one request: what it made. */
type NarrationRecord = { requestHash: string; assetId: string; transcriptId: string; characters: number; voiceId: string; modelId: string; at: string }

// ---- the request ---------------------------------------------------------------------------------------------------

/** The text as it is spoken: each substitution replaces its whole word. Pure. */
export function spokenText(text: string, substitutions: Record<string, string> = {}): string {
  let spoken = text
  for (const [term, replacement] of Object.entries(substitutions)) {
    if (!term) continue
    spoken = spoken.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), () => replacement)
  }
  return spoken
}

/** The exact request for a text in a voice. Pure. */
export function makeTtsRequest(voice: StudioVoice, text: string): TtsRequest {
  const s = voice.settings ?? {}
  return TtsRequestSchema.parse({
    provider: 'elevenlabs',
    endpoint: 'text-to-speech/with-timestamps',
    requestVersion: 1,
    voiceId: voice.voiceId,
    modelId: voice.modelId || DEFAULT_MODEL_ID,
    outputFormat: 'mp3_44100_128',
    languageCode: s.languageCode === undefined ? DEFAULT_REQUEST.languageCode : s.languageCode,
    seed: s.seed === undefined ? DEFAULT_REQUEST.seed : s.seed,
    applyTextNormalization: s.applyTextNormalization ?? DEFAULT_REQUEST.applyTextNormalization,
    applyLanguageTextNormalization: false,
    voiceSettings: {
      stability: s.stability ?? DEFAULT_SETTINGS.stability,
      similarityBoost: s.similarityBoost ?? DEFAULT_SETTINGS.similarityBoost,
      style: s.style ?? DEFAULT_SETTINGS.style,
      useSpeakerBoost: s.useSpeakerBoost ?? DEFAULT_SETTINGS.useSpeakerBoost,
      speed: s.speed ?? DEFAULT_SETTINGS.speed,
    },
    pronunciationDictionaryLocators: [],
    text,
  })
}

/** The cache key: the same text, voice, model and settings give the same hash, whatever order anything was written in. Pure. */
export const requestHash = (request: TtsRequest) => sha256Hex(stableStringify(request))

/** A draft checked as narration text (1 to 20,000 characters once trimmed). Pure. */
export function narrationText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new StudioError('Write the narration first.')
  const text = value.trim()
  if (text.length > 20_000) throw new StudioError('Narration is at most 20,000 characters.')
  return text
}

/** The request for a draft in a voice, its hash and how many characters it sends. Pure. */
export function narrationRequest(voice: StudioVoice, value: unknown) {
  const request = makeTtsRequest(voice, spokenText(narrationText(value), voice.substitutions))
  return { request, requestHash: requestHash(request), characters: request.text.length }
}

// ---- the voice -----------------------------------------------------------------------------------------------------

/** The workspace's voice, or null when none is chosen. */
export async function getVoice(ctx: StudioContext): Promise<StudioVoice | null> {
  return getRecord<StudioVoice>(ctx, VOICE_COLLECTION, VOICE_KEY)
}

async function voiceOrRefuse(ctx: StudioContext): Promise<StudioVoice> {
  const voice = await getVoice(ctx)
  if (!voice) throw new StudioError('Choose a voice for narration first.', 400, 'NO_VOICE')
  return voice
}

/** A voice choice checked (the voice id, and the name, model, settings and substitutions when given). */
export function checkVoice(body: Record<string, unknown>, known: ProviderVoice[] = []): StudioVoice {
  const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : ''
  if (!voiceId || voiceId.length > 200 || !/^[\w-]+$/.test(voiceId)) throw new StudioError('Choose a voice.')
  const listed = known.find((v) => v.voiceId === voiceId)
  const name = (typeof body.name === 'string' && body.name.trim()) || listed?.name || voiceId
  const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : DEFAULT_MODEL_ID
  if (modelId.length > 200 || !/^[\w.-]+$/.test(modelId)) throw new StudioError('That model id is not valid.')
  const voice: StudioVoice = { provider: 'elevenlabs', voiceId, name: name.slice(0, 100), modelId }
  if (body.settings !== undefined && body.settings !== null) {
    if (typeof body.settings !== 'object') throw new StudioError('Voice settings are an object.')
    const raw = body.settings as Record<string, unknown>
    const parsed = VoiceSettingsSchema.partial().safeParse(Object.fromEntries(Object.entries(raw).filter(([k]) => k in VoiceSettingsSchema.shape)))
    if (!parsed.success) throw new StudioError('Voice settings are out of range (stability, similarity and style 0–1, speed 0.7–1.2).')
    const settings: StudioVoice['settings'] = { ...parsed.data }
    if (raw.seed === null || (Number.isInteger(raw.seed) && (raw.seed as number) >= 0 && (raw.seed as number) <= 4_294_967_295)) settings.seed = raw.seed as number | null
    if (raw.languageCode === null || (typeof raw.languageCode === 'string' && /^[a-z]{2,3}$/.test(raw.languageCode))) settings.languageCode = raw.languageCode as string | null
    if (raw.applyTextNormalization === 'auto' || raw.applyTextNormalization === 'on' || raw.applyTextNormalization === 'off') settings.applyTextNormalization = raw.applyTextNormalization
    if (Object.keys(settings).length) voice.settings = settings
  }
  if (body.substitutions !== undefined && body.substitutions !== null) {
    if (typeof body.substitutions !== 'object' || Array.isArray(body.substitutions)) throw new StudioError('Substitutions are words and how to read them.')
    const entries = Object.entries(body.substitutions as Record<string, unknown>).filter(([k, v]) => k.trim() && typeof v === 'string')
    if (entries.length > 200 || entries.some(([k, v]) => k.length > 100 || (v as string).length > 200)) throw new StudioError('Up to 200 substitutions, each a word up to 100 characters.')
    if (entries.length) voice.substitutions = Object.fromEntries(entries.map(([k, v]) => [k.trim(), v as string]))
  }
  return voice
}

/** PUT /voiceover/voice: save the workspace's voice. */
export async function saveVoice(ctx: StudioContext, body: Record<string, unknown>): Promise<StudioVoice> {
  const listed = await getRecord<{ at: string; voices: ProviderVoice[] }>(ctx, VOICE_COLLECTION, VOICES_KEY)
  const voice = checkVoice(body, listed?.voices ?? [])
  await putRecord(ctx, VOICE_COLLECTION, VOICE_KEY, voice)
  return voice
}

/** GET /voiceover: the voice (or none), in the editor's words, and whether narration can be made right now. */
export async function voiceoverInfo(ctx: StudioContext) {
  const voice = await getVoice(ctx)
  return { voice, voiceName: voice?.name ?? '', voiceId: voice?.voiceId ?? '', modelId: voice?.modelId ?? '', available: currentCapabilities(ctx).voiceover }
}

/**
 * GET /voiceover/voices: the account's voices, kept an hour. A fresh list is read through a quick worker job; with no
 * worker to read it, the last list (however old) is answered, else the refusal.
 */
export async function listVoices(ctx: StudioContext, options: { refresh?: boolean; waitMs?: number } = {}): Promise<{ voices: ProviderVoice[]; at: string }> {
  // The voices are the provider account's (cloned ones too): only a workspace that may use it reads them.
  requireCapability(ctx, 'voiceover', { worker: false })
  const kept = await getRecord<{ at: string; voices: ProviderVoice[] }>(ctx, VOICE_COLLECTION, VOICES_KEY)
  const fresh = kept && Date.now() - Date.parse(kept.at) < VOICES_FRESH_MS
  if (kept && (fresh || !currentCapabilities(ctx).voiceover) && !options.refresh) return kept
  requireCapability(ctx, 'voiceover')
  const job = await queueJob(ctx, 'voices', { provider: 'elevenlabs' })
  const done = await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? 30_000, everyMs: 500 })
  if (done.status === 'completed') return (await getRecord<{ at: string; voices: ProviderVoice[] }>(ctx, VOICE_COLLECTION, VOICES_KEY)) ?? { at: new Date().toISOString(), voices: [] }
  if (done.status === 'failed' || done.status === 'cancelled') throw new StudioError(done.error ?? 'Listing the voices failed.', 502, 'PROVIDER')
  if (kept) return kept
  throw new StudioError('The Studio worker is busy; try listing the voices again in a moment.', 503, 'BUSY')
}

// ---- the cache -----------------------------------------------------------------------------------------------------

/** The narration a request already made (its asset and transcript still registered), or null. */
export async function cachedNarration(ctx: StudioContext, hash: string): Promise<VoiceoverResult | null> {
  const record = await getRecord<NarrationRecord>(ctx, NARRATION_COLLECTION, hash)
  if (!record) return null
  const asset = (await getAssets(ctx, [record.assetId])).get(record.assetId)
  const transcript = (await getRecords<EditorTranscript>(ctx, 'transcripts', [record.transcriptId])).get(record.transcriptId)
  if (!asset || !transcript) return null
  return { asset, transcript, cached: true, requestHash: hash }
}

/** POST /voiceover/preview: the request's hash, how many characters it sends, and whether this exact one is cached. */
export async function previewNarration(ctx: StudioContext, text: unknown) {
  requireCapability(ctx, 'voiceover', { worker: false })
  const voice = await voiceOrRefuse(ctx)
  const { request, requestHash: hash, characters } = narrationRequest(voice, text)
  const cached = !!(await cachedNarration(ctx, hash))
  return { cached, characters, requestHash: hash, voiceName: voice.name, voiceId: request.voiceId, modelId: request.modelId }
}

const JOB_FIELDS = 'id, workspace_id, video_id, kind, status, progress, logs, input, result, error, cancel_requested, worker_id, attempts, created_by, created_at, updated_at'

/** The narration job for this request still queued or running, if any. */
async function runningNarration(ctx: StudioContext, hash: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', 'narration').in('status', ['queued', 'running']).eq('input->>requestHash', hash).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/** Asks in flight in this process, so two at once for one request queue one job. */
const starting = new Map<string, Promise<{ result: VoiceoverResult } | { job: JobRow }>>()

/** What the replay of an approval card answers when the request is no longer the one the card showed. */
export const NARRATION_CHANGED = 'Nothing was spent. The voice or script changed since you approved: ask again.'

/**
 * The narration for a draft: the cached one when this exact request was made before (never paid again), else, only
 * with `allowPaid`, the job that makes it (the one already running for this request, or a new one). `expectHash`
 * (an approval card's pinned request) refuses (409 CARD_CHANGED) a request that is no longer that one: the voice,
 * its model or its substitutions changed since.
 */
export function startNarration(ctx: StudioContext, text: unknown, options: { allowPaid: boolean; videoId?: string | null; expectHash?: string }): Promise<{ result: VoiceoverResult } | { job: JobRow }> {
  return (async () => {
    requireCapability(ctx, 'voiceover', { worker: false })
    const voice = await voiceOrRefuse(ctx)
    const { request, requestHash: hash } = narrationRequest(voice, text)
    if (options.expectHash !== undefined && options.expectHash !== hash) throw new StudioError(NARRATION_CHANGED, 409, 'CARD_CHANGED')
    const slot = `${ctx.workspaceId}:${hash}`
    const inFlight = starting.get(slot)
    if (inFlight) return inFlight
    const work = (async () => {
      const cached = await cachedNarration(ctx, hash)
      if (cached) return { result: cached }
      if (!options.allowPaid) throw new StudioError('This narration is not cached. Generating it uses ElevenLabs credits, so it needs your explicit Generate.', 402, 'NEEDS_APPROVAL')
      const running = await runningNarration(ctx, hash)
      if (running) return { job: running }
      // Paid for but not delivered, and its sentence not read yet: that answer, never a second request unseen.
      const undelivered = await unreadUndelivered(ctx, hash)
      if (undelivered) return { job: undelivered }
      requireCapability(ctx, 'voiceover')
      const input: NarrationInput = { request, requestHash: hash, voiceName: voice.name, name: `${voice.name} narration.mp3`.slice(0, 250) }
      return { job: await queueJob(ctx, 'narration', input, options.videoId && isUuid(options.videoId) ? options.videoId : null) }
    })().finally(() => starting.delete(slot))
    starting.set(slot, work)
    return work
  })()
}

/** How long a narration paid for but not delivered is answered with its sentence until it has been read. */
const UNDELIVERED_KEPT_MS = 24 * 3600_000

/** The latest narration job for this request that was paid for, not delivered, and whose sentence nobody has read. */
async function unreadUndelivered(ctx: StudioContext, hash: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', 'narration').eq('status', 'completed').eq('input->>requestHash', hash)
      .eq('result->>outcome', 'undelivered').is('result->>shown', null).gte('updated_at', new Date(Date.now() - UNDELIVERED_KEPT_MS).toISOString()).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/** True when a finished narration job's result is the worker's "paid for, not delivered" (NarrationUndelivered). Pure. */
export const isUndelivered = (result: unknown): result is NarrationUndelivered =>
  !!result && typeof result === 'object' && (result as { outcome?: unknown }).outcome === 'undelivered'

/**
 * A finished narration job's answer, or the refusal it ended with; null while it still runs. Paid for but not
 * delivered (the worker's sentence) is a refusal too (502 UNDELIVERED): there is no audio to stage.
 */
export function narrationOutcome(row: JobRow): VoiceoverResult | null {
  if (row.status === 'completed') {
    if (isUndelivered(row.result)) throw new StudioError(String(row.result.error), 502, 'UNDELIVERED')
    return row.result as unknown as VoiceoverResult
  }
  if (row.status === 'failed' || row.status === 'cancelled') throw new StudioError(row.error ?? 'Generating the narration failed.', 502, 'PROVIDER')
  return null
}

/**
 * narrationOutcome, for an answer the person (or the agent) is about to read: a "not delivered" sentence is marked
 * read, so the next Generate of the same text is a new request (it asks again only once that sentence was seen).
 */
export async function narrationAnswer(ctx: StudioContext, row: JobRow): Promise<VoiceoverResult | null> {
  if (row.status === 'completed' && isUndelivered(row.result) && !(row.result as { shown?: unknown }).shown) {
    must(await ctx.supabase.from('studio_job').update({ result: { ...row.result, shown: true } }).eq('workspace_id', ctx.workspaceId).eq('id', row.id), 'record the answer')
  }
  return narrationOutcome(row)
}

/**
 * POST /voiceover/generate {text, allowPaid, projectId?}: the editor's staged result. A new narration takes a while:
 * the request waits on its job; still running at the end of the wait, it says so (pressing Generate again picks up
 * the same job, never a second one).
 */
export async function generateNarration(ctx: StudioContext, body: Record<string, unknown>, options: { waitMs?: number } = {}): Promise<VoiceoverResult> {
  if (typeof body.allowPaid !== 'boolean') throw new StudioError('Choose whether to explicitly allow an uncached narration request.')
  const started = await startNarration(ctx, body.text, { allowPaid: body.allowPaid, videoId: typeof body.projectId === 'string' ? body.projectId : null })
  if ('result' in started) return started.result
  const done = await narrationAnswer(ctx, await waitForJob(ctx, started.job.id, { timeoutMs: options.waitMs ?? 100_000, everyMs: 1000 }))
  if (done) return done
  throw new StudioError('The narration is still being generated. Press Generate again in a moment to pick up the same request: it is not sent or paid for twice.', 409, 'STILL_RUNNING')
}

// ---- filing what the worker made -------------------------------------------------------------------------------------

/** A finished `voices` job: the list is kept for an hour. */
export async function fileVoices(ctx: StudioContext, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const voices = (Array.isArray((raw as VoicesResult).voices) ? (raw as VoicesResult).voices : [])
    .filter((v) => v && typeof v.voiceId === 'string' && typeof v.name === 'string')
    .slice(0, 500)
    .map((v) => ({ voiceId: v.voiceId.slice(0, 200), name: v.name.slice(0, 100), ...(v.category ? { category: String(v.category).slice(0, 40) } : {}), ...(v.description ? { description: String(v.description).slice(0, 200) } : {}), ...(v.previewUrl && /^https:\/\//.test(v.previewUrl) ? { previewUrl: v.previewUrl.slice(0, 500) } : {}) }))
  await putRecord(ctx, VOICE_COLLECTION, VOICES_KEY, { at: new Date().toISOString(), voices })
  return { voices }
}

/**
 * The charge of a narration the worker finished: the provider's character count (else the text's), keyed by the job
 * so recording it twice records it once. Also called for a result that arrives after the job was taken back (jobs.ts).
 */
export async function recordNarrationCharge(ctx: StudioContext, row: Pick<JobRow, 'id' | 'video_id' | 'input'>, out: { characters?: unknown; charactersFrom?: unknown; providerRequestId?: unknown }): Promise<void> {
  const input = row.input as unknown as NarrationInput
  const said = Number(out.characters) > 0
  const characters = said ? Number(out.characters) : input.request.text.length
  // The provider's own count when it gave one; otherwise the request's length, marked as estimated.
  const estimated = !said || out.charactersFrom === 'request'
  await recordCharge(ctx, {
    provider: 'elevenlabs',
    credits: characters,
    model: input.request.modelId,
    kind: 'voice',
    videoId: row.video_id,
    jobId: row.id,
    ...(out.providerRequestId ? { providerJobId: String(out.providerRequestId).slice(0, 120) } : {}),
    detail: `${estimated ? "Estimated from the request's length. " : ''}${input.voiceName}: ${input.request.text}`,
    ...(estimated ? { estimated: true as const } : {}),
  })
}

/**
 * A finished `narration` job: the charge recorded, then the audio registered, its words registered as the asset's
 * transcript, and the request cached. Answers the editor's VoiceoverResult, kept on the job. One paid for and not
 * delivered (NarrationUndelivered) keeps only the charge and the worker's sentence: no asset, no cache, nothing placed.
 */
export async function fileNarration(ctx: StudioContext, row: Pick<JobRow, 'id' | 'video_id' | 'input'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as NarrationInput
  const out = raw as unknown as NarrationWorkerResult
  // The provider was paid once the worker has a result: the charge is recorded first, whatever else is refused.
  await recordNarrationCharge(ctx, row, out)
  // Paid for, not delivered: the charge and the worker's sentence; nothing registered, cached or placed.
  if (isUndelivered(raw)) {
    const characters = Number(raw.characters) > 0 ? Number(raw.characters) : input.request.text.length
    return {
      outcome: 'undelivered',
      error: String(raw.error || 'ElevenLabs made this narration but it could not be kept. Check the costs and the ElevenLabs history before generating it again.').slice(0, 1000),
      characters,
      charactersFrom: raw.charactersFrom === 'provider' ? 'provider' : 'request',
      ...(raw.providerRequestId ? { providerRequestId: String(raw.providerRequestId).slice(0, 120) } : {}),
    } satisfies NarrationUndelivered
  }
  const parsed = await ownAsset(ctx, out.asset, 'narration audio')
  if (parsed.kind !== 'audio' || !parsed.hasAudio) throw new StudioError('The narration is not an audio file.')
  if (!Array.isArray(out.words) || !out.words.length || typeof out.alignmentSha256 !== 'string') throw new StudioError('The narration came back without word timings.')
  const asset = await registerAsset(ctx, parsed)
  const transcript = await registerTranscript(
    ctx,
    toTranscript(asset, { words: out.words, text: typeof out.text === 'string' ? out.text : input.request.text }, 'elevenlabs-generated', out.alignmentSha256, `${input.voiceName} narration`.slice(0, 250), input.voiceName.slice(0, 100)),
  )
  const characters = Number(out.characters) > 0 ? Number(out.characters) : input.request.text.length
  await putRecord(ctx, NARRATION_COLLECTION, input.requestHash, {
    requestHash: input.requestHash, assetId: asset.id, transcriptId: transcript.id, characters, voiceId: input.request.voiceId, modelId: input.request.modelId, at: new Date().toISOString(),
  } satisfies NarrationRecord)
  return { asset, transcript, cached: false, requestHash: input.requestHash } satisfies VoiceoverResult
}

// ---- placing it (the agent's path; the editor stages and applies it itself) --------------------------------------

/**
 * Put a narration over a whole video's footage, as the editor's "Apply" does: it replaces the voiceover there and
 * mutes the clips' own sound; `keep-footage` refuses a narration longer than the footage, `hold-last-frame` holds the
 * last frame for the difference. Keeps the version before it and saves against the digest.
 */
export async function placeNarration(ctx: StudioContext, videoId: string, result: VoiceoverResult, policy: 'keep-footage' | 'hold-last-frame'): Promise<{ projectDigest: string }> {
  const { applyVoiceover } = await import('../engine/transcript')
  const opened = await openVideo(ctx, videoId)
  let next
  try {
    next = applyVoiceover(opened.project, result, [], policy)
  } catch (error) {
    throw new StudioError(error instanceof Error ? error.message : String(error))
  }
  await saveVersion(ctx, videoId, 'project', 'Before a narration', opened.project).catch(() => null)
  return { projectDigest: (await saveVideo(ctx, next, opened.projectDigest)).projectDigest }
}
