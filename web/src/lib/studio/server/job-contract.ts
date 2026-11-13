// The contract between the app and the Studio worker (studio-worker/, its own process with a browser and
// FFmpeg). The app queues a studio_job row (migration 620); the worker polls the app, claims a job, does it,
// reports progress and finishes it. The worker holds no database or storage key: it reaches files only through
// links the app signs for the job it holds. Both sides import this file (the worker by relative path), so it
// stays free of app-only imports: zod and the engine's types only.
//
// Every worker route is POST, JSON, under /api/internal/studio/, with `Authorization: Bearer <STUDIO_WORKER_SECRET>`.
//
//   jobs/claim            {workerId, kinds, capabilities?}         -> {job: ClaimedJob | null}
//   jobs/<id>/progress    {workerId, progress, log?, capabilities?} -> {cancelRequested}
//   jobs/<id>/complete    {workerId, result}                       -> {ok: true}
//   jobs/<id>/fail        {workerId, error}                        -> {ok: true}
//   blobs/read            {jobId, workerId, key}                   -> BlobRead
//   blobs/write           {jobId, workerId, key, bytes, contentType, sha256?} -> BlobWrite
//   blobs/commit          {jobId, workerId, key}                   -> {ok: true}
//   live/pieces           {jobId, workerId, after}                 -> LivePieces (a live-import job's own track)
//
// A blob is one stored file under a key inside the job's workspace ("assets/<sha256>.<ext>",
// "uploads/<id>", "exports/<job id>/<attempt>/video.mp4", "thumbs/<video id>.jpg", "stills/<job id>/<n>.png"). A job's
// result names only keys of its own (completeJob refuses others): an export's carries the attempt (ClaimedJob's
// `attempts`), so a worker that lost the job can never overwrite the next attempt's file. Storage caps
// one object's size, so a blob is kept as numbered parts: read gives a link per part, in order, to be joined;
// write gives an upload link per part for a file of the stated size, cut every partBytes; commit records it once
// every part is up. A worker may only read and write keys of the workspace its job belongs to (the app scopes
// every key itself; a key never carries a workspace id).
import { z } from 'zod'
import type { EditorAsset, EditorProject, EditorTranscript } from '../engine/contracts'
import type { FaceSample } from '../engine/director'
import type { LookInput, LookResult, MotionInput, MotionResult, ReviewInput, ReviewResult } from './check-contract'
import type { ListenInput, ListenResult, SoundBankInput, SoundBankResult, SoundImportInput, SoundImportResult, SoundJudgeInput, SoundJudgeResult, SoundMakeInput, SoundMakeResult, SoundsInput, SoundsResult } from './sound-contract'
import type { AdsMotionInput, AdsMotionResult, AdsReelInput, AdsReelResult, AdsStaticInput, AdsStaticResult } from './ads-contract'
import type { ContinuityInput, ContinuityResult, NarrationInput, NarrationUndelivered, NarrationWorkerResult, ShotInput, ShotQuoteInput, ShotQuoteResult, ShotResult, VoicesInput, VoicesResult } from './provider-contract'
import type { AudioUndelivered, GeneratedAudioWorkerResult, MusicInput, RevoiceInput, RevoiceWorkerResult, SoundEffectInput, VoiceSearchInput, VoiceSearchResult } from './provider-contract'

/** Bytes per stored part. Under the smallest per-object cap we run with (50 MB on our own server). */
export const STUDIO_PART_BYTES = 32 * 1024 * 1024

