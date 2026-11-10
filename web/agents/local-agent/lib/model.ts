/**
 * The local agent's model: a provider-built LanguageModel, reached one of
 * three ways (docs/plans/local-agents.md §3 "The model"; L1 contract D1;
 * docs/plans/teammate-agent.md L4):
 *
 *   - **A model on this Mac** (L4, the private option). The desktop passes
 *     LOCAL_AGENT_LOCAL_MODEL_BASE_URL (Ollama's or LM Studio's
 *     OpenAI-compatible server, `http://127.0.0.1:<port>/v1`) and
 *     LOCAL_AGENT_LOCAL_MODEL_ID (the id as that server lists it), plus
 *     LOCAL_AGENT_LOCAL_MODEL_SERVER (`ollama` | `lmstudio`). The provider is
 *     `createOpenAICompatible` with a `fetch` (localModelFetch) that refuses
 *     any URL outside that loopback server and any redirect, so model calls
 *     never leave the Mac. Only the Native Intelligence tool calls do (C1), and a relay or
 *     Gateway credential beside a local model is refused. The fetch probes the
 *     server before the first request: is it up, is the model there, is it
 *     really on this Mac (not an Ollama cloud model), can it call tools, and
 *     how much context did the server give it (eve compacts before that; below
 *     32K it refuses). The server's failures become sentences the person can
 *     act on.
 *   - **The Native Intelligence model relay** (L1, the default in the app). The desktop gives
 *     the launcher LOCAL_AGENT_MODEL_BASE_URL (built by Rust from the app's own
 *     origin: `<origin>/api/local-agent/model`) and a short-lived per-session
 *     LOCAL_AGENT_MODEL_TOKEN. The launcher writes the token to a 0600 file in
 *     the job dir and gives this server only the file's path
 *     (LOCAL_AGENT_MODEL_TOKEN_FILE), never the token itself. The provider is
 *     `createGateway({ baseURL: <relay>, apiKey, fetch })`, where `fetch` puts
 *     the file's CURRENT token in the Authorization header of every request.
 *     A refresh is a `{"type":"token"}` stdin line: the launcher rewrites the
 *     file atomically, and the next model request carries the new token. No
 *     restart, no env change, nothing to signal. The gateway key never leaves
 *     the server; this process never holds it.
 *   - **The L0 dev path**, when no relay is configured: the same provider with
 *     the default Gateway URL and AI_GATEWAY_API_KEY from this server's
 *     environment (the launcher reads it from LOCAL_AGENT_DEV_ENV_FILE).
 *
 *
 * **On the person's own ChatGPT plan** (the free tier, docs/plans/chatgpt-free-tier.md):
 * the model token says so (its `cp` flag, src/lib/local-agent/tokens.ts),
 * and each step then runs the plan's model instead: an AI SDK OpenAI
 * Responses model (./chatgpt-plan-model.ts, the one module every plan agent
 * copies) against `<relay>/plan`, through the same relayFetch, so the token
 * still goes only to the relay. The relay calls OpenAI with the person's plan
 * token; nothing reaches the Gateway. Read without the key: it only picks the
 * route, and the relay's Gateway path refuses a free user whatever it says.
 * Read from the token file every step, like the token itself: a refreshed
 * token that gained or lost the flag (a plan check that failed at claim, a
 * person who subscribed) moves the job's next step to the matching route.
 *
 * That step's selection (localAgentPlanStep) is what the Mac body's model
 * (agents/chat-agent/lib/mac-model.ts, step.started) returns, ahead of
 * createLocalAgentModel's: eve compiles a static model's settings from the
 * BUILD's environment and takes only the LanguageModel at runtime, so the
 * plan's `store: false` (modelOptions) reaches a call only from a step
 * selection. Without it the SDK sends a step's earlier items as references to
 * responses the plan route never stored, and the second step of every
 * tool-using turn fails.
 *
 * Tripwire: `createGateway` from 'ai' and `createOpenAICompatible` from
 * '@ai-sdk/openai-compatible' are pinned to this one file
 * (eve-everywhere-tripwire.test.ts AI_VALUE_FILE_PINS and
 * PROVIDER_IMPORT_ALLOWLIST; founder decision 7, docs/plans/local-agents.md
 * §9). The model is handed to eve, which owns every call (agent.ts); nothing
 * here calls it. The probe below reads the server's model list and model
 * details; on Ollama it also loads the model (an empty prompt, which loads
 * it as the job's requests will and generates nothing) to read the context it
 * gets.
 */
