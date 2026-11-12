'use client'

/**
 * The Studio page's panel: its sub-nav (Liam, 11-12, on the Studio: "this is
 * a great start but we need to update the UI to match the rest of our app").
 * PAGE_PANELS.studio (page-panel.tsx): it holds the slot while the Studio is
 * the selected page, and the Studio card draws no rail of its own while it is
 * on screen (pages/studio-card.tsx, subnav-on-screen.ts).
 *
 *   What    ./studio-panel-model.ts: Studio projects (each a folder: its
 *           Project overview and its videos), then the videos in no Studio
 *           project; the open video's pages (Overview, Storyboard, Cast,
 *           Edit) under it. Navigation only: the editor's own tools stay in
 *           the card.
 *   Heading Studio projects' "+" makes a Studio project (with its first
 *           video, in the shape picked, opened on the project's overview,
 *           where its name is set); Videos' "+" a video on its own; a
 *           project's own "+" (on hover or focus) a video in it. Each by the
 *           Studio's own routes, as its Projects screen makes them.
 *   A row   a project opens or closes its folder (no move); Project overview,
 *           a video or a page moves the Studio card in front, as its own
 *           rail did (components/chat-cards/studio-card-controls.ts): the
 *           card asks the Studio, which opens it and says where it is.
 *   Look    the Tasks and Team chat sub-navs' (tasks-panel.tsx,
 *           team-chat-panel.tsx): the same floating card (page-panel-frame.tsx),
 *           small muted headings with their "+", 32px rows, a plain muted
 *           lucide glyph, the rail's tint on the lit row; no title row.
 *   Lit     where the Studio says it is, never a click (`aria-current`).
 *   Kept    it wears KEEP_PLACE_ATTR (rail/selected-place.ts): what a press
 *           in it opens keeps the page selected.
 *   Guests  never: the Studio is every member's but a guest's
 *           (lib/studio/server/auth.ts requireStudio): nothing to show.
 *
 *   At once its headings and their "+" come with the page, before the card
 *           has loaded; the list from what this session read last
 *           (./studio-panel-data.ts), then fresh. A press before the card
 *           has said where it is waits for it (pending-move.ts).
 *
 * Flat cost: no timer, no realtime. One read when the page is selected, when
 * the Studio says its list changed, and when another video opens in it.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChartGantt,
  Film,
  Folder,
  FolderOpen,
  GalleryHorizontalEnd,
  Layers,
  LayoutGrid,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useWorkspaceId, useWorkspaces } from '@/app/account/workspace-switcher'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FrontCard } from '@/components/chat-cards/front-card'
import { useStudioCard, type StudioCardControls, type StudioCardPage } from '@/components/chat-cards/studio-card-controls'
import { useStudioRevision } from '@/components/studio/studio-changes'
import { STUDIO_API } from '@/components/studio/studio-env'
import { request } from '@/components/studio/ui/client'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { PagePanelFrame } from './page-panel-frame'
import { PAGE_PANEL_LABELS, type PagePanelProps } from './page-panel-types'
import { usePendingMove } from './pending-move'
import { useStudioList } from './studio-panel-data'
import { pressMoves, studioPanelModel, type StudioPanelPlace, type StudioPanelRow, type StudioPanelSection } from './studio-panel-model'

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), as tasks-panel.tsx's ROW_LIT. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'
const LABEL = PAGE_PANEL_LABELS.studio

/** Each row's glyph: muted, no tile, as the other sub-navs'. A page's by its id, as the Studio's own rail drew them. */
const PAGE_ICONS: Record<Exclude<StudioCardPage, 'project'>, LucideIcon> = {
  overview: LayoutGrid,
  storyboard: GalleryHorizontalEnd,
  cast: Users,
  edit: ChartGantt,
}

/** The shapes a new video is made in (components/studio/ui/project-shapes.ts adShapes, the Studio's own). */
export const NEW_VIDEO_SHAPES: ReadonlyArray<{ label: string; width: number; height: number }> = [
  { label: 'Reel or Story (9:16)', width: 1080, height: 1920 },
  { label: 'Feed (4:5)', width: 1080, height: 1350 },
  { label: 'Square (1:1)', width: 1080, height: 1080 },
  { label: 'Landscape (16:9)', width: 1920, height: 1080 },
]

/** What a new one is called until the person names it (the Studio's own words for a new video). */
const NEW_PROJECT_TITLE = 'Untitled Studio project'
const NEW_VIDEO_TITLE = 'Untitled video'

/** Whether the person here is a guest of the workspace (no Studio for them). */
function useIsGuest(): boolean {
  const { workspaces, currentId } = useWorkspaces()
  return workspaces.find((w) => w.id === currentId)?.role === 'guest'
}

