'use client'

/**
 * One prospect list (§10, Page 3).
 *
 * Bespoke header, shared body. The header carries what views cannot: the list
 * name, an ICP summary chip that opens the editable ICP panel, the stage bar,
 * hand-add-by-domain, and the selection bar for Save / Dismiss. The body is
 * `<UnifiedViewLayout entityType="prospect_list_entry">` scoped to this list,
 * which buys saved views, filters, sort, display properties and list/board
 * layout with no new code.
 *
 * SCOPING is `scopeFilters` + `viewScope` (Package 2's `prospectListScopeFilters`):
 * `list_id` is a real column, so the generic `eq` path restricts the view with
 * no new engine seam, and the scoped `viewScope` keeps saved views made inside
 * one list out of every other list's picker.
 *
 * WHY THE SELECTION BAR IS HERE and not in `unified-view-layout`: `save_to_crm`
 * and `dismiss` both need per-row outcomes the generic `{success, failed}` bulk
 * endpoint cannot express — Save reports created/already-saved/no-domain PER
 * ENTRY, and Dismiss must collect a REASON first (two of which suppress
 * workspace-wide). `onBulkSelectionChange` hands the parent the selection plus
 * `onClear`, which is exactly the seam for owning both.
 *
 * PR 4 ADDS the run surface (§9): a Find button gated on liveness, the confirm
 * dialog, the polled progress rail, the terminal outcome banner, the skipped
 * ledger and the run-history popover. The poll ALSO refetches the entry list on
 * every tick, which is what makes "results stream in as each round commits"
 * true rather than aspirational.
 *
 * THE STAGE TABS (All · Saved · Needs review · Dismissed) live in the views'
 * own tab row, beside this list's custom views, as baseline navigation — the
 * shape the Actions list gives "All issues / Assigned to me" (Liam,
 * 2026-09-06: "those could just be the default views"). This page owns which
 * tab is in force and pushes its narrowing alongside the list scope — `stage`
 * and `identity_state` are real filterable columns, so no engine seam is
 * needed — and stands the tab down while a custom view is open. "Still on the
 * list" (no dismissed rows) is the server's default, so a custom view inherits
 * it unless it names `stage` itself. See @/lib/views/prospect-stage-tabs.
 */

import { PageTitle } from '@/components/views/page-title'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  History,
  Loader2,
  Plus,
  Search,
  Send,
  Settings2,
  Target,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { UnifiedViewLayout, type BulkSelectionInfo } from '@/components/views/unified-view-layout'
import { ProspectListDeleteDialog } from '@/components/views/bulk-actions/prospect-list-delete-dialog'
import { getAdjacentItems, type VisibleItem } from '@/components/views/detail-nav-utils'
import {
  PROSPECT_ENTRY_ACTION_EVENT,
  useProspectEntryActionTarget,
  publishProspectSequenced,
  type ProspectEntryActionDetail,
} from '@/components/views/list/entity-row'
import { cn } from '@/lib/utils'
import { prospectListScopeFilters } from '@/lib/prospecting/urls'
import {
  type Icp,
  type ProspectDismissedReason,
  type ProspectEntryKind,
  type ProspectListEntryRow,
} from '@/lib/prospecting/types'
import { ViewHeader } from '../views/view-header'
import { CompanyDetailPanel } from '../views/company-detail-panel'
import { ContactDetailPanel } from '../views/contact-detail-panel'
import { DetailBreadcrumbHeader } from '../views/detail-breadcrumb-header'
import { DismissReasonDialog } from './dismiss-reason-dialog'
import { EntryPanel } from './entry-panel'
import { FindDialog } from './find-dialog'
import { PeopleDialog } from './people-dialog'
import {
  defaultProspectStageTab,
  prospectStageTabFilters,
  type ProspectStageTab,
} from '@/lib/views/prospect-stage-tabs'
import { IcpEditor } from './icp-editor'
import { RunHistoryPanel } from './run-history'
import { useSpend } from './spend-meter'
import { RunOutcome } from './run-outcome'
import { RunRail } from './run-rail'
import { useRunPoll } from './use-run-poll'
import { useActiveRuns } from './use-active-runs'
import { askAboutList } from './start-event'
import { publishProspectingSelection } from './selection-context'
import { useScoutActivity } from './scout-activity'
import { SaveStoryBanner, type SaveStory } from './save-story'
import {
  NO_EMAIL_REASON,
  hasAccountCard,
  readProgress,
  summarizeSaveResult,
} from './ui-helpers'
import { SequenceFlowSurface, useSequenceFlow } from './sequence-actions'
import {
  MAX_ENTRIES_PER_TARGETED_RUN,
} from '@/lib/prospecting/spend'
import { fitScoreWord } from '@/lib/prospecting/fit-display'
import {
  ProspectListActivityContext,
  type ProspectListActivity,
} from '@/lib/prospecting/list-activity'
import { announceProspectListChanged } from '@/lib/prospecting/list-events'
import {
  addEntryByDomain,
  cancelRun,
  errorCode,
  errorMessage,
  fetchList,
  fetchSequenced,
  patchEntryStage,
  patchList,
  publishEntries,
  publishList,
  saveEntries,
  startRun,
  type ListDetailPayload,
  type RunPayload,
  type SaveResult,
  type SequencedMap,
} from './api'

/** Nudge the shared views list to refetch. This is the exact seam
 *  UnifiedViewLayout already listens on (the same trick sequences-view uses to
 *  bridge enrollment counts), with its own coalescing — so a 40-entry bulk
 *  save costs one refetch. */
function refreshEntries() {
  window.dispatchEvent(
    new CustomEvent('ni:entity-created', { detail: { entityType: 'prospect_list_entry' } }),
  )
}

/** One stable empty array, so "no selection" does not allocate a new identity
 *  on every render and invalidate everything memoized on it. */
const EMPTY_IDS: string[] = []

function parseIcp(raw: unknown): Icp | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Icp) : null
}

/** What to call a candidate in a header or a breadcrumb: its name, else its
 *  domain. Both live in the `candidate` jsonb — the entry IS the prospect, so
 *  there is no CRM row to read a name off until Save. */
function candidateTitle(entry: ProspectListEntryRow | null | undefined): string {
  const raw = entry?.candidate
  const candidate =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { name?: unknown; domain?: unknown })
      : null
  if (typeof candidate?.name === 'string' && candidate.name.trim()) return candidate.name.trim()
  if (typeof candidate?.domain === 'string' && candidate.domain.trim()) {
    return candidate.domain.trim()
  }
  return 'Candidate'
}

/**
 * The one Prospecting section injected above the post-save ContactDetailPanel
 * (§10, Page 4).
 *
 * Three facts, and they are exactly the three the CRM record cannot carry:
 * WHICH LIST found this person, how their ACCOUNT scored (fit is on the
 * account — a per-person letter grade would be a number nobody computed), and
 * whether the employer was confirmed. All three live on the entry as per-list
 * verdict and none of them belongs on `contact`, which is why they have to be
 * rendered here rather than merged into the record on Save.
 */
function ProspectingContactBanner({
  listName,
  context,
}: {
  listName: string
  context: {
    fitScore: number | null
    fitRationale: string | null
    identityState: string
    company: string | null
  }
}) {
  const unverified = context.identityState === 'needs_review'
  return (
    <div
      data-prospecting-section
      className="shrink-0 space-y-1 border-b border-border bg-muted/20 px-6 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">Found in</span>
        <span className="font-medium">{listName}</span>
        {context.company && (
          <>
            <span className="text-muted-foreground">at</span>
            <span className="font-medium">{context.company}</span>
          </>
        )}
        {typeof context.fitScore === 'number' && (
          <span className="text-muted-foreground">
            · match score {context.fitScore}
            {fitScoreWord(context.fitScore) ? ` · ${fitScoreWord(context.fitScore)!.toLowerCase()}` : ''}
          </span>
        )}
        <span className={cn('text-muted-foreground', unverified && 'italic')}>
          ·{' '}
          {unverified
            ? 'employer not confirmed'
            : 'verified at this company'}
        </span>
      </div>
      {context.fitRationale && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {context.fitRationale}
        </p>
      )}
    </div>
  )
}

