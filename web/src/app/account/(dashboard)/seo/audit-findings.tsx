'use client'

/**
 * An audit's Findings tab: one row per issue type, most serious first (the
 * API's order). A row opens in place to say what it means and how to fix
 * it, then the pages it is on, read on demand from
 * GET …/audits/[id]/issues?type= a page at a time.
 */
import * as React from 'react'
import { ChevronRight, CircleCheck, Loader2 } from 'lucide-react'
import type { IssueSeverity } from '@/lib/seo/audit/issues'
import type { SiteAuditIssueGroup, SiteAuditIssueRow } from '@/lib/seo/audit/view'
import { cn } from '@/lib/utils'
import { fetchAuditIssues } from './api'
import { SEVERITY_CHIP, SEVERITY_LABEL, findingsOnPages, issueDetail, pathOf } from './ui-helpers'

export function SeverityChip({ severity }: { severity: IssueSeverity }) {
  return (
    <span
      data-seo-severity={severity}
      className={cn('inline-flex w-16 shrink-0 items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-medium', SEVERITY_CHIP[severity])}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

export function AuditFindings({
  auditId,
  groups,
  live,
  ended,
  expanded,
  onToggle,
  version,
}: {
  auditId: string
  groups: SiteAuditIssueGroup[]
  /** Still running: findings arrive once every page is checked. */
  live: boolean
  /** It ran to the end: no findings means a clean site (a stopped or failed one only found none). */
  ended: boolean
  /** The issue types open, kept by the detail (a tab switch keeps them). */
  expanded: ReadonlySet<string>
  onToggle: (type: string) => void
  /** Bumped when the audit's findings change (it ended): open rows read again. */
  version: number
}) {
  if (groups.length === 0) {
    if (live) return <p className="py-10 text-center text-xs text-muted-foreground">Findings show here once every page is checked.</p>
    if (!ended) return <p data-seo-no-findings="" className="py-10 text-center text-xs text-muted-foreground">Nothing was found before it stopped.</p>
    return (
      <div data-seo-clean="" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <CircleCheck className="h-7 w-7 text-muted-foreground/60" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">No problems found</p>
          <p className="mt-1 text-sm text-muted-foreground">Every page that was checked passed.</p>
        </div>
      </div>
    )
  }
  return (
    <ul data-seo-findings="" className="divide-y divide-border">
      {groups.map((group) => (
        <FindingRow
          key={group.type}
          auditId={auditId}
          group={group}
          open={expanded.has(group.type)}
          onToggle={() => onToggle(group.type)}
          version={version}
        />
      ))}
    </ul>
  )
}

function FindingRow({
  auditId,
  group,
  open,
  onToggle,
  version,
}: {
  auditId: string
  group: SiteAuditIssueGroup
  open: boolean
  onToggle: () => void
  version: number
}) {
  const bodyId = `seo-finding-${group.type}`
  return (
    <li data-seo-finding={group.type}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="group flex w-full items-center gap-3 py-2 text-left"
      >
        <SeverityChip severity={group.severity} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground group-hover:underline" title={group.title}>
          {group.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{findingsOnPages(group.count, group.pages)}</span>
        <ChevronRight
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div id={bodyId} data-seo-finding-body={group.type} className="space-y-3 pb-4 pl-[4.75rem] pr-6">
          <div>
            <p className="text-[11px] font-medium text-foreground">What it means</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{group.explanation}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-foreground">How to fix it</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{group.how_to_fix}</p>
          </div>
          <AffectedPages auditId={auditId} type={group.type} version={version} />
        </div>
      )}
    </li>
  )
}

/** The pages one issue type is on, a page at a time. */
function AffectedPages({ auditId, type, version }: { auditId: string; type: string; version: number }) {
  const [rows, setRows] = React.useState<SiteAuditIssueRow[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setError(false)
      try {
        const page = await fetchAuditIssues(auditId, { type, offset })
        if (ask !== asked.current) return
        setRows((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
      } catch {
        if (ask === asked.current) setError(true)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [auditId, type],
  )

  React.useEffect(() => {
    void load(0)
  }, [load, version])

  if (rows.length === 0 && loading) {
    return (
      <div className="flex py-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Loading the pages" />
      </div>
    )
  }
  if (rows.length === 0 && error) {
    return (
      <p className="text-xs text-muted-foreground">
        Could not load the pages.{' '}
        <button type="button" onClick={() => void load(0)} className="text-foreground underline-offset-2 hover:underline">
          Try again
        </button>
      </p>
    )
  }
  if (rows.length === 0) return null
  return (
    <div>
      <p className="text-[11px] font-medium text-foreground">Pages</p>
      <ul data-seo-affected={type} className="mt-1 space-y-1">
        {rows.map((row) => {
          const detail = issueDetail(row)
          return (
            <li key={row.id} data-seo-affected-row={row.id} className="flex min-w-0 items-baseline gap-2 text-xs">
              <a
                href={row.page_url}
                target="_blank"
                rel="noreferrer noopener"
                title={row.page_url}
                className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
              >
                {pathOf(row.page_url)}
              </a>
              {detail && <span className="min-w-0 shrink-0 truncate tabular-nums text-muted-foreground" title={detail}>{detail}</span>}
            </li>
          )
        })}
      </ul>
      {next !== null && (
        <button
          type="button"
          data-seo-affected-more=""
          disabled={loading}
          onClick={() => void load(next)}
          className="-ml-2 mt-1.5 h-7 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Show more'}
        </button>
      )}
      {error && rows.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Could not load more pages.</p>}
    </div>
  )
}
