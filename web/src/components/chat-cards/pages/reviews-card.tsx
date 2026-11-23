'use client'

/**
 * Reviews as a card (docs/plans/github-reviews.md, "Reviews on the app's own
 * list"): the person's GitHub pull requests, read live with their own sign-in
 * (GET /api/account/github/reviews), drawn with the app's own list parts.
 *
 *   Sections  Review requests, Authored by me, Assigned to me, Involves me,
 *             and Open / Closed / All: the page's sub-nav beside the rail
 *             (page-panel/reviews-panel.tsx), as My Actions' views are; pills
 *             in the card only while that sub-nav isn't on screen.
 *   Toolbar   the shared ViewToolbar: filter chips (Stage, State, Review,
 *             Checks, Repository, Author, Assignee, Labels, Linked work,
 *             dates) and the display settings (grouping, sort, properties).
 *             Kept with the card, as every page card's list is.
 *   Rows      the shared ViewList and ViewBoard over the view kind
 *             `github_pr` (lib/views/types.ts); the board's columns are
 *             Draft, In review, Checks failing, Conflicts, Ready to merge,
 *             Merged. J/K, Enter and O as in every list.
 *   A row     opens the pull request over the list, as a record opens
 *             (reviews/pull-detail.tsx): the card's place `owner/name#12`,
 *             so a GitHub notice opens it too and Back walks it.
 *
 * GitHub's search narrows by the section, the state, the sort and each plain
 * filter; every filter, the grouping and the sort are then applied to the
 * rows on the page (lib/github/reviews-view.ts).
 */
