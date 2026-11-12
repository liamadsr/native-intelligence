/**
 * What the agent reads of the Studio (migration 620), compact: the Studio
 * projects with their videos, one Studio project, and one video's summary.
 * One reader for the Studio tools (src/lib/ai/tools/studio.ts) and the
 * Studio page card's read_card (src/lib/chat-cards/page-server.ts), so the
 * agent hears the same thing from both.
 *
 * Every read is on the service client (the Studio tables are service-role
 * only), so each is fenced here by the workspace id, and the trash
 * (archived_at) is left out. Never the whole edit: a video's summary is the
 * engine's projectSummary, which caps the transcript.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { projectSummary } from '@/lib/studio/engine/agent-summary'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { studioVideoLink } from '@/lib/chat-cards/open-card'
import { isNotSetUp, notSetUpError, storeError } from '@/lib/studio/server/errors'

/** A failed read as the Studio's own error: the database's text is logged, never shown to the agent. */
function readFailed(what: string, error: { message: string; code?: string }): never {
  if (isNotSetUp(error)) throw notSetUpError()
  console.error(`[studio] agent read: ${what}:`, error.message.slice(0, 300))
  throw storeError(what)
}

/** The most Studio projects and videos one read lists. */
export const STUDIO_LIST_MAX = 200

/** One video in a list. */
export interface StudioVideoRow {
  id: string
  title: string
  status: string
  seconds: number | null
  width: number | null
  height: number | null
  updated_at: string
}

/** One Studio project with its videos. */
export interface StudioProjectRow {
  id: string
  title: string
  client: string | null
  updated_at: string
  videos: StudioVideoRow[]
}

/** The Studio's row ids are uuids: anything else names nothing (and never reaches a uuid column). */
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The columns a list reads: the list summary and the output size, never the doc itself. */
const VIDEO_LIST_COLUMNS = 'id, title, status, studio_project_id, summary, updated_at, output:doc->output'

type VideoListRow = { id: string; title: string; status: string; studio_project_id: string | null; summary: unknown; updated_at: string; output: unknown }

/** A list row as the agent reads it: its length and size from the row's summary, else the edit's output. */
export function videoRow(row: VideoListRow): StudioVideoRow {
  const summary = isRecord(row.summary) ? row.summary : {}
  const output = isRecord(row.output) ? row.output : {}
  const seconds = num(summary.durationSeconds) ?? num(summary.seconds)
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    seconds: seconds === null ? null : Math.round(seconds * 100) / 100,
    width: num(summary.width) ?? num(output.width),
    height: num(summary.height) ?? num(output.height),
    updated_at: row.updated_at,
  }
}

/** Every Studio project with its videos, and the videos in none, newest first. */
export async function readStudioOverview(supabase: SupabaseClient, workspaceId: string): Promise<{ projects: StudioProjectRow[]; unfiled: StudioVideoRow[] }> {
  const [projects, videos] = await Promise.all([
    supabase
      .from('studio_project')
      .select('id, title, client, updated_at')
      .eq('workspace_id', workspaceId)
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(STUDIO_LIST_MAX),
    supabase
      .from('studio_video')
      .select(VIDEO_LIST_COLUMNS)
      .eq('workspace_id', workspaceId)
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(STUDIO_LIST_MAX),
  ])
  if (projects.error) readFailed('read Studio projects', projects.error)
  if (videos.error) readFailed('read videos', videos.error)
  const rows = (videos.data ?? []) as unknown as VideoListRow[]
  const byProject = new Map<string, StudioVideoRow[]>()
  const unfiled: StudioVideoRow[] = []
  for (const row of rows) {
    const video = videoRow(row)
    if (!row.studio_project_id) unfiled.push(video)
    else byProject.set(row.studio_project_id, [...(byProject.get(row.studio_project_id) ?? []), video])
  }
  const list = ((projects.data ?? []) as Array<{ id: string; title: string; client: string | null; updated_at: string }>).map((p) => ({
    id: p.id,
    title: p.title,
    client: p.client ?? null,
    updated_at: p.updated_at,
    videos: byProject.get(p.id) ?? [],
  }))
  // A video in a Studio project that is in the trash reads as in none.
  const known = new Set(list.map((p) => p.id))
  for (const [id, vids] of byProject) if (!known.has(id)) unfiled.push(...vids)
  return { projects: list, unfiled }
}

