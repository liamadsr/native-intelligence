/**
 * The live-agent eve mount's ONLY link to the Next app: fetch the rebuilt turn
 * spec, and dispatch tool calls (LIVE-AGENT-DESIGN §5).
 *
 * The eve runtime is a SEPARATE service from the Next app. The cloud route
 * (`POST /api/ai/live-agent`) mints an HMAC-signed run token per turn; the
 * resolvers read it off the session principal
 * (`ctx.session.auth.current.attributes.runToken`) and call
 *   GET  /api/internal/live-agent/spec   → system prompt, model, tool ceiling
 *   POST /api/internal/live-agent/tool   → run ONE real tool, ceiling re-checked
 * with it plus the shared internal secret. Everything is REBUILT server-side
 * from live DB state; nothing Next-coupled compiles into this runtime.
 */
import type { SessionAuth } from 'eve/context'
import type { PlanProxy } from './chatgpt-plan-model.js'
import {
  selectionWithPolicy,
  validModelPolicy,
  withCompactionWindowFor,
  type ModelPolicy,
  type ModelSelection as PolicyModelSelection,
} from './model-policy.js'

/** Header names — kept in sync with src/lib/live-agent/live-agent-run-token.ts. */
const LIVE_AGENT_SECRET_HEADER = 'x-live-agent-secret'
const LIVE_AGENT_TOKEN_HEADER = 'x-live-agent-token'

/**
 * Per-user Gateway attribution as it rides the spec wire. Mirrors the Next-side
 * `GatewayTelemetryValues` (src/lib/ai/gateway-telemetry.ts). A `type` alias
 * (not an `interface`) on purpose: eve types a model selection's
 * `providerOptions` as `Record<string, JsonObject>`, and only an object-literal
 * type alias structurally satisfies that index signature.
 */
export type GatewayTelemetry = {
  user?: string
  tags: string[]
}

/**
 * Shape-guard a spec's `gatewayTelemetry` before it rides a model selection. A
 * malformed telemetry object must NEVER crash the model resolver (that would
 * kill the turn) — `user` must be a string or absent, `tags` an array of
 * strings; anything else → null and the resolver uses the plain model string.
 */
export function validGatewayTelemetry(t: unknown): GatewayTelemetry | null {
  if (!t || typeof t !== 'object') return null
  const obj = t as Record<string, unknown>
  if (obj.user !== undefined && typeof obj.user !== 'string') return null
  if (!Array.isArray(obj.tags) || !obj.tags.every((x) => typeof x === 'string')) return null
  const guarded: GatewayTelemetry = { tags: obj.tags as string[] }
  if (typeof obj.user === 'string') guarded.user = obj.user
  return guarded
}

/**
 * JSON-serializable value/object — a structural mirror of eve's `JsonValue` /
 * `JsonObject`, which eve does not export from `eve/tools`. `defineTool`
 * accepts a plain JsonObject as `inputSchema`, so the proxies pass the wire
 * schema straight through.
 */
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ToolInputSchemaJson = { readonly [key: string]: JsonValue }

/**
 * The eve-facing turn spec — mirrors the Next-side `LiveAgentSpec`
 * (src/lib/live-agent/live-agent-spec.ts) exactly. NO secrets, NO tenancy.
 */
export interface LiveAgentSpec {
  /** The full 7-layer system prompt, byte-identical to the cloud route's. */
  systemPrompt: string
  /** recipe override → workspace 'live_agent' default, as a Gateway slug. */
  model: string
  /** The structural ceiling (staging ∪ narrowed read). */
  ceiling: string[]
  /** One entry per ceiling tool, each with its real input JSON Schema. */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputSchemaJson }>
  /** Advertised from the first model call (staging + core reads + get_package). */
  coreToolNames: string[]
  assistOnly: boolean
  pairNotes: boolean
  /** False → the turn must not reach the web (eval capture / kill switch). */
  webAccess: boolean
  gatewayTelemetry?: GatewayTelemetry
  /** How `model` is called (lib/model-policy.ts): DeepSeek thinks only on a
   *  batch turn, on private hosts. Absent for other models, and from an app
   *  that predates it. */
  modelPolicy?: ModelPolicy
  /**
   * Present when the turn's person runs on their own ChatGPT plan (the free
   * tier, live-agent-spec.ts): every step then runs on the plan model
   * through the app's plan proxy, never the Gateway. Read only through
   * validChatGptPlan (./chatgpt-plan-model.ts).
   */
  chatgptPlan?: unknown
}

