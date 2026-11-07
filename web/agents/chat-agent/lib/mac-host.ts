/**
 * The Mac body's link to the app (contract C2 → C1, docs/plans/teammate-agent.md):
 * its channel auth, and where its spec and tool calls go.
 *
 * The cloud body authenticates the person's Supabase session and reaches the
 * app's internal routes with the shared internal secret plus a chat-run token
 * the browser mints per send (channels/eve.ts, lib/spec-client.ts). None of that
 * exists on a Mac, and the shared secret must never ship to one. Instead:
 *
 *   - **Who may drive it:** only the launcher that started it, by the random
 *     per-launch secret, behind the launcher's request guard
 *     (agents/local-agent/channels/eve.ts, which the Mac build puts in place of
 *     the cloud's channel; agents/local-agent/launcher/server-guard.ts).
 *   - **What it presents to the app:** the per-session `la1` token the model
 *     relay already uses (src/lib/local-agent/tokens.ts). The launcher writes it
 *     to a 0600 file in the job dir and refreshes it in place; this server only
 *     ever gets the file's path (LOCAL_AGENT_SESSION_TOKEN_FILE) and reads it on
 *     every request, as the relay's model fetch does.
 *   - **Where:** C1's two routes, `GET /api/local-agent/agent/spec` and
 *     `POST /api/local-agent/agent/tool`, on the app's origin: LOCAL_AGENT_API_ORIGIN
 *     when the desktop sets it (a local-model run has no relay URL), else the
 *     origin of the relay URL. With both, they must be the same origin: the
 *     token goes to one place only. Every other internal route the cloud body calls
 *     (usage, reply backup, memory, helper tiers, analytics) has no Mac
 *     counterpart: the relay meters the model, and the desktop uploads the
 *     transcript. lib/spec-client.ts short-circuits those on the Mac. (Memory
 *     never gets that far: the Mac principal has no workspace, so the memory
 *     slot has no scope there, lib/profile-memory.ts profileMemoryScope.)
 *
 * Code from agents/local-agent comes in through ./mac-slots.ts only, a stub in
 * the cloud build.
 *
 * The rest of the agent reads a chat-run token off the principal and refuses
 * to work without one. The Mac principal therefore carries a marker in its
 * place, new on every request that delivers a message (one per turn, like the
 * browser's), so the turn's spec memo keys the same way. It is never sent
 * anywhere and authorizes nothing: it starts with `mac-session:` and has no
 * dot, so the cloud's unverified claim readers (surface, teammate, server,
 * relay) all read it as an ordinary chat.
 */
import { randomUUID } from 'node:crypto'
import { readModelToken, relayBaseUrl } from './mac-slots.js'

/** The Mac principal's stand-in for a chat-run token (see the file comment). */
export const MAC_RUN_TOKEN_PREFIX = 'mac-session:'

/** C1's routes on the app, by the name the cloud body's internal route has. */
export type MacAppRoute = 'spec' | 'tool'

/** The environment as read here (process.env, or a plain object in tests). */
type MacEnv = Readonly<Record<string, string | undefined>>

/** A fresh stand-in token for one delivered message. */
export function macRunToken(): string {
  return `${MAC_RUN_TOKEN_PREFIX}${randomUUID()}`
}

/**
 * The attributes the chat agent's resolvers read, for the Mac principal: the
 * stand-in run token, and an empty workspace, turn context and reply id (the
 * desktop sends none of them). The Mac channel adds them to the launcher's
 * secret check (agents/local-agent/channels/eve.ts).
 */
export function macPrincipalAttributes(): Record<string, string> {
  return { workspaceId: '', chatRunToken: macRunToken(), chatRunCtx: '', chatReplyId: '' }
}

/**
 * LOCAL_AGENT_API_ORIGIN as an origin, or null when it isn't one: the relay
 * URL's rule (https, or http to loopback for `next dev`), and nothing but an
 * origin (no credentials, path, query or fragment).
 */
