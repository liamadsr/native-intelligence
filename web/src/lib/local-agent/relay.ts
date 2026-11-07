/**
 * The local agent's model relay, helpers (the route is
 * src/app/api/local-agent/model/[...path]/route.ts).
 *
 * The Mac's local eve uses `createGateway({ baseURL: <app>/api/local-agent/model,
 * apiKey: <model token> })` (agents/local-agent/lib/model.ts), so its requests
 * arrive here in the AI Gateway's own wire format (@ai-sdk/gateway):
 *
 *   POST <base>/language-model
 *   ai-language-model-specification-version: 4
 *   ai-language-model-id: anthropic/claude-sonnet-5.5
 *   ai-language-model-streaming: true|false
 *   body: the JSON call options; response: JSON, or SSE stream parts
 *
 * The relay re-sends those bytes to the Gateway with the SERVER's credential
 * (the gateway key never leaves the server) and streams the answer back
 * unchanged, reading only the final usage on the way past.
 *
 * Why this is not a model call (the eve-everywhere tripwire): nothing here
 * imports 'ai' or a provider package, builds a LanguageModel, or calls one.
 * The model call is the Mac's eve agent's; this forwards its HTTP request,
 * like the Gateway itself does. Only the `language-model` path is served
 * (no embeddings, images, config or credits), for an allowlisted model id.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { gatewayModelSlug } from '@/lib/ai/models'
import { SURFACE_MODELS } from '@/lib/ai/model-defaults'
import { apiError, forbidden, unauthorized } from '@/lib/api-errors'
import { MODEL_LIVE_STATUSES, staleness } from './store'
import { verifyModelToken, type ModelTokenClaims } from './tokens'

export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai'
export const GATEWAY_PROTOCOL_VERSION = '0.0.1'

/** The Gateway path the relay serves. */
export const RELAY_PATH = 'language-model'

/**
 * The ChatGPT free tier's path (the route's file comment): an OpenAI
 * Responses request on the person's own plan. The local agent's provider
 * posts `${baseURL}/responses` with baseURL `<relay>/plan`.
 */
export const RELAY_PLAN_PATH = 'plan/responses'

/**
 * The local agent's model and its fallbacks. agents/local-agent runs
 * SURFACE_MODELS.coding_runs (LOCAL_AGENT_MODEL there is a copied literal of
 * its Gateway slug, anthropic/claude-sonnet-5.5, because an eve root cannot
 * import src), so the allowlist derives from the same constant. The local
 * agent sets no Gateway fallbacks today; any it sends in
 * `providerOptions.gateway.models` must be in this set too.
 */
export const LOCAL_AGENT_MODEL_SLUG = gatewayModelSlug(SURFACE_MODELS.coding_runs)
export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set([LOCAL_AGENT_MODEL_SLUG])

export function isAllowedModel(id: unknown): id is string {
  return typeof id === 'string' && ALLOWED_MODEL_IDS.has(id.trim())
}

// ── The session token's checks ─────────────────────────────────────────────

/** The session columns every check reads. */
export const TOKEN_SESSION_COLUMNS = 'id, user_id, workspace_id, status, expires_at, lease_expires_at, updated_at, stop_requested_at'

/** A local_agent_session row as {@link checkSessionToken} reads it (plus any extra columns asked for). */
export interface TokenSessionRow {
  id: string
  user_id: string
  workspace_id: string
  status: string
  expires_at: string
  lease_expires_at: string | null
  updated_at: string
  stop_requested_at: string | null
}

export type SessionTokenCheck<R extends TokenSessionRow> =
  | { ok: true; claims: ModelTokenClaims; session: R }
  | { ok: false; response: Response }

/**
 * What every route the Mac reaches with its session token checks first: the
 * model relay (/api/local-agent/model/*) and the Mac body's spec and tool
 * routes (/api/local-agent/agent/*, docs/plans/teammate-agent.md C1).
 *   1. `Authorization: Bearer <token>`: its HMAC and expiry (401; 503 when no
 *      key is configured).
 *   2. The session is the token's, owned by its `uid`, in a model-live status
 *      (starting, running, waiting, interrupted), not idle for 24 h, and not
 *      asked to stop (403): Stop cuts the server off at once, without waiting
 *      for the Mac to report `cancelled` (a message that requeues the job
 *      clears it). A failed read is 503.
 * `extraColumns` adds to what is read (a comma list beside the base columns).
 * The caller still checks the person's usage limit.
 */
