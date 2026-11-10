/**
 * "Make a task from this" (the entity actions menu): a new action linked to
 * the record it is about, as an `entity_link` (action → record, relation
 * 'about', the relation the app's own to-dos use: src/lib/payments/todo.ts).
 * POST /api/account/actions takes `about: { type, id }` and calls these.
 *
 * The record is fenced for the person BEFORE the task is made, through the
 * same check a mention gets (visibleMentionTargets: in this workspace and
 * readable by them: a private capture or document only its owner's, a
 * calendar event only its owner's, a team-chat message only if they can read
 * its channel), so a task can never point at a record they can't see, and a
 * refused one makes no task at all. Session client only: RLS holds too.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import { isMentionableType, type MentionRef } from '@/lib/entity-links/mentionable'
import { entityActionsDescriptor } from './entity-actions-registry'

export const TASK_ABOUT_RELATION = 'about'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The body's `about`: absent (null), a record a task can be about, or 'invalid'. */
export function parseTaskAbout(raw: unknown): MentionRef | null | 'invalid' {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return 'invalid'
  const { type, id } = raw as { type?: unknown; id?: unknown }
  if (!isMentionableType(type) || !entityActionsDescriptor(type)?.makeTask) return 'invalid'
  if (typeof id !== 'string' || !UUID.test(id)) return 'invalid'
  return { type, id: id.toLowerCase() }
}

/** May `userId` make a task about `ref` in `workspaceId` (it is there, and theirs to read)? Fails closed. */
export async function canMakeTaskAbout(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  ref: MentionRef,
): Promise<boolean> {
  try {
    return (await visibleMentionTargets(supabase, scope, [ref])).length === 1
  } catch {
    return false
  }
}

/** Link the new task to its record. False when the edge wasn't written (the task stands either way). */
export async function linkTaskAbout(
  supabase: SupabaseClient,
  input: { workspaceId: string; actionId: string; ref: MentionRef; memberId: string | null },
): Promise<boolean> {
  const { error } = await supabase.from('entity_link').upsert(
    {
      workspace_id: input.workspaceId,
      source_type: 'action',
      source_id: input.actionId,
      target_type: input.ref.type,
      target_id: input.ref.id,
      relation: TASK_ABOUT_RELATION,
      created_by: input.memberId,
    },
    { onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation', ignoreDuplicates: true },
  )
  if (error) console.warn('[actions] task about-link skipped:', error.message)
  return !error
}
