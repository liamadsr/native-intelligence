/**
 * What the Studio's sub-nav lists, and which row is lit (Liam, 11-12: the
 * Studio "needs to match the rest of our app": its navigation in the panel
 * beside the rail, as every other page has). Drawn by ./studio-panel.tsx,
 * from the Studio's list (`GET /api/account/studio/campaigns`: its Studio
 * projects, each with its videos, and the videos in none, each as a
 * `single-<id>` one) and where the Studio card says it is
 * (components/chat-cards/studio-card-controls.ts).
 *
 *   Studio projects   each Studio project, newest activity first (the
 *                     server's order). Open (its folder open): a Project
 *                     overview row (the project's own page in the Studio),
 *                     then its videos, oldest first (the server's order).
 *                     The one the open video is in is open by itself; the
 *                     person opens and closes any of them (`toggles`).
 *   Videos            the videos in no Studio project, as the server orders
 *                     them.
 *   The open video    its pages under it: Overview, Storyboard, Cast, Edit.
 *                     A format version of a video (`variantOf`) is listed
 *                     only while it is the open one, after its video, its
 *                     shape beside it.
 *
 * Both sections are always there, for their "+" (New Studio project, New
 * video); a project's own "+" is New video in it. A workspace with no video
 * at all says so, once, in the Videos section.
 *
 * Lit: exactly one row, from where the card says the Studio is, never from a
 * click: the open video's page; its project's overview (a lone video's own
 * row); the video itself while its page is not known yet. A row out of sight
 * (its project closed) lights its project instead.
 *
 * Pure and client-safe.
 */
import type { CampaignSummary } from '@/lib/studio/engine/api'
import type { StudioCardPage } from '@/components/chat-cards/studio-card-controls'

/** Where the card says the Studio is (studio-card-controls.ts), as far as this list needs it. */
export interface StudioPanelPlace {
  videoId: string | null
  title: string | null
  page: StudioCardPage | null
}

/** A video's pages, in the Studio's order and words (components/studio/ui/FilmPages.tsx filmPages). */
export const STUDIO_VIDEO_PAGES: ReadonlyArray<{ id: Exclude<StudioCardPage, 'project'>; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'storyboard', label: 'Storyboard' },
  { id: 'cast', label: 'Cast' },
  { id: 'edit', label: 'Edit' },
]

/** What a row does when pressed. */
export type StudioRowAct =
  /** Open or close a Studio project's folder: no move. */
  | { kind: 'toggle'; projectId: string }
  /** Open a video in the Studio, on a page (null: the one it was last on). */
  | { kind: 'go'; videoId: string; page: StudioCardPage | null }
  /** Nothing (a line of text). */
  | { kind: 'none' }

export interface StudioPanelRow {
  /** `project:<id>`, `overview:<projectId>`, `video:<id>`, `page:<videoId>:<page>`, `note:<id>`. */
  key: string
  kind: 'project' | 'overview' | 'video' | 'page' | 'note'
  label: string
  /** 0 a project or a lone video; 1 inside a project, or a lone video's page; 2 a page of a video in a project. */
  depth: 0 | 1 | 2
  /** Muted after the label: a format version's shape (`1:1`). */
  hint: string | null
  /** A project's folder is open. */
  expanded?: boolean
  /** The open video, or the project it is in. */
  current?: boolean
  /** A real Studio project's id (its "+" makes a video in it). */
  projectId?: string
  act: StudioRowAct
}

export interface StudioPanelSection {
  key: 'projects' | 'videos'
  heading: string
  rows: StudioPanelRow[]
}

export interface StudioPanelModel {
  sections: StudioPanelSection[]
  /** The lit row's key; null: none (nothing open, or not known yet). */
  lit: string | null
  /** The Studio project the open video is in (null: a lone video, or none open). */
  openProjectId: string | null
  /** The open video is not in the list read (made since): read it again. */
  stale: boolean
}

export const SECTION_HEADINGS = { projects: 'Studio projects', videos: 'Videos' } as const
export const NO_VIDEOS_YET = 'No videos yet'
export const PROJECT_OVERVIEW = 'Project overview'
const UNTITLED_VIDEO = 'Untitled video'
const UNTITLED_PROJECT = 'Untitled Studio project'

/** A lone video's own id inside the server's `single-<id>` project. */
export const SINGLE_PREFIX = 'single-'

type Video = CampaignSummary['ads'][number]

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
/** 1080×1920 → 9:16 (components/studio/ui/project-shapes.ts ratio). */
export function shapeOf(width: number, height: number): string | null {
  if (!width || !height) return null
  const g = gcd(width, height)
  return `${width / g}:${height / g}`
}

export const rowKey = {
  project: (id: string) => `project:${id}`,
  overview: (projectId: string) => `overview:${projectId}`,
  video: (id: string) => `video:${id}`,
  page: (videoId: string, page: StudioCardPage) => `page:${videoId}:${page}`,
}

/** The Studio project (real, not `single-`) the video is in, from the list; null: none, or not listed. */
export function projectOfVideo(list: readonly CampaignSummary[], videoId: string): CampaignSummary | null {
  return list.find((c) => !c.single && c.ads.some((a) => a.id === videoId)) ?? null
}

/** The first video a Studio project opens on (its first one that is not a format version); null: it has none. */
export function firstVideoOf(project: CampaignSummary): string | null {
  return (project.ads.find((a) => !a.variantOf) ?? project.ads[0])?.id ?? null
}

