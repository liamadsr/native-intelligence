/**
 * The Reviews page on the shared list parts (docs/plans/github-reviews.md,
 * "Reviews on the app's own list"): pull requests as rows of the view kind
 * `github_pr` (lib/views/types.ts), and the view's filters, grouping and sort
 * applied to them here, since no table stands behind them.
 *
 *   toPrRow          a ReviewPr as the shared row (`id` is `owner/name#12`).
 *   searchFiltersOf  what GitHub's search can narrow by: the section, the
 *                    state, the sort, and each filter that is one plain
 *                    value (`repo is acme/app`). Everything else is applied
 *                    to the rows it returns.
 *   selectPrRows     the view's filters, then its sort, then its grouping
 *                    (GroupedResults, the board's columns in their order).
 *
 * Client-safe and pure.
 */
import type { GroupedResults, SortConfig, ViewFilter } from '@/lib/views/types'
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  LOGIN_RE,
  REPO_RE,
  boardColumn,
  prKey,
  type ReviewDecisionFilter,
  type ReviewFilters,
  type ReviewPr,
  type ReviewSection,
  type ReviewSort,
  type ReviewStateFilter,
} from './reviews'

export type PrReview = 'approved' | 'changes_requested' | 'review_required' | 'none'
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none'
/** A board column, plus `closed` for one closed without merging (it sits in no board column). */
export type PrStage = (typeof BOARD_COLUMNS)[number] | 'closed'

/** A pull request as a row of the shared list (EntityRow) and board. */
export interface ReviewPrRow {
  id: string
  title: string
  /** `#12`, in the row's identifier slot. */
  identifier: string
  repo: string
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  board_column: PrStage
  review: PrReview
  checks: PrChecks
  author: string | null
  assignees: string[]
  labels: string[]
  linked: ReviewPr['linked']
  additions: number
  deletions: number
  /** A field for the display picker: drawn from additions and deletions. */
  size: number
  updated_at: string
  created_at: string
  /** The pull request itself, for its panel. */
  pr: ReviewPr
}

const REVIEW_OF: Record<string, PrReview> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' }

function checksOf(pr: ReviewPr): PrChecks {
  if (pr.checks === 'SUCCESS') return 'passing'
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return 'failing'
  if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') return 'pending'
  return 'none'
}

export function toPrRow(pr: ReviewPr): ReviewPrRow {
  return {
    id: prKey(pr.repo, pr.number),
    title: pr.title,
    identifier: `#${pr.number}`,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    board_column: boardColumn(pr) ?? 'closed',
    review: REVIEW_OF[pr.reviewDecision ?? ''] ?? 'none',
    checks: checksOf(pr),
    author: pr.author?.login ?? null,
    assignees: pr.assignees.map((a) => a.login),
    labels: pr.labels.map((l) => l.name),
    linked: pr.linked,
    additions: pr.additions,
    deletions: pr.deletions,
    size: pr.additions + pr.deletions,
    updated_at: pr.updatedAt,
    created_at: pr.createdAt,
    pr,
  }
}

const one = (v: unknown): string | null => {
  if (typeof v === 'string' && v) return v
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0]
  return null
}

