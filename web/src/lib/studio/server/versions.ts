// Earlier versions of a video (studio_video_version): the whole edit as it was before each agent pass, director
// pass or restore (kind 'project'), and the storyboard alone before each pass that changed it (kind 'storyboard').
// The newest 40 of each kind are kept per video. Restoring a storyboard brings back the plan (words, sources,
// planned beats) but never moves footage: beats that have their take now stay as they are.
import { StoryboardSchema, beatEnd, sortBeats, type Storyboard } from '../engine/storyboard'
import { parseEditorProject, type EditorProject } from '../engine/contracts'
import type { StudioCast } from '../engine/server-types'
import { getAssets } from './assets'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { projectCastOf } from './projects'
import { openVideo, saveVideo } from './videos'

export type VersionKind = 'project' | 'storyboard'
export type ProjectVersion = { id: string; at: string; by: string }
export type StoryboardVersion = ProjectVersion & { beats: number }

/** How many versions of each kind a video keeps. */
export const KEEP_VERSIONS = 40

/** Device choices (cameras, screen, mic) aren't edits: restoring a version keeps today's. */
export const keepInputs = (now: EditorProject, restored: EditorProject): EditorProject =>
  now.storyboard?.inputs && restored.storyboard ? { ...restored, storyboard: { ...restored.storyboard, inputs: now.storyboard.inputs } } : restored

/**
 * The cast isn't a version's to bring back: it is shared by every video of the Studio project (projects.ts), so a
 * restore keeps today's (the project's, else the video's own), with the photos it needs, and saves without sharing.
 * Otherwise an old cast in one video's version would be pushed onto all its siblings.
 */
export async function keepCast(ctx: StudioContext, now: EditorProject, restored: EditorProject): Promise<EditorProject> {
  const cast = (await projectCastOf(ctx, now.id)) ?? ((now.storyboard?.cast ?? []) as StudioCast)
  const have = new Set(restored.assets.map((asset) => asset.id))
  const missing = [...new Set(cast.flatMap((item) => item.assetIds))].filter((id) => !have.has(id))
  const today = new Map(now.assets.map((asset) => [asset.id, asset]))
  const library = await getAssets(ctx, missing.filter((id) => !today.has(id)))
  const added = missing.flatMap((id) => {
    const asset = today.get(id) ?? library.get(id)
    return asset ? [asset] : []
  })
  if (!restored.storyboard && !cast.length) return added.length ? { ...restored, assets: [...restored.assets, ...added] } : restored
  const storyboard = { ...(restored.storyboard ?? { beats: [] }), cast: cast.length ? cast : undefined } as EditorProject['storyboard']
  return { ...restored, assets: [...restored.assets, ...added], storyboard }
}

/** Keep a version (the whole edit, or a storyboard) labelled with what was about to happen; older ones past 40 go. */
export async function saveVersion(ctx: StudioContext, videoId: string, kind: VersionKind, label: string, doc: unknown): Promise<ProjectVersion> {
  const row = must(
    await ctx.supabase
      .from('studio_video_version')
      .insert({ workspace_id: ctx.workspaceId, video_id: videoId, kind, label: label.slice(0, 300), doc, created_by: ctx.userId })
      .select('id, created_at')
      .single(),
    'keep a version',
  ) as { id: string; created_at: string }
  await pruneVersions(ctx, videoId, kind).catch((error) => console.error('[studio] pruning versions failed:', error instanceof Error ? error.message : error))
  return { id: row.id, at: row.created_at, by: label.slice(0, 300) }
}

/** Remove a video's versions of a kind beyond the newest 40. */
export async function pruneVersions(ctx: StudioContext, videoId: string, kind: VersionKind): Promise<number> {
  const old = must(
    await ctx.supabase
      .from('studio_video_version')
      .select('id')
      .eq('workspace_id', ctx.workspaceId)
      .eq('video_id', videoId)
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .range(KEEP_VERSIONS, KEEP_VERSIONS + 500),
    'tidy versions',
  ) as { id: string }[] | null
  if (!old?.length) return 0
  must(await ctx.supabase.from('studio_video_version').delete().eq('workspace_id', ctx.workspaceId).in('id', old.map((row) => row.id)), 'tidy versions')
  return old.length
}

/** A video's whole-edit versions, newest first. */
export async function listVersions(ctx: StudioContext, videoId: string): Promise<ProjectVersion[]> {
  if (!isUuid(videoId)) return []
  const rows = must(
    await ctx.supabase.from('studio_video_version').select('id, label, created_at').eq('workspace_id', ctx.workspaceId).eq('video_id', videoId).eq('kind', 'project').order('created_at', { ascending: false }).limit(KEEP_VERSIONS + 10),
    'list versions',
  ) as { id: string; label: string; created_at: string }[] | null
  return (rows ?? []).map((row) => ({ id: row.id, at: row.created_at, by: row.label }))
}

