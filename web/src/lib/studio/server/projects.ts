// Studio projects (studio_project): a group of videos made with the same people, brand and media (a launch, a
// season, one client's ads). Each video can have several outputs (the same video reframed for other formats, filed
// as variants of it). A video not filed in a project is its own one-video project, listed under the virtual id
// `single-<video id>`, so every way of making a video works unchanged.
//
// The project owns what its videos share: the cast (people, props and places used as references), the brand and
// notes. Videos keep a copy of the cast inside their storyboard, which the editor reads; after any save the edited
// cast becomes the project's and is copied into the other videos (afterVideoSave).
//
// The HTTP paths keep the editor's own word for these: /campaigns.
import type { EditorProject } from '../engine/contracts'
import { CampaignBrandSchema, adStatuses, type AdStatus, type CampaignBrand, type CampaignSummary, type StudioCast } from '../engine/server-types'
import { getAssets } from './assets'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { sameJson } from './stable'
import { createBlankVideo } from './blank'
import { listVideoRows, openVideo, renameVideo, saveVideo, duplicateVideo, toSummary } from './videos'
import { saveVersion } from './versions'
import { workspaceSeed } from './brand-seed'

/** The prefix of a lone video's virtual project id. */
export const SINGLE = 'single-'

type ProjectRow = {
  id: string
  title: string
  client: string | null
  notes: string | null
  brand: CampaignBrand | null
  cast_members: StudioCast
  created_at: string
  updated_at: string
}
const PROJECT_FIELDS = 'id, title, client, notes, brand, cast_members, created_at, updated_at'

async function projectRows(ctx: StudioContext): Promise<ProjectRow[]> {
  return (must(
    await ctx.supabase.from('studio_project').select(PROJECT_FIELDS).eq('workspace_id', ctx.workspaceId).is('archived_at', null).order('created_at', { ascending: true }),
    'list projects',
  ) ?? []) as ProjectRow[]
}

async function projectRow(ctx: StudioContext, id: string): Promise<ProjectRow | null> {
  if (!isUuid(id)) return null
  return must(
    await ctx.supabase.from('studio_project').select(PROJECT_FIELDS).eq('workspace_id', ctx.workspaceId).eq('id', id).is('archived_at', null).maybeSingle(),
    'open that Studio project',
  ) as ProjectRow | null
}

async function mustProject(ctx: StudioContext, id: string): Promise<ProjectRow> {
  const row = await projectRow(ctx, id)
  if (!row) throw notFoundError('Studio project not found')
  return row
}

/** The project a video is filed in, or null (a lone video, or not in this workspace). */
async function projectOfVideo(ctx: StudioContext, videoId: string): Promise<string | null> {
  if (!isUuid(videoId)) return null
  const row = must(
    await ctx.supabase.from('studio_video').select('studio_project_id').eq('workspace_id', ctx.workspaceId).eq('id', videoId).is('archived_at', null).maybeSingle(),
    'read that video',
  ) as { studio_project_id: string | null } | null
  return row?.studio_project_id ?? null
}

async function videoExists(ctx: StudioContext, videoId: string): Promise<{ id: string; title: string; studio_project_id: string | null; status: AdStatus } | null> {
  if (!isUuid(videoId)) return null
  return must(
    await ctx.supabase.from('studio_video').select('id, title, studio_project_id, status').eq('workspace_id', ctx.workspaceId).eq('id', videoId).is('archived_at', null).maybeSingle(),
    'read that video',
  ) as { id: string; title: string; studio_project_id: string | null; status: AdStatus } | null
}