/** The search GitHub runs for a section: its state and sort, and every filter it can take as one plain value. */
export function searchFiltersOf(section: ReviewSection, state: ReviewStateFilter, filters: readonly ViewFilter[], ordering: readonly SortConfig[]): ReviewFilters {
  const out: ReviewFilters = { section, state, sort: ordering[0]?.field === 'created_at' ? 'created' : ('updated' as ReviewSort), linked: 'any' }
  for (const f of filters) {
    if (f.operator !== 'is' && f.operator !== 'is_any_of') continue
    const v = one(f.value)
    if (!v) continue
    if (f.field === 'repo' && REPO_RE.test(v)) out.repo = v
    if (f.field === 'author' && LOGIN_RE.test(v)) out.author = v
    if (f.field === 'assignees' && LOGIN_RE.test(v)) out.assignee = v
    if (f.field === 'labels' && v.length <= 50 && !/["\\\r\n]/.test(v)) out.label = v
    if (f.field === 'review') {
      const map: Record<string, ReviewDecisionFilter> = { approved: 'approved', changes_requested: 'changes_requested', review_required: 'required', none: 'none' }
      if (map[v]) out.review = map[v]
    }
  }
  return out
}

/** The row's value(s) for a field, as strings (an array field: each). */
function valuesOf(row: ReviewPrRow, field: string): string[] {
  switch (field) {
    case 'assignees':
      return row.assignees
    case 'labels':
      return row.labels
    case 'linked':
      return [row.linked.length > 0 ? 'linked' : 'unlinked']
    case 'author':
      return row.author ? [row.author] : []
    default: {
      const v = (row as unknown as Record<string, unknown>)[field]
      return v == null ? [] : [String(v)]
    }
  }
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' && v ? [v] : []
}

/** Whether a row passes one filter. An operator this page doesn't know lets the row through. */
export function rowMatches(row: ReviewPrRow, f: ViewFilter): boolean {
  if (f.field === 'updated_at' || f.field === 'created_at') return dateMatches(row[f.field], f)
  const have = valuesOf(row, f.field).map((v) => v.toLowerCase())
  const want = asList(f.value).map((v) => v.toLowerCase())
  switch (f.operator) {
    case 'is':
    case 'is_any_of':
    case 'includes':
      return want.length === 0 || want.some((w) => have.includes(w))
    case 'is_not':
    case 'is_none_of':
    case 'excludes':
      return !want.some((w) => have.includes(w))
    case 'equals':
      return want.length === have.length && want.every((w) => have.includes(w))
    case 'is_empty':
      return have.length === 0
    case 'is_not_empty':
      return have.length > 0
    case 'contains':
      return want.length === 0 || have.some((h) => want.some((w) => h.includes(w)))
    case 'does_not_contain':
      return !have.some((h) => want.some((w) => h.includes(w)))
    default:
      return true
  }
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 }

function dateMatches(iso: string, f: ViewFilter): boolean {
  const t = Date.parse(iso)
  if (f.operator === 'is_empty') return !Number.isFinite(t)
  if (f.operator === 'is_not_empty') return Number.isFinite(t)
  if (!Number.isFinite(t)) return false
  const v = f.value
  const day = 86_400_000
  if (f.operator === 'is_relative' && v && typeof v === 'object' && !Array.isArray(v) && 'unit' in v) {
    const r = v as { unit: string; direction: string; count?: number }
    const span = (r.count ?? 1) * (UNIT_DAYS[r.unit] ?? 1) * day
    if (r.direction === 'future') return t >= Date.now() && t <= Date.now() + span
    return t >= Date.now() - span && t <= Date.now()
  }
  if (f.operator === 'between' && v && typeof v === 'object' && !Array.isArray(v) && 'from' in v) {
    const r = v as { from: string | number; to: string | number }
    const from = Date.parse(String(r.from))
    const to = Date.parse(String(r.to))
    return (!Number.isFinite(from) || t >= from) && (!Number.isFinite(to) || t <= to + day)
  }
  const at = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN
  if (!Number.isFinite(at)) return true
  switch (f.operator) {
    case 'is':
      return Math.floor(t / day) === Math.floor(at / day)
    case 'is_not':
      return Math.floor(t / day) !== Math.floor(at / day)
    case 'gt':
      return t > at
    case 'gte':
      return t >= at
    case 'lt':
      return t < at
    case 'lte':
      return t <= at
    default:
      return true
  }
}

/** Every filter (an `or` filter joins the one before it, as the shared engine reads them). */
export function filterRows(rows: readonly ReviewPrRow[], filters: readonly ViewFilter[]): ReviewPrRow[] {
  const real = filters.filter((f) => f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0) || f.operator === 'is_empty' || f.operator === 'is_not_empty')
  if (real.length === 0) return [...rows]
  return rows.filter((row) => {
    let ok = rowMatches(row, real[0])
    for (const f of real.slice(1)) ok = f.conjunction === 'or' ? ok || rowMatches(row, f) : ok && rowMatches(row, f)
    return ok
  })
}

export function sortRows(rows: readonly ReviewPrRow[], ordering: readonly SortConfig[]): ReviewPrRow[] {
  const by = ordering.length ? ordering : [{ field: 'updated_at', direction: 'desc' as const }]
  return [...rows].sort((a, b) => {
    for (const s of by) {
      const av = (a as unknown as Record<string, unknown>)[s.field]
      const bv = (b as unknown as Record<string, unknown>)[s.field]
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''))
      if (c !== 0) return s.direction === 'asc' ? c : -c
    }
    return 0
  })
}

