'use client'
// GEN-77: multi-select drag — drag item carries all checked IDs, not just the grabbed one.

import * as React from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { ViewEntityType, GroupedResults } from '@/lib/views/types'
import type { ViewConfig } from './hooks/use-view'
import { prefetchDetailOnHover } from './detail-prefetch'
import { FlowIndicator } from './flow-indicator'
import { flowsForStatusIds, type FlowStatusMap, type FlowRef } from './hooks/use-flow-status-ids'
import { statusIdsForGroup } from './group-status-ids'
import { ActionPlatformCell } from '@/components/tasks/action-platform-cell'
import { requestActionCompose } from '@/lib/tasks/compose-request-events'
import { RowWorkspaceBadge } from './workspace-badge'

const CARD_TYPE = 'BOARD_CARD'
const COLUMN_TYPE = 'BOARD_COLUMN'

/**
 * Resolve the enabled flows attached to a status group. A board column (keyed
 * `category::name`) merges every team's matching workflow_state, so we union
 * the flows across all of the column's member state ids.
 */
function flowsForGroup(group: GroupedResults, flowStatusIds?: FlowStatusMap): FlowRef[] {
  if (!flowStatusIds) return []
  return flowsForStatusIds(statusIdsForGroup(group), flowStatusIds)
}

interface ViewBoardProps {
  entityType: ViewEntityType
  data: Record<string, unknown>[] | GroupedResults[]
  loading: boolean
  config: ViewConfig
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  onMoveItem?: (itemIds: string[], fromGroup: string, toGroup: string) => void
  /** Called when the user drags a column to a new position (fromKey → toKey) */
  onReorderColumns?: (fromKey: string, toKey: string) => void
  /** Bulk selection state */
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  /** workflow_state id → enabled flows that fire on entry (⚡ column badge). */
  flowStatusIds?: FlowStatusMap
}

/** Carries the dragged card's ID plus all IDs that should move together (multi-select). */
interface DragCardItem { id: string; groupKey: string; ids: string[] }
interface DragColumnItem { key: string }

export function ViewBoard({
  entityType, data, loading, config, selectedItemId, onItemSelect, onMoveItem,
  onReorderColumns,
  selectionActive, checkedIds, onToggleCheck,
  flowStatusIds,
}: ViewBoardProps) {
  if (loading) {
    return (
      <div className="flex gap-4 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="w-72 space-y-2">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 3 }).map((_, j) => <Skeleton key={j} className="h-20 w-full" />)}
          </div>
        ))}
      </div>
    )
  }

  // Data must be grouped for board view
  const isGrouped = Array.isArray(data) && data.length > 0 && typeof (data[0] as GroupedResults).key === 'string'
  const groups = isGrouped ? (data as GroupedResults[]) : []

  if (groups.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Set a grouping to use board view.</div>
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <BoardInner
        groups={groups}
        entityType={entityType}
        selectedItemId={selectedItemId}
        onItemSelect={onItemSelect}
        onMoveItem={onMoveItem}
        onReorderColumns={onReorderColumns}
        selectionActive={selectionActive}
        checkedIds={checkedIds}
        onToggleCheck={onToggleCheck}
        flowStatusIds={flowStatusIds}
      />
    </DndProvider>
  )
}

