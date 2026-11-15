import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { workspaceHasEventFlows } from './event-triggers'

type Send = (event: { name: string; id: string; ts?: number; data: Record<string, unknown> }) => Promise<unknown>

/** How long after a person adds a contact its loops run: long enough for them to have filled it in. */
export const CONTACT_CREATED_PERSON_DELAY_MS = 5 * 60 * 1000

/** Who made the contact. Only these two ever emit. */
export type ContactCreatedEmitSource = 'form' | 'person'

/**
 * Emit `flow/contact.created` for a contact just added to the CRM, once per
 * contact (the event id is keyed on it):
 *
 *   form     a public intake made it (upsertCustomerContact in
 *            src/lib/customers/contacts.ts, when it CREATED the contact: a
 *            website form, a quote, a customer's first text): delivered at once;
 *   person   a person added it by hand (the contacts route,
 *            src/app/api/account/contacts/route.ts): delivered
 *            CONTACT_CREATED_PERSON_DELAY_MS later (Inngest `ts`), so the run
 *            reads what they typed. flowDispatchOnContactCreated skips a
 *            contact deleted or merged by then.
 *
 * Nothing else emits: a contact an agent's create_contact, an import (CSV,
 * HubSpot, Stripe), a sync (email, calendar), a meeting's participants,
 * prospecting or a new member made never fires a loop (the loop guard). Ids
 * only. Never throws.
 */
export async function emitContactCreated(
  args: { workspaceId: string; contactId: string; source: ContactCreatedEmitSource; now?: number },
  deps: { send?: Send } = {},
): Promise<boolean> {
  const now = args.now ?? Date.now()
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))({
      name: 'flow/contact.created',
      id: `contact-created:${args.contactId}`,
      ...(args.source === 'person' ? { ts: now + CONTACT_CREATED_PERSON_DELAY_MS } : {}),
      data: { workspace_id: args.workspaceId, contact_id: args.contactId, source: args.source, created_at: new Date(now).toISOString() },
    })
    return true
  } catch (err) {
    console.error('[flows] contact created inngest.send failed', err instanceof Error ? err.message : 'unknown')
    return false
  }
}

/**
 * The two emitters' one entry: asks first whether the workspace has an
 * enabled contact_created loop at all, so a workspace with none sends nothing
 * per contact, then emits. `supabase` must read the flow table whoever the
 * caller is (the service role). Never throws: a contact is made whatever
 * happens here.
 */
export async function notifyContactCreated(
  supabase: SupabaseClient,
  args: { workspaceId: string; contactId: string; source: ContactCreatedEmitSource; now?: number },
  deps: { send?: Send; hasFlows?: typeof workspaceHasEventFlows } = {},
): Promise<boolean> {
  try {
    const has = await (deps.hasFlows ?? workspaceHasEventFlows)(supabase, { workspaceId: args.workspaceId, triggerType: 'contact_created' })
    if (!has) return false
    return await emitContactCreated(args, { send: deps.send })
  } catch (err) {
    console.error('[flows] contact created loop event not sent (non-fatal):', err instanceof Error ? err.message : 'unknown')
    return false
  }
}
