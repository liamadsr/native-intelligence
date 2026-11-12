// The paid providers' jobs, as data both the app and the Studio worker read (job-contract.ts names the kinds; this
// file says what each is given and gives back). Pure (zod and the engine's types only), so the worker imports it by
// relative path like the rest of the contract.
//
// Provider calls run in the worker, never in the app: the worker holds the provider's key (ELEVENLABS_API_KEY) or
// runs its tool (the higgsfield command-line tool, signed in where the worker runs), and says so when it asks for
// work (capabilities.ts). The app only queues the job, files what came back and keeps the ledger (costs.ts).
//
//   voices        the ElevenLabs account's voices, so the person can choose one (quick; the app waits on it)
//   narration     text to speech with word timings for one exact request; the audio becomes a library asset
//   shot-quote    the price of a beat's still or clip as it will run (quick; free; the app waits on it)
//   shot          the spend: create, wait, download, grade, import; the app places the result on the beat
//   continuity    light and colour of generated beats against the recorded beats they cut to (quick; ffmpeg only)
import { z } from 'zod'
import type { EditorAsset } from '../engine/contracts'

// ---- narration -------------------------------------------------------------------------------------------------

/** The voice settings ElevenLabs takes, in its own ranges. */
export const VoiceSettingsSchema = z.object({
  stability: z.number().finite().min(0).max(1),
  similarityBoost: z.number().finite().min(0).max(1),
  style: z.number().finite().min(0).max(1),
  useSpeakerBoost: z.boolean(),
  speed: z.number().finite().min(0.7).max(1.2),
}).strict()
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>

/**
 * One text-to-speech request, exactly as it is sent: the same request is the same audio, so its canonical hash
 * (voiceover.ts requestHash) is the narration cache's key.
 */
export const TtsRequestSchema = z.object({
  provider: z.literal('elevenlabs'),
  endpoint: z.literal('text-to-speech/with-timestamps'),
  requestVersion: z.literal(1),
  voiceId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  outputFormat: z.literal('mp3_44100_128'),
  languageCode: z.string().min(2).max(10).nullable(),
  seed: z.number().int().min(0).max(4_294_967_295).nullable(),
  applyTextNormalization: z.enum(['auto', 'on', 'off']),
  applyLanguageTextNormalization: z.literal(false),
  voiceSettings: VoiceSettingsSchema,
  pronunciationDictionaryLocators: z.array(z.object({ pronunciationDictionaryId: z.string().min(1), versionId: z.string().min(1) }).strict()).max(3),
  text: z.string().trim().min(1).max(20_000),
}).strict()
export type TtsRequest = z.infer<typeof TtsRequestSchema>

/** A voice of the account, as the picker lists it. */
export type ProviderVoice = { voiceId: string; name: string; category?: string; description?: string; previewUrl?: string }

export type VoicesInput = { provider: 'elevenlabs' }
export type VoicesResult = { voices: ProviderVoice[] }

/** narration: the request to send, its hash (the cache key) and what the audio is called in the library. */
export type NarrationInput = { request: TtsRequest; requestHash: string; voiceName: string; name: string }
/**
 * The worker stored the audio (blob `asset.file`) before completing. `words` are the provider's alignment as words in
 * milliseconds; `alignmentSha256` is the hash of the raw alignment it returned. `characters` is what the provider
 * charged (its own count when it says one, else the request's length: `charactersFrom` says which).
 */
export type NarrationWorkerResult = {
  asset: EditorAsset
  text: string
  words: { text: string; startMs: number; endMs: number }[]
  alignmentSha256: string
  characters: number
  charactersFrom: 'provider' | 'request'
  providerRequestId?: string
}
/**
 * narration, spent but not delivered: ElevenLabs answered (and charged) but the audio could not be kept (unreadable,
 * timings past its end, storing failed) or the job was stopped once the request had been answered. No asset: the
 * charge, for the cost ledger, and a sentence for the person. The worker completes the job with it (never fails it),
 * also when the job was cancelled or taken back meanwhile.
 */
export type NarrationUndelivered = {
  outcome: 'undelivered'
  error: string
  characters: number
  charactersFrom: 'provider' | 'request'
  providerRequestId?: string
}

// ---- generated shots -----------------------------------------------------------------------------------------------

/** A parameter of a model as the higgsfield tool describes it (`model get <model> --json`). */
export type ModelParamInfo = { name: string; enum?: string[] | null; default?: unknown; type?: string }

