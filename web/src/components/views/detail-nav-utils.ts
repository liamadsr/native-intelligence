/** Item tuple used for adjacent-item navigation in detail panels. */
export interface VisibleItem {
  id: string
  title: string
  item: Record<string, unknown>
}

/**
 * Given the ID of the currently-open item and the ordered list of all
 * visible items, return the previous and next items (or null when none).
 *
 * This is the core logic behind the prev/next navigation buttons in
 * detail panel breadcrumb headers.
 */
export function getAdjacentItems(
  currentId: string | null,
  items: VisibleItem[],
): { prevItem: VisibleItem | null; nextItem: VisibleItem | null } {
  if (!currentId || items.length === 0) {
    return { prevItem: null, nextItem: null }
  }
  const idx = items.findIndex((it) => it.id === currentId)
  if (idx === -1) {
    return { prevItem: null, nextItem: null }
  }
  return {
    prevItem: idx > 0 ? items[idx - 1] : null,
    nextItem: idx < items.length - 1 ? items[idx + 1] : null,
  }
}