import { readFileSync } from 'node:fs'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createGateway, type LanguageModel } from 'ai'
import { PLAN_WINDOW_TOKENS, planLanguageModel } from './chatgpt-plan-model.js'

/**
 * The same static model as SURFACE_MODELS.coding_runs (STRONG_MODEL,
 * src/lib/ai/model-defaults.ts). eve roots cannot import from src, so this is
 * a copied literal; update both together. The relay's model allowlist must
 * include it.
 */
export const LOCAL_AGENT_MODEL = 'anthropic/claude-sonnet-5.5'

/**
 * The ChatGPT plan model a local agent runs for a person on their own plan:
 * Sol, the plan's main model (PLAN_MAIN_MODEL in src/lib/chatgpt/plan-models.ts),
 * since a local agent does the main agent's work in the person's folder.
 */
export const LOCAL_AGENT_PLAN_MODEL = 'gpt-6.1-sol'

/** A model token: opaque, printable ASCII without spaces (header-safe), at most 2 KB (contract C3). */
export const MODEL_TOKEN = /^[\x21-\x7e]{16,2048}$/

/** The environment as read here (process.env, or a plain object in tests). */
type ModelEnv = Readonly<Record<string, string | undefined>>

/** The model servers the desktop offers (it passes their fixed loopback URLs). */
export type LocalModelServer = 'ollama' | 'lmstudio'

export type LocalModelRoute = {
  readonly kind: 'local'
  readonly baseURL: string
  readonly modelId: string
  /** Null when the desktop named no known server: messages then say "the model server". */
  readonly server: LocalModelServer | null
}

export type ModelRoute = { readonly kind: 'relay'; readonly baseURL: string; readonly tokenFile: string } | { readonly kind: 'dev' } | LocalModelRoute

/**
 * eve's compaction window for the Gateway and relay routes (agent.ts). A
 * model on the Mac uses the context its server really allocated, which the
 * probe reads (localAgentContextWindow).
 */
export const LOCAL_AGENT_CONTEXT_WINDOW = 250_000

/**
 * The least context a model on the Mac may run with: the agent's instructions
 * and tools alone take a good part of it. Below it the probe refuses with the
 * setting to change; it is also the window used until the probe has read the
 * real one (smaller than any real one it accepts, so eve compacts early, never late).
 */
export const MIN_LOCAL_MODEL_CONTEXT = 32_768
/** The most context a reported number counts for: no model on a Mac has more, so a larger one is a server's mistake. */
export const MAX_LOCAL_MODEL_CONTEXT = 2_000_000

/** A model id as a local server lists it: printable ASCII without spaces (`qwen3:30b`, `openai/gpt-oss-20b`). */
export const LOCAL_MODEL_ID = /^[\x21-\x7e]{1,256}$/

/**
 * The base URL of a model server on this Mac, or null when it cannot be one:
 * http(s) to 127.0.0.1 or [::1] only (never a name a resolver could point
 * elsewhere), with no credentials, query or fragment. Trailing slashes are
 * dropped.
 */
export function localModelBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, '')
}

/** The relay's and the Gateway's credentials: never beside a model on the Mac. */
const RELAY_CREDENTIALS = ['LOCAL_AGENT_MODEL_BASE_URL', 'LOCAL_AGENT_MODEL_TOKEN_FILE', 'LOCAL_AGENT_MODEL_TOKEN', 'AI_GATEWAY_API_KEY'] as const

function localModelRouteFromEnv(env: ModelEnv): LocalModelRoute {
  const baseURL = localModelBaseUrl(env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL)
  if (!baseURL) throw new Error('local-agent model: LOCAL_AGENT_LOCAL_MODEL_BASE_URL is missing or not a loopback URL on this Mac')
  const modelId = env.LOCAL_AGENT_LOCAL_MODEL_ID
  if (!modelId || !LOCAL_MODEL_ID.test(modelId)) throw new Error('local-agent model: LOCAL_AGENT_LOCAL_MODEL_ID is missing or not a model id')
  const rawServer = env.LOCAL_AGENT_LOCAL_MODEL_SERVER
  const server = rawServer === 'ollama' || rawServer === 'lmstudio' ? rawServer : null
  // A model call never goes anywhere but the Mac: a relay or Gateway credential beside a local model is a
  // half-configured launch, refused like the launcher refuses it (the C1 session token has its own name).
  const stray = RELAY_CREDENTIALS.filter((k) => env[k])
  if (stray.length) throw new Error(`local-agent model: ${stray.join(', ')} must not be set with a model on this Mac`)
  return { kind: 'local', baseURL, modelId, server }
}