/** A model the person's plan was refused for, learned from the provider's own words ("Pro" or "Ultimate" plan required). */
export type PlanBlock = { plans: string[]; message: string; seenOn: string; at: string }

/**
 * What a beat's generation is asked with. Media are library assets, named by id: the worker downloads them and
 * hands the tool local files (it uploads them itself). `params` are the model parameters but those two.
 */
export type ShotAsk = {
  what: 'still' | 'clip'
  final: boolean
  /** The model a final asks for (the beat's own), when there is one. Drafts pick the cheapest themselves. */
  model?: string
  params: Record<string, unknown>
  references: EditorAsset[]
  startImage?: EditorAsset
  /** Models already refused on a plan, by model (the worker refuses them before quoting). */
  blocks: Record<string, PlanBlock>
}

/** A price as the generation will run (draft tier applied). Media in `params` read `asset:<id>`. Exactly the editor's shape. */
export type ShotQuote = {
  model: string
  params: Record<string, unknown>
  tier: 'draft' | 'final'
  changes: { name: string; from: unknown; to: string }[]
  credits: number
  balance?: number
  plan?: string
}
export type QuoteTried = { model: string; credits?: number; skipped?: string }

export type ShotQuoteInput = ShotAsk
export type ShotQuoteResult = { quote: ShotQuote; tried?: QuoteTried[] }

/** shot: the ask, the price the person confirmed, what to call the files, and the camera footage to grade toward. */
export type ShotInput = ShotAsk & {
  confirm: { model: string; credits: number }
  beatId: string
  name: string
  camera?: EditorAsset
  prompt: string
}

/**
 *   made        spent, downloaded and stored: every file as an asset (`assets`), and the one to place (`asset`:
 *               the graded copy of a clip when there was camera footage to grade toward, else the first file)
 *   refused     nothing was spent: the price changed, or the plan can't run the model (`block`, to remember)
 *   undelivered spent, but no file came back (the provider's job id says where to look)
 */
export type ShotResult =
  | { outcome: 'made'; quote: ShotQuote; providerJobId: string; assets: EditorAsset[]; asset: EditorAsset; graded?: boolean; log?: string[] }
  | { outcome: 'refused'; error: string; block?: { model: string } & PlanBlock }
  | { outcome: 'undelivered'; error: string; quote: ShotQuote; providerJobId: string }

// ---- continuity -------------------------------------------------------------------------------------------------------

/** A stretch of one asset to measure: from and to in the asset's own seconds. */
export type MeasureSpan = { asset: EditorAsset; from: number; to: number }
export type ContinuityInput = { pairs: { beat: string; against: string; a: MeasureSpan; b: MeasureSpan }[] }
export type ContinuityIssue = { beat: string; against: string; what: string; detail: string }
export type ContinuityResult = { issues: ContinuityIssue[] }

// ---- the voice library ------------------------------------------------------------------------------------------------
//
//   voice-search   the account's own voices and the voice provider's shared library, by words and its own filters
//                  (free: two reads; the app waits on it). GET /v1/shared-voices and GET /v1/voices.

/** What a voice search asks: words, and the provider's own filters. */
export type VoiceSearchQuery = { search?: string; gender?: string; age?: string; accent?: string; language?: string; useCase?: string; pageSize: number }
/** A voice a search found: one of the account's own (`account`) or one of the shared library's (`library`). */
export type FoundVoice = ProviderVoice & { source: 'account' | 'library'; gender?: string; age?: string; accent?: string; language?: string; useCase?: string }
export type VoiceSearchInput = { provider: 'elevenlabs'; query: VoiceSearchQuery }
export type VoiceSearchResult = { voices: FoundVoice[]; hasMore: boolean }

// ---- re-voicing, sound effects and music beds -------------------------------------------------------------------------
//
//   revoice        a library asset's speech (or a stretch of it) re-spoken in another voice, its timing kept
//                  (POST /v1/voice-changer/{voice}, multipart; the provider's speech to speech)
//   sound-effect   designed sound effects from a description (POST /v1/sound-generation)
//   music          music beds from a description (POST /v1/music)
//
// Each is a spend, made the narration way: the app builds the exact request and hashes it (the cache key and what an
// approval card pins), the worker sends it once and never again (an attempt after the first refuses), and whatever
// the provider answered comes back with its charge, delivered or not. The audio is streamed to disk under a size cap.