export const STUDIO_JOB_KINDS = [
  'import',      // an uploaded file becomes a library asset
  'export',      // a video renders to MP4
  'stills',      // frames of a video at given times, as PNGs (the agent's eyes, thumbnails of a moment)
  'thumbnail',   // one small JPEG of a video for lists
  'transcribe',  // an asset's speech as timed words
  'slides',      // a slide deck (PDF, PPTX, ODP) becomes one image asset per page
  // The paid providers (provider-contract.ts). Only a worker that says it can (capabilities below) asks for them.
  'voices',      // the ElevenLabs account's voices
  'narration',   // text to speech with word timings, as a library asset
  'shot-quote',  // the price of a beat's still or clip (free)
  'shot',        // a beat's still or clip made on the person's account (spends), stored as library assets
  'continuity',  // light and colour of generated beats against recorded ones (ffmpeg)
  // Vision (macOS only: the worker's Swift helpers over Apple's Vision framework). Only a worker that says it can asks.
  'cutout',      // recordings with the person (or subject) cut out, as transparent VP9 WebM library assets
  'faces',       // where the faces are in recordings, a few times a second (the app caches them by the bytes)
  // The measured checks (check-contract.ts). motion and review run the analysis script (numpy, OpenCV): only a worker
  // that says it can (`motionCheck`, `review`) asks for them. look needs only the renderer and FFmpeg.
  'motion',      // how the picture moves: a half-size muted render watched frame by frame, against reference films
  'review',      // the whole video scene by scene: on-screen text, speech, motion, sound, where a viewer gets lost
  'look',        // the visual check: frames with and without the overlays, text contrast, size and overflow
  // Sound design (sound-contract.ts), with earshot: only a worker that says it can (`sound`) asks for them.
  'sounds',       // cues rendered as sound effects levelled against the music, as library assets with their places
  'sound-import', // one sound or music file aligned on its onset or peak, levelled (a music bed cut and faded)
  'listen',       // the mix rendered as sound only and heard: transcript, scorecard, an annotated sheet image
  'sound-bank',   // the sound bank and the kit presets (quick)
  'sound-judge',  // earshot's ears on library or bank sounds: describe, measure, compare, rank, find, A/B, realness
  'sound-make',   // a sound made in code (forge) or a recording turned into code (fit), as library assets
  // Ads from a Studio project's brand kit (ads-contract.ts): Chromium and FFmpeg, every worker.
  'ads-static',   // a batch of static ads in their sizes, brand-checked, as library images, a report and a contact sheet
  'ads-motion',   // a 9:16 motion ad (and its 4:5 crop) from a brief, brand-checked, with its parts for an editable video
  'ads-reel',     // a 9:16 reel from the brand's own footage, with type beats and an end card
  // More of the voice provider (provider-contract.ts), on the same key and capability as narration (`voiceover`).
  'voice-search', // the account's voices and the shared voice library, by words and filters (free)
  'revoice',      // a library asset's speech re-spoken in another voice, its timing kept (spends)
  'sound-effect', // designed sound effects from a description, as library assets (spends)
  'music',        // music beds from a description, as library assets (spends)
  // A take prepared while it records (live-takes.ts): one per video track, queued when the take starts, taken only by
  // a worker's live slots (STUDIO_LIVE_SLOTS), never by its media or provider slots.
  'live-import',  // a track's pieces piped into one FFmpeg as they arrive, conformed as `import` would, a library asset at the end
] as const

/** The kinds only a worker's live slots take. */
export const LIVE_JOB_KINDS: readonly StudioJobKind[] = ['live-import']
export type StudioJobKind = (typeof STUDIO_JOB_KINDS)[number]

export type StudioJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

// ---- what each kind is given and gives back ----------------------------------------------------------------

/**
 * import: `uploadKey` is the blob the browser (or the desktop app) uploaded: `uploads/<id>`, or a track of a take
 * uploaded while it was recorded, `live/<take id>/<role>` (live-takes.ts). A live track is read like any blob, a link
 * per piece in order, but its pieces are as long as the recorder made them (each part says its own `bytes`) and it has
 * no sha256 until the worker reads it.
 */
export type ImportInput = {
  uploadKey: string
  name: string
  /** A recording's input trace (cursor, clicks, keys), when the recorder made one: stored on the asset as is. */
  trace?: unknown
  /** True when the recording hid the system cursor, so the editor may draw its own from the trace. */
  sourceCursorHidden?: boolean
  /**
   * Recorded files are conformed to a constant frame rate; uploads that already are stay untouched. With `fit`, `fps`
   * is the most: a recording whose frames came 45 a second or fewer while it moved is conformed to 30 (no frame is
   * made up to fill 60); a screen that was still between bursts of motion is judged by its bursts. `ceiling`: the
   * frame rate the recorder asked for or the device said it gives; a recording is never conformed above it.
   */
  conform?: { fps: 30 | 60; fit?: boolean; ceiling?: number }
  /**
   * The recording stopped before its end was saved (a window that closed mid-take, brought back afterwards): its last
   * piece may end mid-frame. The conform then reads past damage at the end instead of refusing the file.
   */
  partial?: boolean
  /** About how long the recording is, in seconds, when the app knows (time limits; a browser's WebM does not say). */
  durationHint?: number
  provenance?: Record<string, unknown>
}
/** The worker wrote blob `asset.file` (assets/<sha256>.<ext>) before completing. The app registers the asset. */
export type ImportResult = { asset: EditorAsset }