export async function checkSessionToken<R extends TokenSessionRow = TokenSessionRow>(
  request: Request,
  svc: SupabaseClient,
  extraColumns?: string,
): Promise<SessionTokenCheck<R>> {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return { ok: false, response: unauthorized() }
  const verified = verifyModelToken(header.slice('Bearer '.length).trim())
  if (!verified.ok) {
    if (verified.reason === 'unconfigured') {
      return { ok: false, response: apiError('Model relay not configured', { status: 503, code: 'NOT_CONFIGURED' }) }
    }
    return { ok: false, response: unauthorized(verified.reason === 'expired' ? 'Model token expired' : 'Invalid model token') }
  }
  const { sid, uid } = verified.claims
  const { data: session, error } = await svc
    .from('local_agent_session')
    .select(extraColumns ? `${TOKEN_SESSION_COLUMNS}, ${extraColumns}` : TOKEN_SESSION_COLUMNS)
    .eq('id', sid)
    .eq('user_id', uid)
    .maybeSingle()
  if (error) return { ok: false, response: apiError('Session check failed', { status: 503, code: 'UNAVAILABLE' }) }
  const row = session as R | null
  if (!row || !(MODEL_LIVE_STATUSES as string[]).includes(row.status)) {
    return { ok: false, response: forbidden('This local agent is not running') }
  }
  // Idle for 24 h (the next read reaps it to expired): its token is done.
  const stale = staleness(row as Parameters<typeof staleness>[0])
  if (stale === 'idle' || stale === 'expired') return { ok: false, response: forbidden('This local agent is not running') }
  if (row.stop_requested_at) return { ok: false, response: forbidden('This local agent was stopped') }
  return { ok: true, claims: verified.claims, session: row }
}

/** The relay accepts at most this much request body (a long context is ~1-2 MB of JSON). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * The provider options a local agent's call may carry, per provider: what its
 * eve sends (the Gateway's prompt caching, session id, fallbacks and tags;
 * Anthropic's metadata user id and its reasoning and caching options), and
 * nothing else. Every other provider, and every other key, is dropped before
 * the Gateway sees it (security review 2026-10-31): a provider option can
 * switch on what the tools check never sees. `anthropic.mcpServers` has
 * Anthropic call an MCP server the request names, `anthropic.container` runs
 * Anthropic-hosted skills, `anthropic.fallbacks` names models the allowlist
 * never checked, and the Gateway takes any option its service adds without an
 * SDK release. `gateway.byok` (the person's own provider keys) is not here
 * either: those never ride through our relay.
 */
export const ALLOWED_PROVIDER_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  gateway: new Set(['caching', 'sessionId', 'models', 'tags']),
  anthropic: new Set(['metadata', 'thinking', 'effort', 'sendReasoning', 'cacheControl', 'disableParallelToolUse', 'toolStreaming', 'structuredOutputMode']),
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** The allowlisted part of a call's provider options (see ALLOWED_PROVIDER_OPTIONS). */
export function allowedProviderOptions(value: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  if (!isRecord(value)) return out
  for (const [provider, keys] of Object.entries(ALLOWED_PROVIDER_OPTIONS)) {
    const options = value[provider]
    if (!isRecord(options)) continue
    const kept = Object.fromEntries(Object.entries(options).filter(([key]) => keys.has(key)))
    if (Object.keys(kept).length > 0) out[provider] = kept
  }
  return out
}

/**
 * The call options, checked and tagged: no provider-run tool, every Gateway
 * fallback model allowlisted, only the allowlisted provider options, and the
 * Gateway's per-user tag set to the person (so its own reports attribute the
 * spend). Returns the body to forward, or the offending model id or tool.
 */