const touch = async (ctx: StudioContext, id: string) =>
  must(await ctx.supabase.from('studio_project').update({ updated_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).eq('id', id), 'update that Studio project')

/** Every project: those that group videos, then each lone video as its own, most recently changed first. */
export async function listProjects(ctx: StudioContext): Promise<CampaignSummary[]> {
  const [projects, videos] = await Promise.all([projectRows(ctx), listVideoRows(ctx)])
  const logos = await getAssets(ctx, projects.flatMap((p) => (p.brand?.logoAssetId ? [p.brand.logoAssetId] : [])))
  const ordered = [...videos].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const out: CampaignSummary[] = projects.map((p) => {
    const ads = ordered
      .filter((v) => v.studio_project_id === p.id)
      .map((v) => ({ ...toSummary(v), status: v.status, ...(v.variant_of ? { variantOf: v.variant_of } : {}) }))
    const logo = p.brand?.logoAssetId ? logos.get(p.brand.logoAssetId)?.file : undefined
    return {
      id: p.id,
      title: p.title,
      ...(p.client ? { client: p.client } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.brand ? { brand: p.brand } : {}),
      createdAt: p.created_at,
      single: false,
      castCount: (p.cast_members ?? []).length,
      ads,
      updatedAt: [p.updated_at, ...ads.map((a) => a.updatedAt)].sort().at(-1)!,
      ...(logo ? { logoFile: logo } : {}),
    }
  })
  const known = new Set(projects.map((p) => p.id))
  for (const v of videos) {
    if (v.studio_project_id && known.has(v.studio_project_id)) continue
    const summary = toSummary(v)
    out.push({ id: `${SINGLE}${v.id}`, title: v.title, single: true, castCount: 0, createdAt: summary.updatedAt, updatedAt: summary.updatedAt, ads: [{ ...summary, status: 'draft' }] })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** One project's summary (a `single-<id>` one too). */
export async function projectSummary(ctx: StudioContext, projectId: string): Promise<CampaignSummary> {
  const found = (await listProjects(ctx)).find((c) => c.id === projectId)
  if (!found) throw notFoundError('Studio project not found')
  return found
}

/** The summary of the project a video is in (its own `single-` one when it is not filed). */
export async function projectForVideo(ctx: StudioContext, videoId: string): Promise<CampaignSummary> {
  const projectId = await projectOfVideo(ctx, videoId)
  return projectSummary(ctx, projectId ?? `${SINGLE}${videoId}`)
}

/** A new project holding these videos (moved out of wherever they were); the cast they bring is shared. */
export async function createProject(ctx: StudioContext, title: unknown, videoIds: string[] = []): Promise<CampaignSummary> {
  const id = await insertProject(ctx, title)
  for (const videoId of videoIds) await fileVideo(ctx, id, videoId)
  return projectSummary(ctx, id)
}

/** A new project, its brand seeded from the workspace (brand-seed.ts: its name, and its logo's link in the notes). */
async function insertProject(ctx: StudioContext, title: unknown): Promise<string> {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new StudioError('Name the Studio project')
  const seed = await workspaceSeed(ctx)
  const row = must(
    await ctx.supabase
      .from('studio_project')
      .insert({ workspace_id: ctx.workspaceId, title: t.slice(0, 160), created_by: ctx.userId, ...(seed.brand ? { brand: seed.brand } : {}), ...(seed.notes ? { notes: seed.notes } : {}) })
      .select('id')
      .single(),
    'make that project',
  ) as { id: string }
  return row.id
}

/** A lone video's virtual id made a real project (named after the video, holding it). Real ids pass through. */
export async function realProject(ctx: StudioContext, projectId: string): Promise<string> {
  if (!projectId.startsWith(SINGLE)) return projectId
  const videoId = projectId.slice(SINGLE.length)
  const video = await videoExists(ctx, videoId)
  if (!video) throw notFoundError('Video not found')
  if (video.studio_project_id) return video.studio_project_id
  const id = await insertProject(ctx, video.title || 'New project')
  await fileVideo(ctx, id, videoId)
  return id
}

/** Rename a project, or set its client, notes or brand. */
export async function updateProject(ctx: StudioContext, projectId: string, patch: { title?: unknown; client?: unknown; notes?: unknown; brand?: unknown }): Promise<CampaignSummary> {
  const id = await realProject(ctx, projectId)
  await mustProject(ctx, id)
  const next: Record<string, unknown> = {}
  if (typeof patch.title === 'string') {
    const t = patch.title.trim()
    if (!t) throw new StudioError('Name the Studio project')
    next.title = t.slice(0, 160)
  }
  if (typeof patch.client === 'string') next.client = patch.client.slice(0, 160)
  if (typeof patch.notes === 'string') next.notes = patch.notes.slice(0, 20_000)
  if (patch.brand && typeof patch.brand === 'object') next.brand = CampaignBrandSchema.parse(patch.brand)
  next.updated_at = new Date().toISOString()
  must(await ctx.supabase.from('studio_project').update(next).eq('workspace_id', ctx.workspaceId).eq('id', id), 'update that Studio project')
  return projectSummary(ctx, id)
}

/** Ungroup: the videos stay, each becomes its own again (status and variant links go with the group). */
export async function dissolveProject(ctx: StudioContext, projectId: string): Promise<void> {
  if (projectId.startsWith(SINGLE)) return
  await mustProject(ctx, projectId)
  must(
    await ctx.supabase.from('studio_video').update({ studio_project_id: null, status: 'draft', variant_of: null }).eq('workspace_id', ctx.workspaceId).eq('studio_project_id', projectId),
    'ungroup that Studio project',
  )
  must(await ctx.supabase.from('studio_project').update({ archived_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).eq('id', projectId), 'ungroup that Studio project')
}

/**
 * File a video in a project (taking it out of any other). Its cast and the project's are merged and shared. A
 * target `single-<id>` (a lone video) becomes a real project named after that video, holding both.
 */
export async function fileVideo(ctx: StudioContext, projectId: string, videoId: string, options: { variantOf?: string; status?: AdStatus } = {}): Promise<string> {
  const video = await videoExists(ctx, videoId)
  if (!video) throw notFoundError('Video not found')
  const id = await realProject(ctx, projectId)
  await mustProject(ctx, id)
  const previous = video.studio_project_id
  const staying = previous === id
  const status = options.status ?? (staying ? video.status : 'draft')
  const patch: Record<string, unknown> = { studio_project_id: id, status }
  if (options.variantOf !== undefined) patch.variant_of = isUuid(options.variantOf) ? options.variantOf : null
  else if (!staying) patch.variant_of = null
  must(await ctx.supabase.from('studio_video').update(patch).eq('workspace_id', ctx.workspaceId).eq('id', videoId), 'file that video')
  await touch(ctx, id)
  // A project left with no videos, notes or brand is gone with its last video.
  if (previous && previous !== id) await archiveIfEmpty(ctx, previous)
  // Everyone in the project shares one cast: the union of what the project had and what the newcomer brings.
  const project = await mustProject(ctx, id)
  const merged = new Map<string, StudioCast[number]>()
  for (const item of project.cast_members ?? []) merged.set(item.id, item)
  const members = (await listVideoRows(ctx)).filter((v) => v.studio_project_id === id)
  for (const member of members) {
    try {
      const { project: edit } = await openVideo(ctx, member.id)
      for (const item of edit.storyboard?.cast ?? []) if (!merged.has(item.id)) merged.set(item.id, item)
    } catch {
      /* an unreadable video adds nothing */
    }
  }
  await shareCast(ctx, id, [...merged.values()])
  return id
}

async function archiveIfEmpty(ctx: StudioContext, projectId: string) {
  const row = await projectRow(ctx, projectId)
  if (!row || row.notes || row.brand) return
  const left = must(
    await ctx.supabase.from('studio_video').select('id').eq('workspace_id', ctx.workspaceId).eq('studio_project_id', projectId).is('archived_at', null).limit(1),
    'tidy Studio projects',
  ) as { id: string }[] | null
  if (!left?.length) must(await ctx.supabase.from('studio_project').update({ archived_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).eq('id', projectId), 'tidy Studio projects')
}

/** Take a video out of its project (it becomes its own again). */
export async function unfileVideo(ctx: StudioContext, videoId: string): Promise<void> {
  if (!isUuid(videoId)) throw notFoundError('Video not found')
  must(
    await ctx.supabase.from('studio_video').update({ studio_project_id: null, status: 'draft', variant_of: null }).eq('workspace_id', ctx.workspaceId).eq('id', videoId),
    'take that video out of its project',
  )
}

/** Mark a filed video draft, review or approved. */
export async function setVideoStatus(ctx: StudioContext, videoId: string, status: unknown): Promise<void> {
  if (!adStatuses.includes(status as AdStatus)) throw new StudioError(`Status is one of ${adStatuses.join(', ')}`)
  const projectId = await projectOfVideo(ctx, videoId)
  if (!projectId) throw new StudioError('Put this video in a Studio project to give it a status')
  must(await ctx.supabase.from('studio_video').update({ status }).eq('workspace_id', ctx.workspaceId).eq('id', videoId), 'set that status')
  await touch(ctx, projectId)
}

/** A new video made from another (a duplicate, another format) is filed next to it; an output of an output belongs to the original. */
export async function addSibling(ctx: StudioContext, sourceId: string, newId: string, variant: boolean): Promise<void> {
  const source = must(
    await ctx.supabase.from('studio_video').select('studio_project_id, variant_of').eq('workspace_id', ctx.workspaceId).eq('id', sourceId).maybeSingle(),
    'read that video',
  ) as { studio_project_id: string | null; variant_of: string | null } | null
  const root = source?.variant_of ?? sourceId
  if (source?.studio_project_id) await fileVideo(ctx, source.studio_project_id, newId, variant ? { variantOf: root } : {})
  else if (variant) await fileVideo(ctx, `${SINGLE}${sourceId}`, newId, { variantOf: sourceId })
}

/**
 * Make this the cast of every video in the project (and the project's own), adding the photos each video needs.
 * Each other video it rewrites keeps a version of itself from before ("Before a cast change"), to be restored.
 */
export async function shareCast(ctx: StudioContext, projectId: string, cast: StudioCast): Promise<void> {
  must(
    await ctx.supabase.from('studio_project').update({ cast_members: cast }).eq('workspace_id', ctx.workspaceId).eq('id', projectId),
    'share the cast',
  )
  const members = (await listVideoRows(ctx)).filter((v) => v.studio_project_id === projectId)
  const need = [...new Set(cast.flatMap((item) => item.assetIds))]
  const library = need.length ? await getAssets(ctx, need) : new Map()
  for (const member of members) {
    try {
      const { project, projectDigest } = await openVideo(ctx, member.id)
      if (sameJson(project.storyboard?.cast ?? [], cast)) continue
      const have = new Set(project.assets.map((a) => a.id))
      const assets = [...project.assets, ...need.filter((id) => !have.has(id) && library.has(id)).map((id) => library.get(id)!)]
      const next: EditorProject = { ...project, assets, storyboard: { ...(project.storyboard ?? { beats: [] }), cast: cast.length ? cast : undefined } as EditorProject['storyboard'] }
      await saveVersion(ctx, member.id, 'project', CAST_CHANGE, project)
      await saveVideo(ctx, next, projectDigest, { share: false })
    } catch (error) {
      console.error(`[studio] couldn't share the cast with ${member.id}:`, error instanceof Error ? error.message : error)
    }
  }
}

/** The label of the version a video keeps before shareCast rewrites its cast. */
export const CAST_CHANGE = 'Before a cast change'

/** The cast of the Studio project a video is filed in, or null when it is a lone video. */
export async function projectCastOf(ctx: StudioContext, videoId: string): Promise<StudioCast | null> {
  const projectId = await projectOfVideo(ctx, videoId)
  if (!projectId) return null
  const row = await projectRow(ctx, projectId)
  return row ? ((row.cast_members ?? []) as StudioCast) : null
}

/** After a video is saved: if its cast changed, it becomes its project's, and the project's other videos get it too. */
export async function afterVideoSave(ctx: StudioContext, project: EditorProject): Promise<void> {
  const projectId = await projectOfVideo(ctx, project.id)
  if (!projectId) return
  const row = await projectRow(ctx, projectId)
  if (!row) return
  const cast = (project.storyboard?.cast ?? []) as StudioCast
  if (sameJson(cast, row.cast_members ?? [])) return
  await shareCast(ctx, projectId, cast)
}

/** A new video in a project: a blank canvas in a format, or a copy of one of its videos (same people, change the copy). */
export async function newVideoInProject(
  ctx: StudioContext,
  projectId: string,
  body: { from?: unknown; title?: unknown; width?: unknown; height?: unknown; fps?: unknown; seconds?: unknown },
): Promise<{ project: EditorProject; campaign: CampaignSummary }> {
  const id = await realProject(ctx, projectId)
  await mustProject(ctx, id)
  let made: EditorProject
  if (body.from) {
    made = await duplicateVideo(ctx, String(body.from))
    if (typeof body.title === 'string' && body.title.trim()) made = await renameVideo(ctx, made.id, body.title)
  } else {
    made = await createBlankVideo(ctx, {
      title: typeof body.title === 'string' ? body.title : 'New ad',
      width: Number(body.width) || 1080,
      height: Number(body.height) || 1920,
      fps: Number(body.fps) || 30,
      seconds: Number(body.seconds) || 15,
    })
  }
  await fileVideo(ctx, id, made.id)
  const { project } = await openVideo(ctx, made.id)
  return { project, campaign: await projectSummary(ctx, id) }
}
