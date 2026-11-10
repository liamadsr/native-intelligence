'use client'

import * as React from 'react'
import { useIsWindowFocused } from './tab-active'
import { toast } from 'sonner'
import { ExpandableSearch } from './expandable-search'
import { ViewToolbar } from './view-toolbar'
import { ENTITY_PLURAL } from './view-tabs'
import { ViewList } from './view-list'
import { ViewBoard } from './view-board'
import { CardHeaderSlot } from '@/components/chat-cards/card-header-slot'
import { defaultConfig, spansWorkspaces, useView, useViewConfig, useViewResults, type CardConfigSource, type ViewConfig } from './hooks/use-view'
import { CARD_SEARCHABLE_ENTITIES } from '@/lib/chat-cards/kinds'
import { useShowAllWorkspaces } from '@/lib/workspace-span'
import { useBulkSelection } from './hooks/use-bulk-selection'
import { useBulkActions } from './bulk-actions/use-bulk-actions'
import { BulkActionBar, SELECTION_ISLAND_CLASS } from './bulk-actions/bulk-action-bar'
import { CompanyDeleteDialog } from './bulk-actions/company-delete-dialog'
import { ProspectListDeleteDialog } from './bulk-actions/prospect-list-delete-dialog'
import { MoveWorkspaceDialog } from '@/components/move/move-workspace-dialog'
import {
  ADD_TO_SEQUENCE_EVENT,
  AddToSequenceDialog,
  type AddToSequenceEventDetail,
} from '@/components/sequences/add-to-sequence-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SEQUENCE_ALLOWED_TRANSITIONS, type SequenceStatus } from '@/lib/sequences/types'
import { sequenceMoveBlockedMessage } from '@/lib/sequences/ui-helpers'
import { PROSPECT_GLOBAL_DISMISS_REASONS } from '@/lib/prospecting/types'
import { emitProspectEntryAction, useProspectEntryActionTarget } from './list/entity-row'
import { usePickerContext } from './hooks/use-picker-context'
import { useFlowStatusIds } from './hooks/use-flow-status-ids'
import { type BulkActionId, isStatusByTeamValue } from './bulk-actions/types'
import type { ViewEntityType, GroupedResults, ViewFilter, ViewLayout, ViewScope, CrmScope } from '@/lib/views/types'
import type { ProspectStageTab, ProspectStageCounts } from '@/lib/views/prospect-stage-tabs'
import { DEFAULT_BOARD_GROUP_BY } from '@/lib/views/types'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { useWorkspaceId, useCurrentMemberId } from '@/app/account/workspace-switcher'
import { useCaptureVisibilityViewer } from '@/app/account/(dashboard)/components/capture-visibility-control'
import { onEntityUpdated, onEntityDeleted, emitEntityUpdated, wasRecentlyMutatedLocally } from '@/lib/entity-events'
import { seedDetailFromListItem } from './detail-prefetch'
import type { VisibleItem } from './detail-nav-utils'
import { celebrate } from '@/components/celebration/celebrate'
import { patchCompletesItem } from '@/components/celebration/detect-completion'
import type { WorkflowStateOption } from '@/components/views/properties/types'
import { useCanOpenCards } from '@/app/account/(dashboard)/main-chat/main-chat-context'
import { openTarget } from '@/lib/chat-cards/open-card'
import {
  isCrossWorkspaceEditable, isForeignWorkspace, rowWorkspace, rowWorkspaceHeaders,
} from './row-workspace'

// `claim` is searchable in every layout, including the graph: a claim IS its
// text, and "find the thing we said about pricing" is the most direct way into
// a knowledge graph. The query engine answers it through the generated `fts`
// tsvector and its GIN index rather than an unindexed ilike, and the map
// applies the same term as a text predicate over the full claim text — so the
// canvas highlights exactly the nodes the list would have rowed.
const SEARCHABLE_ENTITY_TYPES: ViewEntityType[] = ['contact', 'company', 'document', 'claim']

/**
 * Should a capture UPDATE evict the row from an open list/board?
 *
 * Only when the capture went private and the viewer is not its creator — the
 * visibility rule (`visibility = 'workspace' OR user_id = viewer`) read the
 * only way a list can read it. Defensive: post-RLS Supabase gates realtime
 * delivery on the NEW row, so a non-creator is not served this event at all.
 * That is also why it FAILS OPEN on an unknown viewer or an unknown owner:
 * evicting on a missing id would hide the creator's own capture the instant
 * they made it private.
 */
/** `user_id` of the row with this id, across both flat and grouped results. */
export function findRowUserId(data: unknown, id: string): unknown {
  if (!Array.isArray(data) || data.length === 0) return undefined
  const rows = 'items' in (data[0] as Record<string, unknown>)
    ? (data as GroupedResults[]).flatMap((g) => g.items ?? [])
    : (data as Record<string, unknown>[])
  return rows.find((r) => r?.id === id)?.user_id
}

export function shouldEvictCaptureRow(
  entityType: string,
  fields: Record<string, unknown>,
  rowUserId: unknown,
  viewerUserId: string | null,
): boolean {
  if (entityType !== 'capture') return false
  if (fields.visibility !== 'private') return false
  const ownerId = (fields.user_id ?? rowUserId) as string | undefined | null
  if (!ownerId || !viewerUserId) return false
  return ownerId !== viewerUserId
}

/**
 * A scoped instance (scopeFilters present) pins what the list shows, so the
 * built-in scopes must never activate there. For CRM: 'companies' would flip
 * the embed to a list of ALL companies (the company panel's People tab
 * becoming every company in the workspace), and 'internal'/'external' would
 * silently drop rows. For captures: 'mine'/'shared' would partition a
 * parent-pinned list (the contact panel's Captures tab) by ownership. The
 * scope pills are already hidden in scoped instances, but a crm_scope or
 * capture_scope can still arrive via a RESTORED config — a stale localStorage
 * draft or a saved view — which is why the values are neutralized at the
 * source rather than only suppressing the UI that sets them.
 */
export function sanitizeScopedConfig<T extends { crm_scope: CrmScope; capture_scope: 'all' | 'mine' | 'shared' }>(
  config: T,
  scoped: boolean,
): T {
  if (!scoped || (config.crm_scope === 'contacts' && config.capture_scope === 'all')) return config
  return { ...config, crm_scope: 'contacts', capture_scope: 'all' }
}

// The window-focus context lives in its own tiny module (tab-active.tsx);
// re-exported here for every importer of this one.
export { WindowFocusProvider, useIsWindowFocused } from './tab-active'

/** Bulk selection state exposed to the parent (the selection island itself is
 *  the layout's — a page adds its own verbs to it through `selectionActions`). */
export interface BulkSelectionInfo {
  count: number
  hasSelection: boolean
  entityType: ViewEntityType
  onClear: () => void
  onAction: (actionId: BulkActionId, value?: unknown) => void
  /**
   * The ids actually checked, in selection order.
   *
   * `onAction` covers every bulk action the LAYOUT knows how to run, but two
   * of `prospect_list_entry`'s cannot go through it: `save_to_crm` returns
   * per-entry outcomes (created / already-saved / no-domain) that the generic
   * `{success, failed}` bulk response cannot express, and `dismiss` must
   * collect a REASON first — two of which suppress workspace-wide. Both are
   * owned by the prospecting list-detail page, which needs the ids to POST.
   * Exposing them here is additive and lets that page own the intercept
   * without a second selection model shadowing this one.
   */
  selectedIds: string[]
  allVisibleIds: string[]
  onSelectAll: (ids: string[]) => void
}

