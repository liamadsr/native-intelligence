/**
 * The Tasks sub-nav's rows (tasks-panel-model.ts; Liam, 11-11: "one todo
 * icon on the main nav and when you click it the sub-nav would show things
 * like milestone and projects that way it's nested and clean"): the page's
 * views by the tab strip's own names, Projects, then Teams; never the saved
 * views (the card's toolbar's own; Liam, 11-20); no empty section; in the
 * workspace's words; at most one row lit, from where the card is. Fixtures
 * are made up.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, type EditionDefinition } from '@/lib/editions/manifest'
import { ACTION_SCOPE_TAB_ORDER, actionScopeLabel } from '@/lib/views/action-scopes'
import { litTasksRow, tasksPanelSections } from '../tasks-panel-model'

const full = getEdition('full')
const labels = (edition: EditionDefinition) =>
  tasksPanelSections(edition).map((s) => [s.heading, s.rows.map((r) => r.label)])

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
    expect(tasksPanelSections(full)[0].rows.map((r) => r.label).sort()).toEqual([...tabs].sort())
  })

  it('no saved views: they are the card’s toolbar’s own (Liam, 11-20)', () => {
    const teams = [{ id: 't-core', name: 'Core' }]
    expect(tasksPanelSections(full, teams).map((s) => s.heading)).not.toContain('Saved views')
  })

  it('no empty section: with projects and initiatives off, no Projects heading', () => {
    const narrow: EditionDefinition = {
      ...full,
      views: full.views.filter((v) => v !== 'projects' && v !== 'initiatives'),
      extraAllowedViews: full.extraAllowedViews.filter((v) => v !== 'projects' && v !== 'initiatives'),
    }
    expect(tasksPanelSections(narrow).map((s) => s.key)).toEqual(['views'])
  })

  it('in the workspace’s words: a service business’s jobs and goals', () => {
    const service = getEdition('service')
    const rows = tasksPanelSections(service).flatMap((s) => s.rows.map((r) => r.label))
    expect(rows).toContain('All jobs')
    expect(rows).not.toContain('All issues')
    if (rows.some((r) => r === 'Goals' || r === 'Initiatives')) expect(rows).toContain('Goals')
  })

  it('Teams (Liam, 11-11: "Teams should be under action items"): each team, then All teams, after Projects; only when there are teams', () => {
    expect(tasksPanelSections(full, []).some((s) => s.key === 'teams')).toBe(false)
    const teams = [{ id: 't-core', name: 'Core' }, { id: 't-field', name: 'Field crew' }]
    const sections = tasksPanelSections(full, teams)
    expect(sections.map((s) => s.key)).toEqual(['views', 'projects', 'teams'])
    const section = sections.find((s) => s.key === 'teams')!
    expect(section.heading).toBe('Teams')
    expect(section.rows.map((r) => [r.key, r.label])).toEqual([
      ['place:team:t-core', 'Core'],
      ['place:team:t-field', 'Field crew'],
      ['place:teams', 'All teams'],
    ])
  })

  it('at most one row lit, from where the card is: a place, else a view tab; none while a saved view is on', () => {
    expect(litTasksRow({ place: null, scope: 'assigned' })).toBe('scope:assigned')
    expect(litTasksRow({ place: 'projects', scope: null })).toBe('place:projects')
    // A saved view on (its toolbar tab lit): no scope, nothing lit here.
    expect(litTasksRow({ place: null, scope: null })).toBeNull()
    // A team's board lights that team; All teams its own row.
    expect(litTasksRow({ place: 'team:t-core', scope: 'assigned' })).toBe('place:team:t-core')
    expect(litTasksRow({ place: 'teams', scope: 'assigned' })).toBe('place:teams')
  })
})
