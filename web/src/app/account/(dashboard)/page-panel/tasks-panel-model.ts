/**
 * What the Tasks sub-nav lists, and which row is lit (Liam, 11-11: "one todo
 * icon on the main nav and when you click it the sub-nav would show things
 * like milestone and projects that way it's nested and clean and not at the
 * top level"; "ours should look similar except for the parts where our UX is
 * different"). Drawn by ./tasks-panel.tsx.
 *
 *   Views        no heading: Assigned to me (the page's default), All
 *                <actions>, Created by me: the page's own view tabs, by the
 *                same names (lib/views/action-scopes.ts)
 *   Projects     My projects (the ones the person leads), All projects,
 *                Milestones (the actions in one, grouped by it),
 *                Initiatives (they group projects): places inside the card
 *                (lib/chat-cards/tasks-places.ts), each only where the
 *                workspace has its page on
 *   Teams        one row per team the person can see (the Teams page's
 *                list, by name), then All teams: a team opens its board
 *                inside the card, All teams the Teams page inside it
 *                (Liam, 11-11: "Teams should be under action items"; "yes
 *                thats what I meant for teams"); only when there are teams
 *   Saved views  the person's saved views for actions, only when they have
 *                any
 *
 * No empty section: one with no rows isn't listed (Liam's "hide empty
 * widgets"). In the workspace's words (src/lib/editions/words.ts): "All
 * jobs", "Goals" where the edition says so.
 *
 * Lit: exactly one row, from where the card is (a place, else a saved view,
 * else a view tab), never from a click.
 *
 * Pure and client-safe.
 */
import { isViewAllowed, type EditionDefinition } from '@/lib/editions/manifest'
import { editionWords, termWords } from '@/lib/editions/words'
import { ACTION_SCOPE_NAV_ORDER, actionScopeLabel, type ActionScope } from '@/lib/views/action-scopes'
import { ALL_TEAMS_PLACE, teamPlace, type TasksPlace } from '@/lib/chat-cards/tasks-places'
import type { TasksSavedView } from '@/components/chat-cards/tasks-card-controls'

/** What a row does: a view tab's view, a place inside the card, a saved view. */
export type TasksRowAct =
  | { kind: 'scope'; scope: ActionScope }
  | { kind: 'place'; place: TasksPlace }
  | { kind: 'view'; id: string }

export interface TasksRow {
  /** `scope:assigned`, `place:projects`, `view:<id>`. */
  key: string
  label: string
  act: TasksRowAct
}

export interface TasksSection {
  key: 'views' | 'projects' | 'teams' | 'saved'
  /** Null: the first group, which has none. */
  heading: string | null
  rows: TasksRow[]
}

export const rowKeyOf = (act: TasksRowAct): string =>
  act.kind === 'scope' ? `scope:${act.scope}` : act.kind === 'place' ? `place:${act.place}` : `view:${act.id}`

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

const row = (act: TasksRowAct, label: string): TasksRow => ({ key: rowKeyOf(act), label, act })

/** A team, as the Teams section lists it. */
export interface TasksTeam {
  id: string
  name: string
}

/** The sub-nav's sections, top to bottom; a section with no rows isn't there. */
export function tasksPanelSections(edition: EditionDefinition, views: readonly TasksSavedView[], teams: readonly TasksTeam[] = []): TasksSection[] {
  // "All jobs" where the edition has its own word for actions; else the tab's own ("All issues").
  const allWord = editionWords(edition).terms.action?.many
  const projects = termWords(edition, 'project').many
  const initiatives = termWords(edition, 'initiative').many
  const sections: TasksSection[] = [
    {
      key: 'views',
      heading: null,
      rows: ACTION_SCOPE_NAV_ORDER.map((scope) => row({ kind: 'scope', scope }, actionScopeLabel(scope, allWord))),
    },
    {
      key: 'projects',
      heading: capital(projects),
      rows: [
        ...(isViewAllowed(edition, 'projects')
          ? [
              row({ kind: 'place', place: 'my-projects' }, `My ${projects}`),
              row({ kind: 'place', place: 'projects' }, `All ${projects}`),
              row({ kind: 'place', place: 'milestones' }, 'Milestones'),
            ]
          : []),
        ...(isViewAllowed(edition, 'initiatives') ? [row({ kind: 'place', place: 'initiatives' }, capital(initiatives))] : []),
      ],
    },
    {
      key: 'teams',
      heading: 'Teams',
      rows:
        teams.length && isViewAllowed(edition, 'teams')
          ? [...teams.map((t) => row({ kind: 'place', place: teamPlace(t.id) }, t.name)), row({ kind: 'place', place: ALL_TEAMS_PLACE }, 'All teams')]
          : [],
    },
    {
      key: 'saved',
      heading: 'Saved views',
      rows: views.map((v) => row({ kind: 'view', id: v.id }, v.name)),
    },
  ]
  return sections.filter((s) => s.rows.length > 0)
}

/** The row lit for where the card is: its place, else its saved view, else its view tab; null for none of these. */
export function litTasksRow(card: { place: TasksPlace | null; viewId: string | null; scope: ActionScope | null }): string | null {
  if (card.place) return rowKeyOf({ kind: 'place', place: card.place })
  if (card.viewId) return rowKeyOf({ kind: 'view', id: card.viewId })
  if (card.scope) return rowKeyOf({ kind: 'scope', scope: card.scope })
  return null
}
