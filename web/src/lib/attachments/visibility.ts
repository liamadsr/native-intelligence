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
 *
 * FAILS CLOSED: a failed read, no person, or a capture that can't be read is
 * "not visible". With no person (an unattended run) only what every member
 * reads: a file on no capture, or on a workspace capture.
 *
 * Flat cost: one read of the files, one of their captures, and one grant read
 * when a capture is someone else's private one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility } from '@/lib/ai/tools/_shared'
import { withGrantedIds } from '@/lib/entity-access/grants'

/** The columns the rule reads off a file row. */
export interface AttachmentFenceRow {
  id: string
  user_id: string | null
  note_id: string | null
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
  return rows.filter((r) => (userId && r.user_id === userId) || !r.note_id || readable.has(r.note_id))
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
    .select('id, user_id, note_id')
    .eq('workspace_id', scope.workspaceId)
    .in('id', wanted)
  if (error) {
    console.warn('[attachments] fence read failed:', error.message)
    return new Set()
  }
  const rows = (data ?? []) as AttachmentFenceRow[]
  return new Set((await filterVisibleAttachments(supabase, scope, rows)).map((r) => r.id))
}
