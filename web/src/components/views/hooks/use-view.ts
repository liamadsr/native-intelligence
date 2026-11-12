'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import type {
  View,
  ViewEntityType,
  ViewFilter,
  ViewScope,
  ViewLayout,
  SortConfig,
  GroupConfig,
  CreateViewBody,
  GroupedResults,
  CrmScope,
  WorkspaceScope,
  LibraryScope,
} from '@/lib/views/types'
import { acquireCrossWorkspaceTable } from '@/hooks/use-realtime-entities'
import { defaultDisplayProperties, DEFAULT_BOARD_GROUP_BY, defaultLayout, defaultOrdering } from '@/lib/views/types'
import { VIEWS_CHANGED_EVENT } from '@/lib/views/views-changed'
import { readTableSettings, withTableSettings, type TableViewSettings } from '@/lib/tables/views'

// ============================================================
// useView — manages the list of saved views + active view config
// ============================================================

// Persisted-selection key — survives re-mount when navigating into a detail
// panel and back. Scoped by workspace + entity type + team + parent scope:
//   - workspace so views from Workspace A don't restore in Workspace B (every
//     workspace has its own set of saved views with distinct UUIDs, and a
//     leaked id would either resolve nothing or — worse — silently pick up a
//     same-id view from the wrong workspace if collisions ever happened);
//   - team / scope so a Project's Actions tab and the global Actions list
//     don't trample each other within a single workspace.
function activeViewStorageKey(
  workspaceId: string | null,
  entityType: ViewEntityType,
  teamId?: string,
  viewScope?: ViewScope,
): string {
  const scope = viewScope ? `${viewScope.type}:${viewScope.id}` : 'global'
  const ws = workspaceId ?? 'unknown'
  return `ni:active-view:${ws}:${entityType}:${teamId ?? 'noteam'}:${scope}`
}

function readActiveViewId(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

function writeActiveViewId(key: string, viewId: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (viewId) window.localStorage.setItem(key, viewId)
    else window.localStorage.removeItem(key)
  } catch { /* quota/private mode — accept loss of persistence */ }
}

// ── Saved-view resolution gate (perf audit 13.3) ────────────────────────────
// A persisted activeViewId means the user left this list on a saved view. On
// mount the views list hasn't loaded yet, so the caller's config is still the
// DEFAULT config — running the query engine with it double-executed every
// saved-view mount server-side (default query first, the real one after the
// view resolved). useView marks its persisted id as "resolving" until the
// FIRST views fetch settles (success OR failure — a failed fetch must not
// hold forever; the phantom-id sweep separately handles ids that no longer
// exist); useViewResults holds its initial fetch while its activeViewId is
// marked. Module-level because the two hooks are composed by the caller and
// only share the id value; per-instance tokens so two mounted lists on the
// same saved view can't release each other early.
//
// Ordering contract: useView is called BEFORE useViewResults in the composing
// component (unified-view-layout), so marking inside useView's useState
// initializer is synchronously visible to useViewResults' first snapshot read
// in the same render pass. Listeners are notified on RELEASE only — marking
// happens during render (where a notification could trigger the
// setState-during-render warning) and a missed mark only means one
// conservative extra fetch, while a missed release would strand the hold.
const pendingViewResolutions = new Map<string, Set<object>>()
const pendingViewListeners = new Set<() => void>()

function markViewResolving(viewId: string, token: object) {
  let tokens = pendingViewResolutions.get(viewId)
  if (!tokens) {
    tokens = new Set()
    pendingViewResolutions.set(viewId, tokens)
  }
  tokens.add(token)
}

function unmarkViewResolving(viewId: string, token: object) {
  const tokens = pendingViewResolutions.get(viewId)
  if (!tokens?.delete(token)) return
  if (tokens.size === 0) pendingViewResolutions.delete(viewId)
  for (const listener of pendingViewListeners) listener()
}

/** Is some mounted useView instance still resolving this saved-view id? */
export function isViewResolutionPending(viewId: string | null): boolean {
  return viewId != null && pendingViewResolutions.has(viewId)
}

function subscribePendingViewResolutions(listener: () => void): () => void {
  pendingViewListeners.add(listener)
  return () => {
    pendingViewListeners.delete(listener)
  }
}

// ── Request sharing across mounted lists (perf plan 1.4) ────────────────────
// Every window of every tab stays mounted, and several often show the same
// list, each with its own useView/useViewResults. Same idiom as cachedJson's
// `inflight` map: a caller allowed to join (`join: true`) that asks for a key
// already in flight gets that request's promise, so every waiting list sees
// the same parsed result or the same rejection. Invalidation (see
// inflightViewQueries, mutateViews) only drops entries: a request that may
// predate a change stops being handed out; lists already waiting still get it.
//
// Each caller holds a lease. `release(true)` (the caller's next page-1 fetch
// supersedes this one) aborts only if nobody else is still waiting — the old
// per-instance abort, minus aborting under another window. `release(false)`
// (unmount) lets the request finish, as before, but makes it unjoinable.
interface SharedRequest<T> {
  promise: Promise<T>
  controller: AbortController
  holders: number
}

interface RequestLease<T> {
  promise: Promise<T>
  release: (abort: boolean) => void
}

function leaseRequest<T>(
  inflight: Map<string, SharedRequest<T>>,
  key: string,
  join: boolean,
  start: (signal: AbortSignal) => Promise<T>,
): RequestLease<T> {
  let entry = join ? inflight.get(key) : undefined
  if (!entry) {
    const created = { controller: new AbortController(), holders: 0 } as SharedRequest<T>
    created.promise = start(created.controller.signal).finally(() => {
      if (inflight.get(key) === created) inflight.delete(key)
    })
    inflight.set(key, created)
    entry = created
  }
  const shared = entry
  shared.holders += 1
  let released = false
  return {
    promise: shared.promise,
    release: (abort) => {
      if (released) return
      released = true
      shared.holders -= 1
      if (shared.holders > 0) return
      if (inflight.get(key) === shared) inflight.delete(key)
      if (abort) shared.controller.abort()
    },
  }
}

// Saved-views list GETs, keyed by workspace + URL.
const inflightViewLists = new Map<string, SharedRequest<View[] | null>>()

/** Resolves the list on success, null on HTTP/network/parse failure — the
 *  same outcomes fetchViews has always distinguished. */
function fetchViewList(url: string): Promise<View[] | null> {
  return fetch(url)
    .then(async (res) => (res.ok ? (((await res.json()).views || []) as View[]) : null))
    .catch(() => null)
}

/** A saved-view write. Once it lands, no views-list request sent before it may
 *  be joined (it could be missing the write). */
function mutateViews(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init).finally(() => inflightViewLists.clear())
}

