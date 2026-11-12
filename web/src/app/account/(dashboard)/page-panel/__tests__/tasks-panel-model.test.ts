/**
 * The Tasks sub-nav's rows (tasks-panel-model.ts; Liam, 11-11: "one todo
 * icon on the main nav and when you click it the sub-nav would show things
 * like milestone and projects that way it's nested and clean"): the page's
 * views by the tab strip's own names, Projects, then saved views only when
 * there are any; no empty section; in the workspace's words; one row lit,
 * from where the card is. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, type EditionDefinition } from '@/lib/editions/manifest'
import { ACTION_SCOPE_TAB_ORDER, actionScopeLabel } from '@/lib/views/action-scopes'
import { litTasksRow, tasksPanelSections } from '../tasks-panel-model'

const full = getEdition('full')
const labels = (edition: EditionDefinition, views: Array<{ id: string; name: string }> = []) =>
  tasksPanelSections(edition, views).map((s) => [s.heading, s.rows.map((r) => r.label)])

describe('the Tasks sub-nav’s rows', () => {
  it('top to bottom: the views (no heading, the page’s default first), then Projects', () => {
    expect(labels(full)).toEqual([
      [null, ['Assigned to me', 'All issues', 'Created by me']],
      ['Projects', ['My projects', 'All projects', 'Milestones', 'Initiatives']],
    ])
  })

  it('the views read as the page’s own tabs do (one source)', () => {
    const tabs = ACTION_SCOPE_TAB_ORDER.map((s) => actionScopeLabel(s))
    expect(tabs).toEqual(['All issues', 'Assigned to me', 'Created by me'])
    expect(tasksPanelSections(full, [])[0].rows.map((r) => r.label).sort()).toEqual([...tabs].sort())
  })

  it('saved views: a section only when the person has any', () => {
    expect(tasksPanelSections(full, []).some((s) => s.key === 'saved')).toBe(false)
    const views = [{ id: 'v-1', name: 'Fernhill launch' }, { id: 'v-2', name: 'Bugs this week' }]
    expect(labels(full, views).at(-1)).toEqual(['Saved views', ['Fernhill launch', 'Bugs this week']])
  })

  it('no empty section: with projects and initiatives off, no Projects heading', () => {
    const narrow: EditionDefinition = {
      ...full,
      views: full.views.filter((v) => v !== 'projects' && v !== 'initiatives'),
      extraAllowedViews: full.extraAllowedViews.filter((v) => v !== 'projects' && v !== 'initiatives'),
    }
    expect(tasksPanelSections(narrow, []).map((s) => s.key)).toEqual(['views'])
  })

  it('in the workspace’s words: a service business’s jobs and goals', () => {
    const service = getEdition('service')
    const rows = tasksPanelSections(service, []).flatMap((s) => s.rows.map((r) => r.label))
    expect(rows).toContain('All jobs')
    expect(rows).not.toContain('All issues')
    if (rows.some((r) => r === 'Goals' || r === 'Initiatives')) expect(rows).toContain('Goals')
  })

  it('Teams (Liam, 11-11: "Teams should be under action items"): each team, then All teams, after Projects and before Saved views; only when there are teams', () => {
    expect(tasksPanelSections(full, [], []).some((s) => s.key === 'teams')).toBe(false)
    const teams = [{ id: 't-core', name: 'Core' }, { id: 't-field', name: 'Field crew' }]
    const views = [{ id: 'v-1', name: 'Fernhill launch' }]
    const sections = tasksPanelSections(full, views, teams)
    expect(sections.map((s) => s.key)).toEqual(['views', 'projects', 'teams', 'saved'])
    const section = sections.find((s) => s.key === 'teams')!
    expect(section.heading).toBe('Teams')
    expect(section.rows.map((r) => [r.key, r.label])).toEqual([
      ['place:team:t-core', 'Core'],
      ['place:team:t-field', 'Field crew'],
      ['place:teams', 'All teams'],
    ])
  })

  it('one row lit, from where the card is: a place, else a saved view, else a view tab', () => {
    expect(litTasksRow({ place: null, viewId: null, scope: 'assigned' })).toBe('scope:assigned')
    expect(litTasksRow({ place: null, viewId: 'v-1', scope: null })).toBe('view:v-1')
    expect(litTasksRow({ place: 'projects', viewId: 'v-1', scope: null })).toBe('place:projects')
    expect(litTasksRow({ place: null, viewId: null, scope: null })).toBeNull()
    // A team's board lights that team; All teams its own row.
    expect(litTasksRow({ place: 'team:t-core', viewId: null, scope: 'assigned' })).toBe('place:team:t-core')
    expect(litTasksRow({ place: 'teams', viewId: null, scope: 'assigned' })).toBe('place:teams')
  })
})
