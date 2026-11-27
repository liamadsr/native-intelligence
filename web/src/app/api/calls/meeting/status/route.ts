import * as Sentry from '@sentry/nextjs'
import { getServiceClient } from '@/lib/supabase/service'
import { handleMeetingCallStatus } from '@/lib/meeting-agent/call-status'
import { meetingStatusCallbackUrl } from '@/lib/meeting-agent/dial-out'
import { twilioAuthToken, twilioWebhookUrlOverride } from '@/lib/twilio/config'
import { TWILIO_SIGNATURE_HEADER, twilioRequestUrl, validateTwilioSignature } from '@/lib/twilio/signature'
import { isUuid } from '@/lib/presence/presence'

export const dynamic = 'force-dynamic'

/**
 * POST /api/calls/meeting/status?attendance=<id>: Twilio's status changes for
 * the call the meeting agent made to a meeting (roadmap #12,
 * src/lib/meeting-agent/dial-out.ts sets it as the StatusCallback). Public on
 * purpose, like every Twilio webhook: X-Twilio-Signature is its
 * authentication, over the exact URL Twilio was given (the app's own origin,
 * src/lib/app-url.ts, when a proxy rewrites the host: TWILIO_WEBHOOK_URL set).
 * 204 when handled. Logs ids and outcomes only.
 */
export async function POST(request: Request) {
  const authToken = twilioAuthToken()
  if (!authToken) return new Response('Calls are not configured', { status: 503 })
  const attendanceId = new URL(request.url).searchParams.get('attendance') ?? ''
  if (!isUuid(attendanceId)) return new Response('Bad request', { status: 400 })

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
  const url = twilioRequestUrl(request, twilioWebhookUrlOverride() ? meetingStatusCallbackUrl(attendanceId) : null)
  if (!validateTwilioSignature(url, params, request.headers.get(TWILIO_SIGNATURE_HEADER), authToken)) {
    console.warn('[meeting-call-status] signature rejected')
    return new Response('Forbidden', { status: 403 })
  }
  try {
    const outcome = await handleMeetingCallStatus(getServiceClient(), { attendanceId, callSid: params.CallSid ?? '', status: params.CallStatus ?? '' })
    if (outcome !== 'ignored') console.info(`[meeting-call-status] attendance=${attendanceId} status=${(params.CallStatus ?? '-').slice(0, 20)} outcome=${outcome}`)
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[meeting-call-status] ALERT status not handled attendance=${attendanceId}: ${message}`)
    Sentry.captureMessage('meeting call status: not handled', { level: 'error', extra: { attendance: attendanceId, error: message } })
    return new Response('Not handled', { status: 500 })
  }
}