/** One Studio project with its videos and notes, or null when it isn't the workspace's (or is in the trash). */
export async function readStudioProject(
  supabase: SupabaseClient,
  workspaceId: string,
  projectId: string,
): Promise<(StudioProjectRow & { notes: string | null; cast: number }) | null> {
  if (!isUuid(projectId)) return null
  const { data, error } = await supabase
    .from('studio_project')
    .select('id, title, client, notes, cast_members, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('id', projectId)
    .is('archived_at', null)
    .maybeSingle()
  if (error) readFailed('read the Studio project', error)
  if (!data) return null
  const project = data as { id: string; title: string; client: string | null; notes: string | null; cast_members: unknown; updated_at: string }
  const videos = await supabase
    .from('studio_video')
    .select(VIDEO_LIST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('studio_project_id', projectId)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(STUDIO_LIST_MAX)
  if (videos.error) readFailed('read videos', videos.error)
  return {
    id: project.id,
    title: project.title,
    client: project.client ?? null,
    notes: project.notes ? project.notes.slice(0, 2000) : null,
    cast: Array.isArray(project.cast_members) ? project.cast_members.length : 0,
    updated_at: project.updated_at,
    videos: ((videos.data ?? []) as unknown as VideoListRow[]).map(videoRow),
  }
}

/** A video's thumbnail address (the Studio API serves it), for one that has one. */
export function studioThumbnailUrl(videoId: string): string {
  return `/api/account/studio/projects/${videoId}/thumbnail.jpg`
}

/** "16:9", "9:16", "1:1"; else "1080x1350". */
export function formatName(width: number | null, height: number | null): string | null {
  if (!width || !height) return null
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const d = gcd(width, height)
  return width / d <= 32 && height / d <= 32 ? `${width / d}:${height / d}` : `${width}x${height}`
}

/** One video as the agent reads it: get_studio_video's answer, and the Studio card's on a video. */
export interface StudioVideoBrief {
  id: string
  title: string
  status: string
  studio_project: { id: string; title: string } | null
  digest: string
  revision: number
  width: number
  height: number
  fps: number
  seconds: number
  format: string | null
  thumbnail_url: string | null
  /** Where the person opens it: the Studio on this video. */
  link: string
  updated_at: string
  /** The engine's projectSummary of the edit: clips, layers, beats' times, transcript (capped). */
  summary: ReturnType<typeof projectSummary> | { error: string }
}

/** One video's summary, or null when it isn't the workspace's (or is in the trash). */
export async function readStudioVideoBrief(supabase: SupabaseClient, workspaceId: string, videoId: string): Promise<StudioVideoBrief | null> {
  if (!isUuid(videoId)) return null
  const { data, error } = await supabase
    .from('studio_video')
    .select('id, title, status, studio_project_id, doc, digest, revision, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('id', videoId)
    .is('archived_at', null)
    .maybeSingle()
  if (error) readFailed('read the video', error)
  if (!data) return null
  const row = data as { id: string; title: string; status: string; studio_project_id: string | null; doc: EditorProject; digest: string; revision: number; updated_at: string }
  const [project, thumb] = await Promise.all([
    row.studio_project_id
      ? supabase.from('studio_project').select('id, title').eq('workspace_id', workspaceId).eq('id', row.studio_project_id).is('archived_at', null).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('studio_blob').select('key').eq('workspace_id', workspaceId).eq('key', `thumbs/${row.id}.jpg`).maybeSingle(),
  ])
  return briefOf(row, (project.data as { id: string; title: string } | null) ?? null, !!thumb.data)
}

/** The brief from a video row: pure, so the tools build it from a row they already hold. */
export function briefOf(
  row: { id: string; title: string; status: string; doc: EditorProject; digest: string; revision: number; updated_at: string },
  project: { id: string; title: string } | null,
  hasThumbnail: boolean,
): StudioVideoBrief {
  const output = row.doc?.output ?? { width: 0, height: 0, fps: 0 }
  let summary: StudioVideoBrief['summary']
  try {
    summary = projectSummary(row.doc)
  } catch (err) {
    // An edit the engine can't schedule (no clips yet) still reads: its size and digest, and why.
    summary = { error: err instanceof Error ? err.message : String(err) }
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    studio_project: project,
    digest: row.digest,
    revision: row.revision,
    width: output.width,
    height: output.height,
    fps: output.fps,
    seconds: 'durationSeconds' in summary ? summary.durationSeconds : 0,
    format: formatName(output.width, output.height),
    thumbnail_url: hasThumbnail ? studioThumbnailUrl(row.id) : null,
    link: studioVideoLink(row.id),
    updated_at: row.updated_at,
    summary,
  }
}

/** A video as a tool's answer names it (the chat's video card reads it): the brief without the edit's summary. */
export type StudioVideoFields = Omit<StudioVideoBrief, 'summary'>

export function videoFields(brief: StudioVideoBrief): StudioVideoFields {
  const { summary: _summary, ...rest } = brief
  return rest
}
