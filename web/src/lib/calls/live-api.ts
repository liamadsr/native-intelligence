/**
 * OpenAI's GPT-Live session API, for calls (the spike). Founder decision
 * (Liam, 2026-10-31): GPT-Live is the voice layer of a phone call, the one
 * model outside eve. It only talks: in `client` delegation mode it hands every
 * request to us, and eve's chat-agent does all the thinking and every tool
 * call (src/lib/calls/call-turn-server.ts). A raw fetch, no provider package.
 *
 * The REST calls answer an incoming SIP call (accept / reject) or end one;
 * the call's sideband WebSocket is ./live-bridge.ts.
 */

/** The model a call runs on (developers.openai.com/api/docs/models/gpt-live-1). */
export const GPT_LIVE_MODEL = 'gpt-live-1'

const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions'

/** The project key a call is answered with; null when calls are not set up. Never the Gateway's. */
export function liveApiKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.GPT_LIVE_API_KEY?.trim()
  return key ? key : null
}

/** The sideband WebSocket a call is attached to (Authorization: Bearer <key>). */
export function liveAttachUrl(sessionId: string): string {
  return `${LIVE_SESSIONS_URL.replace(/^https:/, 'wss:')}/${encodeURIComponent(sessionId)}/attach`
}

/** One message of the history a session starts with (exactly one text part). */
export interface LiveInputMessage {
  type: 'message'
  role: 'developer' | 'user' | 'assistant'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

/** The `session` an accept carries (SIP negotiates the audio format, so there is none). */
export interface LiveSessionConfig {
  type: 'live'
  model: typeof GPT_LIVE_MODEL
  instructions: string
  input?: LiveInputMessage[]
  audio?: { output?: { voice?: string } }
  delegation: { type: 'client'; acknowledgement_delay_ms?: number }
  store?: boolean
}

export type LiveApiResult = { ok: true } | { ok: false; status: number; code: string | null }

/** Seams for the tests. */
export interface LiveApiDeps {
  fetch?: typeof fetch
  apiKey: string
}

async function post(path: string, body: unknown, deps: LiveApiDeps): Promise<LiveApiResult> {
  try {
    const res = await (deps.fetch ?? fetch)(`${LIVE_SESSIONS_URL}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return { ok: true }
    const err = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
    return { ok: false, status: res.status, code: typeof err?.error?.code === 'string' ? err.error.code : null }
  } catch {
    return { ok: false, status: 0, code: 'network' }
  }
}

/** Answer an incoming call with this session. "The first accept or reject decision wins." */
export function acceptLiveCall(sessionId: string, session: LiveSessionConfig, deps: LiveApiDeps): Promise<LiveApiResult> {
  return post(`${encodeURIComponent(sessionId)}/accept`, { session }, deps)
}

/** Decline an incoming call with a SIP status (300–699; 603 is Decline). */
export function rejectLiveCall(sessionId: string, statusCode: number, deps: LiveApiDeps): Promise<LiveApiResult> {
  return post(`${encodeURIComponent(sessionId)}/reject`, { status_code: statusCode }, deps)
}

/** Hang up a call. */
export function hangUpLiveCall(sessionId: string, deps: LiveApiDeps): Promise<LiveApiResult> {
  return post(`${encodeURIComponent(sessionId)}/hangup`, undefined, deps)
}