/** A video's storyboard versions, newest first, with how many beats each had. */
export async function listStoryboardVersions(ctx: StudioContext, videoId: string): Promise<StoryboardVersion[]> {
  if (!isUuid(videoId)) return []
  const rows = must(
    await ctx.supabase.from('studio_video_version').select('id, label, created_at, doc').eq('workspace_id', ctx.workspaceId).eq('video_id', videoId).eq('kind', 'storyboard').order('created_at', { ascending: false }).limit(50),
    'list versions',
  ) as { id: string; label: string; created_at: string; doc: { beats?: unknown[] } }[] | null
  return (rows ?? []).map((row) => ({ id: row.id, at: row.created_at, by: row.label, beats: Array.isArray(row.doc?.beats) ? row.doc.beats.length : 0 }))
}

async function versionDoc(ctx: StudioContext, videoId: string, versionId: string, kind: VersionKind): Promise<unknown> {
  if (!isUuid(versionId) || !isUuid(videoId)) throw notFoundError('Unknown version')
  const row = must(
    await ctx.supabase.from('studio_video_version').select('doc').eq('workspace_id', ctx.workspaceId).eq('video_id', videoId).eq('kind', kind).eq('id', versionId).maybeSingle(),
    'open that version',
  ) as { doc: unknown } | null
  if (!row) throw notFoundError('Unknown version')
  return row.doc
}

/** One whole-edit version. */
export async function loadVersion(ctx: StudioContext, videoId: string, versionId: string): Promise<EditorProject> {
  const doc = await versionDoc(ctx, videoId, versionId, 'project')
  try {
    return parseEditorProject(doc)
  } catch {
    throw new StudioError("That version can't be read any more.", 500, 'UNREADABLE')
  }
}

/**
 * Put a whole-edit version back (today's device choices and cast kept, nothing shared with the other videos). The
 * edit as it was is kept as a version first.
 */
export async function restoreVersion(ctx: StudioContext, videoId: string, versionId: string) {
  const opened = await openVideo(ctx, videoId)
  const version = await loadVersion(ctx, videoId, versionId)
  await saveVersion(ctx, videoId, 'project', 'Before restoring an earlier version', opened.project).catch(() => null)
  const restored = await keepCast(ctx, opened.project, keepInputs(opened.project, { ...version, id: opened.project.id }))
  return saveVideo(ctx, restored, opened.projectDigest, { share: false })
}

/** The saved plan, with today's recorded beats kept and any saved planned beat that would overlap them dropped. */
export function restoreStoryboard(current: Storyboard | undefined, saved: Storyboard): Storyboard {
  const kept = (current?.beats ?? []).filter((b) => b.status !== 'planned')
  const overlaps = (s: number, e: number) => kept.some((b) => s < beatEnd(b) && e > b.startFrame)
  const planned = saved.beats.filter((b) => !kept.some((k) => k.id === b.id) && !overlaps(b.startFrame, beatEnd(b)))
  return StoryboardSchema.parse({ ...saved, inputs: current?.inputs ?? saved.inputs, beats: sortBeats([...kept, ...planned]) })
}

/**
 * Put a storyboard version back under today's footage (today's cast kept, nothing shared). The storyboard as it was
 * is kept as a version first.
 */
export async function restoreStoryboardVersion(ctx: StudioContext, videoId: string, versionId: string) {
  const opened = await openVideo(ctx, videoId)
  const saved = StoryboardSchema.parse(await versionDoc(ctx, videoId, versionId, 'storyboard'))
  if (opened.project.storyboard?.beats.length) await saveVersion(ctx, videoId, 'storyboard', 'Before restoring an earlier version', opened.project.storyboard).catch(() => null)
  const restored = await keepCast(ctx, opened.project, { ...opened.project, storyboard: restoreStoryboard(opened.project.storyboard, saved) })
  return saveVideo(ctx, restored, opened.projectDigest, { share: false })
}

/** Keep the storyboard as it is before a pass that changes it (nothing kept for an empty one). */
export async function saveStoryboardVersion(ctx: StudioContext, videoId: string, storyboard: Storyboard | undefined, label: string) {
  if (!storyboard?.beats.length) return null
  return saveVersion(ctx, videoId, 'storyboard', label, storyboard)
}

/** Remove a whole recorded take: the edit goes back to the version kept just before the take landed. */
export async function undoTake(ctx: StudioContext, videoId: string, sessionId: string) {
  const opened = await openVideo(ctx, videoId)
  const before = (await listVersions(ctx, videoId)).find((v) => v.by === `Before take ${sessionId}`)
  if (!before) throw new StudioError('No saved version from before that take')
  await saveVersion(ctx, videoId, 'project', `Before removing take ${sessionId}`, opened.project).catch(() => null)
  const version = await loadVersion(ctx, videoId, before.id)
  const restored = await keepCast(ctx, opened.project, keepInputs(opened.project, { ...version, id: opened.project.id }))
  return saveVideo(ctx, restored, opened.projectDigest, { share: false })
}
