// Media coming in and going out: browser uploads (straight to storage, through links signed per part), what the
// editor asks of an upload (a library asset, a camera recording conformed to 30 fps, a slide deck as page images),
// transcription, and export. Each is a job the worker does (jobs.ts); the editor's old one-call answers are kept
// by waiting on the job for a while (`wait`).
import { randomUUID } from 'node:crypto'
import type { EditorAsset, EditorProject } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { commitBlob, createBlobWrite, uploadKey } from './blobs'
import type { StudioContext } from './context'
import { StudioError } from './errors'
import { exportFonts } from './fonts'
import { cancelJob, getJob, queueJob, toEditorJob, waitForJob, type JobRow } from './jobs'
import { noteExportWatched } from './delivery'
import { typeForName } from './media-types'
import { COLLECTIONS, listRecords } from './records'
import { getVideoRow, validateVideo } from './videos'
import { checkOpenLocalExports, localToken } from './local-jobs'
import { STUDIO_RENDER_VERSION } from '../engine/render-version'

/** The largest upload: 2 GB (a long screen recording). */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3
/** The largest slide deck: 500 MB. */
export const MAX_DECK_BYTES = 500 * 1024 ** 2

const PRESENTER_EXTENSIONS = ['.webm', '.mp4', '.mov', '.mkv']
const DECK_EXTENSIONS = ['.pdf', '.pptx', '.ppt', '.odp']

/** A file name as uploaded: no folders, no control characters, at most 250 characters. */
export function checkFileName(name: unknown, what = 'File'): string {
  if (typeof name !== 'string' || !name.trim()) throw new StudioError(`${what} name required`)
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.length > 250) throw new StudioError(`Invalid ${what.toLowerCase()} name`)
  return name.trim()
}

