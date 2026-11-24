'use client'

/**
 * One site audit (the Site audit card's `seo_audit` place): the crumb back to
 * the audits and the site (in a card, its header's breadcrumb, with the menu
 * at the header's right), then
 *
 *   while it runs   the run rail (polled every 3 s; Stop keeps what it found)
 *   failed          an amber banner with the reason and Run again
 *   stopped         a quiet line: what it found is below
 *   the numbers     pages checked and findings by severity, as tiles, and one
 *                   bar of the findings' shares (hidden with none)
 *   two tabs        Findings (each issue type, opened in place) and Pages
 *                   (every crawled page, filtered), as the card's tabs
 *
 * The "…" menu runs it again (same site, same page limit) or deletes it
 * (ConfirmDialog, never window.confirm).
 */
import * as React from 'react'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PAGE_TAB_COUNT, pageTabClass } from '@/components/views/page-tabs'
import { PageTitle } from '@/components/views/page-title'
import { ISSUE_SEVERITIES, isLiveAudit, type SiteAuditDetail, type SiteAuditView } from '@/lib/seo/audit/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../views/view-header'
import { SeoRequestError, cancelAudit, deleteAudit, errorMessage, fetchAuditDetail, runningAuditOf, startAudit } from './api'
import { AuditFindings } from './audit-findings'
import { AuditPages } from './audit-pages'
import { AuditRunRail } from './audit-run-rail'
import { CenteredError, CenteredLoader } from './load-states'
import { SeoHeaderMore, SeoPlaceLabel, useInCard } from './shared/header-controls'
import { SEVERITY_BAR, count, severityCountLabel } from './ui-helpers'
import { useAuditPoll } from './use-audit-poll'

export const AUDIT_TABS = ['findings', 'pages'] as const

