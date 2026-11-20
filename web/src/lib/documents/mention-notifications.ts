/**
 * A TEAMMATE @-MENTIONED IN A DOCUMENT IS TOLD (docs/plans/mentions-everywhere.md,
 * decision 4): one in-app `mentioned` notification (migration 671), when the
 * mention is new. A document mentions people as contacts
 * (`[@Maya Chen](mention://contact/<id>)`); a teammate is the contact linked
 * to their member row, so only those are told. Called by the document's link
 * sync with the contacts whose `mentions` edge that save just wrote, so an
 * autosave that changes nothing tells no one again.
 *
 * A private document tells no one but its creator (as its comments do): the
 * teammate could not open it. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'

export async function notifyDocumentMentions(
  supabase: SupabaseClient,
  input: { workspaceId: string; documentId: string; authorMemberId: string; contactIds: readonly string[] },
): Promise<void> {
  try {
    const [{ data: contacts }, { data: doc }, { data: author }] = await Promise.all([
      supabase.from('contact').select('id, member_id').eq('workspace_id', input.workspaceId).in('id', [...input.contactIds]),
      supabase.from('document').select('title, visibility, created_by').eq('id', input.documentId).eq('workspace_id', input.workspaceId).maybeSingle(),
      supabase.from('member').select('display_name').eq('id', input.authorMemberId).eq('workspace_id', input.workspaceId).maybeSingle(),
    ])
    if (!doc) return
    const d = doc as { title?: string | null; visibility?: string | null; created_by?: string | null }
    const actor = (author as { display_name?: string | null } | null)?.display_name || 'Someone'
    const members = new Set(
      ((contacts ?? []) as Array<{ member_id?: string | null }>).map((c) => c.member_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    for (const recipientId of members) {
      if (recipientId === input.authorMemberId) continue
      if (d.visibility === 'private' && recipientId !== d.created_by) continue
      await createNotification({
        workspaceId: input.workspaceId,
        recipientId,
        type: 'mentioned',
        title: `${actor} mentioned you in ${d.title?.trim() || 'a document'}`,
        actorId: input.authorMemberId,
        targetType: 'document',
        targetId: input.documentId,
      })
    }
  } catch (err) {
    console.warn('[document-mentions] notify threw:', err instanceof Error ? err.message : 'unknown')
  }
}
