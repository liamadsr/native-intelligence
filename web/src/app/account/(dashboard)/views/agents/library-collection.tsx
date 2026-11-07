'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import { ViewToolbar } from '@/components/views/view-toolbar'
import { useView, useViewConfig } from '@/components/views/hooks/use-view'
import { itemsForScope, libraryScopeForFilters, selectLibraryViewItems, type LibrarySources } from './library-filter'
import type { LibraryCategory, LibraryRow, LibraryScope } from './library-types'

/** The library's existing rows and actions under the same saved-view controls
 * as Actions, Projects and Initiatives. Data stays on the library endpoints. */
export function LibraryCollection({ category, sources, search, onScopeChange, children }: {
  category: LibraryCategory
  sources: LibrarySources
  search: string
  onScopeChange: (scope: LibraryScope) => void
  children: (state: {
    scope: LibraryScope
    displayedItems: LibraryRow[]
    resolvingView: boolean
    scopeForItem: (item: LibraryRow) => LibraryScope
  }) => ReactNode
}) {
  const {
    views, activeViewId, activeView, setActiveViewId, loading,
    createView, updateView, duplicateView, deleteView,
  } = useView(category)
  const {
    config, updateConfig, resetConfig, isDirty, overrides, saveOverrides, discardOverrides,
  } = useViewConfig(activeView, category, updateView)
  const scope = activeViewId ? libraryScopeForFilters(config.filters) : config.library_scope ?? 'all'
  useEffect(() => onScopeChange(scope), [scope, onScopeChange])
  const displayedItems = useMemo(
    () => selectLibraryViewItems(sources, category, search, config.filters, config.ordering),
    [sources, category, search, config.filters, config.ordering],
  )
  const usableIds = useMemo(() => new Set(itemsForScope('all', sources).map(row => row.id)), [sources])

  return (
    <>
      <ViewToolbar
        entityType={category}
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
        onLibraryScopeChange={onScopeChange}
        isDirty={isDirty}
        overrides={overrides}
        onSaveDraft={saveOverrides}
        onDiscardDraft={discardOverrides}
      />
      {children({
        scope,
        displayedItems,
        resolvingView: Boolean(activeViewId && loading),
        // A combined custom view must keep public items' Add action, even
        // though it doesn't have a single Discover baseline selected.
        scopeForItem: item => scope === 'discover' || !usableIds.has(item.id) ? 'discover' : scope,
      })}
    </>
  )
}