export function AuditDetail({
  auditId,
  label,
  tab,
  onTab,
  onBack,
  onOpenAudit,
  onCount,
}: {
  auditId: string
  label?: string
  tab?: string
  onTab: (tab: string) => void
  onBack: () => void
  onOpenAudit: (audit: Pick<SiteAuditView, 'id' | 'host'>) => void
  onCount?: (count: number | null) => void
}) {
  const inCard = useInCard()
  const [detail, setDetail] = React.useState<SiteAuditDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  /** Bumped when the audit ends: the open lists read again. */
  const [version, setVersion] = React.useState(0)
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [stopping, setStopping] = React.useState(false)
  const [rerunning, setRerunning] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const asked = React.useRef(0)

  React.useEffect(() => {
    onCount?.(null)
  }, [onCount])

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchAuditDetail(auditId)
      if (ask !== asked.current) return
      setDetail(next)
    } catch (err) {
      if (ask === asked.current) setError(err instanceof SeoRequestError && err.apiError.status === 404 ? 'This audit is no longer here.' : 'Could not load the audit.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [auditId])

  React.useEffect(() => {
    void load()
  }, [load])

  const audit = detail?.audit ?? null
  const live = !!audit && isLiveAudit(audit.status)

  useAuditPoll(auditId, live, (next) => {
    setDetail(next)
    if (!isLiveAudit(next.audit.status)) setVersion((v) => v + 1)
  })

  const stop = async () => {
    setStopping(true)
    try {
      const stopped = await cancelAudit(auditId)
      setDetail((d) => (d ? { ...d, audit: stopped } : d))
      toast('Stopped. What it found is kept.')
      await load()
      setVersion((v) => v + 1)
    } catch (err) {
      toast.error('Could not stop the audit', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  const runAgain = async () => {
    if (!audit) return
    setMenuOpen(false)
    setRerunning(true)
    try {
      onOpenAudit(await startAudit({ url: audit.start_url, maxPages: audit.max_pages }))
    } catch (err) {
      const running = runningAuditOf(err)
      if (running) onOpenAudit(running)
      else toast.error('Could not start the audit', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRerunning(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteAudit(auditId)
      setConfirmDelete(false)
      toast(`Deleted the audit of ${audit?.host ?? 'this site'}.`)
      onBack()
    } catch (err) {
      toast.error('Could not delete the audit', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setDeleting(false)
    }
  }

  const host = audit?.host ?? label ?? 'Audit'
  const activeTab = tab && (AUDIT_TABS as readonly string[]).includes(tab) ? tab : AUDIT_TABS[0]
  const toggle = React.useCallback((type: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PageTitle label="Site audit" onClick={onBack} />
          <h1 className="min-w-0 truncate text-sm font-semibold" title={host}>
            {host}
          </h1>
        </div>
      }
      // In a card the site is the header's breadcrumb, "Site audit › example.com",
      // the title the way back, and the menu its right end (Liam, 11-22: "the
      // back button should just be the breadcrum").
      place={{ label: <SeoPlaceLabel name={host} />, onBack, backLabel: 'Back to site audits' }}
      actions={
        audit ? (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <SeoHeaderMore data-seo-audit-menu="" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1.5">
              <button
                type="button"
                data-seo-run-again=""
                disabled={live || rerunning}
                title={live ? 'It is still running' : `Check ${audit.host} again, up to ${count(audit.max_pages, 'page')}`}
                onClick={() => void runAgain()}
                className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <RotateCcw className="h-3 w-3 shrink-0" />
                Run again
              </button>
              <button
                type="button"
                data-seo-delete=""
                disabled={live}
                title={live ? 'Stop it before deleting it' : undefined}
                onClick={() => {
                  setMenuOpen(false)
                  setConfirmDelete(true)
                }}
                className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <Trash2 className="h-3 w-3 shrink-0" />
                Delete audit
              </button>
            </PopoverContent>
          </Popover>
        ) : null
      }
    />
  )

  if (!detail || !audit) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', inCard && 'pt-2')}>
        {header}
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const total = audit.counts.critical + audit.counts.warning + audit.counts.info
  // An audit that ended having checked nothing (it failed at the start) has nothing to show below its banner.
  const nothing = !live && audit.pages_crawled === 0 && detail.issues.length === 0
  return (
    <div data-seo-detail={audit.id} data-seo-status={audit.status} className={cn('flex h-full min-h-0 flex-col', inCard && 'pt-2')}>
      {header}
      {live && <AuditRunRail audit={audit} stopping={stopping} onStop={() => void stop()} />}
      {audit.status === 'failed' && (
        <div data-seo-failed="" className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
          <p className="min-w-0 flex-1">{audit.error ?? 'The audit could not finish.'}</p>
          <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" disabled={rerunning} onClick={() => void runAgain()}>
            Run again
          </Button>
        </div>
      )}
      {audit.status === 'canceled' && (
        <p data-seo-canceled="" className="mx-5 mb-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {nothing ? 'Stopped before any page was checked.' : 'Stopped early. What it found is below.'}
        </p>
      )}
      {!nothing && (
        <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <div className="mt-1 grid grid-cols-2 gap-3 @md:grid-cols-4">
            {[
              { key: 'pages', label: 'Pages checked', value: audit.pages_crawled, known: true },
              // The findings are counted once every page is checked: unknown until then, not zero.
              { key: 'critical', label: 'Critical', value: audit.counts.critical, known: !live },
              { key: 'warning', label: 'Warnings', value: audit.counts.warning, known: !live },
              { key: 'info', label: 'Info', value: audit.counts.info, known: !live },
            ].map((s) => (
              <div key={s.key} data-seo-tile={s.key} className="min-w-0 rounded-lg border px-3 py-2.5">
                <p className="text-lg font-semibold break-words tabular-nums" title={s.known ? undefined : 'Counted once every page is checked'}>
                  {s.known ? s.value.toLocaleString() : '—'}
                </p>
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
          {total > 0 && <SeverityBar counts={audit.counts} total={total} />}

          <div role="tablist" aria-label="Audit" className="mt-5 flex items-center gap-1">
            <TabPill active={activeTab === 'findings'} count={detail.issues.length} onClick={() => onTab('findings')} tab="findings">
              Findings
            </TabPill>
            <TabPill active={activeTab === 'pages'} count={audit.pages_crawled} onClick={() => onTab('pages')} tab="pages">
              Pages
            </TabPill>
          </div>

          <div className="mt-3">
            {activeTab === 'pages' ? (
              <AuditPages auditId={audit.id} version={version} />
            ) : (
              <AuditFindings
                auditId={audit.id}
                groups={detail.issues}
                live={live}
                ended={audit.status === 'completed'}
                expanded={expanded}
                onToggle={toggle}
                version={version}
              />
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next)
        }}
        title={`Delete the audit of ${audit.host}?`}
        description="Its pages and findings are removed. This cannot be undone."
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** The findings' shares, one stacked bar (side-panels/context-section.tsx's look). */
function SeverityBar({ counts, total }: { counts: SiteAuditView['counts']; total: number }) {
  const label = ISSUE_SEVERITIES.filter((s) => counts[s] > 0)
    .map((s) => severityCountLabel(s, counts[s]))
    .join(', ')
  return (
    <div role="img" aria-label={`Findings: ${label}`} data-seo-bar="" className="mt-3 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
      {ISSUE_SEVERITIES.map((s) =>
        counts[s] > 0 ? (
          <span key={s} data-seo-bar-segment={s} className={cn('h-full shrink-0', SEVERITY_BAR[s])} style={{ width: `${(counts[s] / total) * 100}%`, minWidth: 2 }} />
        ) : null,
      )}
    </div>
  )
}

/**
 * One pill in the tab strip: every page's tab pill (components/views/page-tabs.tsx;
 * Liam, 11-23: "everything looks the same as the projects page").
 */
function TabPill({
  active,
  count: n,
  onClick,
  tab,
  children,
}: {
  active: boolean
  count?: number
  onClick: () => void
  tab: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={active}
      data-seo-tab={tab}
      className={pageTabClass(active)}
    >
      {children}
      {n !== undefined && n > 0 && <span className={PAGE_TAB_COUNT}>{n.toLocaleString()}</span>}
    </button>
  )
}
