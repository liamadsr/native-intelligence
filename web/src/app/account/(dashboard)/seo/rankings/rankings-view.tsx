'use client'

/**
 * SEO's Rankings page: the workspace's rank trackers, and one tracker opened
 * as a card place (./tracker-detail.tsx). Drawn by the page card
 * (components/chat-cards/pages/seo-rankings-card.tsx), which keeps where the
 * person is: moves inside the page are card places, never the router.
 *
 *   First run  no trackers yet: what tracking does, and New tracker. With
 *              lookups off, the "not set up / paid plan" notice instead.
 *   Index      a row per tracker, newest first: the site, its keywords,
 *              market, device and schedule, and a status word while a check
 *              runs, when it is paused or its schedule was skipped. A check
 *              running anywhere puts the run rail above the list (polled
 *              every 3 s). "New tracker" opens the dialog; it waits at the
 *              cap, saying why.
 *
 * Reads: GET /api/account/seo/rank/trackers on mount and when a check ends,
 * with a request counter so a slow answer never overwrites a newer one.
 */
import * as React from 'react'
import { TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import { isLiveRankRun, type RankRunView, type RankTrackerView } from '@/lib/seo/rank/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../../views/view-header'
import { errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoDataNotice, SeoSpendLine, buyBlockedReason, useSeoData, type SeoDataState } from '../shared/data-status'
import { RunRail } from '../shared/run-rail'
import { relativeWhen } from '../ui-helpers'
import { fetchTrackers, stopCheck, type TrackerListPayload } from './api'
import { dataView, runRailLine, trackerStatus, trackerSubline } from './rank-helpers'
import { NewTrackerDialog } from './tracker-dialogs'
import { TrackerDetail } from './tracker-detail'
import { useMarkets, useRankRunPoll } from './use-rank-poll'

export interface RankingsPageProps {
  /** The tracker open (the card's place), or null for the index. */
  trackerId: string | null
  /** Its site, while the tracker itself loads. */
  trackerLabel?: string
  /** The tracker's tab (PAGE_KINDS.seo_rankings.tabs). */
  tab?: string
  onOpenTracker: (tracker: { id: string; domain: string }) => void
  onCloseTracker: () => void
  onTab: (tab: string) => void
  /** The card header's count: the trackers there are, on the index. */
  onCount?: (count: number | null) => void
}

export function RankingsPage(props: RankingsPageProps) {
  const seo = useSeoData()
  if (props.trackerId) {
    return (
      <TrackerDetail
        key={props.trackerId}
        trackerId={props.trackerId}
        label={props.trackerLabel}
        tab={props.tab}
        seo={seo}
        onTab={props.onTab}
        onBack={props.onCloseTracker}
        onCount={props.onCount}
      />
    )
  }
  return <TrackerIndex seo={seo} onOpenTracker={props.onOpenTracker} onCount={props.onCount} />
}

function TrackerIndex({ seo, onOpenTracker, onCount }: { seo: SeoDataState } & Pick<RankingsPageProps, 'onOpenTracker' | 'onCount'>) {
  const markets = useMarkets()
  const [payload, setPayload] = React.useState<TrackerListPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [moreLoading, setMoreLoading] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchTrackers()
      if (ask !== asked.current) return
      setPayload(next)
    } catch {
      if (ask === asked.current) setError('Could not load your rank trackers.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const more = async () => {
    const offset = payload?.trackers.next_offset
    if (offset === null || offset === undefined) return
    const ask = ++asked.current
    setMoreLoading(true)
    try {
      const next = await fetchTrackers(offset)
      if (ask !== asked.current) return
      setPayload((p) => (p ? { ...next, trackers: { rows: [...p.trackers.rows, ...next.trackers.rows], next_offset: next.trackers.next_offset } } : next))
    } catch (err) {
      toast.error('Could not load more trackers', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setMoreLoading(false)
    }
  }

  const trackers = React.useMemo(() => payload?.trackers.rows ?? [], [payload])
  React.useEffect(() => {
    onCount?.(payload ? trackers.length : null)
  }, [onCount, payload, trackers.length])

  const live = trackers.find((t) => t.latest_run && isLiveRankRun(t.latest_run.status)) ?? null
  const liveRun = live?.latest_run ?? null
  const replaceRun = React.useCallback((run: RankRunView) => {
    setPayload((p) =>
      p ? { ...p, trackers: { ...p.trackers, rows: p.trackers.rows.map((t) => (t.id === run.tracker_id ? { ...t, latest_run: run } : t)) } } : p,
    )
  }, [])

  // The live check's progress; when it ends, the list again (its numbers are final then).
  useRankRunPoll(liveRun?.id ?? null, !!liveRun, (run) => {
    replaceRun(run)
    if (!isLiveRankRun(run.status)) {
      seo.refresh()
      void load()
    }
  })

  const stop = async () => {
    if (!liveRun) return
    setStopping(true)
    try {
      replaceRun(await stopCheck(liveRun.id))
      toast('Stopped. Positions stay as the last finished check left them.')
      seo.refresh()
      void load()
    } catch (err) {
      toast.error('Could not stop the check', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  const closeDialog = React.useCallback(() => setDialogOpen(false), [])
  const opened = React.useCallback((t: RankTrackerView) => onOpenTracker({ id: t.id, domain: t.domain }), [onOpenTracker])

  if (!payload) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader title={<PageTitle label="Rankings" as="h1" />} />
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const view = dataView(seo, payload.configured)
  const blocked = buyBlockedReason(view)
  const empty = trackers.length === 0
  const atCap = trackers.length >= payload.limits.max_trackers
  const newTitle = blocked ?? (atCap ? `A workspace can have ${payload.limits.max_trackers} rank trackers. Delete one to add another.` : 'Track where a site ranks on Google')
  const rail = liveRun ? runRailLine(liveRun) : null

  return (
    <div data-seo-index="" className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={<PageTitle label="Rankings" as="h1" />}
        actions={
          <>
            <SeoSpendLine view={view} className={empty ? undefined : 'mr-2'} />
            {/* With no trackers the first-run block carries the button. */}
            {!empty && (
              <Button size="sm" className="h-8" data-seo-new-tracker="" disabled={!!blocked || atCap} title={newTitle} onClick={() => setDialogOpen(true)}>
                New tracker
              </Button>
            )}
          </>
        }
      />
      {rail && live && (
        <RunRail verb={rail.verb} clauses={[live.domain, ...rail.clauses]} stopping={stopping} onStop={() => void stop()} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {empty ? (
          blocked && view ? (
            <SeoDataNotice view={view} what="Rank tracking" />
          ) : (
            <FirstRun onNew={() => setDialogOpen(true)} />
          )
        ) : (
          <>
            <ul className="divide-y divide-border">
              {trackers.map((tracker) => (
                <TrackerRow key={tracker.id} tracker={tracker} subline={trackerSubline(tracker, markets)} onOpen={() => opened(tracker)} />
              ))}
            </ul>
            {payload.trackers.next_offset !== null && (
              <div className="flex justify-center pt-3">
                <button
                  type="button"
                  data-seo-trackers-more=""
                  disabled={moreLoading}
                  onClick={() => void more()}
                  className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                >
                  {moreLoading ? 'Loading…' : 'Show more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <NewTrackerDialog
        open={dialogOpen}
        defaultDomain={payload.default_domain}
        limits={payload.limits}
        onClose={closeDialog}
        onCreated={opened}
        onOpenExisting={(id, domain) => onOpenTracker({ id, domain })}
        onDataOff={seo.refresh}
      />
    </div>
  )
}

function FirstRun({ onNew }: { onNew: () => void }) {
  return (
    <div data-seo-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-16 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <TrendingUp className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Track where you rank on Google</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Pick the searches you care about, and this checks where your site shows up on Google for each one, on the schedule you
          choose, and keeps the history so you can see it move. Setting a tracker up costs nothing; each check is paid for from
          this workspace’s search data.
        </p>
      </div>
      <Button size="sm" className="h-8" data-seo-new-tracker="" onClick={onNew}>
        New tracker
      </Button>
    </div>
  )
}

/** One tracker on the index: its site, what it tracks and how, and a status word when there is one. */
function TrackerRow({ tracker, subline, onOpen }: { tracker: RankTrackerView; subline: string; onOpen: () => void }) {
  const status = trackerStatus(tracker)
  const checked = relativeWhen(tracker.last_checked_at)
  return (
    <li data-seo-tracker-row={tracker.id}>
      <button type="button" onClick={onOpen} title={`Open the tracker of ${tracker.domain}`} className="group flex w-full items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground group-hover:underline">{tracker.domain}</span>
          <span data-seo-tracker-subline="" className="block truncate text-xs tabular-nums text-muted-foreground">
            {subline}
          </span>
        </span>
        {status ? (
          <span
            data-seo-tracker-status={status.word}
            title={status.title}
            className={cn('shrink-0 text-xs', status.tone === 'red' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}
          >
            {status.word}
          </span>
        ) : (
          <span data-seo-tracker-checked="" className="shrink-0 text-xs text-muted-foreground" title={tracker.last_checked_at ?? undefined}>
            {checked ? `Checked ${checked}` : 'Not checked yet'}
          </span>
        )}
      </button>
    </li>
  )
}
