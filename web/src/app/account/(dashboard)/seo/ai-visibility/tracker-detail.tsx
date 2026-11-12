'use client'

/**
 * One AI visibility tracker (the card's `seo_ai_tracker` place): the crumb
 * back to the trackers and the brand, a quiet line of what it asks and how
 * often, then
 *
 *   while a check runs   the run rail ("Asking the assistants · 18 of 30
 *                        answers in") with Stop, polled at the route's pace,
 *                        and once a caption that answers take minutes
 *   failed               an amber banner with the reason and Check again
 *   stopped, late, skip  a neutral banner with the plain sentence
 *   spend cap, data off  the same neutral banner, the route's own words
 *   the numbers          the latest finished check: answers that name you,
 *                        answers that cite your site, assistants, questions;
 *                        each rate's change only when the trend says the two
 *                        periods compare fairly
 *   three tabs           Results, Questions and Sources, as the card's tabs
 *
 * "Check now" is the one press here that spends. When the tracker's
 * estimate says a check needs a yes (or the route answers
 * CONFIRMATION_REQUIRED), a small dialog shows the estimate first and the
 * yes is sent with `confirmed`. The "…" menu edits the tracker (through the
 * same confirmation when its cost rises), pauses or resumes it, downloads
 * the latest finished check's answers as a CSV, and deletes it
 * (ConfirmDialog). Resuming turns the schedule on, which the route holds
 * (409 CONFIRMATION_REQUIRED, even with no questions yet) until the person
 * pressed the button that names its cost in the same dialog (what the
 * schedule costs now and after). Lookups off (a guest, the free plan) is the
 * neutral banner; a check that could not run just now (CHECK_FAILED) is an
 * ordinary failure with Try again, which asks afresh.
 */
