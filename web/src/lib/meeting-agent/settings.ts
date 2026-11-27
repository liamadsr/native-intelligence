/**
 * The meeting agent's settings (roadmap #12, docs/plans/agent-joins-meetings.md).
 * Liam, 11-27: "let's do it". Off unless the owner turns it on; an empty value
 * counts as unset.
 *
 *   MEETING_AGENT=on            people may send their agent to a meeting (the
 *                               chat tool, the API, the dial). Needs the calls
 *                               settings (GPT_LIVE_*, TWILIO_*) and migration 723.
 *   MEETING_AGENT_SIP_URI       OpenAI's SIP address for the project
 *                               (`sip:<project id>@sip.api.openai.com;transport=tls`),
 *                               which the outbound leg dials. Empty: no dial.
 *   MEETING_AGENT_MAX_MINUTES   the cap on one attendance (default 30, at most
 *                               90). The bridge runs in the web process, so a
 *                               roll-out cuts a meeting in progress (phase 2
 *                               moves it out).
 */

export const MEETING_AGENT_DEFAULT_MINUTES = 30
export const MEETING_AGENT_MAX_MINUTES_CAP = 90

type Env = Record<string, string | undefined>

function value(env: Env, name: string): string | null {
  const v = env[name]?.trim()
  return v ? v : null
}

/** People may send their agent to meetings on this server. */
export function meetingAgentOn(env: Env = process.env): boolean {
  return value(env, 'MEETING_AGENT') === 'on'
}

/**
 * OpenAI's SIP address the outbound leg is bridged to, or null. Only a
 * `sip:`/`sips:` URI with no query or headers of its own (the bridge adds
 * ours), no spaces and no XML-special characters (it rides TwiML).
 */
export function meetingAgentSipUri(env: Env = process.env): string | null {
  const uri = value(env, 'MEETING_AGENT_SIP_URI')
  if (!uri) return null
  if (!/^sips?:[^\s?<>&"']+$/i.test(uri)) return null
  return uri
}

/** The cap on one attendance, in minutes. */
export function meetingAgentMaxMinutes(env: Env = process.env): number {
  const raw = value(env, 'MEETING_AGENT_MAX_MINUTES')
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return MEETING_AGENT_DEFAULT_MINUTES
  return Math.min(MEETING_AGENT_MAX_MINUTES_CAP, Math.max(1, Math.floor(n)))
}