export function prepareBody(
  raw: string,
  ctx: { userId: string; sessionId: string },
):
  | { ok: true; body: string }
  | { ok: false; reason: 'json' }
  | { ok: false; reason: 'model'; model: string }
  | { ok: false; reason: 'tool'; tool: string } {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'json' }
    parsed = value as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'json' }
  }
  // "Network off" holds on the server too: only the local agent's own
  // function tools (which run in its sandbox on the Mac) may ride through;
  // a provider-executed tool (the Gateway's or a provider's web search or
  // fetch) would reach the network from outside the fence.
  if (parsed.tools !== undefined) {
    if (!Array.isArray(parsed.tools)) return { ok: false, reason: 'tool', tool: 'tools' }
    for (const t of parsed.tools as unknown[]) {
      const tool = (t ?? {}) as Record<string, unknown>
      if (tool.type !== 'function') return { ok: false, reason: 'tool', tool: String(tool.id ?? tool.name ?? tool.type) }
    }
  }
  const providerOptions = allowedProviderOptions(parsed.providerOptions)
  const gateway = providerOptions.gateway ?? {}
  if (gateway.models !== undefined) {
    if (!Array.isArray(gateway.models)) return { ok: false, reason: 'model', model: String(gateway.models) }
    for (const m of gateway.models as unknown[]) {
      if (!isAllowedModel(m)) return { ok: false, reason: 'model', model: String(m) }
    }
  }
  parsed.providerOptions = {
    ...providerOptions,
    gateway: {
      ...gateway,
      user: ctx.userId,
      tags: ['local_agent', ...(Array.isArray(gateway.tags) ? (gateway.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 8) : [])],
    },
  }
  return { ok: true, body: JSON.stringify(parsed) }
}

export interface GatewayCredential {
  token: string
  authMethod: 'api-key' | 'oidc'
}

/**
 * The server's Gateway credential, the way @ai-sdk/gateway resolves it
 * (getGatewayAuthToken): AI_GATEWAY_API_KEY when set, else the Vercel OIDC
 * token (this request's `x-vercel-oidc-token`, else VERCEL_OIDC_TOKEN, else
 * @vercel/oidc's own lookup). Null when there is none.
 */
export async function gatewayCredential(request: Request): Promise<GatewayCredential | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (key && key.trim()) return { token: key.trim(), authMethod: 'api-key' }
  const header = request.headers.get('x-vercel-oidc-token')
  if (header && header.trim()) return { token: header.trim(), authMethod: 'oidc' }
  const env = process.env.VERCEL_OIDC_TOKEN
  if (env && env.trim()) return { token: env.trim(), authMethod: 'oidc' }
  try {
    const { getVercelOidcToken } = await import('@vercel/oidc')
    const token = await getVercelOidcToken()
    return token ? { token, authMethod: 'oidc' } : null
  } catch {
    return null
  }
}

/** The headers sent upstream: the client's model headers (`ai-language-model-*`), our auth and protocol. */
export function upstreamHeaders(incoming: Headers, cred: GatewayCredential): Headers {
  const out = new Headers()
  incoming.forEach((value, name) => {
    const n = name.toLowerCase()
    if (n.startsWith('ai-language-model-')) out.set(n, value)
  })
  out.set('content-type', 'application/json')
  out.set('authorization', `Bearer ${cred.token}`)
  out.set('ai-gateway-protocol-version', GATEWAY_PROTOCOL_VERSION)
  out.set('ai-gateway-auth-method', cred.authMethod)
  return out
}

/** Response headers passed back (never upstream cookies or auth). */
export function downstreamHeaders(upstream: Headers): Headers {
  const out = new Headers()
  upstream.forEach((value, name) => {
    const n = name.toLowerCase()
    if (n === 'content-type' || n === 'cache-control' || n.startsWith('x-vercel-ai-') || n.startsWith('ai-')) out.set(n, value)
  })
  if (!out.has('cache-control')) out.set('cache-control', 'no-store')
  return out
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface RelayUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  providerMetadata: Record<string, unknown> | undefined
  generationId: string | null
  /** No usage came back (a cancelled or cut stream): the tokens are estimated from text. */
  estimated?: boolean
}

/** About four characters a token: the estimate for a call whose usage never came back. */
const CHARS_PER_TOKEN = 4

