'use client'

/**
 * One rank tracker (the Rankings card's `seo_rank_tracker` place): the crumb
 * back to the trackers and the site, a quiet line of how it checks, then
 *
 *   while a check runs   the run rail (polled every 3 s) with Stop, and once
 *                        what a check takes; positions keep showing the last
 *                        finished check
 *   failed               an amber banner with the reason and Check again
 *   finished with a note a neutral banner with the note
 *   skipped / spend cap  the same neutral banner, with the backend's sentence
 *   the numbers          in the top 3 / 10 / 100 and the average position on
 *                        the device chosen (a switch only when it checks
 *                        both), each with its change since the last check
 *   two tabs             Positions and History, as the card's tabs
 *
 * "Check now" is the one press that spends: when a check would cost more
 * than about $0.25 (POST estimate for this tracker), a small dialog shows the
 * figure first; otherwise the press is the request. The "…" menu adds
 * keywords, changes the schedule and devices (with the estimate before →
 * after), pauses or resumes, and deletes (ConfirmDialog).
 */
import * as React from 'react'
import { AlertTriangle, CalendarClock, MoreHorizontal, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageTitle } from '@/components/views/page-title'
import { CONFIRM_ABOVE_USD, MAX_KEYWORDS_PER_ADD, MAX_KEYWORDS_PER_TRACKER } from '@/lib/seo/rank/limits'
import {
  isLiveRankRun,
  trackerDevices,
  type RankDevice,
  type RankTrackerDetail,
  type RankTrackerTrend,
  type RankTrackerView,
} from '@/lib/seo/rank/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../../views/view-header'
import { SeoRequestError, errorCode, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { buyBlockedReason, type SeoDataState } from '../shared/data-status'
import { RunRail } from '../shared/run-rail'
import { StatTiles, type StatTile } from '../shared/stat-tiles'
import { FilterChips, TabPills } from '../shared/tab-pills'
import { count } from '../ui-helpers'
import {
  DATA_OFF_CODES,
  deleteTracker,
  estimateChange,
  fetchTracker,
  fetchTrend,
  goAheadOf,
  runningCheckOf,
  startCheck,
  stopCheck,
  updateTracker,
  type RankLimits,
  type TrackerChangeEstimate,
} from './api'
import {
  DEVICE_LABEL,
  dataView,
  averageChange,
  countChange,
  estimateSentence,
  lastTwo,
  monthlyWords,
  runRailLine,
  trackerSettingsLine,
  usdWords,
} from './rank-helpers'
import { AddKeywordsDialog, ScheduleDialog, SpendConfirmDialog } from './tracker-dialogs'
import { TrackerHistory } from './tracker-history'
import { TrackerPositions } from './tracker-positions'
import { useMarkets, useRankRunPoll } from './use-rank-poll'

export const TRACKER_TABS = ['positions', 'history'] as const

/** The keyword caps the add dialog counts against (limits.ts is client safe: the same numbers the core enforces). */
const KEYWORD_LIMITS: Pick<RankLimits, 'max_keywords_per_add' | 'max_keywords_per_tracker'> = {
  max_keywords_per_add: MAX_KEYWORDS_PER_ADD,
  max_keywords_per_tracker: MAX_KEYWORDS_PER_TRACKER,
}

const MENU_ITEM =
  'flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

type Confirming = { kind: 'check'; estimate: TrackerChangeEstimate } | { kind: 'resume'; estimate: TrackerChangeEstimate } | null

/** A failure the person can simply retry (the plan or membership couldn't be read) gets a Try again button. */
function retryAction(code: string | null, again: () => void) {
  return code === 'CHECK_FAILED' ? { action: { label: 'Try again', onClick: again } } : {}
}

export function TrackerDetail({
  trackerId,
  label,
  tab,
  seo,
  onTab,
  onBack,
  onCount,
}: {
  trackerId: string
  label?: string
  tab?: string
  seo: SeoDataState
  onTab: (tab: string) => void
  onBack: () => void
  onCount?: (count: number | null) => void
}) {
  const markets = useMarkets()
  const [detail, setDetail] = React.useState<RankTrackerDetail | null>(null)
  const [trend, setTrend] = React.useState<RankTrackerTrend[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  /** Bumped when a check ends or the keywords change: the tabs read again. */
  const [version, setVersion] = React.useState(0)
  const [device, setDevice] = React.useState<RankDevice | null>(null)
  const [keyword, setKeyword] = React.useState<{ id: string; keyword: string } | null>(null)
  const [checkEstimate, setCheckEstimate] = React.useState<TrackerChangeEstimate | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  /** A refusal that is not an error: the spend limit, lookups off. */
  const [notice, setNotice] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<Confirming>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [scheduleOpen, setScheduleOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const [pausing, setPausing] = React.useState(false)
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
      const [next, nextTrend] = await Promise.all([fetchTracker(trackerId), fetchTrend(trackerId).catch(() => null)])
      if (ask !== asked.current) return
      setDetail(next)
      setTrend(nextTrend)
    } catch (err) {
      if (ask === asked.current) setError(err instanceof SeoRequestError && err.apiError.status === 404 ? 'This tracker is no longer here.' : 'Could not load the tracker.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [trackerId])

  React.useEffect(() => {
    void load()
  }, [load])

  // What a check costs now (free maths), read ahead so Check now can answer at once.
  const keywordCount = detail?.tracker.keyword_count ?? 0
  React.useEffect(() => {
    if (!detail) return
    let alive = true
    estimateChange(trackerId)
      .then((e) => {
        if (alive) setCheckEstimate(e)
      })
      .catch(() => {
        if (alive) setCheckEstimate(null)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when what a check reads changes
  }, [trackerId, !!detail, keywordCount, detail?.tracker.devices, detail?.tracker.serp_depth])

  const tracker = detail?.tracker ?? null
  const run = tracker?.latest_run ?? null
  const live = !!run && isLiveRankRun(run.status)

  const setTracker = React.useCallback((next: RankTrackerView) => {
    setDetail((d) => (d ? { ...d, tracker: next } : d))
  }, [])

  useRankRunPoll(run?.id ?? null, live, (next) => {
    setDetail((d) => (d ? { ...d, tracker: { ...d.tracker, latest_run: next } } : d))
    if (!isLiveRankRun(next.status)) {
      seo.refresh()
      void load()
      setVersion((v) => v + 1)
    }
  })

  const view = dataView(seo, undefined)
  const blocked = buyBlockedReason(view)
  const devices = tracker ? trackerDevices(tracker.devices) : []
  const shownDevice: RankDevice = device && devices.includes(device) ? device : devices.includes('mobile') ? 'mobile' : (devices[0] ?? 'mobile')

  /** `confirmed`: only from the confirm dialog's button, which names the cost. */
  const start = async (confirmed = false) => {
    setStarting(true)
    setNotice(null)
    try {
      const next = await startCheck(trackerId, { confirmed })
      setDetail((d) => (d ? { ...d, tracker: { ...d.tracker, latest_run: next } } : d))
      setConfirming(null)
      seo.refresh()
    } catch (err) {
      const running = runningCheckOf(err)
      const code = errorCode(err)
      const goAhead = goAheadOf(err)
      // The server's figure is above the line (the keywords changed since the
      // estimate was read): show it and ask, never start on the old one.
      if (goAhead) {
        setConfirming({ kind: 'check', estimate: { before: goAhead.estimate, after: goAhead.estimate, raises_cost: false } })
        return
      }
      setConfirming(null)
      if (running) setDetail((d) => (d ? { ...d, tracker: { ...d.tracker, latest_run: running } } : d))
      else if (code === 'SPEND_LIMIT_REACHED') setNotice(errorMessage(err))
      else if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
      } else if (code === 'NO_KEYWORDS') toast(errorMessage(err))
      else toast.error('Could not start the check', { description: errorMessage(err, 'Try again in a moment.'), ...retryAction(code, () => void start(confirmed)) })
    } finally {
      setStarting(false)
    }
  }

  const checkNow = async () => {
    if (blocked || live || starting) return
    let estimate = checkEstimate
    if (!estimate) {
      setStarting(true)
      try {
        estimate = await estimateChange(trackerId)
        setCheckEstimate(estimate)
      } catch (err) {
        setStarting(false)
        toast.error('Could not work out what the check costs', { description: errorMessage(err, 'Try again in a moment.') })
        return
      }
      setStarting(false)
    }
    if (estimate.before.per_check_usd > CONFIRM_ABOVE_USD) setConfirming({ kind: 'check', estimate })
    else await start()
  }

  const stop = async () => {
    if (!run) return
    setStopping(true)
    try {
      const stopped = await stopCheck(run.id)
      setDetail((d) => (d ? { ...d, tracker: { ...d.tracker, latest_run: stopped } } : d))
      toast('Stopped. Positions stay as the last finished check left them.')
      seo.refresh()
      void load()
    } catch (err) {
      toast.error('Could not stop the check', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  /** `confirmed`: only from the confirm dialog's button, which names the monthly cost. */
  const setPaused = async (paused: boolean, confirmed = false) => {
    setPausing(true)
    try {
      setTracker(await updateTracker(trackerId, confirmed ? { paused, confirmed: true } : { paused }))
      setConfirming(null)
      toast(paused ? 'Paused. No scheduled checks until you resume it.' : 'Resumed. Scheduled checks start again.')
    } catch (err) {
      const code = errorCode(err)
      const goAhead = goAheadOf(err)
      if (goAhead && !paused) {
        // Resuming costs more than the estimate read before: show the server's figure and ask.
        setConfirming({ kind: 'resume', estimate: { before: goAhead.previous ?? goAhead.estimate, after: goAhead.estimate, raises_cost: true } })
        return
      }
      if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
      } else
        toast.error(paused ? 'Could not pause the tracker' : 'Could not resume the tracker', {
          description: errorMessage(err, 'Try again in a moment.'),
          ...retryAction(code, () => void setPaused(paused, confirmed)),
        })
      setConfirming(null)
    } finally {
      setPausing(false)
    }
  }

  const resume = async () => {
    setMenuOpen(false)
    setPausing(true)
    try {
      const estimate = await estimateChange(trackerId, { paused: false })
      if (estimate.raises_cost) {
        setConfirming({ kind: 'resume', estimate })
        setPausing(false)
        return
      }
    } catch (err) {
      setPausing(false)
      toast.error('Could not work out what resuming costs', { description: errorMessage(err, 'Try again in a moment.') })
      return
    }
    await setPaused(false)
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteTracker(trackerId)
      setConfirmDelete(false)
      toast(`Deleted the tracker of ${tracker?.domain ?? 'this site'}.`)
      onBack()
    } catch (err) {
      toast.error('Could not delete the tracker', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setDeleting(false)
    }
  }

  const keywordsChanged = React.useCallback(() => {
    void load()
    setVersion((v) => v + 1)
  }, [load])

  const domain = tracker?.domain ?? label ?? 'Tracker'
  const activeTab = tab && (TRACKER_TABS as readonly string[]).includes(tab) ? tab : TRACKER_TABS[0]
  const scheduled = tracker ? tracker.schedule.interval !== 'manual' : false
  const checkTitle =
    blocked ??
    (live
      ? 'A check is running'
      : keywordCount === 0
        ? 'Add keywords first'
        : checkEstimate
          ? `Check every keyword now. A check costs ${checkEstimate.before.per_check_usd < 0.005 ? 'less than a cent' : `about ${usdWords(checkEstimate.before.per_check_usd)}`}.`
          : 'Check every keyword now')

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PageTitle label="Rankings" onClick={onBack} />
          <h1 className="min-w-0 truncate text-sm font-semibold" title={domain}>
            {domain}
          </h1>
        </div>
      }
      actions={
        tracker ? (
          <>
            <Button
              size="sm"
              className="h-8"
              data-seo-check-now=""
              disabled={!!blocked || live || starting || keywordCount === 0}
              title={checkTitle}
              onClick={() => void checkNow()}
            >
              Check now
            </Button>
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" data-seo-tracker-menu="" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="More" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-1.5">
                <button
                  type="button"
                  data-seo-menu-add=""
                  className={MENU_ITEM}
                  onClick={() => {
                    setMenuOpen(false)
                    setAddOpen(true)
                  }}
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  Add keywords
                </button>
                <button
                  type="button"
                  data-seo-menu-schedule=""
                  className={MENU_ITEM}
                  disabled={!!blocked}
                  title={blocked ?? 'How often it checks, and on which devices'}
                  onClick={() => {
                    setMenuOpen(false)
                    setScheduleOpen(true)
                  }}
                >
                  <CalendarClock className="h-3 w-3 shrink-0" />
                  Schedule and devices
                </button>
                {tracker.paused ? (
                  <button
                    type="button"
                    data-seo-menu-resume=""
                    className={MENU_ITEM}
                    disabled={pausing || (scheduled && !!blocked)}
                    title={scheduled && blocked ? blocked : 'Start the scheduled checks again'}
                    onClick={() => void resume()}
                  >
                    <Play className="h-3 w-3 shrink-0" />
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    data-seo-menu-pause=""
                    className={MENU_ITEM}
                    disabled={pausing || !scheduled}
                    title={scheduled ? 'Stop the scheduled checks until you resume it' : 'Checked by hand: there is no schedule to pause'}
                    onClick={() => {
                      setMenuOpen(false)
                      void setPaused(true)
                    }}
                  >
                    <Pause className="h-3 w-3 shrink-0" />
                    Pause
                  </button>
                )}
                <button
                  type="button"
                  data-seo-delete=""
                  className={cn(MENU_ITEM, 'text-destructive')}
                  onClick={() => {
                    setMenuOpen(false)
                    setConfirmDelete(true)
                  }}
                >
                  <Trash2 className="h-3 w-3 shrink-0" />
                  Delete tracker
                </button>
              </PopoverContent>
            </Popover>
          </>
        ) : null
      }
    />
  )

  if (!detail || !tracker) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const summary = detail.summaries.find((s) => s.device === shownDevice) ?? null
  const neverChecked = !summary || summary.checked === 0
  const { last, previous } = lastTwo(trend?.find((t) => t.device === shownDevice)?.points)
  const depth = tracker.serp_depth
  const tile = (key: string, label: string, value: number | null, title: string, change: ReturnType<typeof countChange>): StatTile => ({
    key,
    label,
    value: neverChecked ? null : value,
    title: neverChecked ? 'After the first check' : title,
    ...(neverChecked || !change ? {} : { note: change.note, noteTone: change.tone, title: `${title} (${change.note.toLowerCase()} since the last check)` }),
  })
  const tiles: StatTile[] = [
    tile('top3', 'In the top 3', summary?.top3 ?? null, 'Keywords in the first three Google results', last && previous ? countChange(last.top3, previous.top3) : null),
    tile('top10', 'In the top 10', summary?.top10 ?? null, 'Keywords on the first page of Google', last && previous ? countChange(last.top10, previous.top10) : null),
    ...(depth > 10
      ? [tile('top100', `In the top ${Math.min(depth, 100)}`, summary?.top100 ?? null, `Keywords found in the first ${Math.min(depth, 100)} results`, last && previous ? countChange(last.top100, previous.top100) : null)]
      : []),
    {
      ...tile(
        'average',
        'Average position',
        null,
        'The average place of the keywords that were found: lower is better',
        last && previous ? averageChange(last.average_position, previous.average_position) : null,
      ),
      value: neverChecked ? null : summary?.average_position === null || summary?.average_position === undefined ? null : summary.average_position.toLocaleString(undefined, { maximumFractionDigits: 1 }),
      ...(!neverChecked && (summary?.average_position ?? null) === null ? { title: `None of the keywords is in the first ${depth} results yet` } : {}),
    },
  ]

  const banner = (text: string, data: string) => (
    <p data-seo-banner={data} className="mx-5 mb-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {text}
    </p>
  )
  const rail = run && live ? runRailLine(run) : null

  return (
    <div data-seo-tracker={tracker.id} className="flex h-full min-h-0 flex-col">
      {header}
      <p data-seo-tracker-settings="" className="-mt-1 truncate px-5 pb-2 text-xs text-muted-foreground">
        {trackerSettingsLine(tracker, markets)}
      </p>
      {rail && (
        <>
          <RunRail verb={rail.verb} clauses={rail.clauses} stopping={stopping} onStop={() => void stop()} />
          <p data-seo-run-caption="" className="mx-5 -mt-1 mb-2 text-[11px] text-muted-foreground">
            A check usually takes about an hour, sometimes two. The positions below are from the last finished check.
          </p>
        </>
      )}
      {run?.status === 'failed' && (
        <div data-seo-failed="" className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
          <p className="min-w-0 flex-1">{run.error ?? 'The last check could not finish.'}</p>
          <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" disabled={!!blocked || starting || keywordCount === 0} title={blocked ?? undefined} onClick={() => void checkNow()}>
            Check again
          </Button>
        </div>
      )}
      {run?.status === 'completed' && run.note && banner(run.note, 'note')}
      {run?.status === 'canceled' && banner('The last check was stopped. The positions are from the check before it.', 'canceled')}
      {!tracker.paused && tracker.skip_message && banner(tracker.skip_message, 'skipped')}
      {notice && banner(notice, 'notice')}

      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {devices.length > 1 && (
          <FilterChips
            className="mb-2"
            label="Device"
            options={devices.map((d) => ({ value: d, label: DEVICE_LABEL[d] }))}
            value={shownDevice}
            onChange={setDevice}
          />
        )}
        {/* No keywords: nothing to count yet, so no tiles of dashes. */}
        {keywordCount > 0 && <StatTiles tiles={tiles} className="mt-1" />}

        <TabPills
          className={keywordCount > 0 ? 'mt-5' : 'mt-1'}
          label="Tracker"
          tabs={[
            { id: 'positions', label: 'Positions', count: tracker.keyword_count },
            { id: 'history', label: 'History' },
          ]}
          value={activeTab as (typeof TRACKER_TABS)[number]}
          onChange={onTab}
        />

        <div className="mt-3">
          {activeTab === 'history' ? (
            <TrackerHistory tracker={tracker} device={shownDevice} version={version} keyword={keyword} onKeyword={setKeyword} />
          ) : (
            <TrackerPositions
              tracker={tracker}
              device={shownDevice}
              version={version}
              onOpenHistory={(row) => {
                setKeyword({ id: row.id, keyword: row.keyword })
                onTab('history')
              }}
              onAdd={() => setAddOpen(true)}
              onChanged={keywordsChanged}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next)
        }}
        title={`Delete the tracker of ${tracker.domain}?`}
        description="Its keywords and history are removed. This cannot be undone."
        busy={deleting}
        onConfirm={() => void remove()}
      />
      <SpendConfirmDialog
        open={confirming !== null}
        title={confirming?.kind === 'resume' ? `Resume ${tracker.schedule.interval} checks?` : `Check ${count(confirming?.estimate.before.keyword_count ?? keywordCount, 'keyword')} now?`}
        description={
          confirming?.kind === 'resume'
            ? `Checks start again on their own. ${estimateSentence(confirming.estimate.after) ?? ''}`.trim()
            : confirming
              ? `This check costs up to about ${usdWords(confirming.estimate.before.per_check_usd)}, paid for from this workspace’s search data. It usually takes about an hour.`
              : ''
        }
        confirmLabel={
          confirming?.kind === 'resume'
            ? `Resume, ${monthlyWords(confirming.estimate.after)}`
            : confirming
              ? `Check now, about ${usdWords(confirming.estimate.before.per_check_usd)}`
              : 'Check now'
        }
        busy={starting || pausing}
        onClose={() => setConfirming(null)}
        onConfirm={() => void (confirming?.kind === 'resume' ? setPaused(false, true) : start(true))}
      />
      <ScheduleDialog open={scheduleOpen} tracker={tracker} onClose={() => setScheduleOpen(false)} onSaved={setTracker} onDataOff={seo.refresh} />
      <AddKeywordsDialog open={addOpen} tracker={tracker} limits={KEYWORD_LIMITS} onClose={() => setAddOpen(false)} onAdded={keywordsChanged} />
    </div>
  )
}
