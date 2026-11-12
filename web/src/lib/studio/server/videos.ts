// Videos: one edit each (studio_video). `doc` is the whole edit, the editor's project document, validated before
// every write; `digest` is the hash of that document. Every writer names the digest it read: a save against a
// digest that is no longer current is refused (409, the editor keeps its draft and offers to reload), so a person
// and the agent never overwrite each other silently. `summary` is what lists show without opening `doc`.
// `archived_at` is the trash.
//
// The HTTP paths keep the editor's own words: /projects/:id is a video here.
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { parseEditorProject, type EditorAsset, type EditorProject } from '../engine/contracts'
import type { EditorBootstrap } from '../engine/api'
import type { ProjectSummary } from '../engine/server-types'
import { scheduleProject } from '../engine/timeline'
import { getAssets, getTranscripts, listAssets } from './assets'
import { isDuplicate, isUuid, must, type StudioContext } from './context'
import { conflictError, digestConflict, notFoundError, StudioError, zodSentence } from './errors'
import { checkCapabilities, currentCapabilities, soundCapabilities, visionCapabilities, type StudioCapabilities, type VisionCapabilities } from './capabilities'
import { activeJob } from './jobs'
import { addSibling, afterVideoSave } from './projects'
import { listPresets } from './records'
import { asStored, docDigest, sameJson } from './stable'

/** The stored summary: a ProjectSummary without what the row itself holds (id, title, updatedAt). */
export type StoredSummary = Omit<ProjectSummary, 'id' | 'title' | 'updatedAt'>

/** What a list shows of a video, from its edit: length, clips, shape, cast and the moment a thumbnail is taken from. */
export function summarizeVideo(project: EditorProject): StoredSummary {
  const schedule = scheduleProject(project)
  // The thumbnail is the first real footage (a blank canvas under an opening animation would show a plain colour).
  const first = schedule.find((s) => s.asset.kind === 'video' && !/^Blank canvas/.test(s.asset.name)) ?? schedule[0]!
  const last = schedule.at(-1)!
  return {
    durationSeconds: (last.startFrame + last.durationFrames) / project.output.fps,
    clipCount: project.clips.length,
    hasCamera: !!project.presenterTrack,
    hasSlides: !!project.slideDeck,
    width: project.output.width,
    height: project.output.height,
    castCount: project.storyboard?.cast?.length ?? 0,
    thumbnail: {
      assetId: first.asset.id,
      seconds: Math.max(0, Math.min((first.asset.durationSeconds ?? 1) - 0.05, first.clip.trimStartSourceFrame / (first.asset.sourceFps ?? 30) + 1)),
    },
  }
}

/** The moment of the edit (timeline seconds) a thumbnail shows: a second into the first real footage. */
export function thumbnailSeconds(project: EditorProject): number {
  const schedule = scheduleProject(project)
  const first = schedule.find((s) => s.asset.kind === 'video' && !/^Blank canvas/.test(s.asset.name)) ?? schedule[0]!
  const fps = project.output.fps
  return (first.startFrame + Math.min(fps, Math.max(0, first.durationFrames - 1))) / fps
}

/**
 * A document checked as an edit: the schema, and every asset and transcript it embeds exactly as registered in
 * the workspace's library (so media details can't be changed by hand).
 */
export async function validateVideo(ctx: StudioContext, value: unknown): Promise<EditorProject> {
  let project: EditorProject
  try {
    project = parseEditorProject(value)
  } catch (error) {
    if (error instanceof ZodError) throw new StudioError(zodSentence(error, 'The edit'), 400, 'INVALID')
    throw new StudioError(error instanceof Error ? error.message : 'The edit is not valid.', 400, 'INVALID')
  }
  const registered = await getAssets(ctx, project.assets.map((asset) => asset.id))
  for (const asset of project.assets) {
    const known = registered.get(asset.id)
    if (!known || !sameJson(known, asset)) throw new StudioError('This video has media details the Studio did not record, or that were changed', 400, 'UNREGISTERED_ASSET')
  }
  if (project.transcripts.length) {
    const transcripts = await getTranscripts(ctx, project.transcripts.map((t) => t.id))
    for (const transcript of project.transcripts) {
      const known = transcripts.get(transcript.id)
      if (!known || !sameJson(known, transcript)) throw new StudioError('This video has transcript timing the Studio did not record, or that was changed', 400, 'UNREGISTERED_TRANSCRIPT')
    }
  }
  return project
}

