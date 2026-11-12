// More of the voice provider than narration (voiceover.ts), on the same key the Studio worker holds and the same
// capability (`voiceover`): searching its voice library, re-voicing a recorded or generated line into another voice
// with its timing kept (speech to speech), designed sound effects from a description, and music beds from one.
//
// Searching is a read (free): a quick `voice-search` job the request waits on; the voices it finds are kept
// (studio_record `voice`/`found`) so one can be chosen by its id (voiceover.ts saveVoice) or read a cast member's line
// (startNarration's `voiceId`). Choosing one stores only its id in the Studio: the provider account is unchanged.
//
// The three that spend are made the narration way:
//   - the exact request is built here and hashed (stable key order); that hash is the cache key and what an approval
//     card pins, so a replay whose fresh request differs spends nothing (409 CARD_CHANGED);
//   - a request already made is answered from the cache (studio_record `revoice` / `sound-effect` / `music`, keyed by
//     the hash): never paid for twice; an uncached one is queued only with `allowPaid`, and two asks for one request
//     while it is made share the one job;
//   - a job paid for but not delivered answers its worker's sentence (502 UNDELIVERED) until it has been read, and
//     never queues a second request unseen;
//   - filing records the charge first (the provider's own count when it gave one, else the Studio's estimate, marked
//     so), then checks every asset against what the job stored (ownAsset) before any is registered; a refused or
//     undelivered result registers nothing. What is made is placed nowhere: the agent or the person places it.
//
// The gate on every path, previews and searches included: a workspace STUDIO_PROVIDER_WORKSPACES does not list is
// refused (403 NOT_SET_UP), and a path that needs the worker is refused at once when none can (503 NOT_AVAILABLE).
import type { EditorAsset, EditorTranscript } from '../engine/contracts'
import { getAssets, registerAsset, registerTranscript, toTranscript, transcriptForAsset } from './assets'
import { providersAllowed, workerCan } from './capabilities'
import { isUuid, must, type StudioContext } from './context'
import { recordCharge } from './costs'
import { StudioError } from './errors'
import { ownAsset, queueJob, waitForJob, type JobRow } from './jobs'
import {
  MusicRequestSchema, REVOICE_MAX_SECONDS, RevoiceRequestSchema, SoundEffectRequestSchema,
  type AudioUndelivered, type FoundVoice, type GeneratedAudioWorkerResult, type MusicInput, type RevoiceInput,
  type SoundEffectInput, type SpeakerConsent, type VoiceSearchQuery, type VoiceSearchResult,
} from './provider-contract'
import { getRecord, getRecords, putRecord } from './records'
import { sha256Hex, stableStringify } from './stable'
import { FOUND_KEY, getVoice, knownVoice, VOICE_COLLECTION } from './voiceover'

/** The three spends this module makes. */
export type PaidAudioKind = 'revoice' | 'sound-effect' | 'music'

/** What each spend is called, cached under and charged as. */
const PAID: Record<PaidAudioKind, { collection: string; what: string }> = {
  revoice: { collection: 'revoice', what: 're-voice' },
  'sound-effect': { collection: 'sound-effect', what: 'sound effect' },
  music: { collection: 'music', what: 'music bed' },
}

/**
 * The Studio's estimate of a charge when the provider does not say what it charged: credits per second of audio.
 * From the provider's published API prices per minute (voice changer and sound effects 0.12, music 0.15 US dollars)
 * against its text-to-speech price (0.08 per thousand characters, one credit each), read 2026-11-12. An estimate,
 * marked so in the ledger; the provider's own count replaces it whenever its answer carries one.
 */
export const ESTIMATED_CREDITS_PER_SECOND: Record<PaidAudioKind, number> = { revoice: 25, 'sound-effect': 25, music: 31.25 }

