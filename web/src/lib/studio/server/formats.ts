// Formats: the same video for a platform's shape (YouTube, Shorts, TikTok, Reels, a square feed…). A format is a
// reframed view of the edit (engine/formats.ts), shown and exported as chosen, never a rewrite of it; a separate
// version for a platform can also be saved as its own video, filed as an output of the original.
//
// Camera crops centre on the person's face when a narrower format is chosen. The faces come from the Studio worker's
// face tracks (vision.ts: cached by the recording's bytes, else a faces job waited on briefly). Without a worker on a
// Mac to find them, every crop is centred (the answers have the same shape either way); while a faces job is still
// running, the focus is not stored, so the next choice of a format measures it.
import { cameraFocusAll, exportPresets, forPreset } from '../engine/formats'
import type { EditorProject } from '../engine/contracts'
import type { StudioContext } from './context'
import { StudioError } from './errors'
import { uuidFor } from './ids'
import { addSibling } from './projects'
import { getVideoRow, openVideo, saveVideo } from './videos'
import { cameraAssets, FACES_PENDING, FACES_WAIT_MS, focusFootage, gatherFaces, type GatheredFaces } from './vision'

/** Faces found in a video's footage (`footage` picks which recordings), by asset. */
async function videoFaces(ctx: StudioContext, project: EditorProject, footage: (p: EditorProject) => ReturnType<typeof focusFootage> = focusFootage, waitMs = FACES_WAIT_MS): Promise<GatheredFaces> {
  const assets = footage(project)
  return assets.length ? gatherFaces(ctx, project.id, assets, { waitMs }) : { tracks: {}, state: 'measured', logs: [] }
}

/** Refuse while the faces job is still running: a crop measured now would stay centred for good. */
function measured(faces: GatheredFaces): GatheredFaces {
  if (faces.state === 'pending') throw new StudioError(FACES_PENDING, 503, 'FACES_PENDING')
  return faces
}

/** The platform presets. */
export function listFormats() {
  return { presets: exportPresets }
}

/** Where each camera clip's crop centres in a narrower format, measured without saving. */
export async function deliveryFocus(ctx: StudioContext, videoId: string, waitMs = FACES_WAIT_MS) {
  const { project } = await openVideo(ctx, videoId)
  const faces = measured(await videoFaces(ctx, project, focusFootage, waitMs))
  return { focus: cameraFocusAll(project, faces.tracks), faces: faces.state }
}

/** Show and export a video in a format ('original' or a preset id), in place: a view of the edit, nothing rewritten. */
export async function setDelivery(ctx: StudioContext, videoId: string, format: unknown, waitMs = FACES_WAIT_MS) {
  const id = String(format ?? '')
  if (id !== 'original' && !exportPresets.some((p) => p.id === id)) throw new StudioError(`Unknown format; choose original or ${exportPresets.map((p) => p.id).join(', ')}`)
  const opened = await openVideo(ctx, videoId)
  const p = opened.project
  const preset = exportPresets.find((x) => x.id === id)
  const narrower = !!preset && preset.width / preset.height < p.output.width / p.output.height - 0.01
  let focus = p.delivery?.focus
  // An empty focus found no face (or none could be looked for): measured again, from cached tracks once they exist.
  if (narrower && (!focus || !Object.keys(focus).length)) {
    const faces = await videoFaces(ctx, p, focusFootage, waitMs)
    if (faces.state !== 'pending') focus = cameraFocusAll(p, faces.tracks)
  }
  return saveVideo(ctx, { ...p, delivery: { format: id, ...(focus ? { focus } : {}) } }, opened.projectDigest)
}

/** A separate video for a platform (its shape, loudness and rules), filed as an output of this one. Made again in place when it exists. */
export async function makeFormatVersion(ctx: StudioContext, videoId: string, presetId: unknown) {
  const preset = exportPresets.find((p) => p.id === presetId)
  if (!preset) throw new StudioError(`Unknown format; choose one of ${exportPresets.map((p) => p.id).join(', ')}`)
  const opened = await openVideo(ctx, videoId)
  const made = forPreset(opened.project, preset, measured(await videoFaces(ctx, opened.project, cameraAssets)).tracks)
  // One output per platform per video: its id is fixed by the two, so asking again remakes the same video.
  const id = uuidFor(`${opened.project.id}:${preset.id}`)
  const existing = await getVideoRow(ctx, id)
  if (existing?.archived_at) throw new StudioError(`The ${preset.label} version of this video is in the trash.`)
  const saved = await saveVideo(ctx, { ...made.project, id, title: `${opened.project.title} · ${preset.label}`.slice(0, 250) }, existing ? existing.digest : null)
  await addSibling(ctx, opened.project.id, saved.project.id, true)
  return { projectId: saved.project.id, warnings: made.warnings }
}