/**
 * The relay base URL, or null when it is not one the relay can be: an
 * absolute https URL (http only to loopback, for `next dev`), with no
 * credentials, query or fragment. Trailing slashes are dropped.
 */
export function relayBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, '')
}

/**
 * Which way this server reaches the model, from its environment. A model on
 * this Mac when LOCAL_AGENT_LOCAL_MODEL_BASE_URL or LOCAL_AGENT_LOCAL_MODEL_ID
 * is set: then both must be valid, and no relay or Gateway credential may be
 * set beside them (the C1 session token for the Native Intelligence tool routes comes as
 * LOCAL_AGENT_SESSION_TOKEN_FILE, which the model never reads). Otherwise relay when both LOCAL_AGENT_MODEL_BASE_URL and
 * LOCAL_AGENT_MODEL_TOKEN_FILE are set; dev when neither is. Anything in
 * between throws: a half-configured route must not fall back to another.
 */
export function modelRouteFromEnv(env: ModelEnv): ModelRoute {
  if (env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL || env.LOCAL_AGENT_LOCAL_MODEL_ID) return localModelRouteFromEnv(env)
  const rawBase = env.LOCAL_AGENT_MODEL_BASE_URL
  const tokenFile = env.LOCAL_AGENT_MODEL_TOKEN_FILE
  if (!rawBase && !tokenFile) return { kind: 'dev' }
  const baseURL = relayBaseUrl(rawBase)
  if (!baseURL) throw new Error('local-agent model: LOCAL_AGENT_MODEL_BASE_URL is missing or not an https URL')
  if (!tokenFile || !tokenFile.startsWith('/')) throw new Error('local-agent model: LOCAL_AGENT_MODEL_TOKEN_FILE is missing or not absolute')
  return { kind: 'relay', baseURL, tokenFile }
}

/** The current model token from the launcher's file; throws (and nothing is sent) when it is missing or malformed. */
export function readModelToken(tokenFile: string): string {
  let token: string
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch {
    throw new Error('local-agent model: the model token file could not be read')
  }
  if (!MODEL_TOKEN.test(token)) throw new Error('local-agent model: the model token file does not hold a token')
  return token
}

type Fetch = typeof globalThis.fetch

/**
 * A fetch for the relay provider: every request must go to the relay (the
 * token is never sent anywhere else) and carries the token read from the file
 * at that moment, replacing the placeholder the provider put in.
 */
export function relayFetch(route: Extract<ModelRoute, { kind: 'relay' }>, base: Fetch = globalThis.fetch): Fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== route.baseURL && !url.startsWith(`${route.baseURL}/`)) {
      throw new Error('local-agent model: refusing to send the model token outside the relay')
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('authorization', `Bearer ${readModelToken(route.tokenFile)}`)
    return input instanceof Request ? base(new Request(input, { ...init, headers })) : base(input, { ...init, headers })
  }
}

// ── A model on this Mac ──────────────────────────────────────────────────────

function serverName(route: LocalModelRoute): string {
  return route.server === 'ollama' ? 'Ollama' : route.server === 'lmstudio' ? 'LM Studio' : 'the model server'
}