/**
 * live-import: a video track of a take being recorded, `uploadKey` its live key (`live/<take>/<role>`). The worker asks
 * the app for the track's pieces as they arrive (live/pieces below), pipes them in order into one FFmpeg with the
 * conform arguments `import` uses, and ends when the track is sealed and every piece is in. Its rate is the import's:
 * `conform.fps`, or with `conform.fit` the import's own rule (`fitRate`) on the frames that came, decided once enough of
 * the picture has moved and checked again on the whole take after the seal: when the two disagree the job fails, and
 * the ordinary import decides. Its result is an import's, with `rawBytes` and `rawPieces` the app checks against the
 * sealed track.
 */
export type LiveImportInput = Omit<ImportInput, 'partial' | 'durationHint' | 'trace'> & { conform: NonNullable<ImportInput['conform']> }

/**
 * A font face an export needs: `file` is the blob key of a woff2 file in the job's workspace
 * ("fonts/<family slug>/<file>.woff2"); weight is one number or a variable range ("100 900").
 */
export type ExportFont = { family: string; file: string; weight: string; style: 'normal' | 'italic' }

/**
 * export: the edit is frozen in the job; assets are read by their `file` keys. `fonts`: the faces of the families its
 * text uses (the app fills it when it queues the export); the worker stages them beside the bundle.
 */
export type ExportInput = { project: EditorProject; title: string; master?: { lufs: number; truePeak: number }; fonts?: ExportFont[] }
/** `key`: exports/<job id>/<attempt>/video.mp4. */
export type ExportResult = { key: string; bytes: number; width: number; height: number; fps: number; durationSeconds: number }

export type StillsInput = { project: EditorProject; times: number[]; scale: number }
export type StillsResult = { stills: { time: number; key: string; width: number; height: number }[] }

export type ThumbnailInput = { project: EditorProject; seconds: number; key: string }
export type ThumbnailResult = { key: string }

export type TranscribeInput = { asset: EditorAsset; language?: string }
export type TranscribeResult =
  | { outcome: 'transcribed'; transcript: EditorTranscript }
  | { outcome: 'no-speech' | 'no-audio' }

export type SlidesInput = { uploadKey: string; name: string }
export type SlidesResult = { deck: { id: string; name: string; width: number; height: number }; pages: EditorAsset[] }

/** What a cut-out isolates: people (person segmentation), or any main object (foreground instances). */
export type CutoutMode = 'person' | 'subject'
/** cutout: each recording (a library video asset) cut out; the worker stores each cut-out before completing. */
export type CutoutInput = { assets: EditorAsset[]; mode: CutoutMode }
/** One recording's cut-out: `asset` is the transparent WebM (`cutoutAssetId` is its id), stored as blob `asset.file`. */
export type CutoutMade = { assetId: string; cutoutAssetId: string; mode: CutoutMode; asset: EditorAsset }
export type CutoutResult = { cutouts: CutoutMade[] }

/** faces: face boxes of each recording every `every` seconds (default 0.2), on the recording's own clock. */
export type FacesInput = { assets: EditorAsset[]; every?: number }
export type FacesResult = { tracks: { assetId: string; sha256: string; every: number; samples: FaceSample[] }[] }

export type StudioJobIO = {
  import: { input: ImportInput; result: ImportResult }
  export: { input: ExportInput; result: ExportResult }
  stills: { input: StillsInput; result: StillsResult }
  thumbnail: { input: ThumbnailInput; result: ThumbnailResult }
  transcribe: { input: TranscribeInput; result: TranscribeResult }
  slides: { input: SlidesInput; result: SlidesResult }
  voices: { input: VoicesInput; result: VoicesResult }
  narration: { input: NarrationInput; result: NarrationWorkerResult | NarrationUndelivered }
  'shot-quote': { input: ShotQuoteInput; result: ShotQuoteResult }
  shot: { input: ShotInput; result: ShotResult }
  continuity: { input: ContinuityInput; result: ContinuityResult }
  cutout: { input: CutoutInput; result: CutoutResult }
  faces: { input: FacesInput; result: FacesResult }
  motion: { input: MotionInput; result: MotionResult }
  review: { input: ReviewInput; result: ReviewResult }
  look: { input: LookInput; result: LookResult }
  sounds: { input: SoundsInput; result: SoundsResult }
  'sound-import': { input: SoundImportInput; result: SoundImportResult }
  listen: { input: ListenInput; result: ListenResult }
  'sound-bank': { input: SoundBankInput; result: SoundBankResult }
  'sound-judge': { input: SoundJudgeInput; result: SoundJudgeResult }
  'sound-make': { input: SoundMakeInput; result: SoundMakeResult }
  'ads-static': { input: AdsStaticInput; result: AdsStaticResult }
  'ads-motion': { input: AdsMotionInput; result: AdsMotionResult }
  'ads-reel': { input: AdsReelInput; result: AdsReelResult }
  'voice-search': { input: VoiceSearchInput; result: VoiceSearchResult }
  revoice: { input: RevoiceInput; result: RevoiceWorkerResult | AudioUndelivered }
  'sound-effect': { input: SoundEffectInput; result: GeneratedAudioWorkerResult | AudioUndelivered }
  music: { input: MusicInput; result: GeneratedAudioWorkerResult | AudioUndelivered }
  'live-import': { input: LiveImportInput; result: ImportResult }
}

