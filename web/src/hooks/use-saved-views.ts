'use client'

import { useState, useEffect, useCallback } from 'react'
import type { FilterConfig, SavedFilterView } from '@/lib/campaign-types'
import { DEFAULT_FILTERS } from '@/lib/campaign-types'
import {
  loadViews,
  createView,
  deleteView as deleteViewFromStorage,
  updateView,
  setDefaultView as setDefaultInStorage,
  filtersEqual,
} from '@/lib/saved-views'

export function useSavedViews(campaignSlug: string) {
  const [views, setViews] = useState<SavedFilterView[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Load from localStorage on mount (SSR-safe)
  useEffect(() => {
    const stored = loadViews(campaignSlug)
    setViews(stored)
    const defaultView = stored.find((v) => v.isDefault)
    if (defaultView) setActiveViewId(defaultView.id)
    setLoaded(true)
  }, [campaignSlug])

  const initialFilters: FilterConfig = (() => {
    if (!loaded) return DEFAULT_FILTERS
    const defaultView = views.find((v) => v.isDefault)
    return defaultView ? { ...defaultView.filters } : DEFAULT_FILTERS
  })()

  const saveCurrentView = useCallback(
    (name: string, filters: FilterConfig) => {
      const view = createView(campaignSlug, name, filters)
      setViews(loadViews(campaignSlug))
      setActiveViewId(view.id)
    },
    [campaignSlug],
  )

  const removeView = useCallback(
    (viewId: string) => {
      deleteViewFromStorage(campaignSlug, viewId)
      setViews(loadViews(campaignSlug))
      if (activeViewId === viewId) setActiveViewId(null)
    },
    [campaignSlug, activeViewId],
  )

  const renameView = useCallback(
    (viewId: string, name: string) => {
      updateView(campaignSlug, viewId, { name })
      setViews(loadViews(campaignSlug))
    },
    [campaignSlug],
  )

  const updateViewFilters = useCallback(
    (viewId: string, filters: FilterConfig) => {
      updateView(campaignSlug, viewId, { filters })
      setViews(loadViews(campaignSlug))
    },
    [campaignSlug],
  )

  const setDefault = useCallback(
    (viewId: string | null) => {
      setDefaultInStorage(campaignSlug, viewId)
      setViews(loadViews(campaignSlug))
    },
    [campaignSlug],
  )

  const selectView = useCallback(
    (viewId: string | null): FilterConfig => {
      setActiveViewId(viewId)
      if (!viewId) return DEFAULT_FILTERS
      const view = views.find((v) => v.id === viewId)
      return view ? { ...view.filters } : DEFAULT_FILTERS
    },
    [views],
  )

  // Find which view matches the current filters (if any)
  const findMatchingView = useCallback(
    (filters: FilterConfig): string | null => {
      const match = views.find((v) => filtersEqual(v.filters, filters))
      return match?.id ?? null
    },
    [views],
  )

  return {
    views,
    activeViewId,
    setActiveViewId,
    loaded,
    initialFilters,
    saveCurrentView,
    deleteView: removeView,
    renameView,
    updateViewFilters,
    setDefault,
    selectView,
    findMatchingView,
  }
}
