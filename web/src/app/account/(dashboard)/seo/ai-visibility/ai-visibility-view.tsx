'use client'

/**
 * SEO's AI visibility page: the workspace's trackers (a brand, the questions
 * its customers would ask, the assistants to ask them), and one tracker
 * opened as a card place (./tracker-detail.tsx). Drawn by the page card
 * (components/chat-cards/pages/seo-ai-visibility-card.tsx), which keeps where
 * the person is: moves inside the page are card places, never the router.
 *
 *   First run  no trackers yet: what this does, and New tracker. With
 *              lookups off, the "not set up / paid plan" notice instead.
 *   Index      a row per tracker, newest first: the brand, its questions,
 *              assistants and schedule, and a status word while a check
 *              runs, when it is paused, its schedule was skipped or its last
 *              check failed. A check running anywhere puts the run rail above
 *              the list (polled at the route's pace). "New tracker" opens the
 *              dialog; it waits at the cap, saying why.
 *
 * Reads: GET /api/account/seo/ai-visibility/trackers on mount and when a
 * check ends, with a request counter so a slow answer never overwrites a
 * newer one.
 */
import * as React from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import { MAX_TRACKERS_PER_WORKSPACE } from '@/lib/seo/ai-visibility/limits'
import { isLiveRun, type AiTrackerListItem, type AiTrackerView } from '@/lib/seo/ai-visibility/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../../views/view-header'
import { errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoDataNotice, SeoSpendLine, buyBlockedReason, useSeoData, type SeoDataState } from '../shared/data-status'
import { RunRail } from '../shared/run-rail'
import { relativeWhen } from '../ui-helpers'
import { runRailLine, trackerStatus, trackerSubline } from './ai-helpers'
import { fetchTrackers, stopCheck, type AiTrackerListPayload } from './api'
import { TrackerDetail } from './tracker-detail'
import { TrackerFormDialog } from './tracker-dialogs'
import { useAiRunPoll } from './use-ai-poll'

export interface AiVisibilityPageProps {
  /** The tracker open (the card's place), or null for the index. */
  trackerId: string | null
  /** Its brand, while the tracker itself loads. */
  trackerLabel?: string
  /** The tracker's tab (PAGE_KINDS.seo_ai_visibility.tabs). */
  tab?: string
  onOpenTracker: (tracker: { id: string; brand_name: string }) => void
  onCloseTracker: () => void
  onTab: (tab: string) => void
  /** The card header's count: the trackers there are, on the index. */
  onCount?: (count: number | null) => void
}