/** The terms the provider states for what it makes, kept with each asset and said in each answer. */
export const PROVIDER_TERMS: Record<PaidAudioKind, string> = {
  revoice: 'Speech to speech in a voice of your account or the shared library, under the voice provider’s terms for that voice. Only a real person’s speech, or a voice cloned from a real person, with that person’s say-so.',
  'sound-effect': 'The voice provider states its generated sound effects are royalty-free (its API pricing page, read 2026-11-12).',
  music: 'The voice provider states its generated music includes a commercial use licence on its Starter plan and above (its API pricing page, read 2026-11-12): check the account’s plan before using it in a paid ad.',
}

/** The re-voice model the earlier tool used (multilingual speech to speech). */
export const DEFAULT_REVOICE_MODEL = 'eleven_multilingual_sts_v2'

// ---- the gate --------------------------------------------------------------------------------------------------------

const NOT_SET_UP: Record<PaidAudioKind | 'voice-search', string> = {
  'voice-search': 'Voice search is not set up for this workspace.',
  revoice: 'Re-voicing is not set up for this workspace.',
  'sound-effect': 'Sound effects from the voice provider are not set up for this workspace.',
  music: 'Music from the voice provider is not set up for this workspace.',
}
const NEEDS_WORKER: Record<PaidAudioKind | 'voice-search', string> = {
  'voice-search': 'Voice search',
  revoice: 'Re-voicing',
  'sound-effect': 'Sound effects',
  music: 'Music beds',
}

/**
 * Refuse when this workspace may not use the voice provider (403 NOT_SET_UP: STUDIO_PROVIDER_WORKSPACES), or, unless
 * `worker: false`, when no Studio worker holding the provider's key is running (503 NOT_AVAILABLE).
 */
export function requireVoiceProvider(ctx: Pick<StudioContext, 'workspaceId'>, what: PaidAudioKind | 'voice-search', options: { worker?: boolean } = {}): void {
  if (!providersAllowed(ctx.workspaceId)) throw new StudioError(NOT_SET_UP[what], 403, 'NOT_SET_UP')
  if (options.worker !== false && !workerCan('voiceover')) throw new StudioError(`${NEEDS_WORKER[what]} need the Studio’s worker with the voice provider set up, and none is running now.`, 503, 'NOT_AVAILABLE')
}

// ---- voice search ----------------------------------------------------------------------------------------------------

const FILTER = /^[\p{L}\p{N} _'-]{1,60}$/u

/** A search's words and filters, checked (each filter a short word or two; up to 30 voices a page). Pure. */
export function checkVoiceQuery(body: Record<string, unknown>): VoiceSearchQuery {
  const word = (key: string) => {
    const value = body[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || !FILTER.test(value.trim())) throw new StudioError(`${key} is a word or two.`)
    return value.trim()
  }
  const search = typeof body.search === 'string' && body.search.trim() ? body.search.trim().slice(0, 200) : undefined
  const size = Number(body.pageSize ?? 12)
  const query: VoiceSearchQuery = { pageSize: Number.isInteger(size) && size >= 1 && size <= 30 ? size : 12 }
  for (const [key, value] of Object.entries({ search, gender: word('gender'), age: word('age'), accent: word('accent'), language: word('language'), useCase: word('useCase') })) {
    if (value) (query as Record<string, unknown>)[key] = value
  }
  return query
}

/** The voices searches found so far (newest first). */
export async function foundVoices(ctx: StudioContext): Promise<FoundVoice[]> {
  return (await getRecord<{ voices: FoundVoice[] }>(ctx, VOICE_COLLECTION, FOUND_KEY))?.voices ?? []
}

/**
 * Search the account's voices and the shared voice library (free): a quick worker job the call waits on. The voices
 * it finds are kept, so one can be chosen by its id.
 */
export async function searchVoices(ctx: StudioContext, body: Record<string, unknown>, options: { waitMs?: number } = {}): Promise<VoiceSearchResult> {
  requireVoiceProvider(ctx, 'voice-search')
  const job = await queueJob(ctx, 'voice-search', { provider: 'elevenlabs', query: checkVoiceQuery(body) })
  const done = await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? 30_000, everyMs: 500 })
  if (done.status === 'completed') return done.result as unknown as VoiceSearchResult
  if (done.status === 'failed' || done.status === 'cancelled') throw new StudioError(done.error ?? 'Searching the voices failed.', 502, 'PROVIDER')
  throw new StudioError('The Studio worker is busy; search the voices again in a moment.', 503, 'BUSY')
}