import * as React from 'react'
import { AlertTriangle, Download, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageTitle } from '@/components/views/page-title'
import { DEFAULT_TREND_DAYS } from '@/lib/seo/ai-visibility/limits'
import { isLiveRun, type AiCostEstimate, type AiRunView, type AiTrackerSummary, type AiTrend } from '@/lib/seo/ai-visibility/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../../views/view-header'
import { SeoRequestError, errorCode, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { buyBlockedReason, type SeoDataState } from '../shared/data-status'
import { RunRail } from '../shared/run-rail'
import { StatTiles, type StatTile } from '../shared/stat-tiles'
import { TabPills } from '../shared/tab-pills'
import { count } from '../ui-helpers'
import { aboutUsd, comparisonReason, engineList, estimateSentence, monthlyWords, pct, pointsChange, runRailLine, trackerSettingsLine } from './ai-helpers'
import {
  DATA_OFF_CODES,
  type AiConfirmation,
  confirmationOf,
  deleteTracker,
  downloadRunCsv,
  fetchEstimate,
  fetchTracker,
  fetchTrend,
  runningCheckOf,
  startCheck,
  stopCheck,
  updateTracker,
} from './api'
import { QuestionsTab } from './questions-tab'
import { ResultsTab } from './results-tab'
import { SourcesTab } from './sources-tab'
import { SpendConfirmDialog, TrackerFormDialog, retryAction } from './tracker-dialogs'
import { useAiRunPoll } from './use-ai-poll'

export const TRACKER_TABS = ['results', 'prompts', 'sources'] as const
type TrackerTab = (typeof TRACKER_TABS)[number]

const MENU_ITEM =
  'flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

/** A check: the estimate first. Resume: the route's 409 with what the schedule costs now and after. */
type Confirming = { kind: 'check'; estimate: AiCostEstimate | null; message?: string } | { kind: 'resume'; confirmation: AiConfirmation } | null

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
  const [summary, setSummary] = React.useState<AiTrackerSummary | null>(null)
  const [trend, setTrend] = React.useState<AiTrend | null>(null)
  const [trendDays, setTrendDays] = React.useState<number>(DEFAULT_TREND_DAYS)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  /** Bumped when a check ends or the questions change: the tabs read again. */
  const [version, setVersion] = React.useState(0)
  const [starting, setStarting] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  /** A refusal that is not an error: the spend limit, lookups off. */
  const [notice, setNotice] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<Confirming>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [pausing, setPausing] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const asked = React.useRef(0)
  const trendAsked = React.useRef(0)

  React.useEffect(() => {
    onCount?.(null)
  }, [onCount])

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchTracker(trackerId)
      if (ask !== asked.current) return
      setSummary(next)
    } catch (err) {
      if (ask === asked.current) setError(err instanceof SeoRequestError && err.apiError.status === 404 ? 'This tracker is no longer here.' : 'Could not load the tracker.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [trackerId])

  React.useEffect(() => {
    void load()
  }, [load])

  // The trend (free): the chart, and whether the tiles may show a change.
  React.useEffect(() => {
    const ask = ++trendAsked.current
    fetchTrend(trackerId, trendDays)
      .then((t) => {
        if (ask === trendAsked.current) setTrend(t)
      })
      .catch(() => {
        if (ask === trendAsked.current) setTrend(null)
      })
  }, [trackerId, trendDays, version])

  const tracker = summary?.tracker ?? null
  const liveRun = summary?.live_run && isLiveRun(summary.live_run.status) ? summary.live_run : null
  const live = !!liveRun
  const setLiveRun = React.useCallback((run: AiRunView | null) => {
    setSummary((s) => (s ? { ...s, live_run: run } : s))
  }, [])

  useAiRunPoll(liveRun, live, (results) => {
    setLiveRun(results.run)
    if (!isLiveRun(results.run.status)) {
      seo.refresh()
      void load()
      setVersion((v) => v + 1)
    }
  })

  const blocked = buyBlockedReason(seo.view)
  const activeCount = summary?.prompts.filter((p) => p.active).length ?? 0

  const start = async (confirmed: boolean) => {
    setStarting(true)
    setNotice(null)
    try {
      const run = await startCheck(trackerId, confirmed)
      setLiveRun(run)
      setConfirming(null)
      seo.refresh()
    } catch (err) {
      const asking = confirmationOf(err)
      const running = runningCheckOf(err)
      const code = errorCode(err)
      if (asking) {
        setConfirming({ kind: 'check', estimate: asking.estimate, message: asking.message })
        return
      }
      setConfirming(null)
      if (running) setLiveRun(running)
      else if (code === 'SPEND_LIMIT_REACHED') setNotice(errorMessage(err))
      else if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
      } else if (code === 'NO_PROMPTS') toast(errorMessage(err))
      // Try again starts over (the cost is shown again if the route asks), never a yes nobody gave.
      else toast.error('Could not start the check', { description: errorMessage(err, 'Try again in a moment.'), ...retryAction(code, () => void checkNow()) })
    } finally {
      setStarting(false)
    }
  }

  const checkNow = async () => {
    if (blocked || live || starting || !summary) return
    if (!summary.estimate.needs_confirmation) {
      await start(false)
      return
    }
    // Above the threshold: the estimate first, read fresh.
    setStarting(true)
    try {
      const estimate = await fetchEstimate({ tracker_id: trackerId })
      setConfirming({ kind: 'check', estimate })
    } catch (err) {
      toast.error('Could not work out what the check costs', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    if (!liveRun) return
    setStopping(true)
    try {
      setLiveRun(await stopCheck(liveRun.id))
      toast('Stopped. The answers already in are kept.')
      seo.refresh()
      void load()
      setVersion((v) => v + 1)
    } catch (err) {
      toast.error('Could not stop the check', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  /** Pause, or resume: resuming turns the schedule on, which the route holds (409) until the person said yes to its cost. */
  const setPaused = async (paused: boolean, confirmed = false) => {
    setPausing(true)
    setNotice(null)
    try {
      const out = await updateTracker(trackerId, { paused, ...(confirmed ? { confirmed: true } : {}) })
      setSummary((s) => (s ? { ...s, tracker: out.tracker, estimate: out.estimate } : s))
      setConfirming(null)
      toast(paused ? 'Paused. No scheduled checks until you resume it.' : 'Resumed. Scheduled checks start again.')
    } catch (err) {
      const asking = confirmationOf(err)
      const code = errorCode(err)
      if (asking && !paused) {
        setConfirming({ kind: 'resume', confirmation: asking })
        return
      }
      setConfirming(null)
      if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
      } else
        toast.error(paused ? 'Could not pause the tracker' : 'Could not resume the tracker', {
          description: errorMessage(err, 'Try again in a moment.'),
          // Try again asks afresh: the cost is shown again before any yes is sent.
          ...retryAction(code, () => void setPaused(paused)),
        })
    } finally {
      setPausing(false)
    }
  }

  const latestDone = summary?.latest_results?.run ?? summary?.recent_runs.find((r) => r.status === 'completed') ?? null

  const exportCsv = async () => {
    if (!latestDone) return
    setMenuOpen(false)
    setExporting(true)
    try {
      await downloadRunCsv(latestDone.id)
    } catch (err) {
      toast.error('Could not download the answers', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setExporting(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteTracker(trackerId)
      setConfirmDelete(false)
      toast(`Deleted the tracker of ${tracker?.brand_name ?? 'this brand'}.`)
      onBack()
    } catch (err) {
      toast.error('Could not delete the tracker', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setDeleting(false)
    }
  }

  const changed = React.useCallback(() => {
    void load()
    setVersion((v) => v + 1)
  }, [load])

  const brand = tracker?.brand_name ?? label ?? 'Tracker'
  const activeTab: TrackerTab = tab && (TRACKER_TABS as readonly string[]).includes(tab) ? (tab as TrackerTab) : TRACKER_TABS[0]
  const scheduled = tracker ? tracker.schedule_interval !== 'off' : false
  const checkTitle =
    blocked ??
    (live
      ? 'A check is running'
      : activeCount === 0
        ? 'Add questions first'
        : summary
          ? `Ask every assistant every question now. A check costs ${aboutUsd(summary.estimate.run_usd)}.`
          : 'Ask every assistant every question now')

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PageTitle label="AI visibility" onClick={onBack} />
          <h1 className="min-w-0 truncate text-sm font-semibold" title={brand}>
            {brand}
          </h1>
        </div>
      }
      actions={
        tracker ? (
          <>
            <Button size="sm" className="h-8" data-seo-check-now="" disabled={!!blocked || live || starting || activeCount === 0} title={checkTitle} onClick={() => void checkNow()}>
              Check now
            </Button>
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" data-seo-tracker-menu="" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="More" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1.5">
                <button
                  type="button"
                  data-seo-menu-edit=""
                  className={MENU_ITEM}
                  onClick={() => {
                    setMenuOpen(false)
                    setEditOpen(true)
                  }}
                >
                  <Pencil className="h-3 w-3 shrink-0" />
                  Edit tracker
                </button>
                {tracker.paused ? (
                  <button
                    type="button"
                    data-seo-menu-resume=""
                    className={MENU_ITEM}
                    disabled={pausing || (scheduled && !!blocked)}
                    title={scheduled && blocked ? blocked : 'Start the scheduled checks again'}
                    onClick={() => {
                      setMenuOpen(false)
                      void setPaused(false)
                    }}
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
                  data-seo-menu-export=""
                  className={MENU_ITEM}
                  disabled={!latestDone || exporting}
                  title={latestDone ? 'Every answer of the latest finished check, as a spreadsheet file' : 'After the first check'}
                  onClick={() => void exportCsv()}
                >
                  <Download className="h-3 w-3 shrink-0" />
                  Download answers (CSV)
                </button>
                <button
                  type="button"
                  data-seo-delete=""
                  className={cn(MENU_ITEM, 'text-destructive')}
                  disabled={live}
                  title={live ? 'Stop the check before deleting the tracker' : undefined}
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

  if (!summary || !tracker) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const results = summary.latest_results
  const own = results?.brands.find((b) => b.own) ?? null
  const done = results?.run ?? null
  const reason = trend ? comparisonReason(trend.comparison, trend.days) : null
  const rateTile = (key: string, label: string, value: number | null, explain: string, change: number | null): StatTile => {
    if (!done) return { key, label, value: null, title: 'After the first check', note: 'After the first check', noteTone: 'flat' }
    const shown = pct(value)
    const note = trend && trend.comparison === 'comparable' ? pointsChange(change) : null
    return {
      key,
      label,
      value: shown,
      title: shown === null ? 'No answers came back for these questions' : note ? `${explain} (${note.note.toLowerCase()} on the ${trend!.days} days before)` : reason ? `${explain}. ${reason}` : explain,
      ...(note ? { note: note.note, noteTone: note.tone } : {}),
    }
  }
  const tiles: StatTile[] = [
    rateTile('named', 'Answers that name you', own?.mention_rate ?? null, 'Of the answers to questions without your name in them, the share that names you', trend?.mentions.change ?? null),
    rateTile('cited', 'Answers that cite your site', own?.citation_rate ?? null, 'Of those answers, the share that links to your website', trend?.citations.change ?? null),
    done
      ? { key: 'engines', label: 'Assistants checked', value: done.engines.length, title: engineList(done.engines) }
      : { key: 'engines', label: 'Assistants checked', value: null, title: 'After the first check', note: 'After the first check', noteTone: 'flat' },
    done
      ? { key: 'questions', label: 'Questions asked', value: Math.round(done.answers_total / Math.max(1, done.engines.length)) }
      : { key: 'questions', label: 'Questions asked', value: null, title: 'After the first check', note: 'After the first check', noteTone: 'flat' },
  ]

  const newest = summary.recent_runs[0] ?? null
  const banner = (text: string, data: string) => (
    <p data-seo-banner={data} className="mx-5 mb-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {text}
    </p>
  )
  const rail = liveRun ? runRailLine(liveRun) : null
  const completedCount = summary.recent_runs.filter((r) => r.status === 'completed').length

  return (
    <div data-seo-tracker={tracker.id} className="flex h-full min-h-0 flex-col">
      {header}
      <p data-seo-tracker-settings="" className="-mt-1 truncate px-5 pb-2 text-xs text-muted-foreground">
        {trackerSettingsLine(tracker)}
      </p>
      {rail && (
        <>
          <RunRail verb={rail.verb} clauses={rail.clauses} stopping={stopping} onStop={() => void stop()} />
          <p data-seo-run-caption="" className="mx-5 -mt-1 mb-2 text-[11px] text-muted-foreground">
            Some assistants take several minutes to answer.{done ? ' The results below are from the last finished check.' : ''}
          </p>
        </>
      )}
      {!live && newest?.status === 'failed' && (
        <div data-seo-failed="" className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
          <p className="min-w-0 flex-1">{newest.error ?? 'The last check could not finish.'}</p>
          <Button
            variant="ghost"
            size="sm"
            data-seo-check-again=""
            className="-my-1 h-7 shrink-0 text-xs"
            disabled={!!blocked || starting || activeCount === 0}
            title={blocked ?? undefined}
            onClick={() => void checkNow()}
          >
            Check again
          </Button>
        </div>
      )}
      {!live && newest?.status === 'canceled' && banner(done ? 'The last check was stopped. The results below are from the check before it.' : 'The last check was stopped before it finished.', 'canceled')}
      {!live && newest?.status === 'completed' && newest.answers_late > 0 &&
        banner(`${count(newest.answers_late, 'answer')} came in after the check finished. ${newest.answers_late === 1 ? 'It is' : 'They are'} counted below, marked late.`, 'late')}
      {!tracker.paused && tracker.last_skip_message && banner(tracker.last_skip_message, 'skipped')}
      {notice && banner(notice, 'notice')}

      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <StatTiles tiles={tiles} className="mt-1" />

        <TabPills
          className="mt-5"
          label="Tracker"
          tabs={[
            { id: 'results', label: 'Results' },
            { id: 'prompts', label: 'Questions', count: summary.prompts.length },
            { id: 'sources', label: 'Sources' },
          ]}
          value={activeTab}
          onChange={onTab}
        />

        <div className="mt-3">
          {activeTab === 'prompts' ? (
            <QuestionsTab
              tracker={tracker}
              prompts={summary.prompts}
              latestRun={done}
              version={version}
              buyBlocked={blocked}
              onChanged={changed}
              onDataOff={seo.refresh}
              onSpent={seo.refresh}
            />
          ) : activeTab === 'sources' ? (
            <SourcesTab trackerId={tracker.id} runId={done?.id ?? null} version={version} />
          ) : (
            <ResultsTab
              tracker={tracker}
              run={done}
              version={version}
              trend={completedCount >= 2 ? trend : null}
              trendDays={trendDays}
              onTrendDays={setTrendDays}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next)
        }}
        title={`Delete the tracker of ${tracker.brand_name}?`}
        description="Its questions, checks and answers are removed. This cannot be undone."
        busy={deleting}
        onConfirm={() => void remove()}
      />
      <SpendConfirmDialog
        open={confirming !== null}
        title={confirming?.kind === 'resume' ? `Resume ${tracker.schedule_interval} checks?` : `Ask ${count(activeCount, 'question')} now?`}
        description={
          confirming?.kind === 'resume'
            ? 'Checks start again on their own, paid for from this workspace’s search data.'
            : confirming
              ? `${confirming.estimate ? (estimateSentence({ ...confirming.estimate, schedule_interval: 'off' }) ?? confirming.message ?? '') : (confirming.message ?? '')} It is paid for from this workspace’s search data, and the answers come in over several minutes.`.trim()
              : ''
        }
        confirmation={confirming?.kind === 'resume' ? confirming.confirmation : null}
        confirmLabel={
          confirming?.kind === 'resume'
            ? confirming.confirmation.estimate
              ? `Resume, ${monthlyWords(confirming.confirmation.estimate)}`
              : 'Resume and confirm'
            : confirming?.estimate
              ? `Check now, ${aboutUsd(confirming.estimate.run_usd)}`
              : 'Check now'
        }
        busy={starting || pausing}
        onClose={() => setConfirming(null)}
        onConfirm={() => void (confirming?.kind === 'resume' ? setPaused(false, true) : start(true))}
      />
      <TrackerFormDialog
        open={editOpen}
        tracker={tracker}
        scheduleBlocked={blocked}
        onClose={() => setEditOpen(false)}
        onSaved={() => changed()}
        onDataOff={seo.refresh}
      />
    </div>
  )
}
