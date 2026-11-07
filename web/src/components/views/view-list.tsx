'use client'

import * as React from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronRight, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EntityRow, getTitle, type PatchItemFn } from './list/entity-row'
import type { ViewEntityType, GroupedResults } from '@/lib/views/types'
import type { ViewConfig } from './hooks/use-view'
import type { PickerContext } from './properties'
import { FlowIndicator } from './flow-indicator'
import { flowsForStatusIds, type FlowStatusMap, type FlowRef } from './hooks/use-flow-status-ids'
import { statusIdsForGroup } from './group-status-ids'

/** Enabled flows attached to a status group (only when grouping by status). */
function flowsForGroup(group: GroupedResults, flowStatusIds?: FlowStatusMap): FlowRef[] {
  if (!flowStatusIds) return []
  return flowsForStatusIds(statusIdsForGroup(group), flowStatusIds)
}

interface ViewListProps {
  entityType: ViewEntityType
  data: Record<string, unknown>[] | GroupedResults[]
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  config: ViewConfig
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  /** Bulk selection state */
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  /** Inline editing — see EntityRow for details. */
  onPatch?: PatchItemFn
  pickerContext?: PickerContext
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  /** workflow_state id → enabled flows that fire on entry (⚡ group badge). */
  flowStatusIds?: FlowStatusMap
  /**
   * Enables parent/child tree expansion. Rows with `item.has_children === true`
   * render a chevron; clicking it calls `getChildren(parentId)` on first expand
   * and caches the result. A row that already carries its children INLINE
   * (`item.children`, an array — how the views route hands a prospect company
   * its people) needs no fetch and starts EXPANDED: the children are the
   * point of the row, and a list of collapsed chevrons would hide them behind
   * one click each. Currently only applies to flat (non-grouped) lists.
   */
  treeEnabled?: boolean
  /** Fetcher for a parent's children. Called once per expand; results are cached. */
  getChildren?: (parentId: string) => Promise<Record<string, unknown>[]>
}

export function ViewList({
  entityType, data, loading, loadingMore, hasMore, onLoadMore,
  config, selectedItemId, onItemSelect,
  selectionActive, checkedIds, onToggleCheck,
  onPatch, pickerContext, canEdit,
  flowStatusIds,
  treeEnabled, getChildren,
}: ViewListProps) {
  // Only show ⚡ when the list is grouped by workflow_state status; for any
  // other grouping field a status flow has no relationship to the group.
  const showFlowIndicators = config.grouping?.field === 'status_id'
  const scrollRef = React.useRef<HTMLDivElement>(null)

  /**
   * The grouped path's compose bookkeeping — see `useComposingRowId`.
   *
   * Held here and not inside `GroupSection` because groups nest: a subgroup
   * owning its own copy would let two rows in two subgroups believe they are
   * both composing. One per LIST is the same invariant the flat path keeps.
   *
   * Declared unconditionally, above the `loading` early return, so the hook
   * order does not depend on which branch renders.
   */
  const [, onGroupedComposeChange] = useComposingRowId()

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    )
  }

  // Determine if data is grouped
  const isGrouped = config.grouping && Array.isArray(data) && data.length > 0
    && typeof (data[0] as GroupedResults).key === 'string'

  if (isGrouped) {
    return (
      <div ref={scrollRef} className="h-full overflow-y-auto pb-28">
        {(data as GroupedResults[]).map(group => (
          <GroupSection
            key={group.key}
            group={group}
            entityType={entityType}
            displayProperties={config.display_properties}
            selectedItemId={selectedItemId}
            onItemSelect={onItemSelect}
            selectionActive={selectionActive}
            checkedIds={checkedIds}
            onToggleCheck={onToggleCheck}
            onPatch={onPatch}
            pickerContext={pickerContext}
            canEdit={canEdit}
            onComposeChange={onGroupedComposeChange}
            flows={showFlowIndicators ? flowsForGroup(group, flowStatusIds) : undefined}
          />
        ))}
        {(data as GroupedResults[]).length === 0 && <EmptyState />}
      </div>
    )
  }

  // Flat list with virtualization + infinite scroll
  return (
    <FlatList
      scrollRef={scrollRef}
      items={data as Record<string, unknown>[]}
      entityType={entityType}
      displayProperties={config.display_properties}
      selectedItemId={selectedItemId}
      onItemSelect={onItemSelect}
      loadingMore={loadingMore}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      selectionActive={selectionActive}
      checkedIds={checkedIds}
      onToggleCheck={onToggleCheck}
      onPatch={onPatch}
      pickerContext={pickerContext}
      canEdit={canEdit}
      treeEnabled={treeEnabled}
      getChildren={getChildren}
    />
  )
}

