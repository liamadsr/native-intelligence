import { describe, expect, it, vi, beforeEach } from 'vitest'
import { categoryForLinearType, parentsFirst, planLinearImport } from '../plan'
import type { LinearImportIssue } from '../read'
import type { ActionRecord } from '../../types'

vi.mock('@/lib/integrations/linear-api', () => ({ linearGraphQL: vi.fn(), listTeamStates: vi.fn() }))
import { linearGraphQL } from '@/lib/integrations/linear-api'
import { readTeamIssues } from '../read'

function issue(id: string, over: Partial<LinearImportIssue> = {}): LinearImportIssue {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: 0,
    estimate: null,
    dueDate: null,
    url: `https://linear.app/x/issue/ENG-${id}`,
    state: { id: 'ls-todo', name: 'Todo', type: 'unstarted' },
    assignee: null,
    labels: { nodes: [] },
    project: null,
    parent: null,
    cycle: null,
    ...over,
  }
}

const states = [
  { id: 's-todo', name: 'Todo', category: 'unstarted' as const, is_default: true, sort_order: 0 },
  { id: 's-doing', name: 'In Progress', category: 'started' as const, sort_order: 1 },
  { id: 's-done', name: 'Done', category: 'completed' as const, sort_order: 2 },
]

describe('planLinearImport', () => {
  const issues = [
    issue('2', { parent: { id: '1' }, priority: 2, assignee: { id: 'u1', name: 'Ava', email: 'AVA@example.com' }, labels: { nodes: [{ id: 'x', name: 'bug' }, { id: 'y', name: 'Perf' }] } }),
    issue('1', { state: { id: 'ls-rev', name: 'In Review', type: 'started' }, project: { id: 'lp1', name: 'Website' }, description: 'Body **md**', cycle: { number: 4, name: null } }),
    issue('3', { state: { id: 'ls-done', name: 'Done', type: 'completed' }, assignee: { id: 'u9', name: 'Zed', email: 'zed@example.com' }, dueDate: '2026-12-01', estimate: 3, project: { id: 'lp2', name: 'Mobile' } }),
    issue('4'),
  ]
  const base = {
    teams: [{ teamId: 'team-1', linearTeamName: 'Engineering', issues, states }],
    members: [{ id: 'm-ava', name: 'Ava Stone', email: 'ava@example.com' }],
    labels: [{ id: 'l-bug', name: 'Bug' }],
    projects: [{ id: 'p-web', name: 'website' }],
    alreadyImported: new Set(['4']),
  }

  it('maps fields, matches by name and email, and keeps parents first', () => {
    const plan = planLinearImport({ ...base, createStates: false })
    const acts = plan.items.filter((i) => i.record.kind === 'action')
    expect(acts.map((a) => a.external_id)).toEqual(['1', '2', '3'])
    const [one, two, three] = acts.map((a) => a.record as ActionRecord)
    // "In Review" isn't ours: folded into a started state.
    expect(one).toMatchObject({ status: { id: 's-doing' }, project: { id: 'p-web' }, source_label: 'ENG-1' })
    expect(one.description).toBe('Body **md**\n\nImported from Linear: ENG-1 (https://linear.app/x/issue/ENG-1). Cycle: Cycle 4.')
    expect(two).toMatchObject({ priority: 'high', assignee_member_id: 'm-ava', parent: { ref: 'issue:0' }, labels: [{ id: 'l-bug' }, { ref: 'label:0' }] })
    expect(three).toMatchObject({ status: { id: 's-done' }, assignee_member_id: null, due_date: '2026-12-01', estimate: 3, project: { ref: 'project:0' } })
    expect(plan.counts).toMatchObject({ action: 3, label: 1, project: 1, workflow_state: 0, skipped: 1 })
    const text = plan.notes.map((n) => n.text).join('\n')
    expect(text).toMatch(/1 issue was imported before/)
    expect(text).toMatch(/In Review → In Progress/)
    expect(text).toMatch(/“Zed”/)
  })

  it('makes a missing state when asked', () => {
    const plan = planLinearImport({ ...base, createStates: true })
    const made = plan.items.filter((i) => i.record.kind === 'workflow_state')
    expect(made.map((m) => m.record)).toEqual([{ kind: 'workflow_state', team_id: 'team-1', name: 'In Review', category: 'started' }])
    const one = plan.items.find((i) => i.external_id === '1')!.record as ActionRecord
    expect(one.status).toEqual({ ref: 'state:0' })
  })

  it('reads Linear’s state types', () => {
    expect(categoryForLinearType('triage')).toBe('backlog')
    expect(categoryForLinearType('canceled')).toBe('canceled')
    expect(categoryForLinearType(undefined)).toBe('unstarted')
  })

  it('places a parent before its children, whatever the order', () => {
    const a = issue('a', { parent: { id: 'b' } })
    const b = issue('b', { parent: { id: 'c' } })
    const c = issue('c')
    expect(parentsFirst([a, b, c]).map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('readTeamIssues', () => {
  beforeEach(() => vi.mocked(linearGraphQL).mockReset())

  it('pages until done, leaving closed issues out unless asked', async () => {
    vi.mocked(linearGraphQL)
      .mockResolvedValueOnce({ team: { issues: { nodes: [issue('1')], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } })
      .mockResolvedValueOnce({ team: { issues: { nodes: [issue('2')], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const out = await readTeamIssues('tok', 'lt1', { includeClosed: false, pauseMs: 0 })
    expect(out).toEqual({ issues: [issue('1'), issue('2')], truncated: false })
    const vars = vi.mocked(linearGraphQL).mock.calls[1][2] as Record<string, unknown>
    expect(vars).toMatchObject({ teamId: 'lt1', after: 'c1', filter: { state: { type: { nin: ['completed', 'canceled'] } } } })
  })

  it('stops at the cap and says so', async () => {
    vi.mocked(linearGraphQL).mockResolvedValue({ team: { issues: { nodes: [issue('1'), issue('2')], pageInfo: { hasNextPage: true, endCursor: 'c' } } } })
    const out = await readTeamIssues('tok', 'lt1', { includeClosed: true, max: 3, pauseMs: 0 })
    expect(out.issues).toHaveLength(3)
    expect(out.truncated).toBe(true)
    expect(vi.mocked(linearGraphQL).mock.calls[0][2]).toMatchObject({ filter: {} })
  })
})
