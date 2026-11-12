'use client'

/**
 * The My Actions page's panel: its sub-nav (Liam, 11-11: "eventually I want
 * to get to the point where we have one todo icon on the main nav and when
 * you click it the sub-nav would show things like milestone and projects
 * that way it's nested and clean and not at the top level"; "ours should
 * look similar except for the parts where our UX is different and I want to
 * stay with our UX instead of making it like theirs"). PAGE_PANELS.actions
 * (page-panel.tsx): it holds the slot while My Actions is the selected page.
 *
 *   What    ./tasks-panel-model.ts: the page's views (Assigned to me, All
 *           <actions>, Created by me), then Projects (My projects, All
 *           projects, Milestones, Initiatives), then the person's saved
 *           views when they have any. No empty section, no empty state.
 *           Then Teams (Liam, 11-11: "Teams should be under action items"):
 *           each team the person can see, then All teams, before Saved views.
 *   Look    the Recent panel's (home-recents.tsx): the same floating card
 *           (page-panel-frame.tsx), small muted headings, rows of the same
 *           height and type, a plain muted glyph, no tile. No title row:
 *           Search is the rail header's, and the panel opens and closes by
 *           its button right of Search. No "New" button: making an action
 *           stays the page's own + and the chat.
 *   A row   moves the open My Actions card, as its own controls do
 *           (components/chat-cards/tasks-card-controls.ts): a view is the
 *           state its view tabs set (the full-screen card has no tabs of
 *           its own from `md` up: this is its one control, so it shows
 *           while open, room or not; Liam, 11-11); Projects, Milestones and
 *           Initiatives, a team's board and All teams open inside the card,
 *           a step in its history (its
 *           Back returns to the list), so the card in front never changes
 *           and My Actions stays selected and lit; a saved view is applied
 *           on the card, as its tab would.
 *   Lit     exactly one row, from where the card is, never from a click
 *           (the rail's tint, `aria-current`): Back and the page's own
 *           controls keep it right.
 *   Kept    it wears KEEP_PLACE_ATTR (rail/selected-place.ts): what a press
 *           in it opens keeps the page selected.
 *
 *   At once its rows come with the page, before the card has loaded (Liam,
 *           11-11: "it goes away completely and reappears every time" … "only
 *           on first load"): the views, Projects and Teams are known without
 *           it; the saved views and the lit row come when it says where it
 *           is (until then the page's default view, Assigned to me, is lit).
 *           A row pressed before then moves the card once it says
 *           (pending-move.ts).
 *
 * Flat cost: no read of its own, no timer. What the card's list already
 * read (its saved views, reloaded when one is saved anywhere: use-view.ts
 * VIEWS_CHANGED_EVENT) comes with where the card is; the teams are the
 * shell's own list (teams-context.tsx: read once, refreshed by team events).
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  Bookmark,
  CircleUserRound,
  FolderKanban,
  Folders,
  ListTodo,
  Milestone,
  SquarePen,
  LayoutGrid,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { useTasksCard, type TasksCardControls } from '@/components/chat-cards/tasks-card-controls'
import { useTeams } from '@/app/account/teams-context'
import { teamOfPlace } from '@/lib/chat-cards/tasks-places'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { PagePanelFrame } from './page-panel-frame'
import { PAGE_PANEL_LABELS, type PagePanelProps } from './page-panel-types'
import { litTasksRow, rowKeyOf, tasksPanelSections, type TasksRow, type TasksRowAct } from './tasks-panel-model'
import { usePendingMove } from './pending-move'

/** Each row's glyph: muted, no tile, as the Recent panel's. By the scope or place; a saved view's by `view`. */
const ROW_ICONS: Record<string, LucideIcon> = {
  assigned: CircleUserRound,
  all: ListTodo,
  created: SquarePen,
  'my-projects': FolderKanban,
  projects: Folders,
  milestones: Milestone,
  initiatives: Target,
  // A team (teams have no icon or colour of their own to show), and All teams as the board's "View all teams".
  team: Users,
  teams: LayoutGrid,
  view: Bookmark,
}

const iconKey = (act: TasksRowAct): string =>
  act.kind === 'scope' ? act.scope : act.kind === 'place' ? (teamOfPlace(act.place) ? 'team' : act.place) : 'view'

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), as home-recents.tsx's ROW_LIT. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

/** Lit before the card says where it is: the page's default view (its first tab). */
const DEFAULT_LIT = rowKeyOf({ kind: 'scope', scope: 'assigned' })

export function TasksPanel({ active, mode, front, onContent }: PagePanelProps) {
  const card = useTasksCard(front?.id ?? null)
  const edition = useWorkspaceEdition()
  // Its views are always there: something to show from its first commit, card or not.
  useLayoutEffect(() => {
    onContent('actions', true)
  }, [onContent])

  const views = card?.views
  const { teams } = useTeams()
  const sections = useMemo(() => tasksPanelSections(edition, views ?? [], teams), [edition, views, teams])
  const lit = card ? litTasksRow(card) : DEFAULT_LIT
  const frontRef = useRef(front)
  frontRef.current = front
  const run = usePendingMove<TasksCardControls>(card, active)

  const press = (act: TasksRowAct, key: string) =>
    run((c) => {
      const inFront = c.cardId === frontRef.current?.id
      // Where the card is already: nothing more.
      if (key === litTasksRow(c) && inFront) return
      // A record opened over the page as its own card is in front: the page's card comes back first.
      if (!inFront) c.show()
      if (act.kind === 'scope') c.setScope(act.scope)
      else if (act.kind === 'place') c.go(act.place)
      else c.setView(act.id)
    })

  return (
    <PagePanelFrame mode={mode} active={active} label={PAGE_PANEL_LABELS.actions} page="actions">
      <nav
        aria-label={PAGE_PANEL_LABELS.actions}
        data-tasks-panel=""
        {...{ [KEEP_PLACE_ATTR]: '' }}
        className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
      >
        {/* Sections as blocks, as the Recent panel's: 12px between one's last row and the next heading. */}
        <div className="ph-no-capture flex flex-col gap-3">
          {sections.map((section) => (
            <section
              key={section.key}
              data-tasks-section={section.key}
              aria-labelledby={section.heading ? `tasks-${section.key}` : undefined}
              aria-label={section.heading ? undefined : 'Views'}
            >
              {section.heading && (
                <h3 id={`tasks-${section.key}`} className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                  {section.heading}
                </h3>
              )}
              <ul className="flex flex-col">
                {section.rows.map((row) => (
                  <li key={row.key}>
                    <TasksRowButton row={row} lit={row.key === lit} onPress={press} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </nav>
    </PagePanelFrame>
  )
}

function TasksRowButton({ row, lit, onPress }: { row: TasksRow; lit: boolean; onPress: (act: TasksRowAct, key: string) => void }) {
  const Icon = ROW_ICONS[iconKey(row.act)] ?? Bookmark
  return (
    <button
      type="button"
      data-tasks-row={row.key}
      aria-current={lit ? 'true' : undefined}
      onClick={() => onPress(row.act, row.key)}
      title={row.label}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
        lit ? ROW_LIT : 'hover:bg-muted/60',
      )}
    >
      <span aria-hidden data-tasks-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{row.label}</span>
    </button>
  )
}