/**
 * A call's usage estimated from what the relay saw: the request body's text
 * for input, the streamed deltas for output. Never zero: a forwarded call
 * always costs at least its input. Priced by the RPC from the tokens.
 */
export function estimateUsage(inputChars: number, outputChars: number): RelayUsage {
  return {
    inputTokens: Math.max(1, Math.ceil(inputChars / CHARS_PER_TOKEN)),
    outputTokens: Math.max(0, Math.ceil(outputChars / CHARS_PER_TOKEN)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerMetadata: undefined,
    generationId: null,
    estimated: true,
  }
}

function tokens(v: unknown): { total: number; cacheRead: number; cacheWrite: number } {
  if (typeof v === 'number' && Number.isFinite(v)) return { total: v, cacheRead: 0, cacheWrite: 0 }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    return { total: n(o.total), cacheRead: n(o.cacheRead), cacheWrite: n(o.cacheWrite) }
  }
  return { total: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Usage from a generate result or a stream's `finish` part (LanguageModelV4Usage, or flat numbers). Null when absent. */
export function usageOf(value: unknown): RelayUsage | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!v.usage || typeof v.usage !== 'object') return null
  const u = v.usage as Record<string, unknown>
  const input = tokens(u.inputTokens)
  const output = tokens(u.outputTokens)
  const providerMetadata =
    v.providerMetadata && typeof v.providerMetadata === 'object' ? (v.providerMetadata as Record<string, unknown>) : undefined
  const gateway = providerMetadata?.gateway as Record<string, unknown> | undefined
  const generationId = typeof gateway?.generationId === 'string' && gateway.generationId ? gateway.generationId : null
  return {
    inputTokens: input.total,
    outputTokens: output.total,
    cacheReadTokens: input.cacheRead,
    cacheWriteTokens: input.cacheWrite,
    providerMetadata,
    generationId,
  }
}

/** What a stream showed by its end: the finish part's usage, else how much output went by. */
export interface StreamTally {
  usage: RelayUsage | null
  /** Characters of model output seen (text, reasoning and tool-input deltas, whole tool calls). */
  outputChars: number
  /** The client went away before the stream ended. */
  cancelled: boolean
}

function outputCharsOf(part: Record<string, unknown>): number {
  if (typeof part.delta === 'string') return part.delta.length
  if (part.type === 'tool-call' && typeof part.input === 'string') return part.input.length
  return 0
}

/**
 * Pass an SSE body through unchanged, reading the `finish` part's usage and
 * tallying the output deltas on the way past. `onDone(tally)` runs once: when
 * the stream ends, errors, or the client cancels (the upstream fetch is then
 * aborted to stop the spend; the tally still carries the output seen, so the
 * caller can meter an estimate: a cancel is never free).
 */
export function meterSse(
  body: ReadableStream<Uint8Array>,
  onDone: (tally: StreamTally) => void,
  abortUpstream: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let usage: RelayUsage | null = null
  let outputChars = 0
  let done = false
  const finish = (cancelled: boolean) => {
    if (done) return
    done = true
    onDone({ usage, outputChars, cancelled })
  }
  const scan = (text: string, flush: boolean) => {
    pending += text
    const lines = pending.split('\n')
    pending = flush ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const isFinish = line.includes('"finish"')
      if (!isFinish && !line.includes('"delta"') && !line.includes('"tool-call"')) continue
      try {
        const part = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
        if (part?.type === 'finish') usage = usageOf(part) ?? usage
        else outputChars += outputCharsOf(part)
      } catch {
        /* not JSON: not ours to read */
      }
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: end } = await reader.read()
        if (end) {
          scan(decoder.decode(), true)
          controller.close()
          finish(false)
          return
        }
        scan(decoder.decode(value, { stream: true }), false)
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        finish(false)
      }
    },
    cancel(reason) {
      abortUpstream()
      reader.cancel(reason).catch(() => undefined)
      finish(true)
    },
  })
}

/** In-flight model calls a person may hold at once (across every server instance). */
export const MAX_CALLS_IN_FLIGHT = 4
/** A slot outlives the route's maxDuration a little, then frees itself. */
export const SLOT_TTL_SECONDS = 330