export function apiOriginOf(raw: string | undefined): string | null {
  const checked = relayBaseUrl(raw)
  if (!checked) return null
  const url = new URL(checked)
  return url.pathname === '/' ? url.origin : null
}

/**
 * The app's origin for C1: LOCAL_AGENT_API_ORIGIN (apiOriginOf), else the relay
 * URL's origin (the relay URL's own rule: the model token already goes there).
 * With both set they must name the same origin, so the token never goes to
 * two places. Null when neither is set, one is malformed, or they disagree.
 */
export function macApiOrigin(env: MacEnv = process.env): string | null {
  const relay = relayBaseUrl(env.LOCAL_AGENT_MODEL_BASE_URL)
  const relayOrigin = relay ? new URL(relay).origin : null
  if (!env.LOCAL_AGENT_API_ORIGIN) return relayOrigin
  const explicit = apiOriginOf(env.LOCAL_AGENT_API_ORIGIN)
  if (!explicit || (relayOrigin !== null && relayOrigin !== explicit)) return null
  return explicit
}

/**
 * Whether this launch can reach C1: 'ok'; 'no-token' only when the launch has
 * no session token file at all (the dev path, no C1 by design); otherwise
 * 'misconfigured' (a token file but no usable origin, or a relative path),
 * which the liveness judge counts as a stop: such a launch must not work on
 * with no way to hear a Stop.
 */
export function macRouteState(env: MacEnv = process.env): 'ok' | 'no-token' | 'misconfigured' {
  if (!env.LOCAL_AGENT_SESSION_TOKEN_FILE) return 'no-token'
  return macRouteUnavailable(env) ? 'misconfigured' : 'ok'
}

/** Why C1 can't be reached from this launch, or null when it can. */
export function macRouteUnavailable(env: MacEnv = process.env): string | null {
  if (!env.LOCAL_AGENT_SESSION_TOKEN_FILE) return 'no session token on this launch'
  if (!env.LOCAL_AGENT_SESSION_TOKEN_FILE.startsWith('/')) return 'LOCAL_AGENT_SESSION_TOKEN_FILE is not absolute'
  if (!macApiOrigin(env)) return 'no app origin on this launch (LOCAL_AGENT_API_ORIGIN or LOCAL_AGENT_MODEL_BASE_URL)'
  return null
}

/**
 * The URL and headers of one C1 call: the route on the app's origin, with the
 * session token read from its file now (a refresh lands on the next call).
 * Throws when this launch has no session token or origin, or the file doesn't
 * hold a token; the caller turns that into its own failure shape.
 */
export function macRouteTarget(route: MacAppRoute, env: MacEnv = process.env): { url: string; headers: Record<string, string> } {
  const unavailable = macRouteUnavailable(env)
  if (unavailable) throw new Error(`the app is not reachable from this Mac: ${unavailable}`)
  const token = readModelToken(env.LOCAL_AGENT_SESSION_TOKEN_FILE!)
  return {
    url: `${macApiOrigin(env)}/api/local-agent/agent/${route}`,
    headers: { authorization: `Bearer ${token}` },
  }
}

/** How the desktop marks a relayed message's author (src/lib/local-agent/relay-core.ts prefixMessage). */
const FROM_PREFIX = /^\[From ([^\]\n]{1,80})\]\s?/
const FROM_THE_AGENT = 'the Dial8 agent'

/**
 * The person's own words in a message the Mac body received, or null. The
 * request that starts a job is the cloud body's wording, and `[From the Dial8
 * agent]` messages are the cloud body's too; only `[From <name>]` messages are
 * the person's (prefix removed). The reviewer reads these as the person's
 * intent (src/lib/safety/action-review.ts), so an agent's words must never
 * pass as theirs.
 */
export function macPersonText(message: string): string | null {
  const m = FROM_PREFIX.exec(message)
  if (!m || m[1] === FROM_THE_AGENT) return null
  const text = message.slice(m[0].length).trim()
  return text ? text : null
}