export type VideoRow = {
  id: string
  title: string
  doc: unknown
  digest: string
  revision: number
  summary: StoredSummary
  studio_project_id: string | null
  status: 'draft' | 'review' | 'approved'
  variant_of: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

const ROW_FIELDS = 'id, title, doc, digest, revision, summary, studio_project_id, status, variant_of, created_at, updated_at, archived_at'
const LIST_FIELDS = 'id, title, summary, studio_project_id, status, variant_of, created_at, updated_at'

/** A video's row (with its document), or null when it is not in this workspace. Trashed ones too. */
export async function getVideoRow(ctx: StudioContext, id: string): Promise<VideoRow | null> {
  if (!isUuid(id)) return null
  return must(await ctx.supabase.from('studio_video').select(ROW_FIELDS).eq('workspace_id', ctx.workspaceId).eq('id', id).maybeSingle(), 'open that video') as VideoRow | null
}

/** Open a video: its edit and the digest a save must name. 404 when missing or trashed. */
export async function openVideo(ctx: StudioContext, id: string): Promise<{ project: EditorProject; projectDigest: string; row: VideoRow }> {
  const row = await getVideoRow(ctx, id)
  if (!row || row.archived_at) throw notFoundError('Video not found')
  let project: EditorProject
  try {
    project = parseEditorProject(row.doc)
  } catch {
    throw new StudioError("This video's saved edit can't be read.", 500, 'UNREADABLE')
  }
  return { project, projectDigest: row.digest, row }
}

/** The current digest of a video (the editor polls this every two seconds): one indexed read of one column. */
export async function videoDigest(ctx: StudioContext, id: string): Promise<string> {
  if (!isUuid(id)) throw notFoundError('Video not found')
  const row = must(
    await ctx.supabase.from('studio_video').select('digest').eq('workspace_id', ctx.workspaceId).eq('id', id).is('archived_at', null).maybeSingle(),
    'read that video',
  ) as { digest: string } | null
  if (!row) throw notFoundError('Video not found')
  return row.digest
}

export type SaveOptions = {
  /** After the save, share the video's cast with the other videos of its project (default true). */
  share?: boolean
  /** For a new video: the studio project it is filed in. */
  studioProjectId?: string | null
}

/**
 * Save an edit. `expectedDigest`: the digest the writer read (a stale one is refused), null for "this is a new
 * video" (refused when one exists), undefined to write without checking. Answers the saved edit and its digest.
 */
export async function saveVideo(
  ctx: StudioContext,
  value: unknown,
  expectedDigest?: string | null,
  options: SaveOptions = {},
): Promise<{ project: EditorProject; projectDigest: string }> {
  if (expectedDigest !== undefined && expectedDigest !== null && (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)))
    throw new StudioError('Invalid expectedDigest')
  const project = await validateVideo(ctx, value)
  if (!isUuid(project.id)) throw new StudioError('A video id is a UUID.', 400, 'INVALID')
  const row = must(
    await ctx.supabase.from('studio_video').select('id, digest, revision, archived_at').eq('workspace_id', ctx.workspaceId).eq('id', project.id).maybeSingle(),
    'save that video',
  ) as Pick<VideoRow, 'id' | 'digest' | 'revision' | 'archived_at'> | null
  if (row?.archived_at) throw notFoundError('This video is in the trash.')
  if (expectedDigest !== undefined && (row ? expectedDigest !== row.digest : expectedDigest !== null)) throw digestConflict()
  const stored = asStored(project)
  const digest = docDigest(stored)
  const summary = summarizeVideo(stored)
  if (!row) {
    const { error } = await ctx.supabase.from('studio_video').insert({
      id: stored.id,
      workspace_id: ctx.workspaceId,
      studio_project_id: options.studioProjectId ?? null,
      title: stored.title,
      doc: stored,
      digest,
      summary,
      created_by: ctx.userId,
    })
    if (error) {
      if (isDuplicate(error)) throw conflictError('That video id is taken.')
      must({ data: null, error }, 'save that video')
    }
  } else if (row.digest !== digest) {
    const updated = must(
      await ctx.supabase
        .from('studio_video')
        .update({ title: stored.title, doc: stored, digest, summary, revision: row.revision + 1 })
        .eq('workspace_id', ctx.workspaceId)
        .eq('id', stored.id)
        .eq('revision', row.revision)
        .is('archived_at', null)
        .select('id'),
      'save that video',
    ) as { id: string }[] | null
    if (!updated?.length) throw digestConflict()
  }
  if (options.share !== false) {
    await afterVideoSave(ctx, stored).catch((error) => console.error('[studio] sharing the cast after a save failed:', error instanceof Error ? error.message : error))
  }
  return { project: stored, projectDigest: digest }
}

type ListRow = Pick<VideoRow, 'id' | 'title' | 'summary' | 'studio_project_id' | 'status' | 'variant_of' | 'created_at' | 'updated_at'>

/** Every video's list row (not trashed), most recently changed first. */
export async function listVideoRows(ctx: StudioContext): Promise<ListRow[]> {
  return (must(
    await ctx.supabase.from('studio_video').select(LIST_FIELDS).eq('workspace_id', ctx.workspaceId).is('archived_at', null).order('updated_at', { ascending: false }).limit(2000),
    'list videos',
  ) ?? []) as ListRow[]
}