/** Inner component so we can maintain local column-order state under DndProvider */
function BoardInner({
  groups,
  entityType,
  selectedItemId,
  onItemSelect,
  onMoveItem,
  onReorderColumns,
  selectionActive,
  checkedIds,
  onToggleCheck,
  flowStatusIds,
}: {
  groups: GroupedResults[]
  entityType: ViewEntityType
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  onMoveItem?: (itemIds: string[], fromGroup: string, toGroup: string) => void
  onReorderColumns?: (fromKey: string, toKey: string) => void
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  flowStatusIds?: FlowStatusMap
}) {
  // Track column order locally for optimistic reordering.
  // Only reset when the set of group keys changes (columns added / removed).
  const [columnKeys, setColumnKeys] = React.useState<string[]>(() => groups.map(g => g.key))
  // Track the previous group key set so we can diff without re-running the effect on columnKeys changes
  const prevGroupKeySetRef = React.useRef<Set<string>>(new Set(groups.map(g => g.key)))

  React.useEffect(() => {
    const incoming = groups.map(g => g.key)
    const incomingSet = new Set(incoming)
    const prevSet = prevGroupKeySetRef.current
    const hasNew = incoming.some(k => !prevSet.has(k))
    const hasRemoved = [...prevSet].some(k => !incomingSet.has(k))
    prevGroupKeySetRef.current = incomingSet
    if (hasNew || hasRemoved) {
      setColumnKeys(incoming)
    }
  }, [groups])

  // Build an ordered list of groups following the local column order
  const groupMap = React.useMemo(() => new Map(groups.map(g => [g.key, g])), [groups])
  const orderedGroups = React.useMemo(
    () => columnKeys.map(k => groupMap.get(k)).filter(Boolean) as GroupedResults[],
    [columnKeys, groupMap],
  )

  const handleColumnMove = React.useCallback((fromKey: string, toKey: string) => {
    setColumnKeys(prev => {
      const next = [...prev]
      const fromIdx = next.indexOf(fromKey)
      const toIdx = next.indexOf(toKey)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, fromKey)
      return next
    })
    onReorderColumns?.(fromKey, toKey)
  }, [onReorderColumns])

  const boardScrollRef = React.useRef<HTMLDivElement>(null)

  /**
   * Forward HORIZONTAL wheel intent to the board while the pointer is over a
   * column.
   *
   * Each column is its own `overflow-y-auto` scroller. The browser picks one
   * scroll target per wheel event, and over a column that target is the column
   * — which has nothing to scroll horizontally, so the deltaX is simply
   * dropped. The board only panned when the pointer happened to be over a gap
   * or the padding, where the parent IS the target: you had to hunt for empty
   * space between cards to move sideways.
   *
   * So we take the horizontal component ourselves — but ONLY when the gesture
   * is dominantly horizontal, which locks the axis. Without that check the
   * incidental deltaX in an ordinary vertical trackpad swipe slid the board
   * sideways while the user was just scrolling down a column.
   *
   * Only `preventDefault` when we actually consume horizontal movement, so a
   * vertical wheel is untouched (and, at the board's scroll extents, the
   * page/overscroll behaviour it would normally get is preserved).
   *
   * Registered NATIVELY rather than via React's `onWheel`: React attaches
   * wheel listeners as PASSIVE, where `preventDefault()` silently no-ops (and
   * warns). We need it non-passive to stop the default handling of the
   * horizontal component.
   */
  React.useEffect(() => {
    const el = boardScrollRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      if (e.deltaX === 0) return

      // Only pan when the gesture is genuinely HORIZONTAL. A trackpad swipe is
      // never perfectly axis-aligned — scrolling a column up and down carries a
      // few pixels of incidental deltaX, and acting on those made the whole
      // board drift sideways while the user was just reading down a column.
      // Requiring deltaX to dominate locks the axis: vertical stays vertical,
      // and a deliberate sideways swipe still pans.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return

      // Nothing to pan — let the event through rather than swallowing it.
      const maxScroll = el.scrollWidth - el.clientWidth
      if (maxScroll <= 0) return

      // At an edge and still pushing outward: don't preventDefault, or we'd eat
      // the browser's back/forward swipe gesture and the overscroll bounce.
      const atStart = el.scrollLeft <= 0 && e.deltaX < 0
      const atEnd = el.scrollLeft >= maxScroll - 1 && e.deltaX > 0
      if (atStart || atEnd) return

      el.scrollLeft += e.deltaX
      e.preventDefault()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={boardScrollRef}
      className="flex gap-4 p-4 overflow-x-auto flex-1 min-h-0 h-full scrollbar-hide-deep"
    >
      {orderedGroups.map(group => (
        <BoardColumn
          key={group.key}
          group={group}
          entityType={entityType}
          selectedItemId={selectedItemId}
          onItemSelect={onItemSelect}
          onMoveItem={onMoveItem}
          // Only enable column drag-reorder when a reorder handler was provided
          // (single-team boards). Omitting it on the cross-team My Actions board
          // makes the columns non-draggable — their order is fixed by category.
          onMoveColumn={onReorderColumns ? handleColumnMove : undefined}
          selectionActive={selectionActive}
          checkedIds={checkedIds}
          onToggleCheck={onToggleCheck}
          flows={flowsForGroup(group, flowStatusIds)}
        />
      ))}
    </div>
  )
}

