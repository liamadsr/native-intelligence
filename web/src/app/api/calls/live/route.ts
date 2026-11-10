import { after } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { getServiceClient } from '@/lib/supabase/service'
import { verifyLiveWebhook, parseLiveIncomingCall } from '@/lib/calls/live-webhook'
import { acceptLiveCall, hangUpLiveCall, liveApiKey, rejectLiveCall } from '@/lib/calls/live-api'
import { callerDisplayName, callerIdAttested, callerNumberOfSipHeaders, devSkipsAttestation, resolveCallCaller, sipHeaderNames, trunkSecretCheck } from '@/lib/calls/caller'
import { callGreeting, callSessionConfig, firstName } from '@/lib/calls/live-session'
import { runLiveCall } from '@/lib/calls/live-bridge'

export const dynamic = 'force-dynamic'
/** The bridge runs inside this request (after the answer) for the whole call. */
export const maxDuration = 800

/** SIP 603 Decline: a number nobody linked, or calls not set up. */
const DECLINE = 603

/**
 * POST /api/calls/live: OpenAI's webhook for the project's GPT-Live calls
 * (the spike, docs/plans/text-and-calling.md Phase 4). The Native Intelligence number's SIP
 * trunk sends calls to OpenAI, which posts `live.transport.incoming` here.
 * Public on purpose (outside the proxy's matcher, src/proxy.ts): the Standard
 * Webhooks signature is its authentication (GPT_LIVE_WEBHOOK_SECRET).
 *
 *   1. The signature over the raw body first. No secret, a stale timestamp or
 *      a mismatch → 401, nothing read.
 *   2. Anything but an incoming SIP call (the same call's
 *      `realtime.call.incoming`, other events) → 200, ignored: "the first
 *      successful accept selects the runtime surface".
 *   3. Our trunk's secret header (X-NI-Trunk = GPT_LIVE_TRUNK_SECRET): OpenAI
 *      takes a SIP call from anyone who knows the project id, so a call that
 *      didn't come through our Twilio trunk is declined before anything else
 *      (and every call, local dev included, while the secret is unset).
 *      The From number → the person's verified phone (src/lib/calls/caller.ts).
 *      Nobody's → declined (603). Owner calls only, for now. And only with
 *      the carrier's STIR/SHAKEN full attestation (an answer is spoken to
 *      whoever is on the line, so a spoofed caller ID must never get one);
 *      without it → declined, logging which SIP header names arrived.
 *   4. Accepted as a GPT-Live session in client delegation mode (what it is
 *      told: src/lib/calls/live-session.ts), then the bridge attaches to its
 *      sideband for the whole call, after this answer
 *      (src/lib/calls/live-bridge.ts): every request GPT-Live hands over is a
 *      call turn in the person's home thread. A bridge that can't attach hangs
 *      the call up, so GPT-Live never talks on with nobody behind it.
 *
 * Always 200 once verified: OpenAI retries a failed delivery for up to 72
 * hours, long after the call is gone. A failure is an `[calls-live] ALERT`
 * line and Sentry. Logs ids and outcomes only, never a number or a word said.
 *
 * ⚠️ Spike: the bridge lives in this request, so a call is capped below
 * maxDuration (CALL_MAX_MS, 10 min, plus its last turn's grace); local dev
 * runs `next dev` behind a tunnel.
 */
export async function POST(request: Request) {
  const body = await request.text()
  const verdict = verifyLiveWebhook({
    body,
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
    secret: process.env.GPT_LIVE_WEBHOOK_SECRET,
  })
  if (!verdict.ok) {
    console.warn(`[calls-live] webhook rejected: ${verdict.reason}`)
    return new Response(verdict.reason === 'no_secret' ? 'Calls are not configured' : 'Unauthorized', { status: verdict.reason === 'no_secret' ? 503 : 401 })
  }

  let event: unknown
  try {
    event = JSON.parse(body)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const call = parseLiveIncomingCall(event)
  if (!call) return Response.json({ ok: true, ignored: true })

  const apiKey = liveApiKey()
  if (!apiKey) {
    console.error(`[calls-live] ALERT call not answered session=${call.sessionId}: GPT_LIVE_API_KEY is not set`)
    return Response.json({ ok: true, outcome: 'not_configured' })
  }

  const trunk = trunkSecretCheck(call.sipHeaders)
  if (trunk !== 'ok') {
    const rejected = await rejectLiveCall(call.sessionId, DECLINE, { apiKey })
    console.warn(`[calls-live] session=${call.sessionId} outcome=untrusted_trunk:${trunk} headers=${sipHeaderNames(call.sipHeaders)} reject=${rejected.ok ? 'ok' : rejected.code ?? rejected.status}`)
    return Response.json({ ok: true, outcome: 'declined' })
  }

  const supabase = getServiceClient()
  try {
    const phone = callerNumberOfSipHeaders(call.sipHeaders)
    const caller = phone ? await resolveCallCaller(supabase, phone) : null
    if (!caller) {
      const rejected = await rejectLiveCall(call.sessionId, DECLINE, { apiKey })
      console.info(`[calls-live] session=${call.sessionId} outcome=${phone ? 'unknown_caller' : 'no_caller_id'} reject=${rejected.ok ? 'ok' : rejected.code ?? rejected.status}`)
      return Response.json({ ok: true, outcome: 'declined' })
    }
    if (!callerIdAttested(call.sipHeaders) && !devSkipsAttestation()) {
      const rejected = await rejectLiveCall(call.sessionId, DECLINE, { apiKey })
      console.info(`[calls-live] session=${call.sessionId} outcome=unattested headers=${sipHeaderNames(call.sipHeaders)} reject=${rejected.ok ? 'ok' : rejected.code ?? rejected.status}`)
      return Response.json({ ok: true, outcome: 'declined' })
    }
    const name = firstName(await callerDisplayName(supabase, caller))
    const accepted = await acceptLiveCall(call.sessionId, callSessionConfig(name), { apiKey })
    if (!accepted.ok) {
      // A retried delivery for a call already answered: the first accept won and its bridge runs.
      const outcome = accepted.code === 'decision_already_made' ? 'already_answered' : `accept_failed:${accepted.code ?? accepted.status}`
      console.info(`[calls-live] session=${call.sessionId} outcome=${outcome}`)
      if (outcome !== 'already_answered') Sentry.captureMessage('calls live: accept failed', { level: 'error', extra: { session: call.sessionId, status: accepted.status, code: accepted.code } })
      return Response.json({ ok: true, outcome })
    }
    console.info(`[calls-live] session=${call.sessionId} outcome=accepted via=${caller.via}`)
    after(async () => {
      try {
        await runLiveCall({ sessionId: call.sessionId, caller, apiKey, greeting: callGreeting(name) }, { supabase })
      } catch (err) {
        // The attach failed: hang up, or GPT-Live talks on with nobody behind it.
        const hungUp = await hangUpLiveCall(call.sessionId, { apiKey })
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[calls-live] ALERT bridge failed session=${call.sessionId} hangup=${hungUp.ok ? 'ok' : hungUp.code ?? hungUp.status}: ${message}`)
        Sentry.captureMessage('calls live: bridge failed', { level: 'error', extra: { session: call.sessionId, error: message } })
      }
    })
    return Response.json({ ok: true, outcome: 'accepted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[calls-live] ALERT call not handled session=${call.sessionId}: ${message}`)
    Sentry.captureMessage('calls live: call not handled', { level: 'error', extra: { session: call.sessionId, error: message } })
    return Response.json({ ok: true, outcome: 'error' })
  }
}