/** What the person reads when the server is not answering, the model is missing, or it cannot call tools. */
export const localModelMessages = {
  unreachable: (r: LocalModelRoute) => `The model server on this Mac isn't answering at ${r.baseURL}. Start ${serverName(r)} and try again.`,
  notAvailable: (r: LocalModelRoute) =>
    `${r.modelId} isn't available on this Mac's model server. ${
      r.server === 'ollama' ? `Pull it with \`ollama pull ${r.modelId}\`, then try again.` : r.server === 'lmstudio' ? 'Download and load it in LM Studio, then try again.' : 'Load it, then try again.'
    }`,
  noTools: (r: LocalModelRoute) => `${r.modelId} can't call tools, and the local agent needs a model that can. Pick another model on this Mac (for example gpt-oss:20b or qwen3).`,
  cloud: (r: LocalModelRoute) => `${r.modelId} runs on Ollama's servers, not on this Mac. Pick a model that runs on this Mac.`,
  unverified: (r: LocalModelRoute) => `Ollama didn't say where ${r.modelId} runs, so the local agent can't tell it stays on this Mac. Update Ollama, then try again.`,
  loadFailed: (r: LocalModelRoute) => `Ollama couldn't load ${r.modelId}. Check that it runs in Ollama (\`ollama run ${r.modelId}\`), then try again.`,
  unknownContext: (r: LocalModelRoute) =>
    r.server === 'lmstudio'
      ? `${r.modelId} isn't loaded in LM Studio, so how much context it has isn't known. Load it with a context length of at least ${MIN_LOCAL_MODEL_CONTEXT}, then try again.`
      : r.server === 'ollama'
        ? `Couldn't tell how much context Ollama gives ${r.modelId}. Update Ollama and start it with OLLAMA_CONTEXT_LENGTH=${MIN_LOCAL_MODEL_CONTEXT} (or more), then try again.`
        : `Couldn't tell how much context the model server gives ${r.modelId}, so the local agent won't run on it.`,
  tooSmall: (r: LocalModelRoute, tokens: number) =>
    r.server === 'lmstudio'
      ? `LM Studio loaded ${r.modelId} with only ${tokens} tokens of context, and the local agent needs at least ${MIN_LOCAL_MODEL_CONTEXT}. Reload it with a context length of at least ${MIN_LOCAL_MODEL_CONTEXT}, then try again.`
      : `${serverName(r)} gives ${r.modelId} only ${tokens} tokens of context, and the local agent needs at least ${MIN_LOCAL_MODEL_CONTEXT}.${
          r.server === 'ollama' ? ` Restart Ollama with OLLAMA_CONTEXT_LENGTH=${MIN_LOCAL_MODEL_CONTEXT} (or more), then try again.` : ''
        }`,
  tooLong: (r: LocalModelRoute) => `The conversation no longer fits ${r.modelId}'s context window. Give the model a larger context in ${serverName(r)}, or start a new job.`,
  badAnswer: (r: LocalModelRoute, status: number) => `The model server on this Mac answered ${status} when asked for its models (${r.baseURL}/models).`,
} as const

function isAbort(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined
  return name === 'AbortError' || name === 'TimeoutError'
}

/** `p`, or the signal's abort as soon as it fires (the probe is shared, so it is never aborted itself). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p
  const reason = () => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  if (signal.aborted) return Promise.reject(reason())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** A failed model request as a sentence for the person, or null to let the provider's own error stand. */
