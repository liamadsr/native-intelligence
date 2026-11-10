/**
 * WHO MAY SET A RECORD'S CUSTOM FIELDS, asked before a write that RLS can't
 * cover (the agent's set_custom_fields runs on a service-role client, as MCP
 * and the eve tool routes do). Each kind keeps its OWN edit rule; nothing
 * here is new policy, it is each table's UPDATE rule restated for an explicit
 * user:
 *
 *   action, project  any member of the record's workspace (actions_update,
 *                    projects_update: is_workspace_member). The caller has
 *                    already resolved the record's workspace through their
 *                    membership (resolveEntityWorkspace).
 *   initiative       an owner or admin, or the initiative's owner (its
 *                    "Owner and admins can update initiatives" policy).
 *   document         the document EDIT rule (src/lib/documents/access.ts,
 *                    migration 359's can_edit_document): a private document
 *                    is its creator's alone, unless an EDIT grant (512)
 *                    shares it with the person; a view grant never edits.
 *   contact          contact_editable_by (498), contact_update's
 *                    can_edit_contact for this user: its creator, an owner or
 *                    admin, anyone when workspace-visible, an `edit` share. One
 *                    they can see but not edit (a teammate's team contact, a
 *                    view share, a view grant) is `forbidden`; one they can't
 *                    see, not found. An edit grant (512) edits.
 *   company          company_visible_to_ungranted (496), or an edit grant on
 *                    the company (512).
 *
 * `grants: false` (a guest's or a linked agent's turn, omitGrants): no grant
 * of the owner's edits anything.
 *
 * Every check fails CLOSED: a read error or anything but a yes refuses.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCompanyWritableTo, isContactVisibleTo, isContactWritableTo } from '@/lib/crm/contact-visibility'
import { documentUpdateRefusal, loadDocumentAccess } from '@/lib/documents/access'
import {
  customFieldForbidden,
  customFieldNotFound,
  customFieldTable,
  type CustomFieldRecordEntity,
} from '@/lib/crm/custom-fields'

export type CustomFieldWriteRefusal = { reason: 'not_found' | 'forbidden'; error: string }

/** Null when `userId` may set `id`'s fields in `workspaceId`; else why not. */
export async function customFieldWriteRefusal(
  db: SupabaseClient,
  userId: string,
  workspaceId: string,
  entity: CustomFieldRecordEntity,
  id: string,
  opts: { grants?: boolean } = {},
): Promise<CustomFieldWriteRefusal | null> {
  const grants = opts.grants !== false
  const notFound: CustomFieldWriteRefusal = { reason: 'not_found', error: customFieldNotFound(entity) }
  const forbidden: CustomFieldWriteRefusal = { reason: 'forbidden', error: customFieldForbidden(entity) }
  try {
    switch (entity) {
      case 'contact':
        if (await isContactWritableTo(db, id, userId, { grants })) return null
        return (await isContactVisibleTo(db, id, userId)) ? forbidden : notFound
      case 'company':
        return (await isCompanyWritableTo(db, id, userId, { grants })) ? null : notFound
      case 'document': {
        const { access, error } = await loadDocumentAccess(db, workspaceId, userId, id, { editGrants: grants })
        if (error || !access) return notFound
        const refusal = documentUpdateRefusal(access, { custom_fields: {} })
        return refusal ? { reason: 'forbidden', error: refusal } : null
      }
      case 'initiative': {
        const [memberRes, rowRes] = await Promise.all([
          db.from('member').select('id, role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle(),
          db.from(customFieldTable(entity)).select('id, owner_id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
        ])
        const member = memberRes.data as { id: string; role: string | null } | null
        const row = rowRes.data as { id: string; owner_id: string | null } | null
        if (memberRes.error || rowRes.error || !member || !row) return notFound
        if (member.role === 'owner' || member.role === 'admin') return null
        return row.owner_id != null && row.owner_id === member.id ? null : forbidden
      }
      case 'action':
      case 'project': {
        const [memberRes, rowRes] = await Promise.all([
          db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle(),
          db.from(customFieldTable(entity)).select('id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
        ])
        if (memberRes.error || rowRes.error || !memberRes.data || !rowRes.data) return notFound
        return null
      }
    }
  } catch {
    return notFound
  }
}
