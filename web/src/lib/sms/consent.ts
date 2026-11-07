/**
 * The SMS consent the person gives before Dial8 texts them (US 10DLC carrier
 * approval, docs/plans/text-and-calling.md decision 6). Client-safe: Settings
 * → Phone shows {@link SMS_CONSENT_TEXT} next to a required, unchecked
 * checkbox; POST /api/account/phone refuses a start without `consent: true`
 * and the current {@link SMS_CONSENT_VERSION}, and stores both (consented_at,
 * consent_version) on the verification row, which the verify step copies onto
 * user_phone (migration 411).
 *
 * Changing the words means a new version: the stored version says which
 * words the person agreed to.
 *
 * Since 2026-10-24 the words name the texts the agent starts when it needs
 * the person's OK too (Liam: "the agent should be able to text you whenever
 * it needs something, always. It's not something we ask permission for"), so
 * there is one opt-in, not a second switch: verifying a number on these words
 * turns alert texts on ({@link consentCoversAlerts}, phone-verification.ts).
 * Earlier sign-ups keep the replies-only words until they link again.
 *
 * Since 2026-11-01 the words also name what the router sends while the person
 * is away from the app (docs/plans/reach-follows-you.md, src/lib/reach/route.ts):
 * the agent's messages when it needs them or has something for them, the
 * morning summary, and that an urgent one may come at night. There is no cap
 * on the person's own texts any more (Liam, 2026-10-31), so the words say
 * "message frequency varies", never a number. There is no second switch for
 * them either (Liam, 2026-10-31: "I don't want this to be a setting, it should
 * just happen"): any linked phone that hasn't said STOP gets them
 * (src/lib/reach/dispatch.ts smsConsent).
 */

export const SMS_CONSENT_VERSION = '2026-11-01'

export const SMS_CONSENT_TEXT =
  "I agree to receive text messages from Dial8's AI assistant at this number: replies to my texts, and texts when it needs me or has something for me while I'm away from the app, including requests for my OK and a morning summary. " +
  'Urgent ones may come at night. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. ' +
  'See our Terms (https://dial8.ai/terms) and Privacy Policy (https://dial8.ai/privacy).'

/** The first version whose words cover alert texts (above). Versions are dates, so they compare as strings. */
export const SMS_CONSENT_ALERTS_FROM = '2026-10-24'

/** Whether a stored consent version's words cover the agent's "needs your OK" texts. */
export function consentCoversAlerts(version: string | null | undefined): boolean {
  return typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= SMS_CONSENT_ALERTS_FROM
}

/** The verification code text (exact copy for carrier review). */
export function verificationText(code: string): string {
  return `Dial8: Your code is ${code}. Reply STOP to opt out.`
}

/**
 * Signing up by text (src/lib/sms/signup.ts, migration 457): someone texts the
 * Dial8 number from a number nobody linked, and the code comes back with the
 * words they agree to. Replying with the code is the opt-in (mobile
 * originated, confirmed), and its version is stored on user_phone like the
 * Settings checkbox's. The words cover what {@link SMS_CONSENT_TEXT} does
 * (replies, and texts when the agent needs them or has something, the morning
 * summary included), so alert texts are on from the start
 * ({@link consentCoversAlerts}). Its own version: these are other words.
 */
export const SMS_TEXT_SIGNUP_CONSENT_VERSION = '2026-11-02'

/** The sign-up code text (exact copy for carrier review). */
export function signupCodeText(code: string): string {
  return (
    `Dial8: Your code is ${code}. Reply with it to create your Dial8 account and get texts from its AI agent: replies, and texts when it needs you or has something for you, incl. a morning summary. ` +
    'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Terms: dial8.ai/terms'
  )
}

/** The HELP auto-reply (exact copy for carrier review). */
export const HELP_REPLY = 'Dial8 AI assistant. Help: liam@dial8.ai. Reply STOP to opt out. Msg & data rates may apply.'