/**
 * What the model resolver returns to eve: a bare Gateway slug, or the OBJECT
 * selection form carrying per-generation Gateway attribution (eve merges
 * modelReference.providerOptions into every step call).
 */
export type ModelSelection = PolicyModelSelection

/**
 * Map a fetched spec to the model selection — the live-agent twin of
 * chat-agent's `modelSelectionFromSpec`, kept pure so both branches are
 * unit-testable:
 *   1. a provider-qualified slug passes through; a bare id (defense-in-depth)
 *      is prefixed 'anthropic/';
 *   2. VALID telemetry → the object form (per-user BYOK/cost attribution on
 *      every generation); absent/malformed → the bare slug;
 *   3. a valid `modelPolicy` adds its reasoning, window, provider options and
 *      host routing (lib/model-policy.ts selectionWithPolicy), the window
 *      capped at the 600K compaction safety ceiling like every agent's. A
 *      turn is one stateless session, so it only matters for an input past
 *      540K (a 1M model would otherwise compact at 900K).
 * Null when the spec carries no model (the resolver then uses its default —
 * returning null to eve would fail the turn terminally).
 */
export function modelSelectionFromSpec(spec: LiveAgentSpec | null): ModelSelection | null {
  if (!spec?.model) return null
  const modelId = spec.model.includes('/') ? spec.model : `anthropic/${spec.model}`
  return selectionWithPolicy(
    modelId,
    validGatewayTelemetry(spec.gatewayTelemetry),
    withCompactionWindowFor(modelId, validModelPolicy(spec.modelPolicy)),
  )
}

/**
 * The dedicated internal secret, falling back to RUN_SKILL_INTERNAL_SECRET
 * (mirrors ./auth.ts). Throws when neither is set so each caller degrades to its
 * own graceful failure path.
 */
function internalSecret(): string {
  const s = process.env.LIVE_AGENT_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) throw new Error('[live-agent] LIVE_AGENT_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  return s
}

/**
 * The Next app's own origin: NEXT_PUBLIC_APP_URL (the internal routes are the
 * app's). In dev the eve sidecar and Next dev share localhost:3000.
 */
function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/**
 * The ChatGPT plan proxy (src/app/api/internal/chatgpt-plan/v1/responses):
 * the base URL a plan model calls, and a fetch that adds this agent's secret
 * and the turn's token to each request as it goes. They
 * ride the fetch, never a provider's `headers`, which the AI SDK's workflow
 * serializer would write out with the model.
 */
export function chatGptPlanProxy(runToken: string): PlanProxy {
  return {
    baseURL: `${appBaseUrl()}/api/internal/chatgpt-plan/v1`,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      // The SDK's placeholder key: the proxy authenticates the turn's token.
      headers.delete('authorization')
      headers.set(LIVE_AGENT_SECRET_HEADER, internalSecret())
      headers.set(LIVE_AGENT_TOKEN_HEADER, runToken)
      return fetch(input, { ...init, headers })
    },
  }
}

/** Read the run token off the verified session principal, or '' when absent. */
export function runTokenFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.runToken
  return typeof raw === 'string' ? raw : ''
}

/**
 * Upper bound on one spec fetch. The spec gates the whole turn (the model
 * resolver fails the session without it), so a hung Next route must fail it
 * promptly rather than hold the session open.
 */
export const SPEC_FETCH_TIMEOUT_MS = 15_000

/**
 * Upper bound on one tool dispatch. Generous: a tool (deep_search, an embed +
 * match_claims dedupe) can legitimately take a while, but a hung route must
 * surface to the model as a failed call it can react to, not stall the turn.
 */
export const TOOL_DISPATCH_TIMEOUT_MS = 120_000

/**
 * How long one run token's fetched spec is reused. A token names ONE turn and
 * its spec is a pure function of that turn's claims + database state, so every
 * resolver of the turn — model, instructions, ask_user, say_to_user and the
 * workspace tools at session.started, the workspace tools again at every
 * step.started, and search_tools — can share one fetch instead of each paying
 * its own round trip + DB rebuild. Bounded well inside the token's 15-minute
 * lifetime, so a very long batch turn still re-reads the spec now and then.
 * Security does not depend on this: the internal tool route re-verifies the
 * token and re-derives the ceiling on every call.
 */