export function ListDetail({
  listId,
  onBack,
  onNameLoaded,
  onOpenSequence,
}: {
  listId: string
  /** Breadcrumb back to the index — a real history step. */
  onBack: () => void
  /** Deep links arrive with the placeholder name 'Prospect list'; called once
   *  the real name is known so the tab label and Recently viewed adopt it. */
  onNameLoaded?: (name: string) => void
  /**
   * Open a sequence's own page (C5).
   *
   * THE ONE LINK ON THIS PAGE THAT LEAVES IT. Every other destination here is
   * an in-column overlay, deliberately: the list's breadcrumb has to keep
   * reading "<list name> › <thing>", and the shell's generic detailPanel would
   * render "Prospecting" instead (see the overlay's own note below). A sequence
   * is different in kind — it is a first-class tab location
   * (`{kind:'sequence', view:'sequences', id, name}`) with a page of its own,
   * and nothing about it belongs under this list's crumb. So this one is a real
   * navigation, handed down rather than performed here, because this component
   * has no tab-history wiring of its own and should not grow any.
   *
   * Optional: a list rendered without it simply does not offer the link.
   */
  onOpenSequence?: (sequenceId: string, sequenceName: string | null) => void
}) {
  const actionTarget = useProspectEntryActionTarget()
  // Only a chat card gives its rows their own target (prospecting-card.tsx).
  const inChatCard = actionTarget !== null
  const [detail, setDetail] = useState<ListDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [icpOpen, setIcpOpen] = useState(false)
  const [icpDraft, setIcpDraft] = useState<Icp | null>(null)
  const [icpSaving, setIcpSaving] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  /** The header's settings popover (Liam, 2026-09-05: "add a settings button
   *  and when you click it it should show these options instead of having
   *  them all at the top level"). Two levels: the menu, and the run history
   *  behind its "Run history" item. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<'menu' | 'runs'>('menu')
  /** The delete confirmation, opened from the settings menu's last item. */
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addDomain, setAddDomain] = useState('')
  const [adding, setAdding] = useState(false)
  const [addNotice, setAddNotice] = useState<string | null>(null)

  const [selection, setSelection] = useState<BulkSelectionInfo | null>(null)
  const [dismissIds, setDismissIds] = useState<string[] | null>(null)
  const [savingSelection, setSavingSelection] = useState(false)
  /** The list-level publish is in flight — the header button and the
   *  story's own Publish doorway both wait on it. */
  const [publishing, setPublishing] = useState(false)
  /** The title is a field while this is set (Liam, 2026-09-06: "click on
   *  this and rename the list"). The draft is committed on Enter/blur,
   *  dropped on Escape. */
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  /**
   * WHAT THE LAST SAVE DID, kept on screen (C5).
   *
   * A save used to report only through `toast.success` — four seconds, in a
   * corner, gone. That was survivable while Save was a button on this page that
   * the user had just pressed. It stopped being survivable when Scout could
   * save from the chat strip beside the list: the stage counts move, the user
   * pressed nothing, and there is no toast to miss because there was never a
   * gesture to attach one to.
   *
   * ONE story at a time, newest wins, dismissible — the same contract
   * `dismissedOutcomeId` gives a run's outcome banner. Both origins (this page
   * and Scout) write the same shape, so the sentence a user reads is the same
   * sentence either way.
   */
  const [story, setStory] = useState<SaveStory | null>(null)

  const [openEntry, setOpenEntry] = useState<ProspectListEntryRow | null>(null)
  const [entryBusy, setEntryBusy] = useState(false)
  /**
   * The ENTRY behind a panel that was opened by a save rather than by a click.
   *
   * A save clears `openEntry` (the candidate it named is now a CRM record) and
   * opens `CompanyDetailPanel`/`ContactDetailPanel` instead — so without this
   * the covered list would lose its highlight, and closing the detail would
   * drop the user back onto a list with nothing marking the row they just
   * acted on. Kept separate from `openEntry` so it can never resurrect the
   * pre-save panel; it only feeds the row highlight and prev/next.
   */
  const [savedFromEntryId, setSavedFromEntryId] = useState<string | null>(null)
  /** The company promoted by the last Save — after Save the panel is the
   *  EXISTING CompanyDetailPanel, not a bespoke one (§10, Page 4). The title
   *  rides alongside because that panel draws no header of its own: the
   *  breadcrumb above it is where the company is named, and it needs the name
   *  BEFORE the panel has fetched anything. */
  const [savedCompanyId, setSavedCompanyId] = useState<string | null>(null)
  const [savedCompanyTitle, setSavedCompanyTitle] = useState<string | null>(null)
  /** The CONTACT promoted by the last Save, under the same treatment (§10,
   *  Page 4: "after Save it is the existing ContactDetailPanel"). A separate
   *  pair rather than a discriminated one so the two paths cannot clobber each
   *  other's title when a mixed selection saves both. */
  const [savedContactId, setSavedContactId] = useState<string | null>(null)
  const [savedContactTitle, setSavedContactTitle] = useState<string | null>(null)
  /**
   * The Prospecting section injected at the top of the post-save panel: which
   * list this person came from, how their ACCOUNT scored, and the identity
   * line. It is per-list verdict — the thing that lives on the entry and never
   * on the CRM record (§8, "what stays on the entry vs the record") — so the
   * panel below it cannot render it and it has to be carried across.
   */
  const [savedContactContext, setSavedContactContext] = useState<
    { fitScore: number | null; fitRationale: string | null; identityState: string; company: string | null } | null
  >(null)

  /**
   * contact_id → sequence membership for every SAVED contact on this list,
   * DERIVED at read time from `sequence_enrollment` (§8). Fetched once per list
   * load and again after an enrollment, and PUBLISHED to the row renderer,
   * which cannot be handed a prop through the shared views layout.
   */
  const [sequenced, setSequenced] = useState<SequencedMap>({})

  // ── Run surface (§9) ──
  const [findOpen, setFindOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [alreadyRunning, setAlreadyRunning] = useState(false)
  const [canceling, setCanceling] = useState(false)
  /** Set once the user dismisses a terminal run's banner. Keyed by run id so a
   *  NEW run's outcome always shows: dismissing round 1's result must not
   *  swallow round 2's (§9, dismiss-while-running). */
  const [dismissedOutcomeId, setDismissedOutcomeId] = useState<string | null>(null)
  /**
   * THE STAGE TAB the user picked — All · Saved · Needs review · Dismissed,
   * drawn by the shared views toolbar beside this list's custom views (see
   * @/lib/views/prospect-stage-tabs). `null` until the list has loaded: the
   * OPENING tab is decided from the first counts in `load` — Saved once
   * anything is saved, All before that — and never re-decided, so a user
   * pruning on All is not yanked over to Saved by their first save.
   */
  const [stagePick, setStagePick] = useState<ProspectStageTab | null>(null)
  const filter: ProspectStageTab = stagePick ?? 'all'
  /**
   * THE CUSTOM VIEW THAT IS OPEN, if any — reported by the shared layout,
   * which owns the selection (and restores it from localStorage). A tab and
   * a view are mutually exclusive, the way "Assigned to me" and a saved view
   * are on the Actions list: while a view is open the tab steps aside and the
   * view runs on the baseline, everything still on the list.
   */
  const [activeCustomViewId, setActiveCustomViewId] = useState<string | null>(null)
  /** The layout's own view selector, handed up on mount (`onViewSelectorReady`). */
  const selectViewRef = useRef<
    ((viewId: string | null, opts?: { silent?: boolean }) => void) | null
  >(null)
  const handleViewSelectorReady = useCallback(
    (select: (viewId: string | null, opts?: { silent?: boolean }) => void) => {
      selectViewRef.current = select
    },
    [],
  )
  /** The tab in force — none while a custom view is open. */
  const effectiveStage: ProspectStageTab | null = activeCustomViewId ? null : filter
  /**
   * PEOPLE ARE NESTED UNDER THEIR COMPANY (Liam, 2026-09-05): the list queries
   * companies, the views route attaches each company's people as inline
   * `children`, and the list draws them as expandable child rows. The one
   * place people are listed flat is the Needs review tab — an exception view
   * over the people the save gate held back — so `kind` is derived from the
   * tab rather than chosen with a toggle. It is what the query and the tab
   * counts scope to. A custom view queries companies, like every other tab.
   */
  const kind: ProspectEntryKind = effectiveStage === 'needs_review' ? 'person' : 'company'
  const [peopleOpen, setPeopleOpen] = useState(false)
  /** Bumped whenever a run settles, so an open history popover refreshes. */
  const [historyKey, setHistoryKey] = useState(0)
  /**
   * The workspace's monthly ceiling, re-read on the SAME key the run history
   * uses — a run settling is exactly the event that moves this number, and it
   * is the moment the Find dialog is most likely to be opened again.
   *
   * The dialog and the `monthly_cap` outcome both read it. A null (loading, or
   * a failed read) gates nothing and drops the date clause: the server owns the
   * refusal either way, and a client-side "no" invented by a footnote that
   * would not load is worse than no footnote.
   */
  const { spend } = useSpend(historyKey)

  /**
   * WHAT SCOUT IS DOING TO THIS LIST (C2/C3), published by the chat panel
   * beside it into a module store — there is no prop channel between a tab's
   * content pane and its chat strip.
   *
   * `version` drives a refetch: a save Scout makes is a write this page's
   * numbers depend on, and nothing else would tell it. (`touched` used to
   * quiet the enrichment gate; the gate is gone — the filter strip's actions
   * are one line already.)
   */
  const scout = useScoutActivity(listId)

  const nameReportedRef = useRef<string | null>(null)
  /** The entries as last loaded, read by `runSave` to name the breadcrumb of
   *  the company it just promoted. A ref rather than a dep so a refetch does
   *  not re-create `runSave` (and with it the selection bar's handlers) on
   *  every poll. */
  const entriesRef = useRef<ProspectListEntryRow[]>([])
  const openEntryRef = useRef<ProspectListEntryRow | null>(null)

  const load = useCallback(async () => {
    try {
      const payload = await fetchList(listId)
      setDetail(payload)
      // The opening tab, decided once from the first counts and kept from
      // then on (`prev ??`): every later refetch — poll ticks, Scout's saves —
      // leaves whatever the user is on alone.
      setStagePick((prev) => prev ?? defaultProspectStageTab(payload.entry_counts))
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load this list'))
    } finally {
      setLoading(false)
    }
  }, [listId])

  useEffect(() => {
    setLoading(true)
    // A different list decides its own opening tab.
    setStagePick(null)
    void load()
  }, [load])

  /**
   * Load the derived Sequenced map. Called on list load and after an
   * enrollment — NOT on every poll tick: it is a join over
   * `sequence_enrollment` and nothing a discovery run does can change it.
   *
   * A failure is SILENT and leaves the map empty. The chip is additive
   * information; a list that renders without it is complete, and an error
   * banner for a decoration would be worse than the missing decoration.
   */
  const loadSequenced = useCallback(async () => {
    try {
      setSequenced(await fetchSequenced(listId))
    } catch {
      setSequenced({})
    }
  }, [listId])

  useEffect(() => {
    void loadSequenced()
  }, [loadSequenced])

  /**
   * Publish the map to the row renderer, and CLEAR IT ON UNMOUNT.
   *
   * The store is module-level (the shared views layout passes a row only its
   * item and the view's display properties, so there is no prop channel), and
   * a map left behind by list A would paint Sequenced chips on list B's rows —
   * every id would miss, but a saved contact shared between two lists would
   * hit, which is worse than a blanket error because it looks right.
   */
  //
  // A list in a chat card publishes nothing: these stores are the page's, one
  // per app, and the card clearing them on unmount would wipe the real page's.
  useEffect(() => {
    if (inChatCard) return
    publishProspectSequenced(sequenced)
    return () => publishProspectSequenced({})
  }, [sequenced, inChatCard])

  // The 3s poll (§9). `onTick` refetches the list detail AND nudges the shared
  // views layout, so each round's candidates appear as the engine commits them
  // rather than after a four-minute blank screen.
  const onPollTick = useCallback(() => {
    refreshEntries()
    void load()
  }, [load])
  const runPoll = useRunPoll({ listId, onTick: onPollTick })
  const run = runPoll.run
  const runLive = runPoll.isLive
  /** For the rows (ProspectListActivityContext): is anything live, is it the
   *  profile run (the one that scores the unscored rows), and — for a people
   *  run — which companies it is searching, so those rows draw the orb in
   *  place of Find people. The page draws no rail for a people run; the rows
   *  are the rail (Liam, 2026-09-06). */
  const activity = useMemo<ProspectListActivity>(
    () => ({
      runLive,
      profiling: runLive && run?.kind === 'account_card',
      findingPeople:
        runLive && run?.kind === 'people'
          ? {
              ids: new Set(run.target_entry_ids ?? []),
              since: run.started_at ?? run.created_at,
            }
          : null,
    }),
    [runLive, run?.kind, run?.target_entry_ids, run?.started_at, run?.created_at],
  )
  const runProgress = useMemo(() => readProgress(run?.progress), [run?.progress])

  /**
   * ADOPT A RUN SOMEONE ELSE STARTED (§B5b).
   *
   * `useRunPoll` resumes an unknown live run at MOUNT and never again — which
   * was complete when the only way to start one was to press a button on this
   * very page. Scout now starts runs from the chat strip beside this list
   * without unmounting anything, so without this the rail would stay blank for
   * the entire run and the Find button would stay enabled over a live run.
   *
   * `track` rather than `adopt`: the feed re-reports the same run every 5s, and
   * overwriting the 3s poll's fresher progress with the feed's staler copy
   * would make the rail tick backwards twice a minute. `track` is a no-op once
   * the poll owns the run.
   *
   * AND NOT OVER A RUN THE USER OPENED. `track`'s own guard only knows the run
   * the poll is following, so once the user picks a past run out of the history
   * popover (`onOpenRun` → `adopt`), the feed's next fresh object — a new
   * reference every 5s — would pass that guard and yank the rail back to the
   * live run, over and over. That pick is PINNED (`pinnedRunIdRef`) and the
   * feed leaves it alone.
   *
   * BUT A RUN THAT MERELY SETTLED ON SCREEN YIELDS. Discovery hands off to the
   * profile run by itself the moment it finishes, so the common case is: the
   * poll follows discovery to `completed`, the outcome banner shows, and five
   * seconds later the feed reports the profile run — live, scoring the rows
   * the user is looking at. That run MUST take the rail (and the entry
   * refetch that rides on the poll), or the list sits on a stale outcome with
   * dashes while 50 scores land unseen. Seen live on 2026-09-06.
   */
  const activeRuns = useActiveRuns({ enabled: true })
  const agentRun = activeRuns.byListId.get(listId) ?? null
  const trackRun = runPoll.track
  /** The terminal run the user opened from history, if any — the one settled
   *  run the feed may not replace. Cleared by the next adoption. */
  const pinnedRunIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agentRun) return
    if (run && !run.is_live && pinnedRunIdRef.current === run.id) return
    pinnedRunIdRef.current = null
    trackRun(agentRun)
  }, [agentRun, run, trackRun])

  // A settled run refreshes the history popover once. `runLive` going false is
  // the edge; the run id is in the deps so two runs in a row each fire.
  const settledRunRef = useRef<string | null>(null)
  useEffect(() => {
    if (!run || run.is_live) return
    if (settledRunRef.current === run.id) return
    settledRunRef.current = run.id
    setHistoryKey((k) => k + 1)
  }, [run])

  // Report the real name exactly once per value — the parent re-navigates to
  // the same location on each call, and reporting an unchanged name would push
  // a redundant history step on every refetch.
  useEffect(() => {
    const name = detail?.list.name
    if (!name || nameReportedRef.current === name) return
    nameReportedRef.current = name
    onNameLoaded?.(name)
  }, [detail?.list.name, onNameLoaded])

  // Keep the lookup table fresh without putting `detail` in runSave's deps.
  // The open entry is tracked too: saving from the entry panel clears
  // `openEntry` as part of the same handler, so by the time the title is read
  // the state has already moved on.
  useEffect(() => {
    if (detail?.entries) entriesRef.current = detail.entries
  }, [detail?.entries])
  useEffect(() => {
    if (openEntry) openEntryRef.current = openEntry
  }, [openEntry])

  const icp = useMemo(() => parseIcp(detail?.list.icp), [detail?.list.icp])
  const counts = detail?.entry_counts
  const total = counts?.total ?? 0

  // ── Filter chips (Package B's component, this page's data) ──
  //
  // Counts come from the ENTRIES this page already loaded, not from a second
  // query: `fetchList` returns the full entry set and the stage tallies.
  const entries = detail?.entries

  /**
   * COMPANY entries only, split by whether they have been researched.
   *
   * §9's gate — now the filter strip's two actions — is keyed on the DATA,
   * not on a run event: a company entry
   * whose `research` blob is empty is work the account-card stage would do,
   * and it stays true across a reload, a second visit and a browser tab that
   * was closed while the run finished. A gate keyed on "a discovery run just
   * completed" would vanish on refresh and strand eighteen unresearched
   * companies with no affordance.
   *
   * DISMISSED ROWS ARE EXCLUDED from both halves — the route rejects them and
   * §9 is explicit that dismissing while running removes companies from the
   * pending queue. Counting them would quote money for work that will not
   * happen.
   */
  const companyEntries = useMemo(
    () => (entries ?? []).filter((e) => e.kind === 'company' && e.stage !== 'dismissed'),
    [entries],
  )
  /**
   * The filter strip's two populations, both keyed on WORK THAT REMAINS.
   *
   * The research half is companies with an empty `research` blob. The people
   * half is the same idea one stage along: a researched company that has NO
   * person entries yet. Keying the people half on "researched" alone would
   * re-offer — and re-bill — a search over companies whose people have all
   * already been found, and every one of those people would come back
   * suppressed as `this_list`. The banner has to disappear exactly when there
   * is nothing left to spend on, which is what the research half already does.
   *
   * Both halves are also capped at `MAX_ENTRIES_PER_TARGETED_RUN` at the point
   * the NUMBERS ARE SHOWN, not just where the run starts: a consent screen
   * that quotes 80 companies and then runs 50 is a price that does not bind.
   */
  const gateCounts = useMemo(() => {
    // Person entries hang off their account by `parent_entry_id`, so the set
    // of accounts already worked is one pass over the rows this page loaded —
    // dismissed people excluded, since a dismissed person is not a reason to
    // stop looking for that company's buyers.
    const withPeople = new Set(
      (entries ?? [])
        .filter((e) => e.kind === 'person' && e.stage !== 'dismissed')
        .map((e) => e.parent_entry_id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    )
    // `hasAccountCard`, not "the research blob is non-empty": discovery writes
    // a research blob of its own, so the old test reported every discovered
    // company as already researched and offered the account card to nobody.
    // A company the ICP's anti rule zeroed at discovery has a score and no
    // card, and needs neither: the user said "never" to it. Only a company
    // with NO score is owed a profile — the "Enrich · N" fallback must not
    // count the excluded ones forever.
    const unresearched = companyEntries.filter((e) => !hasAccountCard(e) && e.fit_score === null)
    const needPeople = companyEntries.filter(
      (e) => hasAccountCard(e) && !withPeople.has(e.id),
    )
    return {
      unresearched,
      unresearchedCount: unresearched.length,
      /** Researched companies with no people yet — the people stage's real
       *  population, and the exact set `confirmPeople` targets. */
      needPeople,
      needPeopleCount: needPeople.length,
    }
  }, [companyEntries, entries])

  const filterCounts = useMemo(() => {
    // THE CURRENT KIND ONLY: companies, whose people ride beneath them as
    // child rows and are not rows of this list in their own right — except in
    // the Needs review view, where the rows ARE people. Never both kinds
    // added together.
    const rows = (entries ?? []).filter((e) => e.kind === kind)
    return {
      // "All" is everything STILL ON the list: a dismissed row left it (that is
      // what dismissing is for) and is counted under Dismissed instead.
      all: rows.filter((e) => e.stage !== 'dismissed').length,
      saved:
        kind === 'person'
          ? (counts?.saved_people ?? rows.filter((e) => e.stage === 'saved').length)
          : (counts?.saved ?? rows.filter((e) => e.stage === 'saved').length),
      // The PERSISTED signal, not the transient save-time refusal: `needs_review`
      // is a real `identity_state` value on a person row (an employer we could
      // not verify), which is what makes it countable before anyone presses Save
      // and filterable after. Counted over BOTH kinds, unlike the other tabs:
      // it is an exception cue, and a user on Companies should still see that
      // a person is held back — picking it switches the query to people (see
      // `kind`). Dismissed people are out: they left the list.
      needs_review: (entries ?? []).filter(
        (e) => e.identity_state === 'needs_review' && e.stage !== 'dismissed',
      ).length,
      dismissed:
        kind === 'person'
          ? rows.filter((e) => e.stage === 'dismissed').length
          : (counts?.dismissed ?? rows.filter((e) => e.stage === 'dismissed').length),
    }
  }, [entries, kind, counts?.saved, counts?.saved_people, counts?.dismissed])


  /**
   * The list scope plus whatever the tab in force narrows to.
   *
   * These ride as `scopeFilters`, the SAME mechanism the list scope already
   * uses, because `stage` and `identity_state` are real filterable columns
   * (FILTERABLE_FIELDS.prospect_list_entry) and the generic `eq` path handles
   * both — no client-side filtering, so the count on the tab and the rows on
   * screen come from one query and cannot disagree, and pagination keeps
   * working. "All" adds NOTHING: the server hides dismissed rows unless a
   * filter names `stage`, which is also what lets a custom view built as
   * "Stage is dismissed" be honoured. While a custom view is open no tab is in
   * force and the view narrows on its own terms.
   */
  const scopeFilters = useMemo(() => {
    // The KIND rides in the same array as the tab, for the same reason:
    // `kind` is a real filterable column (FILTERABLE_FIELDS.prospect_list_entry)
    // so the generic `eq` path narrows the query itself. Client-side splitting
    // would break pagination and let the tab count and the visible rows
    // disagree the moment a list is longer than one page.
    const base = [
      ...prospectListScopeFilters(listId),
      { id: '__tab_kind', field: 'kind', operator: 'is' as const, value: kind },
    ]
    return effectiveStage ? [...base, ...prospectStageTabFilters(effectiveStage)] : base
  }, [listId, effectiveStage, kind])

  /**
   * Pick a stage tab. Clears the open custom view FIRST — the toolbar does the
   * same when the tab is clicked there, but the save story's "open Saved" link
   * reaches this directly, and a tab and a view must never both read as
   * selected. `silent`: the clear is plumbing for the tab switch, not a view
   * pick, so it must not record a history step.
   */
  const applyStage = useCallback((next: ProspectStageTab) => {
    selectViewRef.current?.(null, { silent: true })
    setStagePick(next)
  }, [])

  // ── ICP panel ──
  const openIcp = () => {
    setIcpDraft(icp)
    setIcpOpen(true)
  }

  const commitIcp = async () => {
    if (!icpDraft) return
    setIcpSaving(true)
    try {
      const result = await patchList(listId, { icp: icpDraft })
      setDetail((prev) => (prev ? { ...prev, list: result.list } : prev))
      setIcpOpen(false)
      // Be honest about the version bump rather than drifting every entry
      // badge on a no-op edit — the server only bumps when the normalized ICP
      // actually differs.
      toast.success(
        result.icp_version_bumped
          ? `ICP saved — entries found before this edit are on version ${result.list.icp_version - 1}`
          : 'ICP saved',
      )
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the ICP'))
    } finally {
      setIcpSaving(false)
    }
  }

  // ── Runs (§9) ──
  /**
   * Start a run. A 409 `RUN_ALREADY_LIVE` is the one-live-run-per-list index
   * doing its job on a double-press — the dialog says "Already running" and we
   * ATTACH to whatever is in flight (`refresh` re-probes the newest run),
   * rather than rendering the red error a raw 409 would otherwise produce.
   */
  const beginRun = useCallback(
    async () => {
      setStarting(true)
      setAlreadyRunning(false)
      try {
        const started = await startRun(listId)
        runPoll.adopt(started)
        setDismissedOutcomeId(null)
        setFindOpen(false)
      } catch (err) {
        if (errorCode(err) === 'RUN_ALREADY_LIVE') {
          setAlreadyRunning(true)
          await runPoll.refresh()
          setFindOpen(false)
        } else {
          toast.error(errorMessage(err, 'Could not start the run'))
        }
      } finally {
        setStarting(false)
      }
    },
    [listId, runPoll],
  )

  /**
   * Start an `account_card` or `people` run over an explicit selection.
   *
   * The kickoff route requires `entry_ids` for both kinds and this is where
   * §9's cost guarantee is actually enforced client-side: the per-company
   * stages run ONLY on entries the user picked (a chip's population or a
   * selection), never the whole
   * list. The 50-per-run cap is applied here rather than left to the route's
   * 400, so a 60-company selection runs the first 50 and says so instead of
   * failing.
   *
   * The 409 branch is identical to `beginRun`'s, and deliberately: the
   * one-live-run-per-list index does not care which kind is in flight, so
   * pressing Research while a discovery run is still settling has to attach
   * rather than paint an error.
   */
  const beginTargetedRun = useCallback(
    async (
      kind: 'account_card' | 'people',
      entryIds: string[],
      /** A re-run of a settled run's own targets: the table selection is not
       *  what ran, so it is left alone. */
      opts?: { keepSelection?: boolean },
    ) => {
      if (entryIds.length === 0) return
      const ids = entryIds.slice(0, MAX_ENTRIES_PER_TARGETED_RUN)
      setStarting(true)
      setAlreadyRunning(false)
      try {
        const started = await startRun(listId, { kind, entryIds: ids })
        runPoll.adopt(started)
        setDismissedOutcomeId(null)
        setPeopleOpen(false)
        if (!opts?.keepSelection) selection?.onClear()
      } catch (err) {
        if (errorCode(err) === 'RUN_ALREADY_LIVE') {
          setAlreadyRunning(true)
          await runPoll.refresh()
          setPeopleOpen(false)
        } else {
          toast.error(errorMessage(err, 'Could not start the run'))
        }
      } finally {
        setStarting(false)
      }
    },
    [listId, runPoll, selection],
  )

  /** Resume/Retry from the outcome banner re-runs the SAME kind of run: a
   *  stopped profile or people run goes again over its own targets (leaving
   *  the table selection as it is), never as a fresh discovery run. A targeted
   *  run that carries no targets cannot be re-run, and says so. */
  const rerunOutcome = useCallback(
    async (settled: RunPayload) => {
      if (settled.kind !== 'account_card' && settled.kind !== 'people') return beginRun()
      const targets = settled.target_entry_ids ?? []
      if (targets.length === 0) {
        toast.error('This run has no companies to run again. Select them and start it from the list.')
        return
      }
      return beginTargetedRun(settled.kind, targets, { keepSelection: true })
    },
    [beginRun, beginTargetedRun],
  )

  /**
   * The rows the list is currently showing, in order, as the shared views
   * layout reports them.
   *
   * Held in a ref for the callbacks and mirrored into state as an ID SEQUENCE
   * so a realtime row patch — which re-reports every item on every event while
   * the list is mounted beside an open pane — only re-renders this page when
   * the order actually changed.
   */
  const visibleItemsRef = useRef<VisibleItem[]>([])
  const [visibleItemIds, setVisibleItemIds] = useState<string[]>([])
  const handleVisibleItemsChange = useCallback((items: VisibleItem[]) => {
    visibleItemsRef.current = items
    const ids = items.map((it) => it.id)
    setVisibleItemIds((prev) =>
      prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
    )
  }, [])

  /**
   * What the toolbar's two actions act on: the companies the CURRENT tab
   * shows that still owe the stage. "Enrich · 12" on All is every company
   * still on the list without a profile — the user prunes first, then enriches
   * what is left; on Saved it is the saved ones. The tab IS the choice, and
   * the rows' own checkboxes (and their Enrich buttons) are "choose manually".
   *
   * Under a CUSTOM VIEW the population is the rows the view is showing — which
   * only the layout knows, so it is read off the visible-item report rather
   * than re-deriving the view's filters here. Needs review is a people filter
   * and Dismissed rows are already out of the gate sets, so both scope to
   * nothing and the actions hide.
   */
  const scopedTargets = useMemo(() => {
    const visible = effectiveStage === null ? new Set(visibleItemIds) : null
    const inFilter = (e: (typeof companyEntries)[number]): boolean => {
      switch (effectiveStage) {
        case 'all':
          return true
        case 'saved':
          return e.stage === 'saved'
        case null:
          return visible!.has(e.id)
        default:
          return false
      }
    }
    return {
      profile: gateCounts.unresearched.filter(inFilter),
      people: gateCounts.needPeople.filter(inFilter),
    }
  }, [effectiveStage, gateCounts, visibleItemIds])

  /**
   * Confirm the people run, persisting `people_per_company` when it changed.
   *
   * The PATCH is fire-and-forget-ish on purpose: it is a preference, and a
   * failed preference write must not block a run the user has already paid
   * attention to. The engine reads the list's stored value, so the run that
   * follows uses whatever landed — which is why the PATCH is awaited before
   * the run starts rather than raced with it.
   */
  const confirmPeople = useCallback(
    async (peoplePerCompany: number) => {
      // The SAME set the button and the dialog counted — the profiled
      // companies in the current view that have no people yet — so what was
      // confirmed and what runs are one population.
      const targets = scopedTargets.people
      if (peoplePerCompany !== detail?.list.people_per_company) {
        try {
          const result = await patchList(listId, { people_per_company: peoplePerCompany })
          setDetail((prev) => (prev ? { ...prev, list: result.list } : prev))
        } catch {
          // A preference that would not save is not worth blocking the run
          // the user just consented to; the engine falls back to the stored
          // value, which is the one they were shown before editing.
        }
      }
      await beginTargetedRun('people', targets.map((e) => e.id))
    },
    [beginTargetedRun, scopedTargets.people, detail?.list.people_per_company, listId],
  )

  const requestCancel = useCallback(async () => {
    if (!run) return
    setCanceling(true)
    try {
      // The route returns `canceling`, not `canceled`: the engine settles it
      // once it stops between steps, and the poll observes that. Results are
      // kept either way, which is what the copy promises.
      runPoll.adopt(await cancelRun(run.id))
      toast.success('Cancelling — results are kept')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not cancel the run'))
    } finally {
      setCanceling(false)
    }
  }, [run, runPoll])


  // ── Hand-add by domain ──
  const commitAdd = async () => {
    const domain = addDomain.trim()
    if (!domain) return
    setAdding(true)
    setAddNotice(null)
    try {
      const result = await addEntryByDomain(listId, domain)
      if (result.status === 'exists') {
        // NOT an error: this is dedup layer 2 doing its job (§6). Say what is
        // true — the candidate is already here — and keep the input open so a
        // second paste is one keystroke away.
        setAddNotice('Already on this list')
      } else {
        setAddDomain('')
        setAddOpen(false)
        toast.success('Added to the list')
      }
      refreshEntries()
      void load()
    } catch (err) {
      setAddNotice(errorMessage(err, 'Could not add that domain'))
    } finally {
      setAdding(false)
    }
  }

  /**
   * The account a person hangs off, by name.
   *
   * Prefers the PARENT ENTRY this page already loaded (it is the live name, and
   * it is what the link will open), falling back to the `company_name` the
   * people stage denormalised into `candidate` at insert. Both exist because
   * `company_id` is NULL on a person by construction and the shared views
   * select carries no join — see `ProspectCandidate.company_name`.
   */
  const parentNameFor = useCallback((entry: ProspectListEntryRow): string | null => {
    if (entry.kind !== 'person') return null
    if (entry.parent_entry_id) {
      const parent = entriesRef.current.find((e) => e.id === entry.parent_entry_id)
      if (parent) return candidateTitle(parent)
    }
    const raw = entry.candidate
    const candidate =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { company_name?: unknown })
        : null
    return typeof candidate?.company_name === 'string' && candidate.company_name.trim()
      ? candidate.company_name.trim()
      : null
  }, [])

  // ── Save / Dismiss ──
  /**
   * THE OUTCOME OF A SAVE OR A PUBLISH, in the surface that fits it (C5).
   *
   * A SINGLE row still toasts, and rightly: the user pressed one row's
   * control and the list beside it moves, so the toast is a confirmation
   * beside a result, not the result itself.
   *
   * A MULTI-ROW outcome gets the BANNER instead. It is a set of counts with
   * somewhere to go — "6 companies and 8 people added · 2 need review" — and
   * each of those numbers is only useful if the rows it counts can be
   * reached. A toast cannot hold a link the user will still be able to press
   * in ten seconds.
   */
  const tellOutcome = useCallback(
    (kind: 'saved' | 'published', result: SaveResult, listName: string | null = null) => {
      if (result.saved.length === 1 && result.skipped.length === 0) {
        toast.success(summarizeSaveResult(result, kind))
        return
      }
      setStory({
        kind,
        listName,
        companies: result.saved.filter((s) => s.kind === 'company').length,
        people: result.saved.filter((s) => s.kind === 'person').length,
        // The transient refusal, NOT the persisted column: this counts the
        // people THIS publish held back, which is the number the sentence is
        // about. (The chip the banner opens reads the column, which is the
        // wider set — every unverified person on the list. That is the correct
        // destination: once the user is looking, all of them are the same
        // problem.)
        needsReview: result.skipped.filter((s) => s.reason === 'needs_review').length,
        skippedOther: result.skipped.filter((s) => s.reason !== 'needs_review').length,
        // Filled in later if this was the first half of an add-to-sequence —
        // the enroll reports back through `onEnrolled`.
        enrolled: null,
        source: 'page',
        at: Date.now(),
      })
    },
    [],
  )

  /**
   * SAVE IS CURATION (Liam, 2026-09-06): the rows go ON THE LIST, and the
   * CRM sees nothing until the list is published. The one exception is the
   * per-row `confirmUnverified` — the namesake gate's escape hatch — which
   * PUBLISHES that one person (the gate lives at publish time now, and a
   * confirm that only curated would leave the user pressing it twice).
   */
  const runSave = useCallback(
    async (entryIds: string[], options: { confirmUnverified?: boolean } = {}) => {
      if (entryIds.length === 0) return
      setSavingSelection(true)
      try {
        if (options.confirmUnverified === true) {
          // ONE id, from a row or panel that asked first — never a batch.
          const result = await publishEntries(entryIds, true)
          tellOutcome('published', result)

          // ── Open what was just created ──
          //
          // The one place a single press still makes a CRM record: the person
          // the user just vouched for. Open it, with the per-list verdict the
          // CRM record cannot carry on its own. (A list publish has no single
          // record to show, and opening the first of forty would be an
          // arbitrary choice presented as a result.)
          if (result.saved.length === 1) {
            const promoted = result.saved[0]
            const savedEntry =
              openEntryRef.current?.id === promoted.entry_id
                ? openEntryRef.current
                : entriesRef.current.find((e) => e.id === promoted.entry_id)
            // Name the crumb from the entry that was published — the id alone
            // would leave the breadcrumb reading "<list> › Contact".
            const title = candidateTitle(savedEntry)
            // Remember the row this panel came from so the list beside it
            // keeps it highlighted — `setOpenEntry(null)` below is about to
            // drop the only other record of which row this was.
            setSavedFromEntryId(promoted.entry_id)
            if (promoted.contact_id) {
              setSavedContactTitle(title)
              const parent = savedEntry?.parent_entry_id
                ? entriesRef.current.find((e) => e.id === savedEntry.parent_entry_id)
                : undefined
              setSavedContactContext({
                fitScore: parent?.fit_score ?? null,
                fitRationale: parent?.fit_rationale ?? null,
                identityState: savedEntry?.identity_state ?? 'resolved',
                company: savedEntry ? parentNameFor(savedEntry) : null,
              })
              setSavedContactId(promoted.contact_id)
            } else if (promoted.company_id) {
              setSavedCompanyTitle(title)
              setSavedCompanyId(promoted.company_id)
            }
          }
        } else {
          const result = await saveEntries(entryIds)
          tellOutcome('saved', result)
        }
        selection?.onClear()
        setOpenEntry(null)
        refreshEntries()
        void load()
        // A published person may already be in a sequence from another list —
        // the chip is derived, so the only way to know is to re-read it.
        void loadSequenced()
      } catch (err) {
        toast.error(errorMessage(err, 'Could not save'))
      } finally {
        setSavingSelection(false)
      }
    },
    [load, loadSequenced, parentNameFor, selection, tellOutcome],
  )

  /**
   * PUBLISH — the list becomes (or updates) its group in the CRM. Everything
   * saved that the CRM does not hold yet is promoted and filed under the
   * list; a second press with nothing new says so and writes nothing.
   */
  const runPublish = useCallback(async () => {
    setPublishing(true)
    try {
      const result = await publishList(listId)
      if (result.saved.length === 0 && result.skipped.length === 0) {
        toast.success('Everything on the list is already in your CRM')
      } else {
        tellOutcome('published', result, result.list_name ?? detail?.list.name ?? null)
      }
      refreshEntries()
      void load()
      void loadSequenced()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not publish the list'))
    } finally {
      setPublishing(false)
    }
  }, [detail?.list.name, listId, load, loadSequenced, tellOutcome])

  // ── Rename, from the title ──
  //
  // The name is the one thing about a list every other surface repeats — the
  // tab, the index card, the CRM's "From list" chip, Scout's own chips — so
  // the write is followed by `announceProspectListChanged`, which is how the
  // surfaces that spelled the name out at mount learn to read it again.
  // Everything keyed on the id (CRM rows, saved views) needs nothing.
  const startRename = useCallback(() => {
    if (!detail) return
    setNameDraft(detail.list.name)
    setRenaming(true)
  }, [detail])

  useEffect(() => {
    if (!renaming) return
    const input = nameInputRef.current
    input?.focus()
    input?.select()
  }, [renaming])

  const commitRename = useCallback(async () => {
    setRenaming(false)
    const next = nameDraft.trim()
    if (!detail || !next || next === detail.list.name) return
    try {
      const result = await patchList(listId, { name: next })
      setDetail((prev) => (prev ? { ...prev, list: result.list } : prev))
      announceProspectListChanged({ id: listId, name: result.list.name })
    } catch (err) {
      toast.error(
        errorCode(err) === 'LIST_NAME_TAKEN'
          ? 'A list with that name already exists'
          : errorMessage(err, 'Could not rename the list'),
      )
    }
  }, [detail, listId, nameDraft])

  const cancelRename = useCallback(() => {
    // Reset the draft BEFORE closing: the field's blur fires as it unmounts,
    // and a commit that finds the draft equal to the name writes nothing.
    setNameDraft(detail?.list.name ?? '')
    setRenaming(false)
  }, [detail?.list.name])

  /**
   * Add-to-sequence = Save FIRST, then enroll (§8).
   *
   * The dialog takes contact ids and a prospect person has none until Save
   * promotes them, so the flow owns both halves and reconciles the save
   * route's per-entry outcomes against what the user selected. `onSaved`
   * refetches, because the rows the user is looking at have just become CRM
   * records and the Saved chips have to appear.
   */
  const sequenceFlow = useSequenceFlow({
    onSaved: () => {
      selection?.onClear()
      setOpenEntry(null)
      refreshEntries()
      void load()
      // A person promoted here may ALREADY be enrolled from another list —
      // the same contact, a different entry — and the chip is derived, so the
      // only way to learn that is to read the enrollment table again.
      void loadSequenced()
    },
  })

  /** The stable half of the flow, so the row listener does not re-bind on
   *  every render (the hook returns a fresh object each time). */
  const startSequenceFlow = sequenceFlow.start

  const runDismiss = useCallback(
    async (entryIds: string[], reason: ProspectDismissedReason) => {
      // allSettled, not all: a partial failure must still commit the
      // dismissals that landed — each one is an independent suppression
      // record, and rolling them back would re-open candidates the user has
      // already rejected.
      const results = await Promise.allSettled(
        entryIds.map((id) => patchEntryStage(id, 'dismissed', reason)),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        toast.error(`${entryIds.length - failed} dismissed, ${failed} failed`)
      } else {
        toast.success(entryIds.length === 1 ? 'Dismissed' : `${entryIds.length} dismissed`)
      }
      setDismissIds(null)
      selection?.onClear()
      setOpenEntry(null)
      refreshEntries()
      void load()
    },
    [load, selection],
  )

  /**
   * The row → page seam.
   *
   * A row's hover Save/Dismiss buttons cannot call these handlers directly:
   * the row renderer lives in the shared views system (`entity-row.tsx`),
   * which must not import from a feature folder. It states an intent as a
   * CustomEvent (`emitAddToSequence`'s documented pattern) and this page
   * decides what the intent means.
   *
   * BOTH ACTIONS LAND ON THE SAME HANDLERS THE PANEL USES, deliberately.
   * Dismiss in particular routes through `setDismissIds` — the reason dialog —
   * rather than straight to `runDismiss`: two of the four reasons suppress the
   * candidate WORKSPACE-WIDE, so a one-click hover dismiss with no reason
   * would let a row quietly do something the panel makes the user choose.
   * A hover affordance may open a dialog; it may not skip one.
   *
   * `runSave` is a dep (it is re-created when `selection` changes); the
   * listener re-binds with it, which is correct — a stale closure here would
   * clear the wrong selection after a save.
   */
  useEffect(() => {
    const onRowAction = (event: Event) => {
      const detail = (event as CustomEvent<ProspectEntryActionDetail>).detail
      if (!detail?.entryIds?.length) return
      if (detail.action === 'save') {
        // `confirmUnverified` only ever arrives from a row that ASKED first —
        // the row renders the confirm and emits on the answer, so the page
        // does not re-ask.
        void runSave(detail.entryIds, { confirmUnverified: detail.confirmUnverified === true })
      } else if (detail.action === 'sequence') {
        void startSequenceFlow(detail.entryIds)
      } else if (detail.action === 'profile') {
        // A one-company profile (and THE score). Discovery hands off to the
        // profile run by itself now; this is the panel's catch-up path for a
        // company that missed it. One live run per list still holds — a
        // second press while one is going gets the "already running" notice.
        void beginTargetedRun('account_card', detail.entryIds)
      } else if (detail.action === 'people') {
        // The row's Find people button: the people search for this one
        // company, the same run kind the strip's "Find people · N" starts.
        void beginTargetedRun('people', detail.entryIds)
      } else {
        setDismissIds(detail.entryIds)
      }
    }
    // A list in a chat card hears only its own rows (ProspectEntryActionTargetContext).
    const target = actionTarget ?? window
    target.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, onRowAction)
    return () => target.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, onRowAction)
  }, [runSave, startSequenceFlow, beginTargetedRun, actionTarget])

  // Intercept the selection bar's two prospecting-specific ids. `onAction`
  // reaches us through `onBulkSelectionChange`, so neither ever hits the
  // generic bulk endpoint (which has no handler for them).
  const handleBulkSelection = useCallback((info: BulkSelectionInfo) => {
    setSelection(info)
    // "Choose manually" takes the banner down so the checkboxes are the
    // interface. Clearing the selection is the user changing their mind, so
    // the banner comes back — otherwise the only route to it is a reload, and
    // a gate that can be permanently dismissed by pressing a button labelled
    // "choose manually" is a gate that strands the money it was guarding.
  }, [])

  /** The selection's ids, memoized on the ARRAY THE LAYOUT OWNS rather than on
   *  a fresh `?? []` — the fallback allocates a new empty array every render,
   *  which would re-run every memo downstream of it on each keystroke. */
  const selectedIds = useMemo(
    () => selection?.selectedIds ?? EMPTY_IDS,
    [selection?.selectedIds],
  )
  /** What a targeted run over this selection will actually cover.
   *  `beginTargetedRun` slices to the route's 50-per-run cap, so the bar's
   *  price and its count are both read off the capped number. */
  const selectionRunCount = Math.min(selectedIds.length, MAX_ENTRIES_PER_TARGETED_RUN)
  const selectionCapped = selectedIds.length > MAX_ENTRIES_PER_TARGETED_RUN

  /**
   * How many of the selected people carry an email on the CANDIDATE.
   *
   * A prediction, not the answer: the save route is the authority (an existing
   * contact may already hold an address this candidate never carried), and the
   * flow filters on the response. This number exists only to decide whether the
   * button is worth offering at all — zero here means the dialog would open
   * empty, and saying so before the click beats reporting it after.
   */
  /**
   * Which kinds the checked rows are. A nested person row checks like any
   * other row, so a selection can hold companies, people, or both: the bar
   * offers the per-company runs only for a pure company selection (neither
   * stage takes person entries) and the sequence hand-off only when people are
   * in it (a sequence enrolls contacts).
   */
  const selectedKinds = useMemo(() => {
    const chosen = new Set(selectedIds)
    let companies = 0
    let people = 0
    for (const e of entries ?? []) {
      if (!chosen.has(e.id)) continue
      if (e.kind === 'person') people += 1
      else companies += 1
    }
    return { companies, people }
  }, [entries, selectedIds])

  const selectionEmailCount = useMemo(() => {
    if (selectedIds.length === 0) return 0
    const chosen = new Set(selectedIds)
    return (entries ?? []).filter((e) => {
      if (!chosen.has(e.id) || e.kind !== 'person') return false
      const raw = e.candidate
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
      const email = (raw as { email?: unknown }).email
      return typeof email === 'string' && email.trim() !== ''
    }).length
  }, [entries, selectedIds])

  /**
   * PUBLISH WHAT THE USER IS LOOKING AT (§B6).
   *
   * The chat panel beside this list has no prop channel to it — it is a sibling
   * under the tab shell, not a child — so the selection travels through a tiny
   * module-level store that the tab's `systemContext` memo subscribes to. Scout
   * then receives "they have these five entry ids selected" in its system
   * prompt and can act on THAT selection instead of inventing its own.
   *
   * AN EMPTY SELECTION STILL PUBLISHES. "The user is looking at this list with
   * nothing selected" is a different fact from "the user is not on a list at
   * all", and it is the one that lets Scout answer "these" with "which ones?"
   * rather than guessing. Only unmount publishes null.
   *
   * SLICED TO THE RUN CAP. The ids exist to be passed as `entry_ids`, and the
   * route refuses more than 50 — so the prompt carries at most 50, and
   * `selectedCount` carries the untruncated number so Scout can say that the
   * selection is bigger than what it can act on in one run.
   */
  const listName = detail?.list.name ?? ''
  useEffect(() => {
    if (inChatCard) return
    publishProspectingSelection(listId, {
      listId,
      listName,
      tab: kind,
      // The baseline while a custom view is open: still-on-the-list rows,
      // narrowed further by a view Scout cannot see.
      filter: effectiveStage ?? 'all',
      selectedEntryIds: selectedIds.slice(0, MAX_ENTRIES_PER_TARGETED_RUN),
      selectedCount: selectedIds.length,
    })
  }, [listId, listName, kind, effectiveStage, selectedIds, inChatCard])

  // Unmount clears. Deliberately its OWN effect keyed on `listId` alone: folded
  // into the publisher above, the cleanup would fire on every selection change
  // and briefly publish null between each keystroke's re-render.
  useEffect(() => (inChatCard ? undefined : () => publishProspectingSelection(listId, null)), [listId, inChatCard])

  /**
   * SCOUT MUTATED THIS LIST — refetch (C3).
   *
   * `version` bumps only on a tool call this page has not seen before (the
   * store's own contract: a resumed conversation replaying its transcript does
   * not re-bump), so this is one refetch per real write. Runs need no help —
   * `useActiveRuns` already adopts a run Scout started — but a save or a
   * dismiss changes only rows, and nothing else would tell the page.
   *
   * The initial sighting refetches too, deliberately: a user who switches to
   * this tab after Scout worked in the background lands on stale counts, and
   * "the page was already open" is not a reason to show them.
   */
  const scoutVersion = scout?.version ?? 0
  const seenScoutVersionRef = useRef<number | null>(null)
  useEffect(() => {
    if (scoutVersion === 0) return
    if (seenScoutVersionRef.current === scoutVersion) return
    seenScoutVersionRef.current = scoutVersion
    refreshEntries()
    void load()
    void loadSequenced()
  }, [scoutVersion, load, loadSequenced])

  /**
   * TELL SCOUT'S SAVE AS THIS PAGE'S OWN STORY (C5).
   *
   * Same banner, same sentence, same doorways — the only difference is
   * `source`, which the banner does not render. A user who asked Scout to
   * "save the A-tier ones" should not have to learn a second vocabulary for the
   * outcome, nor go back to the chat to find out what happened to their list.
   *
   * Keyed on the tool call id: the store republishes an equal object on any
   * unrelated re-render of the chat panel, and re-setting the story would
   * resurrect a banner the user had dismissed.
   */
  const scoutSave = scout?.lastSave ?? null
  const scoutEnroll = scout?.lastEnroll ?? null
  const seenScoutSaveRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scoutSave) return
    if (seenScoutSaveRef.current === scoutSave.toolCallId) return
    seenScoutSaveRef.current = scoutSave.toolCallId
    setStory({
      kind: scoutSave.published ? 'published' : 'saved',
      companies: scoutSave.saved_companies,
      people: scoutSave.saved_people,
      needsReview: scoutSave.needs_review,
      skippedOther: scoutSave.skipped_other,
      enrolled: null,
      source: 'scout',
      at: Date.now(),
    })
  }, [scoutSave])

  /**
   * An enroll Scout ran merges INTO the story rather than replacing it — save
   * and enroll are one gesture told as one sentence ("8 people added · 8
   * enrolled in Q4 Outbound"), exactly as they are for the page's own
   * add-to-sequence flow.
   *
   * If no story is standing (Scout enrolled contacts that were already in the
   * CRM, with no save of its own) the enroll becomes the whole story: the
   * zero-count save clauses drop and the banner reads as just the enrollment.
   */
  const seenScoutEnrollRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scoutEnroll) return
    if (seenScoutEnrollRef.current === scoutEnroll.toolCallId) return
    seenScoutEnrollRef.current = scoutEnroll.toolCallId
    const enrolled = {
      count: scoutEnroll.enrolled_count,
      sequenceId: scoutEnroll.sequence_id,
      sequenceName: scoutEnroll.sequence_name,
    }
    setStory((prev) =>
      prev
        ? { ...prev, enrolled, at: Date.now() }
        : {
            kind: 'published',
            companies: 0,
            people: 0,
            needsReview: 0,
            skippedOther: 0,
            enrolled,
            source: 'scout',
            at: Date.now(),
          },
    )
  }, [scoutEnroll])

  // ── Detail overlay ──
  // ONE derived descriptor for what is covering the list, so the overlay has a
  // single close path and a single title. Previously the post-save company and
  // the clicked entry were two independent `absolute inset-0` blocks with
  // different close handlers, which is how the post-save one ended up with no
  // way out at all.
  const entryTitle = candidateTitle(openEntry)

  const detailOverlay = savedContactId
    ? ({
        kind: 'contact',
        contactId: savedContactId,
        title: savedContactTitle ?? 'Contact',
        // Only a POST-SAVE contact carries the prospecting context.
        prospecting: savedContactContext,
      } as const)
    : savedCompanyId
      ? ({ kind: 'company', companyId: savedCompanyId, title: savedCompanyTitle ?? 'Company' } as const)
      : openEntry
          ? openEntry.contact_id
            ? // A person entry that is ALREADY saved opens the same
              // ContactDetailPanel a fresh save does — reopening the pre-save
              // candidate panel for a row that has a CRM record would show
              // stale research beside a live record.
              ({
                kind: 'contact',
                contactId: openEntry.contact_id,
                title: entryTitle,
                prospecting: {
                  fitScore: null,
                  fitRationale: null,
                  identityState: openEntry.identity_state,
                  company: parentNameFor(openEntry),
                },
              } as const)
            : openEntry.company_id
              ? ({ kind: 'company', companyId: openEntry.company_id, title: entryTitle } as const)
              : ({ kind: 'entry', entry: openEntry, title: entryTitle } as const)
          : null

  // Every pane that can outrank `openEntry` in `detailOverlay`, cleared in one
  // place. Any path that OPENS a pane has to clear the panes above it first,
  // otherwise the list highlights the new row while the old panel stays on
  // screen — the list and the pane disagreeing about what is open.
  const clearSavedPanes = useCallback(() => {
    setSavedFromEntryId(null)
    setSavedCompanyId(null)
    setSavedCompanyTitle(null)
    setSavedContactId(null)
    setSavedContactTitle(null)
    setSavedContactContext(null)
  }, [])

  const closeDetailOverlay = useCallback(() => {
    clearSavedPanes()
    setOpenEntry(null)
  }, [clearSavedPanes])

  // ── The row the open pane belongs to ──
  //
  // The list is covered while a detail is open, not unmounted, so it still has
  // to be told which row that detail belongs to: closing the sheet reveals the
  // list with the row already highlighted, and stepping with prev/next moves
  // that highlight, so the user always lands back where they were.
  //
  // `openEntry` covers a click; `savedFromEntryId` covers the panel a save
  // opened, whose entry has already been cleared. A LEDGER link has no entry on
  // this list at all (that is what being suppressed means), so it highlights
  // nothing, which is correct.
  const activeEntryId = openEntry?.id ?? savedFromEntryId

  /**
   * Prev/next stepping through the list without leaving the pane, the same
   * gesture Mail has.
   *
   * `undefined` at the ends rather than a no-op handler: the shared breadcrumb
   * header renders the arrows either way and disables the ones with no handler,
   * so the buttons stay put instead of blinking out at the top and bottom of
   * the list.
   *
   * Stepping always lands on `setOpenEntry` — even from a saved record's panel
   * — because the neighbour is a LIST ROW, and a row is opened by the same path
   * a click takes (an already-saved row resolves straight back to its CRM panel
   * through `detailOverlay`).
   */
  const { prevItem, nextItem } = getAdjacentItems(
    activeEntryId,
    // `visibleItemIds` is the render-visible half of the pair; reading the ref
    // here keeps the records fresh while that state drives the re-render.
    visibleItemIds.length > 0 ? visibleItemsRef.current : [],
  )
  const stepTo = useCallback(
    (item: VisibleItem | null) => {
      if (!item) return
      clearSavedPanes()
      setOpenEntry(item.item as unknown as ProspectListEntryRow)
    },
    [clearSavedPanes],
  )
  const onPrevEntry = prevItem ? () => stepTo(prevItem) : undefined
  const onNextEntry = nextItem ? () => stepTo(nextItem) : undefined

  /**
   * WHEN ESCAPE MAY CLOSE THE MODAL.
   *
   * Radix owns the key now — the modal below hands this to
   * `onEscapeKeyDown`, which `preventDefault()`s when the answer is no. There
   * is deliberately NO document-level listener any more: with one, Escape
   * would be handled twice (Radix closes, the listener closes again), and the
   * two would disagree the moment a nested dialog was up.
   *
   * The gate itself is unchanged. A NESTED dialog — the dismiss picker, the
   * ICP sheet, the Find dialog — owns Escape while it is open, and Radix's own
   * stack already routes the key to the topmost layer; the flags here are the
   * belt to that braces, and they also cover the two non-dialog cases: a save
   * or an entry write in flight, where a stray keypress must not yank the
   * panel out from under it.
   *
   * A derived BOOLEAN rather than the `detailOverlay` object, which is rebuilt
   * every render.
   */
  const escapeClosesOverlay =
    detailOverlay !== null &&
    dismissIds === null &&
    !icpOpen &&
    !findOpen &&
    !savingSelection &&
    !entryBusy

  // ── Render ──
  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Prospect list" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (loadError || !detail) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader
          title="Prospect list"
          actions={
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onBack}>
              Back to lists
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
          <p className="text-sm text-muted-foreground">{loadError ?? 'List not found'}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const list = detail.list

  /**
   * THE TOOLBAR'S RIGHT CLUSTER — this page's per-company action beside the
   * views' own filter and settings buttons, now that the stage tabs share the
   * views' tab row (Liam, 2026-09-06). "Enrich · N" acts on the companies the
   * tab in force (or the open custom view) shows that still owe a profile. It
   * steps aside for the selection bar (which answers "these seven" with the
   * same verb) and while a run is live — the rail says what is running, or,
   * for a people run, the rows do and this slot holds the one stop button.
   * Nothing at all on an empty list.
   */
  const toolbarActions =
    total > 0 ? (
      <>
        {kind === 'company' &&
          !runLive &&
          !selection?.hasSelection &&
          scopedTargets.profile.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={starting}
              title={
                scopedTargets.profile.length > MAX_ENTRIES_PER_TARGETED_RUN
                  ? `Enrich the first ${MAX_ENTRIES_PER_TARGETED_RUN} of the ${scopedTargets.profile.length} companies in this view without a profile — full profile and a score each`
                  : `Enrich the ${scopedTargets.profile.length === 1 ? 'company' : `${scopedTargets.profile.length} companies`} in this view without a profile — full profile and a score each`
              }
              onClick={() =>
                void beginTargetedRun(
                  'account_card',
                  scopedTargets.profile.map((e) => e.id),
                )
              }
            >
              <Sparkles className="h-3 w-3" />
              Enrich · {Math.min(scopedTargets.profile.length, MAX_ENTRIES_PER_TARGETED_RUN)}
            </Button>
          )}
        {/* The people run's only page-level control. Its progress is on the
            rows (the orbs going out one by one); what the rows cannot offer is
            a way to stop the whole run. */}
        {runLive && run?.kind === 'people' && (
          <Button
            variant="ghost"
            size="sm"
            data-prospect-stop-people
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            disabled={canceling || run.status === 'canceling'}
            title="Stop the people search — the people already found are kept"
            onClick={() => void requestCancel()}
          >
            {canceling || run.status === 'canceling' ? 'Stopping…' : 'Stop finding people'}
          </Button>
        )}
      </>
    ) : null

  /**
   * The page's verbs for the selection — drawn by the views layout in a
   * SECOND island floating directly above its own (count · Select all ·
   * Actions) while rows are checked. The two per-company runs live here as
   * well as on the filter strip, because the strip answers "all or the A's?"
   * and the island answers "these seven". Both are hidden on a PERSON
   * selection: neither stage takes person entries, and a button that 400s is
   * a worse answer than a button that is not offered.
   */
  const selectionActions = selection?.hasSelection ? (
    <>
      {selectedKinds.people === 0 && (
        <>
          {/* `beginTargetedRun` truncates at the route's 50-per-run cap, so the
              island says what will run rather than letting the user count 60
              checkboxes and get 50 companies. */}
          {selectionCapped && (
            <span className="shrink-0 px-1.5 text-[11px] text-muted-foreground/80">
              researching the first {MAX_ENTRIES_PER_TARGETED_RUN}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
            disabled={starting || runLive}
            title={
              runLive
                ? 'A run is already going on this list'
                : 'Enrich the selected companies — full profile and a score each'
            }
            onClick={() => void beginTargetedRun('account_card', selectedIds)}
          >
            <Sparkles className="h-3 w-3" />
            Enrich
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
            disabled={starting || (runLive && run?.kind !== 'people')}
            title={
              runLive && run?.kind === 'people'
                ? 'Adds the selected companies to the people search that is running'
                : runLive
                  ? 'A run is already going on this list'
                  : 'Find people at the selected companies'
            }
            onClick={() => void beginTargetedRun('people', selectedIds)}
          >
            <Users className="h-3 w-3" />
            Find people
          </Button>
        </>
      )}
      {/* ADD TO SEQUENCE — People only, and it is Save-then-enroll (§8): the
          dialog needs contact ids and these rows have none until Save promotes
          them. Disabled with the reason when NOBODY in the selection has an
          email, because a dialog that opened on an empty list would report the
          truth after the click instead of before it. Rows with no email are
          dropped from the enrollment and named in the inline note under the
          toolbar. */}
      {selectedKinds.people > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
          disabled={sequenceFlow.busy || savingSelection || selectionEmailCount === 0}
          title={
            selectionEmailCount === 0
              ? NO_EMAIL_REASON
              : `Save to your CRM, then add ${selectionEmailCount} to a sequence`
          }
          onClick={() => void startSequenceFlow(selectedIds)}
        >
          {sequenceFlow.busy && <Loader2 className="h-3 w-3 animate-spin" />}
          <Send className="h-3 w-3" />
          Add to sequence
        </Button>
      )}
      {/* ASK ABOUT THIS LIST — hand the selection to the agent instead of to a stage. It
          does NOT send: it focuses the composer with the Scout skill armed,
          because the whole point is that the user says what they want done
          with these rows. The rows themselves ride along out of band, through
          the selection store the effect above publishes, so the typed message
          can be as short as "research these". */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
        onClick={() =>
          askAboutList({
            listId,
            listName: detail?.list.name ?? 'this list',
            selectedCount: selection.count,
          })
        }
      >
        <Sparkles className="h-3 w-3" />
        Ask about this list
      </Button>
      <Button
        size="sm"
        className="h-7 shrink-0 rounded-full text-xs"
        disabled={savingSelection}
        data-prospect-save-selection
        title="Keep the selected rows on the list — the CRM gets them when you publish"
        onClick={() => void runSave(selectedIds)}
      >
        {savingSelection && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Save
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 rounded-full text-xs"
        onClick={() => setDismissIds(selectedIds)}
      >
        Dismiss
      </Button>
    </>
  ) : null

  return (
    // No `relative` any more: the detail was an `absolute inset-0` sheet
    // positioned against this root, and the modal that replaced it portals to
    // the body instead. Nothing in this tree is absolutely positioned.
    <div className="flex h-full flex-col">
      {/* ── The list, and EVERY control that belongs to it ──

             This wrapper holds the whole page: the header and its crumb, the
             stage bar, the run rail, the ledger, the story banner, the run
             gate, add-by-domain, the selection bar and the entries themselves
             — the stage tabs and "Enrich · N" ride inside the views toolbar.

             IT STAYS VISIBLE while a candidate detail is open — that is the
             whole point of the modal below. The detail used to be a full-width
             sheet painted over this wrapper, which had to go `invisible` +
             `inert` to keep its money-spending controls out of the tab order.
             The modal needs none of that: Radix draws a backdrop over the page,
             marks everything outside the dialog `aria-hidden`, traps focus
             inside it and swallows clicks through the overlay — so the list is
             SEEN behind the pop-up (which is what Liam asked for) and still
             cannot be reached by tab or by click. ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── Header ── */}
        <ViewHeader
          history="custom"
          className="gap-3"
          title={
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <PageTitle label="Lists" onClick={onBack} />
              {/* Crumb, then the name — nothing else. The Beta pill and the
                  purpose chip ("Customers") used to sit either side of the
                  name; Liam cut both from this page on 2026-09-05. Beta stays
                  on the index; the purpose is a column on the index row and
                  is edited in the ICP panel. The name itself is the rename
                  control (2026-09-06): a press turns it into a field. */}
              {renaming ? (
                <input
                  ref={nameInputRef}
                  data-prospect-list-name-input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commitRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelRename()
                    }
                  }}
                  aria-label="List name"
                  className="h-7 w-80 max-w-full rounded-md border border-border bg-background px-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : (
                <h1 className="min-w-0 truncate text-sm font-semibold">
                  <button
                    type="button"
                    data-prospect-list-name
                    onClick={startRename}
                    title="Rename this list"
                    className="-mx-1 max-w-full truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {list.name}
                  </button>
                </h1>
              )}
            </div>
          }
          actions={
            <>
              {/* ── List settings ──
                     One gear instead of three top-level controls (the ICP
                     chip, "+ Add company by domain", "Runs"). A Popover rather
                     than a DropdownMenu because the second level — run history
                     — is a scrolling list with its own fetch, which a menu
                     cannot hold. ── */}
              <Popover
                open={settingsOpen}
                onOpenChange={(next) => {
                  setSettingsOpen(next)
                  if (!next) setSettingsView('menu')
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title="List settings"
                    aria-label="List settings"
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-0">
                  {settingsView === 'menu' ? (
                    <div className="p-1.5">
                      {/* FIND MORE COMPANIES — discovery, from the menu rather
                          than the header (Liam, 2026-09-06): the first search
                          starts from the new-list sheet, so by the time this
                          page is open the button is always asking for MORE,
                          and a primary "Find companies" beside a list that
                          already has 75 read as the first step again. Still
                          disabled while a run is live, with the reason — the
                          server would 409 anyway (one live run per list). */}
                      <button
                        type="button"
                        data-prospect-find-more
                        disabled={runLive}
                        title={
                          runLive
                            ? 'A run is already going on this list'
                            : 'Search again for companies that fit the ICP — new ones only, then profiled and scored'
                        }
                        onClick={() => {
                          setSettingsOpen(false)
                          setAlreadyRunning(false)
                          setFindOpen(true)
                        }}
                        className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Search className="h-3 w-3 shrink-0" />
                        {total > 0 ? 'Find more companies' : 'Find companies'}
                      </button>
                      {/* One line, like its neighbours: the ICP's own summary
                          used to sit under it, truncated to nothing useful
                          (Liam, 2026-09-06). The editor is one click away. */}
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsOpen(false)
                          openIcp()
                        }}
                        className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50"
                      >
                        <Target className="h-3 w-3 shrink-0" />
                        Edit ICP
                        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                          v{list.icp_version}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="Add company by domain"
                        onClick={() => {
                          setSettingsOpen(false)
                          setAddNotice(null)
                          setAddOpen(true)
                        }}
                        className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50"
                      >
                        <Plus className="h-3 w-3 shrink-0" />
                        Add company by domain
                      </button>
                      <button
                        type="button"
                        onClick={() => setSettingsView('runs')}
                        className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50"
                      >
                        <History className="h-3 w-3 shrink-0" />
                        Run history
                        <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                      </button>
                      {/* DELETE LIST — last, below a rule, in the destructive
                          colour (Liam, 2026-09-06). Disabled, with the reason,
                          while a run is live: the route would refuse it (the
                          engine re-reads the list's rows per iteration). The
                          confirmation says what goes and what stays. */}
                      <div className="my-1 border-t border-border" />
                      <button
                        type="button"
                        data-prospect-delete-list
                        disabled={runLive}
                        title={runLive ? 'Stop the run before deleting this list' : 'Delete this list'}
                        onClick={() => {
                          setSettingsOpen(false)
                          setDeleteOpen(true)
                        }}
                        className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Trash2 className="h-3 w-3 shrink-0" />
                        Delete list
                      </button>
                    </div>
                  ) : (
                    <RunHistoryPanel
                      listId={listId}
                      refreshKey={historyKey}
                      onBack={() => setSettingsView('menu')}
                      onOpenRun={(past) => {
                        // A deliberate look at a past run: the feed must not
                        // yank the rail back to whatever is live.
                        pinnedRunIdRef.current = past.is_live ? null : past.id
                        runPoll.adopt(past)
                        setDismissedOutcomeId(null)
                        setSettingsOpen(false)
                        setSettingsView('menu')
                      }}
                    />
                  )}
                </PopoverContent>
              </Popover>

              {/* FIND DECISION MAKERS — the people search over every profiled
                  company in the current chip that has none yet. An icon beside
                  the gear, its name and its scope on hover (Liam, 2026-09-06:
                  "just have the icon and make the text on hover"). Disabled,
                  never hidden, when there is nothing to run or a run is live —
                  a control that vanishes reads as the layout breaking. */}
              <Button
                variant="ghost"
                size="icon"
                data-prospect-find-people-header
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                disabled={starting || runLive || scopedTargets.people.length === 0}
                aria-label="Find decision makers"
                title={
                  runLive
                    ? 'Find decision makers — a run is already going on this list'
                    : scopedTargets.people.length === 0
                      ? 'Find decision makers — every profiled company in this view already has people'
                      : `Find decision makers — people at the ${scopedTargets.people.length === 1 ? 'profiled company' : `${Math.min(scopedTargets.people.length, MAX_ENTRIES_PER_TARGETED_RUN)} profiled companies`} in this view that have none yet`
                }
                onClick={() => {
                  setAlreadyRunning(false)
                  setPeopleOpen(true)
                }}
              >
                <Users className="h-4 w-4" />
              </Button>

              {/* PUBLISH — the list into the CRM (migration 259). The count is
                  what a press would write: saved rows the CRM group does not
                  hold yet. With nothing pending the button stays, quiet and
                  disabled, saying the list is published — a control that
                  vanished would leave "did I publish this?" unanswerable. */}
              {detail && (
                <Button
                  size="sm"
                  variant="outline"
                  data-prospect-publish
                  className="h-8 gap-1.5 text-xs"
                  disabled={publishing || detail.entry_counts.pending_publish === 0}
                  title={
                    detail.entry_counts.pending_publish > 0
                      ? `Write the ${detail.entry_counts.pending_publish} saved ${detail.entry_counts.pending_publish === 1 ? 'row' : 'rows'} the CRM does not have yet, filed under “${detail.list.name}”`
                      : detail.list.published_at
                        ? 'Everything saved on this list is in your CRM — this wakes up the moment you save something new'
                        : 'Save companies to the list first — publishing writes them to the CRM'
                  }
                  onClick={() => void runPublish()}
                >
                  {publishing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {publishing
                    ? 'Publishing…'
                    : detail.entry_counts.pending_publish > 0
                      ? `Publish · ${detail.entry_counts.pending_publish}`
                      : detail.list.published_at
                        ? 'Published'
                        : 'Publish'}
                </Button>
              )}
            </>
          }
        />

        {/* ── Run rail (live) / outcome (terminal) ──
               Exactly one of the two is ever up: the rail describes a run in
               flight, the banner describes one that finished. A PEOPLE run
               draws no rail: the rows it targets carry the orb themselves
               (ProspectListActivityContext) and the strip carries the stop
               button, so the page does not grow a header for a search the
               user started on a row (Liam, 2026-09-06). The banner is
               suppressed once dismissed FOR THAT RUN ID, so dismissing round
               1's result cannot swallow round 2's. ── */}
        {run && runLive && run.kind !== 'people' && (
          <RunRail
            kind={run.kind}
            progress={runProgress}
            live
            canceling={canceling || run.status === 'canceling'}
            onCancel={() => void requestCancel()}
          />
        )}
        {run && !runLive && dismissedOutcomeId !== run.id && (
          <RunOutcome
            run={run}
            spend={spend}
            busy={starting}
            onResume={() => void rerunOutcome(run)}
            onRetry={() => void rerunOutcome(run)}
            onDismiss={() => setDismissedOutcomeId(run.id)}
            onEditIcp={openIcp}
          />
        )}

        {/* ── The save/sequence story (C5) ──
               In the OUTCOME SLOT, beside the run's own banner rather than
               inside it: a run reports what the engine found, this reports what
               the user (or Scout) did with it, and the two can be true at the
               same moment. Above the filter strip, because the strip asks what
               to do next and this says what just happened. ── */}
        {story && (
          <SaveStoryBanner
            story={story}
            onPublish={() => void runPublish()}
            onOpenSaved={() => applyStage('saved')}
            onOpenNeedsReview={() => applyStage('needs_review')}
            onOpenSequence={(id, name) => onOpenSequence?.(id, name)}
            onDismiss={() => setStory(null)}
          />
        )}

        {/* ── Add-by-domain ── */}
        {addOpen && (
          <div className="mx-5 mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <Input
              autoFocus
              value={addDomain}
              placeholder="acme.com"
              aria-label="Company domain"
              onChange={(e) => {
                setAddDomain(e.target.value)
                if (addNotice) setAddNotice(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitAdd()
                if (e.key === 'Escape') setAddOpen(false)
              }}
              className="h-7 border-none text-sm shadow-none focus-visible:ring-0"
            />
            {addNotice && (
              <span className="shrink-0 text-xs text-muted-foreground">{addNotice}</span>
            )}
            <Button size="sm" className="h-7 shrink-0 text-xs" onClick={() => void commitAdd()} disabled={adding}>
              {adding && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Add
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              onClick={() => setAddOpen(false)}
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* ── Add-to-sequence: the dialog and the INLINE note ──
               The note lives here, directly under the selection bar and the rows
               it is about, because §8 forbids reporting `no_email` in a toast
               alone: a toast is the one place a user can miss the fact that
               three of the people they just "added" are not going anywhere. ── */}
        <SequenceFlowSurface
          flow={sequenceFlow}
          onEnrolled={(info) => {
            // The Sequenced chip is DERIVED — the only way to make it appear is
            // to read the enrollment table again.
            void loadSequenced()
            refreshEntries()
            void load()
            // MERGE, don't replace: add-to-sequence is save-then-enroll, one
            // gesture, and the save half already wrote a story a moment ago. Two
            // banners for one action would make the user dismiss it twice.
            setStory((prev) =>
              prev
                ? {
                    ...prev,
                    enrolled: {
                      count: info.enrolledCount,
                      sequenceId: info.sequenceId,
                      sequenceName: info.sequenceName,
                    },
                    at: Date.now(),
                  }
                : {
                    kind: 'published',
                    companies: 0,
                    people: 0,
                    needsReview: 0,
                    skippedOther: 0,
                    enrolled: {
                      count: info.enrolledCount,
                      sequenceId: info.sequenceId,
                      sequenceName: info.sequenceName,
                    },
                    source: 'page',
                    at: Date.now(),
                  },
            )
          }}
        />

        {/* ── Entries, with the detail as a MODAL POP-UP over them ──

               FOUR SHAPES, AND WHY THIS ONE. The detail began as a bare
               `absolute inset-0 z-20` box with the list toggled `hidden`
               underneath — no crumb, no back, no Escape, and a remount of the
               whole views stack every time you closed it. It then became a
               Mail-style 45/55 resizable SPLIT, on the theory that triage wants
               the list beside what you are reading; that did not survive contact
               with the shell, because this page lives in the dashboard's CONTENT
               column which the chat strip already caps at roughly half the
               viewport, so 55% of a half is a ~400px reading pane and every
               panel inside it spent its width wrapping. Third came a full-width
               SHEET over the whole column — readable at last, but it read as a
               page navigation: the list vanished, and clicking a prospect felt
               like leaving the list rather than looking at one of its rows.

               So: a MODAL. Liam asked for a pop-up, and a pop-up is the honest
               shape for this gesture — the list stays ON SCREEN behind the
               backdrop, so the modal reads as "this row, expanded" and closing
               it is visibly a return to something that never went away. It is
               also the shape that costs the least: the sheet needed `invisible`
               + `inert` hand-wiring to keep the page's paid-run buttons out of
               the tab order, and Radix's modal does focus trapping, outside
               `aria-hidden`, click-blocking and Escape on its own.

               The views layout stays MOUNTED throughout, exactly as it did under
               the sheet — it owns the scroll position, the active saved view,
               the selection and the visible-item ORDER that prev/next steps
               through, all of which a remount would throw away. ── */}
        <div className="min-h-0 flex-1">
          {/* What the rows may read about the page: whether a run is live
              (hide the per-row Find people button, which would 409) and
              whether it is the PROFILE run (say "Scoring…" on the unscored
              rows rather than a dash). The provider sits here rather than
              around the page so a row rendered elsewhere gets the idle
              default. */}
          <ProspectListActivityContext.Provider value={activity}>
          <div className="h-full min-h-0">
            <UnifiedViewLayout
              key={`prospect-list-${listId}`}
              entityType="prospect_list_entry"
              scopeFilters={scopeFilters}
              viewScope={{ type: 'prospect_list', id: listId }}
              onBulkSelectionChange={handleBulkSelection}
              /* Still reported even though the list is covered: closing the sheet
                 reveals the list with the row the user was just reading already
                 highlighted, so they land back where they were. */
              selectedItemId={activeEntryId}
              onVisibleItemsChange={handleVisibleItemsChange}
              /* The stage tabs, in the views' own tab row; the tab in force
                 (none while a custom view is open) and the counts. The layout
                 reports which custom view is open and lends this page its
                 selector, so a tab picked from the save story clears the
                 view the way a tab clicked in the toolbar does. */
              prospectStage={effectiveStage}
              prospectStageCounts={total > 0 ? filterCounts : null}
              onProspectStageChange={applyStage}
              toolbarActions={toolbarActions}
              selectionActions={selectionActions}
              onActiveViewChange={setActiveCustomViewId}
              onViewSelectorReady={handleViewSelectorReady}
              onItemSelect={(_id, _title, _event, item) => {
                if (item) {
                  // A click always wins over whatever a save or a ledger link
                  // left open — every one of those panes outranks `openEntry`
                  // in `detailOverlay`, so clicking a row without clearing them
                  // would move the highlight while the old panel stayed put.
                  clearSavedPanes()
                  setOpenEntry(item as unknown as ProspectListEntryRow)
                }
              }}
            />
          </div>
          </ProspectListActivityContext.Provider>
        </div>
      </div>
      {/* ── end of the page behind the modal ── */}

      {/* ── Delete this list ──
             The same dialog the index's bulk delete uses, so the sentence about
             the CRM is the same from either door. On success the list is gone,
             so the only place to land is the index — `onBack` — and the toast
             names what was deleted since the page it was on no longer exists. */}
      <ProspectListDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        listIds={[listId]}
        listName={list.name}
        candidateCount={total}
        onDeleted={() => {
          toast.success(`Deleted “${list.name}”`)
          onBack()
        }}
      />

      {/* ── Entry detail — a MODAL POP-UP over the list (§10, Page 4).

             THE BUG THE HEADER FIXES: the panel used to be a bare
             `absolute inset-0` box painted over the list — including over the
             list header and its "Lists" crumb — and `CompanyDetailPanel` draws
             no header of its own, so after "Save to CRM" there was no back
             control, no crumb and no Escape. The user was simply stuck on a
             company page with the whole app's navigation hidden underneath.

             The fix is the shape every other detail in the app already has:
             the SHARED `DetailBreadcrumbHeader` on top of the panel body. Its
             crumb reads "<list name> › <candidate>" and its back button
             returns to THIS list, which is the correct parent — the list is
             where the user was, not the Prospecting index. It also carries the
             prev/next arrows, which step through the rows the list behind the
             backdrop is showing, in the order it is showing them.

             WHY A DIALOG and not the tab shell's own detail panel: the list
             detail is a bespoke page whose open list rides in the LOCATION with
             `detailPanel: null` (same shape as Sequences). Routing the company
             through the tab's generic detailPanel would render a crumb reading
             "Prospecting", not the list name — the shell maps a view to a fixed
             label and its close handler drops a `prospect_list` location. So
             the pop-up owns its own header, and gets the same affordances by
             using the same component.

             The Radix `Dialog` is what makes this a POP-UP rather than a page:
             it portals out of this subtree (so no z-index fight with the chat
             column), paints the backdrop that keeps the list visible-but-
             unreachable, traps focus, and owns Escape. Nested dialogs opened
             from INSIDE it — the dismiss picker, the ICP sheet — stack on top
             and take Escape first, which is why the gate below only has to
             refuse the key rather than re-implement the ordering. ── */}
      <Dialog
        open={detailOverlay !== null}
        onOpenChange={(next) => {
          if (!next) closeDetailOverlay()
        }}
      >
        {detailOverlay && (
          <DialogContent
            data-testid="prospect-detail-pane"
            /* `max-w-none` overrides the primitive's `max-w-lg`: this is a
               reading surface for a whole company record, not a confirm box.
               `p-0` + `gap-0` because the header and the panels below draw
               their own padding, and `overflow-hidden` so the rounded corners
               clip the panels' own scroll areas. */
            className="flex h-[88vh] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0"
            aria-describedby={undefined}
            /* Radix owns Escape; the gate is the same one the old document
               listener carried — a save or an entry write in flight must not
               have the panel yanked out from under it. `preventDefault` is the
               refusal, so no second handler is needed anywhere. */
            onEscapeKeyDown={(e) => {
              if (!escapeClosesOverlay) e.preventDefault()
            }}
          >
            {/* Radix requires a title for the dialog's accessible name. The
                breadcrumb below is the VISIBLE naming — a second heading would
                repeat it — so this is the same string, screen-reader only. */}
            <DialogTitle className="sr-only">
              {list.name} › {detailOverlay.title}
            </DialogTitle>
            {/* `pr-8` RESERVES the top-right corner for the dialog's own
                Close X. `DialogContent` draws that X at `right-4 top-4` around
                a 16px icon — it reaches ~32px in from the right edge and spans
                y 16-32px — while this header is a `h-12 px-5` ViewHeader whose
                last nav arrow (`h-7 w-7`) would otherwise sit 20-48px in at
                y 10-38px. The two boxes overlap, and the absolutely-positioned
                Close, being the later sibling, wins the hit test: a band of
                "next prospect" would close the pop-up instead of stepping.
                Padding the header pushes the arrow's right edge out to 52px,
                clear of the X. jsdom has no layout, so the regression test can
                only assert this reserved padding is still here. */}
            <div data-testid="prospect-detail-header" className="shrink-0 pr-8">
              <DetailBreadcrumbHeader
                viewTitle={list.name}
                detailTitle={detailOverlay.title}
                onBack={closeDetailOverlay}
                onPrev={onPrevEntry}
                onNext={onNextEntry}
                showNav
              />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {detailOverlay.kind === 'company' ? (
                <CompanyDetailPanel
                  companyId={detailOverlay.companyId}
                  onClose={closeDetailOverlay}
                />
              ) : detailOverlay.kind === 'contact' ? (
                /* AFTER SAVE THE PANEL IS THE EXISTING ONE (§10, Page 4),
                   with ONE Prospecting section injected on top. That section
                   is not decoration: the list, the account's fit and the
                   identity line are per-LIST verdict, they live on the entry
                   and never on the CRM record, so the panel below has no way
                   to know any of it. Everything else — enrichment, activity,
                   properties — is the same contact panel the CRM shows. */
                <div className="flex h-full min-h-0 flex-col">
                  {detailOverlay.prospecting && (
                    <ProspectingContactBanner
                      listName={list.name}
                      context={detailOverlay.prospecting}
                    />
                  )}
                  <div className="min-h-0 flex-1">
                    <ContactDetailPanel
                      contactId={detailOverlay.contactId}
                      onClose={closeDetailOverlay}
                    />
                  </div>
                </div>
              ) : (
                <EntryPanel
                  entry={detailOverlay.entry}
                  busy={entryBusy || savingSelection || sequenceFlow.busy}
                  onSave={async (options) => {
                    setEntryBusy(true)
                    await runSave([detailOverlay.entry.id], options ?? {})
                    setEntryBusy(false)
                  }}
                  onDismiss={() => setDismissIds([detailOverlay.entry.id])}
                  /* The panel's Enrich: the same one-company profile run the
                     row's button starts. Companies only — a person has no
                     card of their own. */
                  onProfile={
                    detailOverlay.entry.kind === 'company'
                      ? () => void beginTargetedRun('account_card', [detailOverlay.entry.id])
                      : undefined
                  }
                  /* The panel's Find people: the same one-company people run
                     the row's button starts (a click during a live people run
                     joins it — see beginTargetedRun's 409 branch). */
                  onFindPeople={
                    detailOverlay.entry.kind === 'company'
                      ? () => void beginTargetedRun('people', [detailOverlay.entry.id])
                      : undefined
                  }
                  /* The same liveness the rows read off the activity context.
                     The pop-up is portaled out of the provider's subtree, so
                     the two facts travel as props. */
                  profiling={activity.profiling}
                  findingPeople={activity.findingPeople?.ids.has(detailOverlay.entry.id) ?? false}
                  /* The people found at this company — this page holds every
                     entry on the list, so the panel's People tab is a filter,
                     not a fetch. */
                  people={
                    detailOverlay.entry.kind === 'company'
                      ? (detail?.entries ?? []).filter(
                          (e) => e.kind === 'person' && e.parent_entry_id === detailOverlay.entry.id,
                        )
                      : undefined
                  }
                  onOpenPerson={(person) => setOpenEntry(person)}
                  /* The "already in this list" note names the row a found
                     person duplicates and the account it sits under, and
                     opens it — this page holds every entry on the list. */
                  lookupEntry={(id) => entriesRef.current.find((e) => e.id === id)}
                  onOpenEntry={(target) => setOpenEntry(target)}
                  /* A person's only route back to the account that produced
                     them: `company_id` is NULL by construction, so the parent
                     ENTRY is the link, and this page already holds every entry
                     on the list. */
                  parentName={parentNameFor(detailOverlay.entry)}
                  onOpenParent={(parentId) => {
                    const parent = entriesRef.current.find((e) => e.id === parentId)
                    if (parent) setOpenEntry(parent)
                  }}
                  /* People only — a company entry has no contact to enroll. */
                  onAddToSequence={
                    detailOverlay.entry.kind === 'person'
                      ? () => void startSequenceFlow([detailOverlay.entry.id])
                      : undefined
                  }
                  sequenced={
                    detailOverlay.entry.contact_id
                      ? sequenced[detailOverlay.entry.contact_id] ?? null
                      : null
                  }
                />
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* ── ICP panel. PORTALED via the shared Sheet for the same reason as
             the new-list sheet: an in-tree `fixed` panel loses the paint order
             fight with the dashboard's chat column and its footer becomes
             unclickable. ── */}
      <Sheet open={icpOpen} onOpenChange={(next) => { if (!next) setIcpOpen(false) }}>
        <SheetContent
          side="right"
          aria-label="Edit ICP"
          aria-describedby={undefined}
          className="flex h-full w-full max-w-[520px] flex-col gap-0 border-l border-border p-0 sm:max-w-[520px]"
        >
          <SheetHeader className="flex h-12 shrink-0 flex-row items-center gap-2 space-y-0 border-b border-border px-4 text-left">
            <SheetTitle className="truncate text-sm font-semibold">Who to find</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {icpDraft && (
              <IcpEditor icp={icpDraft} provenance={{}} onChange={setIcpDraft} />
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
            {/* Editing does not retro-invalidate anything: entries keep the
                version they were found under and the list badges the drift. */}
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
              Editing this does not change candidates already found.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setIcpOpen(false)} disabled={icpSaving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void commitIcp()} disabled={icpSaving}>
              {icpSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <FindDialog
        open={findOpen}
        list={list}
        busy={starting}
        alreadyRunning={alreadyRunning}
        onCancel={() => setFindOpen(false)}
        onConfirm={() => void beginRun()}
      />

      <PeopleDialog
        open={peopleOpen}
        companyCount={Math.min(scopedTargets.people.length, MAX_ENTRIES_PER_TARGETED_RUN)}
        cappedByRunSize={scopedTargets.people.length > MAX_ENTRIES_PER_TARGETED_RUN}
        peoplePerCompany={list.people_per_company}
        icp={icp}
        busy={starting}
        alreadyRunning={alreadyRunning}
        onCancel={() => setPeopleOpen(false)}
        onConfirm={(perCompany) => void confirmPeople(perCompany)}
      />

      <DismissReasonDialog
        open={dismissIds !== null}
        count={dismissIds?.length ?? 0}
        onCancel={() => setDismissIds(null)}
        onConfirm={(reason) => runDismiss(dismissIds ?? [], reason)}
      />
    </div>
  )
}
