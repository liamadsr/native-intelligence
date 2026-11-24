/**
 * A folder's rows for the shared views list (Folders, docs/plans/views-everywhere.md):
 * its subfolders and the records filed in it, as rows of the view-only kind
 * `drive_item`, and the view (filters, sort, grouping, search) applied to them
 * on the page, since they come from the folder routes, not the query route.
 *
 * A row's id is `<type>:<id>` (`folder:<id>` for a subfolder), unique across
 * kinds, so the list's keyboard and selection hold one row each.
 *
 * Client-safe and pure.
 */
import type { GroupedResults, SortConfig, ViewFilter } from '@/lib/views/types'
import { defaultOrdering } from '@/lib/views/types'
import { filterLocalRows, groupLocalRows, sortLocalRows } from '@/lib/views/local-rows'
import { FOLDER_ITEM_LABEL, type DriveFolder, type FolderItem, type FolderItemType } from './folders'

export type DriveItemType = 'folder' | FolderItemType

export interface DriveItemRow {
  [key: string]: unknown
  /** `<type>:<id>`. */
  id: string
  item_type: DriveItemType
  /** The folder's or the record's own id. */
  record_id: string
  title: string
  updated_at: string | null
  filed_at: string | null
  folder?: DriveFolder
  item?: FolderItem
}

const DATE_FIELDS: ReadonlySet<string> = new Set(['updated_at', 'filed_at'])

export const DRIVE_ITEM_LABEL: Record<DriveItemType, string> = { folder: 'Folder', ...FOLDER_ITEM_LABEL }
const TYPE_ORDER: readonly DriveItemType[] = ['folder', 'document', 'data_table', 'spreadsheet', 'canvas', 'attachment']

export const driveRowId = (type: DriveItemType, id: string) => `${type}:${id}`

/** The open folder's rows (the top level: the top folders only). */
export function toDriveRows(subfolders: readonly DriveFolder[], items: readonly FolderItem[]): DriveItemRow[] {
  return [
    ...subfolders.map((f) => ({ id: driveRowId('folder', f.id), item_type: 'folder' as const, record_id: f.id, title: f.name, updated_at: f.updated_at, filed_at: null, folder: f })),
    ...items.map((it) => ({ id: driveRowId(it.type, it.id), item_type: it.type, record_id: it.id, title: it.title, updated_at: it.updated_at, filed_at: it.filed_at, item: it })),
  ]
}

/** The view applied: search (the name), filters, sort (subfolders first), then the grouping or the flat list. */
export function selectDriveRows(
  rows: readonly DriveItemRow[],
  config: { filters: readonly ViewFilter[]; ordering: readonly SortConfig[]; grouping: { field: string } | null },
  search = '',
  now = Date.now(),
): { data: Record<string, unknown>[] | GroupedResults[]; flat: DriveItemRow[] } {
  const q = search.trim().toLowerCase()
  const searched = q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows
  const flat = sortLocalRows(filterLocalRows(searched, config.filters, DATE_FIELDS, now), config.ordering, defaultOrdering('drive_item'), (r) => r.item_type === 'folder')
  const field = config.grouping?.field
  if (!field) return { data: flat, flat }
  return { data: groupLocalRows(flat, field, field === 'item_type' ? DRIVE_ITEM_LABEL : {}, field === 'item_type' ? TYPE_ORDER : undefined), flat }
}
