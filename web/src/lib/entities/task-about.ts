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
 * Mail is the one kind a task may be about that no one can @-mention
 * (TASK_ABOUT_ONLY_TYPES): an email thread is fenced here on its own, as its
 * owner's alone (email_thread_index.user_id, in this workspace). The edge is
 * then hidden from every teammate who opens the task: entity_link's read
 * policy follows both ends (migrations 500/501, entity_visible_to answers
 * mail as its owner's), the agent's graph walks hide it (hiddenGraphRefs:
 * email_thread is a LINK_FENCED_KIND), and the activity log never records an
 * edge to mail (488/521's logged kinds leave it out), so no subject or
 * sender reaches them through it.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import type { MentionRef } from '@/lib/entity-links/mentionable'
import { entityActionsDescriptor, isTaskAboutType, type TaskAboutOnlyType } from './entity-actions-registry'

export const TASK_ABOUT_RELATION = 'about'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A record a task can be about: a mentionable one, or the person's own email thread. */
export type TaskAboutRef = MentionRef | { type: TaskAboutOnlyType; id: string }

/** The body's `about`: absent (null), a record a task can be about, or 'invalid'. */
export function parseTaskAbout(raw: unknown): TaskAboutRef | null | 'invalid' {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return 'invalid'
  const { type, id } = raw as { type?: unknown; id?: unknown }
  if (!isTaskAboutType(type) || !entityActionsDescriptor(type)?.makeTask) return 'invalid'
  if (typeof id !== 'string' || !UUID.test(id)) return 'invalid'
  return { type, id: id.toLowerCase() }
}

/** May `userId` make a task about `ref` in `workspaceId` (it is there, and theirs to read)? Fails closed. */
export async function canMakeTaskAbout(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  ref: TaskAboutRef,
): Promise<boolean> {
  try {
    if (ref.type === 'email_thread') return await ownsEmailThread(supabase, scope, ref.id)
    return (await visibleMentionTargets(supabase, scope, [ref])).length === 1
  } catch {
    return false
  }
}

/**
 * Is the email thread (its email_thread_index row) the person's own, in this
 * workspace? Mail is its owner's alone: a teammate is refused even where RLS
 * would not be asked (the check names the owner column itself).
 */
async function ownsEmailThread(
  supabase: SupabaseClient,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('email_thread_index')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return false
  return (data as { id?: unknown } | null)?.id === id
}

/** Link the new task to its record. False when the edge wasn't written (the task stands either way). */
export async function linkTaskAbout(
  supabase: SupabaseClient,
  input: { workspaceId: string; actionId: string; ref: TaskAboutRef; memberId: string | null },
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
