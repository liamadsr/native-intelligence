/**
 * WHO MAY READ AN UPLOADED FILE, for an explicit person: the attachments
 * table's read rule (RLS `attachments_workspace_select`, migration 493, and
 * entity_visible_to's attachment arm, 572), restated so a service-role client
 * holds it too. A file is readable by a member of its workspace (every caller
 * has checked that the person is one) when:
 *   - they uploaded it, or
 *   - it hangs off no capture (a task's or a project's file: every member's), or
 *   - its capture is one they may see: a workspace capture, their own, or one a
 *     grant opens to them (492). Never an eval capture's.
 * and, for a file on a table's row (migration 663: a form's upload), only
 * when they may read the row's table (data_table_visible_to, as the
 * restrictive attachments_row_select says), whoever uploaded it.
 *
 * FAILS CLOSED: a failed read, no person, or a capture that can't be read is
 * "not visible". With no person (an unattended run) only what every member
 * reads: a file on no capture, or on a workspace capture.
 *
 * Flat cost: one read of the files, one of their captures, and one grant read
 * when a capture is someone else's private one. A caller that didn't select
 * data_row_id costs one more indexed read of the files on no capture; a file
 * on a row, one read of the rows and one of their tables (visible_data_table_ids).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility } from '@/lib/ai/tools/_shared'
import { withGrantedIds } from '@/lib/entity-access/grants'

/** The columns the rule reads off a file row. */
export interface AttachmentFenceRow {
  id: string
  user_id: string | null
  note_id: string | null
  /** The table row it is on (663). Not selected by the caller: read here. */
  data_row_id?: string | null
}

const uniq = (ids: readonly (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]

/**
 * The rows among `rows` (files of `workspaceId`, already read) that `userId`
 * may read. A capture read that fails drops every file on a capture.
 */
export async function filterVisibleAttachments<T extends AttachmentFenceRow>(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string | null },
  rows: readonly T[],
): Promise<T[]> {
  const { workspaceId, userId } = scope
  const captureIds = uniq(rows.filter((r) => r.note_id && r.user_id !== userId).map((r) => r.note_id))
  let readable = new Set<string>()
  if (captureIds.length > 0) {
    const { data, error } = await applyCaptureVisibility(
      supabase.from('captures').select('id').eq('workspace_id', workspaceId).in('id', captureIds),
      userId,
    )
    if (!error) {
      const visible = ((data ?? []) as Array<{ id?: unknown }>).map((c) => c.id).filter((id): id is string => typeof id === 'string')
      readable = await withGrantedIds(supabase, { userId, workspaceId }, 'capture', captureIds, visible)
    } else {
      console.warn('[attachments] capture fence read failed:', error.message)
    }
  }
  const onRows = await rowFence(supabase, scope, rows)
  return rows.filter((r) => {
    const row = onRows.rowOf.get(r.id)
    if (row === HIDDEN) return false
    if (row && !onRows.visible.has(row)) return false
    return (userId && r.user_id === userId) || !r.note_id || readable.has(r.note_id)
  })
}

/** A file whose row could not be read: never shown. */
const HIDDEN = Symbol('hidden')

/**
 * The row each file on no capture is on (read here when the caller didn't
 * select it), and which of those rows' tables `userId` may read. A read that
 * fails hides the files it was about.
 */
async function rowFence(
  supabase: SupabaseClient,
  { workspaceId, userId }: { workspaceId: string; userId: string | null },
  rows: readonly AttachmentFenceRow[],
  grants = true,
): Promise<{ rowOf: Map<string, string | typeof HIDDEN | null>; visible: Set<string> }> {
  const rowOf = new Map<string, string | typeof HIDDEN | null>()
  for (const r of rows) if (r.data_row_id !== undefined) rowOf.set(r.id, r.data_row_id ?? null)
  const unknown = uniq(rows.filter((r) => r.data_row_id === undefined && !r.note_id).map((r) => r.id))
  if (unknown.length) {
    const { data, error } = await supabase.from('attachments').select('id, data_row_id').eq('workspace_id', workspaceId).in('id', unknown)
    if (error) {
      console.warn('[attachments] row fence read failed:', error.message)
      for (const id of unknown) rowOf.set(id, HIDDEN)
    } else {
      for (const r of (data ?? []) as Array<{ id?: unknown; data_row_id?: unknown }>) {
        if (typeof r.id === 'string') rowOf.set(r.id, typeof r.data_row_id === 'string' && r.data_row_id ? r.data_row_id : null)
      }
    }
  }
  const rowIds = uniq([...rowOf.values()].map((v) => (typeof v === 'string' ? v : null)))
  const visible = new Set<string>()
  if (!rowIds.length) return { rowOf, visible }
  // No person: a table's row is no one's to see on such a run (entity_visible_to's rule for data_row).
  if (!userId) return { rowOf, visible }
  const { data: found, error: rowError } = await supabase.from('data_row').select('id, table_id').eq('workspace_id', workspaceId).in('id', rowIds)
  if (rowError) {
    console.warn('[attachments] row read failed:', rowError.message)
    return { rowOf, visible }
  }
  const tableOf = new Map(((found ?? []) as Array<{ id: string; table_id: string }>).map((r) => [r.id, r.table_id]))
  const tableIds = uniq([...tableOf.values()])
  if (!tableIds.length) return { rowOf, visible }
  const { data: tables, error: tableError } = await supabase.rpc('visible_data_table_ids', { p_ids: tableIds, p_user_id: userId, p_grants: grants })
  if (tableError) {
    console.warn('[attachments] table fence read failed:', tableError.message)
    return { rowOf, visible }
  }
  const readableTables = new Set(Array.isArray(tables) ? (tables as unknown[]).filter((id): id is string => typeof id === 'string') : [])
  for (const [rowId, tableId] of tableOf) if (readableTables.has(tableId)) visible.add(rowId)
  return { rowOf, visible }
}

/** The ids among `ids` of files in `workspaceId` that `userId` may read (fails closed). */
export async function visibleAttachmentIds(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string | null },
  ids: readonly string[],
): Promise<Set<string>> {
  const wanted = uniq(ids)
  if (wanted.length === 0) return new Set()
  const { data, error } = await supabase
    .from('attachments')
    .select('id, user_id, note_id, data_row_id')
    .eq('workspace_id', scope.workspaceId)
    .in('id', wanted)
  if (error) {
    console.warn('[attachments] fence read failed:', error.message)
    return new Set()
  }
  const rows = (data ?? []) as AttachmentFenceRow[]
  return new Set((await filterVisibleAttachments(supabase, scope, rows)).map((r) => r.id))
}

/**
 * The row rule alone (see the header): the rows among `rows` that are on no
 * table row, or on a row of a table `userId` may read. For a reader that
 * fences captures its own way (the agent's attachment tools); `grants` false
 * on a guest's or a linked agent's turn (a table shared with the person is
 * not theirs). Fails closed.
 */
export async function filterRowAttachments<T extends Pick<AttachmentFenceRow, 'id' | 'note_id' | 'data_row_id'>>(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string | null },
  rows: readonly T[],
  opts: { grants?: boolean } = {},
): Promise<T[]> {
  const fence = await rowFence(supabase, scope, rows.map((r) => ({ id: r.id, user_id: null, note_id: r.note_id, data_row_id: r.data_row_id })), opts.grants !== false)
  return rows.filter((r) => {
    const row = fence.rowOf.get(r.id)
    return row !== HIDDEN && (!row || fence.visible.has(row))
  })
}
