/**
 * A TEAMMATE @-MENTIONED IN A RECORD IS TOLD (docs/plans/mentions-everywhere.md,
 * decision 4): one in-app `mentioned` notification (migration 671), when the
 * mention is new. Records mention people as contacts
 * (`[@Maya Chen](mention://contact/<id>)`); a teammate is the contact linked
 * to their member row, so only those are told. Called by the surface's mention
 * sync with the contacts whose `mentions` edge that save just wrote, so an
 * autosave that changes nothing tells no one again.
 *
 * `notifyRecordMentions` is the one place this happens, for any target the
 * notifications allow (a document, an action, a project, an initiative, a
 * contact's notes, a capture). A target only some teammates can open (a private
 * document) carries a `gate`: a recipient who is not its creator is not told.
 * Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'

/** The target types a `mentioned` notification may point at (createNotification's allowed set). */
export type MentionNotificationTargetType = 'action' | 'capture' | 'document' | 'project' | 'contact' | 'initiative'

/** How a target is named when it has no title of its own. */
const DEFAULT_PHRASE: Record<MentionNotificationTargetType, string> = {
  action: 'a task',
  capture: 'a note',
  document: 'a document',
  project: 'a project',
  initiative: 'an initiative',
  contact: 'a note',
}

/** Tell each teammate (a mentioned contact linked to a member) that they were mentioned. Never throws. */
export async function notifyRecordMentions(
  supabase: SupabaseClient,
  input: {
    workspaceId: string
    authorMemberId: string
    target: { type: MentionNotificationTargetType; id: string; title: string | null }
    contactIds: readonly string[]
    /** For a target only some teammates can open (a private document): a recipient who is not its creator is not told. */
    gate?: { visibility: string | null; createdBy: string | null }
  },
): Promise<void> {
  try {
    if (input.contactIds.length === 0) return
    const [{ data: contacts }, { data: author }] = await Promise.all([
      supabase.from('contact').select('id, member_id').eq('workspace_id', input.workspaceId).in('id', [...input.contactIds]),
      supabase.from('member').select('display_name').eq('id', input.authorMemberId).eq('workspace_id', input.workspaceId).maybeSingle(),
    ])
    const actor = (author as { display_name?: string | null } | null)?.display_name || 'Someone'
    const members = new Set(
      ((contacts ?? []) as Array<{ member_id?: string | null }>).map((c) => c.member_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    const where = input.target.title?.trim() || DEFAULT_PHRASE[input.target.type]
    for (const recipientId of members) {
      if (recipientId === input.authorMemberId) continue
      if (input.gate && input.gate.visibility === 'private' && recipientId !== input.gate.createdBy) continue
      await createNotification({
        workspaceId: input.workspaceId,
        recipientId,
        type: 'mentioned',
        title: `${actor} mentioned you in ${where}`,
        actorId: input.authorMemberId,
        targetType: input.target.type,
        targetId: input.target.id,
      })
    }
  } catch (err) {
    console.warn('[mention-notify] notify threw:', err instanceof Error ? err.message : 'unknown')
  }
}

/**
 * The document case: read its title and visibility, then tell the teammates
 * newly mentioned. A private document tells no one but its creator.
 */
export async function notifyDocumentMentions(
  supabase: SupabaseClient,
  input: { workspaceId: string; documentId: string; authorMemberId: string; contactIds: readonly string[] },
): Promise<void> {
  try {
    const { data: doc } = await supabase
      .from('document')
      .select('title, visibility, created_by')
      .eq('id', input.documentId)
      .eq('workspace_id', input.workspaceId)
      .maybeSingle()
    if (!doc) return
    const d = doc as { title?: string | null; visibility?: string | null; created_by?: string | null }
    await notifyRecordMentions(supabase, {
      workspaceId: input.workspaceId,
      authorMemberId: input.authorMemberId,
      target: { type: 'document', id: input.documentId, title: d.title ?? null },
      contactIds: input.contactIds,
      gate: { visibility: d.visibility ?? null, createdBy: d.created_by ?? null },
    })
  } catch (err) {
    console.warn('[document-mentions] notify threw:', err instanceof Error ? err.message : 'unknown')
  }
}
