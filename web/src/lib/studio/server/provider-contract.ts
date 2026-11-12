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