export async function describeLocalModelFailure(route: LocalModelRoute, res: Response): Promise<string | null> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 4096).toLowerCase()
  } catch {
    // unreadable body: decide on the status alone
  }
  if (/does not support tools|doesn't support tools|tools? (?:are |is )?not supported|not support(?:ed)? (?:for )?(?:tool|function) call/.test(body)) return localModelMessages.noTools(route)
  if (/context (?:length|window|size)|too many tokens|exceeds? the (?:maximum )?context|greater than the context/.test(body)) return localModelMessages.tooLong(route)
  // "Not found" only about the model: by its id, or as `model "<id>" not found`, never any other thing not found.
  const id = route.modelId.toLowerCase()
  const missing =
    /no models? (?:is |are )?loaded|try pulling it/.test(body) ||
    (body.includes(id) && /\bnot (?:found|loaded)\b/.test(body)) ||
    /\bmodel ["'`]?[\w.:/@+-]+["'`]? (?:is |was )?not (?:found|loaded)/.test(body)
  if (res.status === 404 || missing) return localModelMessages.notAvailable(route)
  return null
}

const PROBE_TIMEOUT_MS = 5000
/** Loading a large model from disk takes a while. */
const LOAD_TIMEOUT_MS = 120_000

async function fetchJson(base: Fetch, url: string, init: RequestInit = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ status: number; json: unknown } | null> {
  const res = await base(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) return { status: res.status, json: null }
  try {
    return { status: res.status, json: await res.json() }
  } catch {
    return { status: res.status, json: null }
  }
}

/** The context each probed model got, by server and model: what eve compacts before (localAgentContextWindow). */
const probedContexts = new Map<string, number>()
const routeKey = (r: LocalModelRoute) => `${r.baseURL}\n${r.modelId}`

/** A whole number of tokens from a server's answer, or null. */
function tokens(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/** Ollama's `num_ctx` from a model's Modelfile parameters (`/api/show` `parameters`), or null. */
function modelfileNumCtx(show: unknown): number | null {
  const params = show && typeof show === 'object' ? (show as { parameters?: unknown }).parameters : undefined
  const m = typeof params === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(params) : null
  return m ? tokens(Number(m[1])) : null
}

/** The context Ollama allocated to a loaded model (`/api/ps`), or null when it isn't loaded or doesn't say. */
async function ollamaLoadedContext(base: Fetch, origin: string, modelId: string): Promise<number | null> {
  const ps = (await fetchJson(base, `${origin}/api/ps`))?.json as { models?: unknown } | null
  const models = Array.isArray(ps?.models) ? (ps.models as { name?: unknown; model?: unknown; context_length?: unknown }[]) : []
  const loaded = models.find((m) => m && (m.name === modelId || m.model === modelId))
  return loaded ? tokens(loaded.context_length) : null
}

/**
 * Check the model server before the first model request, and read the
 * context it gives the model. Throws the person-facing sentence for:
 *   - a server that doesn't answer, or doesn't list the model;
 *   - an Ollama cloud model (an id ending in `-cloud`, or `/api/show` naming
 *     a `remote_host` / `remote_model`), or an Ollama whose `/api/show`
 *     doesn't answer: Ollama forwards cloud models to ollama.com, so the
 *     conversation would leave the Mac;
 *   - a model that can't call tools (Ollama's `/api/show` `"tools"`, LM
 *     Studio's `/api/v0/models/<id>` `"tool_use"`);
 *   - a context that is unknown, or under MIN_LOCAL_MODEL_CONTEXT.
 *
 * The context is what the server really allocated, never the model's trained
 * maximum (Ollama gives a few thousand tokens by default and silently cuts the
 * start of a longer prompt, instructions and tools first):
 *   - Ollama: `context_length` of the loaded model in `/api/ps`, after
 *     Ollama's empty-prompt load (`POST /api/generate` with `prompt: ""` and
 *     no options, documented as "the model will be loaded into memory"). It
 *     generates nothing, loads the model as the job's requests will (another
 *     client may have loaded it with a different `num_ctx`, which Ollama
 *     reloads), and the first model request would load it anyway. A Modelfile
 *     `num_ctx` is the fallback for an Ollama whose `/api/ps` doesn't say;
 *   - LM Studio: `loaded_context_length` of `/api/v0/models/<id>` (it must
 *     already be loaded);
 *   - another server: unknown, refused.
 * A context over MAX_LOCAL_MODEL_CONTEXT counts as that. Returns the context
 * and records it for localAgentContextWindow. Model
 * lists, model info and a load only: never a generation.
 */
export async function probeLocalModel(route: LocalModelRoute, base: Fetch = globalThis.fetch): Promise<number> {
  const origin = new URL(route.baseURL).origin
  let list: { status: number; json: unknown } | null
  try {
    list = await fetchJson(base, `${route.baseURL}/models`)
  } catch {
    throw new Error(localModelMessages.unreachable(route))
  }
  if (!list || list.status >= 400) throw new Error(localModelMessages.badAnswer(route, list?.status ?? 0))
  const data = (list.json as { data?: unknown } | null)?.data
  const ids = Array.isArray(data) ? data.map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined)) : []
  if (!ids.includes(route.modelId)) throw new Error(localModelMessages.notAvailable(route))
  if (/[-:]cloud$/i.test(route.modelId)) throw new Error(localModelMessages.cloud(route))

  let info: Record<string, unknown> | null = null
  try {
    const json =
      route.server === 'ollama'
        ? (await fetchJson(base, `${origin}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: route.modelId }) }))?.json
        : route.server === 'lmstudio'
          ? (await fetchJson(base, `${origin}/api/v0/models/${encodeURIComponent(route.modelId)}`))?.json
          : null
    info = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  } catch {
    info = null // no native endpoint: the context stays unknown below
  }
  // Ollama must say where the model runs before anything loads it: a cloud model renamed with `ollama cp` keeps
  // no `-cloud` in its id, and loading it would reach ollama.com.
  if (route.server === 'ollama' && !info) throw new Error(localModelMessages.unverified(route))
  if (info && (info.remote_host || info.remote_model)) throw new Error(localModelMessages.cloud(route))
  const caps = info?.capabilities
  if (Array.isArray(caps) && !caps.includes('tools') && !caps.includes('tool_use')) throw new Error(localModelMessages.noTools(route))

  let context: number | null = null
  if (route.server === 'ollama') {
    // Load it as the job's requests will (no options): Ollama reloads a model another client loaded with a
    // different num_ctx, so what /api/ps says before this may not be what the job gets. Already loaded so: a no-op.
    let load: { status: number } | null = null
    try {
      load = await fetchJson(base, `${origin}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: route.modelId, prompt: '', stream: false }) }, LOAD_TIMEOUT_MS)
    } catch {
      load = null
    }
    if (!load || load.status >= 400) throw new Error(localModelMessages.loadFailed(route))
    try {
      context = (await ollamaLoadedContext(base, origin, route.modelId)) ?? modelfileNumCtx(info)
    } catch {
      context = modelfileNumCtx(info)
    }
  } else if (route.server === 'lmstudio') {
    context = tokens(info?.loaded_context_length)
  }
  if (context === null) throw new Error(localModelMessages.unknownContext(route))
  if (context < MIN_LOCAL_MODEL_CONTEXT) throw new Error(localModelMessages.tooSmall(route, context))
  context = Math.min(context, MAX_LOCAL_MODEL_CONTEXT)
  probedContexts.set(routeKey(route), context)
  return context
}