/** One found voice as the Studio keeps it (short fields, an https preview link only). Pure. */
function keptVoice(v: FoundVoice): FoundVoice {
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)
  const out: FoundVoice = { voiceId: String(v.voiceId).slice(0, 200), name: String(v.name).slice(0, 100), source: v.source === 'account' ? 'account' : 'library' }
  const extra = {
    category: text(v.category, 40), description: text(v.description, 200), gender: text(v.gender, 40), age: text(v.age, 40),
    accent: text(v.accent, 60), language: text(v.language, 20), useCase: text(v.useCase, 60),
    previewUrl: typeof v.previewUrl === 'string' && /^https:\/\//.test(v.previewUrl) ? v.previewUrl.slice(0, 500) : undefined,
  }
  for (const [key, value] of Object.entries(extra)) if (value) (out as Record<string, unknown>)[key] = value
  return out
}

/** A finished `voice-search` job: its voices checked and kept (the newest 300 found, each once). */
export async function fileVoiceSearch(ctx: StudioContext, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const voices = (Array.isArray(raw.voices) ? (raw.voices as FoundVoice[]) : [])
    .filter((v) => v && typeof v.voiceId === 'string' && /^[\w-]{1,200}$/.test(v.voiceId) && typeof v.name === 'string')
    .slice(0, 100)
    .map(keptVoice)
  const seen = new Set(voices.map((v) => v.voiceId))
  const kept = [...voices, ...(await foundVoices(ctx)).filter((v) => !seen.has(v.voiceId))].slice(0, 300)
  await putRecord(ctx, VOICE_COLLECTION, FOUND_KEY, { at: new Date().toISOString(), voices: kept })
  return { voices, hasMore: raw.hasMore === true } satisfies VoiceSearchResult
}

// ---- the requests ----------------------------------------------------------------------------------------------------

/** A request's hash: the same request is the same hash, whatever order it was written in. Pure. */
export const paidRequestHash = (request: unknown) => sha256Hex(stableStringify(request))

/** A number from a body, or the default when absent; refused when it is outside its range. Pure. */
function numberIn(value: unknown, fallback: number | undefined, min: number, max: number, what: string): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new StudioError(`Say ${what}.`)
    return fallback
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new StudioError(`${what[0]!.toUpperCase()}${what.slice(1)} is ${min} to ${max}.`)
  return n
}

/** A described sound or bed's text: trimmed, never empty, at most `max` characters. Pure. */
function described(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new StudioError(`Describe the ${what} first.`)
  if (value.trim().length > max) throw new StudioError(`A ${what} description is at most ${max} characters.`)
  return value.trim()
}

/** What a re-voice is asked with (the tool's and a route's words). */
export type RevoiceAsk = { assetId: string; from?: number; to?: number; voiceId?: string; speaker: SpeakerConsent; removeBackgroundNoise?: boolean }

/** The speaker's consent as the call says it: a generated voice, or a real person who agreed. Pure. */
export function checkSpeaker(value: unknown): SpeakerConsent {
  if (value === 'generated' || value === 'person-who-agreed') return value
  throw new StudioError('Say whose speech this is: a generated voice, or a real person who agreed to be re-voiced. A real person’s voice is re-voiced only with their say-so.', 400, 'NEEDS_CONSENT')
}

