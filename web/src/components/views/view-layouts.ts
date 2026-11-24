/**
 * The layouts a views page can be drawn in, for the two places that switch
 * it: the header island's switcher (view-layout-switcher.tsx; Liam, 11-21:
 * "they're kinda hidden I want to move it to the header island") and the view
 * settings popover, for a list with no island of its own (a record's tab).
 */
import { CalendarDays, ChartGantt, Columns2, GalleryHorizontalEnd, LayoutGrid, List, Share2, Table2, type LucideIcon } from 'lucide-react'
import type { ViewEntityType, ViewLayout } from '@/lib/views/types'
import { supportsRoadmap } from '@/lib/views/roadmap'

export interface LayoutOption {
  value: ViewLayout
  label: string
  Icon: LucideIcon
}

const GRAPH: LayoutOption = { value: 'graph', label: 'Graph', Icon: Share2 }
const LIST: LayoutOption = { value: 'list', label: 'List', Icon: List }
const BOARD: LayoutOption = { value: 'board', label: 'Board', Icon: Columns2 }
const ROADMAP: LayoutOption = { value: 'roadmap', label: 'Roadmap', Icon: ChartGantt }

/** Kinds drawn as a list only. */
const LIST_ONLY: ReadonlySet<ViewEntityType> = new Set(['canvas', 'spreadsheet', 'data_table', 'drive_item', 'team', 'file', 'knowledge_package'])

/** A table's rows: four layouts of their own. */
const TABLE_LAYOUTS: LayoutOption[] = [
  { value: 'grid', label: 'Table', Icon: Table2 },
  { value: 'board', label: 'Board', Icon: LayoutGrid },
  { value: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { value: 'gallery', label: 'Gallery', Icon: GalleryHorizontalEnd },
]

/**
 * What `entityType` can be drawn as. The library (agents and skills) keeps
 * its one row layout: none. The graph only where the page draws one
 * (`graphAvailable`: Knowledge passes renderGraph), the roadmap only for the
 * kinds with dates to lay out (lib/views/roadmap.ts).
 */
export function layoutOptions(entityType: ViewEntityType, graphAvailable = false): LayoutOption[] {
  if (entityType === 'agent' || entityType === 'skill') return []
  if (entityType === 'data_row') return TABLE_LAYOUTS
  // The Drive kinds have no status to group a board by (docs/plans/views-everywhere.md): a list.
  if (LIST_ONLY.has(entityType)) return [LIST]
  return [...(graphAvailable ? [GRAPH] : []), LIST, BOARD, ...(supportsRoadmap(entityType) ? [ROADMAP] : [])]
}
