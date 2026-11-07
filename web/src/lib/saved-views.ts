import type { FilterConfig, SavedFilterView } from './campaign-types'

const STORAGE_KEY_PREFIX = 'admin_saved_views:'

function getStorageKey(campaignSlug: string): string {
  return `${STORAGE_KEY_PREFIX}${campaignSlug}`
}

export function loadViews(campaignSlug: string): SavedFilterView[] {
  try {
    const raw = localStorage.getItem(getStorageKey(campaignSlug))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveViews(campaignSlug: string, views: SavedFilterView[]): void {
  localStorage.setItem(getStorageKey(campaignSlug), JSON.stringify(views))
}

export function createView(
  campaignSlug: string,
  name: string,
  filters: FilterConfig,
): SavedFilterView {
  const views = loadViews(campaignSlug)
  const view: SavedFilterView = {
    id: crypto.randomUUID(),
    name,
    filters: { ...filters },
    isDefault: false,
    createdAt: new Date().toISOString(),
  }
  views.push(view)
  saveViews(campaignSlug, views)
  return view
}

export function deleteView(campaignSlug: string, viewId: string): void {
  const views = loadViews(campaignSlug).filter((v) => v.id !== viewId)
  saveViews(campaignSlug, views)
}

export function updateView(
  campaignSlug: string,
  viewId: string,
  updates: Partial<Pick<SavedFilterView, 'name' | 'filters' | 'isDefault'>>,
): void {
  const views = loadViews(campaignSlug)
  const idx = views.findIndex((v) => v.id === viewId)
  if (idx === -1) return
  if (updates.name !== undefined) views[idx].name = updates.name
  if (updates.filters !== undefined) views[idx].filters = { ...updates.filters }
  if (updates.isDefault !== undefined) views[idx].isDefault = updates.isDefault
  saveViews(campaignSlug, views)
}

export function setDefaultView(campaignSlug: string, viewId: string | null): void {
  const views = loadViews(campaignSlug)
  for (const v of views) {
    v.isDefault = v.id === viewId
  }
  saveViews(campaignSlug, views)
}

export function filtersEqual(a: FilterConfig, b: FilterConfig): boolean {
  return (
    a.tier === b.tier &&
    a.signedUpDays === b.signedUpDays &&
    a.lastSignInDays === b.lastSignInDays &&
    a.hasPurchase === b.hasPurchase &&
    a.campaignStatus === b.campaignStatus
  )
}