const ENUM_ORDER: Record<string, readonly string[]> = {
  board_column: [...BOARD_COLUMNS, 'closed'],
  state: ['open', 'merged', 'closed'],
  review: ['changes_requested', 'review_required', 'approved', 'none'],
  checks: ['failing', 'pending', 'passing', 'none'],
  linked: ['linked', 'unlinked'],
}

const ENUM_LABEL: Record<string, Record<string, string>> = {
  board_column: { ...BOARD_COLUMN_LABEL, closed: 'Closed' },
  state: { open: 'Open', merged: 'Merged', closed: 'Closed' },
  review: { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required', none: 'No review' },
  checks: { passing: 'Checks pass', failing: 'Checks fail', pending: 'Checks running', none: 'No checks' },
  linked: { linked: 'Linked to an action', unlinked: 'Not linked' },
}

/**
 * The rows grouped by `field` (GroupedResults, the shared list's groups and
 * the board's columns). The board's own field keeps every column, empty
 * ones too, in its order; a closed, unmerged pull request has no column
 * there. Other fields: one group per value seen (an array field puts a row
 * in each of its values; none, under "None").
 */
export function groupRows(rows: readonly ReviewPrRow[], field: string, opts: { board?: boolean } = {}): GroupedResults[] {
  const order = ENUM_ORDER[field]
  const labels = ENUM_LABEL[field] ?? {}
  const groups = new Map<string, Record<string, unknown>[]>()
  if (order) for (const k of order) groups.set(k, [])
  for (const row of rows) {
    const keys = valuesOf(row, field)
    for (const k of keys.length ? keys : ['__none']) {
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(row as unknown as Record<string, unknown>)
    }
  }
  let out = [...groups.entries()].map(([key, items]) => ({ key, label: key === '__none' ? 'None' : (labels[key] ?? key), items }))
  if (field === 'board_column' && opts.board) out = out.filter((g) => g.key !== 'closed')
  else if (order) out = out.filter((g) => g.items.length > 0)
  if (!order) out.sort((a, b) => (a.key === '__none' ? 1 : b.key === '__none' ? -1 : a.label.localeCompare(b.label)))
  return out
}

/** The view applied to the rows: filters, sort, then the grouping (or the flat list). */
export function selectPrRows(
  rows: readonly ReviewPrRow[],
  config: { filters: readonly ViewFilter[]; ordering: readonly SortConfig[]; grouping: { field: string } | null; layout: string },
): { data: Record<string, unknown>[] | GroupedResults[]; flat: ReviewPrRow[]; closedOffBoard: number } {
  const flat = sortRows(filterRows(rows, config.filters), config.ordering)
  const board = config.layout === 'board'
  const field = config.grouping?.field ?? (board ? 'board_column' : null)
  if (!field) return { data: flat as unknown as Record<string, unknown>[], flat, closedOffBoard: 0 }
  const closedOffBoard = board && field === 'board_column' ? flat.filter((r) => r.board_column === 'closed').length : 0
  return { data: groupRows(flat, field, { board }), flat, closedOffBoard }
}

/** The values on screen for the filter pickers' `local:` sources. */
export function localValuesOf(rows: readonly ReviewPrRow[]): Record<string, string[]> {
  return {
    'github_pr.repo': rows.map((r) => r.repo),
    'github_pr.author': rows.map((r) => r.author ?? '').filter(Boolean),
    'github_pr.assignees': rows.flatMap((r) => r.assignees),
    'github_pr.labels': rows.flatMap((r) => r.labels),
  }
}