/** The longest stretch one re-voice sends. */
export const REVOICE_MAX_SECONDS = 300

/** The provider's request for a re-voice, exactly as it is sent (the audio is the stretch of `source`). */
export const RevoiceRequestSchema = z.object({
  provider: z.literal('elevenlabs'),
  endpoint: z.literal('voice-changer'),
  requestVersion: z.literal(1),
  voiceId: z.string().regex(/^[\w-]{1,200}$/),
  modelId: z.string().regex(/^[\w.-]{1,200}$/),
  outputFormat: z.literal('mp3_44100_128'),
  removeBackgroundNoise: z.boolean(),
  seed: z.number().int().min(0).max(4_294_967_295).nullable(),
  source: z.object({
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fromSeconds: z.number().finite().min(0),
    toSeconds: z.number().finite().positive(),
  }).strict(),
}).strict().refine((r) => r.source.toSeconds - r.source.fromSeconds >= 1 && r.source.toSeconds - r.source.fromSeconds <= REVOICE_MAX_SECONDS, `A re-voice is 1 to ${REVOICE_MAX_SECONDS} seconds of speech.`)
export type RevoiceRequest = z.infer<typeof RevoiceRequestSchema>


/**
 * The provider's request for designed sound effects. `variants` is how many requests are sent (one candidate each);
 * `take` is never sent: it tells a deliberate new take of the same description from a repeat (which is cached).
 */
export const SoundEffectRequestSchema = z.object({
  provider: z.literal('elevenlabs'),
  endpoint: z.literal('sound-generation'),
  requestVersion: z.literal(1),
  modelId: z.enum(['eleven_text_to_sound_v3', 'eleven_text_to_sound_v2']),
  outputFormat: z.literal('mp3_44100_128'),
  text: z.string().trim().min(1).max(1000),
  durationSeconds: z.number().finite().min(0.5).max(30),
  promptInfluence: z.number().finite().min(0).max(1),
  loop: z.boolean(),
  variants: z.number().int().min(1).max(3),
  take: z.number().int().min(1).max(50),
}).strict()
export type SoundEffectRequest = z.infer<typeof SoundEffectRequestSchema>

/** The provider's request for a music bed: a prompt and a length (`variants` and `take` as for sound effects). */
export const MusicRequestSchema = z.object({
  provider: z.literal('elevenlabs'),
  endpoint: z.literal('music'),
  requestVersion: z.literal(1),
  modelId: z.enum(['music_v2_5', 'music_v2', 'music_v1']),
  outputFormat: z.literal('mp3_44100_128'),
  prompt: z.string().trim().min(1).max(4100),
  lengthMs: z.number().int().min(3000).max(300_000),
  forceInstrumental: z.boolean(),
  variants: z.number().int().min(1).max(2),
  take: z.number().int().min(1).max(50),
}).strict()
export type MusicRequest = z.infer<typeof MusicRequestSchema>

/** Who is speaking in what is re-voiced: a generated voice, or a real person who agreed to it. Nothing else is sent. */
export type SpeakerConsent = 'generated' | 'person-who-agreed'

/**
 * Every spend of these kinds is given the Studio's own estimate of its charge (`estimatedCredits`, used when the
 * provider says nothing of what it charged) and the words of the provider's terms to keep with what it makes.
 */
type SpendInput = { requestHash: string; name: string; estimatedCredits: number; terms: string }
export type RevoiceInput = SpendInput & { request: RevoiceRequest; source: EditorAsset; voiceName: string; speaker: SpeakerConsent }
export type SoundEffectInput = SpendInput & { request: SoundEffectRequest }
export type MusicInput = SpendInput & { request: MusicRequest }

/** What a spend cost: the provider's own count when it said one (`provider`), else the Studio's estimate. */
export type ProviderSpend = { credits: number; creditsFrom: 'provider' | 'estimate'; providerRequestIds?: string[] }
/** revoice, made: the stored audio (blob `asset.file`) and its length. */
export type RevoiceWorkerResult = ProviderSpend & { asset: EditorAsset; seconds: number }
/** sound-effect or music, made: the stored candidates; `note` says when fewer came back than were asked for. */
export type GeneratedAudioWorkerResult = ProviderSpend & { assets: EditorAsset[]; note?: string }
/** Spent but not delivered (the provider answered, nothing could be kept), as NarrationUndelivered. */
export type AudioUndelivered = ProviderSpend & { outcome: 'undelivered'; error: string }
