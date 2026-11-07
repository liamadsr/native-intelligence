'use client'

import { useCallback, useMemo, useState } from 'react'

export interface BulkSelectionState {
  /** Set of currently selected item IDs */
  selectedIds: Set<string>
  /** Whether any items are selected (convenience) */
  hasSelection: boolean
  /** Number of selected items */
  count: number
  /** Toggle a single item's selection */
  toggle: (id: string) => void
  /** Select a single item (additive) */
  select: (id: string) => void
  /** Deselect a single item */
  deselect: (id: string) => void
  /** Select all provided IDs */
  selectAll: (ids: string[]) => void
  /** Clear entire selection */
  clear: () => void
  /** Check if a specific item is selected */
  isSelected: (id: string) => boolean
}

export function useBulkSelection(): BulkSelectionState {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const select = useCallback((id: string) => {
    setSelectedIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const deselect = useCallback((id: string) => {
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids))
  }, [])

  const clear = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  return useMemo(() => ({
    selectedIds,
    hasSelection: selectedIds.size > 0,
    count: selectedIds.size,
    toggle,
    select,
    deselect,
    selectAll,
    clear,
    isSelected,
  }), [selectedIds, toggle, select, deselect, selectAll, clear, isSelected])
}