const extension = (name: string) => (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase()

/**
 * Upload links for a file the browser is about to send: {uploadKey, partBytes, parts:[{index, bytes, url, headers}]}.
 * The browser's stated type is ignored: the type comes from the file name, through the media allowlist
 * (media-types.ts), so an upload can never be stored, or served back, as a page.
 */
export async function startUpload(ctx: StudioContext, body: { name?: unknown; bytes?: unknown; contentType?: unknown }) {
  const name = checkFileName(body.name)
  const bytes = Number(body.bytes)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new StudioError('Choose a file that is not empty.')
  if (bytes > MAX_UPLOAD_BYTES) throw new StudioError('Import exceeds 2 GB')
  const write = await createBlobWrite(ctx, { key: uploadKey(randomUUID()), bytes, contentType: typeForName(name) })
  return { uploadKey: write.key, partBytes: write.partBytes, parts: write.parts }
}

/** An upload of this person's, checked and committed (every part there at its size). */
async function takeUpload(ctx: StudioContext, key: unknown, max: number, tooLarge: string) {
  if (typeof key !== 'string' || !/^uploads\/[0-9a-f-]{36}$/.test(key)) throw new StudioError('Upload the file first.')
  const blob = await commitBlob(ctx, key)
  if (blob.bytes > max) throw new StudioError(tooLarge)
  return blob
}

/** What a finished job answers in the editor's old one-call shape; a failure throws its reason. */
function finished<T>(row: JobRow, shape: (job: EditorJob) => T): T | { job: EditorJob } {
  const job = toEditorJob(row)
  if (row.status === 'failed') throw new StudioError(row.error || 'That did not finish.', 422, 'JOB_FAILED')
  if (row.status === 'cancelled') throw new StudioError('Cancelled.', 409, 'JOB_CANCELLED')
  if (row.status !== 'completed') return { job }
  return shape(job)
}

/** Wait (when asked) for a queued job, else answer it to be polled. */
async function answer<T>(ctx: StudioContext, row: JobRow, wait: boolean, shape: (job: EditorJob) => T, signal?: AbortSignal) {
  if (!wait) return { job: toEditorJob(row) }
  return finished(await waitForJob(ctx, row.id, { signal }), shape)
}

/** An uploaded file becomes a library asset: {asset} once done (with `wait`), else {job}. */
export async function importUpload(ctx: StudioContext, body: { uploadKey?: unknown; name?: unknown }, options: { wait?: boolean; signal?: AbortSignal } = {}) {
  const name = checkFileName(body.name)
  const blob = await takeUpload(ctx, body.uploadKey, MAX_UPLOAD_BYTES, 'Import exceeds 2 GB')
  const row = await queueJob(ctx, 'import', { uploadKey: blob.key, name })
  return answer(ctx, row, !!options.wait, (job) => ({ asset: job.asset as EditorAsset }), options.signal)
}

/** A camera recording becomes a library asset at a steady 30 fps: {asset, rawSha256, rawBytes} once done, else {job}. */
export async function importPresenter(ctx: StudioContext, body: { uploadKey?: unknown; name?: unknown }, options: { wait?: boolean; signal?: AbortSignal } = {}) {
  const name = checkFileName(body.name, 'Presenter file')
  if (!PRESENTER_EXTENSIONS.includes(extension(name))) throw new StudioError('Presenter source must be WebM, MP4, MOV, or MKV')
  const blob = await takeUpload(ctx, body.uploadKey, MAX_UPLOAD_BYTES, 'Presenter source exceeds 2 GB')
  const label = `${name.replace(/\.[^.]+$/, '').slice(0, 220)} · presenter.mp4`
  const row = await queueJob(ctx, 'import', { uploadKey: blob.key, name: label, conform: { fps: 30 }, provenance: { presenter: true, uploadedName: name } })
  return answer(ctx, row, !!options.wait, (job) => ({ asset: job.asset as EditorAsset, rawSha256: String((job.result as { rawSha256?: string } | undefined)?.rawSha256 ?? ''), rawBytes: Number((job.result as { rawBytes?: number } | undefined)?.rawBytes ?? blob.bytes) }), options.signal)
}

/** A slide deck (PDF, PowerPoint, OpenDocument) becomes one image per page: {deck} once done, else {job}. */
export async function importSlides(ctx: StudioContext, body: { uploadKey?: unknown; name?: unknown }, options: { wait?: boolean; signal?: AbortSignal } = {}) {
  const name = checkFileName(body.name, 'Slide file')
  const ext = extension(name)
  if (ext === '.key') throw new StudioError('Keynote decks can’t be read here. Export it as PDF from Keynote and import that.')
  if (!DECK_EXTENSIONS.includes(ext)) throw new StudioError('Choose a PDF, PowerPoint (.pptx) or OpenDocument (.odp) deck.')
  const blob = await takeUpload(ctx, body.uploadKey, MAX_DECK_BYTES, 'Slide decks must be nonempty and at most 500 MB')
  const row = await queueJob(ctx, 'slides', { uploadKey: blob.key, name })
  return answer(ctx, row, !!options.wait, (job) => ({ deck: (job.result as { deck?: unknown } | undefined)?.deck }), options.signal)
}

/** The workspace's slide decks, newest first. */
export async function listSlideDecks(ctx: StudioContext) {
  const rows = await listRecords<{ createdAt: string }>(ctx, COLLECTIONS.slides)
  return rows.map((row) => row.value).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/**
 * Queue the render of an edit to MP4, the one way every export is queued (the editor's and the agent's): the edit is
 * frozen in the job (checked first), with its loudness target and the font faces its text uses. `source` says who
 * asked (delivery.ts).
 */
export async function queueExport(ctx: StudioContext, project: unknown, source: 'editor' | 'agent'): Promise<JobRow> {
  const checked: EditorProject = await validateVideo(ctx, project)
  // The job names its video when the edit is a saved one (an unsaved draft exports all the same).
  const saved = (await getVideoRow(ctx, checked.id)) ? checked.id : null
  // The faces of the families its text uses (missing ones installed first), for the worker to stage.
  const fonts = await exportFonts(ctx, checked).catch(() => [])
  return queueJob(ctx, 'export', { project: checked, title: checked.title, source, ...(checked.master ? { master: checked.master } : {}), ...(fonts.length ? { fonts } : {}) }, saved)
}

/** Whether an edit plays code scenes (a layer naming a scene module): those run only on the server's worker. Pure. */
export function playsCodeScenes(project: EditorProject): boolean {
  return (project.layers ?? []).some((layer) => {
    const scene = (layer as { style?: { scene?: { id?: unknown } } }).style?.scene
    return !!scene && typeof scene.id === 'string'
  })
}

/** What a computer whose engine is not the Studio's is told (the Export dialog shows it, then exports on the server). */
export const RENDER_VERSION_REFUSAL = "This computer's Studio app is a different version from the Studio, so it can't export this video. It's exported on our server instead."
/** What a computer is told for a video with code scenes. */
export const CODE_SCENES_REFUSAL = 'This video has code scenes, which only our server runs. It’s exported on our server instead.'

/**
 * Queue an export to run on the person's own computer, in the desktop app (job-contract.ts `local-export`): from the
 * editor only (the agent's exports stay on the server). Refused (409) when the computer's engine is not this Studio's
 * (`renderVersion`, engine/render-version.ts) or the video plays code scenes; the editor then exports on the server.
 */
export async function queueLocalExport(ctx: StudioContext, project: unknown, renderVersion: unknown): Promise<JobRow> {
  if (renderVersion !== STUDIO_RENDER_VERSION) throw new StudioError(RENDER_VERSION_REFUSAL, 409, 'RENDER_VERSION')
  const checked: EditorProject = await validateVideo(ctx, project)
  if (playsCodeScenes(checked)) throw new StudioError(CODE_SCENES_REFUSAL, 409, 'CODE_SCENES')
  await checkOpenLocalExports(ctx)
  const saved = (await getVideoRow(ctx, checked.id)) ? checked.id : null
  const fonts = await exportFonts(ctx, checked).catch(() => [])
  return queueJob(ctx, 'local-export', { project: checked, title: checked.title, source: 'editor', renderVersion: STUDIO_RENDER_VERSION, ...(checked.master ? { master: checked.master } : {}), ...(fonts.length ? { fonts } : {}) }, saved)
}

/**
 * Render an edit to MP4 from the editor (delivery.ts tells the person only if they left before it finished). `where`
 * 'computer' queues it for the desktop app on the person's own computer and answers the token the editor hands it;
 * anything else, on the server.
 */
export async function startExport(ctx: StudioContext, project: unknown, options: { where?: unknown; renderVersion?: unknown } = {}): Promise<{ job: EditorJob; local?: { token: string; expiresAt: string } }> {
  if (options.where === 'computer') {
    const row = await queueLocalExport(ctx, project, options.renderVersion)
    return { job: toEditorJob(row), local: await localToken(ctx, row.id) }
  }
  return { job: toEditorJob(await queueExport(ctx, project, 'editor')) }
}

/** A job as the editor polls it. A running export polled is one the person is watching (delivery.ts). */
export async function jobStatus(ctx: StudioContext, id: string): Promise<{ job: EditorJob }> {
  const job = await getJob(ctx, id)
  await noteExportWatched(ctx, job)
  return { job }
}

/** Ask a job to stop. */
export async function stopJob(ctx: StudioContext, id: string): Promise<{ job: EditorJob }> {
  return { job: await cancelJob(ctx, id) }
}