interface UnifiedViewLayoutProps {
  entityType: ViewEntityType
  teamId?: string
  /** Called when an item row is clicked — parent navigates to detail.
   *  `entityType` is the EFFECTIVE type of the clicked row: the CRM view is
   *  mounted as entityType='contact' but its Companies scope tab lists company
   *  rows, and the parent needs to know which detail to open. */
  onItemSelect?: (itemId: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>, entityType?: ViewEntityType) => void
  /** If the parent manages selection, pass the selected id so we highlight the row */
  selectedItemId?: string | null
  /** Called when the visible list of item IDs changes (for prev/next navigation) */
  onVisibleIdsChange?: (ids: string[]) => void
  /** Called when the visible list of items changes with full item data (for
   *  prev/next navigation). entityType is what the rows actually are — on the
   *  CRM page the Companies scope lists companies while the view stays
   *  'contacts', so the parent cannot derive it. */
  onVisibleItemsChange?: (items: VisibleItem[], entityType?: ViewEntityType) => void
  /** Called when the CRM scope changes (contacts ↔ companies, internal ↔ external) */
  onCrmScopeChange?: (scope: CrmScope) => void
  /** Called whenever bulk selection state changes, so the parent can render the action bar in the header */
  onBulkSelectionChange?: (info: BulkSelectionInfo) => void
  /** Exposes updateItem so the parent can patch a single item in the list without refetching */
  onUpdateItemReady?: (updateItem: (id: string, fields: Record<string, unknown>) => void) => void
  /**
   * Filters that are merged into every query and cannot be removed by the
   * user. Used to restrict a list to a parent entity (Project → Actions,
   * Initiative → Projects).
   */
  scopeFilters?: ViewFilter[]
  /**
   * Filters merged into every query WITHOUT making this a scoped instance:
   * the view tabs, the CRM's own pills and the saved views all stay live, and
   * these narrow on top of whatever the user has open. The CRM's "From list"
   * chips (migration 259) ride here — a `scopeFilters` scope would have hidden
   * the Internal/External/Companies pills the user is combining it with.
   */
  extraFilters?: ViewFilter[]
  /**
   * When set, saved views created from this instance are persisted under
   * `(scope_type, scope_id)` so they don't appear in the global listing.
   */
  viewScope?: ViewScope
  /**
   * Controlled search term. When provided, the parent owns the search input
   * (e.g. rendered in the page header) and the layout's own in-list search bar
   * is hidden. The value is still debounced internally before querying.
   */
  searchValue?: string
  /**
   * True while an opaque detail overlay is layered on top of this list. The
   * list stays MOUNTED underneath — that's the whole point: scroll offset,
   * pagination, scope tabs, draft resolution, realtime subscriptions and the
   * reported visible-item order all survive a detail open/close.
   *
   * What must NOT survive is interactivity. A covered-but-mounted subtree is
   * still in the tab order and still receives keyboard/pointer events routed by
   * focus, so a user tabbing inside the detail panel would fall through into
   * invisible rows, filter menus and the toolbar's search box. `inert` on the
   * wrapper is the containment: it drops the whole subtree out of tab order and
   * suppresses focus + interaction events without unmounting anything, so every
   * data listener (realtime, entity-created/updated, reconnect catch-up) keeps
   * running untouched.
   */
  obscured?: boolean
  /**
   * Saved-view selection driven from the outside — the tab's history entry.
   * `undefined` leaves the layout UNCONTROLLED (it keeps owning the selection
   * and restoring it from localStorage, which is what arriving from the nav menu
   * does). A defined value — `string` for a saved view, `null` for the built-in
   * default — is applied to the layout whenever it differs, which is how Back
   * and Forward re-select the view the user was on.
   */
  historyViewId?: string | null
  /**
   * Fired when the USER picks a view from the toolbar, so the parent can record
   * it as a history step. Deliberately NOT fired when a `historyViewId` change
   * is applied — that application is itself the result of a history move, and
   * echoing it back would push a duplicate step (or loop).
   */
  onViewSelectionChange?: (view: { id: string; name: string } | null) => void
  /**
   * The prospect list's stage tabs (All · Saved · Needs review · Dismissed),
   * drawn in the views' tab row as baseline navigation — see ViewToolbar. The
   * page owns the value (`null` while a custom view is open) and the counts.
   */
  prospectStage?: ProspectStageTab | null
  prospectStageCounts?: ProspectStageCounts | null
  onProspectStageChange?: (tab: ProspectStageTab) => void
  /** Page-owned controls for the toolbar's right cluster — see ViewToolbar. */
  toolbarActions?: React.ReactNode
  /**
   * Page-owned verbs for the selection — the prospect list's Save, Dismiss,
   * Enrich… — drawn in a SECOND island floating directly above the layout's
   * own (count · Select all · Actions; see BulkActionBar), never mixed into
   * it. Liam, 2026-09-06: "for cases like the prospect page where there's
   * more options than the usual action button and the select all button … a
   * secondary menu, like a second island floating above it".
   */
  selectionActions?: React.ReactNode
  /**
   * Reports the ACTIVE saved view on mount and whenever it changes — including
   * a selection restored from localStorage, which `onViewSelectionChange`
   * deliberately never reports. The prospect list page reads it to stand its
   * stage tab down while a custom view is open.
   */
  onActiveViewChange?: (viewId: string | null) => void
  /**
   * Hands the parent the layout's own view selector, the way `onUpdateItemReady`
   * hands it `updateItem`. A page that picks a stage tab programmatically (the
   * save story's "open Saved" link) has to clear the open custom view too, or a
   * tab and a view would both read as selected.
   */
  onViewSelectorReady?: (
    select: (viewId: string | null, opts?: { silent?: boolean }) => void,
  ) => void
  /**
   * Body for `layout === 'graph'`, supplied by the page rather than imported
   * here.
   *
   * The only graph today is the knowledge map, which pulls in a WebGL renderer,
   * a tile store and a shader set. Importing that from this file would put it
   * in the bundle of every list in the product — the CRM, Actions, Documents —
   * none of which can ever render it. So the views system owns the LAYOUT
   * (a third value, a toggle, a saved-view field) and the page owns the
   * PICTURE, and the two meet at the filters.
   *
   * It receives the view's live filters, already merged with any scope filters,
   * so a graph reads exactly the rows its list would. A page that leaves this
   * out simply cannot be put into graph layout — see `effectiveLayout`.
   */
  renderGraph?: (args: { filters: ViewFilter[]; search: string }) => React.ReactNode
  /**
   * Reports the view's live filters — the user's own, merged with any scope
   * filters — whenever they change.
   *
   * The Knowledge page reads them to derive a package's standing rules when the
   * user promotes what they are looking at. It cannot derive them itself: the
   * filters live in this component's config/draft layer, and `scopeFilters` are
   * merged here rather than by the page.
   */
  onFiltersChange?: (filters: ViewFilter[]) => void
  /**
   * A card in the chat (docs/plans/one-agent-and-chat-pages.md): the page as
   * the agent described it, beside the real one. Its baseline is the agent's
   * page; the person's changes (filters, sort, columns, search) belong to the
   * card, never to the real page's selection or drafts. Its saved views are
   * the tab row, as on a window, picked for the card alone, and its search
   * sits in the card's header, where a window's was; it spans one workspace,
   * and reports what it shows so the agent can be told (onStateChange).
   */
  card?: CardLayoutOptions
}

/** What a chat card hands the layout (see UnifiedViewLayoutProps.card). */
export interface CardLayoutOptions extends CardConfigSource {
  /** The person's search as the card last kept it. Read once, at mount. */
  search?: string
  onSearchChange?: (search: string) => void
  /** A slimmer toolbar for the inline card: no view tabs, the filter and settings buttons only. */
  compact?: boolean
  /** What the card shows now, whenever it changes. */
  onStateChange?: (state: CardLayoutState) => void
  /** Keep the view-tabs row (a prospect list's stage tabs live in it). */
  keepTabs?: boolean
  /**
   * The saved view the card had picked (null: the page itself; undefined:
   * none kept). Read once, at mount, and applied as a history entry is, so
   * a card loaded again (let go and opened again, or after a reload) lands
   * on its view.
   */
  view?: string | null
  /** The person picked another saved view (or the page itself). */
  onViewChange?: (viewId: string | null) => void
}

/**
 * The page card around a list (src/components/chat-cards/pages): hands every
 * UnifiedViewLayout inside it card options, keyed by entity and scope, so a
 * list the page draws deep inside (a suite's cases) is a card list too.
 */
export interface CardSurface {
  listOptions: (entityType: ViewEntityType, key: string) => CardLayoutOptions
}

export const CardSurfaceContext = React.createContext<CardSurface | null>(null)

export interface CardLayoutState {
  config: ViewConfig
  /** The agent's page, even while a saved view is picked: the change is the person's. */
  baseline: ViewConfig
  /** The entity's own defaults, to tell what is still the page default. */
  defaults: ViewConfig
  search: string
  /** Null until the first page has loaded. */
  total: number | null
  /** The rows loaded, flattened, in order. */
  rows: Record<string, unknown>[]
}

/**
 * The layout actually rendered.
 *
 * A saved view carries `layout` as a free enum value, and a page that does not
 * supply `renderGraph` has no picture to draw — so rather than render nothing,
 * a `graph` view on such a page falls back to the list. That is not a
 * hypothetical: `view_layout` is global across every entity type (one enum, one
 * column), so a view of ANY entity can be persisted with `layout='graph'`, and
 * a claim view opened on a surface that embeds claims without a canvas takes
 * the same path.
 *
 * Exported because everything downstream keys off the EFFECTIVE layout, not the
 * configured one — including whether the row query runs. A gate written against
 * `config.layout` instead would leave that fallback list permanently empty.
 */
export function resolveEffectiveLayout(layout: ViewLayout, hasGraph: boolean): ViewLayout {
  return layout === 'graph' && !hasGraph ? 'list' : layout
}

/**
 * Headless list-panel component: toolbar → filters → list/board.
 * The shared header is rendered by the parent (tab-content.tsx).
 */