/** A re-voice: the exact request, its hash, what it bills by, and the names it is made under. */
export async function revoicePlan(ctx: StudioContext, body: Record<string, unknown>) {
  const speaker = checkSpeaker(body.speaker)
  const assetId = typeof body.assetId === 'string' ? body.assetId : ''
  const source = /^[a-f0-9]{64}$/.test(assetId) ? (await getAssets(ctx, [assetId])).get(assetId) : undefined
  if (!source) throw new StudioError('No such recording or audio in the library.', 404, 'NOT_FOUND')
  if ((source.kind !== 'audio' && source.kind !== 'video') || !source.hasAudio || !(source.durationSeconds! > 0)) throw new StudioError(`${source.name} has no sound to re-voice.`)
  const duration = source.durationSeconds!
  const from = numberIn(body.from, 0, 0, duration, 'from (seconds into the file)')
  const to = numberIn(body.to, Math.min(duration, from + REVOICE_MAX_SECONDS), 0, duration, 'to (seconds into the file)')
  if (to - from < 1 || to - from > REVOICE_MAX_SECONDS) throw new StudioError(`Re-voice 1 to ${REVOICE_MAX_SECONDS} seconds at a time (from ${from} to ${to} is ${(to - from).toFixed(2)}).`)
  const workspaceVoice = await getVoice(ctx)
  const voiceId = typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : workspaceVoice?.voiceId
  if (!voiceId) throw new StudioError('Choose the voice to re-voice into first.', 400, 'NO_VOICE')
  const voice = voiceId === workspaceVoice?.voiceId ? { voiceId, name: workspaceVoice.name, category: undefined as string | undefined } : await knownVoice(ctx, voiceId)
  if (!voice) throw new StudioError('That voice is not one the Studio knows: choose it from the account’s voices or a voice search first.', 400, 'UNKNOWN_VOICE')
  const request = RevoiceRequestSchema.parse({
    provider: 'elevenlabs', endpoint: 'voice-changer', requestVersion: 1, voiceId, modelId: DEFAULT_REVOICE_MODEL, outputFormat: 'mp3_44100_128',
    removeBackgroundNoise: body.removeBackgroundNoise !== false, seed: null,
    source: { assetId: source.id, sha256: source.sha256, fromSeconds: Math.round(from * 1000) / 1000, toSeconds: Math.round(to * 1000) / 1000 },
  })
  const seconds = Math.round((request.source.toSeconds - request.source.fromSeconds) * 100) / 100
  return {
    request, requestHash: paidRequestHash(request), seconds, speaker, source, voiceName: voice.name, voiceCategory: voice.category,
    estimatedCredits: Math.ceil(seconds * ESTIMATED_CREDITS_PER_SECOND.revoice),
    name: `${voice.name} re-voice of ${source.name.replace(/\.[^.]+$/, '')}.mp3`.slice(0, 250),
  }
}

/** Designed sound effects: the exact request (one per variant), its hash and what it bills by. Pure. */
export function soundEffectPlan(body: Record<string, unknown>) {
  const request = SoundEffectRequestSchema.parse({
    provider: 'elevenlabs', endpoint: 'sound-generation', requestVersion: 1, modelId: 'eleven_text_to_sound_v3', outputFormat: 'mp3_44100_128',
    text: described(body.text, 1000, 'sound effect'),
    durationSeconds: numberIn(body.seconds, undefined, 0.5, 30, 'how many seconds long (0.5 to 30)'),
    promptInfluence: numberIn(body.influence, 0.4, 0, 1, 'how literal (0 to 1)'),
    loop: body.loop === true,
    variants: Math.round(numberIn(body.variants, 1, 1, 3, 'how many candidates (1 to 3)')),
    take: Math.round(numberIn(body.take, 1, 1, 50, 'the take (1 to 50)')),
  })
  const seconds = Math.round(request.durationSeconds * request.variants * 100) / 100
  return {
    request, requestHash: paidRequestHash(request), seconds,
    estimatedCredits: Math.ceil(seconds * ESTIMATED_CREDITS_PER_SECOND['sound-effect']),
    name: `Sound effect: ${request.text.slice(0, 60)}`.slice(0, 240),
  }
}

