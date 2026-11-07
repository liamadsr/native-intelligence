/**
 * Twilio configuration (docs/plans/text-and-calling.md, Phase 1). One Dial8
 * number per deployment, set through Vercel Connect / env:
 *
 *   TWILIO_ACCOUNT_SID              the account (AC…)
 *   TWILIO_AUTH_TOKEN               signs the webhooks we receive and
 *                                   authenticates the REST calls we make
 *   TWILIO_PHONE_NUMBER             the Dial8 number (E.164), the `From`
 *   TWILIO_MESSAGING_SERVICE_SID    optional (MG…): sends through a messaging
 *                                   service instead (10DLC campaigns attach
 *                                   there), From the Dial8 number when it is
 *                                   set (the pool holds agent numbers too:
 *                                   src/lib/sms/agent-number.ts)
 *   TWILIO_WEBHOOK_URL              optional: the exact public URL Twilio
 *                                   posts to, when a proxy or tunnel rewrites
 *                                   the host the app sees (the signature is
 *                                   computed over the URL Twilio used)
 *
 * FAILS CLOSED: with no account, token or sender, {@link twilioConfig} is null
 * and nothing is sent; with no auth token every webhook is refused (an
 * unsigned request is never trusted).
 */

export interface TwilioConfig {
  accountSid: string
  authToken: string
  /** The `From` number, when no messaging service is set. */
  fromNumber: string | null
  messagingServiceSid: string | null
}

function env(name: string): string | null {
  const v = process.env[name]?.trim()
  return v ? v : null
}

/** The full sending config, or null when any required piece is unset. */
export function twilioConfig(): TwilioConfig | null {
  const accountSid = env('TWILIO_ACCOUNT_SID')
  const authToken = env('TWILIO_AUTH_TOKEN')
  const messagingServiceSid = env('TWILIO_MESSAGING_SERVICE_SID')
  const fromNumber = env('TWILIO_PHONE_NUMBER')
  if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) return null
  return { accountSid, authToken, fromNumber, messagingServiceSid }
}

/** The auth token that signs webhooks, or null (every webhook is then refused). */
export function twilioAuthToken(): string | null {
  return env('TWILIO_AUTH_TOKEN')
}

/** The Dial8 number people text, for copy ("text +1 555…"), or null. */
export function twilioPhoneNumber(): string | null {
  return env('TWILIO_PHONE_NUMBER')
}

/** The configured public webhook URL override, or null. */
export function twilioWebhookUrlOverride(): string | null {
  return env('TWILIO_WEBHOOK_URL')
}

/** The SMS webhook every Dial8 number posts to (the Dial8 one, a business's, an agent's). */
export function twilioSmsWebhookUrl(): string {
  return twilioWebhookUrlOverride() ?? `${appOrigin()}/api/twilio/sms`
}

/** Where Twilio posts the outcome of a text sent from an agent number (src/app/api/twilio/sms/status/route.ts). */
export function twilioStatusCallbackUrl(): string {
  return `${twilioSmsWebhookUrl()}/status`
}

/** The app's public origin, for links in texts. */
export function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}