/** One probe per server, model and fetch, shared by the model's requests and resolveLocalAgentContextWindow; a failed one is dropped, so the next asks again. */
const probes = new WeakMap<Fetch, Map<string, Promise<number>>>()

/** Forget the probe, so the next request (or window) reads the server again. */
function dropProbe(route: LocalModelRoute, base: Fetch): void {
  probes.get(base)?.delete(routeKey(route))
}

function sharedProbe(route: LocalModelRoute, base: Fetch): Promise<number> {
  let byRoute = probes.get(base)
  if (!byRoute) probes.set(base, (byRoute = new Map()))
  const key = routeKey(route)
  let probe = byRoute.get(key)
  if (!probe) {
    const mine: Promise<number> = probeLocalModel(route, base).catch((err: unknown) => {
      if (byRoute.get(key) === mine) byRoute.delete(key) // not a newer probe that replaced it
      throw err
    })
    probe = mine
    byRoute.set(key, probe)
  }
  return probe
}

/**
 * A fetch for the local provider: only to the loopback server in the route,
 * never following a redirect (a server must not send the conversation
 * elsewhere), probed once before the first request (again after a failed
 * probe, so starting the server mid-job works). Connection failures and the
 * server's error answers become person-facing sentences; an abort passes
 * through as is, so eve can cancel a turn.
 */
export function localModelFetch(route: LocalModelRoute, base: Fetch = globalThis.fetch): Fetch {
  return async (input, init) => {
    const url = urlOf(input)
    if (url !== route.baseURL && !url.startsWith(`${route.baseURL}/`)) {
      throw new Error('local-agent model: refusing a model request outside the model server on this Mac')
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    await untilAborted(sharedProbe(route, base), signal)
    let res: Response
    try {
      res = input instanceof Request ? await base(new Request(input, { ...init, redirect: 'error' })) : await base(input, { ...init, redirect: 'error' })
    } catch (err) {
      if (isAbort(err, signal)) throw err
      throw new Error(localModelMessages.unreachable(route))
    }
    if (!res.ok) {
      const message = await describeLocalModelFailure(route, res.clone())
      if (message === localModelMessages.tooLong(route)) {
        // The server may have reloaded the model with less context than the probe read (LM Studio unloads an idle
        // model and loads it again at its default): read it again once, so eve compacts at what it has now. A
        // context now under the floor says so instead.
        dropProbe(route, base)
        await untilAborted(sharedProbe(route, base), signal)
      }
      if (message) throw new Error(message)
    }
    return res
  }
}

/**
 * eve's compaction window for this server's route: for a model on the Mac,
 * the context its server gave it (read by the probe, before the first model
 * request); until the probe has run, MIN_LOCAL_MODEL_CONTEXT, which is never
 * more than a context the probe accepts. Else the Gateway window.
 */
export function localAgentContextWindow(env: ModelEnv = process.env): number {
  const route = modelRouteFromEnv(env)
  return route.kind === 'local' ? (probedContexts.get(routeKey(route)) ?? MIN_LOCAL_MODEL_CONTEXT) : LOCAL_AGENT_CONTEXT_WINDOW
}

/**
 * The same window, after the probe: for a model on the Mac, runs it (or joins
 * the one the model's first request runs) and returns the context it read,
 * so even the first model step compacts at the real window, and a refused
 * model fails before eve compacts anything. Throws the probe's sentence. Else
 * the Gateway window. For a per-step resolver (the Mac body's step.started).
 */
export async function resolveLocalAgentContextWindow(env: ModelEnv = process.env, base: Fetch = globalThis.fetch): Promise<number> {
  const route = modelRouteFromEnv(env)
  return route.kind === 'local' ? sharedProbe(route, base) : LOCAL_AGENT_CONTEXT_WINDOW
}

// ── The provider ─────────────────────────────────────────────────────────────

/** Placeholder credential: the provider needs one to build its headers; relayFetch replaces it on every request. */
const RELAY_PLACEHOLDER_KEY = 'replaced-per-request-by-relayFetch'

/**
 * Whether a model token says its person runs on their own ChatGPT plan (its
 * `cp` claim). Read without the key, never throws: a token it can't read is
 * not on the plan.
 */
export function tokenIsOnChatGptPlan(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'la1') return false
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return !!claims && typeof claims === 'object' && (claims as { cp?: unknown }).cp === true
  } catch {
    return false
  }
}