export function StudioPanel({ active, mode, front, onContent }: PagePanelProps) {
  const guest = useIsGuest()
  // Its headings are always there for a member: something to show from its first commit, card or not.
  useLayoutEffect(() => {
    onContent('studio', !guest)
  }, [onContent, guest])
  const card = useStudioCard(front?.id ?? null)
  const run = usePendingMove<StudioCardControls>(card, active && !guest)
  if (guest) return null
  return (
    <PagePanelFrame mode={mode} active={active} label={LABEL} page="studio">
      <StudioPanelRows card={card} run={run} front={front} active={active} />
    </PagePanelFrame>
  )
}

function StudioPanelRows({
  card,
  run,
  front,
  active,
}: {
  card: StudioCardControls | null
  /** A move on the card: now, or once there is one (pending-move.ts). */
  run: (move: (card: StudioCardControls) => void) => void
  front: FrontCard | null
  active: boolean
}) {
  const shellWorkspace = useWorkspaceId()
  const workspaceId = card?.workspaceId ?? shellWorkspace
  const revision = useStudioRevision()
  const place: StudioPanelPlace | null = card ? { videoId: card.videoId, title: card.title, page: card.page } : null
  const list = useStudioList(workspaceId, active, revision, place?.videoId ?? null)
  // The folders the person opened or closed (this session); the open video's opens by itself.
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const model = useMemo(
    () => studioPanelModel(list, place, toggles),
    // `place` is rebuilt each render from the card's fields: depend on those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, place?.videoId, place?.title, place?.page, toggles],
  )

  // A record opened over the page as its own card is in front: the page's card comes back first.
  const frontRef = useRef(front)
  frontRef.current = front
  const bringBack = (c: StudioCardControls) => {
    if (c.cardId !== frontRef.current?.id) c.show()
  }
  const press = (row: StudioPanelRow) => {
    const act = row.act
    if (act.kind === 'toggle') {
      const open = !!row.expanded
      setToggles((was) => new Map(was).set(act.projectId, !open))
      return
    }
    if (act.kind !== 'go') return
    run((c) => {
      const here = { videoId: c.videoId, title: c.title, page: c.page }
      const inFront = c.cardId === frontRef.current?.id
      // Where the Studio is already: nothing more.
      if (!pressMoves(act, here) && inFront) return
      bringBack(c)
      if (pressMoves(act, here)) c.go(act.videoId, act.page)
    })
  }

  // The starts: made by the Studio's own routes, then opened in the card.
  const [making, setMaking] = useState(false)
  const make = useCallback(
    (what: 'project' | 'video', shape: { width: number; height: number }, projectId: string | null) => {
      if (making) return
      setMaking(true)
      void (async () => {
        try {
          let videoId: string
          let page: StudioCardPage
          if (what === 'project') {
            const { campaign } = await request<{ campaign: { id: string } }>(`${STUDIO_API}/campaigns`, { title: NEW_PROJECT_TITLE, projectIds: [] })
            const made = await request<{ project: { id: string } }>(`${STUDIO_API}/campaigns/${encodeURIComponent(campaign.id)}/new-ad`, {
              title: NEW_VIDEO_TITLE,
              width: shape.width,
              height: shape.height,
            })
            // Its overview, where the project is named.
            videoId = made.project.id
            page = 'project'
          } else if (projectId) {
            const made = await request<{ project: { id: string } }>(`${STUDIO_API}/campaigns/${encodeURIComponent(projectId)}/new-ad`, {
              title: NEW_VIDEO_TITLE,
              width: shape.width,
              height: shape.height,
            })
            videoId = made.project.id
            page = 'edit'
          } else {
            const made = await request<{ project: { id: string } }>(`${STUDIO_API}/projects/blank`, { title: NEW_VIDEO_TITLE, width: shape.width, height: shape.height })
            videoId = made.project.id
            page = 'edit'
          }
          if (projectId) setToggles((was) => new Map(was).set(projectId, true))
          run((c) => {
            bringBack(c)
            c.go(videoId, page)
          })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not make that')
        } finally {
          setMaking(false)
        }
      })()
    },
    [making, run],
  )

  return (
    <nav
      aria-label={LABEL}
      data-studio-panel=""
      aria-busy={making || undefined}
      {...{ [KEEP_PLACE_ATTR]: '' }}
      className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
    >
      {/* Sections as blocks, as the Tasks and Team chat sub-navs': 12px between one's last row and the next heading. */}
      <div className="ph-no-capture flex flex-col gap-3">
        {model.sections.map((section) => (
          <section key={section.key} data-studio-section={section.key} aria-labelledby={`studio-${section.key}`}>
            <SectionHeading
              section={section}
              disabled={making}
              onMake={(shape) => make(section.key === 'projects' ? 'project' : 'video', shape, null)}
            />
            {section.rows.length > 0 && (
              <ul className="flex flex-col">
                {section.rows.map((row) => (
                  <li key={row.key}>
                    {row.kind === 'note' ? (
                      <p data-studio-note="" className={cn('flex h-8 items-center px-2 text-[12px] text-muted-foreground', INDENT[row.depth])}>
                        {row.label}
                      </p>
                    ) : (
                      <StudioRowButton
                        row={row}
                        lit={row.key === model.lit}
                        onPress={press}
                        newVideo={
                          row.kind === 'project' && row.projectId
                            ? (shape) => make('video', shape, row.projectId!)
                            : undefined
                        }
                        disabled={making}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </nav>
  )
}

const HEAD_BUTTON =
  'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none'

/** A "+" opening the shapes a new video is made in (the Studio's own: its Projects screen's and its project overview's "New ad"). */
function ShapeMenu({
  label,
  disabled,
  onPick,
  trigger,
}: {
  label: string
  disabled: boolean
  onPick: (shape: { width: number; height: number }) => void
  trigger: ReactNode
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="min-w-48" data-studio-shapes={label}>
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{label}</DropdownMenuLabel>
        {NEW_VIDEO_SHAPES.map((shape) => (
          <DropdownMenuItem key={shape.label} data-studio-shape={shape.label} onSelect={() => onPick(shape)}>
            {shape.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SectionHeading({
  section,
  disabled,
  onMake,
}: {
  section: StudioPanelSection
  disabled: boolean
  onMake: (shape: { width: number; height: number }) => void
}) {
  const label = section.key === 'projects' ? 'New Studio project' : 'New video'
  return (
    <div className="flex items-center gap-0.5 pb-1 pl-2 pr-0.5 pt-0.5">
      <h3 id={`studio-${section.key}`} className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
        {section.heading}
      </h3>
      <ShapeMenu
        label={label}
        disabled={disabled}
        onPick={onMake}
        trigger={
          <button type="button" data-studio-add={section.key} aria-label={label} title={label} disabled={disabled} className={HEAD_BUTTON}>
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        }
      />
    </div>
  )
}

/** Each depth's left inset: a child's glyph under its parent's label, as a tree reads. */
const INDENT: Record<StudioPanelRow['depth'], string> = { 0: 'pl-2', 1: 'pl-[26px]', 2: 'pl-[44px]' }

/** Each row's glyph, by what it is (a project's by whether its folder is open; a page's by the page). */
const ROW_ICONS: Record<string, LucideIcon> = {
  'project-open': FolderOpen,
  project: Folder,
  // The Studio's own rail drew a project's overview as a stack.
  'project-overview': Layers,
  video: Film,
  ...PAGE_ICONS,
}

function iconKey(row: StudioPanelRow): string {
  if (row.kind === 'project') return row.expanded ? 'project-open' : 'project'
  if (row.kind === 'page' && row.act.kind === 'go' && row.act.page) return row.act.page
  if (row.kind === 'overview') return 'project-overview'
  return row.kind
}

function StudioRowButton({
  row,
  lit,
  onPress,
  newVideo,
  disabled,
}: {
  row: StudioPanelRow
  lit: boolean
  onPress: (row: StudioPanelRow) => void
  /** A project's own "+": a video in it, in the shape picked. */
  newVideo?: (shape: { width: number; height: number }) => void
  disabled: boolean
}) {
  const Icon = ROW_ICONS[iconKey(row)] ?? Film
  const button = (
    <button
      type="button"
      data-studio-row={row.key}
      data-studio-kind={row.kind}
      data-current={row.current ? '' : undefined}
      aria-current={lit ? 'true' : undefined}
      aria-expanded={row.kind === 'project' ? !!row.expanded : undefined}
      onClick={() => onPress(row)}
      title={row.hint ? `${row.label} · ${row.hint}` : row.label}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-xl pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
        INDENT[row.depth],
        newVideo && 'group-hover/row:pr-8 group-focus-within/row:pr-8',
        lit ? ROW_LIT : 'hover:bg-muted/60',
      )}
    >
      <span aria-hidden data-studio-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span data-studio-label="" className={cn('min-w-0 truncate text-[13px] text-foreground', row.current && 'font-medium')}>
          {row.label}
        </span>
        {row.hint && (
          <span data-studio-hint="" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {row.hint}
          </span>
        )}
      </span>
    </button>
  )
  if (!newVideo) return button
  const label = `New video in ${row.label}`
  return (
    <div className="group/row relative" data-studio-item={row.key}>
      {button}
      <ShapeMenu
        label={label}
        disabled={disabled}
        onPick={newVideo}
        trigger={
          <button
            type="button"
            data-studio-add-video={row.projectId}
            aria-label={label}
            title="New video"
            disabled={disabled}
            className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        }
      />
    </div>
  )
}
