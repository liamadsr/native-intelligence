'use client'

/**
 * SEO's Site audit page: the workspace's audits, and one audit opened as a
 * card place (./audit-detail.tsx). Drawn by the page card
 * (components/chat-cards/pages/seo-audit-card.tsx), which keeps where the
 * person is: moves inside the page are card places, never the router.
 *
 *   First run  no audits yet: what an audit does, and the address field
 *              (prefilled with the workspace's own site) with Start audit.
 *   Index      a row per audit, newest first: the site, its pages and when,
 *              its findings by severity (or its status while it isn't done).
 *              A live audit's run rail sits above the list, polled every 3 s.
 *              "New audit" opens the start dialog; it waits, saying why,
 *              while an audit runs (one at a time per workspace).
 *
 * Reads: GET /api/account/seo/audits on mount and when an audit ends, with
 * a request counter so a slow answer never overwrites a newer one.
 */
import * as React from 'react'
import { ScanSearch } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import { ISSUE_SEVERITIES, isLiveAudit, type SiteAuditView } from '@/lib/seo/audit/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../views/view-header'
import { cancelAudit, errorMessage, fetchAudits, type AuditListPayload } from './api'
import { AuditDetail } from './audit-detail'
import { AuditRunRail } from './audit-run-rail'
import { CenteredError, CenteredLoader } from './load-states'
import { InlineStartForm, StartAuditDialog } from './start-audit'
import { SEVERITY_CHIP, STATUS_WORD, count, relativeWhen, severityCountLabel } from './ui-helpers'
import { useAuditPoll } from './use-audit-poll'

export interface SiteAuditViewProps {
  /** The audit open (the card's place), or null for the index. */
  auditId: string | null
  /** Its site, while the audit itself loads. */
  auditLabel?: string
  /** The audit's tab (PAGE_KINDS.seo_audit.tabs). */
  tab?: string
  onOpenAudit: (audit: Pick<SiteAuditView, 'id' | 'host'>) => void
  onCloseAudit: () => void
  onTab: (tab: string) => void
  /** The card header's count: the audits there are, on the index. */
  onCount?: (count: number | null) => void
}

export function SiteAuditPage(props: SiteAuditViewProps) {
  if (props.auditId) {
    return (
      <AuditDetail
        key={props.auditId}
        auditId={props.auditId}
        label={props.auditLabel}
        tab={props.tab}
        onTab={props.onTab}
        onBack={props.onCloseAudit}
        onOpenAudit={props.onOpenAudit}
        onCount={props.onCount}
      />
    )
  }
  return <AuditIndex onOpenAudit={props.onOpenAudit} onCount={props.onCount} />
}

function AuditIndex({ onOpenAudit, onCount }: Pick<SiteAuditViewProps, 'onOpenAudit' | 'onCount'>) {
  const [payload, setPayload] = React.useState<AuditListPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchAudits()
      if (ask !== asked.current) return
      setPayload(next)
    } catch {
      if (ask === asked.current) setError('Could not load your audits.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const audits = React.useMemo(() => payload?.audits ?? [], [payload])
  React.useEffect(() => {
    onCount?.(payload ? audits.length : null)
  }, [onCount, payload, audits.length])

  const live = audits.find((a) => isLiveAudit(a.status)) ?? null
  const replace = React.useCallback((audit: SiteAuditView) => {
    setPayload((p) => (p ? { ...p, audits: p.audits.map((a) => (a.id === audit.id ? audit : a)) } : p))
  }, [])

  // The live audit's progress; when it ends, the list again (its counts are final then).
  useAuditPoll(live?.id ?? null, !!live, (detail) => {
    replace(detail.audit)
    if (!isLiveAudit(detail.audit.status)) void load()
  })

  const stop = async () => {
    if (!live) return
    setStopping(true)
    try {
      replace(await cancelAudit(live.id))
      toast('Stopped. What it found is kept.')
      void load()
    } catch (err) {
      toast.error('Could not stop the audit', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  const opened = React.useCallback((audit: SiteAuditView) => onOpenAudit(audit), [onOpenAudit])
  const closeDialog = React.useCallback(() => setDialogOpen(false), [])

  if (!payload) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader title={<PageTitle label="Site audit" as="h1" />} />
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const empty = audits.length === 0
  return (
    <div data-seo-index="" className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={<PageTitle label="Site audit" as="h1" />}
        actions={
          empty ? null : (
            <Button
              size="sm"
              className="h-8"
              data-seo-new-audit=""
              disabled={!!live}
              title={live ? `An audit of ${live.host} is running. One runs at a time.` : 'Check a website for search problems'}
              onClick={() => setDialogOpen(true)}
            >
              New audit
            </Button>
          )
        }
      />
      {live && <AuditRunRail audit={live} stopping={stopping} onStop={() => void stop()} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {empty ? (
          <FirstRun defaultUrl={payload.default_url} payload={payload} onStarted={opened} onRunning={opened} />
        ) : (
          <ul className="divide-y divide-border">
            {audits.map((audit) => (
              <AuditRow key={audit.id} audit={audit} onOpen={() => onOpenAudit(audit)} />
            ))}
          </ul>
        )}
      </div>
      <StartAuditDialog
        open={dialogOpen}
        defaultUrl={payload.default_url}
        limits={payload.limits}
        onClose={closeDialog}
        onStarted={opened}
        onRunning={opened}
      />
    </div>
  )
}

function FirstRun({
  defaultUrl,
  payload,
  onStarted,
  onRunning,
}: {
  defaultUrl: string | null
  payload: AuditListPayload
  onStarted: (audit: SiteAuditView) => void
  onRunning: (audit: SiteAuditView) => void
}) {
  return (
    <div data-seo-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-16 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <ScanSearch className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Check your website for search problems</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The audit reads your site the way a search engine does, about one page a second, and lists what to fix:
          broken links, missing titles and descriptions, and pages search engines are told to skip. It takes a few
          minutes and costs nothing.
        </p>
      </div>
      <InlineStartForm defaultUrl={defaultUrl} limits={payload.limits} onStarted={onStarted} onRunning={onRunning} />
    </div>
  )
}

/** One audit on the index: its site, pages and when, and its findings by severity (or its status). */
function AuditRow({ audit, onOpen }: { audit: SiteAuditView; onOpen: () => void }) {
  const status = STATUS_WORD[audit.status]
  const chips = ISSUE_SEVERITIES.filter((s) => audit.counts[s] > 0)
  const when = relativeWhen(audit.completed_at ?? audit.started_at ?? audit.created_at)
  return (
    <li data-seo-audit-row={audit.id}>
      <button type="button" onClick={onOpen} title={`Open the audit of ${audit.host}`} className="group flex w-full items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground group-hover:underline">{audit.host}</span>
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {[audit.pages_crawled > 0 ? count(audit.pages_crawled, 'page') : null, when || null].filter(Boolean).join(' · ')}
          </span>
        </span>
        {status ? (
          <span
            data-seo-audit-status={audit.status}
            className={cn('shrink-0 text-xs', audit.status === 'failed' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}
          >
            {status}
          </span>
        ) : null}
        {chips.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {chips.map((s) => (
              <span
                key={s}
                data-seo-count={s}
                className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums whitespace-nowrap', SEVERITY_CHIP[s])}
              >
                {severityCountLabel(s, audit.counts[s])}
              </span>
            ))}
          </span>
        ) : (
          audit.status === 'completed' && <span className="shrink-0 text-xs text-muted-foreground">No problems</span>
        )}
      </button>
    </li>
  )
}
