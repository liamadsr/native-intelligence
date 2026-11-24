'use client'

/**
 * The Library's packages as the app's shared list (docs/plans/views-everywhere.md):
 * ViewList and EntityRow (the package mark, its name, its description, its
 * visibility, how many items are pinned, when it changed), J/K and the arrows
 * to move, Enter or O to open its panel. The view-only kind
 * `knowledge_package` draws them: the Library reads its own rows
 * (/api/account/knowledge-library), and no saved view is made of them.
 */
import * as React from 'react'
import { Eye } from 'lucide-react'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import { ViewList } from '@/components/views/view-list'
import { defaultConfig, type ViewConfig } from '@/components/views/hooks/use-view'
import { ListFocusProvider, listOwnsKeys, scrollListRowIntoView, stepListFocus } from '@/components/views/list-keyboard'
import { RowMenuItemsProvider, type RowMenuItemsOf } from '@/components/views/list/row-menu-items'

export interface PackageListRow {
  id: string
  name: string
  description: string | null
  visibility: 'personal' | 'team' | 'workspace'
  pinned_items: number
  updated_at: string
}

/** The fixed list config: the kind's default columns, newest change first, no grouping. */
export const PACKAGE_LIST_CONFIG: ViewConfig = defaultConfig('knowledge_package')

export function PackageList({
  packages,
  selectedId,
  onOpen,
}: {
  packages: PackageListRow[]
  selectedId: string | null
  onOpen: (row: PackageListRow) => void
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const ids = React.useMemo(() => packages.map((p) => p.id), [packages])
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  const liveFocusedId = focusedId && ids.includes(focusedId) ? focusedId : null
  const focusedRow = packages.find((p) => p.id === liveFocusedId) ?? null
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

  const menuItemsOf = React.useCallback<RowMenuItemsOf>(
    (item) => [{ key: 'open', label: 'Open', icon: Eye, onSelect: () => onOpen(item as unknown as PackageListRow) }],
    [onOpen],
  )
  const onItemSelect = React.useCallback(
    (id: string) => {
      setFocusedId(id)
      const row = packages.find((p) => p.id === id)
      if (row) onOpen(row)
    },
    [packages, onOpen],
  )

  return (
    <div ref={rootRef} data-list-keyboard-root="" data-library-packages="" className="relative isolate">
      <RowMenuItemsProvider value={menuItemsOf}>
        <ListFocusProvider value={liveFocusedId}>
          <ViewList
            entityType="knowledge_package"
            data={packages as unknown as Record<string, unknown>[]}
            loading={false}
            config={PACKAGE_LIST_CONFIG}
            selectedItemId={selectedId}
            onItemSelect={onItemSelect}
          />
        </ListFocusProvider>
      </RowMenuItemsProvider>
    </div>
  )
}
