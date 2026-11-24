'use client'

/**
 * The library's agents or skills as the app's shared list (docs/plans/views-everywhere.md):
 * ViewList and EntityRow (each item's mark, its /command, its description,
 * Built-in or its visibility and author, how many added it), J/K and the
 * arrows to move, Enter or O to open. Its verbs sit in the row's right-click
 * (row-menu-items.tsx): Open, Add (from Discover), Edit, Delete. The toolbar
 * above is LibraryCollection's (saved views, filters, display).
 */
import * as React from 'react'
import { Download, Eye, Pencil, Trash2 } from 'lucide-react'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import { ViewList } from '@/components/views/view-list'
import type { ViewConfig } from '@/components/views/hooks/use-view'
import { ListFocusProvider, listOwnsKeys, scrollListRowIntoView, stepListFocus } from '@/components/views/list-keyboard'
import { RowMenuItemsProvider, type RowMenuItem, type RowMenuItemsOf } from '@/components/views/list/row-menu-items'
import type { LibraryCategory, LibraryRow, LibraryScope } from './library-types'

/** A library item with where it was listed from and whether it is the person's. */
export type LibraryListRow = LibraryRow & { library_scope: LibraryScope; is_mine: boolean }

/** What a row's right-click offers, as the old row's hover buttons did. */
export function libraryRowMenu(
  row: LibraryListRow,
  forking: string | null,
  act: { onView: (r: LibraryListRow) => void; onEdit: (r: LibraryListRow) => void; onFork: (r: LibraryListRow) => void; onDelete: (r: LibraryListRow) => void },
): RowMenuItem[] {
  const discover = row.library_scope === 'discover'
  const canManage = !row.is_system && (!discover || row.is_mine)
  return [
    { key: 'open', label: 'Open', icon: Eye, onSelect: () => act.onView(row) },
    ...(discover && !row.is_system && !row.is_mine
      ? [{ key: 'add', label: forking === row.id ? 'Adding…' : 'Add', icon: Download, onSelect: () => act.onFork(row) }]
      : []),
    ...(canManage
      ? [
          { key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => act.onEdit(row) },
          { key: 'delete', label: 'Delete', icon: Trash2, destructive: true, onSelect: () => act.onDelete(row) },
        ]
      : []),
  ]
}

export function LibraryList({
  category,
  config,
  rows,
  forking,
  onView,
  onEdit,
  onFork,
  onDelete,
}: {
  category: LibraryCategory
  config: ViewConfig
  rows: LibraryListRow[]
  forking: string | null
  onView: (row: LibraryListRow) => void
  onEdit: (row: LibraryListRow) => void
  onFork: (row: LibraryListRow) => void
  onDelete: (row: LibraryListRow) => void
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const ids = React.useMemo(() => rows.map((r) => r.id), [rows])
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  const liveFocusedId = focusedId && ids.includes(focusedId) ? focusedId : null
  const focusedRow = rows.find((r) => r.id === liveFocusedId) ?? null
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
      { ...onRow, key: 'Enter', handler: () => focusedRow && onView(focusedRow) },
      { ...onRow, key: 'o', handler: () => focusedRow && onView(focusedRow) },
    ]
  }, [ownsKeys, moveFocus, focusedRow, onView])
  useHotkeys(keys)

  const menuItemsOf = React.useCallback<RowMenuItemsOf>(
    (item) => libraryRowMenu(item as unknown as LibraryListRow, forking, { onView, onEdit, onFork, onDelete }),
    [forking, onView, onEdit, onFork, onDelete],
  )
  const onItemSelect = React.useCallback(
    (id: string) => {
      setFocusedId(id)
      const row = rows.find((r) => r.id === id)
      if (row) onView(row)
    },
    [rows, onView],
  )

  return (
    <div ref={rootRef} data-list-keyboard-root="" data-library-list={category} className="relative isolate h-full min-h-0">
      <RowMenuItemsProvider value={menuItemsOf}>
        <ListFocusProvider value={liveFocusedId}>
          <ViewList
            entityType={category}
            data={rows as unknown as Record<string, unknown>[]}
            loading={false}
            config={config}
            selectedItemId={null}
            onItemSelect={onItemSelect}
          />
        </ListFocusProvider>
      </RowMenuItemsProvider>
    </div>
  )
}
