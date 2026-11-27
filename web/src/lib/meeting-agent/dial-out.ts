/**
 * The outbound leg (roadmap #12, docs/plans/agent-joins-meetings.md §1a).
 * Today's calls are inbound only: Twilio sends a call to OpenAI's SIP address,
 * and OpenAI posts `live.transport.incoming` to us. A meeting is the other way
 * round, so we start the call:
 *
 *   1. Twilio's REST API calls the meeting's dial-in number from the Native
 *      Intelligence number, with the call's TwiML inline (no webhook to fetch):
 *   2. once the bridge answers, `<Play digits>` keys in its PIN (./dial-in.ts),
 *   3. then `<Dial><Sip>` bridges the call to OpenAI's SIP address
 *      (MEETING_AGENT_SIP_URI) with two headers: our trunk's secret
 *      (`X-NI-Trunk`, GPT_LIVE_TRUNK_SECRET, the same check every call passes:
 *      src/lib/calls/caller.ts trunkSecretCheck) and the attendance's one-time
 *      token (`X-NI-Meeting`).
 *   4. OpenAI posts `live.transport.incoming` to /api/calls/live as for any
 *      call; the webhook sees `X-NI-Meeting`, finds the attendance by the
 *      token's hash (the token itself is never stored) and accepts the call as
 *      a meeting (./session.ts), not as the person calling.
 *
 * Twilio ends the call at `TimeLimit` whatever happens to us (the cap,
 * MEETING_AGENT_MAX_MINUTES), and posts each status change to
 * /api/calls/meeting/status (signed, like every Twilio webhook).
 */
import { createHash, randomBytes } from 'node:crypto'
import { appUrl } from '@/lib/app-url'
import { accountUrl, twilioRest } from '@/lib/twilio/rest'
import type { TwilioConfig } from '@/lib/twilio/config'
import { TRUNK_SECRET_HEADER } from '@/lib/calls/caller'
import { isDialDigits } from './dial-in'

/** The header the outbound leg carries the attendance's one-time token in. */
export const MEETING_TOKEN_HEADER = 'X-NI-Meeting' // gitleaks:allow (a header name, not a secret)

/** How long the meeting's number may ring before Twilio gives up (seconds). */
export const DIAL_RING_SECONDS = 45

/** A fresh one-time token (hex, so it rides a SIP URI unescaped) and its hash, which is all we keep. */
export function newJoinToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, hash: hashJoinToken(token) }
}

/** sha256 hex of a join token. */
export function hashJoinToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * The call's TwiML: key in the PIN, then bridge to OpenAI with our headers.
 * Every value is checked before it is written: digits only from the DTMF set,
 * headers hex, the SIP URI already validated (settings.ts).
 */
export function meetingTwiml(args: { digits: string; sipUri: string; trunkSecret: string; token: string; timeLimitSeconds: number }): string {
  if (!isDialDigits(args.digits)) throw new Error('meeting agent: bad dial digits')
  if (!/^[0-9a-f]{16,128}$/i.test(args.trunkSecret)) throw new Error('meeting agent: the trunk secret must be hex')
  if (!/^[0-9a-f]{64}$/.test(args.token)) throw new Error('meeting agent: bad join token')
  const uri = `${args.sipUri}?${TRUNK_SECRET_HEADER}=${args.trunkSecret}&${MEETING_TOKEN_HEADER}=${args.token}`
  const limit = Math.max(60, Math.floor(args.timeLimitSeconds))
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${escapeXml(args.digits)}"/><Dial timeLimit="${limit}"><Sip>${escapeXml(uri)}</Sip></Dial></Response>`
}

/** Where Twilio posts the call's status changes (signed over this exact URL). */
export function meetingStatusCallbackUrl(attendanceId: string, origin: string = appUrl()): string {
  return `${origin.replace(/\/+$/, '')}/api/calls/meeting/status?attendance=${encodeURIComponent(attendanceId)}`
}

export type DialResult = { ok: true; callSid: string } | { ok: false; status: number; code: string | null }

/** Seams for the tests. */
export interface DialDeps {
  fetch?: typeof fetch
}

/** Start the call to the meeting. Never throws: a failure is `ok: false`. */
export async function dialMeeting(
  config: Pick<TwilioConfig, 'accountSid' | 'authToken'>,
  args: { from: string; to: string; twiml: string; timeLimitSeconds: number; statusCallback: string },
  deps: DialDeps = {},
): Promise<DialResult> {
  try {
    const res = await twilioRest(
      config,
      accountUrl(config, '/Calls.json'),
      {
        method: 'POST',
        form: {
          To: args.to,
          From: args.from,
          Twiml: args.twiml,
          Timeout: String(DIAL_RING_SECONDS),
          TimeLimit: String(Math.max(60, Math.floor(args.timeLimitSeconds))),
          StatusCallback: args.statusCallback,
          StatusCallbackMethod: 'POST',
          // Twilio takes one parameter per event; URLSearchParams can't repeat a key, so it's Twilio's space-separated form.
          StatusCallbackEvent: 'initiated ringing answered completed',
        },
      },
      deps.fetch,
    )
    const sid = typeof res.json?.sid === 'string' ? res.json.sid : null
    if (res.ok && sid) return { ok: true, callSid: sid }
    const code = res.json?.code
    return { ok: false, status: res.status, code: code == null ? null : String(code) }
  } catch {
    return { ok: false, status: 0, code: 'network' }
  }
}

/** The one-time token an incoming call carries in `X-NI-Meeting`, when it is one of our meeting legs (hex, 64), else null. */
export function meetingTokenOfSipHeaders(headers: ReadonlyArray<{ name: string; value: string }>): string | null {
  const raw = headers.find((h) => h.name.toLowerCase() === MEETING_TOKEN_HEADER.toLowerCase())?.value?.trim() ?? ''
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null
}

/** Whether an incoming call says it is a meeting leg at all (any `X-NI-Meeting`, well formed or not). */
export function claimsMeetingLeg(headers: ReadonlyArray<{ name: string }>): boolean {
  return headers.some((h) => h.name.toLowerCase() === MEETING_TOKEN_HEADER.toLowerCase())
}