// ── Flat virtualized list ──────────────────────────────────

interface VisualRow {
  item: Record<string, unknown>
  depth: number
  hasChildren: boolean
}

/** The children a row carries inline, or null when it relies on `getChildren`. */
function inlineChildren(item: Record<string, unknown>): Record<string, unknown>[] | null {
  return Array.isArray(item.children) ? (item.children as Record<string, unknown>[]) : null
}

/**
 * Whether a tree row is open. Lazy rows (children fetched on demand) start
 * CLOSED and live in `expanded`; inline rows start OPEN and live in
 * `collapsed`. Two sets rather than one because the default differs, and a
 * single "expanded" set would have to be seeded with every inline id as the
 * page loads — and re-seeded on every page of an infinite scroll.
 */
export function isTreeRowOpen(
  item: Record<string, unknown>,
  expanded: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): boolean {
  const id = item.id as string
  return inlineChildren(item) ? !collapsed.has(id) : expanded.has(id)
}

/**
 * Flatten the tree into the rows the virtualizer draws. Pure and exported so
 * the walk — which decides what a user SEES — is testable without a
 * virtualizer, which jsdom cannot size.
 */
export function buildVisualRows(
  items: Record<string, unknown>[],
  opts: {
    treeEnabled: boolean
    expanded: ReadonlySet<string>
    collapsed: ReadonlySet<string>
    childrenByParent: Record<string, Record<string, unknown>[]>
  },
): VisualRow[] {
  if (!opts.treeEnabled) return items.map((item) => ({ item, depth: 0, hasChildren: false }))
  const rows: VisualRow[] = []
  const walk = (list: Record<string, unknown>[], depth: number) => {
    for (const item of list) {
      const id = item.id as string
      const inline = inlineChildren(item)
      const hasChildren = inline ? inline.length > 0 : !!item.has_children
      rows.push({ item, depth, hasChildren })
      if (hasChildren && isTreeRowOpen(item, opts.expanded, opts.collapsed)) {
        const kids = inline ?? opts.childrenByParent[id]
        if (kids) walk(kids, depth + 1)
      }
    }
  }
  walk(items, 0)
  return rows
}

/**
 * How tall a row is while it holds the compose strip.
 *
 * The strip is a label (~14px) over a 32px control over a hint (~14px) plus the
 * strip's own padding and the row's — measured at 93px in the browser, rounded
 * up so a hint that wraps to a second line still fits rather than clipping. It
 * is a constant rather than a measurement on purpose: see `composingRowId`.
 */
const COMPOSE_ROW_HEIGHT = 96

/**
 * WHICH ROW IS COMPOSING, and the one stable callback every row reports through.
 *
 * Shared by both list paths, for two different reasons:
 *
 *  - The FLAT path needs the id, because its slots are absolutely positioned at
 *    a height the virtualizer decides (see `estimateSize`): a row that grows
 *    into the compose strip without telling anyone draws ON TOP of its
 *    neighbours instead of pushing them down.
 *  - The GROUPED path does not need the id — its rows are in normal flow and
 *    push their siblings down by themselves — but it still has to PASS the
 *    callback, so `EntityRow`'s compose contract is wired on both surfaces
 *    rather than only on the one that happens to be virtualized today. Grouped
 *    rows silently dropped the announcement, which was benign only for as long
 *    as the grouped path stayed in normal flow; the day it windows by height
 *    the overlap comes back with nothing on the way down to catch it.
 *
 * The returned callback is referentially STABLE, and it has to be. `EntityRow`
 * is memoized, and the row's "release the tall slot when I unmount" cleanup
 * depends on this callback — so a fresh closure per render re-runs that effect,
 * whose cleanup reports `false` and ends compose on the very next render. An
 * inline arrow made picking a provider look like a dead click: the strip
 * mounted and was torn down in the same commit. Taking the row id as an
 * ARGUMENT is what lets one function serve every row.
 */
