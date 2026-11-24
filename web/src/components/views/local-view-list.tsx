'use client'

/**
 * A views list over rows a page reads itself, for a view-only kind with no
 * query route behind it (docs/plans/views-everywhere.md): Teams' teams. The
 * shared parts, never lookalikes: ViewToolbar (saved views and their tabs,
 * filters, display settings), search (the card's header, or the toolbar's
 * right outside a card), ViewList and EntityRow, J/K and the arrows to move,
 * Enter or O to open, and the page's own verbs in the row's right-click menu
 * (row-menu-items.tsx). The view is applied to the rows here
 * (lib/views/local-rows.ts).
 *
 * Inside a page card it takes the card's options from the card's surface
 * (CardSurfaceContext), so its filters stay with the card, as every card list's do.
 */
import * as React from 'react'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import type { GroupedResults, ViewEntityType } from '@/lib/views/types'
import { defaultOrdering } from '@/lib/views/types'
import { filterLocalRows, groupLocalRows, sortLocalRows, type LocalRow } from '@/lib/views/local-rows'
import { CardHeaderSlot, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { CardSurfaceContext } from './unified-view-layout'
import { ViewToolbar } from './view-toolbar'
import { ViewList } from './view-list'
import { ExpandableSearch } from './expandable-search'
import { ENTITY_PLURAL } from './view-tabs'
import { useView, useViewConfig } from './hooks/use-view'
import { ListFocusProvider, listOwnsKeys, scrollListRowIntoView, stepListFocus } from './list-keyboard'
import { RowMenuItemsProvider, type RowMenuItemsOf } from './list/row-menu-items'

export interface LocalViewListProps<T extends LocalRow> {
  entityType: ViewEntityType
  rows: readonly T[]
  loading: boolean
  /** The fields read as dates by the filters. */
  dateFields: ReadonlySet<string>
  /** The fields search reads (lower-cased substring). */
  searchFields: readonly (keyof T & string)[]
  onOpen: (row: T) => void
  menuItemsOf?: RowMenuItemsOf
  /** Group labels by field and value (an enum's words). */
  groupLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Drawn in the list's place when there are no rows and no search. */
  empty?: React.ReactNode
}

const NO_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {}

export function LocalViewList<T extends LocalRow>({ entityType, rows, loading, dateFields, searchFields, onOpen, menuItemsOf, groupLabels = NO_LABELS, empty }: LocalViewListProps<T>) {
  const inCard = useCardHeaderSlots() !== null
  const surface = React.useContext(CardSurfaceContext)
  // The card's options for this list, once (CardConfigSource is read at mount).
  const [card] = React.useState(() => surface?.listOptions(entityType, entityType))
  const { views, activeViewId, activeView, setActiveViewId, createView, updateView, duplicateView, deleteView } = useView(entityType, undefined, undefined, { standalone: !!card })
  const { config, updateConfig, resetConfig, isDirty, overrides, saveOverrides, discardOverrides } = useViewConfig(activeView, entityType, updateView, false, undefined, 'workspace', card, card ? 'memory' : 'storage')

  const [search, setSearch] = React.useState(card?.search ?? '')
  const changeSearch = React.useCallback(
    (next: string) => {
      setSearch(next)
      card?.onSearchChange?.(next)
    },
    [card],
  )

  const { data, flat } = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const searched = q ? rows.filter((r) => searchFields.some((f) => String(r[f] ?? '').toLowerCase().includes(q))) : rows
    const sorted = sortLocalRows(filterLocalRows(searched, config.filters, dateFields), config.ordering, defaultOrdering(entityType))
    const field = config.grouping?.field
    const grouped: Record<string, unknown>[] | GroupedResults[] = field ? groupLocalRows(sorted, field, groupLabels[field] ?? {}) : sorted
    return { data: grouped, flat: sorted }
  }, [rows, search, searchFields, config.filters, config.ordering, config.grouping, dateFields, entityType, groupLabels])

  // ── The keyboard, as in every list (list-keyboard.tsx). ──
  const rootRef = React.useRef<HTMLDivElement>(null)
  const ids = React.useMemo(() => flat.map((r) => r.id), [flat])
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  const liveFocusedId = focusedId && ids.includes(focusedId) ? focusedId : null
  const focusedRow = flat.find((r) => r.id === liveFocusedId) ?? null
  const ownsKeys = React.useCallback((e: KeyboardEvent) => listOwnsKeys(rootRef.current, e), [])
  const moveFocus = React.useCallback(
    (step: number) => {
      const next = stepListFocus(ids, liveFocusedId, step)
      if (!next) return
      setFocusedId(next)
      requestAnimationFrame(() => scrollListRowIntoView(rootRef.current, next))
    },
    [ids, liveFocusedId],
  )
  const keys = React.useMemo<HotkeyDefinition[]>(() => {
    const base = { globalGuard: true, when: ownsKeys }
    const onRow = { ...base, disabled: !focusedRow }
    return [
      { ...base, key: 'j', handler: () => moveFocus(1) },
      { ...base, key: 'ArrowDown', handler: () => moveFocus(1) },
      { ...base, key: 'k', handler: () => moveFocus(-1) },
      { ...base, key: 'ArrowUp', handler: () => moveFocus(-1) },
      { ...onRow, key: 'Enter', handler: () => focusedRow && onOpen(focusedRow) },
      { ...onRow, key: 'o', handler: () => focusedRow && onOpen(focusedRow) },
    ]
  }, [ownsKeys, moveFocus, focusedRow, onOpen])
  useHotkeys(keys)

  const onItemSelect = React.useCallback(
    (id: string) => {
      setFocusedId(id)
      const row = flat.find((r) => r.id === id)
      if (row) onOpen(row)
    },
    [flat, onOpen],
  )

  const searchBox = <ExpandableSearch value={search} onChange={changeSearch} label={`Search ${ENTITY_PLURAL[entityType]}`} placeholder={`Search ${ENTITY_PLURAL[entityType]}…`} />

  return (
    <div ref={rootRef} data-list-keyboard-root="" data-local-view-list={entityType} className="relative isolate flex h-full min-h-0 flex-col">
      {inCard && <CardHeaderSlot side="right">{searchBox}</CardHeaderSlot>}
      <ViewToolbar
        embedded
        alignToContent
        compact={card?.compact}
        layoutInHeader={inCard}
        entityType={entityType}
        views={views}
        activeViewId={activeViewId}
        onViewChange={setActiveViewId}
        onCreateView={createView}
        onUpdateView={updateView}
        onDuplicateView={duplicateView}
        onDeleteView={deleteView}
        config={config}
        onConfigChange={updateConfig}
        onScopeReset={resetConfig}
        isDirty={isDirty}
        overrides={overrides}
        onSaveDraft={saveOverrides}
        onDiscardDraft={discardOverrides}
        actions={!inCard ? searchBox : undefined}
      />
      <div data-view-body="" className="relative min-h-0 flex-1 overflow-hidden">
        {!loading && rows.length === 0 && !search && empty ? (
          empty
        ) : (
          <RowMenuItemsProvider value={menuItemsOf ?? null}>
            <ListFocusProvider value={liveFocusedId}>
              <ViewList entityType={entityType} data={data} loading={loading} config={config} selectedItemId={null} onItemSelect={onItemSelect} />
            </ListFocusProvider>
          </RowMenuItemsProvider>
        )}
      </div>
    </div>
  )
}