const SPEC_CACHE_TTL_MS = 5 * 60 * 1000
/** Cap on cached turns per runtime instance (oldest evicted first). */
const SPEC_CACHE_MAX_ENTRIES = 256

const specCache = new Map<string, { at: number; spec: Promise<LiveAgentSpec | null> }>()

/** Drop every cached spec (tests). */
export function resetLiveAgentSpecCache(): void {
  specCache.clear()
}

/**
 * Fetch the rebuilt spec for `runToken`, always with the real input JSON
 * Schemas (the proxy-building resolvers need them, and one shared fetch beats
 * two). Concurrent and repeat calls for the same token share one request (see
 * SPEC_CACHE_TTL_MS); a failure is never cached, so the next call retries.
 * Returns null on any failure — logged, never silent — and the caller decides
 * how to fail (the model resolver fails the session; the tool resolvers fall
 * back to their fail-closed surface).
 */
export function fetchLiveAgentSpec(runToken: string): Promise<LiveAgentSpec | null> {
  if (!runToken) return Promise.resolve(null)
  const now = Date.now()
  const hit = specCache.get(runToken)
  if (hit && now - hit.at < SPEC_CACHE_TTL_MS) return hit.spec
  if (hit) specCache.delete(runToken)

  const spec = requestLiveAgentSpec(runToken).then((result) => {
    if (result === null && specCache.get(runToken)?.spec === spec) specCache.delete(runToken)
    return result
  })
  specCache.set(runToken, { at: now, spec })
  while (specCache.size > SPEC_CACHE_MAX_ENTRIES) {
    const oldest = specCache.keys().next().value
    if (oldest === undefined) break
    specCache.delete(oldest)
  }
  return spec
}

async function requestLiveAgentSpec(runToken: string): Promise<LiveAgentSpec | null> {
  const url = `${appBaseUrl()}/api/internal/live-agent/spec?schemas=1`
  try {
    const secret = internalSecret()
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [LIVE_AGENT_SECRET_HEADER]: secret,
        [LIVE_AGENT_TOKEN_HEADER]: runToken,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[live-agent] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    return (await res.json()) as LiveAgentSpec
  } catch (err) {
    console.error(`[live-agent] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Dispatch ONE tool call to the Next app's internal tool route. Returns the
 * tool's output on success; THROWS on any failure so eve turns it into a
 * `tool-result {isError: true}` the model can read and adapt to within the same
 * turn (matching the AI-SDK error tool-results of the cloud route). The run
 * token scopes tenancy + ceiling server-side; the model supplies only `input`.
 * The message carries the route's `details` (the Zod error on INPUT_INVALID).
 */
export async function dispatchLiveAgentTool(
  toolName: string,
  runToken: string,
  input: unknown,
): Promise<unknown> {
  if (!runToken) {
    throw new Error(`${toolName}: no run token on this session — tool call refused (NO_RUN_TOKEN)`)
  }
  let secret: string
  try {
    secret = internalSecret()
  } catch (err) {
    throw new Error(
      `${toolName}: tool dispatch unavailable — ${err instanceof Error ? err.message : 'runtime misconfigured'}`,
    )
  }
  const url = `${appBaseUrl()}/api/internal/live-agent/tool`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [LIVE_AGENT_SECRET_HEADER]: secret,
        [LIVE_AGENT_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify({ toolName, input }),
      redirect: 'error',
      signal: AbortSignal.timeout(TOOL_DISPATCH_TIMEOUT_MS),
    })
  } catch (err) {
    console.error(`[live-agent] tool dispatch errored: ${toolName} — ${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof Error && err.name === 'TimeoutError') {
      // The route may still have run the call — a blind retry could stage it twice.
      throw new Error(
        `${toolName}: the workspace did not answer within ${TOOL_DISPATCH_TIMEOUT_MS / 1000}s. ` +
          'The call may still have gone through — check before calling it again.',
      )
    }
    throw new Error(
      `${toolName}: tool dispatch failed to reach the workspace (${err instanceof Error ? err.message : 'network error'}). You may retry once.`,
    )
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    console.error(`[live-agent] tool dispatch failed: ${toolName} ${res.status} ${url}`)
    const error = typeof json.error === 'string' ? json.error : `tool dispatch failed (${res.status})`
    const code = typeof json.code === 'string' ? ` [${json.code}]` : ''
    const details = typeof json.details === 'string' && json.details ? ` — ${json.details}` : ''
    throw new Error(`${toolName}: ${error}${code}${details}`)
  }
  return json.output
}
