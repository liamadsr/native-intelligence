/**
 * The places inside the My Actions page's card that its sub-nav opens (Liam,
 * 11-11: "one todo icon on the main nav and when you click it the sub-nav
 * would show things like milestone and projects that way it's nested and
 * clean and not at the top level"): each a list drawn over the card's own,
 * a step in the card's history (components/chat-cards/card-body.tsx
 * TasksCardBody), never a card of its own.
 *
 *   projects     every project: the Projects page's own list (page-menu.ts)
 *   my-projects  the projects the person leads (project `lead_id` is @me:
 *                the only "mine" a project's filters have; no membership)
 *   milestones   the actions in a milestone, grouped by it (milestones are a
 *                groupable field on actions, validate.ts; no milestone page)
 *   initiatives  every initiative: the Initiatives page's own list
 *
 * Liam, 11-11: Projects and Initiatives nest under Tasks ("Yes, nest them"):
 * their `/` pages have no rail icon of their own, and opening either page
 * (`/`, Search, a link) lands on its place here (TASKS_PLACE_OF_PAGE;
 * app/account/(dashboard)/rail/rail-pages.ts NESTED_RAIL_PAGES).
 *
 * Liam, 11-11: "Teams should be under action items" (and "yes thats what I
 * meant for teams"): two more places, not lists of the views system but the
 * Teams page's own views, drawn over the card the same way
 * (components/chat-cards/pages/tasks-teams-place.tsx):
 *
 *   teams        All teams: the Teams page (the list, a team's settings);
 *                where the Teams page opens from `/`, Search or a link
 *   team:<id>    that team's board (its actions by state)
 *
 * tasksPlaceList is null for these two: they are not a list.
 *
 * Pure and client-safe.
 */
import type { ViewConfig } from '@/components/views/hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'

/** A place inside the Tasks card that is a list of the views system. */
export type TasksListPlace = 'my-projects' | 'projects' | 'milestones' | 'initiatives'

/** A place inside the Tasks card other than its own list (null: the list): a list, All teams, or one team's board. */
export type TasksPlace = TasksListPlace | 'teams' | `team:${string}`

/** All teams (the Teams page) inside the Tasks card. */
export const ALL_TEAMS_PLACE = 'teams' satisfies TasksPlace

/** One team's board inside the Tasks card. */
export const teamPlace = (teamId: string): TasksPlace => `team:${teamId}`

/** The team whose board `place` is, or null (another place). */
export function teamOfPlace(place: TasksPlace): string | null {
  return place.startsWith('team:') && place.length > 5 ? place.slice(5) : null
}

/** The list a place opens: its key (what its changes are kept by), its entity, its baseline. */
export interface TasksPlaceList {
  key: string
  entityType: ViewEntityType
  baseline: Partial<ViewConfig>
}

const PLACE_LISTS: Record<TasksListPlace, TasksPlaceList> = {
  projects: { key: 'tasks:projects', entityType: 'project', baseline: { filters: [] } },
  'my-projects': {
    key: 'tasks:my-projects',
    entityType: 'project',
    baseline: { filters: [{ id: 'tasks-lead', field: 'lead_id', operator: 'is', value: '@me' }] },
  },
  milestones: {
    key: 'tasks:milestones',
    entityType: 'action',
    baseline: {
      // `''` is the placeholder value is_not_empty carries (validate.ts).
      filters: [{ id: 'tasks-milestone', field: 'milestone_id', operator: 'is_not_empty', value: '' }],
      grouping: { field: 'milestone_id', direction: 'asc' },
    },
  },
  initiatives: { key: 'tasks:initiatives', entityType: 'initiative', baseline: { filters: [] } },
}

/** The list a place opens; null for All teams and a team's board (not a list). */
export function tasksPlaceList(place: TasksPlace): TasksPlaceList | null {
  return Object.prototype.hasOwnProperty.call(PLACE_LISTS, place) ? PLACE_LISTS[place as TasksListPlace] : null
}

/** A place this card knows (a value read back from storage may be anything). */
export function isTasksPlace(value: unknown): value is TasksPlace {
  if (typeof value !== 'string') return false
  if (Object.prototype.hasOwnProperty.call(PLACE_LISTS, value) || value === ALL_TEAMS_PLACE) return true
  return teamOfPlace(value as TasksPlace) !== null
}

/** The place inside the Tasks card a nested `/` page opens on, by the page's slug. */
export const TASKS_PLACE_OF_PAGE: Readonly<Record<string, TasksPlace>> = {
  projects: 'projects',
  initiatives: 'initiatives',
  teams: ALL_TEAMS_PLACE,
}