/** How long the Mac waits for C1's liveness answer before it counts as a miss. */
export const MAC_PROBE_TIMEOUT_MS = 5_000
/** Misses in a row (no answer, a 5xx, a timeout) after which the Mac body stops: it fails closed. */
export const MAC_PROBE_MISSES_BEFORE_STOP = 3

/**
 * The `exp` (unix seconds) of the session token in the launcher's file, read
 * without verifying it (the app verifies; this only lets the Mac notice an
 * expired token on its own: `la1.<base64url JSON {sid, uid, wid, exp}>.<mac>`,
 * src/lib/local-agent/tokens.ts). Null when it can't be read.
 */
export function macTokenExpiry(env: MacEnv = process.env): number | null {
  try {
    const [prefix, payload] = readModelToken(env.LOCAL_AGENT_SESSION_TOKEN_FILE ?? '').split('.')
    if (prefix !== 'la1' || !payload) return null
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    return null
  }
}

/** Why the Mac body must stop working, from one liveness answer. */
export type MacLivenessStop = 'ended' | 'unreachable' | 'expired' | 'misconfigured'

/** The app's last answer on this process (one launcher, one job): the native tools refuse while it says stop. */
let macStopped: MacLivenessStop | null = null
let macMisses = 0
/** When the last answer was judged (ms): the tool guard reuses it for a moment (lib/mac-guard.ts). */
let macJudgedAt = 0

/** When the last liveness answer was judged (Date.now() ms; 0 = never). */
export function macLastJudgedAt(): number {
  return macJudgedAt
}

/**
 * Judge one answer of C1's liveness probe (before every model step,
 * hooks/usage-limit-gate.ts). Fails closed:
 *   - 401 / 403: the session ended (a Stop answers 403 at once) or its token is bad;
 *   - MAC_PROBE_MISSES_BEFORE_STOP misses in a row: the app can't be reached;
 *   - a miss once the token's own `exp` has passed: it expired;
 *   - a launch with a token but no usable route to the app (macRouteState).
 * A launch with no session token at all (the dev path, no C1 by design) is
 * never judged. A 200 clears everything, a refreshed token included.
 */
export function judgeMacLiveness(
  result: { ok: true } | { ok: false; status: number | 'network' | 'no-token' | 'misconfigured' },
  now: number = Date.now() / 1000,
  env: MacEnv = process.env,
): MacLivenessStop | null {
  macJudgedAt = Date.now()
  if (result.ok) {
    macMisses = 0
    macStopped = null
    return null
  }
  if (result.status === 'no-token') return null
  if (result.status === 'misconfigured') return (macStopped = 'misconfigured')
  if (result.status === 401 || result.status === 403) return (macStopped = 'ended')
  macMisses += 1
  if (macMisses >= MAC_PROBE_MISSES_BEFORE_STOP) return (macStopped = 'unreachable')
  const exp = macTokenExpiry(env)
  if (exp !== null && exp <= now) return (macStopped = 'expired')
  return null
}

/** Record a stop decided elsewhere (the turn's spec answered 401 / 403). */
export function markMacStopped(why: MacLivenessStop): void {
  macStopped = why
}

/** Test-only: forget the liveness state. */
export function resetMacLivenessForTests(): void {
  macStopped = null
  macMisses = 0
  macJudgedAt = 0
}

/** What the native tools say while the app's last answer is a stop. */
export const MAC_TOOLS_PAUSED =
  'This Mac job is paused: the app no longer accepts it (its session ended, or its token expired or could not be checked). Nothing runs on the Mac until it does.'

/** Throws while the app's last answer is a stop (lib/mac-guard.ts macToolGuard calls it after its check). */
export function assertMacAppLive(): void {
  if (macStopped) throw new Error(MAC_TOOLS_PAUSED)
}
