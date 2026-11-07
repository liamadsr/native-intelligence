import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { buildPersonCard, type PersonCardRow } from '@/lib/crm/person-card'

/** A merged contact's tombstone points at its survivor; followed this many times at most. */
const MAX_MERGE_HOPS = 3

const CARD_SELECT =
  'id, full_name, email, job_title, relationship_type, relationship_strength, notes, metadata, merged_into_contact_id, company:company_id(name)'

/**
 * GET /api/account/contacts/[id]/card
 *
 * A person's card for the live agent's HUD (lib/crm/person-card.ts): name,
 * role · company, relationship and one line of background, for a voice Voice
 * ID has linked to this contact. Read-only and light (one row, no
 * interactions, no mail), fetched once per contact per call.
 *
 * Workspace-fenced, merge tombstones followed to the surviving contact, and
 * fenced by contact visibility (contact_visible_to): a contact the caller
 * can't see is a 404, indistinguishable from a missing one.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id: requested } = await params

  let id = requested
  let row: (PersonCardRow & { merged_into_contact_id?: string | null }) | null = null
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const { data, error } = await supabase
      .from('contact')
      .select(CARD_SELECT)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) return serverError(error.message)
    const next = data as unknown as (PersonCardRow & { merged_into_contact_id?: string | null }) | null
    if (!next) return notFound('Contact not found')
    if (!next.merged_into_contact_id) {
      row = next
      break
    }
    id = next.merged_into_contact_id
  }
  if (!row) return notFound('Contact not found')

  const [visible] = await filterVisibleContacts(supabase, user.id, [row])
  if (!visible) return notFound('Contact not found')

  return NextResponse.json({ person: buildPersonCard(visible) })
}
