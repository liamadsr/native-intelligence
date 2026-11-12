// The measured checks' half of the job contract (job-contract.ts names the kinds): what the app gives the Studio
// worker for a motion check, a video review and a visual check ("look"), and what each gives back. Types only, so
// the worker can import it by relative path like the rest of the contract.
//
//   motion   the picture rendered at half size, muted, for the range; the analysis script watches it frame by frame
//            and compares it with the bundled reference films and any library videos named as references
//   review   the same render with its sound, cut into scenes; on-screen text (when the worker has a text reader),
//            what is said (the video's transcript), layers, clicks, motion and sound per scene, flags, style rows
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
export type ReviewInput = CheckBase & { from?: number; to?: number; references?: CheckReference[]; context: ReviewContext }

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
