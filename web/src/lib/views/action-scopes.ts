/**
 * My Actions' three views of whose actions it lists: assigned to me, all of
 * them, created by me. One source for their names, so the page's own tab
 * strip (components/views/view-tabs.tsx) and the Tasks sub-nav beside the
 * rail (app/account/(dashboard)/page-panel/tasks-panel.tsx) say the same
 * (Liam, 11-11: "one todo icon on the main nav and when you click it the
 * sub-nav would show things like milestone and projects … nested and clean";
 * "ours should look similar except for the parts where our UX is different").
 *
 * The state they pick is the views system's own (`action_scope`,
 * components/views/hooks/use-view.ts): the tabs and the sub-nav set the same
 * thing on the same list.
 *
 * Pure and client-safe.
 */

/** Whose actions a top-level action list shows (ViewConfig.action_scope). */
export type ActionScope = 'assigned' | 'created' | 'all'

/** The page's tab strip, left to right, as it has always read. */
export const ACTION_SCOPE_TAB_ORDER: readonly ActionScope[] = ['all', 'assigned', 'created']

/** The sub-nav, top to bottom: the page's default (assigned to me) first. */
export const ACTION_SCOPE_NAV_ORDER: readonly ActionScope[] = ['assigned', 'all', 'created']

/** The app's own word after "All" on the tab ("All issues"), where an edition says nothing else. */
export const ACTION_SCOPE_ALL_WORD = 'issues'

/**
 * A scope's name. `allWord` is what "All" lists: an edition's word for
 * actions where it has one ("All jobs"), else the tab's own ("All issues").
 */
export function actionScopeLabel(scope: ActionScope, allWord: string = ACTION_SCOPE_ALL_WORD): string {
  if (scope === 'assigned') return 'Assigned to me'
  if (scope === 'created') return 'Created by me'
  return `All ${allWord}`
}
