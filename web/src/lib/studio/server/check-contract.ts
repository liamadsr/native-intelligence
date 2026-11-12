// The measured checks' half of the job contract (job-contract.ts names the kinds): what the app gives the Studio
// worker for a motion check, a video review and a visual check ("look"), and what each gives back. Types only, so
// the worker can import it by relative path like the rest of the contract.
//
//   motion   the picture rendered at half size, muted, for the range; the analysis script watches it frame by frame
//            and compares it with the bundled reference films and any library videos named as references
//   review   the same render with its sound, cut into scenes; on-screen text (when the worker has a text reader),
//            what is said (the video's transcript), layers, clicks, motion and sound per scene, flags, style rows,
//            or a library video by itself (a reference), measured as it is, with no render. Either answers its
//            scene list with each scene's times and how it reads (sceneList)
//   look     frames every `step` seconds, rendered with and without the overlays: each overlay's footprint is the
//            difference; per text layer its contrast, size and overflow; a contact sheet
//
// Every file a check makes is stored under `checks/<job id>/<file>` in the job's workspace. None edits the video.
import type { EditorAsset, EditorProject } from '../engine/contracts'
import type { VisualIssue } from '../engine/server-types'

/** A font face the render needs (job-contract.ts ExportFont, repeated here to keep this file free of cycles). */
export type CheckFont = { family: string; file: string; weight: string; style: 'normal' | 'italic' }

/** A library video measured as a reference (read by its `file` key; the worker keeps its measurement by sha256). */
export type CheckReference = { asset: EditorAsset }

/** What every check is given: the edit frozen at queue time, the digest it had, the fonts its text uses. */
type CheckBase = { project: EditorProject; digest: string; fonts?: CheckFont[] }

/** motion: `from`/`to` in seconds on the video (the whole video when left out); `scale` of the render (default 0.5). */
export type MotionInput = CheckBase & { from?: number; to?: number; scale?: number; references?: CheckReference[] }

/** What the review knows from the edit that pixels can't tell, in seconds on the whole video. */
export type ReviewContext = {
  title: string
  words: { t: number; end: number; text: string }[]
  layers: { name: string; kind: string; text: string; start: number; end: number }[]
  clicks: number[]
}
/** review of a saved video: its edit rendered with its sound, then cut into scenes. */
export type ReviewVideoInput = CheckBase & { from?: number; to?: number; references?: CheckReference[]; context: ReviewContext }

/**
 * review of a library video by itself (a reference: an uploaded or imported file, not one of the workspace's edits):
 * the file is measured as it is, with no render and no edit. The worker keeps that measurement by the file's sha256,
 * so measuring the same file again costs nothing. Made for the reference blueprint (blueprint.ts).
 */
export type ReviewReferenceInput = { reference: CheckReference }

export type ReviewInput = ReviewVideoInput | ReviewReferenceInput

/** How a scene reads, from the measured numbers: text on screen, someone talking, something moving, a still, an empty frame. */
export type ReviewShot = 'text' | 'talk' | 'motion' | 'still' | 'empty'

/**
 * One scene as the review cut it, in seconds on the render (a reference's own clock for a library video). `onScreen`
 * is the text read in it, when the worker has a text reader; `said` the words of the transcript the review was given.
 */
export type ReviewScene = {
  index: number
  start: number
  end: number
  seconds: number
  shot: ReviewShot
  /** How it begins: start, cut, scene change, or the handoff the motion analysis saw. */
  entersBy: string
  /** The share of the scene in which something moves (0 to 1). */
  alive: number
  /** Its mean brightness (0 to 1). */
  luma: number
  said?: string
  words?: number
  onScreen?: string[]
  /** The most headline-sized words read in one frame of it. */
  wordsOnScreen?: number
  /** Its largest text's height as a share of the frame height. */
  textHeight?: number
}

/** look: a frame every `step` seconds (default 0.5) where an overlay shows, at `scale` (default 0.5). */
export type LookInput = CheckBase & { step?: number; scale?: number }

/** A handoff between beats as the motion analysis saw it (seconds on the render). */
export type MotionHandoff = { start: number; end: number; kind: string; empty_seconds?: number; moving?: number; kept?: number; picture?: string }
export type MotionIssue = { metric: string; label: string; ours: number; refs: number[]; severity: number; fix: string }

/**
 * motion's answer, in the shape the editor's Motion check reads. Times are on the render: add `offsetSeconds` for
 * the video's. `pictures` and each handoff's `picture` are file names under checks/<name>/.
 */
export type MotionResult = {
  name: string
  offsetSeconds: number
  summary: Record<string, unknown>
  text: string
  moves: number
  handoffs: MotionHandoff[]
  pictures: Record<string, string>
  compare: { score: number; issues: MotionIssue[]; rows?: unknown[]; text: string } | null
  references: string[]
  files: string[]
}

export type ReviewIssue = { at: number; end: number; scene: number; kind: string; severity: number; text: string }

/** review's answer, in the shape the editor's Review reads. Times are on the render (`offsetSeconds` as above). */
export type ReviewResult = {
  name: string
  offsetSeconds: number
  profile: Record<string, unknown>
  issues: ReviewIssue[]
  text: string
  pictures: Record<string, string>
  against?: { references: string[]; rows: unknown[]; in_range: number; of: number }
  scenes: number
  /** Every scene with its times (render clock), how it reads and its text. Left out by a worker from before it. */
  sceneList?: ReviewScene[]
  /** The library video measured, for a review of a reference (ReviewReferenceInput). */
  reference?: { assetId: string; sha256: string }
  /** Whether on-screen text was read (a text reader on the worker), with a sentence when not. */
  onScreenText: 'read' | 'not-read'
  note?: string
  files: string[]
}

/** look's answer: the engine's VisualReport (server-types.ts) plus what was and wasn't measured. `sheet` is a file name. */
export type LookResult = {
  projectId: string
  digest: string
  checkedAt: string
  times: number[]
  issues: VisualIssue[]
  sheet?: string
  folder: string
  /** Overlays on the person and their face need a person finder on the worker; without one only text is measured. */
  overlap: 'measured' | 'not-measured'
  note?: string
  files: string[]
}
