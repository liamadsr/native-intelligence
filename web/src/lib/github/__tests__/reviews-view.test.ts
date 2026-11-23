/**
 * The Reviews page on the shared list (lib/github/reviews-view.ts): a pull
 * request as a `github_pr` row, what GitHub's search narrows by, and the
 * view's filters, sort and grouping applied to the rows. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { filterRows, groupRows, localValuesOf, searchFiltersOf, selectPrRows, sortRows, toPrRow } from '../reviews-view'
import type { ReviewPr } from '../reviews'
import type { ViewFilter } from '@/lib/views/types'

const pr = (n: number, over: Partial<ReviewPr> = {}): ReviewPr => ({
  id: `PR_${n}`, repo: 'acme/app', number: n, title: `Change ${n}`, url: `https://github.com/acme/app/pull/${n}`, state: 'open', draft: false,
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: 'APPROVED', checks: 'SUCCESS', createdAt: `2026-11-${10 + n}T10:00:00Z`,
  updatedAt: `2026-11-${20 - n}T10:00:00Z`, additions: n * 10, deletions: n, changedFiles: 1, headRef: 'b', headSha: 'd'.repeat(40), baseRef: 'main',
  author: { login: 'dana', avatarUrl: null }, labels: [], assignees: [], permission: 'WRITE', mergeMethods: ['squash'], linked: [], ...over,
})

const f = (field: string, operator: ViewFilter['operator'], value: ViewFilter['value'], conjunction?: 'and' | 'or'): ViewFilter => ({ id: field + operator, field, operator, value, conjunction })

const ROWS = [
  toPrRow(pr(1, { labels: [{ name: 'bug', color: null }], linked: [{ id: 'a', identifier: 'ENG-1', title: 'x' }] })),
  toPrRow(pr(2, { draft: true, reviewDecision: 'REVIEW_REQUIRED', author: { login: 'ravi', avatarUrl: null } })),
  toPrRow(pr(3, { checks: 'FAILURE', repo: 'acme/api', assignees: [{ login: 'dana', avatarUrl: null }] })),
  toPrRow(pr(4, { state: 'closed', reviewDecision: null, checks: null })),
  toPrRow(pr(5, { state: 'merged' })),
]

describe('toPrRow', () => {
  it('keys a row by owner/name#n and reads its stage, review and checks', () => {
    expect(ROWS.map((r) => r.id)).toEqual(['acme/app#1', 'acme/app#2', 'acme/api#3', 'acme/app#4', 'acme/app#5'])
    expect(ROWS.map((r) => r.board_column)).toEqual(['ready', 'draft', 'checks_failing', 'closed', 'merged'])
    expect(ROWS.map((r) => r.review)).toEqual(['approved', 'review_required', 'approved', 'none', 'approved'])
    expect(ROWS.map((r) => r.checks)).toEqual(['passing', 'passing', 'failing', 'none', 'passing'])
    expect(ROWS[0]).toMatchObject({ identifier: '#1', size: 11, labels: ['bug'] })
  })
})

describe('searchFiltersOf', () => {
  it('hands GitHub the section, state, sort and each plain value it can search by', () => {
    expect(
      searchFiltersOf('authored', 'all', [f('repo', 'is', ['acme/app']), f('author', 'is', 'ravi'), f('assignees', 'is_any_of', ['dana']), f('labels', 'is', ['bug']), f('review', 'is', ['changes_requested'])], [{ field: 'created_at', direction: 'desc' }]),
    ).toEqual({ section: 'authored', state: 'all', sort: 'created', linked: 'any', repo: 'acme/app', author: 'ravi', assignee: 'dana', label: 'bug', review: 'changes_requested' })
  })

  it('keeps what it cannot search by (several values, a negation, a malformed name) for the rows', () => {
    const out = searchFiltersOf('review_requests', 'open', [f('repo', 'is_any_of', ['acme/app', 'acme/api']), f('author', 'is_not', ['dana']), f('repo', 'is', ['not a repo']), f('author', 'is', ['bad login!'])], [])
    expect(out).toEqual({ section: 'review_requests', state: 'open', sort: 'updated', linked: 'any' })
  })
})

describe('filterRows', () => {
  it('applies enum, array, linked and date filters, joined by and/or', () => {
    expect(filterRows(ROWS, [f('checks', 'is', ['failing'])]).map((r) => r.number)).toEqual([3])
    expect(filterRows(ROWS, [f('labels', 'includes', ['bug'])]).map((r) => r.number)).toEqual([1])
    expect(filterRows(ROWS, [f('linked', 'is', ['linked'])]).map((r) => r.number)).toEqual([1])
    expect(filterRows(ROWS, [f('assignees', 'is_empty', [])]).map((r) => r.number)).toEqual([1, 2, 4, 5])
    expect(filterRows(ROWS, [f('state', 'is', ['merged']), f('board_column', 'is', ['draft'], 'or')]).map((r) => r.number)).toEqual([2, 5])
    expect(filterRows(ROWS, [f('created_at', 'gte', '2026-11-14T00:00:00Z')]).map((r) => r.number)).toEqual([4, 5])
  })

  it('lets every row through for a filter with no value yet', () => {
    expect(filterRows(ROWS, [f('repo', 'is', [])])).toHaveLength(5)
  })
})

describe('sortRows and groupRows', () => {
  it('sorts by the view, recently updated by default', () => {
    expect(sortRows(ROWS, []).map((r) => r.number)).toEqual([1, 2, 3, 4, 5])
    expect(sortRows(ROWS, [{ field: 'size', direction: 'desc' }]).map((r) => r.number)).toEqual([5, 4, 3, 2, 1])
  })

  it('draws every board column in order, empty ones too, and no column for closed-unmerged', () => {
    const cols = groupRows(ROWS, 'board_column', { board: true })
    expect(cols.map((c) => c.key)).toEqual(['draft', 'in_review', 'checks_failing', 'conflicts', 'ready', 'merged'])
    expect(cols.find((c) => c.key === 'in_review')!.items).toEqual([])
  })

  it('groups a free field by its values, an array field putting a row under each, with None last', () => {
    const groups = groupRows(ROWS, 'assignees')
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([['dana', 1], ['None', 4]])
  })

  it('selectPrRows: the board on stages by default, counting the closed-unmerged it leaves off', () => {
    const out = selectPrRows(ROWS, { filters: [], ordering: [], grouping: null, layout: 'board' })
    expect(out.closedOffBoard).toBe(1)
    expect(selectPrRows(ROWS, { filters: [], ordering: [], grouping: null, layout: 'list' }).data).toHaveLength(5)
  })
})

describe('localValuesOf', () => {
  it('lists the repositories, authors, assignees and labels on screen for the filter pickers', () => {
    const v = localValuesOf(ROWS)
    expect(new Set(v['github_pr.repo'])).toEqual(new Set(['acme/app', 'acme/api']))
    expect(new Set(v['github_pr.author'])).toEqual(new Set(['dana', 'ravi']))
    expect(v['github_pr.labels']).toEqual(['bug'])
  })
})
