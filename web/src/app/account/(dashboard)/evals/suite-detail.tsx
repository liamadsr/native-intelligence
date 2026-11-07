'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * One eval suite: its cases, its run history, and the two buttons that start a
 * run.
 *
 * THE RUN BUTTONS ARE THE SCREEN. Everything else here — the case list, the
 * runs table — exists to answer "should I press one of those, and what
 * happened last time I did".
 *
 * SHAPE. The house detail-page shape, so this reads like a sequence or a flow:
 * `EntityDetailHeader` (breadcrumb + inline-editable name + ⋯ + actions) over
 * the two-column body — a centered main column beside a width-driven
 * Properties sidebar (`usePropertiesVisible`).
 *
 * NO SUITE-LEVEL VERDICT, anywhere on this page. A run passing or failing is a
 * fact about THAT run, and its results already live on its own row in the Runs
 * tab and on the run page. Stamping the last run's outcome on the suite — as a
 * header status pill or an Overview tile — read as "this suite failed", which
 * is not a thing a suite can be.
 *
 * TABS, THE COMPANY-PANEL IDIOM. Under the header sits the pill tab strip —
 * Overview, Cases, Runs — and the main column renders one of the three. The
 * Properties sidebar is a SIBLING of that column, outside the branches, so it
 * persists across tabs rather than being re-created by each one.
 *
 * THE ACTIVE TAB RIDES ON THE LOCATION, not on component state, exactly as a
 * side panel's `section` does: switching tabs is a history step, so Back and
 * Forward restore the tab the user was on, and a case or a run opened from a
 * tab hands that tab back on Back (`suiteTab`).
 *
 * EVERY FACT ABOUT THE SUITE IS A PROPERTY. What it grades, what kind it is,
 * how many cases and runs it has and when it last ran are all rows in the
 * sidebar. Overview carries only what a person writes: the name and the
 * description. It used to repeat the first two as a subtitle and the last three
 * as a meta line under the title, which was five properties rendered twice, in
 * prose, in the one place they could not be edited.
 *
 * EVERY EDITABLE PROPERTY EDITS. Target, suite kind, judge model and nightly watch each
 * PATCH one field and merge the response — optimistic, with a toast + reload on
 * failure, the shape `handleNameChange` already uses. `target_kind` is the one
 * exception and is deliberately NOT editable: `UpdateSuiteSchema` refuses it,
 * because a case's script and expectations are written against one kind of
 * recipe and repointing the suite would keep every case and invalidate all of
 * them at once. Changing the target therefore stays within the suite's kind.
 *
 * WHY BOTH RUN BUTTONS GO THROUGH A DIALOG. Spec §10 requires the price to be
 * quoted before it is spent, and prospecting gates its own metered run the same
 * way. The dialog also holds the live speed picker, which used to be a
 * split-dropdown welded to the button.
 *
 * WHY A LIVE RUN DISABLES BOTH BUTTONS. `idx_eval_run_one_live` is a partial
 * unique index on `(suite_id, mode)` — the database, not the app, refuses a
 * second concurrent run. `startEvalRun` adopts on the conflict rather than
 * erroring, so a race converges on one run; the disabled state is here so the
 * user is told BEFORE pressing rather than watching a button do nothing.
 *
 * CASES AND RUNS ARE LOCATIONS, NOT SHEETS. Opening one is a navigation step,
 * so Back/Forward and Recently viewed reach it — the caller turns
 * `onOpenCase`/`onOpenRun` into a tab navigation exactly as it does for a
 * suite.
 */

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { EntityDetailHeader } from '@/components/views/entity-detail-header'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import {
  BooleanPanelField,
  EnumPanelField,
} from '@/components/views/properties'
import { PropertyGroup } from '@/components/views/property-group'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { emitEntityDeleted } from '@/lib/entity-events'
import { estimateRunCostUsd } from '@/lib/evals/estimate'
import {
  EVAL_SUITE_KINDS,
  type EvalMode,
  type EvalSpeed,
  type EvalSuiteKind,
  type EvalSuiteRow,
} from '@/lib/evals/types'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Clock,
  Coins,
  FlaskConical,
  History,
  Layers,
  Loader2,
  Moon,
  Play,
  Trash2,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { EVAL_SUITE_TABS, type EvalSuiteTab } from '@/app/account/(dashboard)/evals/suite-tabs'
