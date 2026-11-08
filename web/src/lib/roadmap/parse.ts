// Turns GitHub's issue list into roadmap columns. Pure: no fetch, no env, so
// the page, the docs and the tests all share it.

export type RoadmapHorizon = 'now' | 'next' | 'later'
export type RoadmapStatus = 'planned' | 'in_progress' | 'shipped'

export interface RoadmapItem {
  number: number
  title: string
  /** The issue body before its `---` line (the voting note comes after it). */
  summary: string
  url: string
  /** `null` for a shipped item: it has left the timeline. */
  horizon: RoadmapHorizon | null
  status: RoadmapStatus
  /** The milestone title, e.g. "2027 Q1". */
  quarter: string | null
  up: number
  down: number
  net: number
  /** When the issue was closed (shipped items only sort by it). */
  closedAt: string | null
}

export interface RoadmapData {
  /** False when GitHub could not be read: the page shows its fallback. */
  ok: boolean
  horizons: Record<RoadmapHorizon, RoadmapItem[]>
  /** Each column's target quarter, from its items' milestones. */
  quarters: Record<RoadmapHorizon, string | null>
  shipped: RoadmapItem[]
}

export const ROADMAP_HORIZONS: readonly RoadmapHorizon[] = ['now', 'next', 'later']

/** The fields of GitHub's REST issue we read. Everything is optional: never trust the wire. */
export interface GitHubIssue {
  number?: number
  title?: string
  body?: string | null
  html_url?: string
  state?: string
  closed_at?: string | null
  pull_request?: unknown
  labels?: Array<string | { name?: string | null }>
  milestone?: { title?: string | null } | null
  reactions?: { '+1'?: number; '-1'?: number } | null
}

export function emptyRoadmap(ok: boolean): RoadmapData {
  return {
    ok,
    horizons: { now: [], next: [], later: [] },
    quarters: { now: null, next: null, later: null },
    shipped: [],
  }
}

/** The part of an issue body before a line that is only `---`. */
export function summaryFromBody(body: string | null | undefined): string {
  if (!body) return ''
  const text = body.replace(/\r\n?/g, '\n')
  const cut = text.search(/^[ \t]*---[ \t]*$/m)
  const before = cut === -1 ? text : text.slice(0, cut)
  return before.replace(/\n{3,}/g, '\n\n').trim()
}

function labelNames(issue: GitHubIssue): Set<string> {
  const names = new Set<string>()
  for (const label of issue.labels ?? []) {
    const name = typeof label === 'string' ? label : label?.name
    if (name) names.add(name.trim().toLowerCase())
  }
  return names
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** One issue as a roadmap item, or `null` when it doesn't belong on the roadmap. */
export function toRoadmapItem(issue: GitHubIssue): RoadmapItem | null {
  if (issue.pull_request) return null
  if (typeof issue.number !== 'number' || !issue.title || !issue.html_url) return null

  const labels = labelNames(issue)
  const closed = issue.state === 'closed'
  const shipped = closed && labels.has('shipped')
  // A closed issue that didn't ship was dropped: it leaves the roadmap.
  if (closed && !shipped) return null

  const horizon = shipped ? null : ROADMAP_HORIZONS.find((h) => labels.has(h)) ?? null
  // An open item with no horizon label has no column to sit in.
  if (!shipped && !horizon) return null

  const up = count(issue.reactions?.['+1'])
  const down = count(issue.reactions?.['-1'])

  return {
    number: issue.number,
    title: issue.title.trim(),
    summary: summaryFromBody(issue.body),
    url: issue.html_url,
    horizon,
    status: shipped ? 'shipped' : labels.has('in progress') ? 'in_progress' : 'planned',
    quarter: issue.milestone?.title?.trim() || null,
    up,
    down,
    net: up - down,
    closedAt: shipped ? issue.closed_at ?? null : null,
  }
}

/** Highest net score first, then the oldest issue. */
export function byVotes(a: RoadmapItem, b: RoadmapItem): number {
  return b.net - a.net || a.number - b.number
}

/** Most recently shipped first. */
function byShipped(a: RoadmapItem, b: RoadmapItem): number {
  return (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.number - a.number
}

/** "2027 Q1", or "2027 Q1 – 2027 Q2" when a column's items span quarters. */
function quarterOf(items: RoadmapItem[]): string | null {
  const quarters = [...new Set(items.map((i) => i.quarter).filter((q): q is string => !!q))].sort()
  if (quarters.length === 0) return null
  if (quarters.length === 1) return quarters[0]
  return `${quarters[0]} – ${quarters[quarters.length - 1]}`
}

export function buildRoadmap(issues: unknown): RoadmapData {
  if (!Array.isArray(issues)) return emptyRoadmap(false)
  const data = emptyRoadmap(true)
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue
    const item = toRoadmapItem(issue as GitHubIssue)
    if (!item) continue
    if (item.horizon) data.horizons[item.horizon].push(item)
    else data.shipped.push(item)
  }
  for (const horizon of ROADMAP_HORIZONS) {
    data.horizons[horizon].sort(byVotes)
    data.quarters[horizon] = quarterOf(data.horizons[horizon])
  }
  data.shipped.sort(byShipped)
  return data
}