/** Whether this step runs on the person's ChatGPT plan: a relay route whose current token says so. */
export function onChatGptPlanNow(route: ModelRoute): boolean {
  if (route.kind !== 'relay') return false
  try {
    return tokenIsOnChatGptPlan(readModelToken(route.tokenFile))
  } catch {
    // No readable token yet: the Gateway model, which the relay refuses for a free user.
    return false
  }
}

/** The provider-built LanguageModel for this server's route (see the file comment). */
export function createLocalAgentModel(env: ModelEnv = process.env, base?: Fetch): LanguageModel {
  const route = modelRouteFromEnv(env)
  if (route.kind === 'dev') return createGateway({ ...(base ? { fetch: base } : {}) })(LOCAL_AGENT_MODEL)
  if (route.kind === 'local') {
    // No apiKey: nothing to authenticate on loopback, and no Native Intelligence credential is ever sent there.
    return createOpenAICompatible({ name: 'local', baseURL: route.baseURL, includeUsage: true, fetch: localModelFetch(route, base) })(route.modelId)
  }
  return createGateway({ baseURL: route.baseURL, apiKey: RELAY_PLACEHOLDER_KEY, fetch: relayFetch(route, base) })(LOCAL_AGENT_MODEL)
}

/** A step on the person's own ChatGPT plan, as eve takes it from step.started. */
export interface LocalAgentPlanSelection {
  model: LanguageModel
  modelContextWindowTokens: number
  reasoning: 'medium'
  modelOptions: { providerOptions: { openai: { store: false } } }
}

const planSelections = new Map<string, LocalAgentPlanSelection>()

/**
 * This step's model on the person's own ChatGPT plan, or null for every other
 * step (the Mac body's model, agents/chat-agent/lib/mac-model.ts, then takes
 * createLocalAgentModel's). On the relay, when the current token says the
 * person runs on their plan (onChatGptPlanNow, read every step): the plan's
 * model through the relay's plan path, with `store: false` (the plan route
 * keeps nothing, so the SDK carries each step's items and reasoning forward
 * itself), an explicit reasoning effort (a local job is the main agent's kind
 * of work; it spends the person's plan) and the plan's capped window. Built
 * once per relay. A model on the Mac (`local`) is the person's own and the dev
 * key is a developer's: neither is on the plan.
 */
export function localAgentPlanStep(env: ModelEnv = process.env, base?: Fetch): LocalAgentPlanSelection | null {
  const route = modelRouteFromEnv(env)
  if (route.kind !== 'relay' || !onChatGptPlanNow(route)) return null
  let selection = planSelections.get(route.baseURL)
  if (!selection) {
    selection = {
      model: planLanguageModel(LOCAL_AGENT_PLAN_MODEL, { baseURL: `${route.baseURL}/plan`, fetch: relayFetch(route, base) }),
      modelContextWindowTokens: PLAN_WINDOW_TOKENS,
      reasoning: 'medium',
      modelOptions: { providerOptions: { openai: { store: false } } },
    }
    planSelections.set(route.baseURL, selection)
  }
  return selection
}