export function UnifiedViewLayout({
  entityType, teamId,
  onItemSelect: onItemSelectProp,
  selectedItemId: selectedItemIdProp,
  onVisibleIdsChange,
  onVisibleItemsChange,
  onCrmScopeChange,
  onBulkSelectionChange,
  onUpdateItemReady,
  scopeFilters,
  extraFilters,
  viewScope,
  searchValue,
  obscured = false,
  historyViewId,
  onViewSelectionChange,
  prospectStage,
  prospectStageCounts,
  onProspectStageChange,
  toolbarActions,
  selectionActions,
  onActiveViewChange,
  onViewSelectorReady,
  renderGraph,
  onFiltersChange,
  card: cardProp,
}: UnifiedViewLayoutProps) {
  // A list inside a page card that wasn't handed its own card options (a
  // sequence's page, a suite's cases, a list's entries) takes them from the
  // card around it, so it too keeps its changes with the card and never
  // touches the real page's saved views, selection or drafts.
  const cardSurface = React.useContext(CardSurfaceContext)
  const surfaceKey = `${entityType}:${viewScope ? `${viewScope.type}:${viewScope.id}` : (teamId ?? '')}`
  const surfaceCard = React.useMemo(
    () => (!cardProp && cardSurface ? cardSurface.listOptions(entityType, surfaceKey) : undefined),
    [cardProp, cardSurface, entityType, surfaceKey],
  )
  const card = cardProp ?? surfaceCard
  // Where a prospect row's intent goes: the card's own target inside a chat
  // card, else window (see ProspectEntryActionTargetContext).
  const prospectActionTarget = useProspectEntryActionTarget()
  const isControlledSearch = searchValue !== undefined
  // The active workspace — what every row's own workspace is compared against
  // (see handleItemSelect) and what the picker context is keyed on further
  // down. Read once, up here, because the row-click handler is declared long
  // before the picker context is.
  const workspaceId = useWorkspaceId()
  // A foreign row opens as a card in its own workspace, where there is a
  // chat to open it in (not on a bare panel or in a test).
  const canOpenCards = useCanOpenCards()
  // Read inside event-handler callbacks that must stay referentially stable
  // (patchItem is handed to every memoized row; rebuilding it would re-render
  // the whole list). Same latest-value-ref idiom the rest of this file uses.
  const workspaceIdRef = React.useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  // Every row currently loaded, flattened — filled further down, where the
  // data is. Declared here because the callbacks that read it (the bulk
  // hook's workspace resolver, getChildren) must stay stable and must not
  // take the array as a dependency.
  const flatVisibleDataRef = React.useRef<Record<string, unknown>[]>([])

  /**
   * Which workspace a SELECTED id lives in, for the bulk endpoint — `null`
   * meaning "the active one", which is the answer for every row outside the
   * cross-workspace scope and the one that leaves the request untouched.
   * Stable, so the bulk hook's `execute` keeps its identity.
   */
  const workspaceIdOfItem = React.useCallback((id: string): string | null => {
    const row = flatVisibleDataRef.current.find(it => (it as { id?: string }).id === id)
    const ws = rowWorkspace(row)
    return isForeignWorkspace(ws, workspaceIdRef.current ?? null) ? ws!.id : null
  }, [])

  /** Is this row from a workspace other than the active one? */
  const isForeignRow = React.useCallback(
    (item: Record<string, unknown> | undefined) =>
      isForeignWorkspace(rowWorkspace(item), workspaceIdRef.current ?? null),
    [],
  )

  // The card's own list: the one that reports what the card shows. It has the
  // window's tab row (saved views) and puts its search in the card's header. A
  // quiet list inside a page card (a record's actions) has neither, or the
  // header would hold two searches; a prospect list keeps its own stage tabs.
  const cardOwnList = !!card && !!card.onStateChange && !card.keepTabs

  // View management
  const {
    views, activeViewId, activeView, setActiveViewId,
    createView, updateView, deleteView, duplicateView,
  } = useView(entityType, teamId, viewScope, { standalone: !!card, listViews: !card || cardOwnList })

  // ── Saved-view selection as history ──────────────────────
  // The parent may drive the selection (see historyViewId). Applying its value
  // must not look like a user pick, or the parent would record a step for its
  // own step. This ref is raised for exactly the duration of a programmatic
  // apply and read by the toolbar handler below.
  const applyingHistoryViewRef = React.useRef(false)
  const viewsRef = React.useRef(views)
  viewsRef.current = views
  // The last value we've reconciled against. Applying on "prop differs from
  // local state" rather than "prop CHANGED" would make the controlled value
  // fight the user: their pick updates local state first, the parent's
  // historyViewId is still the old one for that render, and the effect would
  // immediately yank the selection back before the parent's navigate lands.
  // Anchoring on prop identity means a user pick stands until history genuinely
  // moves somewhere else.
  //
  // Seeded to a sentinel rather than the initial prop so the FIRST value is
  // still applied: a tab restored onto a saved-view location mounts with
  // historyViewId already set, and that must win over whatever localStorage
  // happened to hold.
  const NOT_APPLIED = React.useRef(Symbol('not-applied')).current
  const lastHistoryViewIdRef = React.useRef<string | null | symbol>(NOT_APPLIED)
  // A chat card's own pick, as it kept it: the history's value when there is none.
  const [cardView] = React.useState(() => card?.view)
  const appliedViewId = historyViewId !== undefined ? historyViewId : cardView
  const onCardViewChangeRef = React.useRef(card?.onViewChange)
  onCardViewChangeRef.current = card?.onViewChange
  React.useEffect(() => {
    if (appliedViewId === undefined) {
      // Leaving controlled mode (Back/Forward landed on a plain view entry that
      // expresses no opinion). Reset the anchor so a LATER return to a
      // custom-view entry re-applies its value — without this, Back onto the
      // same saved-view entry the user came from would early-return on the
      // identity check and never restore the selection.
      lastHistoryViewIdRef.current = NOT_APPLIED
      return
    }
    if (appliedViewId === lastHistoryViewIdRef.current) return
    lastHistoryViewIdRef.current = appliedViewId
    if (appliedViewId === activeViewId) return
    applyingHistoryViewRef.current = true
    try {
      // setActiveViewId also writes localStorage, so a history-driven selection
      // is still what a cold start restores.
      setActiveViewId(appliedViewId)
    } finally {
      applyingHistoryViewRef.current = false
    }
  }, [appliedViewId, activeViewId, setActiveViewId])

  const handleViewSelected = React.useCallback((viewId: string | null, opts?: { silent?: boolean }) => {
    setActiveViewId(viewId)
    if (applyingHistoryViewRef.current) return
    // A chat card keeps the pick, whatever made it.
    onCardViewChangeRef.current?.(viewId)
    // `silent` marks a selection change that is a SIDE EFFECT of some other
    // gesture rather than a view pick — the scope tabs clear the saved view on
    // the way to changing scope. Recording those as history steps pushed a
    // step labelled "Default" that reverted nothing on Back (scope itself
    // lives outside history) and locked the layout into controlled mode for
    // the rest of the tab's life.
    if (opts?.silent) return
    if (!onViewSelectionChange) return
    if (viewId === null) {
      onViewSelectionChange(null)
      return
    }
    const picked = viewsRef.current.find(v => v.id === viewId)
    onViewSelectionChange({ id: viewId, name: picked?.name ?? 'View' })
  }, [setActiveViewId, onViewSelectionChange])

  // What the parent may know about the selection: the active view as it
  // stands (restored ids included), and a handle to change it.
  React.useEffect(() => {
    onActiveViewChange?.(activeViewId)
  }, [activeViewId, onActiveViewChange])
  React.useEffect(() => {
    onViewSelectorReady?.(handleViewSelected)
  }, [handleViewSelected, onViewSelectorReady])

  // Fields locked by scopeFilters — DnD and grouping across these is a no-op,
  // and scope-only display properties key off them (defaults + picker).
  const lockedScopeFields = React.useMemo(
    () => new Set((scopeFilters ?? []).map(f => f.field)),
    [scopeFilters],
  )

  const isScopedInstance = Boolean(scopeFilters?.length)

  // How many workspaces this list spans: the workspace menu's "Show all
  // workspaces" switch, for the lists it reaches (My Actions and Projects —
  // spansWorkspaces), and always the active one for every other list.
  const showAllWorkspaces = useShowAllWorkspaces()
  // A chat card is the agent's page of the active workspace, whatever the switch says.
  const workspaceScope =
    !card && showAllWorkspaces && spansWorkspaces(entityType, { teamId, scoped: isScopedInstance }) ? 'all' : 'workspace'

  const {
    config: rawConfig,
    updateConfig: rawUpdateConfig,
    resetConfig,
    isDirty,
    saveOverrides,
    discardOverrides,
    overrides,
    baseline: configBaseline,
    cardPageBaseline,
  } = useViewConfig(activeView, entityType, updateView, isScopedInstance, lockedScopeFields, workspaceScope, card)

  // Scoped instances treat any restored crm_scope / capture_scope as unset
  // (see sanitizeScopedConfig).
  const config = React.useMemo(
    () => sanitizeScopedConfig(rawConfig, isScopedInstance),
    [rawConfig, isScopedInstance],
  )

  // CRM: effective entity type switches between contact/company based on crm_scope
  const effectiveEntityType: ViewEntityType = entityType === 'contact' && config.crm_scope === 'companies' ? 'company' : entityType

  // Notify parent when CRM scope changes so item-select handler uses the right entity
  React.useEffect(() => {
    if (onCrmScopeChange) onCrmScopeChange(config.crm_scope)
  }, [config.crm_scope, onCrmScopeChange])

  // Search state — debounced so we don't fire a query on every keystroke.
  // In controlled mode the input lives in the parent; we just debounce the
  // incoming `searchValue`. In uncontrolled mode we own the input too.
  // A chat card starts from the search it kept, and keeps every change.
  const cardRef = React.useRef(card)
  cardRef.current = card
  const [searchInput, setSearchInput] = React.useState(() => card?.search ?? '')
  const debouncedSearchRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const [debouncedSearch, setDebouncedSearch] = React.useState(() => card?.search ?? '')
  const handleSearchChange = React.useCallback((value: string) => {
    setSearchInput(value)
    cardRef.current?.onSearchChange?.(value)
    if (debouncedSearchRef.current) clearTimeout(debouncedSearchRef.current)
    debouncedSearchRef.current = setTimeout(() => setDebouncedSearch(value), 300)
  }, [])
  // Debounce the controlled value from the parent.
  React.useEffect(() => {
    if (!isControlledSearch) return
    if (debouncedSearchRef.current) clearTimeout(debouncedSearchRef.current)
    debouncedSearchRef.current = setTimeout(() => setDebouncedSearch(searchValue ?? ''), 300)
    return () => {
      if (debouncedSearchRef.current) clearTimeout(debouncedSearchRef.current)
    }
  }, [isControlledSearch, searchValue])
  // Reset search when entity type changes (e.g. contacts ↔ companies tab
  // switch). A card's entity never changes, and its kept search must stand.
  const isCard = !!card
  React.useEffect(() => {
    if (isCard) return
    setSearchInput('')
    setDebouncedSearch('')
  }, [effectiveEntityType, isCard])

  // A card searches whatever the query engine can search (a title, a name).
  const isSearchable = card
    ? CARD_SEARCHABLE_ENTITIES.has(effectiveEntityType) || SEARCHABLE_ENTITY_TYPES.includes(effectiveEntityType)
    : SEARCHABLE_ENTITY_TYPES.includes(effectiveEntityType)
  const activeSearch = isSearchable ? debouncedSearch : undefined

  // What every query is pinned to: the instance's scope, plus any extra
  // narrowing the page composes on top (the CRM's "From list" chips). Memoised
  // so the results hook's dependency key does not churn on every render.
  const queryFilters = React.useMemo<ViewFilter[] | undefined>(
    () =>
      (scopeFilters?.length ?? 0) + (extraFilters?.length ?? 0) > 0
        ? [...(scopeFilters ?? []), ...(extraFilters ?? [])]
        : undefined,
    [scopeFilters, extraFilters],
  )

  const effectiveLayout = resolveEffectiveLayout(config.layout, Boolean(renderGraph))

  const isGraph = effectiveLayout === 'graph'

  // A background tab's list holds its query until the tab is activated (perf
  // plan 2.2); cached rows still render meanwhile. Tab-active, NOT drawn:
  // tucking the windows must not delay a first load.
  const { data, loading, loadingMore, totalCount, hasMore, loadMore, refetch, updateItem, moveItemBetweenGroups, removeItem } = useViewResults(activeViewId, config, effectiveEntityType, teamId, queryFilters, activeSearch, !isGraph)

  /**
   * The filters the graph draws — the same merged set the row query would have
   * used, so the canvas and the list answer one saved view identically. Built
   * here rather than in the page because `queryFilters` (scope + extra) is this
   * component's own composition and the page cannot see it.
   */
  const graphFilters = React.useMemo<ViewFilter[]>(
    () => [...(queryFilters ?? []), ...config.filters],
    [queryFilters, config.filters],
  )

  React.useEffect(() => {
    onFiltersChange?.(graphFilters)
  }, [graphFilters, onFiltersChange])

  // A chat card reports what it shows: its config against the agent's
  // baseline, its search, its count and its rows (for the agent's note).
  const cardDefaults = React.useMemo(() => (isCard ? defaultConfig(entityType) : null), [isCard, entityType])
  React.useEffect(() => {
    const report = cardRef.current?.onStateChange
    if (!report || !cardDefaults) return
    const rows = Array.isArray(data) && data.length > 0 && 'items' in (data[0] as Record<string, unknown>)
      ? (data as GroupedResults[]).flatMap((g) => g.items ?? [])
      : (data as Record<string, unknown>[])
    report({
      config,
      baseline: cardPageBaseline ?? configBaseline,
      defaults: cardDefaults,
      search: activeSearch ?? '',
      total: loading && rows.length === 0 ? null : totalCount,
      rows,
    })
  }, [config, configBaseline, cardPageBaseline, cardDefaults, activeSearch, totalCount, data, loading])

  // Expose updateItem to parent so detail panel edits can patch a single row
  React.useEffect(() => {
    onUpdateItemReady?.(updateItem)
  }, [updateItem, onUpdateItemReady])

  // Wrap updateConfig so switching to board auto-sets a default grouping
  // and action_scope changes sync with actual filters
  const updateConfig = React.useCallback((updates: Parameters<typeof rawUpdateConfig>[0]) => {
    const merged = { ...updates }

    // Sync action_scope tab selection → real filter
    if (merged.action_scope && entityType === 'action') {
      const scope = merged.action_scope
      // Across workspaces the @me filter is not the way the scope travels —
      // `@me` resolves to the ACTIVE workspace's member id and the query route
      // drops `action_scope` whenever it sees such a filter, so the two
      // together would return one workspace's rows at best. The scope rides in
      // the request body instead (see defaultConfig, which suppresses the same
      // filter on the baseline side).
      const acrossWorkspaces = config.workspace_scope === 'all'
      // When switching scope tabs, start with a clean filter list. Strip the
      // auto-generated __scope_assignee filter (and any equivalent @me scope)
      // first; user-added filters are preserved.
      const baseFilters = merged.filters ?? []
      const withoutScope = baseFilters.filter(
        f => f.id !== '__scope_assignee' && !(f.value === '@me' && (f.field === 'assignee_id' || f.field === 'user_id'))
      )
      if (scope === 'all' || acrossWorkspaces) {
        // "All issues" has no scope filter — unassigned items stay visible.
        merged.filters = withoutScope
      } else {
        const field = scope === 'created' ? 'user_id' : 'assignee_id'
        merged.filters = [
          { id: '__scope_assignee', field, operator: 'is' as const, value: '@me' },
          ...withoutScope,
        ]
      }
    }

    if (merged.layout === 'board' && !config.grouping && !merged.grouping) {
      const defaultField = DEFAULT_BOARD_GROUP_BY[entityType]
      rawUpdateConfig({ ...merged, grouping: { field: defaultField, direction: 'asc' } })
    } else {
      rawUpdateConfig(merged)
    }
  }, [rawUpdateConfig, config.grouping, config.filters, config.workspace_scope, entityType])

  // ── Bulk selection ──────────────────────────────────────────
  const bulkSelection = useBulkSelection()

  // Use refs to avoid recreating the onComplete callback every render
  const bulkClearRef = React.useRef(bulkSelection.clear)
  bulkClearRef.current = bulkSelection.clear
  const refetchRef = React.useRef(refetch)
  refetchRef.current = refetch


  // Listen for entity creation events (from CreateDialog, AI chat, etc.)
  // and silently refresh the list if the created entity matches this view's type.
  //
  // Coalesced with a trailing debounce: a batch server-side create (e.g. MCP
  // create_actions_batch inserting 20 rows) fans out one realtime INSERT per
  // row, and refetching once at the end beats 20 overlapping queries.
  //
  // Automatic refetches (this debounce, the reconnect handler)
  // pass `coalesce: true` so lists on the same query share one
  // request (see useViewResults' refetch); ones after this list's own mutation
  // (bulk complete, failed move, column reorder) stay plain.
  const entityTypeRef = React.useRef(effectiveEntityType)
  entityTypeRef.current = effectiveEntityType
  const refetchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRefetch = React.useCallback(() => {
    if (refetchDebounceRef.current) clearTimeout(refetchDebounceRef.current)
    refetchDebounceRef.current = setTimeout(() => {
      refetchDebounceRef.current = null
      refetchRef.current({ coalesce: true })
    }, 300)
  }, [])
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { entityType: string }
      // Map create dialog entity types to view entity types
      const created = detail.entityType
      const viewing = entityTypeRef.current
      if (created === viewing || (created === 'contact' && viewing === 'company')) {
        scheduleRefetch()
      }
    }
    window.addEventListener('ni:entity-created', handler)
    return () => {
      window.removeEventListener('ni:entity-created', handler)
      if (refetchDebounceRef.current) clearTimeout(refetchDebounceRef.current)
    }
  }, [scheduleRefetch])

  // Refetch when realtime reconnects after a drop — events that fired during
  // the gap weren't delivered, so the list is potentially stale.
  React.useEffect(() => {
    const handler = () => {
      refetchRef.current({ coalesce: true })
    }
    window.addEventListener('ni:realtime-recovered', handler)
    return () => window.removeEventListener('ni:realtime-recovered', handler)
  }, [])

  // Patch a row in place when an entity is updated elsewhere (detail panel,
  // bulk action, AI tool). This avoids a full refetch and keeps the list in
  // sync without flicker.
  const updateItemRef = React.useRef(updateItem)
  updateItemRef.current = updateItem
  const removeItemRef = React.useRef(removeItem)
  removeItemRef.current = removeItem
  const moveItemBetweenGroupsRef = React.useRef(moveItemBetweenGroups)
  moveItemBetweenGroupsRef.current = moveItemBetweenGroups
  // Shared ref for current data — also read by inline-edit rollback below.
  const dataRef = React.useRef(data)
  dataRef.current = data
  // The viewer's AUTH uid (captures.user_id is a uid, not a member id), read
  // off the already-cached workspace payload. Ref'd because the entity-updated
  // listener is registered once and must not re-subscribe when it resolves.
  const { userId: viewerUserId } = useCaptureVisibilityViewer(useWorkspaceId())
  const viewerUserIdRef = React.useRef(viewerUserId)
  viewerUserIdRef.current = viewerUserId
  // Live ref for the board's group_by field — used by the entity-updated
  // listener to decide whether a remote change crosses board columns.
  const groupingFieldRef = React.useRef<string | null>(config.grouping?.field ?? null)
  groupingFieldRef.current = config.grouping?.field ?? null
  // Live ref for per-team workflow states (assigned after pickerContext is
  // computed below) — lets the status-change handlers resolve a status_id to
  // its category to decide whether a move completed an action (→ confetti).
  const workflowStatesByTeamRef = React.useRef<Record<string, WorkflowStateOption[]>>({})

  React.useEffect(() => {
    const offUpdated = onEntityUpdated((d) => {
      const viewing = entityTypeRef.current
      if (d.entityType !== viewing && !(d.entityType === 'contact' && viewing === 'company')) return

      // A contact merged into another is soft-deleted for list purposes —
      // server queries filter `merged_into_contact_id IS NULL`, so mirror
      // that here instead of patching a row that should vanish.
      if (d.fields.merged_into_contact_id != null) {
        removeItemRef.current(d.id)
        return
      }

      // A capture that went private is gone for everyone but its creator —
      // same shape as the merge case above: the row should vanish, not be
      // patched. See shouldEvictCaptureRow for why this is defensive.
      if (
        shouldEvictCaptureRow(
          d.entityType,
          d.fields,
          findRowUserId(dataRef.current, d.id),
          viewerUserIdRef.current,
        )
      ) {
        removeItemRef.current(d.id)
        return
      }

      // Raw column patches can't refresh JOINED display data: a realtime
      // UPDATE carries e.g. the new project_id but not the joined
      // project.name the row actually renders. When a joined FK changed and
      // we're not doing the board column-move dance below, a (debounced)
      // refetch is the only way to get correct display values.
      const JOINED_FK_FIELDS = [
        'status_id', 'project_id', 'assignee_id', 'company_id',
        'initiative_id', 'cycle_id', 'milestone_id', 'team_id',
        'stage_id', 'owner_id',
      ]
      const changedJoinedFk = JOINED_FK_FIELDS.some((f) => f in d.fields)
      const groupField = groupingFieldRef.current
      // Exception 1: a status_id change on a status-grouped board is resolved
      // locally below (the column move only needs the column key, not joined
      // display data) — as long as status_id is the ONLY joined FK changed.
      const boardHandlesIt =
        (groupField === 'status_id' || groupField === 'stage_id') &&
        groupField in d.fields &&
        !JOINED_FK_FIELDS.some((f) => f !== groupField && f in d.fields)
      // Exception 2: self-originated events (this tab's own drag/inline edit,
      // which already applied the change optimistically with correct joined
      // display data). Refetching here would race the in-flight PATCH — the
      // server can answer with pre-PATCH state and snap the card back.
      const selfOriginated = wasRecentlyMutatedLocally(d.entityType, d.id)
      if (changedJoinedFk && !boardHandlesIt && !selfOriginated) {
        scheduleRefetch()
        return
      }
      if (groupField && groupField in d.fields) {
        // The card changed columns. Try to derive the destination column
        // key from current data without a refetch — much cheaper than
        // re-fetching the entire list, especially on N-user boards.
        //
        // Column-key conventions (server-side groupResults):
        //   status_id  → `${workflow_state.category}::${workflow_state.name}`
        //   priority   → priority string ('high', 'med', 'low', 'none')
        //   *_id (fk)  → the UUID value itself, or '__none__' for null
        //   null value → '__none__' for any grouping field
        const groups = (dataRef.current as GroupedResults[]) ?? []
        const isGrouped = Array.isArray(groups) && groups.length > 0
          && typeof (groups[0] as GroupedResults)?.key === 'string'
        const newValue = d.fields[groupField]
        let toKey: string | undefined

        if (!isGrouped) {
          // List view, not grouped — just patch in place.
          updateItemRef.current(d.id, d.fields)
          return
        }

        // Server convention (see query-engine.ts getGroupKey):
        //   value === null/undefined → '__none__'
        //   anything else            → String(value)
        // status_id is a special case: server merges by `${category}::${name}`
        // to coalesce per-team duplicates, so we sample existing items or
        // group metadata to find the right column.
        if (newValue == null) {
          toKey = '__none__'
        } else if (groupField === 'status_id') {
          // Prefer the server-injected group metadata (works for empty
          // columns); fall back to sampling an existing item's workflow_state.
          const metaMatch = groups.find(g => g.metadata?.status_id === newValue)
          if (metaMatch) {
            toKey = metaMatch.key
          } else {
            for (const g of groups) {
              const sample = g.items?.find(it => (it.workflow_state as { id?: string } | undefined)?.id === newValue)
              if (sample) { toKey = g.key; break }
            }
          }
        } else {
          // Priority + foreign-key groupings — key is just String(value).
          // (priority='none' is a literal enum value, not the null sentinel;
          // the null path above is handled separately.)
          toKey = String(newValue)
        }

        // Find which column the card is currently in.
        let fromKey: string | undefined
        for (const g of groups) {
          if (g.items?.some(it => it.id === d.id)) { fromKey = g.key; break }
        }

        // If we resolved both endpoints AND the destination column exists in
        // current data, move locally. Otherwise fall back to refetch (handles
        // the "status changed to a column that's not in this view" case).
        if (toKey !== undefined && fromKey !== undefined && groups.some(g => g.key === toKey)) {
          if (toKey !== fromKey) {
            moveItemBetweenGroupsRef.current(d.id, fromKey, toKey, d.fields)
          } else {
            updateItemRef.current(d.id, d.fields)
          }
          return
        }
        // Debounced: diffed realtime payloads make this branch reachable for
        // remote bursts (e.g. a teammate bulk-completing 30 actions whose
        // destination column is hidden in this view) — an immediate refetch
        // here would fire one un-coalesced full view query per event.
        // scheduleRefetch (trailing 300ms) coalesces the burst exactly like
        // the changedJoinedFk path above; local-emit callers already applied
        // their change optimistically, so the short delay is invisible.
        scheduleRefetch()
        return
      }

      updateItemRef.current(d.id, d.fields)
    })
    const offDeleted = onEntityDeleted((d) => {
      const viewing = entityTypeRef.current
      if (d.entityType !== viewing && !(d.entityType === 'contact' && viewing === 'company')) return
      removeItemRef.current(d.id)
    })
    return () => { offUpdated(); offDeleted() }
  }, [scheduleRefetch])

  const onBulkComplete = React.useCallback(() => {
    bulkClearRef.current()
    refetchRef.current()
  }, [])

  const { execute: executeBulkAction } = useBulkActions(
    effectiveEntityType,
    onBulkComplete,
    workspaceIdOfItem,
  )

  // Clear selection when entity type or view changes
  React.useEffect(() => {
    bulkSelection.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEntityType, activeViewId])

  // Flatten grouped or flat data into a single array of item records.
  //
  // Sub-grouping moves every row down one level: groupResults fills
  // `group.subGroups` and EMPTIES `group.items`, so a flatMap over `g.items`
  // alone returns nothing for a sub-grouped view. That silently zeroed out both
  // consumers below — prev/next reported an empty list, and "select all"
  // selected nothing — on exactly the views where grouping is most useful.
  // Recurse instead, in render order (a group's own rows, then each sub-group's)
  // so the flattened order still matches what the list paints top to bottom.
  const flatVisibleData = React.useMemo(() => {
    if (!(Array.isArray(data) && data.length > 0 && 'items' in (data[0] as Record<string, unknown>))) {
      return data as Record<string, unknown>[]
    }
    const out: Record<string, unknown>[] = []
    const walk = (groups: GroupedResults[]) => {
      for (const g of groups) {
        if (g.items?.length) out.push(...g.items)
        if (g.subGroups?.length) walk(g.subGroups)
      }
    }
    walk(data as GroupedResults[])
    return out
  }, [data])

  flatVisibleDataRef.current = flatVisibleData

  // Compute all visible item IDs for "select all"
  const allVisibleIds = React.useMemo(
    () => flatVisibleData.map(item => item.id as string).filter(Boolean),
    [flatVisibleData],
  )

  // Compute visible items with title for prev/next navigation
  const allVisibleItems = React.useMemo(
    () =>
      flatVisibleData
        .filter(it => Boolean((it as { id?: string }).id))
        .map(it => ({
          id: (it as { id: string }).id,
          // Column names differ per entity: contacts carry `full_name` (not
          // `title`/`name`), and without it stepping onto a contact wrote an
          // empty title into history and the breadcrumb.
          title:
            (it as { title?: string }).title ??
            (it as { name?: string }).name ??
            (it as { full_name?: string }).full_name ??
            '',
          item: it as Record<string, unknown>,
        })),
    [flatVisibleData],
  )

  // Ids snapshotted when the bulk move dialog opens. The selection can change
  // (or be cleared) while the dialog is up, so the move must not read it live.
  const [moveDialogIds, setMoveDialogIds] = React.useState<string[]>([])

  // Contact ids snapshotted when the add-to-sequence picker opens (same
  // snapshot rationale as moveDialogIds). Fed by the bulk action AND by the
  // contact row's context-menu item via the ADD_TO_SEQUENCE_EVENT bridge.
  const [sequenceDialogIds, setSequenceDialogIds] = React.useState<string[]>([])

  // Company ids snapshotted when the cascade-delete confirmation opens (same
  // snapshot rationale as moveDialogIds). Deleting a company deletes all its
  // people, so the shared dialog dry-runs the delete and shows the exact
  // people count before the user can confirm.
  const [companyDeleteIds, setCompanyDeleteIds] = React.useState<string[]>([])
  const [listDeleteIds, setListDeleteIds] = React.useState<string[]>([])

  // Board drag onto the sequence Archived column, snapshotted while its
  // confirmation dialog is up. Archiving is legal from every status but
  // destructive — it exits every active enrollment — so a drag must clear the
  // SAME confirmation the equivalent bulk action does (BULK_ACTIONS.sequence
  // marks archive destructive) instead of committing on mouse-up.
  const [pendingArchiveDrag, setPendingArchiveDrag] = React.useState<
    { itemIds: string[]; fromGroup: string } | null
  >(null)

  // Only the focused copy of a contact list answers: a chat card and the real
  // page can both be mounted, and the event is window-wide.
  const isWindowFocused = useIsWindowFocused()
  React.useEffect(() => {
    if (effectiveEntityType !== 'contact' || !isWindowFocused) return
    const onAddToSequence = (e: Event) => {
      const ids = (e as CustomEvent<AddToSequenceEventDetail>).detail?.contactIds
      if (Array.isArray(ids) && ids.length > 0) setSequenceDialogIds(ids)
    }
    window.addEventListener(ADD_TO_SEQUENCE_EVENT, onAddToSequence)
    return () => window.removeEventListener(ADD_TO_SEQUENCE_EVENT, onAddToSequence)
  }, [effectiveEntityType, isWindowFocused])

  // Handle bulk action dispatch — the BulkActionBar resolves values internally
  const handleBulkAction = React.useCallback((actionId: BulkActionId, value?: unknown) => {
    const ids = Array.from(bulkSelection.selectedIds)
    // Cross-workspace move never goes through /api/account/bulk — it's a single
    // transactional RPC, and the shared dialog owns the destination picker and
    // the disclosure of what gets translated or dropped. Only action views
    // offer this action (see BULK_ACTIONS).
    if (actionId === 'move_to_workspace') {
      if (ids.length > 0) setMoveDialogIds(ids)
      return
    }
    // Enrollment has per-contact skip reasons the generic bulk endpoint can't
    // express — the shared dialog owns the sequence picker + the enroll call.
    if (actionId === 'add_to_sequence') {
      if (ids.length > 0) setSequenceDialogIds(ids)
      return
    }
    // Company delete cascades to every contact at the company — the shared
    // dialog owns the confirmation (with the dry-run people count) AND the
    // delete call, so it never goes through /api/account/bulk.
    if (actionId === 'delete' && effectiveEntityType === 'company') {
      if (ids.length > 0) setCompanyDeleteIds(ids)
      return
    }
    // A prospect list's delete goes through its own DELETE route, one list at
    // a time (a list with a run in flight is refused), and the shared dialog
    // owns the sentence about what goes and what stays in the CRM.
    if (actionId === 'delete' && effectiveEntityType === 'prospect_list') {
      if (ids.length > 0) setListDeleteIds(ids)
      return
    }
    // An action's status pick is a state name with each team's own id for it:
    // each action gets ITS team's state (one bulk request per state), never
    // another team's.
    if (actionId === 'change_status' && isStatusByTeamValue(value)) {
      const teamOf = new Map(flatVisibleDataRef.current.map((it) => [it.id as string, it.team_id as string | null | undefined]))
      const idsByState = new Map<string, string[]>()
      let unmatched = 0
      for (const id of ids) {
        const teamId = teamOf.get(id)
        const stateId = teamId ? value.stateIdByTeam[teamId] : undefined
        if (!stateId) { unmatched++; continue }
        const group = idsByState.get(stateId)
        if (group) group.push(id)
        else idsByState.set(stateId, [id])
      }
      if (unmatched > 0) {
        toast.error(`${unmatched} item${unmatched === 1 ? '' : 's'} not changed: no "${value.name}" status in ${unmatched === 1 ? 'its' : 'their'} team`)
      }
      void (async () => {
        for (const [stateId, group] of idsByState) await executeBulkAction(group, actionId, stateId)
      })()
      return
    }
    executeBulkAction(ids, actionId, value)
  }, [bulkSelection.selectedIds, effectiveEntityType, executeBulkAction])

  // Notify parent of bulk selection state for header rendering.
  // Use a ref for the callback and for functions to avoid dependency churn.
  const onBulkSelectionChangeRef = React.useRef(onBulkSelectionChange)
  onBulkSelectionChangeRef.current = onBulkSelectionChange
  const handleBulkActionRef = React.useRef(handleBulkAction)
  handleBulkActionRef.current = handleBulkAction

  // The Set gets a new identity on every selection change, so this array is
  // stable exactly as long as the selection is — which is what keeps the
  // notify effect below from firing on unrelated renders.
  const selectedIdList = React.useMemo(
    () => Array.from(bulkSelection.selectedIds),
    [bulkSelection.selectedIds],
  )

  React.useEffect(() => {
    const cb = onBulkSelectionChangeRef.current
    if (!cb) return
    cb({
      count: bulkSelection.count,
      hasSelection: bulkSelection.hasSelection,
      entityType: effectiveEntityType,
      onClear: bulkSelection.clear,
      onAction: (...args) => handleBulkActionRef.current(...args),
      selectedIds: selectedIdList,
      allVisibleIds,
      onSelectAll: bulkSelection.selectAll,
    })
  }, [bulkSelection.count, bulkSelection.hasSelection, effectiveEntityType, selectedIdList, allVisibleIds, bulkSelection.clear, bulkSelection.selectAll])

  // Notify parent of visible item IDs / items for prev/next navigation
  React.useEffect(() => {
    if (onVisibleIdsChange) onVisibleIdsChange(allVisibleIds)
  }, [allVisibleIds, onVisibleIdsChange])

  React.useEffect(() => {
    if (onVisibleItemsChange) onVisibleItemsChange(allVisibleItems, effectiveEntityType)
  }, [allVisibleItems, onVisibleItemsChange, effectiveEntityType])

  const selectedItemId = selectedItemIdProp ?? null
  const handleItemSelect = React.useCallback((id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => {
    // A ROW FROM ANOTHER WORKSPACE CANNOT BE OPENED IN THIS ONE.
    //
    // Every detail fetch behind the panel resolves its id against the ACTIVE
    // workspace (server-side from the cookie, client-side from the workspace
    // header), so handing a foreign id to the ordinary path opens a panel that
    // can only ever say "not found". It opens as a card in ITS workspace
    // instead: the card request carries that workspace, which is switched to
    // first (the native-notification handler's precedent, for the same reason).
    //
    // Only reachable from a cross-workspace list (workspace_scope 'all', the
    // "Show all workspaces" switch): in the default scope every row's
    // workspace IS the active one and this is a comparison of two equal
    // strings.
    // Seed the detail cache from the row before the panel mounts, so it can
    // paint from row data instantly (covers keyboard/touch opens that never
    // triggered the hover prefetch). Done BEFORE the cross-workspace fork
    // below as well as on the ordinary path: the cache is module-level and
    // survives the workspace switch, so the panel that opens on the other side
    // paints from the row the user actually clicked.
    seedDetailFromListItem(effectiveEntityType, item)

    const ws = rowWorkspace(item)
    if (canOpenCards && isForeignWorkspace(ws, workspaceId ?? null)) {
      event?.preventDefault()
      // A foreign row can only come from the two lists the switch reaches
      // (actions and projects), and only those two select the workspace
      // embed this branch keys off (ACTION_VIEW_SELECT, PROJECT_VIEW_SELECT).
      openTarget({ type: effectiveEntityType === 'project' ? 'project' : 'action', id, title }, { from: 'list', workspaceId: ws!.id })
      return
    }
    if (onItemSelectProp) onItemSelectProp(id, title, event, item, effectiveEntityType)
  }, [onItemSelectProp, effectiveEntityType, canOpenCards, workspaceId])

  // ── Board drag-and-drop ──────────────────────────────────
  // itemIds contains all IDs to move — either every checked item (multi-select
  // drag) or a single-element array for an unselected card drag.
  // Split in two: performMoveItem does the optimistic move + PATCHes;
  // handleMoveItem (below) is the drop handler, which runs the per-entity
  // guards first — sequence lifecycle rules and the archive confirmation —
  // so a guarded drop never gets an optimistic move it must roll back.
  const performMoveItem = React.useCallback(async (itemIds: string[], fromGroup: string, toGroup: string) => {
    if (!config.grouping) return

    const groupField = config.grouping.field

    const groups = data as GroupedResults[]
    const targetGroup = groups.find(g => g.key === toGroup)

    // Build a per-item map of the index of the source item, so we can look up
    // each item's own team when resolving a merged status column.
    const itemById = new Map<string, Record<string, unknown>>()
    for (const g of groups) {
      for (const it of g.items ?? []) itemById.set(it.id as string, it)
    }

    // Resolve the value to set for a single item. For status_id this is
    // team-aware: a board column keyed by `category::name` merges the matching
    // workflow_state from every team, so the item must land on ITS OWN team's
    // state — not an arbitrary first-team state. Using the wrong team's state
    // corrupts status and breaks team-scoped Flow triggers.
    const resolveValueFor = (itemId: string): unknown => {
      if (groupField === 'priority') {
        return toGroup === '__none__' ? 'none' : toGroup
      }
      if (groupField !== 'status_id') {
        // project_id, assignee_id, etc. — key is the UUID or '__none__'
        return toGroup === '__none__' ? null : toGroup
      }
      if (!targetGroup) return undefined

      // Team-aware resolution: prefer the dropped item's own team's state.
      const item = itemById.get(itemId)
      const teamId = item?.team_id as string | undefined
      const byTeam = targetGroup.metadata?.status_id_by_team as
        | Record<string, string>
        | undefined
      if (teamId && byTeam && byTeam[teamId]) {
        return byTeam[teamId]
      }
      // A FOREIGN card gets the team-aware answer or none. The fallbacks below
      // sample whatever is already in the column, which across workspaces means
      // some OTHER workspace's workflow_state id — and now that the PATCH
      // actually reaches the card's workspace, writing that would point the
      // action at a status row that doesn't exist there. Returning undefined
      // makes the caller bail out of the move instead.
      if (isForeignRow(item)) return undefined
      // Fallbacks (single-team board, or pre-status_id_by_team cached data):
      // the scalar status_id, then sampling an existing card's state.
      const metaStatusId = targetGroup.metadata?.status_id
      if (metaStatusId) return metaStatusId
      const sampleItem = targetGroup.items?.[0]
      const ws = sampleItem?.workflow_state as { id?: string } | undefined
      return ws?.id
    }

    // Pre-resolve each item's target value; bail if any status move can't be
    // resolved (e.g. a team with no matching state for this column).
    const valueByItem = new Map<string, unknown>()
    for (const itemId of itemIds) {
      const v = resolveValueFor(itemId)
      if (groupField === 'status_id' && (v === undefined || v === null)) return
      valueByItem.set(itemId, v)
    }

    // Optimistic: move each card to the target column immediately so the UI
    // feels instant. Track snapshots so we can roll back on failure.
    const snapshots = itemIds.map(itemId =>
      moveItemBetweenGroups(itemId, fromGroup, toGroup, { [groupField]: valueByItem.get(itemId) }),
    )

    // Fire PATCH requests in parallel — one per item (no bulk endpoint for
    // arbitrary field updates, but concurrent calls keep total latency low).
    const results = await Promise.allSettled(
      itemIds.map(async (itemId) => {
        const endpoint = ENTITY_ENDPOINTS[effectiveEntityType](itemId)
        if (!endpoint) return
        const newValue = valueByItem.get(itemId)
        const res = await fetch(endpoint, {
          method: 'PATCH',
          // A card dragged with "Show all workspaces" on belongs to whichever
          // workspace its row came from; without naming it the PATCH resolves
          // the id in the ACTIVE workspace and 404s, so the card springs back
          // to its old column. Empty (and the request unchanged) for every
          // same-workspace card — see rowWorkspaceHeaders.
          headers: {
            'Content-Type': 'application/json',
            ...rowWorkspaceHeaders(itemById.get(itemId), workspaceIdRef.current ?? null),
          },
          body: JSON.stringify({ [groupField]: newValue }),
        })
        if (!res.ok) {
          // Surface the API's `{ error }` message (see @/lib/api-errors) —
          // routes reject moves for reasons the user must be told about
          // (lifecycle rules, locks), and a bare status code hides them.
          let message = ''
          try {
            const body = (await res.json()) as { error?: unknown }
            if (typeof body?.error === 'string') message = body.error
          } catch { /* non-JSON error body */ }
          throw new Error(message || `HTTP ${res.status}`)
        }
        // Notify other surfaces (detail panel, sibling lists) so they update
        // their cached copy without a round-trip.
        emitEntityUpdated({
          entityType: effectiveEntityType as Parameters<typeof emitEntityUpdated>[0]['entityType'],
          id: itemId,
          fields: { [groupField]: newValue },
        })
      }),
    )

    // Rollback any items whose PATCH failed, then refetch as a safety net.
    const firstRejection = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    if (firstRejection) {
      itemIds.forEach((itemId, idx) => {
        const snapshot = snapshots[idx]
        if (snapshot) {
          moveItemBetweenGroups(itemId, toGroup, fromGroup, {
            [groupField]: snapshot[groupField] ?? null,
          })
        }
      })
      // Prefer the server's own explanation (a 400's `{ error }` body) over
      // the generic fallback, so a rejected move says WHY it was rejected.
      const reason = firstRejection.reason
      const serverMessage =
        reason instanceof Error && !/^HTTP \d+$/.test(reason.message)
          ? reason.message
          : null
      toast.error(serverMessage ?? 'Failed to move item(s)')
      refetch()
    }

    // Celebrate if any successfully-moved item just crossed into a completed
    // state (dragging a card onto the Done / Completed column). One pop per
    // drag, even if multiple cards were moved at once.
    const anyCompleted = itemIds.some((itemId, idx) => {
      if (results[idx]?.status !== 'fulfilled') return false
      return patchCompletesItem({
        entityType: effectiveEntityType,
        fields: { [groupField]: valueByItem.get(itemId) },
        prior: itemById.get(itemId),
        workflowStatesByTeam: workflowStatesByTeamRef.current,
      })
    })
    if (anyCompleted) celebrate()

    // Clear bulk selection after a multi-item drag so the board returns to
    // its normal (non-selection) state once the move is complete.
    if (itemIds.length > 1) {
      bulkClearRef.current()
    }
  }, [config.grouping, data, effectiveEntityType, moveItemBetweenGroups, refetch, isForeignRow])

  // Drop handler: per-entity guards, then performMoveItem.
  const handleMoveItem = React.useCallback((itemIds: string[], fromGroup: string, toGroup: string) => {
    if (!config.grouping) return
    const groupField = config.grouping.field

    // Don't allow DnD to change a scope-locked field — that would violate
    // the invariant that every row in a scoped list matches scopeFilters.
    if (lockedScopeFields.has(groupField)) return

    // A FOREIGN CARD MAY NOT TAKE THIS WORKSPACE'S VALUES.
    //
    // Across workspaces a board column's key is a value from whichever
    // workspace produced it. For `status_id` that is handled per card (the
    // column carries each team's own state id — see resolveValueFor), and
    // `priority` (actions) and `status` (projects) are enums that mean the
    // same thing everywhere. Every other grouping — project, assignee, lead,
    // initiative, cycle, milestone — keys its columns by a UUID belonging to
    // ONE workspace, so dropping another workspace's card there would write it
    // an id that doesn't exist in its own. Refused with the reason, rather
    // than left to 400 on the way back.
    const CROSS_WORKSPACE_DROPPABLE = new Set(['status_id', 'priority', 'status'])
    if (!CROSS_WORKSPACE_DROPPABLE.has(groupField)) {
      const foreign = itemIds
        .map(id => flatVisibleData.find(it => (it as { id?: string }).id === id))
        .find(it => isForeignRow(it))
      if (foreign) {
        const name = rowWorkspace(foreign)?.name ?? 'its own workspace'
        toast.error(`This column belongs to this workspace — open the item in ${name} to change that`)
        return
      }
    }

    /**
     * Prospect entry stage guard — the board's write path (§10, "Dragging to
     * Dismissed opens the reason picker").
     *
     * `stage` is the one group-by field on this entity whose columns are NOT
     * interchangeable, because two of the four are not a field write at all:
     *
     *   dismissed  → needs a REASON, and two of the reasons suppress the
     *                candidate in EVERY list (decision 3). A drag that wrote
     *                `stage='dismissed'` with no reason would 400; one that
     *                picked a reason for the user would let a mouse gesture
     *                do something the row's own × makes them choose. So the
     *                drop DEFERS to the same DismissReasonDialog the row and
     *                the selection bar use, and — because nothing has moved
     *                yet — cancelling leaves the card exactly where it was
     *                with no rollback to get wrong.
     *   saved      → asserts a CRM record EXISTS. Only /entries/save can make
     *                that true (it creates the company/contact and returns
     *                per-entry outcomes: created, already-saved, no-domain).
     *                The generic PATCH refuses the value outright, so the drag
     *                is routed through the save flow instead.
     *   discovered → refused. It is where candidates START; there is no
     *                un-dismiss and no un-save on this board, and a drag back
     *                would either silently fail or, worse, look like it
     *                reversed a CRM write it cannot reverse.
     *   shortlisted→ a plain PATCH — but only FROM a column where leaving
     *                writes nothing else. Dragging OUT of `dismissed` is the
     *                same asymmetry in reverse: `updateEntryStage` nulls the
     *                whole dismissal triple on any non-dismissed stage, so a
     *                card carrying `competitor` or `already_customer` dragged
     *                to Shortlisted silently revokes a WORKSPACE-WIDE
     *                suppression — `buildExclusionSet` keys `dismissed_global`
     *                on exactly `stage === 'dismissed' && dismissed_reason`,
     *                so the candidate becomes eligible again in every list,
     *                including lists that do not exist yet. Refused for the
     *                same reason entering dismissal defers: one mouse gesture
     *                may not undo a decision the row's own control made the
     *                user choose.
     *
     * Both deferrals go through `emitProspectEntryAction`, the SAME bridge the
     * hover row and the selection bar already use, so all three gestures land
     * on one handler in the prospecting page rather than on three code paths
     * that could drift apart on the surface whose whole job is not doing
     * something surprising with the user's CRM.
     */
    if (effectiveEntityType === 'prospect_list_entry' && groupField === 'stage') {
      // Leaving a WORKSPACE-WIDE dismissal is refused before any branch that
      // could write the stage. `fromGroup` is the cheap test; the reason comes
      // off the row itself, so only the two global reasons are blocked and an
      // ordinary `not_icp` dismissal stays draggable back to Shortlisted.
      if (fromGroup === 'dismissed' && toGroup !== 'dismissed') {
        const dragged = new Set(itemIds)
        const revokesGlobal = flatVisibleData.some(it => {
          const row = it as { id?: string; dismissed_reason?: string | null }
          if (!row.id || !dragged.has(row.id)) return false
          return (PROSPECT_GLOBAL_DISMISS_REASONS as readonly string[])
            .includes(row.dismissed_reason ?? '')
        })
        if (revokesGlobal) {
          toast.error(
            'This dismissal hides the company across every list — undo it from the row',
          )
          return
        }
      }
      if (toGroup === 'dismissed') {
        emitProspectEntryAction('dismiss', itemIds, {}, prospectActionTarget)
        return
      }
      if (toGroup === 'saved') {
        emitProspectEntryAction('save', itemIds, {}, prospectActionTarget)
        return
      }
      if (toGroup === 'discovered') {
        toast.error('Use Dismiss or Save; discovery is where candidates start')
        return
      }
    }

    /**
     * Eval suite board guard. The default group-by is `last_outcome`, and it
     * is DISPLAY-ONLY: `last_outcome`, `last_run_mode` and `case_count` are
     * denormalized columns owned by migration 255's triggers on eval_case and
     * eval_run. A drag would PATCH a value the next child-table write silently
     * reverts — and the suites PATCH route does not accept any of them, so it
     * would 400, roll back and toast something generic.
     *
     * `target_kind` is refused too, for a different reason: it is a real
     * column but the PATCH schema deliberately omits it, because it is what
     * the suite grades — repointing it would invalidate every run already
     * recorded against the suite.
     *
     * `suite_kind` (capability ↔ regression) is the ONE column here a drag may
     * write: it is an authoring choice with no derived state behind it, and
     * UpdateSuiteSchema accepts it. It falls through to the ordinary PATCH.
     */
    if (effectiveEntityType === 'eval_suite') {
      if (groupField === 'last_outcome') {
        toast.error('Outcome comes from the last run — run the suite to change it')
        return
      }
      if (groupField === 'last_run_mode' || groupField === 'case_count') {
        toast.error('This column is filled in by the suite\'s runs, not by hand')
        return
      }
      if (groupField === 'target_kind') {
        toast.error('A suite grades one agent or skill — change it on the suite itself')
        return
      }
    }

    /**
     * Eval CASES. `polarity` is the one field a drag may write — it is a plain
     * authoring choice with no derived state behind it, and UpdateCaseSchema
     * accepts it — so it falls through to the ordinary PATCH.
     *
     * Everything else is refused HERE rather than left to 400 on the way back:
     * `last_outcome` and `last_run_at` are owned by migration 257's triggers on
     * eval_trial (a write would be reverted by the next trial), and
     * `visibility` and `modes` are not in UpdateCaseSchema at all — `modes`
     * additionally because it is a text[] and a board drag carries exactly one
     * value, so a drop would silently narrow a batch+live case to one mode.
     */
    if (effectiveEntityType === 'eval_case') {
      if (groupField === 'last_outcome' || groupField === 'last_run_at') {
        toast.error('Outcome comes from the last run — run the suite to change it')
        return
      }
      if (groupField === 'modes') {
        toast.error('A case can run in both modes — set them on the case itself')
        return
      }
      if (groupField === 'visibility') {
        toast.error('Visibility follows the capture the case was seeded from')
        return
      }
    }

    /**
     * Eval RUNS are IMMUTABLE RECORDS. A run is what one prompt scored at one
     * moment; nothing about it is a field a person sets afterwards, and
     * ENTITY_ENDPOINTS.eval_run returns null so there is no PATCH endpoint to
     * send a drop to in the first place. Every column is refused, whichever
     * field the board happens to be grouped by.
     */
    if (effectiveEntityType === 'eval_run') {
      toast.error('A run records what happened — it cannot be edited')
      return
    }

    // A prospect LIST's purpose is not a column to drag between: it seeds the
    // ICP draft and picks the angle templates the next run searches with, and
    // changing it here would do that silently — without bumping icp_version,
    // so nothing on the page would show the drift. The row cell is read-only
    // for the same reason; the ICP editor on the list page is the one place
    // that change belongs.
    if (effectiveEntityType === 'prospect_list' && groupField === 'purpose') {
      toast.error("A list's purpose shapes its ICP — change it from the list's ICP editor")
      return
    }

    // Sequence lifecycle guard. The status columns are ordinary drop targets,
    // but most status pairs are NOT legal `{ status }` PATCHes (draft→active
    // only via Review & Launch, archived is terminal, only active can pause) —
    // without this check the drop optimistically lands, 400s, rolls back and
    // used to toast a generic failure. Reject up front with the real reason.
    if (effectiveEntityType === 'sequence' && groupField === 'status') {
      const allowed = SEQUENCE_ALLOWED_TRANSITIONS[fromGroup as SequenceStatus]
      if (allowed && !allowed.includes(toGroup as SequenceStatus)) {
        const message = sequenceMoveBlockedMessage(fromGroup, toGroup)
        // For the common draft→active mistake, offer the real path.
        const singleId = itemIds.length === 1 ? itemIds[0] : null
        const row = singleId
          ? flatVisibleData.find(it => (it as { id?: string }).id === singleId)
          : undefined
        if (fromGroup === 'draft' && toGroup === 'active' && singleId) {
          toast.error(message, {
            action: {
              label: 'Open',
              onClick: () =>
                handleItemSelect(singleId, (row?.name as string | undefined) ?? '', undefined, row),
            },
          })
        } else {
          toast.error(message)
        }
        return
      }
      // Legal but destructive: archiving exits every active enrollment and
      // cannot be undone. Route the drag through the same confirmation the
      // bulk archive action uses instead of committing on mouse-up.
      if (toGroup === 'archived') {
        setPendingArchiveDrag({ itemIds, fromGroup })
        return
      }
    }

    void performMoveItem(itemIds, fromGroup, toGroup)
  }, [config.grouping, lockedScopeFields, effectiveEntityType, flatVisibleData, handleItemSelect, performMoveItem, isForeignRow, prospectActionTarget])

  // ── Column reorder (board view, status grouping) ─────────
  const handleReorderColumns = React.useCallback(async (fromKey: string, toKey: string) => {
    if (!config.grouping || config.grouping.field !== 'status_id') return

    const groups = data as GroupedResults[]
    const ordered = [...groups]
    const fromIdx = ordered.findIndex(g => g.key === fromKey)
    const toIdx = ordered.findIndex(g => g.key === toKey)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

    // Compute the new column order
    const moved = groups[fromIdx]
    ordered.splice(fromIdx, 1)
    ordered.splice(toIdx, 0, moved)

    // Each board column (keyed by `category::name`) merges the matching
    // workflow_state row from every team. The server exposes all of them via
    // metadata.status_ids — we must persist the new sort_order to ALL of them,
    // otherwise un-updated teams' stale sort_order wins the re-sort on reload
    // and the column snaps back to its original position.
    const updates = ordered.flatMap((group, i) => {
      const ids = (group.metadata?.status_ids as string[] | undefined)
        // Fallback for older payloads that only had a single id / sample item.
        || (group.metadata?.status_id ? [group.metadata.status_id as string] : [])
        || []
      const resolved = ids.length
        ? ids
        : [(group.items?.[0]?.workflow_state as { id?: string } | undefined)?.id].filter(Boolean) as string[]
      // Index `i` stays contiguous across columns even if a column resolves to
      // no state IDs — no gaps in the resulting sort_order sequence.
      return resolved.map(id => ({ id, sort_order: i }))
    })

    if (updates.length === 0) {
      refetch()
      return
    }

    // Single bulk request — the board already shows the new order optimistically
    // via local state in ViewBoard.
    const res = await fetch('/api/account/workflow-states/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    }).catch(() => null)
    // The refetch below reconciles the columns with the saved order.
    if (!res?.ok) toast.error('Failed to reorder columns')
    refetch()
  }, [config.grouping, data, refetch])

  // ── Inline row editing ───────────────────────────────────
  // (entityTypeRef is already defined above for the entity-created event
  // handler; we reuse it here to avoid stale CRM-scope closures on patchItem.)

  // Snapshot prior values from current data for rollback on PATCH failure.
  // (dataRef is declared once above, near the entity-event listeners.)

  const patchItem = React.useCallback(async (id: string, fields: Record<string, unknown>) => {
    // Snapshot the pre-patch values so we can revert locally on failure.
    const flatData = Array.isArray(dataRef.current) && dataRef.current.length > 0
      && 'items' in (dataRef.current[0] as Record<string, unknown>)
      ? (dataRef.current as GroupedResults[]).flatMap(g => g.items)
      : (dataRef.current as Record<string, unknown>[])
    const prior = flatData.find(it => (it as { id?: string }).id === id) as Record<string, unknown> | undefined
    const snapshot: Record<string, unknown> = {}
    if (prior) {
      for (const key of Object.keys(fields)) snapshot[key] = prior[key] ?? null
    }

    // Optimistic update
    updateItem(id, fields)

    const endpoint = ENTITY_ENDPOINTS[entityTypeRef.current](id)
    if (!endpoint) {
      toast.error(`Inline edit not supported for ${entityTypeRef.current}`)
      if (prior) updateItem(id, snapshot)
      return
    }

    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        // Name the ROW's workspace when it isn't the active one — otherwise the
        // route resolves this id in the active workspace, 404s, and the inline
        // edit rolls back with a bare "HTTP 404". Adds nothing for a row in the
        // active workspace (see rowWorkspaceHeaders), which is every row
        // outside the cross-workspace scope.
        headers: {
          'Content-Type': 'application/json',
          ...rowWorkspaceHeaders(prior, workspaceIdRef.current ?? null),
        },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Notify other surfaces (detail panel, sibling lists) so they refresh
      // without a server round-trip.
      emitEntityUpdated({ entityType: entityTypeRef.current as Parameters<typeof emitEntityUpdated>[0]['entityType'], id, fields })
      // Celebrate if this edit just moved the item into a completed state.
      if (patchCompletesItem({
        entityType: entityTypeRef.current,
        fields,
        prior,
        workflowStatesByTeam: workflowStatesByTeamRef.current,
      })) {
        celebrate()
      }
    } catch (err) {
      // Rollback: re-apply snapshot locally, surface error
      if (prior) updateItem(id, snapshot)
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    }
  }, [updateItem])

  // ── Picker context ───────────────────────────────────────
  // (`workspaceId` is read at the top of the component — see there.)

  // Collect team_ids present in the data so workflow states load per team.
  const teamIds = React.useMemo(() => {
    const flatData = Array.isArray(data) && data.length > 0 && 'items' in (data[0] as Record<string, unknown>)
      ? (data as GroupedResults[]).flatMap(g => g.items)
      : (data as Record<string, unknown>[])
    const set = new Set<string>()
    for (const it of flatData) {
      const tid = (it as { team_id?: string }).team_id
      if (tid) set.add(tid)
    }
    // Fall back to the explicit teamId prop if no rows had one (empty views).
    if (teamId && set.size === 0) set.add(teamId)
    return Array.from(set)
  }, [data, teamId])

  const currentMemberId = useCurrentMemberId()
  const rawPickerContext = usePickerContext(effectiveEntityType, teamIds, workspaceId ?? null)
  const pickerContext = React.useMemo(
    () => ({ ...rawPickerContext, currentMemberId }),
    [rawPickerContext, currentMemberId],
  )
  workflowStatesByTeamRef.current = pickerContext.workflowStatesByTeam

  // ── Flow status indicators ───────────────────────────────
  // Map of workflow_state id → enabled flows that fire on entry. Only entity
  // types that group by a workflow_state status can show ⚡ on a column/group;
  // for the rest the map stays empty (and the fetch is skipped). The flows
  // themselves are workspace-wide, so we fetch once and let board/list match
  // their own status ids against it.
  const STATUS_ENTITY_TYPES: ViewEntityType[] = ['action', 'project']
  const flowStatusIds = useFlowStatusIds(
    STATUS_ENTITY_TYPES.includes(effectiveEntityType) ? (workspaceId ?? null) : null,
  )

  /**
   * Which cells a row will let the user edit in place. Everything, as ever,
   * except on a row from another workspace: there the pickers would be offering
   * THIS workspace's statuses, members, projects and labels for a row that
   * cannot hold them (see isCrossWorkspaceEditable). Priority and dates stay
   * live, because a value means the same thing in every workspace.
   */
  const canEditCell = React.useCallback(
    (item: Record<string, unknown>, property: string) =>
      !isForeignRow(item) || isCrossWorkspaceEditable(entityTypeRef.current, property),
    [isForeignRow],
  )

  // ── Tree support ──────────────────────────────────────────
  // When the list is not grouped, action rows with sub-actions expose a
  // chevron that lazy-loads children; prospect COMPANY rows carry their people
  // inline (`item.children`, attached by the views query route) and start
  // expanded — see view-list's `isTreeRowOpen`. Nothing is fetched for them.
  const treeEnabled =
    (effectiveEntityType === 'action' || effectiveEntityType === 'prospect_list_entry') &&
    !config.grouping
  const getChildren = React.useCallback(async (parentId: string) => {
    if (effectiveEntityType !== 'action') return []
    // The children live wherever their parent does. Unheadered, this LISTS the
    // active workspace's actions with that parent_id — which for a foreign row
    // is none, so its chevron would expand onto nothing.
    const parent = flatVisibleDataRef.current.find(it => (it as { id?: string }).id === parentId)
    const res = await fetch(`/api/account/actions?parent_id=${parentId}&scope=all&status=all`, {
      headers: rowWorkspaceHeaders(parent, workspaceIdRef.current ?? null),
    })
    if (!res.ok) return []
    const d = await res.json()
    return (d.actions || []) as Record<string, unknown>[]
  }, [effectiveEntityType])

  const search = isSearchable && !isControlledSearch ? (
    <ExpandableSearch
      value={searchInput}
      onChange={handleSearchChange}
      label={`Search ${ENTITY_PLURAL[effectiveEntityType]}`}
      placeholder={`Search ${ENTITY_PLURAL[effectiveEntityType]}…`}
    />
  ) : null

  return (
    <div className="relative isolate h-full flex flex-col" inert={obscured || undefined} aria-hidden={obscured || undefined}>
      {/* The card's own list searches from the card's header, where a window
          held its search. A record open over the list owns the header while
          it is there. */}
      {cardOwnList && search && !obscured && <CardHeaderSlot side="right">{search}</CardHeaderSlot>}
      {/* Toolbar (view tabs, settings, layout toggle) */}
      <ViewToolbar
        embedded={isScopedInstance || !!card}
        hideTabs={!!card && !card.keepTabs && !cardOwnList}
        compact={card?.compact}
        entityType={entityType}
        teamId={teamId}
        views={views}
        activeViewId={activeViewId}
        onViewChange={handleViewSelected}
        onCreateView={createView}
        onUpdateView={updateView}
        onDuplicateView={duplicateView}
        onDeleteView={deleteView}
        config={config}
        onConfigChange={updateConfig}
        onScopeReset={resetConfig}
        crmScopesEnabled={!isScopedInstance}
        captureScopesEnabled={!isScopedInstance}
        lockedScopeFields={lockedScopeFields}
        prospectStage={prospectStage}
        prospectStageCounts={prospectStageCounts}
        onProspectStageChange={onProspectStageChange}
        actions={<>
          {!cardOwnList && search}
          {toolbarActions}
        </>}
        isDirty={isDirty}
        overrides={overrides}
        onSaveDraft={saveOverrides}
        onDiscardDraft={discardOverrides}
        graphAvailable={Boolean(renderGraph)}
      />

      {/* ── Selection islands ──
          Float over the bottom of the list, centred on this layout's own
          width (Linear-style), instead of wedging a strip between the toolbar
          and the rows. The primary island (count · Select all · Actions) sits
          at the bottom; a page's own verbs, when it has any, float in a second
          island of the same make directly above it. The root is `relative
          isolate` so the stack stays inside the layout's stacking context: a
          detail overlay drawn over the layout (tab-content, z-10) still covers
          it, and `obscured` makes it inert with everything else. view-list's
          bottom padding keeps the last row reachable underneath. ── */}
      {bulkSelection.hasSelection && (
        <div
          data-selection-island
          className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3"
        >
          <div className="pointer-events-auto flex max-w-full flex-col items-center gap-2 animate-island-in">
            {selectionActions && (
              <div
                role="toolbar"
                aria-label="Selection actions"
                data-selection-island-secondary
                className={SELECTION_ISLAND_CLASS}
              >
                {selectionActions}
              </div>
            )}
            <BulkActionBar
              entityType={effectiveEntityType}
              selectedCount={bulkSelection.count}
              onClear={bulkSelection.clear}
              onAction={handleBulkAction}
              allVisibleIds={allVisibleIds}
              onSelectAll={bulkSelection.selectAll}
              // Company delete has its own richer confirmation (the cascade
              // dialog with the dry-run people count) — the bar's generic
              // "N item(s)" confirm must not stack in front of it.
              skipConfirmActionIds={
                effectiveEntityType === 'company' || effectiveEntityType === 'prospect_list'
                  ? ['delete']
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {/* Bulk move to another workspace — opened by handleBulkAction, kept
          outside the selection-gated block so it survives the selection being
          cleared on success. */}
      {moveDialogIds.length > 0 && (
        <MoveWorkspaceDialog
          entityType="action"
          entityIds={moveDialogIds}
          open
          onOpenChange={(next) => { if (!next) setMoveDialogIds([]) }}
          onMoved={onBulkComplete}
        />
      )}

      {/* Add selected contacts to a sequence — like the move dialog, kept
          outside the selection-gated block so it survives selection clears. */}
      {sequenceDialogIds.length > 0 && (
        <AddToSequenceDialog
          contactIds={sequenceDialogIds}
          open
          onOpenChange={(next) => { if (!next) setSequenceDialogIds([]) }}
          onEnrolled={() => bulkSelection.clear()}
        />
      )}

      {/* Company cascade delete — like the move dialog, kept outside the
          selection-gated block so it survives the selection being cleared. */}
      {companyDeleteIds.length > 0 && (
        <CompanyDeleteDialog
          companyIds={companyDeleteIds}
          open
          onOpenChange={(next) => { if (!next) setCompanyDeleteIds([]) }}
          onDeleted={() => onBulkComplete()}
        />
      )}

      {/* Prospect list delete — same placement, same reason. A single
          selection is named in the title from the row on screen; a batch
          is counted. */}
      {listDeleteIds.length > 0 && (
        <ProspectListDeleteDialog
          listIds={listDeleteIds}
          listName={
            listDeleteIds.length === 1
              ? allVisibleItems.find((it) => it.id === listDeleteIds[0])?.title || undefined
              : undefined
          }
          open
          onOpenChange={(next) => { if (!next) setListDeleteIds([]) }}
          onDeleted={() => onBulkComplete()}
        />
      )}

      {/* Confirmation for dragging sequence card(s) onto the Archived column —
          same gate as the destructive bulk archive: archiving exits every
          active enrollment and is irreversible, so one mouse gesture must not
          commit it silently. handleMoveItem stashes the drag here; confirming
          runs the deferred move. */}
      <AlertDialog
        open={!!pendingArchiveDrag}
        onOpenChange={(open) => { if (!open) setPendingArchiveDrag(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive {pendingArchiveDrag?.itemIds.length === 1
                ? 'this sequence'
                : `${pendingArchiveDrag?.itemIds.length ?? 0} sequences`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archiving stops all sending and exits every active enrollment.
              Archived sequences cannot be reactivated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingArchiveDrag) {
                  void performMoveItem(pendingArchiveDrag.itemIds, pendingArchiveDrag.fromGroup, 'archived')
                }
                setPendingArchiveDrag(null)
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Content: graph, list or board.
          The graph gets `relative` + an absolutely-positioned child of its own
          (see the page's renderGraph) because the chrome ABOVE it changes
          height as the user works — the dirty-state ribbon appears the moment a
          filter diverges from the saved baseline and disappears on Cancel.
          Every such toggle resizes this box, and for a canvas a resize is a
          viewport change that re-requests tiles. `min-h-0` alone does not stop
          that: the flex child still shrinks. The graph body must therefore size
          itself from this box's final rect, not participate in its flow. */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {isGraph ? (
          renderGraph?.({ filters: graphFilters, search: activeSearch ?? '' })
        ) : effectiveLayout === 'list' ? (
          <ViewList
            entityType={effectiveEntityType}
            data={data}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            config={config}
            selectedItemId={selectedItemId}
            onItemSelect={handleItemSelect}
            selectionActive={bulkSelection.hasSelection}
            checkedIds={bulkSelection.selectedIds}
            onToggleCheck={bulkSelection.toggle}
            onPatch={patchItem}
            pickerContext={pickerContext}
            canEdit={canEditCell}
            flowStatusIds={flowStatusIds}
            treeEnabled={treeEnabled}
            getChildren={getChildren}
          />
        ) : (
          <ViewBoard
            entityType={effectiveEntityType}
            data={data}
            loading={loading}
            config={config}
            selectedItemId={selectedItemId}
            onItemSelect={handleItemSelect}
            onMoveItem={handleMoveItem}
            onReorderColumns={
              // Column drag-reorder only on a single-team board: there each
              // column is one team's workflow_state and a new sort_order can be
              // persisted. The cross-team board orders columns by fixed category
              // order, so reordering can't be saved and is disabled.
              teamId && config.grouping?.field === 'status_id' ? handleReorderColumns : undefined
            }
            selectionActive={bulkSelection.hasSelection}
            checkedIds={bulkSelection.selectedIds}
            onToggleCheck={bulkSelection.toggle}
            flowStatusIds={flowStatusIds}
          />
        )}
      </div>
    </div>
  )
}