function BoardColumn({
  group, entityType, selectedItemId, onItemSelect, onMoveItem, onMoveColumn,
  selectionActive, checkedIds, onToggleCheck, flows,
}: {
  group: GroupedResults
  entityType: ViewEntityType
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  onMoveItem?: (itemIds: string[], fromGroup: string, toGroup: string) => void
  onMoveColumn?: (fromKey: string, toKey: string) => void
  selectionActive?: boolean
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  flows?: FlowRef[]
}) {
  // The card area is both the react-dnd card drop target AND the column's own
  // vertical scroll container. We keep our own ref so the progressive-reveal
  // sentinel can observe intersections against it, then merge react-dnd's drop
  // ref into the same element via a callback ref below.
  const cardAreaRef = React.useRef<HTMLDivElement>(null)

  // Drop target for cards (attached to the card body area)
  const [{ isOver, canDrop }, cardDropRef] = useDrop<DragCardItem, void, { isOver: boolean; canDrop: boolean }>({
    accept: CARD_TYPE,
    drop: (dragItem) => {
      if (dragItem.groupKey !== group.key && onMoveItem) {
        // dragItem.ids contains all selected IDs when dragging a checked card,
        // or just [dragItem.id] for a single unselected card drag.
        onMoveItem(dragItem.ids, dragItem.groupKey, group.key)
      }
    },
    canDrop: (dragItem) => dragItem.groupKey !== group.key,
    collect: monitor => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() }),
  })

  // Column reordering is only available when onMoveColumn is provided (single-
  // team boards). On the cross-team My Actions board it's omitted, so the
  // column must not be draggable at all — we leave the drag/drop refs unattached
  // below rather than wiring up handlers that can't persist.
  const columnReorderEnabled = !!onMoveColumn

  // Drag source for column reordering (attached to the column header)
  const [{ isColumnDragging }, columnDragRef] = useDrag<DragColumnItem, void, { isColumnDragging: boolean }>({
    type: COLUMN_TYPE,
    item: { key: group.key },
    canDrag: columnReorderEnabled,
    collect: monitor => ({ isColumnDragging: monitor.isDragging() }),
  })

  // Drop target for columns (attached to the outer column container)
  const [{ isColumnOver }, columnDropRef] = useDrop<DragColumnItem, void, { isColumnOver: boolean }>({
    accept: COLUMN_TYPE,
    drop: (dragItem) => {
      if (dragItem.key !== group.key) {
        onMoveColumn?.(dragItem.key, group.key)
      }
    },
    canDrop: (dragItem) => columnReorderEnabled && dragItem.key !== group.key,
    collect: monitor => ({ isColumnOver: monitor.isOver() && monitor.canDrop() }),
  })

  // Merge react-dnd's card drop ref with our scroll-root ref onto one element.
  const setCardAreaRef = React.useCallback((el: HTMLDivElement | null) => {
    cardAreaRef.current = el
    ;(cardDropRef as unknown as (node: HTMLDivElement | null) => void)(el)
  }, [cardDropRef])

  return (
    // Outer container: drop target for column reordering
    <div
      ref={columnDropRef as unknown as React.Ref<HTMLDivElement>}
      className={cn(
        'flex flex-col w-72 min-w-72 min-h-0 max-h-full rounded-lg border bg-muted/30 transition-colors',
        isColumnDragging && 'opacity-50',
        isColumnOver && 'border-primary/70 bg-primary/10',
      )}
    >
      {/* Column header — drag handle for column reordering */}
      <div
        ref={columnDragRef as unknown as React.Ref<HTMLDivElement>}
        className={cn(
          'flex items-center justify-between px-3 py-2 border-b select-none',
          onMoveColumn ? 'cursor-grab active:cursor-grabbing' : '',
        )}
        title={onMoveColumn ? 'Drag to reorder column' : undefined}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{group.label}</span>
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">
            {group.items?.length ?? 0}
          </span>
          {flows && flows.length > 0 && <FlowIndicator flows={flows} />}
        </div>
      </div>
      {/* Card area — drop target for card moves AND the per-column scroll
          container. Passed to BoardCards as the IntersectionObserver root so
          the progressive-reveal sentinel fires against THIS column's scroll,
          not the (horizontally-scrolling) viewport. */}
      <div
        ref={setCardAreaRef}
        className={cn(
          'flex-1 overflow-y-auto p-2 pb-28 space-y-2 transition-colors',
          isOver && canDrop && 'bg-primary/5',
        )}
      >
        <BoardCards
          items={group.items || []}
          groupKey={group.key}
          entityType={entityType}
          selectedItemId={selectedItemId}
          onItemSelect={onItemSelect}
          checkedIds={checkedIds}
          selectionActive={selectionActive}
          onToggleCheck={onToggleCheck}
          scrollRootRef={cardAreaRef}
        />
        {(!group.items || group.items.length === 0) && (
          <div className="py-8 text-center text-xs text-muted-foreground">No items</div>
        )}
      </div>
    </div>
  )
}

