/**
 * The Files page's read (Liam, 11-11: "a new page that shows all available
 * files that were uploaded anywhere in the app, uploaded to captures or action
 * items or projects"): every attachment in the workspace the viewer may see,
 * newest first, a page at a time. The one reader behind GET
 * /api/account/files (./workspace-files-model.ts has its shapes).
 *
 * SESSION CLIENT ONLY. The attachments table's own RLS
 * (attachments_workspace_select, migration 493) already lets a file through
 * only for a member, and a capture's file only when its capture is readable
 * (shared, the viewer's own, or granted); attachments_user_select also shows
 * an uploader their own uploads. This file fences again, the way
 * lib/entities/feed.ts does, so the page never rests on one rule alone: every
 * file's record (the capture, action or project it is attached to) is
 * labelled through the viewer's own RLS (resolveEntityLabels), and a file
 * whose record they can't read (another member's private capture, one made
 * private after they uploaded to it) or that is gone has no label and is
 * dropped, never shown as a placeholder. A file on a table's row (663: a
 * form's upload) is labelled by the row's name and its table's, both read
 * through the viewer's RLS (data_row and data_table follow the table's
 * access), so it is dropped when they can't read the table.
 *
 * Left out: chat uploads (the person's own storage folder, no row nor record
 * until the agent attaches one, when it becomes an attachment here), and the
 * files in team chat messages (inside each message's row, fenced per channel:
 * no workspace-wide read of them is one indexed read).
 *
 * Flat cost, whatever the page: one read of attachments (by workspace_id,
 * idx_attachments_workspace, newest first, limit + 1 to know there is more),
 * then one label read per parent kind present (at most three), and for rows
 * one read of the rows and one of their tables.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import type { FileParentType, WorkspaceFile, WorkspaceFilesPage, WorkspaceFilesQuery } from './workspace-files-model'

const FILE_FIELDS =
  'id, workspace_id, user_id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path, thumbnail_path, note_id, action_id, project_id, data_row_id, from_form, drive_upload, created_at, updated_at'

interface AttachmentRow {
  id: string
  workspace_id: string
  user_id?: string | null
  drive_upload?: boolean | null
  updated_at?: string | null
  file_name: string
  file_size_bytes: number | null
  mime_type: string | null
  file_extension: string | null
  file_category: string | null
  storage_path: string | null
  thumbnail_path: string | null
  note_id: string | null
  action_id: string | null
  project_id: string | null
  data_row_id?: string | null
  from_form?: boolean | null
  created_at: string
}

/** The record a file is attached to: its capture, else its action, else its table row, else its project (an action's or capture's file carries its project too). */
export function fileParentOf(row: Pick<AttachmentRow, 'note_id' | 'action_id' | 'project_id' | 'data_row_id'> & { id?: string; drive_upload?: boolean | null }): { type: FileParentType; id: string } | null {
  // A Drive upload (696) hangs off no record: it names itself.
  if (row.drive_upload && row.id) return { type: 'drive', id: row.id }
  if (row.note_id) return { type: 'capture', id: row.note_id }
  if (row.action_id) return { type: 'action', id: row.action_id }
  if (row.data_row_id) return { type: 'row', id: row.data_row_id }
  if (row.project_id) return { type: 'project', id: row.project_id }
  return null
}