// ---- the worker's routes -----------------------------------------------------------------------------------

/**
 * What a worker can do beyond media work, said on every claim and progress report (capabilities.ts): `voiceover`
 * (it holds an ElevenLabs key), `generatedShots` (the higgsfield tool answers, signed in), `cutouts` and `faces` (a
 * worker on a Mac whose Vision helpers compiled and passed their self-test). The app keeps the latest
 * word about a minute. Optional: a worker that says nothing offers none.
 */
const WorkerCapabilities = z.array(z.string().min(1).max(40)).max(20).optional()
export const ClaimBody = z.object({ workerId: z.string().min(1).max(120), kinds: z.array(z.enum(STUDIO_JOB_KINDS)).min(1), capabilities: WorkerCapabilities })
export type ClaimedJob<K extends StudioJobKind = StudioJobKind> = {
  id: string
  kind: K
  workspaceId: string
  videoId: string | null
  input: StudioJobIO[K]['input']
  attempts: number
}

export const ProgressBody = z.object({
  workerId: z.string().min(1).max(120),
  progress: z.number().min(0).max(1),
  log: z.string().max(2000).optional(),
  capabilities: WorkerCapabilities,
})
export const CompleteBody = z.object({ workerId: z.string().min(1).max(120), result: z.unknown() })
export const FailBody = z.object({ workerId: z.string().min(1).max(120), error: z.string().min(1).max(4000) })

const blobKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,300}$/).refine((key) => !key.includes('..') && !key.includes('//'), 'Not a blob key')
export const BlobReadBody = z.object({ jobId: z.string().uuid(), workerId: z.string().min(1).max(120), key: blobKey })
export type BlobRead = { key: string; bytes: number; contentType: string; sha256: string | null; parts: { index: number; bytes: number; url: string }[] }

export const BlobWriteBody = z.object({
  jobId: z.string().uuid(),
  workerId: z.string().min(1).max(120),
  key: blobKey,
  bytes: z.number().int().min(0).max(20 * 1024 * 1024 * 1024),
  contentType: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
/** PUT each part's bytes to its url with the given headers; a part is partBytes long but the last. */
export type BlobWrite = { key: string; partBytes: number; parts: { index: number; bytes: number; url: string; headers: Record<string, string> }[] }
export const BlobCommitBody = z.object({ jobId: z.string().uuid(), workerId: z.string().min(1).max(120), key: blobKey })

/**
 * live/pieces {jobId, workerId, after} -> LivePieces: the held live-import job's own track, the pieces from index
 * `after` that are surely in storage (every declared piece but the newest, and the newest once storage has it at its
 * length), each with a read link. `sealed`: the track was handed to a recording (or brought back): `count` pieces make
 * it, `complete` false when it stopped before its end (read past damage at the end). `state` `dropped`: the take was
 * thrown away, stop. `quietMs`: how long since its newest piece was declared.
 */
export const LivePiecesBody = z.object({ jobId: z.string().uuid(), workerId: z.string().min(1).max(120), after: z.number().int().min(0).max(100_000), check: z.boolean().optional() })
export type LivePieces = {
  pieces: { index: number; bytes: number; url: string }[]
  /** How many pieces the track declares so far. */
  declared: number
  /** With `check`: the declared length of every piece below `after` (a worker resuming from its own copy compares). */
  lengths?: number[]
  sealed: { count: number; complete: boolean } | null
  state: 'recording' | 'finished' | 'dropped'
  quietMs: number
}
export { blobKey as BlobKey }

/** The parts a file of `bytes` is cut into. An empty file is one empty part. */
export function blobParts(bytes: number, partBytes = STUDIO_PART_BYTES): { index: number; bytes: number }[] {
  const count = Math.max(1, Math.ceil(bytes / partBytes))
  return Array.from({ length: count }, (_, index) => ({ index, bytes: index < count - 1 ? partBytes : bytes - partBytes * (count - 1) }))
}

/** A blob's object name in the studio bucket. */
export const blobObject = (workspaceId: string, key: string, index: number) => `${workspaceId}/${key}/${index}`
