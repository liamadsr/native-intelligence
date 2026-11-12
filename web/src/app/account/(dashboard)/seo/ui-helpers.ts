/**
 * The Site audit page's words and colours, pure, so the views and their
 * tests read the same strings.
 *
 * House style: sentence case, plural-aware counts, a clause whose number is
 * zero dropped, ` · ` between clauses, every number with tabular figures
 * where it is drawn.
 */
import type { IssueSeverity } from '@/lib/seo/audit/issues'
import type { SiteAuditIssueRow, SiteAuditPageRow, SiteAuditView } from '@/lib/seo/audit/view'
import type { AuditPageFilter } from './api'

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** "1 page", "1,204 pages". */
export function count(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString()} ${plural(n, one, many)}`
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", "Mar 4". */
export function relativeWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const minutes = Math.round((now.getTime() - t) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${count(minutes, 'minute')} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${count(hours, 'hour')} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const d = new Date(t)
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/**
 * The run rail's sentence for a live audit, as a verb and its clauses:
 *
 *   Reading the sitemap · example.com
 *   Checking pages · 42 of about 100 · example.com
 *   Comparing pages · 100 checked
 *
 * "of about N" only while more pages are known than checked; a count of
 * nothing is dropped (a stage that hasn't reported yet, not progress).
 */
export function auditRailLine(audit: Pick<SiteAuditView, 'status' | 'phase' | 'host' | 'pages_crawled' | 'pages_queued'>): {
  verb: string
  clauses: string[]
} {
  const crawled = audit.pages_crawled
  if (audit.status === 'queued') return { verb: 'Starting', clauses: [audit.host] }
  if (audit.phase === 'discovery') return { verb: 'Reading the sitemap', clauses: [audit.host] }
  if (audit.phase === 'crawl') {
    const clauses: string[] = []
    if (crawled > 0) {
      clauses.push(audit.pages_queued > crawled ? `${crawled.toLocaleString()} of about ${audit.pages_queued.toLocaleString()}` : crawled.toLocaleString())
    }
    clauses.push(audit.host)
    return { verb: 'Checking pages', clauses }
  }
  if (audit.phase === 'analysis') return { verb: 'Comparing pages', clauses: crawled > 0 ? [`${crawled.toLocaleString()} checked`] : [] }
  return { verb: 'Finishing', clauses: [audit.host] }
}

/** The status word an index row shows (a completed audit shows its counts instead). */
export const STATUS_WORD: Record<SiteAuditView['status'], string | null> = {
  queued: 'Starting',
  running: 'Running',
  completed: null,
  failed: 'Failed',
  canceled: 'Stopped',
}

// ── Severity ─────────────────────────────────────────────────────────────

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

/** The index row's count chips: "2 critical", "12 warnings", "5 info". */
export function severityCountLabel(severity: IssueSeverity, n: number): string {
  if (severity === 'warning') return count(n, 'warning')
  return `${n.toLocaleString()} ${severity}`
}

/** A severity chip's colours (evals/outcome-chip.tsx's treatment). */
export const SEVERITY_CHIP: Record<IssueSeverity, string> = {
  critical: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
}

/** A severity's segment in the stacked bar. */
export const SEVERITY_BAR: Record<IssueSeverity, string> = {
  critical: 'bg-red-500 dark:bg-red-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  info: 'bg-sky-500 dark:bg-sky-400',
}

/** "4 on 3 pages", or "3 pages" when each page has one. */
export function findingsOnPages(n: number, pages: number): string {
  if (n === pages) return count(pages, 'page')
  return `${n.toLocaleString()} on ${count(pages, 'page')}`
}

// ── Pages and findings ───────────────────────────────────────────────────

/** A URL as its path (and query): "/pricing", "/" for the root; the URL itself when it isn't one. */
export function pathOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.pathname || '/'}${u.search}`
  } catch {
    return url
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** One short line on what a finding's check measured, or null when it has nothing to add. */
export function issueDetail(row: Pick<SiteAuditIssueRow, 'type' | 'details'>): string | null {
  const d = row.details ?? {}
  switch (row.type) {
    case 'broken-internal-link': {
      const target = str(d.targetUrl)
      if (!target) return null
      const status = num(d.targetStatus)
      return `links to ${pathOf(target)}${status ? ` (${status})` : ''}`
    }
    case 'title-too-long':
    case 'title-too-short':
    case 'meta-description-too-long':
    case 'meta-description-too-short': {
      const length = num(d.length)
      return length === null ? null : count(length, 'character')
    }
    case 'duplicate-title':
    case 'duplicate-meta-description':
    case 'duplicate-content': {
      const size = num(d.groupSize)
      if (size === null || size < 2) return null
      return `same as ${count(size - 1, 'other page')}`
    }
    case 'server-error':
    case 'broken-page':
    case 'blocked-page':
    case 'rate-limited-page': {
      const status = num(d.statusCode)
      return status ? `answered ${status}` : null
    }
    case 'slow-response': {
      const ms = num(d.responseTimeMs)
      return ms === null ? null : `${(ms / 1000).toFixed(1)} s to answer`
    }
    case 'redirect-chain': {
      const hops = Array.isArray(d.hops) ? d.hops.length : 0
      const final = str(d.finalUrl)
      return hops > 1 ? `${count(hops - 1, 'redirect')}${final ? ` to ${pathOf(final)}` : ''}` : null
    }
    case 'multiple-h1': {
      const n = num(d.h1Count)
      return n === null ? null : `${n.toLocaleString()} H1 headings`
    }
    case 'thin-content':
    case 'javascript-rendering-suspected': {
      const n = num(d.wordCount)
      return n === null ? null : count(n, 'word')
    }
    case 'images-missing-alt': {
      const missing = num(d.imagesMissingAlt)
      const total = num(d.imagesTotal)
      if (missing === null) return null
      return total ? `${missing.toLocaleString()} of ${count(total, 'image')}` : count(missing, 'image')
    }
    case 'deep-page': {
      const depth = num(d.crawlDepth)
      return depth === null ? null : `${count(depth, 'click')} from the home page`
    }
    case 'canonicalized-page': {
      const url = str(d.canonicalUrl)
      return url ? `points to ${pathOf(url)}` : null
    }
    case 'crawl-page-limit':
    case 'crawl-rate-limited':
    case 'crawl-time-limit': {
      const crawled = num(d.pagesCrawled)
      const found = num(d.pagesFound)
      if (crawled === null) return null
      return found && found > crawled ? `${crawled.toLocaleString()} of ${count(found, 'page')} checked` : `${count(crawled, 'page')} checked`
    }
    default:
      return null
  }
}

/** The Pages tab's filters, as the radiogroup lists them. */
export const PAGE_FILTERS: ReadonlyArray<{ value: AuditPageFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'errors', label: 'Errors' },
  { value: 'redirects', label: 'Redirects' },
  { value: 'noindex', label: 'Not indexed' },
  { value: 'not_in_sitemap', label: 'Not in sitemap' },
]

/** A crawled page's answer as the Pages tab shows it: the code, or what stood in the way. */
export function pageStatus(page: Pick<SiteAuditPageRow, 'status_code' | 'fetch_class'>): { text: string; tone: 'ok' | 'redirect' | 'error' } {
  if (page.fetch_class === 'blocked') return { text: 'Blocked', tone: 'error' }
  if (page.fetch_class === 'rate_limited') return { text: 'Rate limited', tone: 'error' }
  const code = page.status_code
  if (page.fetch_class === 'error' || code === null) return { text: code === null ? 'Failed' : String(code), tone: 'error' }
  if (code >= 400) return { text: String(code), tone: 'error' }
  if (code >= 300) return { text: String(code), tone: 'redirect' }
  return { text: String(code), tone: 'ok' }
}

export const PAGE_STATUS_TONE: Record<'ok' | 'redirect' | 'error', string> = {
  ok: 'text-muted-foreground',
  redirect: 'text-sky-700 dark:text-sky-400',
  error: 'text-red-700 dark:text-red-400',
}

/** The page budgets the start dialog offers (held to the route's bounds). */
export const PAGE_PRESETS: readonly number[] = [50, 100, 250, 500, 1000]