function useComposingRowId(): [string | null, (itemId: string, composing: boolean) => void] {
  /**
   * Held here rather than measured, because measurement is the thing that goes
   * stale. `measureElement` caches per index and re-reads on a ResizeObserver
   * callback; entering compose is a MOUNT and leaving it an UNMOUNT, so the
   * shrink back to one line does not always produce an observed resize, and the
   * list was left with a permanent gap where the form used to be. One id in
   * state is exact in both directions and re-runs the size function by itself.
   */
  const [composingRowId, setComposingRowId] = React.useState<string | null>(null)

  const handleRowComposeChange = React.useCallback((itemId: string, composing: boolean) => {
    // Last writer wins: only one row composes at a time (opening a second menu
    // closes the first), and `: prev` keeps a row's own exit from clearing a
    // DIFFERENT row that has since taken over.
    setComposingRowId((prev) => (composing ? itemId : prev === itemId ? null : prev))
  }, [])

  return [composingRowId, handleRowComposeChange]
}

function FlatList({
  scrollRef, items, entityType, displayProperties, selectedItemId, onItemSelect,
  loadingMore, hasMore, onLoadMore,
  selectionActive, checkedIds, onToggleCheck,
  onPatch, pickerContext, canEdit,
  treeEnabled, getChildren,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  items: Record<string, unknown>[]
  entityType: ViewEntityType
  displayProperties: string[]
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  loadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  onPatch?: PatchItemFn
  pickerContext?: PickerContext
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  treeEnabled?: boolean
  getChildren?: (parentId: string) => Promise<Record<string, unknown>[]>
}) {
  // Tree expansion state (only used when treeEnabled). `expanded` is the
  // lazy rows the user opened; `collapsed` is the inline rows the user closed
  // — see `isTreeRowOpen` for why the defaults differ.
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = React.useState<Record<string, Record<string, unknown>[]>>({})
  const inlineIds = React.useMemo(
    () => new Set(items.filter((i) => inlineChildren(i) !== null).map((i) => i.id as string)),
    [items],
  )

  const toggleExpand = React.useCallback((id: string) => {
    if (inlineIds.has(id)) {
      setCollapsed(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // Lazy-fetch children on first expand
        if (!childrenByParent[id] && getChildren) {
          getChildren(id)
            .then(children => setChildrenByParent(prev => ({ ...prev, [id]: children })))
            .catch(() => setChildrenByParent(prev => ({ ...prev, [id]: [] })))
        }
      }
      return next
    })
  }, [childrenByParent, getChildren, inlineIds])

  // Flatten items + open children into visual rows for the virtualizer
  const visualRows: VisualRow[] = React.useMemo(
    () => buildVisualRows(items, { treeEnabled: !!treeEnabled, expanded, collapsed, childrenByParent }),
    [items, treeEnabled, expanded, collapsed, childrenByParent],
  )

  /**
   * WHICH ROW IS COMPOSING, and therefore how tall it is.
   *
   * Every row is one 40px line — until the push menu turns one of them into the
   * compose strip, which stacks a label, a control and a hint and needs roughly
   * twice that. The virtualizer positions rows ABSOLUTELY from `estimateSize`,
   * so a row that outgrows its slot does not push the list down: it draws ON TOP
   * of the rows beneath it. That is the reported "Create button overlapping the
   * row" — the strip was rendering correctly and being covered by its neighbours,
   * which also hid every field to the right of the fold.
   */
  const [composingRowId, handleRowComposeChange] = useComposingRowId()

  const estimateSize = React.useCallback(
    (index: number) => (visualRows[index]?.item.id === composingRowId ? COMPOSE_ROW_HEIGHT : 40),
    [visualRows, composingRowId],
  )

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 20,
  })

  // The size FUNCTION changing is not enough — the virtualizer caches per index
  // and only re-reads when told to. One row's height changed, so the offsets of
  // every row after it are wrong until this runs.
  React.useEffect(() => {
    virtualizer.measure()
  }, [composingRowId, virtualizer])

  // Infinite scroll: load more when scrolling near the bottom
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el || !hasMore || loadingMore || !onLoadMore) return
    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight - scrollTop - clientHeight < 200) {
      onLoadMore()
    }
  }, [scrollRef, hasMore, loadingMore, onLoadMore])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [scrollRef, handleScroll])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto pb-28">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vi => {
          const row = visualRows[vi.index]
          const { item, depth, hasChildren } = row
          const itemId = item.id as string
          return (
            <div
              key={itemId || vi.index}
              style={{
                position: 'absolute', top: 0, left: 12, right: 12, width: 'calc(100% - 24px)',
                height: vi.size, transform: `translateY(${vi.start}px)`,
              }}
            >
              <EntityRow
                item={item}
                entityType={entityType}
                displayProperties={displayProperties}
                isSelected={selectedItemId === itemId}
                onItemSelect={onItemSelect}
                isChecked={checkedIds?.has(itemId)}
                selectionActive={selectionActive}
                onToggleCheck={onToggleCheck}
                onPatch={onPatch}
                pickerContext={pickerContext}
                canEdit={canEdit}
                depth={depth}
                hasChildren={hasChildren}
                onComposeChange={handleRowComposeChange}
                isExpanded={isTreeRowOpen(item, expanded, collapsed)}
                onToggleExpand={treeEnabled ? toggleExpand : undefined}
              />
            </div>
          )
        })}
      </div>
      {loadingMore && (
        <div className="py-3 flex justify-center">
          <ThinkingOrb state="working" size={20} theme="auto" />
        </div>
      )}
      {visualRows.length === 0 && <EmptyState />}
    </div>
  )
}