// ── Progressive card rendering (per column) ────────────────

/** Cards mounted immediately; the rest reveal in chunks as the tail scrolls in. */
const COLUMN_INITIAL_CARDS = 60
const COLUMN_CHUNK_CARDS = 60

/**
 * Renders a column's cards with progressive mounting instead of one giant
 * synchronous `.map`. Grouped board views fetch up to 500 rows and a single
 * column can hold most of them, so mounting every BoardCard up-front stalls the
 * first paint. We mount the first `COLUMN_INITIAL_CARDS` and reveal
 * `COLUMN_CHUNK_CARDS` more whenever a sentinel at the current tail enters the
 * column's own scroll viewport. Mirrors GroupItems in view-list.tsx.
 *
 * Drop-at-end is unaffected: the react-dnd card drop target lives on the COLUMN
 * (cardDropRef), not on individual cards, and the move is driven by
 * dragItem.ids / dragItem.groupKey — so dropping onto a column with unmounted
 * tail cards still moves the dragged item(s) correctly.
 */
function BoardCards({
  items, groupKey, entityType, selectedItemId, onItemSelect,
  checkedIds, selectionActive, onToggleCheck, scrollRootRef,
}: {
  items: Record<string, unknown>[]
  groupKey: string
  entityType: ViewEntityType
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  checkedIds?: Set<string>
  selectionActive?: boolean
  onToggleCheck?: (id: string) => void
  scrollRootRef: React.RefObject<HTMLDivElement | null>
}) {
  const [visibleCount, setVisibleCount] = React.useState(() =>
    Math.min(items.length, COLUMN_INITIAL_CARDS),
  )

  // Keep the visible window in sync when the item set changes (e.g. a realtime
  // refetch, or an optimistic move adds/removes a card). Two distinct cases:
  //
  //   (A) PURE TAIL APPEND — an optimistic drag-drop. moveItemBetweenGroups
  //       (use-view.ts) appends the moved card(s) to the END of the target
  //       group's items array, leaving the existing items as an unchanged
  //       prefix. A count-delta-only widening (case B) would leave the appended
  //       card past the count-based window (e.g. a 100-card column widens 60→61,
  //       but the dropped card sits at index 100), so the drop appears to do
  //       nothing. Detect this by remembering the previous last item's id: if
  //       the array grew AND that id is still at its old index (prevLen-1), the
  //       old array is a prefix of the new one → mount the whole column so the
  //       appended card(s) are visible immediately. This matches the pre-
  //       windowing behavior exactly (card shows at the tail, then snaps to its
  //       sorted spot on the next refetch/echo). Cost is a one-time full mount
  //       of this column's tail — acceptable, and only on an actual drop.
  //
  //   (B) GENERAL ITEM-SET CHANGE — a refetch/echo replaces the array in server
  //       sort order (prefix changed), or the set shrank. Keep the growth-delta
  //       widening: widen by the added count so cards inserted above the fold
  //       don't push an already-mounted card past the window and silently
  //       unmount it (same rationale as GroupItems in view-list.tsx), but do NOT
  //       force a full mount — the reordered tail must stay windowed.
  const prevItemCountRef = React.useRef(items.length)
  const prevLastIdRef = React.useRef<string | undefined>(items[items.length - 1]?.id as string | undefined)
  React.useEffect(() => {
    const prevLen = prevItemCountRef.current
    const prevLastId = prevLastIdRef.current
    const growth = Math.max(0, items.length - prevLen)
    prevItemCountRef.current = items.length
    prevLastIdRef.current = items[items.length - 1]?.id as string | undefined

    // Case A: the array grew and the previous last id is still parked at its old
    // index (prevLen - 1) — a sufficient cheap proxy that the previous array is
    // an unchanged prefix, i.e. an optimistic tail-append. Covers multi-card
    // drops (several ids appended at once) with the same single check. prevLen>0
    // guard skips first render / growth-from-empty (nothing to preserve there;
    // the count clamp already mounts what fits).
    const isTailAppend =
      growth > 0 && prevLen > 0 && (items[prevLen - 1]?.id as string | undefined) === prevLastId
    if (isTailAppend) {
      setVisibleCount(items.length)
      return
    }

    // Case B: refetch / shrink — growth-delta widening only, tail stays windowed.
    setVisibleCount(prev => Math.min(items.length, Math.max(prev + growth, COLUMN_INITIAL_CARDS)))
  }, [items])

  const hasMore = visibleCount < items.length
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setVisibleCount(prev => Math.min(items.length, prev + COLUMN_CHUNK_CARDS))
        }
      },
      // Observe against the column's own vertical scroll container (not the
      // viewport, which scrolls horizontally). Pre-load the next chunk slightly
      // before the sentinel is on screen so the reveal feels seamless.
      { root: scrollRootRef.current, rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, items.length, scrollRootRef])

  return (
    <>
      {items.slice(0, visibleCount).map(item => (
        <BoardCard
          key={item.id as string}
          item={item}
          groupKey={groupKey}
          entityType={entityType}
          isSelected={selectedItemId === (item.id as string)}
          onItemSelect={onItemSelect}
          isChecked={checkedIds?.has(item.id as string)}
          checkedIds={checkedIds}
          selectionActive={selectionActive}
          onToggleCheck={onToggleCheck}
        />
      ))}
      {/* The windowing tail. `data-card-sentinel` names it explicitly: its tests
          used to find it as "the only aria-hidden node on the board", which was
          true until a decorative glyph appeared inside a card (the Native Intelligence mark is
          aria-hidden because the button around it carries the real label). A
          presentational attribute is not an identity. */}
      {hasMore && <div ref={sentinelRef} aria-hidden data-card-sentinel="" className="h-1" />}
    </>
  )
}

