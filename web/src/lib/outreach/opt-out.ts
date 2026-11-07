/**
 * Opting out, beside the opt-out list (outreach_suppression, which the
 * sequence engine checks at enrollment and before every send): a contact
 * imported from Brevo arrives with a tag saying they unsubscribed there
 * (roadmap track G's importer: 'unsubscribed email', 'unsubscribed sms').
 * Outreach treats the tag as an opt-out on that channel: enrollment skips
 * them as suppressed, a campaign's audience leaves them out, and a review
 * request never goes to them on it. Pure; case-insensitive.
 */
export const UNSUBSCRIBED_EMAIL_TAG = 'unsubscribed email'
export const UNSUBSCRIBED_SMS_TAG = 'unsubscribed sms'

export type OutreachChannel = 'email' | 'sms'

/** True when the contact's tags opt them out of this channel. */
export function optedOutByTag(tags: unknown, channel: OutreachChannel): boolean {
  if (!Array.isArray(tags)) return false
  const wanted = channel === 'email' ? UNSUBSCRIBED_EMAIL_TAG : UNSUBSCRIBED_SMS_TAG
  return tags.some((t) => typeof t === 'string' && t.trim().toLowerCase() === wanted)
}