/** A music bed: the exact request (one per variant), its hash and what it bills by. Pure. */
export function musicPlan(body: Record<string, unknown>) {
  const request = MusicRequestSchema.parse({
    provider: 'elevenlabs', endpoint: 'music', requestVersion: 1, modelId: 'music_v2_5', outputFormat: 'mp3_44100_128',
    prompt: described(body.prompt, 4100, 'music bed'),
    lengthMs: Math.round(numberIn(body.seconds, undefined, 3, 300, 'how many seconds long (3 to 300)') * 1000),
    forceInstrumental: body.instrumental !== false,
    variants: Math.round(numberIn(body.variants, 1, 1, 2, 'how many candidates (1 or 2)')),
    take: Math.round(numberIn(body.take, 1, 1, 50, 'the take (1 to 50)')),
  })
  const seconds = Math.round((request.lengthMs / 1000) * request.variants * 100) / 100
  return {
    request, requestHash: paidRequestHash(request), seconds,
    estimatedCredits: Math.ceil(seconds * ESTIMATED_CREDITS_PER_SECOND.music),
    name: `Music bed: ${request.prompt.slice(0, 60)}`.slice(0, 240),
  }
}

/** Any of the three plans, by kind, with the job input it queues. */
async function planFor(ctx: StudioContext, kind: PaidAudioKind, body: Record<string, unknown>) {
  if (kind === 'revoice') {
    const p = await revoicePlan(ctx, body)
    const input: RevoiceInput = { request: p.request, requestHash: p.requestHash, name: p.name, estimatedCredits: p.estimatedCredits, terms: PROVIDER_TERMS.revoice, source: p.source, voiceName: p.voiceName, speaker: p.speaker }
    return { ...p, input }
  }
  const p = kind === 'sound-effect' ? soundEffectPlan(body) : musicPlan(body)
  const input = { request: p.request, requestHash: p.requestHash, name: p.name, estimatedCredits: p.estimatedCredits, terms: PROVIDER_TERMS[kind] } as SoundEffectInput | MusicInput
  return { ...p, input }
}

// ---- the cache -------------------------------------------------------------------------------------------------------

/** The cache's record of one request: what it made. */
type PaidRecord = { requestHash: string; assetIds: string[]; transcriptId?: string; timingKept?: boolean; credits: number; at: string }

/** What a spend answers: the assets it made (and a re-voice's carried-over transcript), and whether it was cached. */
export type PaidAudioAnswer = { assets: EditorAsset[]; transcript: EditorTranscript | null; timingKept?: boolean; cached: boolean; requestHash: string; terms: string; note?: string }

/** The answer a request already made (every asset still registered), or null. */
export async function cachedPaid(ctx: StudioContext, kind: PaidAudioKind, hash: string): Promise<PaidAudioAnswer | null> {
  const record = await getRecord<PaidRecord>(ctx, PAID[kind].collection, hash)
  if (!record?.assetIds?.length) return null
  const found = await getAssets(ctx, record.assetIds)
  if (record.assetIds.some((id) => !found.has(id))) return null
  const transcript = record.transcriptId ? ((await getRecords<EditorTranscript>(ctx, 'transcripts', [record.transcriptId])).get(record.transcriptId) ?? null) : null
  return { assets: record.assetIds.map((id) => found.get(id)!), transcript, ...(kind === 'revoice' ? { timingKept: record.timingKept === true } : {}), cached: true, requestHash: hash, terms: PROVIDER_TERMS[kind] }
}

/** A quote, as the cards and the tools read it. A re-voice's names its voice and stretch; the others their candidates. */
export type PaidQuote = {
  cached: boolean; requestHash: string; seconds: number; estimatedCredits: number; modelId: string; terms: string
  voiceName?: string; voiceId?: string; voiceCategory?: string; sourceName?: string; speaker?: SpeakerConsent; from?: number; to?: number; variants?: number
}

/** A quote: what the request bills by, its hash, and whether this exact one is cached (then it is free). */
export async function previewPaid(ctx: StudioContext, kind: PaidAudioKind, body: Record<string, unknown>): Promise<PaidQuote> {
  requireVoiceProvider(ctx, kind, { worker: false })
  const plan = await planFor(ctx, kind, body)
  const cached = !!(await cachedPaid(ctx, kind, plan.requestHash))
  return {
    cached, requestHash: plan.requestHash, seconds: plan.seconds, estimatedCredits: plan.estimatedCredits, modelId: plan.request.modelId, terms: PROVIDER_TERMS[kind],
    ...('voiceName' in plan ? { voiceName: plan.voiceName, voiceId: plan.request.voiceId, voiceCategory: plan.voiceCategory, sourceName: plan.source.name, speaker: plan.speaker, from: plan.request.source.fromSeconds, to: plan.request.source.toSeconds } : {}),
    ...('variants' in plan.request ? { variants: plan.request.variants } : {}),
  }
}