interface BoardCardProps {
  item: Record<string, unknown>
  groupKey: string
  entityType: ViewEntityType
  isSelected: boolean
  /**
   * Row activation. Must be referentially stable (the parent memoizes it) so
   * `React.memo` can skip re-rendering cards on unrelated parent updates — the
   * click/aux-click handlers are derived from it internally. Passing fresh
   * inline closures (the old `onClick`/`onAuxClick` props) would defeat the memo.
   */
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  isChecked?: boolean
  /** Full selection set — used to build the multi-item drag payload. */
  checkedIds?: Set<string>
  selectionActive?: boolean
  onToggleCheck?: (id: string) => void
}

function boardCardTitle(item: Record<string, unknown>): string {
  if (!item.title && !item.full_name && !item.name && typeof item.from_email === 'string') return `Email from ${item.from_email}`
  return (item.title || item.subject || item.full_name || item.name || 'Untitled') as string
}

function BoardCardImpl({
  item, groupKey, entityType, isSelected, onItemSelect,
  isChecked, checkedIds, selectionActive, onToggleCheck,
}: BoardCardProps) {
  // The drag `item()` factory runs at drag-BEGIN time and must read the live
  // `item` + `checkedIds` (multi-select). We route those through refs updated
  // on every render so the factory always sees fresh values WITHOUT `checkedIds`
  // being a dependency of useDrag — keeping the drag config (and this card)
  // referentially stable so `React.memo` below actually bails on unrelated
  // parent re-renders. Refs don't invalidate memo; props flowing into them do
  // the comparison. (checkedIds identity changes on selection, which is exactly
  // when we DO want a re-render, so memo still lets those through.)
  const itemRef = React.useRef(item)
  itemRef.current = item
  const checkedIdsRef = React.useRef(checkedIds)
  checkedIdsRef.current = checkedIds

  const [{ isDragging }, dragRef] = useDrag<DragCardItem, void, { isDragging: boolean }>({
    type: CARD_TYPE,
    // Factory function so we capture the live checkedIds at drag-begin time.
    // If the dragged card is part of a multi-selection, include all selected
    // IDs so the drop handler can move them all at once.
    item: () => {
      const id = itemRef.current.id as string
      const checked = checkedIdsRef.current
      const ids = (checked?.size && checked.has(id))
        ? Array.from(checked)
        : [id]
      return { id, groupKey, ids }
    },
    collect: monitor => ({ isDragging: monitor.isDragging() }),
  })

  const title = boardCardTitle(item)
  const identifier = item.identifier as string | undefined
  const itemId = item.id as string
  const showCheckbox = selectionActive || isChecked

  // Derive click handlers from the stable `onItemSelect` + this card's stable
  // identity, so they don't change across parent re-renders (memo stays live).
  const onClick = React.useCallback(
    (e: React.MouseEvent) => onItemSelect(itemRef.current.id as string, boardCardTitle(itemRef.current), e, itemRef.current),
    [onItemSelect],
  )
  const onAuxClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        onItemSelect(itemRef.current.id as string, boardCardTitle(itemRef.current), e, itemRef.current)
      }
    },
    [onItemSelect],
  )

  return (
    <div
      ref={dragRef as unknown as React.Ref<HTMLDivElement>}
      onClick={onClick}
      onAuxClick={onAuxClick}
      // Warm the detail-panel cache so clicking through feels instant
      // (deduped + cached inside).
      onMouseEnter={() => prefetchDetailOnHover(entityType, item)}
      className={cn(
        // select-none: the card is an HTML5 drag source — without it, dragging
        // selects the title text and composes a text-drag alongside the card.
        'group/card select-none rounded-md border bg-background p-3 cursor-grab active:cursor-grabbing shadow-sm transition-all',
        isDragging && 'opacity-50',
        isSelected && 'ring-1 ring-foreground/30',
        isChecked && 'ring-1 ring-foreground/20 bg-primary/5',
      )}
    >
      {/* Header: checkbox + identifier */}
      <div className="flex items-center gap-1.5 mb-1">
        <div
          className={cn(
            'shrink-0 flex items-center justify-center w-4 h-4',
            showCheckbox ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100',
          )}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCheck?.(itemId)
          }}
        >
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => onToggleCheck?.(itemId)}
            className="h-3.5 w-3.5 cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        {/* The platform mark, between the checkbox and the identifier. The
            WHOLE CARD is the drag source (`ref={dragRef}` above), so this must
            not swallow the gesture that starts a drag — ActionPlatformIcon
            stops propagation on pointer-down as well as click, which is the
            same belt-and-braces the checkbox one element back already uses.
            Links ride in on the row payload, so no card fetches anything.

            NO `onCompose` HERE, deliberately — this is the one surface with no
            room for the strip (see compose-request-events.ts for the width
            arithmetic). Picking a provider relocates compose to the detail
            panel's properties sidebar instead, with the same fields and the
            same prefill. The alternative was a scroller narrower than one of
            its own fields.

            ROUTING IS TWO STEPS, and this card owns BOTH. Announcing the
            request is not opening anything: the panel that will host the form
            is the one this click has to MOUNT, via the same `onItemSelect` the
            card's own body uses. Publishing first and selecting second is
            deliberate — the request is latched at module scope before the
            select can mount a panel, so the panel finds it waiting on mount
            (see compose-request-events.ts). Doing it the other way round would
            work only for a panel that happened to be open already. */}
        {entityType === 'action' && (
          <ActionPlatformCell
            item={item}
            onComposeStart={(provider) => {
              if (!provider) return
              const current = itemRef.current
              const composeTitle = boardCardTitle(current)
              requestActionCompose({
                actionId: current.id as string,
                title: composeTitle,
                provider,
              })
              // No MouseEvent: this is not a modified click, so it must never
              // take the open-in-background/new-tab branch `goForItem` runs for
              // meta/ctrl. The form has to be on screen for the user who asked.
              onItemSelect(current.id as string, composeTitle, undefined, current)
            }}
          />
        )}
        {identifier && <span className="text-[10px] text-muted-foreground font-mono">{identifier}</span>}
        {/* Which workspace this card is from — the same component the list row
            uses, and equally invisible unless the card is foreign. In the
            header rather than under the title because a board COLUMN in
            personal scope is a merged category ("In Progress" from every
            workspace at once), so the per-card answer is the only place the
            distinction can live. `ml-auto` parks it at the right edge, clear of
            the identifier. */}
        <RowWorkspaceBadge item={item} className="ml-auto" />
      </div>
      <div className="text-sm font-medium line-clamp-2">{title}</div>
    </div>
  )
}

/**
 * Memoized so an unrelated parent re-render (e.g. a realtime UPDATE that swaps
 * the grouped-data array reference, or a sibling column's optimistic move) only
 * re-renders the cards whose props actually changed — not every card a large
 * column can mount. Relies on every prop being referentially stable per card:
 * the callers pass memoized handlers, the card derives its own click handlers
 * from the stable `onItemSelect`, and the drag `item()` factory reads live state
 * through refs rather than closing over invalidating props. Default shallow
 * comparison is correct here — `item`/`checkedIds`/`isChecked`/`isSelected` all
 * change by reference exactly when the card should re-render.
 */
const BoardCard = React.memo(BoardCardImpl)
