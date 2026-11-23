/**
 * Drive folders on the server (migration 690): reads and writes through the
 * caller's own Supabase client, so the database's row security and guards
 * decide (a private record shows to no one but who may open it; a record is
 * filed only by someone who can open it). Used by /api/account/folders.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { FOLDER_ITEM_TYPES, type DriveFolder, type FolderItem, type FolderItemType } from './folders'

const FOLDER_COLUMNS = 'id, name, parent_id, created_by, created_at, updated_at'

/** How each kind's row is read: its table, its title column, what hides an archived one, and any more columns. */
const SOURCES: Record<FolderItemType, { table: string; title: string; live: (q: any) => any; more?: string }> = {
  document: { table: 'document', title: 'title', live: (q) => q.neq('status', 'archived') },
  data_table: { table: 'data_table', title: 'name', live: (q) => q.is('archived_at', null) },
  spreadsheet: { table: 'spreadsheet', title: 'title', live: (q) => q.neq('status', 'archived') },
  canvas: { table: 'canvas', title: 'title', live: (q) => q.is('archived_at', null) },
  // A Drive upload (696); its own read rule decides who sees it.
  attachment: { table: 'attachments', title: 'file_name', live: (q) => q.eq('drive_upload', true), more: 'storage_path, mime_type, file_size_bytes, user_id' },
}

export async function listFolders(supabase: SupabaseClient, workspaceId: string): Promise<DriveFolder[]> {
  const { data, error } = await supabase.from('drive_folder').select(FOLDER_COLUMNS).eq('workspace_id', workspaceId).order('name').limit(2000)
  if (error) throw new Error(error.message)
  return (data ?? []) as DriveFolder[]
}

export async function getFolder(supabase: SupabaseClient, workspaceId: string, id: string): Promise<DriveFolder | null> {
  const { data, error } = await supabase.from('drive_folder').select(FOLDER_COLUMNS).eq('workspace_id', workspaceId).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as DriveFolder | null) ?? null
}

/** Read records of each kind by id, under the caller's row security (unreadable ones simply aren't there). */
async function readRecords(
  supabase: SupabaseClient,
  workspaceId: string,
  ids: Record<FolderItemType, string[]>,
  opts: { search?: string; limit?: number } = {},
): Promise<Array<Omit<FolderItem, 'filed_at'>>> {
  const out: Array<Omit<FolderItem, 'filed_at'>> = []
  await Promise.all(
    FOLDER_ITEM_TYPES.map(async (type) => {
      const want = ids[type]
      if (want && want.length === 0) return
      const src = SOURCES[type]
      let q = supabase.from(src.table).select(`id, ${src.title}, updated_at${src.more ? `, ${src.more}` : ''}`).eq('workspace_id', workspaceId)
      q = src.live(q)
      if (want) q = q.in('id', want)
      if (opts.search) q = q.ilike(src.title, `%${toIlikeSearchTerm(opts.search)}%`)
      q = q.order('updated_at', { ascending: false }).limit(opts.limit ?? 500)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        out.push({
          type,
          id: String(row.id),
          title: String(row[src.title] ?? '') || 'Untitled',
          updated_at: (row.updated_at as string | null) ?? null,
          ...(type === 'attachment'
            ? {
                file: {
                  storage_path: String(row.storage_path ?? ''),
                  mime_type: (row.mime_type as string | null) ?? null,
                  size: typeof row.file_size_bytes === 'number' ? row.file_size_bytes : null,
                  user_id: (row.user_id as string | null) ?? null,
                },
              }
            : {}),
        })
      }
    }),
  )
  return out
}

/** A folder's records, newest first: only those the caller can open. */
export async function folderItems(supabase: SupabaseClient, workspaceId: string, folderId: string): Promise<FolderItem[]> {
  const { data, error } = await supabase
    .from('drive_folder_item')
    .select('item_type, item_id, created_at')
    .eq('workspace_id', workspaceId)
    .eq('folder_id', folderId)
    .limit(2000)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ item_type: FolderItemType; item_id: string; created_at: string }>
  const ids = Object.fromEntries(FOLDER_ITEM_TYPES.map((t) => [t, rows.filter((r) => r.item_type === t).map((r) => r.item_id)])) as Record<FolderItemType, string[]>
  const filedAt = new Map(rows.map((r) => [`${r.item_type}:${r.item_id}`, r.created_at]))
  const records = await readRecords(supabase, workspaceId, ids)
  return records
    .map((r) => ({ ...r, filed_at: filedAt.get(`${r.type}:${r.id}`) ?? '' }))
    .sort((a, b) => (b.updated_at ?? b.filed_at).localeCompare(a.updated_at ?? a.filed_at))
}

/** Records the caller can open that sit in no folder yet (Add's picker), matching `search`. */
export async function unfiledRecords(supabase: SupabaseClient, workspaceId: string, search: string): Promise<Array<Omit<FolderItem, 'filed_at'>>> {
  const all = { document: undefined, data_table: undefined, spreadsheet: undefined, canvas: undefined, attachment: undefined } as unknown as Record<FolderItemType, string[]>
  const records = await readRecords(supabase, workspaceId, all, { search: search.trim() || undefined, limit: 50 })
  if (records.length === 0) return []
  const { data, error } = await supabase
    .from('drive_folder_item')
    .select('item_type, item_id')
    .eq('workspace_id', workspaceId)
    .in('item_id', records.map((r) => r.id))
  if (error) throw new Error(error.message)
  const filed = new Set(((data ?? []) as Array<{ item_type: string; item_id: string }>).map((r) => `${r.item_type}:${r.item_id}`))
  return records
    .filter((r) => !filed.has(`${r.type}:${r.id}`))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, 60)
}

/** A database refusal as the answer it deserves: the guard's (42501), a check's (23514), a duplicate (23505). */
export function folderRefusal(error: { code?: string; message?: string } | null | undefined): { status: number; message: string } {
  switch (error?.code) {
    case '42501':
      return { status: 403, message: error.message || 'Not allowed.' }
    case '23514':
      return { status: 400, message: error.message || 'Not a valid folder.' }
    case '23505':
      return { status: 409, message: 'It is already in a folder.' }
    case '23503':
      return { status: 400, message: 'No such folder.' }
    default:
      return { status: 500, message: error?.message || 'Something went wrong.' }
  }
}
