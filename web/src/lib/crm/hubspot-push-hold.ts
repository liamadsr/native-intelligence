/**
 * The HubSpot push HOLD marker (Sequence step 2, plan A.1).
 *
 * `create_contact` is an internal write on the workspace's own CRM, but the
 * contact-push writeback it triggers is an EXTERNAL side effect — and the
 * 15-minute retroactive sweep (hubspot-push-sweep) would push any un-linked
 * manual contact even when the creator sent no event. So an UNATTENDED run's
 * create stamps `contact.metadata.hubspot_push_hold`; the per-contact push
 * function and the sweep both skip a held row (the sweep on every fire, retry
 * or not). A person editing the contact (PATCH /api/account/contacts/[id]) is
 * the review that lifts the hold and sends the push. Leaf module on purpose:
 * the tools, the Inngest functions and the route all import it without pulling
 * the sync layer in.
 */
export const HUBSPOT_PUSH_HOLD_KEY = 'hubspot_push_hold'

export interface HubspotPushHold {
  at: string
  by: 'unattended'
}

export function hubspotPushHold(): HubspotPushHold {
  return { at: new Date().toISOString(), by: 'unattended' }
}

/** True when a contact's metadata carries the hold. */
export function hasHubspotPushHold(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>)[HUBSPOT_PUSH_HOLD_KEY] != null
}

/** The metadata without the hold (sibling keys preserved). */
export function withoutHubspotPushHold(metadata: unknown): Record<string, unknown> {
  const rest = { ...((metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>) }
  delete rest[HUBSPOT_PUSH_HOLD_KEY]
  return rest
}
