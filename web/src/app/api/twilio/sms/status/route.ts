import * as Sentry from '@sentry/nextjs'
import { getServiceClient } from '@/lib/supabase/service'
import { handleSmsStatus } from '@/lib/sms/status'
import { twilioAuthToken, twilioStatusCallbackUrl, twilioWebhookUrlOverride } from '@/lib/twilio/config'
import { TWILIO_SIGNATURE_HEADER, twilioRequestUrl, validateTwilioSignature } from '@/lib/twilio/signature'

export const dynamic = 'force-dynamic'

/**
 * POST /api/twilio/sms/status: the outcome of a text sent from an agent
 * number (the StatusCallback src/lib/twilio/client.ts sets on those only).
 * Public on purpose, as the inbound webhook: the X-Twilio-Signature is its
 * authentication (over TWILIO_WEBHOOK_URL + "/status" when a proxy rewrites
 * the host, as the callback URL itself is). A text carriers refused as from a
 * number not yet registered is resent from the Native Intelligence number
 * (src/lib/sms/status.ts); everything else is ignored. 204 when handled.
 * Logs ids and outcomes only.
 */
export async function POST(request: Request) {
  const authToken = twilioAuthToken()
  if (!authToken) return new Response('Texting is not configured', { status: 503 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  const url = twilioRequestUrl(request, twilioWebhookUrlOverride() ? twilioStatusCallbackUrl() : null)
  if (!validateTwilioSignature(url, params, request.headers.get(TWILIO_SIGNATURE_HEADER), authToken)) {
    console.warn('[twilio-sms-status] signature rejected')
    return new Response('Forbidden', { status: 403 })
  }

  const sid = params.MessageSid || params.SmsSid || ''
  const code = Number.parseInt(params.ErrorCode ?? '', 10)
  try {
    const outcome = await handleSmsStatus(getServiceClient(), {
      sid,
      status: params.MessageStatus || params.SmsStatus || '',
      errorCode: Number.isFinite(code) ? code : null,
      from: params.From ?? '',
      to: params.To ?? '',
    })
    if (outcome !== 'ignored') console.info(`[twilio-sms-status] sid=${sid || '-'} code=${Number.isFinite(code) ? code : '-'} outcome=${outcome}`)
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[twilio-sms-status] ALERT status not handled sid=${sid || '-'}: ${message}`)
    Sentry.captureMessage('twilio sms status: not handled', { level: 'error', extra: { sid: sid || null, error: message } })
    return new Response('Not handled', { status: 500 })
  }
}