import { usePanelSection } from '../views/use-panel-section'
import { ViewHeader } from '../views/view-header'
import {
  cancelRun,
  deleteSuite,
  errorCode,
  errorMessage,
  fetchSuite,
  patchSuite,
  startRun,
  type SuiteDetailPayload,
  type UpdateSuiteBody,
} from './api'
import { JudgeModelPanelField, RecipePanelField } from './property-fields'
import { EvalRunRail } from './run-rail'
import { StartRunDialog } from './start-run-dialog'
import {
  formatCost,
  formatRunWhen,
  pluralize,
  relativeTimeShort,
} from './ui-helpers'
import { useEvalRunPoll } from './use-eval-run-poll'

/** A suite kind, named in full. The Properties sidebar renders this control as
 *  value-only with no field name, so the VALUE has to say what field it is —
 *  "Capability" alone could be anything, "Capability suite" cannot. */
function suiteKindLabelFor(kind: EvalSuiteKind): string {
  return kind === 'regression' ? 'Regression suite' : 'Capability suite'
}

/** `UpdateSuiteSchema.description` is `.max(2000)`. The editor stops accepting
 *  input at the cap rather than letting the user type past it and meet a 400 on
 *  the debounce — nobody is writing 2000 characters of summary by accident, so
 *  a counter or an error would be furniture for a limit nobody reaches. */
const DESCRIPTION_MAX = 2000

/**
 * The description editor: the panel's inline-field treatment, multi-line and
 * height-autosized. Copied from the company panel's own `AutoGrowTextarea` —
 * deliberately NOT the NoteEditor, which is a full markdown document editor and
 * far too heavy for one plain-text column.
 */
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // Autosize to the content. Reset to 'auto' first so the box can SHRINK when
  // text is deleted, not only grow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={2}
      maxLength={DESCRIPTION_MAX}
      aria-label={ariaLabel}
      className="placeholder:text-muted-foreground w-full resize-none bg-transparent px-2 text-sm outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, DESCRIPTION_MAX))}
      placeholder={placeholder}
    />
  )
}

/** One pill in the sub-header tab strip. Same markup and classes as the
 *  company and contact panels, so all three read as one control. */
function TabPill({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean
  /** Rendered as the muted trailing badge. Omitted at 0 — a "0" badge is a
   *  fact the empty state below already states more plainly. */
  count?: number
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors',
        active
          ? 'bg-foreground text-background border-foreground font-medium'
          : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 text-[10px] opacity-70">{count}</span>
      )}
    </button>
  )
}

// ============================================================
// The detail page
// ============================================================