export function useView(
  entityType: ViewEntityType,
  teamId?: string,
  viewScope?: ViewScope,
  /**
   * `standalone`: a card in the chat (pages in the chat) is its own view: it
   * restores no selection and writes none, so picking a saved view in a card
   * never moves the real page's. Saving it as a view (createView) still works.
   *
   * `listViews` (default true): load the saved views at all. The mail card
   * shows none, so it skips the request.
   */
  opts?: { standalone?: boolean; listViews?: boolean },
) {
  const standalone = opts?.standalone ?? false
  const listViews = opts?.listViews ?? true
  const workspaceId = useWorkspaceId()
  const [views, setViews] = useState<View[]>([])
  const storageKey = standalone ? null : activeViewStorageKey(workspaceId, entityType, teamId, viewScope)
  // Per-instance identity for the resolution gate (see the block above). A
  // plain object so two lists on the same saved view hold independent marks.
  const resolutionTokenRef = useRef<object>({})
  // Which id (if any) this instance currently holds a mark on. Held in a ref so
  // the settle effect releases exactly what it marked, even if activeViewId
  // changed underneath it.
  const markedViewIdRef = useRef<string | null>(null)
  // Seed from localStorage so back-nav restores the previously selected view.
  // The view itself carries layout/filters/grouping — restoring its ID restores everything.
  const [activeViewId, setActiveViewIdState] = useState<string | null>(() => {
    const persisted = storageKey ? readActiveViewId(storageKey) : null
    // Mark DURING the state initializer so the mark is already visible when
    // useViewResults reads the store later in the same render pass.
    if (persisted) {
      markViewResolving(persisted, resolutionTokenRef.current)
      markedViewIdRef.current = persisted
    }
    return persisted
  })
  const setActiveViewId = useCallback((id: string | null | ((prev: string | null) => string | null)) => {
    setActiveViewIdState((prev) => {
      const next = typeof id === 'function' ? id(prev) : id
      if (storageKey) writeActiveViewId(storageKey, next)
      return next
    })
  }, [storageKey])
  // When storageKey changes (workspace switch, team switch, scope switch),
  // re-seed activeViewId from the new key's localStorage entry. Without this,
  // React state would still hold the previous key's value until the next
  // manual setActiveViewId, leaking selection across workspaces.
  const prevStorageKeyRef = useRef(storageKey)
  useEffect(() => {
    if (prevStorageKeyRef.current === storageKey) return
    prevStorageKeyRef.current = storageKey
    setActiveViewIdState(storageKey ? readActiveViewId(storageKey) : null)
  }, [storageKey])
  const [loading, setLoading] = useState(listViews)
  // Did the LAST fetch actually come back with a list? A failed fetch (offline,
  // 500, aborted deploy) leaves `views` empty, which is indistinguishable from
  // "this workspace has no saved views" — and the phantom-view sweep below would
  // read that as "your selection is gone" and permanently erase the persisted
  // id. Only a fetch we know succeeded is allowed to conclude a view is missing.
  const [loadedOk, setLoadedOk] = useState(false)
  // Views-list lease (see leaseRequest). The workspace only scopes the sharing
  // key, so it is read through a ref and fetchViews keeps its old deps.
  const viewsLeaseRef = useRef<RequestLease<View[] | null> | null>(null)
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId

  // Only the newest views-list fetch writes state: a slower answer for the
  // previous entity type / team / scope must not land under the new one.
  const viewsFetchGenRef = useRef(0)

  // Only the mount/deps-change fetch below shares; refetchViews() never does.
  const fetchViews = useCallback(async (share?: boolean) => {
    const gen = ++viewsFetchGenRef.current
    setLoading(true)
    const qs = new URLSearchParams({ entity_type: entityType })
    if (teamId) qs.set('team_id', teamId)
    if (viewScope) {
      qs.set('scope_type', viewScope.type)
      qs.set('scope_id', viewScope.id)
    }
    const url = `/api/account/views?${qs}`
    viewsLeaseRef.current?.release(false)
    const lease = leaseRequest(
      inflightViewLists,
      `${workspaceIdRef.current ?? ''}|${url}`,
      share === true,
      () => fetchViewList(url),
    )
    viewsLeaseRef.current = lease
    const list = await lease.promise
    if (gen !== viewsFetchGenRef.current) return
    if (list) setViews(list)
    setLoadedOk(list !== null)
    setLoading(false)
    // Release the resolution gate the moment the fetch SETTLES — success or
    // failure. A failed fetch leaves the caller on the default config, which
    // is exactly what it should then query; holding forever would leave the
    // list permanently empty with no request in flight.
    const marked = markedViewIdRef.current
    if (marked) {
      markedViewIdRef.current = null
      unmarkViewResolving(marked, resolutionTokenRef.current)
    }
  }, [entityType, teamId, viewScope])

  useEffect(() => {
    if (listViews) fetchViews(true)
  }, [fetchViews, listViews])

  useEffect(() => {
    if (!listViews) return
    // A list fetched before the change must not answer for after it.
    const reload = () => {
      inflightViewLists.clear()
      void fetchViews()
    }
    window.addEventListener(VIEWS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(VIEWS_CHANGED_EVENT, reload)
  }, [fetchViews, listViews])

  // Unmounting mid-fetch must not strand the mark — a later mount on the same
  // saved view would then hold its initial fetch forever. (Also drops this
  // instance's hold on a shared views-list request.)
  useEffect(() => {
    const token = resolutionTokenRef.current
    return () => {
      viewsLeaseRef.current?.release(false)
      const marked = markedViewIdRef.current
      if (marked) {
        markedViewIdRef.current = null
        unmarkViewResolving(marked, token)
      }
    }
  }, [])

  // If a persisted activeViewId no longer matches any view (deleted, or moved
  // workspace), drop it so the user isn't stuck on a phantom selection. Gated on
  // loadedOk: without that gate a transient network failure silently wipes the
  // user's saved-view selection with no way to get it back.
  useEffect(() => {
    if (loading || !loadedOk) return
    if (activeViewId && !views.some(v => v.id === activeViewId)) {
      setActiveViewId(null)
    }
  }, [loading, loadedOk, views, activeViewId, setActiveViewId])

  const createView = useCallback(async (data: CreateViewBody): Promise<View | null> => {
    try {
      // If this instance is scoped, persist scope metadata so the view only
      // appears under the same parent entity.
      const body = viewScope
        ? { ...data, scope_type: viewScope.type, scope_id: viewScope.id }
        : data
      const res = await mutateViews('/api/account/views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      const json = await res.json()
      setViews(prev => [json.view, ...prev])
      return json.view
    } catch { return null }
  }, [viewScope])

  const updateView = useCallback(async (viewId: string, updates: Partial<View>) => {
    // Optimistic update
    setViews(prev => prev.map(v => v.id === viewId ? { ...v, ...updates } : v))
    try {
      await mutateViews(`/api/account/views/${viewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    } catch { /* rollback could go here */ }
  }, [])

  const deleteView = useCallback(async (viewId: string) => {
    setViews(prev => prev.filter(v => v.id !== viewId))
    if (activeViewId === viewId) setActiveViewId(null)
    try {
      await mutateViews(`/api/account/views/${viewId}`, { method: 'DELETE' })
    } catch { /* ignore */ }
  }, [activeViewId, setActiveViewId])

  const duplicateView = useCallback(async (viewId: string): Promise<View | null> => {
    try {
      const res = await mutateViews(`/api/account/views/${viewId}/duplicate`, { method: 'POST' })
      if (!res.ok) return null
      const json = await res.json()
      setViews(prev => [json.view, ...prev])
      return json.view
    } catch { return null }
  }, [])

  // Active view config (or default config if no view selected)
  const activeView = views.find(v => v.id === activeViewId) || null

  return {
    views,
    activeViewId,
    activeView,
    setActiveViewId,
    loading,
    createView,
    updateView,
    deleteView,
    duplicateView,
    refetchViews: fetchViews,
  }
}

// ============================================================
// useViewConfig — local config state with debounced save
// ============================================================

export interface ViewConfig {
  filters: ViewFilter[]
  grouping: GroupConfig | null
  sub_grouping: GroupConfig | null
  ordering: SortConfig[]
  display_properties: string[]
  layout: ViewLayout
  board_group_by: string | null
  show_completed: boolean
  completed_filter: 'all' | 'recent' | 'none'
  show_sub_items: boolean
  nested_sub_items: boolean
  show_empty_groups: boolean
  /** Action-specific: 'all' = all issues, 'assigned' = assigned to me, 'created' = created by me */
  action_scope: 'assigned' | 'created' | 'all'
  /**
   * How many WORKSPACES the list spans (My Actions and Projects only — see
   * spansWorkspaces). 'workspace' (default) is the active one; 'all' is every
   * workspace the user is a member of, with the membership set resolved
   * SERVER-side (see WorkspaceScope). Not the list's own choice: it is the
   * workspace menu's "Show all workspaces" switch (lib/workspace-span), handed
   * in to useViewConfig, so it is never saved with a view or a draft.
   * Orthogonal to `action_scope`, which picks WHOSE actions within whatever
   * workspaces are in scope — the two combine ("assigned to me, everywhere").
   */
  workspace_scope: WorkspaceScope
  /** CRM-specific: which entity type to show */
  crm_scope: CrmScope
  /** Capture-specific: 'all' = everything visible, 'mine' = my captures, 'shared' = teammates' workspace-visible captures */
  capture_scope: 'all' | 'mine' | 'shared'
  /** Library baseline navigation, saved as an explicit Collection filter. */
  library_scope?: LibraryScope
  /** A table's view (data_row): widths, hidden columns and layout picks, kept in the view's `metadata.table`. */
  table?: TableViewSettings
}

/**
 * Build the canonical default config. action_scope / workspace_scope /
 * crm_scope / capture_scope are baseline navigation (not editable config), so
 * they're inputs here — not overridable fields. The scope tabs change the
 * baseline, not the draft.
 *
 * Exported so the ordering defaults can be pinned directly: nothing else in
 * the tree asserts them, and a tie-broken default is invisible until
 * pagination starts duplicating rows.
 */
export function defaultConfig(
  entityType: ViewEntityType,
  scoped: boolean = false,
  actionScope: 'assigned' | 'created' | 'all' = 'all',
  crmScope: CrmScope = 'contacts',
  captureScope: 'all' | 'mine' | 'shared' = 'all',
  workspaceScope: WorkspaceScope = 'workspace',
  scopeFields?: ReadonlySet<string>,
  libraryScope: LibraryScope = 'all',
): ViewConfig {
  const defaultFilters: ViewFilter[] = []
  if (entityType === 'agent' || entityType === 'skill') {
    defaultFilters.push({ id: '__library_scope', field: 'library_scope', operator: 'is', value: libraryScope })
  }
  // For top-level action lists, the "Assigned to me" / "Created by me" tabs add
  // a @me filter on the appropriate field — assignee for "Assigned to me",
  // creator for "Created by me". The "All issues" tab (default) adds no scope
  // filter so unassigned items (e.g. tickets created via the MCP/API without an
  // assignee) are visible. Inside a scoped container (e.g. Project → Actions),
  // show everything.
  //
  // ACROSS WORKSPACES the filter is deliberately NOT injected: `@me` resolves
  // to the ACTIVE workspace's member id only, and the query route drops
  // `action_scope` the moment it sees such a filter — so sending it would ask
  // for "assigned to my member row in workspace A" over a set of rows from
  // every workspace, i.e. an empty list everywhere but A. The same intent
  // travels as `action_scope` + `workspace_scope: 'all'` instead, which the
  // server resolves per workspace from the `member` table.
  if (entityType === 'action' && !scoped && actionScope !== 'all' && workspaceScope !== 'all') {
    defaultFilters.push({
      id: '__scope_assignee',
      field: actionScope === 'created' ? 'user_id' : 'assignee_id',
      operator: 'is',
      value: '@me',
    })
  }

  // Default captures view groups by day (started_at desc) for chronological browsing
  const defaultGrouping = entityType === 'capture'
    ? { field: 'started_at', direction: 'desc' as const }
    : null

  return {
    filters: defaultFilters,
    grouping: defaultGrouping,
    sub_grouping: null,
    ordering: defaultOrdering(entityType),
    // Scope-aware: scope-only properties (e.g. the sequence 'enrollment'
    // cell) join the defaults only when the instance locks their scope field.
    display_properties: defaultDisplayProperties(entityType, scopeFields),
    layout: defaultLayout(entityType),
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: true,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: actionScope,
    // Record-only (like crm_scope below): with 'all' the server resolves the
    // membership set from the query body's scope, so the only thing this field
    // does locally is SUPPRESS the @me filter above.
    workspace_scope: workspaceScope,
    crm_scope: crmScope,
    // Record-only (like crm_scope): the server applies the scope from the
    // query body, so no synthetic filter is injected here.
    capture_scope: captureScope,
    ...(entityType === 'agent' || entityType === 'skill' ? { library_scope: libraryScope } : {}),
  }
}

/**
 * Can this list span every workspace? The two lists the "Show all workspaces"
 * switch reaches: My Actions (an action list with no team pinned) and Projects
 * — never a team board (a team is one workspace's) and never a parent-scoped
 * embed (Project → Actions hangs off ONE workspace's project, so widening it
 * would only ever return the same rows). The server mirrors the entity list
 * (views/query route).
 */
export function spansWorkspaces(entityType: ViewEntityType, opts: { teamId?: string | null; scoped?: boolean }): boolean {
  return (entityType === 'action' || entityType === 'project') && !opts.teamId && !opts.scoped
}

/**
 * The My Actions tab filter (`__scope_assignee`, "Assigned to me" / "Created
 * by me" as `@me`) refitted to the workspace span. Across workspaces it goes:
 * `@me` resolves to the ACTIVE workspace's member id only, and the query route
 * drops `action_scope` the moment it sees such a filter (see defaultConfig).
 * Back in one workspace the tab's filter returns. The user's own filters are
 * kept as they are.
 */
export function fitScopeAssigneeFilter(
  filters: ViewFilter[],
  actionScope: 'assigned' | 'created' | 'all',
  workspaceScope: WorkspaceScope,
): ViewFilter[] {
  const rest = filters.filter((f) => f.id !== '__scope_assignee')
  if (actionScope === 'all' || workspaceScope === 'all') return rest
  return [
    { id: '__scope_assignee', field: actionScope === 'created' ? 'user_id' : 'assignee_id', operator: 'is', value: '@me' },
    ...rest,
  ]
}

// Storage key for a draft. A draft = unsaved overrides on top of a baseline.
// Baselines:
//   - Saved view → key is the view UUID (globally unique across workspaces)
//   - Implicit default → key is `default:<workspaceId>:<entityType>:<scoped>`
// Each saved view + each default-slot gets its own slot so per-view drafts
// coexist. Default slots are workspace-scoped: a "layout=board" draft on the
// Actions list in Workspace A must NOT bleed into Workspace B's Actions list.
function draftStorageKey(
  baselineId: string,
): string {
  return `ni:view-draft:${baselineId}`
}

function defaultBaselineId(
  workspaceId: string | null,
  entityType: ViewEntityType,
  scoped: boolean,
): string {
  // 'unknown' shouldn't appear in practice because the dashboard waits for
  // workspace to load before rendering view layouts, but if it ever does, it
  // gets its own slot rather than colliding with a real workspace.
  const ws = workspaceId ?? 'unknown'
  return `default:${ws}:${entityType}:${scoped ? 'scoped' : 'global'}`
}

// Identifies a baseline as referring to a saved view (UUID) vs. an implicit
// default slot. Default slots are bounded by workspace × entity-type × scope
// (a handful of values per workspace) so they never need garbage collection —
// only saved-view slots do.
function isDefaultBaselineId(baselineId: string): boolean {
  return baselineId.startsWith('default:')
}

// Envelope around stored overrides — adds a savedAt timestamp so we can
// reason about draft age in future cleanup heuristics. Reads transparently
// accept the legacy raw-overrides shape so existing drafts aren't lost on
// the first deploy.
interface DraftEnvelope {
  overrides: Partial<ViewConfig>
  savedAt: number
}

function readDraft(baselineId: string): Partial<ViewConfig> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(draftStorageKey(baselineId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Envelope form (new) — overrides nested under .overrides.
    if ('overrides' in parsed && parsed.overrides && typeof parsed.overrides === 'object') {
      return (parsed as DraftEnvelope).overrides
    }
    // Legacy form — the raw overrides object was the stored value.
    return parsed as Partial<ViewConfig>
  } catch { return {} }
}

/** Drafts kept in memory instead (useViewConfig's `drafts: 'memory'`), by baseline. */
type DraftMemory = Map<string, Partial<ViewConfig>>

function readDraftIn(memory: DraftMemory | null, baselineId: string): Partial<ViewConfig> {
  return memory ? memory.get(baselineId) ?? {} : readDraft(baselineId)
}

function writeDraftIn(memory: DraftMemory | null, baselineId: string, overrides: Partial<ViewConfig>) {
  if (!memory) return writeDraft(baselineId, overrides)
  if (Object.keys(overrides).length) memory.set(baselineId, overrides)
  else memory.delete(baselineId)
}

function writeDraft(baselineId: string, overrides: Partial<ViewConfig>) {
  if (typeof window === 'undefined') return
  try {
    const key = draftStorageKey(baselineId)
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(key)
    } else {
      const envelope: DraftEnvelope = { overrides, savedAt: Date.now() }
      window.localStorage.setItem(key, JSON.stringify(envelope))
    }
  } catch { /* quota / private mode — accept loss */ }
}

/**
 * Drop draft entries that haven't been touched in 7 days. The savedAt
 * timestamp is refreshed on every write, so any draft a user is actively
 * iterating on is safe — only truly idle drafts get reaped. A week
 * covers normal weekends and short PTO; longer-running drafts should be
 * saved as a view.
 *
 * Legacy (un-enveloped) drafts have no savedAt. We assume they're recent
 * on first contact: re-write them with a fresh timestamp instead of
 * deleting, so users upgrading don't lose in-flight work.
 *
 * Idempotent and cheap — iterates localStorage keys with our prefix only.
 * Default-baseline slots are left untouched (their set is bounded).
 */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function garbageCollectAbandonedDrafts(now: number = Date.now()) {
  if (typeof window === 'undefined') return
  try {
    const prefix = 'ni:view-draft:'
    const toRemove: string[] = []
    const toRestamp: Array<{ key: string; overrides: Partial<ViewConfig> }> = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(prefix)) continue
      const baselineId = key.slice(prefix.length)
      if (isDefaultBaselineId(baselineId)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { toRemove.push(key); continue }
      if (!parsed || typeof parsed !== 'object') { toRemove.push(key); continue }
      const env = parsed as Partial<DraftEnvelope>
      if (typeof env.savedAt !== 'number') {
        // Legacy entry — stamp it now rather than delete. The body of these
        // entries IS the overrides object (no envelope), so we forward it as-is.
        toRestamp.push({ key, overrides: parsed as Partial<ViewConfig> })
        continue
      }
      if (now - env.savedAt > DRAFT_TTL_MS) toRemove.push(key)
    }
    for (const k of toRemove) window.localStorage.removeItem(k)
    for (const { key, overrides } of toRestamp) {
      const envelope: DraftEnvelope = { overrides, savedAt: now }
      window.localStorage.setItem(key, JSON.stringify(envelope))
    }
  } catch { /* localStorage unavailable — skip */ }
}

// Stable JSON for equality — sort object keys so { a:1, b:2 } == { b:2, a:1 }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

// Drop override entries that equal the baseline. Without this, toggling a
// field back to its original value would leave a stale dirty marker.
function pruneOverrides(
  baseline: ViewConfig,
  overrides: Partial<ViewConfig>,
): Partial<ViewConfig> {
  const pruned: Partial<ViewConfig> = {}
  for (const key of Object.keys(overrides) as (keyof ViewConfig)[]) {
    const a = overrides[key]
    const b = baseline[key]
    if (stableStringify(a) !== stableStringify(b)) {
      // Cast through unknown — TS can't prove the key/value pairing matches.
      ;(pruned as Record<string, unknown>)[key] = a as any
    }
  }
  return pruned
}

// A card's baseline ids. Never draft slots: a card's changes go to the card.
const CARD_BASELINE_ID = 'card'
/** A card on a scope tab other than its page's own (its changes stay in memory, as on a saved view). */
const CARD_SCOPE_BASELINE_ID = 'card:scope'
const SCOPE_KEYS = ['action_scope', 'crm_scope', 'capture_scope', 'library_scope'] as const
function cardViewBaselineId(viewId: string): string {
  return `card:${viewId}`
}

/** Where a chat card's view config comes from (see useViewConfig's `card`). */
export interface CardConfigSource {
  /** The agent's page, over the entity's defaults. Pass a memoized object. */
  baseline: Partial<ViewConfig>
  /** The person's changes as the card last kept them. Read once, at mount. */
  overrides?: Partial<ViewConfig>
  onOverridesChange?: (overrides: Partial<ViewConfig>) => void
}

export function useViewConfig(
  activeView: View | null,
  entityType: ViewEntityType,
  /**
   * Persist `updates` to the server — called only from `saveOverrides()`
   * (explicit Update button). NOT called on every keystroke. Auto-save was
   * removed when drafts became the model: changes are local until the user
   * explicitly Saves.
   */
  onSave?: (viewId: string, updates: Partial<View>) => Promise<void> | void,
  /** When true, default config omits the @me assignee filter (used for scoped views). */
  scoped: boolean = false,
  /**
   * The scope-filter fields locked by the parent container (e.g. the contact
   * panel's Sequences embed locks `enrolled_contact_id`). Feeds the default
   * config so scope-only display properties are on by default exactly where
   * their data exists. Pass a memoized Set — it participates in the baseline
   * memo.
   */
  scopeFields?: ReadonlySet<string>,
  /**
   * How many workspaces the list spans: the app-wide switch, already resolved
   * against spansWorkspaces by the caller (unified-view-layout). 'workspace'
   * for every list the switch doesn't reach.
   */
  workspaceScope: WorkspaceScope = 'workspace',
  /**
   * A card in the chat (pages in the chat): its baseline is the agent's page
   * (`baseline`, over the entity's defaults) and its overrides, the person's
   * own changes, belong to the card. They start from `overrides` and every
   * change goes to `onOverridesChange` (the card keeps them per device, keyed
   * by its tool call) instead of the page's localStorage drafts, so a card
   * never touches the real page's saved filters or drafts.
   *
   * A saved view picked in the card (`activeView`) is its baseline while it
   * is picked, and picking one, or the agent's page again, starts the card's
   * changes over: they were made against the baseline it left. Changes made
   * on a saved view stay in memory, since the card keeps no selection and a
   * reload opens on the agent's page, where they would not belong.
   */
  card?: CardConfigSource,
  /**
   * `memory`: drafts live in this hook only (one per baseline, for the
   * visit), never in localStorage. A table's page keeps only its last-opened
   * view in the browser (useView), not its unsaved changes.
   */
  drafts: 'storage' | 'memory' = 'storage',
) {
  // The drafts' home when they stay in memory (see `drafts`), else null: localStorage.
  const memoryDraftsRef = useRef<DraftMemory | null>(drafts === 'memory' ? new Map() : null)
  // Scope tab selection — owned here so the baseline can include the scope's
  // implied filter (e.g. user_id=@me for "Created by me"). When the user
  // switches scope, this state updates and the baseline recomputes; any
  // pending draft gets discarded (see resetConfig). Not persisted: scope
  // navigation isn't a "precious" edit, just transient selection.
  const [actionScope, setActionScope] = useState<'assigned' | 'created' | 'all'>('all')
  const [crmScope, setCrmScope] = useState<CrmScope>('contacts')
  const [captureScope, setCaptureScope] = useState<'all' | 'mine' | 'shared'>('all')
  const [libraryScope, setLibraryScope] = useState<LibraryScope>('all')

  // Workspace context — feeds default-baseline keys so a Workspace-A draft
  // doesn't leak into Workspace B. Saved-view baselines use the view UUID
  // and are already globally unique, so they don't need this.
  const workspaceId = useWorkspaceId()

  // The baseline this draft sits on. View UUID for saved views, synthetic
  // slot key for the implicit default.
  // A card's scope tab (Mine, Shared with me…): the agent's page until one is
  // picked; then that scope's own defaults, as on the list page. Picking the
  // page's own scope again goes back to the page.
  const [cardScopePicked, setCardScopePicked] = useState(false)
  const baselineId = card
    ? (activeView ? cardViewBaselineId(activeView.id) : cardScopePicked ? CARD_SCOPE_BASELINE_ID : CARD_BASELINE_ID)
    : activeView ? activeView.id : defaultBaselineId(workspaceId, entityType, scoped)
  const cardBaseline = card?.baseline
  const cardRef = useRef(card)
  cardRef.current = card

  // The agent's page, over the entity's defaults: a card's baseline whenever
  // no saved view is picked, and what its report compares against either way.
  const cardPageBaseline = useMemo(
    () => cardBaseline
      ? { ...defaultConfig(entityType, scoped, 'all', 'contacts', 'all', 'workspace', scopeFields), ...cardBaseline }
      : null,
    [cardBaseline, entityType, scoped, scopeFields],
  )
  const cardPageBaselineRef = useRef(cardPageBaseline)
  cardPageBaselineRef.current = cardPageBaseline

  // Recompute the canonical baseline from the active view (or defaults).
  // Memoized so flipping back to a saved view gives identical refs.
  // The workspace span rides on a saved view too: which workspaces a list
  // spans is the app's setting, not something a view holds.
  const baseline = useMemo(
    () => activeView
      ? { ...viewToConfig(activeView), workspace_scope: workspaceScope }
      : (!cardScopePicked && cardPageBaseline)
        || defaultConfig(entityType, scoped, actionScope, crmScope, captureScope, workspaceScope, scopeFields, libraryScope),
    [cardPageBaseline, cardScopePicked, activeView, entityType, scoped, actionScope, crmScope, captureScope, workspaceScope, scopeFields, libraryScope],
  )

  // Unsaved overrides for the current baseline, seeded from localStorage so
  // navigating away and back (or reloading) restores the draft. A card's come
  // from the card.
  const [overrides, setOverridesState] = useState<Partial<ViewConfig>>(() => (card ? card.overrides ?? {} : readDraftIn(memoryDraftsRef.current, baselineId)))

  // A card that switched baselines starts its changes over. Adjusted DURING
  // render, like the span refit below, so the list never queries the new
  // baseline with changes made against the old one.
  const [cardBaselineId, setCardBaselineId] = useState(baselineId)
  if (card && cardBaselineId !== baselineId) {
    setCardBaselineId(baselineId)
    setOverridesState({})
  }

  // When baseline changes (user picked a different view or switched workspaces),
  // load that baseline's draft from storage. Each baseline has its own slot,
  // so drafts on view A survive a detour through view B. A card's changes
  // were reset above; the card is told, so it no longer keeps the old ones.
  const lastBaselineIdRef = useRef(baselineId)
  useEffect(() => {
    if (lastBaselineIdRef.current === baselineId) return
    lastBaselineIdRef.current = baselineId
    if (cardRef.current) cardRef.current.onOverridesChange?.({})
    else setOverridesState(readDraftIn(memoryDraftsRef.current, baselineId))
  }, [baselineId])

  // The switch flipped while this list is mounted: refit the My Actions tab
  // filter in the default draft to the new span (fitScopeAssigneeFilter).
  // Adjusted DURING render, the documented way to follow a prop, so the list
  // never queries once with the old span's filter. Only the tab's own filter
  // moves — the user's filters, layout and grouping stay. A saved view's
  // filters are its own complete set and are left alone.
  const [fittedScope, setFittedScope] = useState(workspaceScope)
  if (fittedScope !== workspaceScope) {
    setFittedScope(workspaceScope)
    if (!activeView && entityType === 'action' && !scoped && overrides.filters) {
      setOverridesState(pruneOverrides(baseline, {
        ...overrides,
        filters: fitScopeAssigneeFilter(overrides.filters, actionScope, workspaceScope),
      }))
    }
  }

  // Merge baseline + overrides into the effective config consumers see. A
  // draft restored while the app spans every workspace (written before the
  // switch was on, or under another workspace) can still hold the tab's `@me`
  // filter, which would narrow the list back to one workspace — it never
  // applies across workspaces, so it is dropped on read.
  const config = useMemo<ViewConfig>(() => {
    const merged = { ...baseline, ...overrides }
    if (workspaceScope === 'all' && overrides.filters) {
      merged.filters = overrides.filters.filter((f) => f.id !== '__scope_assignee')
    }
    return merged
  }, [baseline, overrides, workspaceScope])

  // Apply updates as overrides, pruning entries that match baseline.
  // Persists to localStorage on every change.
  const updateConfig = useCallback((updates: Partial<ViewConfig>) => {
    setOverridesState(prev => {
      const merged = { ...prev, ...updates }
      const pruned = pruneOverrides(baseline, merged)
      if (cardRef.current) {
        // Only changes to the agent's page are kept with the card (see `card`).
        if (baselineId === CARD_BASELINE_ID) queueMicrotask(() => cardRef.current?.onOverridesChange?.(pruned))
      } else writeDraftIn(memoryDraftsRef.current, baselineId, pruned)
      return pruned
    })
  }, [baseline, baselineId])

  // Explicit Save (Update button on the dirty bar). PATCHes the saved view
  // with all override fields, then clears the local draft.
  //
  // Capture activeView.id at call time, not closure time — if the user
  // switches views during the awaited PATCH, we clear the draft that was
  // saved (which is now stale on disk), not the new view's pending draft.
  const saveOverrides = useCallback(async () => {
    if (!activeView || !onSave) return
    if (Object.keys(overrides).length === 0) return
    const savedViewId = activeView.id
    // baselineId for a saved view IS its UUID (a card's is its own; see cardViewBaselineId)
    const savedBaselineId = cardRef.current ? cardViewBaselineId(savedViewId) : savedViewId
    // Strip ViewConfig-only fields that aren't columns on View. action_scope
    // is persisted via View.metadata (handled elsewhere); workspace_scope is
    // the app's switch, and crm_scope and capture_scope are session-only
    // navigation — none of them is persisted. Sending them to the View PATCH
    // endpoint would either be silently ignored or return a 400.
    const { action_scope, workspace_scope, crm_scope, capture_scope, library_scope, table, ...viewPatch } = overrides
    void action_scope
    void workspace_scope
    void crm_scope
    void capture_scope
    void library_scope
    // A table's settings live in the view's metadata, beside whatever else it holds.
    const patch: Partial<View> = 'table' in overrides
      ? { ...(viewPatch as Partial<View>), metadata: withTableSettings(activeView.metadata, table) }
      : (viewPatch as Partial<View>)
    await onSave(savedViewId, patch)
    if (!cardRef.current) writeDraftIn(memoryDraftsRef.current, savedBaselineId, {})
    // Only clear local React state if we're still on the same baseline.
    // Otherwise the user has moved on and the current overrides belong to
    // a different baseline that we must not stomp.
    if (lastBaselineIdRef.current === savedBaselineId) {
      setOverridesState({})
    }
  }, [activeView, onSave, overrides])

  // Discard overrides (Cancel button on the dirty bar).
  //
  // Uses lastBaselineIdRef instead of the closure-captured baselineId to
  // dodge the same race fixed in saveOverrides: if the user clicks Cancel
  // in the same render cycle as a baseline switch, the closure could point
  // at the new baseline while the in-memory overrides still belong to the
  // old one. Reading the ref gives us the value that React state is
  // actually in sync with.
  const discardOverrides = useCallback(() => {
    const currentBaselineId = lastBaselineIdRef.current
    setOverridesState({})
    if (cardRef.current) cardRef.current.onOverridesChange?.({})
    else writeDraftIn(memoryDraftsRef.current, currentBaselineId, {})
  }, [])

  // Atomic scope switch — used when changing scope tabs (assigned/created,
  // contacts/companies, mine/shared). Treats scope as baseline NAVIGATION,
  // not editing: it
  // updates the scope state (which changes the baseline) and drops exactly one
  // key from the default-baseline draft — `filters`.
  //
  // Why filters specifically, and nothing else: the scope's implied @me filter
  // lives in the BASELINE (defaultConfig injects it per actionScope). A filters
  // override left over from the previous scope would shadow the whole baseline
  // array, so the new scope's @me filter would never reach the query and the tab
  // would show the wrong rows. Every other draft key — layout, grouping,
  // ordering, display_properties, … — is orthogonal to scope and is the user's
  // deliberate arrangement of this list. Wiping the whole draft (the old
  // behavior) meant a single click on "All issues" silently threw away a board
  // layout the user had set up, which reads as the app losing their work.
  //
  // The `filters` field in overridesIn is intentionally ignored — the scope
  // change derives its filter from the new actionScope value via defaultConfig.
  // Callers used to pass the filter manually; that's now redundant.
  const resetConfig = useCallback((overridesIn: Partial<ViewConfig>) => {
    if (overridesIn.action_scope) setActionScope(overridesIn.action_scope)
    if (overridesIn.crm_scope) setCrmScope(overridesIn.crm_scope)
    if (overridesIn.capture_scope) setCaptureScope(overridesIn.capture_scope)
    if (overridesIn.library_scope) setLibraryScope(overridesIn.library_scope)
    if (cardRef.current) {
      // A card: the page's own scope (or a card with no page) stays on the
      // page; any other scope leaves it. Never the list page's draft: the
      // card's changes are its own. The scope's filter goes, as below.
      const page = cardPageBaselineRef.current
      const onPage = !page || SCOPE_KEYS.every((key) => overridesIn[key] === undefined || overridesIn[key] === page[key])
      setCardScopePicked(!onPage)
      setOverridesState((prev) => {
        const { filters, ...kept } = prev
        void filters
        if (onPage && lastBaselineIdRef.current === CARD_BASELINE_ID) queueMicrotask(() => cardRef.current?.onOverridesChange?.(kept))
        return kept
      })
      return
    }
    const targetBaselineId = defaultBaselineId(workspaceId, entityType, scoped)
    const { filters, ...kept } = readDraftIn(memoryDraftsRef.current, targetBaselineId)
    void filters
    writeDraftIn(memoryDraftsRef.current, targetBaselineId, kept)
    setOverridesState(kept)
  }, [workspaceId, entityType, scoped])

  const isDirty = Object.keys(overrides).length > 0
  const dirtyFields = Object.keys(overrides) as (keyof ViewConfig)[]

  return {
    config,
    baseline,
    /** A card's own baseline (the agent's page), whatever saved view is picked; null outside a card. */
    cardPageBaseline,
    overrides,
    isDirty,
    dirtyFields,
    updateConfig,
    saveOverrides,
    discardOverrides,
    resetConfig,
  }
}

function viewToConfig(view: View): ViewConfig {
  const layout = view.layout || defaultLayout(view.entity_type)
  // Board views require grouping — auto-set if the view was saved without it
  const grouping = view.grouping
    || (layout === 'board'
      ? { field: DEFAULT_BOARD_GROUP_BY[view.entity_type], direction: 'asc' as const }
      : null)

  return {
    filters: view.filters || [],
    grouping,
    sub_grouping: view.sub_grouping?.field ? view.sub_grouping : null,
    ordering: view.ordering || defaultOrdering(view.entity_type),
    display_properties: view.display_properties || [],
    layout,
    board_group_by: view.board_group_by,
    show_completed: view.show_completed ?? true,
    completed_filter: view.completed_filter || 'all',
    show_sub_items: view.show_sub_items ?? true,
    nested_sub_items: view.nested_sub_items ?? false,
    show_empty_groups: view.show_empty_groups ?? false,
    action_scope: (view.metadata as Record<string, unknown>)?.action_scope as 'assigned' | 'created' | 'all' || 'all',
    // The app-wide switch, set over this by useViewConfig — never the view's.
    workspace_scope: 'workspace',
    crm_scope: 'contacts',
    capture_scope: 'all',
    ...(view.entity_type === 'data_row' ? { table: readTableSettings(view.metadata) } : {}),
  }
}

// ============================================================
// useViewResults — fetches data using the view query engine
// ============================================================

// ── Stale-while-revalidate cache ─────────────────────────────
// Module-level cache so data survives component unmount/remount (tab switch).
// When a view mounts with cached data, it renders instantly and refreshes
// in the background — no loading spinner flash.

interface CacheEntry {
  data: Record<string, unknown>[] | GroupedResults[]
  totalCount: number
  timestamp: number
}

const viewResultsCache = new Map<string, CacheEntry>()
const VIEW_CACHE_MAX_ENTRIES = 30

function writeViewCache(key: string, data: CacheEntry['data'], totalCount: number) {
  viewResultsCache.set(key, { data, totalCount, timestamp: Date.now() })
  // Evict oldest entries when cache exceeds max size
  if (viewResultsCache.size > VIEW_CACHE_MAX_ENTRIES) {
    const oldest = viewResultsCache.keys().next().value
    if (oldest) viewResultsCache.delete(oldest)
  }
}

function readViewCache(key: string): CacheEntry | undefined {
  return viewResultsCache.get(key)
}

// ── Shared page-1 queries (perf plan 1.4; see leaseRequest) ──
// Keyed by queryKey + per_page: only identical page-1 bodies for the same
// workspace share; load-more pages always go out on their own. Joiners: the
// mount/query-change fetch and automatic refetches (refetch({ coalesce: true })
// — realtime, reconnect). A plain refetch() never joins.
//
// Freshness: every entity event and realtime recovery drops all entries before
// any list's own listener runs (this one is registered at module load, so it
// is first in line), so a joinable request was always sent after the last
// change this page has heard of. No post-completion reuse window is kept, and
// none is needed: lists that saw the same event arm their 300 ms debounce in
// the same dispatch and fire back to back, and the recovered event reaches
// them all in one dispatch, so the first list's request is still in flight
// when the others ask. A list that asks later sends its own, as before.
type ViewQueryResponse = { data?: unknown[]; total?: number } | null

const inflightViewQueries = new Map<string, SharedRequest<ViewQueryResponse>>()

if (typeof window !== 'undefined') {
  const dropInflightViewQueries = () => inflightViewQueries.clear()
  for (const name of ['ni:entity-created', 'ni:entity-updated', 'ni:entity-deleted', 'ni:realtime-recovered']) {
    window.addEventListener(name, dropInflightViewQueries)
  }
}

function postViewQuery(body: string, signal?: AbortSignal): Promise<ViewQueryResponse> {
  return fetch('/api/account/views/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  }).then((res) => (res.ok ? (res.json() as Promise<ViewQueryResponse>) : null))
}

/**
 * When an item moves between board columns optimistically, the caller only
 * supplies the *raw* field (e.g. `{ status_id: newUuid }`). But the item
 * carries denormalized mirrors of that field too — for status_id, the joined
 * `workflow_state` object plus flattened `status_name`/`status_color`/
 * `status_category`; for project_id, the joined `project` object plus
 * `project_name`. Any consumer that reads those mirrors (the next refetch's
 * `groupResults` call, badge renderers, etc.) would see the old value and
 * either re-file the card back to its origin column or display stale UI.
 *
 * This helper samples the destination group's existing items / metadata to
 * synthesize the appropriate denormalized object, so the optimistic item is
 * internally consistent with where it now lives. Returns the patch to
 * `Object.assign` onto the moved item.
 *
 * Falls back to `{}` if the destination column has nothing to sample from
 * AND no metadata hint — the next server fetch will reconcile.
 */
function deriveDenormalizedFields(
  groups: GroupedResults[],
  toGroupKey: string,
  groupField: string | null,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!groupField) return {}
  const targetGroup = groups.find(g => g.key === toGroupKey)

  if (groupField === 'status_id') {
    const newId = fields.status_id as string | undefined
    if (!newId) return {}
    // Prefer a sample item — gives us the full `workflow_state` shape.
    const sample = targetGroup?.items?.find(
      it => (it.workflow_state as { id?: string } | undefined)?.id === newId,
    )
    if (sample) {
      const ws = sample.workflow_state as { id: string; name: string; category: string; color: string }
      return {
        workflow_state: { ...ws },
        status_name: ws.name,
        status_color: ws.color,
        status_category: ws.category,
      }
    }
    // Empty column with metadata.status_id but no item to sample — we can at
    // least keep workflow_state.id correct so any id-based comparison still
    // works. Name/category/color must be filled in by the server refetch.
    const metaStatusId = targetGroup?.metadata?.status_id as string | undefined
    if (metaStatusId === newId) {
      return { workflow_state: { id: newId, name: '', category: '', color: '' } }
    }
    return {}
  }

  // A deal dragged to another stage column (roadmap #8): the column IS the
  // stage, so its label and kind (deal-board.ts metadata) are the new chip.
  if (groupField === 'stage_id') {
    const newId = fields.stage_id as string | undefined
    if (!newId || !targetGroup) return {}
    const kind = targetGroup.metadata?.stage_kind as string | undefined
    return { stage: { id: newId, name: targetGroup.label.split(' · ')[0], kind: kind ?? 'open' } }
  }

  if (groupField === 'project_id') {
    const newProjectId = fields.project_id as string | null | undefined
    if (newProjectId === null) {
      return { project: null, project_name: null, project_id: null }
    }
    if (!newProjectId) return {}
    const sample = targetGroup?.items?.find(
      it => (it.project as { id?: string } | undefined)?.id === newProjectId,
    )
    if (sample) {
      const p = sample.project as { id: string; name: string } | null
      return {
        project: p ? { ...p } : null,
        project_name: p?.name ?? null,
      }
    }
    return {}
  }

  // Other groupings (priority, assignee_id, etc.) don't carry a joined
  // object — the raw field IS the denormalized form. Nothing extra to set.
  return {}
}

export function useViewResults(
  activeViewId: string | null,
  config: ViewConfig,
  entityType: ViewEntityType,
  teamId?: string,
  scopeFilters?: ViewFilter[],
  search?: string,
  /**
   * When false, the row query never runs and the hook holds an empty result.
   *
   * The `graph` layout draws the knowledge map, which fetches its own tiles
   * from /api/account/knowledge/map and never reads a row. Without this gate
   * every graph view would ALSO run a paginated claim query whose result is
   * thrown away — on each filter edit, on the largest workspaces, alongside the
   * map fetch it is competing with.
   *
   * It is a parameter rather than a conditional call on purpose: hooks cannot
   * be called conditionally, and the one implementation that "obviously" works
   * — wrapping the call in an `if` — is a rules-of-hooks violation that breaks
   * the moment the layout toggle changes.
   */
  enabled = true,
) {
  const perPage = config.grouping ? 500 : 50
  const workspaceId = useWorkspaceId()

  // Does this list currently span every workspace? Only actions and projects
  // have a cross-workspace query on the server, so the flag is pinned to those
  // entity types rather than trusting whatever config it is handed.
  const crossWorkspace =
    (entityType === 'action' || entityType === 'project') && config.workspace_scope === 'all'

  // Realtime has to follow the query. The shared entity channel filters
  // `actions` and `projects` to the active workspace, so while this list is
  // showing other workspaces' rows it asks that binding to widen (see
  // acquireCrossWorkspaceTable). Ref-counted and released on unmount or the
  // moment the switch goes back, so a single list leaving personal scope
  // narrows the binding again.
  useEffect(() => {
    if (!crossWorkspace) return
    return acquireCrossWorkspaceTable(entityType === 'project' ? 'projects' : 'actions')
  }, [crossWorkspace, entityType])

  // Scope filters are merged into every query but cannot be removed by the
  // user. Stable key for dependency tracking since filter arrays are usually
  // re-created on each render.
  const scopeFiltersKey = useMemo(() => JSON.stringify(scopeFilters ?? []), [scopeFilters])
  const mergedFilters = useMemo(() => {
    if (!scopeFilters?.length) return config.filters
    // Scope filters first — stable prefix — then user filters.
    return [...scopeFilters, ...config.filters]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.filters, scopeFiltersKey])

  // Build the query body from current props — this is the source of truth.
  // Memoized so it only changes when query-affecting values change (by value).
  const queryBody = useMemo(() => ({
    entity_type: entityType,
    filters: mergedFilters,
    ordering: config.ordering,
    grouping: config.grouping,
    // Board layout doesn't render sub-groups — skip to keep items in main groups
    sub_grouping: config.layout === 'board' ? null : config.sub_grouping,
    // NEVER a team with 'all': a team belongs to one workspace, so team-scoping
    // a cross-workspace query would narrow it back to that workspace's rows
    // (the route merges board columns by category regardless, but the row set
    // is the part that would silently collapse).
    team_id: crossWorkspace ? null : (teamId || null),
    show_completed: config.show_completed,
    completed_filter: config.completed_filter,
    // When a saved view is active, don't send action_scope — the view's own
    // filters are the complete set. Same when the view is parent-scoped
    // (Project → Actions shows everyone's actions in that project).
    action_scope: activeViewId || scopeFilters?.length ? null : config.action_scope,
    // Workspace span. Omitted entirely (undefined → dropped by JSON.stringify)
    // in the default scope, so every pre-existing caller's body is unchanged
    // byte for byte and the server's own default applies. Unlike action_scope
    // it IS sent on a saved view: the workspaces a query spans can't be
    // expressed as one of the view's filters, so nothing else would carry it.
    workspace_scope: crossWorkspace ? 'all' : undefined,
    // CRM internal/external scope — only sent when not on a saved view
    crm_scope: activeViewId ? null : (config.crm_scope === 'internal' || config.crm_scope === 'external' ? config.crm_scope : null),
    // Capture mine/shared scope — only sent when not on a saved view
    capture_scope: activeViewId ? null : (config.capture_scope === 'mine' || config.capture_scope === 'shared' ? config.capture_scope : null),
    // Free-text search term — forwarded to the server query engine
    search: search || undefined,
  }), [activeViewId, entityType, teamId, mergedFilters, config.ordering,
       config.grouping, config.sub_grouping, config.layout, config.show_completed,
       config.completed_filter, config.action_scope, config.crm_scope, config.capture_scope,
       crossWorkspace, scopeFilters?.length, search])

  // Serialized key for dependency tracking — includes workspace ID so the cache
  // differentiates between workspaces (the server resolves workspace from session
  // cookies, but the client-side cache needs an explicit key).
  const queryKey = useMemo(
    () => JSON.stringify({ ...queryBody, _ws: workspaceId }),
    [queryBody, workspaceId],
  )

  // Initialize from cache if available — instant render, no loading flash
  const cached = readViewCache(queryKey)
  const [data, setData] = useState<Record<string, unknown>[] | GroupedResults[]>(cached?.data ?? [])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalCount, setTotalCount] = useState(cached?.totalCount ?? 0)
  const pageRef = useRef(1)
  const hasMoreRef = useRef(true)

  // Page-1 request lease (was a per-instance AbortController) + generation
  // counter — guarantees only the latest fetch ever writes to state,
  // regardless of how many intermediate fetches fire.
  const leaseRef = useRef<RequestLease<ViewQueryResponse> | null>(null)
  const genRef = useRef(0)

  // Track the queryKey so we can reset state when it changes (e.g. switching views)
  const prevQueryKeyRef = useRef(queryKey)

  // Core fetch function — takes the EXACT body to send, no refs. `share`
  // lets a page-1 fetch join an identical in-flight request from another list.
  const doFetch = useCallback(async (
    body: typeof queryBody,
    pageNum: number,
    append: boolean,
    gen: number,
    cacheKey: string,
    hasCachedData: boolean,
    share = false,
  ) => {
    // The page-1 lease this fetch supersedes: released (aborted once nobody
    // waits on it) before the new request starts.
    if (!append) {
      leaseRef.current?.release(true)
      leaseRef.current = null
      // A page-1 fetch supersedes any load-more in flight, which then returns
      // early on its stale generation and never clears the flag itself.
      setLoadingMore(false)
      // Only show loading spinner if there's no cached data to display
      if (!hasCachedData) setLoading(true)
    } else {
      setLoadingMore(true)
    }

    try {
      const requestBody = JSON.stringify({ ...body, page: pageNum, per_page: perPage })
      let json: ViewQueryResponse
      if (append) {
        json = await postViewQuery(requestBody)
      } else {
        const lease = leaseRequest(
          inflightViewQueries,
          `${cacheKey}|${perPage}`,
          share,
          (signal) => postViewQuery(requestBody, signal),
        )
        leaseRef.current = lease
        json = await lease.promise
      }

      // Discard if a newer fetch has started
      if (gen !== genRef.current) return

      if (json) {
        const newItems = (json.data || []) as Record<string, unknown>[]
        setTotalCount(json.total ?? 0)
        hasMoreRef.current = newItems.length >= perPage

        if (append && !body.grouping) {
          setData(prev => {
            const all = [...(prev as Record<string, unknown>[]), ...newItems]
            const seen = new Set<unknown>()
            return all.filter(item => {
              if (seen.has(item.id)) return false
              seen.add(item.id)
              return true
            })
          })
        } else if (body.grouping) {
          setData(newItems)
          // Write to cache after successful page-1 fetch
          if (!append) writeViewCache(cacheKey, newItems, json.total ?? 0)
        } else {
          const seen = new Set<unknown>()
          const deduped = newItems.filter(item => {
            if (seen.has(item.id)) return false
            seen.add(item.id)
            return true
          })
          setData(deduped)
          // Write to cache after successful page-1 fetch
          if (!append) writeViewCache(cacheKey, deduped, json.total ?? 0)
        }
      } else if (append) {
        // The page failed: the next load-more asks for it again, not the one after.
        pageRef.current = pageNum - 1
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError' && !append && gen === genRef.current) {
        setData([])
        setTotalCount(0)
      }
      if (append && gen === genRef.current) pageRef.current = pageNum - 1
    }

    if (gen === genRef.current) {
      if (append) setLoadingMore(false)
      else setLoading(false)
    }
  }, [perPage])

  // Saved-view resolution gate: while the composing useView is still resolving
  // THIS activeViewId, `config` is still the DEFAULT config, so firing the
  // query now would run (and pay for) a query the user never asked for, then
  // immediately run the real one. Subscribed via useSyncExternalStore so the
  // release re-renders us and the held fetch actually fires. Only the INITIAL
  // fetch is held — once a query has gone out, later config changes are real
  // user intent and must never be gated.
  const viewResolutionPending = useSyncExternalStore(
    subscribePendingViewResolutions,
    () => isViewResolutionPending(activeViewId),
    () => false, // SSR: never hold (no fetch happens there anyway)
  )
  const hasFetchedOnceRef = useRef(false)

  // Fetch page 1 for `key`. If cached data exists for it, render it
  // immediately and refresh in the background (stale-while-revalidate). Only
  // show loading spinner when there's no cached data at all. Called only from
  // the two effects below, always with the current render's query.
  const fetchFirstPage = (body: typeof queryBody, key: string) => {
    hasFetchedOnceRef.current = true
    pageRef.current = 1
    hasMoreRef.current = true
    genRef.current += 1

    // When queryKey changes (e.g. switching views), seed from cache or clear
    if (prevQueryKeyRef.current !== key) {
      prevQueryKeyRef.current = key
      const entry = readViewCache(key)
      if (entry) {
        setData(entry.data)
        setTotalCount(entry.totalCount)
      } else {
        setData([])
        setTotalCount(0)
      }
    }

    const hasCachedData = readViewCache(key) != null
    doFetch(body, 1, false, genRef.current, key, hasCachedData, true)
  }

  // Primary effect: fetch page 1 whenever the query changes.
  useEffect(() => {
    if (!enabled) return
    if (viewResolutionPending && !hasFetchedOnceRef.current) return
    fetchFirstPage(queryBody, queryKey)
  }, [queryKey, doFetch, viewResolutionPending, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Unmount: stop holding the shared request without aborting it — as before,
  // it still lands in the SWR cache, but no later mount can join it.
  useEffect(() => () => leaseRef.current?.release(false), [])

  // Refs for values used inside callbacks fired from event handlers (scroll,
  // delete, edit). Declared BEFORE the callbacks so the closure reference is
  // valid at hook-call order — using them later would work today (closures
  // capture the ref object, not its current value), but relying on that is
  // fragile and breaks if any synchronous code is added that reads the ref.
  const queryBodyRef = useRef(queryBody)
  queryBodyRef.current = queryBody
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMoreRef.current) return
    const nextPage = pageRef.current + 1
    pageRef.current = nextPage
    doFetch(queryBodyRef.current, nextPage, true, genRef.current, queryKeyRef.current, true)
  }, [doFetch, loadingMore])

  const updateItem = useCallback((id: string, fields: Record<string, unknown>) => {
    setData(prev => {
      if (config.grouping) {
        return (prev as GroupedResults[]).map(group => ({
          ...group,
          items: group.items.map(item => item.id === id ? { ...item, ...fields } : item),
        }))
      }
      return (prev as Record<string, unknown>[]).map(item => item.id === id ? { ...item, ...fields } : item)
    })
    // Also patch the cached entry so a tab switch doesn't lose the change
    const entry = readViewCache(queryKeyRef.current)
    if (entry) {
      const nextData = config.grouping
        ? (entry.data as GroupedResults[]).map(g => ({
            ...g,
            items: g.items.map(it => it.id === id ? { ...it, ...fields } : it),
          }))
        : (entry.data as Record<string, unknown>[]).map(it => it.id === id ? { ...it, ...fields } : it)
      writeViewCache(queryKeyRef.current, nextData, entry.totalCount)
    }
  }, [config.grouping])

  /**
   * Physically move an item from one board column to another, applying
   * `fields` to the item data in the process. Used for optimistic drag-and-drop
   * on the Kanban board — call this instead of `updateItem` when the grouping
   * field itself changes, so the card visually lands in the new column
   * immediately rather than waiting for the API round-trip.
   *
   * Also synthesizes the *denormalized* shape of the new grouping value
   * (e.g. `workflow_state.{id,name,category,color}` and the flattened
   * `status_name/status_color/status_category` mirrors) by sampling the
   * destination group. Without this the optimistic item ends up with
   * `status_id = newId` but `workflow_state` pointing at the old state, which
   * breaks any consumer that re-derives the column from `workflow_state`
   * (e.g. cache rehydration on remount where `groupResults`-style logic
   * would file the card back into its original column).
   *
   * Returns the snapshot of the moved item (before applying `fields`) so the
   * caller can rollback on API failure.
   */
  const moveItemBetweenGroups = useCallback((
    id: string,
    fromGroupKey: string,
    toGroupKey: string,
    fields: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    let snapshot: Record<string, unknown> | undefined

    const groupField = config.grouping?.field ?? null

    // Apply the move to a GroupedResults snapshot. Pure: returns the next
    // groups array plus the captured pre-move snapshot of the moved item.
    const applyMove = (groups: GroupedResults[]): { next: GroupedResults[]; snap?: Record<string, unknown> } => {
      let movedItem: Record<string, unknown> | undefined
      let actualFromKey: string | undefined
      for (const group of groups) {
        const found = group.items.find(it => it.id === id)
        if (found) { movedItem = found; actualFromKey = group.key; break }
      }
      if (!movedItem) return { next: groups }

      const denormalized = deriveDenormalizedFields(groups, toGroupKey, groupField, fields)
      const updatedItem = { ...movedItem, ...fields, ...denormalized }

      const next = groups.map(group => {
        if (group.key === actualFromKey) {
          return { ...group, items: group.items.filter(it => it.id !== id) }
        }
        if (group.key === toGroupKey) {
          return { ...group, items: [...group.items, updatedItem] }
        }
        return group
      })
      return { next, snap: movedItem }
    }

    setData(prev => {
      if (!config.grouping) return prev
      const { next, snap } = applyMove(prev as GroupedResults[])
      if (snap) snapshot = snap
      return next
    })

    // Also patch the cache so a tab switch doesn't flash the old column.
    // Reads `data` from the live ref so we apply the move on top of the
    // freshest snapshot (which may already include other in-flight optimistic
    // changes), not the cache's older copy.
    const entry = readViewCache(queryKeyRef.current)
    if (entry && config.grouping) {
      const { next } = applyMove(entry.data as GroupedResults[])
      writeViewCache(queryKeyRef.current, next, entry.totalCount)
    }

    return snapshot
  }, [config.grouping])

  const removeItem = useCallback((id: string) => {
    setData(prev => {
      if (config.grouping) {
        return (prev as GroupedResults[]).map(group => ({
          ...group,
          items: group.items.filter(item => item.id !== id),
        }))
      }
      return (prev as Record<string, unknown>[]).filter(item => item.id !== id)
    })
    setTotalCount(c => Math.max(0, c - 1))
    const entry = readViewCache(queryKeyRef.current)
    if (entry) {
      const nextData = config.grouping
        ? (entry.data as GroupedResults[]).map(g => ({
            ...g,
            items: g.items.filter(it => it.id !== id),
          }))
        : (entry.data as Record<string, unknown>[]).filter(it => it.id !== id)
      writeViewCache(queryKeyRef.current, nextData, Math.max(0, entry.totalCount - 1))
    }
  }, [config.grouping])

  // `coalesce: true` (automatic refetches only) may join an identical request
  // another list has in flight — see inflightViewQueries. A plain refetch()
  // (after this list's own mutation) always sends its own.
  const refetch = useCallback((options?: { coalesce?: boolean }) => {
    pageRef.current = 1
    hasMoreRef.current = true
    genRef.current += 1
    // Explicit refetch always has cached data (user is already looking at the list)
    doFetch(queryBodyRef.current, 1, false, genRef.current, queryKeyRef.current, true, options?.coalesce === true)
  }, [doFetch])

  return {
    data,
    loading,
    loadingMore,
    totalCount,
    hasMore: hasMoreRef.current,
    loadMore,
    refetch,
    updateItem,
    moveItemBetweenGroups,
    removeItem,
  }
}

