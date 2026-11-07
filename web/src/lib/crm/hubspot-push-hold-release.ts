/**
 * Releasing the HubSpot push HOLD (Sequence step 2, plan A.1) — the tier-2
 * gate for contacts an UNATTENDED run created.
 *
 * The hold (src/lib/crm/hubspot-push-hold.ts) keeps hubspot-push-contact and
 * the 15-minute sweep off the row. Releasing it is the person's explicit
 * approval: clear the marker and send the same fire-and-forget push the manual
 * create surfaces send (hubspot-push-contact owns every gate — opt-in flag,
 * scope, dedupe — and no-ops cleanly, so releasing in a workspace without
 * HubSpot is harmless). Two callers: POST /api/account/contacts/[id]/hubspot-hold
 * (the contact's own badge) and the run's review card, which calls that route
 * per contact. Runs on the caller's SESSION client: the SELECT is the
 * ownership check under RLS, and the UPDATE is fenced the same way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { hasHubspotPushHold, withoutHubspotPushHold } from './hubspot-push-hold'

export interface ReleasedContact {
  id: string
  full_name: string | null
  email: string | null
  metadata: Record<string, unknown>
}

export type ReleaseHoldResult =
  | { ok: true; released: true; pushed: boolean; contact: ReleasedContact }
  | { ok: true; released: false; reason: 'not_held'; contact: ReleasedContact }
  | { ok: false; status: 404 | 500; error: string }

export async function releaseHubspotPushHold(
  supabase: SupabaseClient,
  args: { contactId: string; workspaceId: string },
): Promise<ReleaseHoldResult> {
  const { data: contact, error } = await supabase
    .from('contact')
    .select('id, full_name, email, metadata')
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!contact) return { ok: false, status: 404, error: 'Contact not found' }

  const row = contact as { id: string; full_name: string | null; email: string | null; metadata: unknown }
  if (!hasHubspotPushHold(row.metadata)) {
    return {
      ok: true,
      released: false,
      reason: 'not_held',
      contact: { id: row.id, full_name: row.full_name, email: row.email, metadata: withoutHubspotPushHold(row.metadata) },
    }
  }

  const cleared = withoutHubspotPushHold(row.metadata)
  const { error: updateError } = await supabase
    .from('contact')
    .update({ metadata: cleared })
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
  if (updateError) return { ok: false, status: 500, error: updateError.message }

  // The push, exactly as the manual create surfaces send it. Fire-and-forget:
  // a failed send must never fail the release (the row is un-held either way,
  // and the sweep now picks it up).
  let pushed = false
  if (row.email) {
    pushed = true
    inngest
      .send({ name: 'crm/hubspot-push-contact', data: { contactId: row.id, workspaceId: args.workspaceId } })
      .catch((err) => {
        console.error('[hubspot-hold] hubspot-push-contact send failed', err)
      })
  }
  return {
    ok: true,
    released: true,
    pushed,
    contact: { id: row.id, full_name: row.full_name, email: row.email, metadata: cleared },
  }
}