import * as React from 'react'
import Link from 'next/link'
import { LayoutGrid, List, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import {
  REVIEW_SECTIONS,
  REVIEW_STATES,
  SECTION_LABEL,
  reviewFiltersQuery,
  type ReviewPr,
  type ReviewSection,
  type ReviewStateFilter,
} from '@/lib/github/reviews'
import { localValuesOf, searchFiltersOf, selectPrRows, toPrRow, type ReviewPrRow } from '@/lib/github/reviews-view'
import { setLocalEnumOptions } from '@/lib/views/local-enum-options'
import type { GroupedResults } from '@/lib/views/types'
import { EntityIcon } from '@/components/entities/entity-icon'
import { ViewToolbar } from '@/components/views/view-toolbar'
import { ViewList } from '@/components/views/view-list'
import { ViewBoard } from '@/components/views/view-board'
import { ViewLayoutSwitcher } from '@/components/views/view-layout-switcher'
import type { LayoutOption } from '@/components/views/view-layouts'
import { ExpandableSearch } from '@/components/views/expandable-search'
import { useViewConfig, type CardConfigSource, type ViewConfig } from '@/components/views/hooks/use-view'
import { ListFocusProvider, listOwnsKeys, scrollListRowIntoView, stepListFocus } from '@/components/views/list-keyboard'
import { useOwnSubnavShown } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import { CardCovered, CardOverlay } from '../card-covered'
import { CARD_HEADER_ICON_BUTTON } from '../card-header-button'
import { CardHeaderSlot, useCardHeaderSlots } from '../card-header-slot'
import { publishReviewsCard, unpublishReviewsCard } from '../reviews-card-controls'
import { RecordOverlay, usePageRecords } from './record-overlay'
import { usePagePlace, type PageCardProps } from './page-card'
import { PullDetail } from './reviews/pull-detail'

const PREFS_KEY = 'ni:reviews:prefs'
/** The card keeps its list's changes here, as every page card's list (page-card.tsx). */
const LIST_KEY = 'github_pr'

/** List and Board, in the card's header as every views page's layouts are. */
const LAYOUTS: LayoutOption[] = [
  { value: 'list', label: 'List', Icon: List },
  { value: 'board', label: 'Board', Icon: LayoutGrid },
]

interface Prefs {
  section: ReviewSection
  state: ReviewStateFilter
}

const DEFAULT_PREFS: Prefs = { section: 'review_requests', state: 'open' }

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs & { filters: Partial<Prefs> }> | null
    // An older page kept them inside `filters`.
    const section = p?.section ?? p?.filters?.section
    const state = p?.state ?? p?.filters?.state
    return {
      section: (REVIEW_SECTIONS as readonly string[]).includes(section ?? '') ? (section as ReviewSection) : DEFAULT_PREFS.section,
      state: (REVIEW_STATES as readonly string[]).includes(state ?? '') ? (state as ReviewStateFilter) : DEFAULT_PREFS.state,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(p: Prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* private mode: kept for the visit only */
  }
}

interface ReviewsAnswer {
  total?: number
  cursor?: string | null
  prs?: ReviewPr[]
  error?: string
  code?: string
}

/** One section's pull requests from GitHub, page by page. */
function useReviews(query: string) {
  const [prs, setPrs] = React.useState<ReviewPr[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [total, setTotal] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; code?: string } | null>(null)
  const seq = React.useRef(0)

  const load = React.useCallback(
    async (after: string | null) => {
      const n = ++seq.current
      if (after) setLoadingMore(true)
      else {
        setLoading(true)
        setError(null)
      }
      try {
        const res = await fetch(`/api/account/github/reviews?${query}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
        const json = (await res.json().catch(() => ({}))) as ReviewsAnswer
        if (n !== seq.current) return
        if (!res.ok) {
          setError({ message: json.error ?? 'Could not load your pull requests.', code: json.code })
          if (!after) setPrs([])
          setCursor(null)
          return
        }
        const page = json.prs ?? []
        setPrs((prev) => (after ? [...prev, ...page.filter((p) => !prev.some((q) => q.id === p.id))] : page))
        setCursor(json.cursor ?? null)
        setTotal(typeof json.total === 'number' ? json.total : null)
      } catch {
        if (n === seq.current) setError({ message: 'Could not reach the server.' })
      } finally {
        if (n === seq.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [query],
  )

  React.useEffect(() => {
    void load(null)
  }, [load])

  return { prs, cursor, total, loading, loadingMore, error, reload: () => load(null), more: () => (cursor ? load(cursor) : undefined) }
}

const NOOP = () => {}
const NO_VIEW = async () => null

export default function ReviewsCard(props: PageCardProps) {
  const { toolCallId, store, onCount } = props
  const records = usePageRecords(toolCallId, store)
  const inCard = useCardHeaderSlots() !== null
  const subnavShown = useOwnSubnavShown('reviews')

  // The section and state: the sub-nav's, remembered on this device.
  const [prefs, setPrefs] = React.useState<Prefs>(DEFAULT_PREFS)
  React.useEffect(() => setPrefs(readPrefs()), [])
  const setSection = React.useCallback((section: ReviewSection) => setPrefs((p) => (writePrefs({ ...p, section }), { ...p, section })), [])
  const setState = React.useCallback((state: ReviewStateFilter) => setPrefs((p) => (writePrefs({ ...p, state }), { ...p, state })), [])

  // The view (filters, grouping, sort, layout, properties): the shared config, kept with the card.
  const cardSource = React.useMemo<CardConfigSource>(
    () => ({
      baseline: {},
      overrides: store.state(toolCallId).lists?.[LIST_KEY] as Partial<ViewConfig> | undefined,
      onOverridesChange: (overrides) => {
        const lists = { ...(store.state(toolCallId).lists ?? {}), [LIST_KEY]: overrides as Record<string, unknown> }
        store.update(toolCallId, { lists }, { touch: true })
      },
    }),
    // Read once, at mount (CardConfigSource).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolCallId],
  )
  const { config, updateConfig, isDirty, overrides, saveOverrides, discardOverrides } = useViewConfig(null, 'github_pr', undefined, false, undefined, 'workspace', cardSource, 'memory')

  const [search, setSearch] = React.useState('')
  const query = reviewFiltersQuery(searchFiltersOf(prefs.section, prefs.state, config.filters, config.ordering))
  const { prs, cursor, total, loading, loadingMore, error, reload, more } = useReviews(query)

  const rows = React.useMemo(() => prs.map(toPrRow), [prs])
  React.useEffect(() => {
    for (const [key, values] of Object.entries(localValuesOf(rows))) setLocalEnumOptions(key, values)
  }, [rows])
  const searched = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || (r.author ?? '').toLowerCase().includes(q))
  }, [rows, search])
  const layout = config.layout === 'board' ? 'board' : 'list'
  const { data, flat, closedOffBoard } = React.useMemo(
    () => selectPrRows(searched, { filters: config.filters, ordering: config.ordering, grouping: config.grouping, layout }),
    [searched, config.filters, config.ordering, config.grouping, layout],
  )

  React.useEffect(() => {
    onCount?.(loading ? null : (total ?? prs.length))
  }, [onCount, loading, total, prs.length])

  // The pull request open over the list: the card's place, `owner/name#12`.
  const place = usePagePlace(props)
  const openKey = place.at?.type === 'github_pr' ? place.at.id : null
  const openRow = openKey ? (rows.find((r) => r.id === openKey) ?? null) : null
  const openPr = React.useCallback(
    (id: string, title?: string) => place.go({ type: 'github_pr', id, ...(title ? { label: title } : {}) }),
    [place],
  )

  // The sub-nav moves this card (reviews-card-controls.ts).
  React.useEffect(() => {
    publishReviewsCard({
      cardId: toolCallId,
      section: prefs.section,
      state: prefs.state,
      setSection: (s) => {
        if (place.at) place.go(null)
        setSection(s)
      },
      setState: (s) => {
        if (place.at) place.go(null)
        setState(s)
      },
      show: () => {
        if (store.fullScreen() !== toolCallId) store.enterFullScreen(toolCallId)
      },
    })
  }, [toolCallId, prefs.section, prefs.state, place, setSection, setState, store])
  React.useEffect(() => () => unpublishReviewsCard(toolCallId), [toolCallId])

  // ── The keyboard, as in every list (list-keyboard.tsx): J/K and the arrows move, Enter or O opens. ──
  const listRootRef = React.useRef<HTMLDivElement>(null)
  // The rows in the order they stand on screen: group by group when grouped.
  const ids = React.useMemo(() => {
    const grouped = data.length > 0 && 'items' in (data[0] as object)
    if (!grouped) return flat.map((r) => r.id)
    const seen = new Set<string>()
    for (const g of data as GroupedResults[]) for (const item of g.items) seen.add(item.id as string)
    return [...seen]
  }, [data, flat])
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  const liveFocusedId = focusedId && ids.includes(focusedId) ? focusedId : null
  const keysOn = !openKey && !records.current
  const ownsKeys = React.useCallback((e: KeyboardEvent) => listOwnsKeys(listRootRef.current, e), [])
  const moveFocus = React.useCallback(
    (step: number) => {
      const next = stepListFocus(ids, liveFocusedId, step)
      if (!next) return
      setFocusedId(next)
      requestAnimationFrame(() => scrollListRowIntoView(listRootRef.current, next))
    },
    [ids, liveFocusedId],
  )
  const openFocused = React.useCallback(() => {
    const row = flat.find((r) => r.id === liveFocusedId)
    if (row) openPr(row.id, row.title)
  }, [flat, liveFocusedId, openPr])
  const listKeys = React.useMemo<HotkeyDefinition[]>(() => {
    const base = { globalGuard: true, when: ownsKeys, disabled: !keysOn }
    return [
      { ...base, key: 'j', handler: () => moveFocus(1) },
      { ...base, key: 'ArrowDown', handler: () => moveFocus(1) },
      { ...base, key: 'k', handler: () => moveFocus(-1) },
      { ...base, key: 'ArrowUp', handler: () => moveFocus(-1) },
      { ...base, key: 'Enter', disabled: !keysOn || !liveFocusedId, handler: openFocused },
      { ...base, key: 'o', disabled: !keysOn || !liveFocusedId, handler: openFocused },
    ]
  }, [ownsKeys, keysOn, moveFocus, openFocused, liveFocusedId])
  useHotkeys(listKeys)

  const onItemSelect = React.useCallback(
    (id: string, title: string) => {
      setFocusedId(id)
      openPr(id, title)
    },
    [openPr],
  )

  // Prev / next in the open pull request's header: the rows as listed.
  const step = (dir: 1 | -1) => {
    const i = openKey ? ids.indexOf(openKey) : -1
    const next = i >= 0 ? ids[i + dir] : undefined
    return next ? () => openPr(next, flat.find((r) => r.id === next)?.title) : undefined
  }

  const notConnected = error?.code === 'github_not_connected' || error?.code === 'github_unauthorized'

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!openKey || !!records.current}>
        {inCard && (
          // The page's own controls in its header (Liam, 11-22): the layouts, search and Refresh, 24px like every header control.
          <CardHeaderSlot side="right">
            <div className="flex items-center gap-1.5">
              <ViewLayoutSwitcher options={LAYOUTS} value={layout} onChange={(next) => updateConfig({ layout: next === 'board' ? 'board' : 'list' })} />
              <ExpandableSearch value={search} onChange={setSearch} label="Search pull requests" placeholder="Search pull requests…" />
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh"
                data-reviews-refresh=""
                onClick={() => void reload()}
                className={cn('grid size-6 shrink-0 place-items-center', CARD_HEADER_ICON_BUTTON)}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
              </button>
            </div>
          </CardHeaderSlot>
        )}
        <div ref={listRootRef} data-list-keyboard-root="" className="relative isolate flex h-full flex-col">
          {/* The sections and state as pills where the sub-nav beside the rail isn't: below `md`, or when it isn't on screen. */}
          {(
            <div data-reviews-sections="" className={cn('flex shrink-0 flex-wrap items-center gap-1 px-[18px] pt-2', subnavShown && 'md:hidden')}>
              {REVIEW_SECTIONS.map((s) => (
                <Pill key={s} on={prefs.section === s} onClick={() => setSection(s)} data={{ 'data-reviews-section': s }}>
                  {SECTION_LABEL[s]}
                </Pill>
              ))}
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              {REVIEW_STATES.map((s) => (
                <Pill key={s} on={prefs.state === s} onClick={() => setState(s)} data={{ 'data-reviews-state': s }}>
                  {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'All'}
                </Pill>
              ))}
            </div>
          )}
          <ViewToolbar
            embedded
            hideTabs
            canSaveViews={false}
            alignToContent
            layoutInHeader={inCard}
            entityType="github_pr"
            views={[]}
            activeViewId={null}
            onViewChange={NOOP}
            onCreateView={NO_VIEW}
            onUpdateView={NOOP}
            onDuplicateView={NOOP}
            onDeleteView={NOOP}
            config={config}
            onConfigChange={updateConfig}
            isDirty={isDirty}
            overrides={overrides}
            onSaveDraft={saveOverrides}
            onDiscardDraft={discardOverrides}
            actions={!inCard ? <ExpandableSearch value={search} onChange={setSearch} label="Search pull requests" placeholder="Search pull requests…" /> : undefined}
          />
          <div data-view-body="" className="relative min-h-0 flex-1 overflow-hidden">
            {error ? (
              <StateMessage data={{ 'data-reviews-error': error.code ?? '' }}>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {error.message}
                </p>
                {notConnected && (
                  <Link href="/account/settings/connectors" className="text-sm font-medium text-foreground underline underline-offset-2">
                    Open Connectors
                  </Link>
                )}
              </StateMessage>
            ) : !loading && rows.length === 0 ? (
              <StateMessage>
                <p className="text-sm text-muted-foreground" data-reviews-empty="">
                  No pull requests here.
                </p>
              </StateMessage>
            ) : (
              <ListFocusProvider value={liveFocusedId}>
                {layout === 'board' ? (
                  <ViewBoard
                    entityType="github_pr"
                    data={data as GroupedResults[]}
                    loading={loading}
                    config={config}
                    selectedItemId={openKey}
                    onItemSelect={onItemSelect}
                  />
                ) : (
                  <ViewList
                    entityType="github_pr"
                    data={data}
                    loading={loading}
                    loadingMore={loadingMore}
                    hasMore={!!cursor}
                    onLoadMore={() => void more()}
                    config={config}
                    selectedItemId={openKey}
                    onItemSelect={onItemSelect}
                  />
                )}
              </ListFocusProvider>
            )}
            {layout === 'board' && closedOffBoard > 0 && (
              <p data-reviews-closed-note="" className="absolute bottom-3 left-[18px] text-xs text-muted-foreground">
                {closedOffBoard} closed without merging {closedOffBoard === 1 ? 'is' : 'are'} not on the board: see them in List.
              </p>
            )}
          </div>
        </div>
      </CardCovered>
      {openKey && (
        <CardOverlay>
          <PullDetail
            key={openKey}
            prKey={openKey}
            summary={openRow?.pr ?? null}
            fallbackTitle={place.at?.label}
            onClose={() => place.go(null)}
            onPrev={step(-1)}
            onNext={step(1)}
            onMerged={() => void reload()}
            onOpenAction={(id) => records.open({ type: 'action', id })}
          />
        </CardOverlay>
      )}
      <RecordOverlay records={records} page={props} />
    </div>
  )
}

function Pill({ on, onClick, data, children }: { on: boolean; onClick: () => void; data: Record<string, string>; children: React.ReactNode }) {
  return (
    <button
      type="button"
      {...data}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors',
        on ? 'border-foreground bg-foreground font-medium text-background' : 'border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** The page's empty and error states: the kind's own icon over a line, centred in the list's place. */
function StateMessage({ children, data }: { children: React.ReactNode; data?: Record<string, string> }) {
  return (
    <div {...data} className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <EntityIcon kind="github_pr" size="lg" muted />
      {children}
    </div>
  )
}

export type { ReviewPrRow }