const JOB_FIELDS = 'id, workspace_id, video_id, kind, status, progress, logs, input, result, error, cancel_requested, worker_id, attempts, created_by, created_at, updated_at'

/** The job of this kind for this request still queued or running, if any. */
async function runningPaid(ctx: StudioContext, kind: PaidAudioKind, hash: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', kind).in('status', ['queued', 'running']).eq('input->>requestHash', hash).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/** How long a spend paid for but not delivered is answered with its sentence until it has been read. */
const UNDELIVERED_KEPT_MS = 24 * 3600_000

/** The latest job of this kind for this request paid for, not delivered, and whose sentence nobody has read. */
async function unreadUndelivered(ctx: StudioContext, kind: PaidAudioKind, hash: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', kind).eq('status', 'completed').eq('input->>requestHash', hash)
      .eq('result->>outcome', 'undelivered').is('result->>shown', null).gte('updated_at', new Date(Date.now() - UNDELIVERED_KEPT_MS).toISOString()).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/** What the replay of an approval card answers when the request is no longer the one the card showed. */
export const PAID_CHANGED = 'Nothing was spent. What would be sent changed since you approved (the voice, the stretch, the description or the length): ask again.'

/** Asks in flight in this process, so two at once for one request queue one job. */
const starting = new Map<string, Promise<{ result: PaidAudioAnswer } | { job: JobRow }>>()

/**
 * A spend of this kind: the cached answer when this exact request was made before (never paid again), else, only with
 * `allowPaid`, the job that makes it (the one already running for this request, or a new one). `expectHash` (an
 * approval card's pinned request) refuses (409 CARD_CHANGED) a request that is no longer that one.
 */
export function startPaid(ctx: StudioContext, kind: PaidAudioKind, body: Record<string, unknown>, options: { allowPaid: boolean; videoId?: string | null; expectHash?: string }): Promise<{ result: PaidAudioAnswer } | { job: JobRow }> {
  return (async () => {
    requireVoiceProvider(ctx, kind, { worker: false })
    const plan = await planFor(ctx, kind, body)
    if (options.expectHash !== undefined && options.expectHash !== plan.requestHash) throw new StudioError(PAID_CHANGED, 409, 'CARD_CHANGED')
    const slot = `${ctx.workspaceId}:${kind}:${plan.requestHash}`
    const inFlight = starting.get(slot)
    if (inFlight) return inFlight
    const work = (async () => {
      const cached = await cachedPaid(ctx, kind, plan.requestHash)
      if (cached) return { result: cached }
      if (!options.allowPaid) throw new StudioError(`This ${PAID[kind].what} is not made yet. Making it uses the voice provider’s credits, so it needs your yes first.`, 402, 'NEEDS_APPROVAL')
      const running = await runningPaid(ctx, kind, plan.requestHash)
      if (running) return { job: running }
      // Paid for but not delivered, and its sentence not read yet: that answer, never a second request unseen.
      const undelivered = await unreadUndelivered(ctx, kind, plan.requestHash)
      if (undelivered) return { job: undelivered }
      requireVoiceProvider(ctx, kind)
      return { job: await queueJob(ctx, kind, plan.input as never, options.videoId && isUuid(options.videoId) ? options.videoId : null) }
    })().finally(() => starting.delete(slot))
    starting.set(slot, work)
    return work
  })()
}

/** True when a finished job's result is the worker's "paid for, not delivered". Pure. */
export const isAudioUndelivered = (result: unknown): result is AudioUndelivered =>
  !!result && typeof result === 'object' && (result as { outcome?: unknown }).outcome === 'undelivered'

/** A finished job's answer, or the refusal it ended with; null while it still runs. Not delivered is a refusal (502 UNDELIVERED). Pure. */
export function paidOutcome(row: JobRow): PaidAudioAnswer | null {
  if (row.status === 'completed') {
    if (isAudioUndelivered(row.result)) throw new StudioError(String(row.result.error), 502, 'UNDELIVERED')
    return row.result as unknown as PaidAudioAnswer
  }
  if (row.status === 'failed' || row.status === 'cancelled') throw new StudioError(row.error ?? 'The voice provider’s work failed.', 502, 'PROVIDER')
  return null
}

/** paidOutcome for an answer about to be read: a "not delivered" sentence is marked read, so a next ask is a new request. */
export async function paidAnswer(ctx: StudioContext, row: JobRow): Promise<PaidAudioAnswer | null> {
  if (row.status === 'completed' && isAudioUndelivered(row.result) && !(row.result as { shown?: unknown }).shown) {
    must(await ctx.supabase.from('studio_job').update({ result: { ...row.result, shown: true } }).eq('workspace_id', ctx.workspaceId).eq('id', row.id), 'record the answer')
  }
  return paidOutcome(row)
}

// ---- filing what the worker made -------------------------------------------------------------------------------------

type SpendRow = Pick<JobRow, 'id' | 'video_id' | 'input' | 'kind'>

/** What a spend's job input says, whichever kind it is. */
const inputOf = (row: SpendRow) => row.input as unknown as (RevoiceInput | SoundEffectInput | MusicInput)

/** What a request is about, for the ledger's line. Pure. */
function chargeDetail(kind: PaidAudioKind, input: RevoiceInput | SoundEffectInput | MusicInput): string {
  if (kind === 'revoice') {
    const i = input as RevoiceInput
    return `${i.voiceName}: ${i.source.name} ${i.request.source.fromSeconds}–${i.request.source.toSeconds} s`
  }
  const r = (input as SoundEffectInput | MusicInput).request
  return `${r.variants} × ${'text' in r ? `${r.durationSeconds} s: ${r.text}` : `${r.lengthMs / 1000} s: ${r.prompt}`}`
}

/**
 * The charge of a spend the worker finished: the provider's count when it gave one, else the Studio's estimate
 * (marked), keyed by the job so recording it twice records it once. Also for a result that arrives late (jobs.ts).
 */
export async function recordPaidCharge(ctx: StudioContext, row: SpendRow, out: { credits?: unknown; creditsFrom?: unknown; providerRequestIds?: unknown }): Promise<void> {
  const kind = row.kind as PaidAudioKind
  const input = inputOf(row)
  const said = Number(out.credits) > 0
  const credits = said ? Number(out.credits) : Number(input.estimatedCredits) || 0
  const estimated = !said || out.creditsFrom !== 'provider'
  const ids = Array.isArray(out.providerRequestIds) ? out.providerRequestIds.filter((id): id is string => typeof id === 'string') : []
  await recordCharge(ctx, {
    provider: 'elevenlabs',
    credits,
    model: String(input.request?.modelId ?? kind).slice(0, 120),
    kind,
    videoId: row.video_id,
    jobId: row.id,
    ...(ids.length ? { providerJobId: ids.join(',').slice(0, 120) } : {}),
    detail: `${estimated ? 'Estimated from the length. ' : ''}${chargeDetail(kind, input)}`,
    ...(estimated ? { estimated: true as const } : {}),
  })
}

/**
 * A re-voice's transcript, carried over from the source's own when the timing was kept (the made audio is as long as
 * the stretch, within a quarter second): the source's words inside the stretch, moved to start at zero. Null when
 * the source has no transcript, no words fall inside, or the timing changed.
 */
export async function carriedTranscript(ctx: StudioContext, input: RevoiceInput, asset: EditorAsset): Promise<{ transcript: EditorTranscript | null; timingKept: boolean }> {
  const { fromSeconds, toSeconds } = input.request.source
  const timingKept = Math.abs((asset.durationSeconds ?? 0) - (toSeconds - fromSeconds)) <= 0.25
  if (!timingKept) return { transcript: null, timingKept }
  const source = await transcriptForAsset(ctx, input.source.id).catch(() => null)
  const limit = (asset.durationSeconds ?? 0) * 1000
  const words = (source?.words ?? [])
    .filter((w) => w.startMs >= fromSeconds * 1000 && w.endMs <= toSeconds * 1000)
    .map((w) => ({ text: w.text, startMs: Math.max(0, w.startMs - fromSeconds * 1000), endMs: Math.min(limit, w.endMs - fromSeconds * 1000) }))
    .filter((w) => w.endMs > w.startMs)
  if (!words.length) return { transcript: null, timingKept }
  const transcript = await registerTranscript(ctx, toTranscript(asset, { words, text: words.map((w) => w.text).join(' ') }, 'imported', sha256Hex(stableStringify({ from: source!.id, fromSeconds, toSeconds })), `${input.voiceName} re-voice`.slice(0, 250), input.voiceName.slice(0, 100)))
  return { transcript, timingKept }
}

/** The assets a made result names, each an audio file checked against what the job stored before any is registered. */
async function checkedAudio(ctx: StudioContext, kind: PaidAudioKind, out: Record<string, unknown>): Promise<EditorAsset[]> {
  const named = kind === 'revoice' ? [out.asset] : Array.isArray(out.assets) ? out.assets : []
  if (!named.length || named.length > 3) throw new StudioError(`The ${PAID[kind].what} came back without its audio.`)
  const checked: EditorAsset[] = []
  for (const value of named) {
    const asset = await ownAsset(ctx, value, `${PAID[kind].what} audio`)
    if (asset.kind !== 'audio' || !asset.hasAudio) throw new StudioError(`The ${PAID[kind].what} is not an audio file.`)
    checked.push(asset)
  }
  return checked
}

/**
 * A finished `revoice`, `sound-effect` or `music` job: the charge recorded, then (made) every asset checked and
 * registered, a re-voice's transcript carried over when the timing was kept, and the request cached. Placed nowhere.
 * One paid for and not delivered keeps only the charge and the worker's sentence.
 */
export async function filePaidAudio(ctx: StudioContext, row: SpendRow, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = row.kind as PaidAudioKind
  const input = inputOf(row)
  // The provider was paid once the worker has a result: the charge is recorded first, whatever else is refused.
  await recordPaidCharge(ctx, row, raw)
  if (isAudioUndelivered(raw)) {
    return {
      outcome: 'undelivered',
      error: String(raw.error || `The voice provider made this ${PAID[kind].what} but it could not be kept. Check the video’s costs before asking for it again.`).slice(0, 1000),
      credits: Number(raw.credits) > 0 ? Number(raw.credits) : input.estimatedCredits,
      creditsFrom: raw.creditsFrom === 'provider' ? 'provider' : 'estimate',
    } satisfies AudioUndelivered
  }
  const checked = await checkedAudio(ctx, kind, raw)
  const assets: EditorAsset[] = []
  for (const asset of checked) assets.push(await registerAsset(ctx, asset))
  const carried = kind === 'revoice' ? await carriedTranscript(ctx, input as RevoiceInput, assets[0]!) : null
  const credits = Number(raw.credits) > 0 ? Number(raw.credits) : input.estimatedCredits
  await putRecord(ctx, PAID[kind].collection, input.requestHash, {
    requestHash: input.requestHash, assetIds: assets.map((a) => a.id), ...(carried?.transcript ? { transcriptId: carried.transcript.id } : {}),
    ...(carried ? { timingKept: carried.timingKept } : {}), credits, at: new Date().toISOString(),
  } satisfies PaidRecord)
  const note = typeof (raw as GeneratedAudioWorkerResult).note === 'string' ? String(raw.note).slice(0, 500) : undefined
  return {
    assets, transcript: carried?.transcript ?? null, ...(carried ? { timingKept: carried.timingKept } : {}), cached: false, requestHash: input.requestHash, terms: PROVIDER_TERMS[kind], ...(note ? { note } : {}),
  } satisfies PaidAudioAnswer
}
