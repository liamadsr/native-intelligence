/**
 * Drive folders (migration 690; docs/plans/create-everything.md, "Drive
 * folders"): what a folder is, which records sit in one, and how a request
 * names them. Client-safe and pure.
 */

/**
 * The records a folder holds, by the kind drive_folder_item names them with.
 * 'attachment' is a Drive upload (709): a file dropped on Drive, filed only by
 * its uploader.
 */
export const FOLDER_ITEM_TYPES = ['document', 'data_table', 'spreadsheet', 'canvas', 'attachment'] as const
export type FolderItemType = (typeof FOLDER_ITEM_TYPES)[number]

export function isFolderItemType(v: unknown): v is FolderItemType {
  return typeof v === 'string' && (FOLDER_ITEM_TYPES as readonly string[]).includes(v)
}

/** What each kind is called in a folder's list. */
export const FOLDER_ITEM_LABEL: Record<FolderItemType, string> = {
  document: 'Doc',
  data_table: 'Table',
  spreadsheet: 'Spreadsheet',
  canvas: 'Canvas',
  attachment: 'File',
}

export const FOLDER_NAME_MAX = 200

/** A folder's name as stored (trimmed), or null when it would be refused. */
export function folderName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.trim()
  return name.length >= 1 && name.length <= FOLDER_NAME_MAX ? name : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

export interface DriveFolder {
  id: string
  name: string
  parent_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface FolderItem {
  type: FolderItemType
  id: string
  title: string
  updated_at: string | null
  /** When it was put in the folder. */
  filed_at: string
  /** A file's own facts (an 'attachment'): what the viewer needs to open it. */
  file?: { storage_path: string; mime_type: string | null; size: number | null; user_id: string | null }
}

/** The folders from the top to this one (itself last); empty when it isn't among them. */
export function folderPath(folders: readonly DriveFolder[], id: string | null): DriveFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path: DriveFolder[] = []
  const seen = new Set<string>()
  let at = id ? byId.get(id) : undefined
  while (at && !seen.has(at.id)) {
    seen.add(at.id)
    path.unshift(at)
    at = at.parent_id ? byId.get(at.parent_id) : undefined
  }
  return path
}

/** A folder's own subfolders (null: the top folders), by name. */
export function childFolders(folders: readonly DriveFolder[], parentId: string | null): DriveFolder[] {
  return folders.filter((f) => (f.parent_id ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name))
}

/** This folder and every folder under it: where it may not be moved. */
export function folderAndDescendants(folders: readonly DriveFolder[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
    }
  }
  return out
}