export function EvalSuiteDetail({
  suiteId,
  tab,
  onBack,
  onTabChange,
  onSuiteNameLoaded,
  onOpenCase,
  onOpenRun,
}: {
  suiteId: string
  /** The open inner tab, from the LOCATION. Absent = Overview. */
  tab?: EvalSuiteTab
  onBack: () => void
  /** Switching tabs is a history step — the caller re-navigates to the same
   *  suite with a new `tab`, exactly as a side panel's `onSectionChange` does. */
  onTabChange?: (tab: EvalSuiteTab) => void
  onSuiteNameLoaded?: (id: string, name: string) => void
  /** Open a case as a location — the caller navigates. */
  onOpenCase?: (caseId: string, caseName: string, suiteName: string) => void
  /** Open a run as a location — the caller navigates. */
  onOpenRun?: (runId: string, label: string, suiteName: string) => void
}) {
  const [detail, setDetail] = useState<SuiteDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The 409 budget ceiling, a failed start — a banner, not a toast: it is a
   *  fixable state the user can act on. */
  const [runError, setRunError] = useState<string | null>(null)
  const [starting, setStarting] = useState<EvalMode | null>(null)
  const [confirmMode, setConfirmMode] = useState<EvalMode | null>(null)
  const [speed, setSpeed] = useState<EvalSpeed>('instant')
  const [canceling, setCanceling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)

  /** The active tab, mirrored locally so a pill highlights on click before the
   *  navigation round-trips, and re-synced whenever history restores another —
   *  the side panels' contract, via the same hook. */
  const [activeTab, setActiveTab] = usePanelSection<EvalSuiteTab>(
    tab,
    onTabChange as ((section: string) => void) | undefined,
    'overview',
    EVAL_SUITE_TABS,
  )

  /**
   * The suite fetch. Its ONLY dependency is `suiteId` — deliberately, and this
   * is the fix for a request storm that hammered
   * `GET /api/account/evals/suites/<id>` two-to-four times a second on a suite
   * with nothing running.
   *
   * `onSuiteNameLoaded` is an inline arrow in `tab-content.tsx` whose body
   * calls `navigate(...)`. It is therefore a NEW function identity on every
   * render of the tab, and calling it re-renders the tab. With that prop in
   * `load`'s deps AND called from inside `load`, the circuit closed:
   *
   *   load → fetchSuite → onSuiteNameLoaded → navigate → parent re-render →
   *   new callback identity → new `load` identity → mount effect (deps
   *   `[load]`) re-fires → load → …
   *
   * No timer, no `is_live` gate — it spun as fast as the network answered.
   * The callback now lives in a ref (read at call time, never a dependency),
   * exactly as the poll does with its own `onTick`, and the name report has
   * moved to its own value-deduped effect below.
   */
  const onSuiteNameLoadedRef = useRef(onSuiteNameLoaded)
  onSuiteNameLoadedRef.current = onSuiteNameLoaded

  /** An inline rename in flight. A poll-tick refetch landing mid-type must not
   *  clobber what is in the input (the sequence-detail contract). */
  const pendingNameRef = useRef<string | null>(null)
  const nameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** The same pair for the description: a poll-tick refetch landing mid-type
   *  must not clobber what is in the textarea. */
  const pendingDescriptionRef = useRef<string | null>(null)
  const descriptionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  /**
   * Keep whatever is mid-edit. ANY server row that lands between a keystroke
   * and the PATCH that carries it — a poll-tick refetch, or the row a property
   * PATCH answers with — would otherwise reset the field to the server's older
   * value under the user's cursor.
   */
  const mergePending = useCallback((suite: EvalSuiteRow): EvalSuiteRow => {
    const merged = { ...suite }
    if (pendingNameRef.current !== null) merged.name = pendingNameRef.current
    if (pendingDescriptionRef.current !== null) {
      merged.description = pendingDescriptionRef.current
    }
    return merged
  }, [])

  const load = useCallback(async () => {
    try {
      setLoadError(null)
      const next = await fetchSuite(suiteId)
      setDetail((prev) => {
        if (!prev) return next
        return { ...next, suite: mergePending(next.suite) }
      })
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load this suite'))
    } finally {
      setLoading(false)
    }
  }, [suiteId, mergePending])

  useEffect(() => {
    setLoading(true)
    setDetail(null)
    void load()
  }, [load])

  // Leaving (or switching suites) inside the 500 ms debounce: send the
  // pending edit now rather than dropping it with the timer.
  useEffect(
    () => () => {
      if (nameTimeoutRef.current) {
        clearTimeout(nameTimeoutRef.current)
        nameTimeoutRef.current = null
        const name = pendingNameRef.current?.trim()
        // Cleared so a switched-to suite's load doesn't merge this suite's edit.
        pendingNameRef.current = null
        if (name) void patchSuite(suiteId, { name }).catch(() => {})
      }
      if (descriptionTimeoutRef.current) {
        clearTimeout(descriptionTimeoutRef.current)
        descriptionTimeoutRef.current = null
        const description = pendingDescriptionRef.current
        pendingDescriptionRef.current = null
        if (description !== null) {
          void patchSuite(suiteId, { description: description || null }).catch(() => {})
        }
      }
    },
    [suiteId],
  )

  /**
   * Report the real name exactly ONCE PER VALUE — the prospecting contract
   * (`list-detail.tsx` ~403). A deep link arrives with a placeholder, and the
   * parent re-navigates to the same location on each call; re-reporting an
   * unchanged name would push a redundant history step on every poll-tick
   * refetch, which is this same storm one level up in the tab.
   */
  const reportedNameRef = useRef<string | null>(null)
  const suiteName = detail?.suite.name
  useEffect(() => {
    if (!suiteName || reportedNameRef.current === suiteName) return
    reportedNameRef.current = suiteName
    onSuiteNameLoadedRef.current?.(suiteId, suiteName)
  }, [suiteId, suiteName])

  /** Inline rename — debounced PATCH, the sequence-detail shape. */
  const handleNameChange = useCallback(
    (value: string) => {
      setDetail((prev) =>
        prev ? { ...prev, suite: { ...prev.suite, name: value } } : prev,
      )
      pendingNameRef.current = value
      if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
      nameTimeoutRef.current = setTimeout(async () => {
        nameTimeoutRef.current = null
        const name = value.trim()
        if (!name) {
          pendingNameRef.current = null
          return
        }
        try {
          await patchSuite(suiteId, { name })
          reportedNameRef.current = name
          onSuiteNameLoadedRef.current?.(suiteId, name)
        } catch (err) {
          toast.error(errorMessage(err, 'Could not rename this suite'))
          void load()
        } finally {
          // Only AFTER the PATCH settles, and only if no later keystroke has
          // claimed the ref: a poll tick landing mid-request still reads the
          // server's pre-PATCH name, and clearing on entry would let it
          // repaint the old value under the user's cursor.
          if (pendingNameRef.current === value) pendingNameRef.current = null
        }
      }, 500)
    },
    [suiteId, load],
  )

  /**
   * The description — the same debounced-PATCH shape as the rename, one field
   * down. `|| null` because the column is nullable and an empty string is not
   * a description: a suite whose summary was deleted should read as having none
   * rather than as having a blank one.
   */
  const handleDescriptionChange = useCallback(
    (value: string) => {
      setDetail((prev) =>
        prev ? { ...prev, suite: { ...prev.suite, description: value } } : prev,
      )
      pendingDescriptionRef.current = value
      if (descriptionTimeoutRef.current) {
        clearTimeout(descriptionTimeoutRef.current)
      }
      descriptionTimeoutRef.current = setTimeout(async () => {
        descriptionTimeoutRef.current = null
        try {
          await patchSuite(suiteId, { description: value || null })
        } catch (err) {
          toast.error(errorMessage(err, 'Could not save the description'))
          void load()
        } finally {
          // Same ordering as the rename: the guard has to outlive the request.
          if (pendingDescriptionRef.current === value) {
            pendingDescriptionRef.current = null
          }
        }
      }, 500)
    },
    [suiteId, load],
  )

  /**
   * Every editable PROPERTY, through one path: optimistic locally, one PATCH,
   * merge the row the route answers with, and on failure say so and re-read
   * the truth. No debounce — a picker fires once per choice, unlike a textarea.
   *
   * `reload` re-reads the whole detail rather than merging, for the one change
   * whose effect is not in the returned row: `target_recipe_id` moves the
   * NAME the page shows, and that name lives in the payload's `target`, which
   * a suite PATCH does not return.
   */
  const patchProperty = useCallback(
    async (updates: UpdateSuiteBody, reload = false) => {
      const previous = detail
      setDetail((prev) =>
        prev ? { ...prev, suite: { ...prev.suite, ...updates } } : prev,
      )
      try {
        const suite = await patchSuite(suiteId, updates)
        // The row the route answers with carries name and description too, and
        // a rename or description still sitting in its debounce has not been
        // written yet — merge the pending edits back or this replacement snaps
        // the field back to the server's older text under the cursor.
        setDetail((prev) =>
          prev ? { ...prev, suite: mergePending(suite) } : prev,
        )
        if (reload) void load()
      } catch (err) {
        toast.error(errorMessage(err, 'Could not save that change'))
        setDetail(
          previous
            ? { ...previous, suite: mergePending(previous.suite) }
            : previous,
        )
        void load()
      }
    },
    [detail, suiteId, load, mergePending],
  )

  /**
   * The run poll. `onTick` refetches the suite so the runs table and every
   * case's outcome track a run that is in flight — the poll owns the RUN, the
   * page owns everything the run changes.
   */
  const runPoll = useEvalRunPoll({ suiteId, onTick: load })
  const liveRun = runPoll.isLive ? runPoll.run : null

  // Memoized because the `?? []` allocates a NEW empty array every render while
  // `detail` is null, which would re-run the cost estimate below on each one.
  const cases = useMemo(() => detail?.cases ?? [], [detail])
  const runs = detail?.runs ?? []

  /**
   * What each button is about to spend, BEFORE it is pressed.
   *
   * `estimateRunCostUsd` is pure and client-safe, and counts only the cases the
   * run will actually execute — a case that does not declare a mode is skipped
   * server-side and must not be billed for here either.
   */
  const runnableCount = useMemo(
    () => ({
      batch: cases.filter((c) => c.modes.includes('batch')).length,
      live: cases.filter((c) => c.modes.includes('live')).length,
    }),
    [cases],
  )
  const estimates = useMemo(() => {
    const forMode = (mode: EvalMode) =>
      estimateRunCostUsd({
        caseCount: runnableCount[mode],
        mode,
        trialsPerCase: 1,
      })
    return { batch: forMode('batch'), live: forMode('live') }
  }, [runnableCount])

  const start = useCallback(
    async (mode: EvalMode) => {
      setRunError(null)
      setStarting(mode)
      try {
        const result = await startRun({
          suite_id: suiteId,
          mode,
          ...(mode === 'live' ? { speed } : {}),
        })
        // Adopt immediately rather than waiting up to 3s for the next tick —
        // and an `adopted: true` result is the unique index handing back a run
        // that was already in flight, which is the same adoption.
        runPoll.adopt(result.run)
        setConfirmMode(null)
        void load()
      } catch (err) {
        setConfirmMode(null)
        setRunError(
          errorCode(err) === 'budget_exceeded'
            ? errorMessage(
                err,
                'This workspace has used its monthly eval budget',
              )
            : errorMessage(err, 'Could not start the run'),
        )
      } finally {
        setStarting(null)
      }
    },
    [suiteId, speed, runPoll, load],
  )

  const stop = useCallback(async () => {
    if (!liveRun) return
    setRunError(null)
    setCanceling(true)
    try {
      runPoll.adopt(await cancelRun(liveRun.id))
    } catch (err) {
      // A run that finished between the render and the click answers 409
      // NOT_CANCELABLE. Nothing went wrong — the run is stopped, which is what
      // the button asked for — so say nothing and let the reload below show the
      // true status.
      if (errorCode(err) !== 'NOT_CANCELABLE') {
        setRunError(errorMessage(err, 'Could not stop the run'))
      }
    } finally {
      setCanceling(false)
    }
    void load()
  }, [liveRun, runPoll, load])

  const removeSuite = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteSuite(suiteId)
      // The index behind us is a views list. It drops the row on this event —
      // the realtime DELETE would arrive too, but only after a round trip, so
      // Back would land on a list still showing the suite we just deleted.
      emitEntityDeleted({ entityType: 'eval_suite', id: suiteId })
      onBack()
    } catch (err) {
      setRunError(
        errorCode(err) === 'RUN_ALREADY_LIVE'
          ? 'Stop the run in flight before deleting this suite.'
          : errorMessage(err, 'Could not delete this suite'),
      )
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }, [suiteId, onBack])

  // ── Render ──
  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Eval suite" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      </div>
    )
  }

  // A failed refetch (a poll tick, a reload after a failed save) keeps the
  // loaded suite on screen; the error page is only for a suite never loaded.
  if (!detail) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader
          title="Eval suite"
          actions={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onBack}
            >
              Back to evals
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
          <p className="text-muted-foreground text-sm">
            {loadError ?? 'Suite not found'}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const suite = detail.suite
  const target = detail.target ?? null
  const runBusy = starting !== null || runPoll.isLive
  /** The most recent run of ANY status — a queued run is still the last time
   *  someone ran this, even before it has a verdict. */
  const lastRunAt = runs[0]?.started_at ?? null
  const runDisabledReason = runPoll.isLive
    ? 'A run is already going on this suite'
    : cases.length === 0
      ? 'This suite has no cases yet'
      : null

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <EntityDetailHeader
        viewTitle="Evals"
        onBack={onBack}
        name={suite.name}
        onNameChange={handleNameChange}
        namePlaceholder="Untitled suite"

        actions={
          <WindowActions className="flex items-center gap-1.5">
            <PreferenceActionButton
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={runBusy || cases.length === 0}
              title={
                runDisabledReason ??
                `One end-of-meeting call per case · about ${formatCost(estimates.batch)}`
              }
              onClick={() => setConfirmMode('batch')}
            >
              <Play className="h-3 w-3" />
              Run batch
            </PreferenceActionButton>
            <PreferenceActionButton
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={runBusy || cases.length === 0}
              title={
                runDisabledReason ?? `Replay each case chunk by chunk · about ${formatCost(estimates.live)}`
              }
              onClick={() => setConfirmMode('live')}
            >
              <Play className="h-3 w-3" />
              Run live
            </PreferenceActionButton>
            <PreferenceActionButton
              onClick={() => setConfirmDelete(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete suite
            </PreferenceActionButton>
          </WindowActions>
        }
      />

      {/* The tab strip — the company panel's sub-header row, same markup and
          same classes. Directly under the header, above the two-column body,
          so it reads as belonging to the page rather than to either column. */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          <TabPill
            active={activeTab === 'overview'}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </TabPill>
          <TabPill
            active={activeTab === 'cases'}
            count={cases.length}
            onClick={() => setActiveTab('cases')}
          >
            Cases
          </TabPill>
          <TabPill
            active={activeTab === 'runs'}
            count={runs.length}
            onClick={() => setActiveTab('runs')}
          >
            Runs
          </TabPill>
        </div>
      </div>

      <div ref={panelBodyRef} className="flex min-h-0 flex-1 justify-center">
        <div className="mx-auto flex min-h-0 w-full max-w-[736px] min-w-0 flex-col">
          {/* The run error is ABOVE the tab split — it is about the suite, not
              about whichever tab happens to be open, and a banner that
              vanishes when you switch tabs is a banner nobody trusts. It sits
              OUTSIDE the scroll area now that two of the three tabs own their
              own scrolling (see below), so it stays pinned rather than
              scrolling away inside one tab and not the other. */}
          {runError && (
            <div className="mx-8 mt-4 flex shrink-0 items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{runError}</span>
            </div>
          )}

          {/* THE SCROLL AREA BELONGS TO OVERVIEW ALONE. Cases and Runs are
              `UnifiedViewLayout` mounts, and that component owns its own
              virtualized scroll container — nesting it inside a ScrollArea
              gives the list a viewport of infinite height, so it renders every
              row at once and the toolbar scrolls away with them. Exactly the
              arrangement `project-detail-panel` uses for its own Overview /
              Actions / Captures split. */}
          {activeTab === 'overview' && (
            <ScrollArea className="h-full">
              <div className="px-8 pb-28">
                <>
                  {/* Title — the house detail-page block (sequence-detail's
                      shape). The header carries the same editable name and the
                      same debounced PATCH; both write through
                      `handleNameChange`, so they are one field with two
                      renderings rather than two. */}
                  <div className="pt-6 pb-2">
                    <EntityTitleInput
                      value={suite.name}
                      onChange={handleNameChange}
                      placeholder="Untitled suite"
                      aria-label="Suite name"
                    />
                  </div>

                  {/* WHAT THIS SUITE IS goes in PROPERTIES, not here. A
                      subtitle reading "Capability suite · grades the
                      Interactive Assistant agent" restated, word for word, the
                      Suite kind and Target rows the sidebar already carries,
                      and the meta line under it ("1 case · 1 run · last run
                      11h ago") was three more properties wearing prose. They
                      are all rows in the sidebar now, which leaves Overview as
                      the two things only a person writes: the name and the
                      description. */}

                  {/* What this suite is FOR, in the author's own words. The
                      Properties sidebar says what it grades; only a person can
                      say what it is trying to prove. Editable in place — one
                      debounced PATCH, no Save button, like the name. */}
                  <div className="mt-2 -ml-2">
                    <AutoGrowTextarea
                      value={suite.description ?? ''}
                      onChange={handleDescriptionChange}
                      placeholder="Add a description..."
                      aria-label="Suite description"
                    />
                  </div>
                </>
              </div>
            </ScrollArea>
          )}

          {/* ── Cases: the shared views system, scoped to this suite ──

              The SAME component a project's Actions tab embeds, and for the
              same reason: a list of cases wants saved views, filters, grouping
              and a board just as much as a list of issues does, and the
              hand-rolled list this replaced could offer none of them. What
              makes it "this suite's cases" is one fixed `suite_id` scope
              filter — a real column, so no synthetic field and no subquery.

              `viewScope` is what keeps a view saved here from leaking: a
              "Failed only" view made inside Smoke 2 persists under
              (scope_type='eval_suite', scope_id=<this suite>) and never
              appears in the next suite's picker. Migration 257 added
              'eval_suite' to the scope CHECK for exactly this.

              THE KEY CARRIES THE SUITE ID. Without it, navigating from one
              suite to another would re-use the mounted instance and show the
              previous suite's rows, active view and selection until the
              refetch landed. */}
          {activeTab === 'cases' && (
            <UnifiedViewLayout
              key={`eval-cases-${suiteId}`}
              entityType="eval_case"
              scopeFilters={[
                {
                  id: '__scope_eval_suite',
                  field: 'suite_id',
                  operator: 'is',
                  value: suiteId,
                },
              ]}
              viewScope={{ type: 'eval_suite', id: suiteId }}
              onItemSelect={(id, title) => onOpenCase?.(id, title, suite.name)}
            />
          )}

          {activeTab === 'runs' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* The rail stays ABOVE the list, outside the views layout. A
                  live run says so in countable segments — never a percentage;
                  a run's unit is trials, and "7 of 12" is checkable while
                  "58%" is not (the run-rail rule). It cannot be a row in the
                  list below: the list is a history, and the thing happening
                  right now needs to stay put while that history scrolls. */}
              {liveRun && (
                <EvalRunRail
                  run={liveRun}
                  live
                  canceling={canceling}
                  onCancel={() => void stop()}
                />
              )}

              <div className="flex min-h-0 flex-1 flex-col">
                <UnifiedViewLayout
                  key={`eval-runs-${suiteId}`}
                  entityType="eval_run"
                  scopeFilters={[
                    {
                      id: '__scope_eval_suite',
                      field: 'suite_id',
                      operator: 'is',
                      value: suiteId,
                    },
                  ]}
                  viewScope={{ type: 'eval_suite', id: suiteId }}
                  onItemSelect={(id, title) =>
                    onOpenRun?.(id, title, suite.name)
                  }
                />
              </div>
            </div>
          )}
        </div>

        {/* Properties — a SIBLING of the tab column, outside the branches, so
            it persists across tabs (the company-panel idiom) rather than being
            three copies that happen to look alike. Informational plus editable,
            and still width-driven: nothing here is the only way to do anything,
            so nothing is lost when the column collapses it away. */}
        <WindowProperties key={suiteId} title={suite.name} fallbackVisible={propertiesOpen}>
                <div className="space-y-4 p-4">
                  <PropertyGroup title="Properties">
                    {/* The target by NAME, and editable. The KIND is not: it is
                        immutable by schema, because every case's script and
                        expectations are written against one kind of recipe. So
                        the picker lists this suite's own kind and the kind
                        stays the muted suffix, which is where a type belongs
                        next to a name. */}
                    <RecipePanelField
                      kind={suite.target_kind}
                      value={suite.target_recipe_id}
                      displayName={target?.name ?? null}
                      // A reload, not a merge: the PATCH answers with the suite
                      // row, and the target's NAME lives in the payload's
                      // `target` — which only a re-read carries.
                      onChange={(id) =>
                        void patchProperty({ target_recipe_id: id }, true)
                      }
                    />
                    {/* The shared `EnumPanelField` renders VALUE-as-label with
                        a leading icon and no field name — the contact panel's
                        Type and Strength rows read the same way, so the row is
                        left alone and the OPTION LABELS carry the field name
                        instead ("Capability suite", not "Capability"). */}
                    <EnumPanelField
                      value={suite.suite_kind}
                      options={EVAL_SUITE_KINDS.map((value) => ({
                        value,
                        label: suiteKindLabelFor(value),
                      }))}
                      onChange={(value) =>
                        void patchProperty({
                          suite_kind: value as EvalSuiteKind,
                        })
                      }
                      placeholder="Set suite kind"
                      padding="px-3"
                      icon={
                        <Layers className="text-muted-foreground h-4 w-4 shrink-0" />
                      }
                    />
                    <JudgeModelPanelField
                      value={suite.judge_model}
                      onChange={(id) => void patchProperty({ judge_model: id })}
                    />
                    {/* The one row that keeps a written label: a boolean has no
                        value worth reading on its own ("On" is not a property
                        name), so label + right-aligned state is the house
                        boolean idiom and stays as it is. */}
                    <BooleanPanelField
                      value={suite.watch}
                      label="Nightly watch"
                      padding="px-3"
                      icon={
                        <Moon className="text-muted-foreground h-4 w-4 shrink-0" />
                      }
                      onChange={(value) => void patchProperty({ watch: value })}
                    />
                    {/* How big this suite is and how often it has been run —
                        the facts the Overview subtitle used to carry as prose.
                        They are properties of the suite, so they read as rows
                        here beside the ones that are, in the same read-only
                        capture-panel shell as the estimate and the created
                        date below.

                        NO OUTCOME ON ANY OF THEM. A run's verdict belongs to
                        THAT run — its row in the Runs tab and the run page. A
                        failed run does not make the suite failed. */}
                    <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-sm">
                      <FlaskConical className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {cases.length === 0
                          ? 'No cases yet'
                          : pluralize(cases.length, 'case')}
                      </span>
                    </div>
                    <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-sm">
                      <Play className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {runs.length === 0
                          ? 'No runs yet'
                          : pluralize(runs.length, 'run')}
                      </span>
                    </div>
                    {/* Dropped entirely when nothing has ever run: "Last run —"
                        is a row about an event that has not happened, and the
                        row above already said there are no runs. `History`
                        rather than `Clock` because Created below has the clock
                        and two identical glyphs in one column would read as
                        two spellings of the same field. */}
                    {lastRunAt && (
                      <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-sm">
                        <History className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          Last run {relativeTimeShort(lastRunAt)}
                        </span>
                      </div>
                    )}
                    {/* What a run WOULD cost, as reference. It is no longer a
                        hero tile: the number that matters is quoted in the
                        start-run dialog, at the moment it is about to be spent.
                        Read-only rows use the capture panel's shell — icon,
                        one value, muted throughout — so the eye can tell at a
                        glance which rows here it can click. */}
                    <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-sm">
                      <Coins className="h-4 w-4 shrink-0" />
                      <span className="truncate tabular-nums">
                        {formatCost(estimates.batch)} batch ·{' '}
                        {formatCost(estimates.live)} live
                      </span>
                    </div>
                    <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-sm">
                      <Clock className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {formatRunWhen(suite.created_at)}
                      </span>
                    </div>
                  </PropertyGroup>
                </div>
              </WindowProperties>
      </div>

      <StartRunDialog
        open={confirmMode !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmMode(null)
        }}
        mode={confirmMode}
        caseCount={confirmMode ? runnableCount[confirmMode] : 0}
        estimateUsd={confirmMode ? estimates[confirmMode] : 0}
        speed={speed}
        onSpeedChange={setSpeed}
        starting={starting !== null}
        onConfirm={() => {
          if (confirmMode) void start(confirmMode)
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${suite.name}"?`}
        description="This deletes the suite, every case in it, their mock captures, and the whole run history. It cannot be undone."
        busy={deleting}
        onConfirm={() => void removeSuite()}
      />
    </div>
  )
}

/** Skeleton rows, exported so a caller can render the suite shell while its
 *  payload loads without importing the whole page. */
export function SuiteDetailSkeleton() {
  return (
    <div className="space-y-2 pt-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-md" />
      ))}
    </div>
  )
}
