'use client'

/**
 * A page's own verbs in the shared row's right-click menu (EntityRow), for a
 * view-only kind the entity actions registry doesn't know: Folders' Rename,
 * Move to… and Delete on a folder's row (docs/plans/views-everywhere.md). The
 * page provides a function of the row; EntityRow draws what it returns after
 * the registry's own items, in the same menu, never a lookalike of its own.
 */
import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

export interface RowMenuItem {
  key: string
  label: string
  icon?: LucideIcon
  /** A key the page answers itself on the focused row, shown beside the item. */
  shortcut?: string
  destructive?: boolean
  onSelect: () => void
}

export type RowMenuItemsOf = (item: Record<string, unknown>) => RowMenuItem[]

const RowMenuItemsContext = React.createContext<RowMenuItemsOf | null>(null)
export const RowMenuItemsProvider = RowMenuItemsContext.Provider

/** The page's verbs for rows under this provider, or null (most lists). */
export function useRowMenuItems(): RowMenuItemsOf | null {
  return React.useContext(RowMenuItemsContext)
}
