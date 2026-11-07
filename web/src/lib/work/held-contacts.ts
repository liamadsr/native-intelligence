/**
 * The contacts a work item created that are still HELD from HubSpot
 * (Sequence step 2, plan A.1) — what the run's review card lists as needing
 * the person's approval. Read from the ledger's own relation: `work_touch`
 * rows `(work_item_id, entity_type 'contact', verb 'created')` written by the
 * create_contact tool call on an unattended run, joined to the contact rows
 * that still carry `metadata.hubspot_push_hold`. A released contact drops out
 * on the next load. Fail-soft: any read error is an empty list, never a
 * failed panel.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HUBSPOT_PUSH_HOLD_KEY, hasHubspotPushHold } from '@/lib/crm/hubspot-push-hold'

export interface HeldContact {
  id: string
  full_name: string
  email: string | null
  /** When the hold was stamped (the run's create). */
  held_at: string | null
}

const HELD_CONTACTS_MAX = 50

export async function loadHeldContacts(
  supabase: SupabaseClient,
  item: { id: string; workspace_id: string },
): Promise<HeldContact[]> {
  try {
    const { data: touches, error: touchError } = await supabase
      .from('work_touch')
      .select('entity_id')
      .eq('work_item_id', item.id)
      .eq('entity_type', 'contact')
      .eq('verb', 'created')
      .limit(HELD_CONTACTS_MAX * 4)
    if (touchError) throw new Error(touchError.message)
    const ids = [...new Set(((touches ?? []) as Array<{ entity_id: string }>).map((t) => t.entity_id))].slice(0, HELD_CONTACTS_MAX)
    if (ids.length === 0) return []

    const { data: contacts, error: contactError } = await supabase
      .from('contact')
      .select('id, full_name, email, metadata')
      .in('id', ids)
      .eq('workspace_id', item.workspace_id)
    if (contactError) throw new Error(contactError.message)

    const out: HeldContact[] = []
    for (const c of (contacts ?? []) as Array<{ id: string; full_name: string | null; email: string | null; metadata: unknown }>) {
      if (!hasHubspotPushHold(c.metadata)) continue
      const hold = (c.metadata as Record<string, unknown>)[HUBSPOT_PUSH_HOLD_KEY] as { at?: unknown } | null
      out.push({
        id: c.id,
        full_name: c.full_name ?? '',
        email: c.email ?? null,
        held_at: typeof hold?.at === 'string' ? hold.at : null,
      })
    }
    // Stable order: the ledger's creation order.
    const rank = new Map(ids.map((id, i) => [id, i]))
    out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    return out
  } catch (err) {
    console.warn('[work/held-contacts] load failed:', err instanceof Error ? err.message : err)
    return []
  }
}
