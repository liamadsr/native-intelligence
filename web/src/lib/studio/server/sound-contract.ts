// Sound design's jobs, as data both the app and the Studio worker read (job-contract.ts names the kinds; this file
// says what each is given and gives back). Pure (the engine's types only), so the worker imports it by relative path
// like the rest of the contract.
//
// The sound work runs in the worker with earshot (an MIT-licensed outside project, pinned to a reviewed commit:
// studio-worker/README.md, "Sound"), driven through a small JSON bridge (studio-worker/python/earshot_bridge.py).
// A worker offers it only when the tool answers (the `sound` capability). The app computes the cue sheet from the
// edit (engine/sound.ts, pure), queues the job, and applies what comes back to the video itself (sound.ts): a job
// never edits a video.
//
//   sounds        render cues (the automatic pass, or chosen sounds) as audio files levelled against the music bed,
//                 each a library asset with where it sits; and the music's step-down before big moments
//   sound-import  one sound or music file (a library asset or an upload) aligned on its onset or peak, levelled,
//                 cut and faded for a music bed
//   listen        the mix rendered (audio only) and heard by earshot: transcript, scorecard, an annotated sheet image
//   sound-bank    the sound bank and the kit presets (quick; the app keeps them)
import type { EditorAsset, EditorProject } from '../engine/contracts'
import type { SoundCue } from '../engine/sound'
import type { ExportFont } from './job-contract'

/** The kit presets earshot knows. */
export const SOUND_PRESETS = ['launch', 'crisp', 'calm', 'minimal'] as const
export type SoundPreset = (typeof SOUND_PRESETS)[number]

/** What listen can be asked to do. */
export const LISTEN_CHECKS = ['timeline', 'critique', 'sheet'] as const
export type ListenCheck = (typeof LISTEN_CHECKS)[number]

/** One piece of the music bed on the timeline's clock (a segment of an unmuted music track). */
export type BedPiece = { asset: EditorAsset; atSeconds: number; trimStartSeconds: number; trimEndSeconds: number; gain: number }

/** The Music track's one segment, for the step-down: the file it plays now and the take it was ducked from. */
export type MusicSegment = { segmentId: string; atSeconds: number; trimStartSeconds: number; currentAssetId: string; source: EditorAsset }

/**
 * sounds: `cues` rendered with the preset. `mode` 'pass' replaces the earlier automatic pass when applied, 'add'
 * keeps everything and drops only `replaceIds`. `bed`: the music to level against (none: each role's own level).
 */
export type SoundsInput = {
  mode: 'pass' | 'add'
  preset: SoundPreset
  cues: SoundCue[]
  bed: BedPiece[]
  music: MusicSegment | null
  replaceIds?: string[]
}

/** One rendered cue: its library asset (stored as blob `asset.file`) and where it sits so its sync point lands. */
export type RenderedSound = {
  cueId: string
  asset: EditorAsset
  startSeconds: number
  trimSeconds: number
  durationSeconds: number
  sound: string
  role: string | null
  gainDb: number
  label: string
}

/** What happens to the music bed: stepped down before big moments (a new take), or back to the take as imported. */
export type MusicChange =
  | { action: 'duck'; segmentId: string; currentAssetId: string; sourceId: string; asset: EditorAsset; moments: number[] }
  | { action: 'restore'; segmentId: string; currentAssetId: string; sourceId: string }

export type SoundsResult = { preset: SoundPreset; placed: RenderedSound[]; notes: string[]; music: MusicChange | null }

/**
 * sound-import: one file from the library (`asset`) or an upload (`uploadKey` + `name`), placed at `at` seconds.
 * track 'music': the bed from `at` to the video's end (`endSeconds` long at most), faded out over `fadeOut` seconds.
 */
export type SoundImportInput = {
  asset?: EditorAsset
  uploadKey?: string
  name: string
  at: number
  align: 'onset' | 'peak'
  offsetMs?: number
  levelDb?: number
  label?: string
  track: 'sfx' | 'music'
  fadeOut?: number
  from?: number
  endSeconds?: number
}
export type SoundImportResult = { asset: EditorAsset; startSeconds: number; trimSeconds: number; durationSeconds: number; track: 'sfx' | 'music'; name: string; label: string }

/** earshot's cue-file format (engine/sound.ts earshotCueFile): what its checks sync against. */
export type EarshotCueFile = { fps: number; total: number; events: { f: number; kind: string; id: string; weight: number; dur?: number }[] }

/** listen: the edit frozen in the job, rendered as sound only, heard against its own cue sheet. */
export type ListenInput = { project: EditorProject; cues: EarshotCueFile; checks: ListenCheck[]; fonts?: ExportFont[] }
export type ListenResult = {
  seconds: number
  timeline?: { summary?: unknown; text?: string }
  critique?: { verdict?: string; score?: number; text?: string }
  /** The annotated sheet, stored as blob `key` ("listen/<job id>/sheet.png"). */
  sheet?: { key: string; summary?: unknown }
}

export type SoundBankInput = Record<string, never>
/** One sound of the bank as earshot lists it (id, category, kinds, knobs, notes…). */
export type BankSound = { id: string; category?: string; kinds?: string[]; notes?: string; [field: string]: unknown }
export type SoundBankResult = { version: string; sounds: BankSound[]; presets: Record<string, { note?: string | null; roles: Record<string, { sound: string; [field: string]: unknown }> }> }
