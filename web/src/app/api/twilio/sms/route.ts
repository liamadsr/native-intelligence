import * as Sentry from '@sentry/nextjs'
import { getServiceClient } from '@/lib/supabase/service'
import { handleInboundSms, supabaseInboundDeps } from '@/lib/sms/inbound'
import { deliverTextToHomeThread } from '@/lib/sms/deliver'
import { mediaFromParams } from '@/lib/sms/media'
import { codeKey } from '@/lib/sms/phone-verification'
import { handleSignupText, supabaseSignupDeps } from '@/lib/sms/signup'
import { appOrigin, twilioAuthToken } from '@/lib/twilio/config'
import { TWILIO_SIGNATURE_HEADER, twilioRequestUrl, validateTwilioSignature } from '@/lib/twilio/signature'
import { twimlResponse } from '@/lib/twilio/twiml'

export const dynamic = 'force-dynamic'

/**
 * POST /api/twilio/sms: Twilio's inbound-SMS webhook for the Dial8 number
 * (docs/plans/text-and-calling.md, Phase 1). Public on purpose: it is outside
 * the proxy's matcher (src/proxy.ts covers /account, /admin and their APIs
 * only), and the X-Twilio-Signature is its authentication.
 *
 *   1. The signature first (HMAC-SHA1 over the public URL and the sorted form
 *      params with TWILIO_AUTH_TOKEN; TWILIO_WEBHOOK_URL when a proxy rewrites
 *      the host). No token, no signature, or a mismatch → 403, nothing read.
 *   2. Then src/lib/sms/inbound.ts: STOP / START / HELP before anything else,
 *      the per-number rate limit, `From` → the verified user_phone (an
 *      unknown number texting the Dial8 number is signing up:
 *      src/lib/sms/signup.ts), membership, and the text written into the
 *      person's home thread with its turn requested over Inngest.
 *   3. Answers TwiML at once: empty for an ordinary text (the reply is texted
 *      later by the turn), one `<Message>` for HELP, START, a sign-up code or
 *      the sign-up welcome. The turn never runs here.
 *
 * Twilio does NOT retry an inbound-message webhook on a 5xx (it only tries
 * the number's fallback URL, when one is set, on an error or a timeout). So a
 * store failure is answered 200 with empty TwiML and reported loudly (an
 * `[twilio-sms] ALERT` line and Sentry): the text is lost unless a fallback
 * URL re-delivers it, which the ledger's unique MessageSid then dedupes (a
 * failed delivery forgets its sid first, src/lib/sms/inbound.ts).
 * Logs ids and outcomes only, never a number or a word of the text.
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

  const signature = request.headers.get(TWILIO_SIGNATURE_HEADER)
  if (!validateTwilioSignature(twilioRequestUrl(request), params, signature, authToken)) {
    console.warn('[twilio-sms] signature rejected')
    return new Response('Forbidden', { status: 403 })
  }

  const supabase = getServiceClient()
  const origin = appOrigin()
  try {
    const result = await handleInboundSms(
      {
        from: params.From ?? '',
        // The number that was texted: the Dial8 line, or a business's own, which makes the sender its customer (roadmaps A and B2).
        to: params.To ?? null,
        body: params.Body ?? '',
        sid: params.MessageSid || params.SmsSid || null,
        numMedia: Number.parseInt(params.NumMedia ?? '0', 10) || 0,
        media: mediaFromParams(params, Number.parseInt(params.NumMedia ?? '0', 10) || 0),
        optOutType: params.OptOutType ?? null,
      },
      supabaseInboundDeps(supabase, {
        origin,
        deliverText: async (args) => {
          await deliverTextToHomeThread(supabase, args)
        },
        signupText: (input, tools) =>
          handleSignupText(input, supabaseSignupDeps(supabase, { autoReply: tools.autoReply, key: codeKey(), origin, now: Date.now() })),
      }),
    )
    console.info(`[twilio-sms] sid=${params.MessageSid ?? '-'} outcome=${result.outcome}`)
    return twimlResponse(result.reply)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[twilio-sms] ALERT inbound text not handled sid=${params.MessageSid ?? '-'}: ${message}`)
    Sentry.captureMessage('twilio sms: inbound text not handled', { level: 'error', extra: { sid: params.MessageSid ?? null, error: message } })
    // 200 + empty TwiML: a 5xx is not retried by Twilio, and would only show as an error in its console.
    return twimlResponse(null)
  }
}