/**
 * The sub-nav's rows from the list read (null: not read yet: no rows, the
 * headings alone, so nothing shows then goes), where the Studio is, and the
 * folders the person opened or closed (`toggles`, by project id; a project
 * not in it is open only when the open video is in it).
 */
export function studioPanelModel(
  list: readonly CampaignSummary[] | null,
  place: StudioPanelPlace | null,
  toggles: ReadonlyMap<string, boolean> = new Map(),
): StudioPanelModel {
  const openId = place?.videoId ?? null
  const titleOf = (v: Pick<Video, 'id' | 'title'>) => (v.id === openId && place?.title ? place.title : v.title) || UNTITLED_VIDEO
  const sections: StudioPanelSection[] = [
    { key: 'projects', heading: SECTION_HEADINGS.projects, rows: [] },
    { key: 'videos', heading: SECTION_HEADINGS.videos, rows: [] },
  ]
  if (!list) return { sections, lit: null, openProjectId: null, stale: false }

  const openProject = openId ? projectOfVideo(list, openId) : null
  const listed = !!openId && list.some((c) => c.ads.some((a) => a.id === openId))
  const isOpen = (projectId: string) => toggles.get(projectId) ?? projectId === openProject?.id
  let lit: string | null = null

  /** The open video's pages, under its row. */
  const pagesOf = (videoId: string, depth: 1 | 2): StudioPanelRow[] =>
    STUDIO_VIDEO_PAGES.map((p) => ({
      key: rowKey.page(videoId, p.id),
      kind: 'page',
      label: p.label,
      depth,
      hint: null,
      act: { kind: 'go', videoId, page: p.id },
    }))

  const videoRow = (v: Video, depth: 0 | 1, hint: string | null): StudioPanelRow => ({
    key: rowKey.video(v.id),
    kind: 'video',
    label: titleOf(v),
    depth,
    hint,
    current: v.id === openId || undefined,
    act: { kind: 'go', videoId: v.id, page: null },
  })

  // Studio projects.
  const projectRows = sections[0]!.rows
  for (const project of list) {
    if (project.single) continue
    const open = isOpen(project.id)
    const current = project.id === openProject?.id
    projectRows.push({
      key: rowKey.project(project.id),
      kind: 'project',
      label: project.title || UNTITLED_PROJECT,
      depth: 0,
      hint: null,
      expanded: open,
      current: current || undefined,
      projectId: project.id,
      act: { kind: 'toggle', projectId: project.id },
    })
    if (!open) {
      if (current) lit = rowKey.project(project.id)
      continue
    }
    const first = firstVideoOf(project)
    if (!first) {
      projectRows.push({ key: `note:${project.id}`, kind: 'note', label: NO_VIDEOS_YET, depth: 1, hint: null, act: { kind: 'none' } })
      continue
    }
    projectRows.push({
      key: rowKey.overview(project.id),
      kind: 'overview',
      label: PROJECT_OVERVIEW,
      depth: 1,
      hint: null,
      // The project's page in the Studio is the open video's, when it is in it; else its first video's.
      act: { kind: 'go', videoId: current && openId ? openId : first, page: 'project' },
    })
    for (const v of project.ads) {
      // A format version: only while it is the open one, after its video.
      if (v.variantOf && v.id !== openId) continue
      projectRows.push(videoRow(v, 1, v.variantOf ? shapeOf(v.width, v.height) : null))
      if (v.id === openId) projectRows.push(...pagesOf(v.id, 2))
    }
    if (current && openId) lit = litIn(rowKey.overview(project.id), openId, place?.page ?? null)
  }

  // Videos in no Studio project; the open one first when the list doesn't have it yet (made since it was read).
  const videoRows = sections[1]!.rows
  const lone: Video[] = list.filter((c) => c.single).flatMap((c) => c.ads.slice(0, 1))
  if (openId && !listed) lone.unshift({ id: openId, title: place?.title ?? '', status: 'draft' } as Video)
  for (const v of lone) {
    videoRows.push(videoRow(v, 0, null))
    if (v.id === openId) {
      videoRows.push(...pagesOf(v.id, 1))
      lit = litIn(rowKey.video(v.id), v.id, place?.page ?? null)
    }
  }
  if (!list.some((c) => c.ads.length) && !openId) {
    videoRows.push({ key: 'note:videos', kind: 'note', label: NO_VIDEOS_YET, depth: 0, hint: null, act: { kind: 'none' } })
  }

  return { sections, lit, openProjectId: openProject?.id ?? null, stale: !!openId && !listed }
}

/** The lit row for the open video, its rows in sight: a page's; its project's overview (`overviewKey`); else the video. */
function litIn(overviewKey: string, videoId: string, page: StudioCardPage | null): string {
  if (page === 'project') return overviewKey
  if (page) return rowKey.page(videoId, page)
  return rowKey.video(videoId)
}

/** A press: whether it would move the Studio at all (the lit row, or the open video's own row while the Studio is on it, does nothing more). */
export function pressMoves(act: StudioRowAct, place: StudioPanelPlace | null): boolean {
  if (act.kind !== 'go') return false
  if (!place || place.videoId !== act.videoId) return true
  if (act.page === null) return false
  return place.page !== act.page
}