// ── Group section ──────────────────────────────────────────

function GroupSection({
  group, entityType, displayProperties, selectedItemId, onItemSelect,
  selectionActive, checkedIds, onToggleCheck,
  onPatch, pickerContext, canEdit, onComposeChange, flows,
}: {
  group: GroupedResults
  entityType: ViewEntityType
  displayProperties: string[]
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  onPatch?: PatchItemFn
  pickerContext?: PickerContext
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  /**
   * Forwarded to every leaf row, including through nested subgroups. Must be the
   * SAME function identity for the whole list — `EntityRow` is memoized and its
   * unmount cleanup depends on it, so a per-group closure would end compose on
   * the next render. See `useComposingRowId`.
   */
  onComposeChange?: (itemId: string, composing: boolean) => void
  flows?: FlowRef[]
}) {
  const [collapsed, setCollapsed] = React.useState(false)

  return (
    <div>
      <div className="flex items-center w-full px-4 py-2 hover:bg-muted/30 transition-colors group">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-left"
        >
          <ChevronRight className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            !collapsed && 'rotate-90',
          )} />
          <span className="text-sm font-medium">{group.label}</span>
          <span className="text-xs text-muted-foreground ml-1">
            {group.items?.length ?? 0}
          </span>
        </button>
        {flows && flows.length > 0 && <FlowIndicator flows={flows} className="ml-2" />}
        <Plus className="h-3.5 w-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {!collapsed && (
        <div className="px-3">
          {group.subGroups ? (
            group.subGroups.map(sub => (
              <GroupSection
                key={sub.key}
                group={sub}
                entityType={entityType}
                displayProperties={displayProperties}
                selectedItemId={selectedItemId}
                onItemSelect={onItemSelect}
                selectionActive={selectionActive}
                checkedIds={checkedIds}
                onToggleCheck={onToggleCheck}
                onPatch={onPatch}
                pickerContext={pickerContext}
                canEdit={canEdit}
                onComposeChange={onComposeChange}
              />
            ))
          ) : (
            <GroupItems
              items={group.items ?? []}
              entityType={entityType}
              displayProperties={displayProperties}
              selectedItemId={selectedItemId}
              onItemSelect={onItemSelect}
              selectionActive={selectionActive}
              checkedIds={checkedIds}
              onToggleCheck={onToggleCheck}
              onPatch={onPatch}
              pickerContext={pickerContext}
              canEdit={canEdit}
              onComposeChange={onComposeChange}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Group items (progressive rendering) ────────────────────

/** Rows mounted immediately; the rest reveal in chunks as the tail scrolls in. */
const GROUP_INITIAL_ROWS = 80
const GROUP_CHUNK_ROWS = 80

/**
 * Renders a group's leaf items with progressive mounting instead of one giant
 * synchronous `.map`. Grouped views fetch up to 500 rows and a page can hold
 * several groups, so mounting every EntityRow up-front stalls the first paint
 * (thousands of DOM nodes at once). Here we mount the first `GROUP_INITIAL_ROWS`
 * and reveal `GROUP_CHUNK_ROWS` more whenever a sentinel at the current tail
 * enters the viewport. This keeps the rendered DOM structure byte-for-byte
 * identical to the old direct map for whatever is currently mounted, so every
 * interaction (selection, inline editing, flow badges, collapse) is unchanged —
 * we only defer mounting rows the user hasn't scrolled to yet.
 */
function GroupItems({
  items, entityType, displayProperties, selectedItemId, onItemSelect,
  selectionActive, checkedIds, onToggleCheck,
  onPatch, pickerContext, canEdit, onComposeChange,
}: {
  items: Record<string, unknown>[]
  entityType: ViewEntityType
  displayProperties: string[]
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  onPatch?: PatchItemFn
  pickerContext?: PickerContext
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  /** See `GroupSection` — one stable identity for the whole list. */
  onComposeChange?: (itemId: string, composing: boolean) => void
}) {
  const [visibleCount, setVisibleCount] = React.useState(() =>
    Math.min(items.length, GROUP_INITIAL_ROWS),
  )

  // Keep the visible window in sync when the item set changes (e.g. a realtime
  // refetch shrinks/grows the group). Never mount fewer than the initial chunk,
  // and never claim to show more rows than exist. When the set GROWS, widen the
  // window by the same delta: refetches replace the array in fresh server order,
  // so rows inserted above the fold would otherwise push an already-mounted row
  // past the count-based window and silently unmount it. Growing by the delta
  // keeps every previously-mounted index covered wherever the insertions landed.
  const prevItemCountRef = React.useRef(items.length)
  React.useEffect(() => {
    const growth = Math.max(0, items.length - prevItemCountRef.current)
    prevItemCountRef.current = items.length
    setVisibleCount(prev => Math.min(items.length, Math.max(prev + growth, GROUP_INITIAL_ROWS)))
  }, [items.length])

  const hasMore = visibleCount < items.length
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setVisibleCount(prev => Math.min(items.length, prev + GROUP_CHUNK_ROWS))
        }
      },
      // Pre-load the next chunk slightly before the sentinel is on screen so the
      // reveal feels seamless while scrolling.
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, items.length])

  return (
    <>
      {items.slice(0, visibleCount).map(item => (
        <EntityRow
          key={item.id as string}
          item={item}
          entityType={entityType}
          displayProperties={displayProperties}
          isSelected={selectedItemId === (item.id as string)}
          onItemSelect={onItemSelect}
          isChecked={checkedIds?.has(item.id as string)}
          selectionActive={selectionActive}
          onToggleCheck={onToggleCheck}
          onPatch={onPatch}
          pickerContext={pickerContext}
          canEdit={canEdit}
          onComposeChange={onComposeChange}
        />
      ))}
      {hasMore && <div ref={sentinelRef} aria-hidden className="h-1" />}
    </>
  )
}

// ── Empty state ────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="py-16 text-center text-sm text-muted-foreground">
      No items match this view.
    </div>
  )
}