export function AiVisibilityPage(props: AiVisibilityPageProps) {
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

function TrackerIndex({ seo, onOpenTracker, onCount }: { seo: SeoDataState } & Pick<AiVisibilityPageProps, 'onOpenTracker' | 'onCount'>) {
  const [payload, setPayload] = React.useState<AiTrackerListPayload | null>(null)
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
      const next = await fetchTrackers()
      if (ask !== asked.current) return
      setPayload(next)
    } catch {
      if (ask === asked.current) setError('Could not load your AI visibility trackers.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const trackers = React.useMemo(() => payload?.trackers ?? [], [payload])
  React.useEffect(() => {
    onCount?.(payload ? trackers.length : null)
  }, [onCount, payload, trackers.length])

  const live = trackers.find((t) => t.latest_run && isLiveRun(t.latest_run.status)) ?? null
  const liveRun = live?.latest_run ?? null

  // The live check's progress; when it ends, the list again.
  useAiRunPoll(liveRun, !!liveRun, (results) => {
    const run = results.run
    setPayload((p) => (p ? { ...p, trackers: p.trackers.map((t) => (t.id === run.tracker_id ? { ...t, latest_run: run } : t)) } : p))
    if (!isLiveRun(run.status)) {
      seo.refresh()
      void load()
    }
  })

  const stop = async () => {
    if (!liveRun) return
    setStopping(true)
    try {
      await stopCheck(liveRun.id)
      toast('Stopped. The answers already in are kept.')
      seo.refresh()
      void load()
    } catch (err) {
      toast.error('Could not stop the check', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setStopping(false)
    }
  }

  const closeDialog = React.useCallback(() => setDialogOpen(false), [])
  const opened = React.useCallback((t: AiTrackerView) => onOpenTracker({ id: t.id, brand_name: t.brand_name }), [onOpenTracker])

  if (!payload) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader title={<PageTitle label="AI visibility" as="h1" />} />
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const view = seo.view
  const blocked = buyBlockedReason(view)
  const empty = trackers.length === 0
  const atCap = trackers.length >= MAX_TRACKERS_PER_WORKSPACE
  const newTitle = atCap
    ? `A workspace can have ${MAX_TRACKERS_PER_WORKSPACE} AI visibility trackers. Delete one to add another.`
    : 'Check how AI assistants answer questions about your business'
  const rail = liveRun ? runRailLine(liveRun) : null

  return (
    <div data-seo-index="" className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={<PageTitle label="AI visibility" as="h1" />}
        actions={
          <>
            <SeoSpendLine view={view} className="mr-2" />
            {/* With no trackers the first-run block carries the button. */}
            {!empty && (
              <Button size="sm" className="h-8" data-seo-new-tracker="" disabled={atCap} title={newTitle} onClick={() => setDialogOpen(true)}>
                New tracker
              </Button>
            )}
          </>
        }
      />
      {rail && live && <RunRail verb={rail.verb} clauses={[...rail.clauses, live.brand_name]} stopping={stopping} onStop={() => void stop()} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {empty ? (
          blocked && view ? (
            <SeoDataNotice view={view} what="AI visibility" />
          ) : (
            <FirstRun onNew={() => setDialogOpen(true)} />
          )
        ) : (
          <ul className="divide-y divide-border">
            {trackers.map((tracker) => (
              <TrackerRow key={tracker.id} tracker={tracker} onOpen={() => opened(tracker)} />
            ))}
          </ul>
        )}
      </div>
      <TrackerFormDialog
        open={dialogOpen}
        tracker={null}
        defaultDomain={payload.default_domain}
        scheduleBlocked={blocked}
        onClose={closeDialog}
        onSaved={opened}
        onDataOff={seo.refresh}
      />
    </div>
  )
}

function FirstRun({ onNew }: { onNew: () => void }) {
  return (
    <div data-seo-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-16 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">See how AI assistants talk about you</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          People now ask ChatGPT, Gemini and others what to buy and who to hire. Give this the questions your customers would
          ask, and it checks whether the answers name you, who they name instead, and which websites they lean on. Setting a
          tracker up costs nothing; each check is paid for from this workspace’s search data.
        </p>
      </div>
      <Button size="sm" className="h-8" data-seo-new-tracker="" onClick={onNew}>
        New tracker
      </Button>
    </div>
  )
}

/** One tracker on the index: its brand, what it asks and how often, and a status word when there is one. */
function TrackerRow({ tracker, onOpen }: { tracker: AiTrackerListItem; onOpen: () => void }) {
  const status = trackerStatus(tracker)
  const run = tracker.latest_run
  const checkedAt = run?.status === 'completed' ? (run.completed_at ?? run.created_at) : (tracker.last_run_at ?? null)
  const checked = relativeWhen(checkedAt)
  return (
    <li data-seo-tracker-row={tracker.id}>
      <button type="button" onClick={onOpen} title={`Open the tracker of ${tracker.brand_name}`} className="group flex w-full items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground group-hover:underline">{tracker.brand_name}</span>
          <span data-seo-tracker-subline="" className="block truncate text-xs tabular-nums text-muted-foreground">
            {trackerSubline(tracker)}
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
          <span data-seo-tracker-checked="" className="shrink-0 text-xs text-muted-foreground" title={checkedAt ?? undefined}>
            {checked ? `Checked ${checked}` : 'Not checked yet'}
          </span>
        )}
      </button>
    </li>
  )
}