/** A list row as the editor's ProjectSummary. */
export const toSummary = (row: Pick<ListRow, 'id' | 'title' | 'summary' | 'updated_at'>): ProjectSummary => ({ ...row.summary, id: row.id, title: row.title, updatedAt: row.updated_at })

/** Newest-first summaries for the video list. */
export async function listVideos(ctx: StudioContext): Promise<ProjectSummary[]> {
  return (await listVideoRows(ctx)).map(toSummary)
}

/** A new video from an edit (its id must be new). */
export async function createVideo(ctx: StudioContext, project: EditorProject, options: SaveOptions = {}) {
  return saveVideo(ctx, project, null, options)
}

/** A copy of a video as a new one ("<title> copy"), filed next to it. */
export async function duplicateVideo(ctx: StudioContext, id: string): Promise<EditorProject> {
  const { project } = await openVideo(ctx, id)
  const copy = { ...project, id: randomUUID(), title: `${project.title.slice(0, 240)} copy` }
  const saved = await saveVideo(ctx, copy, null, { share: false })
  await addSibling(ctx, id, saved.project.id, false)
  return saved.project
}

/** Rename a video. */
export async function renameVideo(ctx: StudioContext, id: string, title: unknown): Promise<EditorProject> {
  if (typeof title !== 'string' || !title.trim() || title.length > 250) throw new StudioError('Choose a name up to 250 characters')
  const { project, projectDigest } = await openVideo(ctx, id)
  return (await saveVideo(ctx, { ...project, title: title.trim() }, projectDigest)).project
}

/** Move a video to the trash (media and other videos are untouched). Answers the remaining list. */
export async function archiveVideo(ctx: StudioContext, id: string): Promise<ProjectSummary[]> {
  if (!isUuid(id)) throw notFoundError('Video not found')
  const done = must(
    await ctx.supabase.from('studio_video').update({ archived_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).eq('id', id).is('archived_at', null).select('id'),
    'move that video to the trash',
  ) as { id: string }[] | null
  if (!done?.length) throw notFoundError('Video not found')
  return listVideos(ctx)
}

/** Take a video out of the trash (the Undo of archiveVideo, from the entity actions menu). Answers the list. */
export async function restoreVideo(ctx: StudioContext, id: string): Promise<ProjectSummary[]> {
  if (!isUuid(id)) throw notFoundError('Video not found')
  const done = must(
    await ctx.supabase.from('studio_video').update({ archived_at: null }).eq('workspace_id', ctx.workspaceId).eq('id', id).not('archived_at', 'is', null).select('id'),
    'take that video out of the trash',
  ) as { id: string }[] | null
  if (!done?.length) throw notFoundError('Video not found')
  return listVideos(ctx)
}

/** Library assets named in a text by their 64-hex id that an edit does not hold yet (ops and scenes bring them along). */
export async function namedLibraryAssets(ctx: StudioContext, project: EditorProject, text: string): Promise<EditorAsset[]> {
  const named = new Set([...text.matchAll(/\b[a-f0-9]{64}\b/g)].map((m) => m[0]))
  for (const asset of project.assets) named.delete(asset.id)
  if (!named.size) return []
  return [...(await getAssets(ctx, [...named])).values()]
}

/**
 * What the editor opens with: the video asked for (else the most recently changed), the list, the library, the
 * presets and the person's running export or transcription, if any.
 */
export async function bootstrap(ctx: StudioContext, preferId?: string | null): Promise<EditorBootstrap & { workspaceId: string; capabilities: StudioCapabilities & VisionCapabilities & { sound: boolean; motionCheck: boolean; review: boolean } }> {
  const [rows, assets, presets] = await Promise.all([listVideoRows(ctx), listAssets(ctx), listPresets(ctx)])
  let opened: { project: EditorProject | null; projectDigest: string | null } = { project: null, projectDigest: null }
  const pick = (preferId && rows.find((row) => row.id === preferId)) || rows[0]
  if (pick) {
    try {
      const { project, projectDigest } = await openVideo(ctx, pick.id)
      opened = { project, projectDigest }
    } catch (error) {
      console.error('[studio] bootstrap could not open a video:', error instanceof Error ? error.message : error)
    }
  }
  const job = ctx.userId ? await activeJob(ctx, ctx.userId).catch(() => null) : null
  return {
    ...opened,
    projects: rows.map((row) => ({ id: row.id, title: row.title })),
    assets,
    presets,
    job,
    workspaceId: ctx.workspaceId,
    // What the Studio worker running now can do (capabilities.ts): a part it can't draws no button.
    capabilities: { ...currentCapabilities(ctx), ...visionCapabilities(), ...soundCapabilities(), ...checkCapabilities() },
  }
}

/** True when two edits differ (JSON, key order aside). */
export const editChanged = (a: unknown, b: unknown) => !sameJson(a, b)
