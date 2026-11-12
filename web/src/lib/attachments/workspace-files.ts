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
 * dropped, never shown as a placeholder.
 *
 * Left out: chat uploads (the person's own storage folder, no row nor record
 * until the agent attaches one, when it becomes an attachment here), and the
 * files in team chat messages (inside each message's row, fenced per channel:
 * no workspace-wide read of them is one indexed read).
 *
 * Flat cost, whatever the page: one read of attachments (by workspace_id,
 * idx_attachments_workspace, newest first, limit + 1 to know there is more),
 * then one label read per parent kind present (at most three).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import type { FileParentType, WorkspaceFile, WorkspaceFilesPage, WorkspaceFilesQuery } from './workspace-files-model'

const FILE_FIELDS =
  'id, workspace_id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path, thumbnail_path, note_id, action_id, project_id, created_at'

interface AttachmentRow {
  id: string
  workspace_id: string
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
  created_at: string
}

/** The record a file is attached to: its capture, else its action, else its project (an action's or capture's file carries its project too). */
export function fileParentOf(row: Pick<AttachmentRow, 'note_id' | 'action_id' | 'project_id'>): { type: FileParentType; id: string } | null {
  if (row.note_id) return { type: 'capture', id: row.note_id }
  if (row.action_id) return { type: 'action', id: row.action_id }
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
): Promise<WorkspaceFilesPage> {
  let read = supabase.from('attachments').select(FILE_FIELDS).eq('workspace_id', workspaceId)
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
    if (!parent) continue
    const ids = byType.get(parent.type) ?? new Set<string>()
    ids.add(parent.id)
    byType.set(parent.type, ids)
  }
  const labels = byType.size ? await resolveEntityLabels(supabase, workspaceId, byType) : new Map<string, string>()

  const files: WorkspaceFile[] = []
  for (const row of page) {
    const parent = fileParentOf(row)
    const label = parent ? labels.get(`${parent.type}:${parent.id}`) : undefined
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
      parent: { ...parent, label },
    })
  }
  return { files, next_offset: more ? query.offset + query.limit : null }
}