/** `text` for an ilike pattern: its wildcards and escape taken literally. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** A page of the workspace's files the viewer may see (see the header). Throws on a failed read. */
export async function listWorkspaceFiles(
  supabase: SupabaseClient,
  workspaceId: string,
  query: WorkspaceFilesQuery,
  /** The caller, for `owner` (My files / Shared with me). */
  userId?: string,
): Promise<WorkspaceFilesPage> {
  let read = supabase.from('attachments').select(FILE_FIELDS).eq('workspace_id', workspaceId)
  if (query.owner === 'mine' && userId) read = read.eq('user_id', userId)
  if (query.owner === 'others' && userId) read = read.neq('user_id', userId)
  if (query.ids) read = read.in('id', [...query.ids])
  if (query.category) read = read.eq('file_category', query.category)
  if (query.q) read = read.ilike('file_name', `%${likeLiteral(query.q)}%`)
  const { data, error } = await read
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(query.offset, query.offset + query.limit)
  if (error) throw new Error(`files: ${error.message}`)

  const rows = ((data ?? []) as AttachmentRow[]).filter((r) => r.workspace_id === workspaceId)
  const more = (data ?? []).length > query.limit
  const page = rows.slice(0, query.limit)

  // The second fence: each file's record, labelled through the viewer's RLS.
  const byType = new Map<string, Set<string>>()
  for (const row of page) {
    const parent = fileParentOf(row)
    if (!parent || parent.type === 'row' || parent.type === 'drive') continue
    const ids = byType.get(parent.type) ?? new Set<string>()
    ids.add(parent.id)
    byType.set(parent.type, ids)
  }
  const labels = byType.size ? await resolveEntityLabels(supabase, workspaceId, byType) : new Map<string, string>()
  const onRows = await rowLabels(supabase, workspaceId, page.map((r) => r.data_row_id).filter((id): id is string => !!id))
  const folders = await driveFolders(supabase, workspaceId, page.filter((r) => r.drive_upload).map((r) => r.id))

  const files: WorkspaceFile[] = []
  for (const row of page) {
    const parent = fileParentOf(row)
    const onRow = parent?.type === 'row' ? onRows.get(parent.id) : undefined
    const folder = parent?.type === 'drive' ? folders.get(parent.id) : undefined
    // A Drive upload reached here through its own read rule (696): its label is its folder's, or Drive.
    const label = parent ? (parent.type === 'row' ? onRow?.label : parent.type === 'drive' ? (folder?.name ?? 'Drive') : labels.get(`${parent.type}:${parent.id}`)) : undefined
    if (!parent || !label) continue
    files.push({
      id: row.id,
      file_name: row.file_name,
      file_size_bytes: row.file_size_bytes,
      mime_type: row.mime_type,
      file_extension: row.file_extension,
      file_category: row.file_category,
      storage_path: row.storage_path,
      thumbnail_path: row.thumbnail_path,
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
      user_id: row.user_id ?? null,
      parent: { ...parent, label, ...(onRow ? { table: onRow.table } : {}), ...(folder ? { folder } : {}) },
      ...(row.from_form ? { from_form: true } : {}),
    })
  }
  return { files, next_offset: more ? query.offset + query.limit : null }
}

/**
 * The folder each Drive upload among `ids` is filed in, read through the
 * viewer's own RLS (folders are every non-guest member's, 690). A failed read
 * names none: the file is still listed, under Drive.
 */
async function driveFolders(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('drive_folder_item')
    .select('item_id, folder_id, drive_folder(id, name)')
    .eq('workspace_id', workspaceId)
    .eq('item_type', 'attachment')
    .in('item_id', ids)
  if (error) return out
  for (const r of (data ?? []) as Array<{ item_id: string; drive_folder: { id: string; name: string } | Array<{ id: string; name: string }> | null }>) {
    const f = Array.isArray(r.drive_folder) ? r.drive_folder[0] : r.drive_folder
    if (f) out.set(r.item_id, { id: f.id, name: f.name })
  }
  return out
}

/**
 * The rows among `ids` the viewer can read, each with its name ("Untitled"
 * when it has none) and its table's: both read through the viewer's own RLS,
 * so a row of a table they can't read has no label. A read that fails labels
 * none (the files are dropped, never shown unfenced).
 */
async function rowLabels(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, { label: string; table: { id: string; name: string } }>> {
  const out = new Map<string, { label: string; table: { id: string; name: string } }>()
  const wanted = [...new Set(ids)]
  if (!wanted.length) return out
  const { data: rows, error } = await supabase.from('data_row').select('id, title, table_id').eq('workspace_id', workspaceId).in('id', wanted)
  if (error || !rows?.length) return out
  const found = rows as Array<{ id: string; title: string | null; table_id: string }>
  const { data: tables, error: tableError } = await supabase
    .from('data_table')
    .select('id, name')
    .eq('workspace_id', workspaceId)
    .in('id', [...new Set(found.map((r) => r.table_id))])
  if (tableError) return out
  const names = new Map(((tables ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]))
  for (const r of found) {
    const name = names.get(r.table_id)
    if (name !== undefined) out.set(r.id, { label: r.title?.trim() || 'Untitled', table: { id: r.table_id, name } })
  }
  return out
}
