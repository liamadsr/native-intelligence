/**
 * The spec's `modelPolicy`, and the eve model selection it becomes: how the
 * spec's model is called (its context window, its thinking, and which AI
 * Gateway hosts may serve it). Mirrors the Next-side `ChatModelPolicy`
 * (src/lib/ai/models.ts: chatModelPolicy for chat, deepseekSurfacePolicy for
 * the other surfaces), JSON only.
 *
 * A copy of agents/chat-agent/lib/model-policy.ts (the eve bundler can't
 * share code across agents); agents/chat-agent/lib/__tests__/
 * model-policy-drift.test.ts keeps the copies identical.
 */

/** JSON-serializable value/object: a structural mirror of eve's JsonValue / JsonObject. */
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * The reasoning efforts eve accepts on a model selection: the AI SDK's
 * `CallSettings.reasoning` values, checked by eve's resolveRuntimeModelSelection
 * (dist/src/runtime/agent/resolve-model.js), which throws on anything else.
 */
const REASONING_EFFORTS = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** How the AI Gateway may rank the hosts allowed to serve a call. */
const GATEWAY_SORTS = ['ttft', 'tps', 'cost'] as const

/**
 * AI Gateway routing as it rides the spec wire, merged into
 * `providerOptions.gateway` beside the telemetry: `only` restricts the hosts,
 * `order` prefers some (and still falls back to unlisted ones), `sort` ranks
 * the allowed hosts by live first-token latency, throughput or cost. A `type`
 * alias, not an interface: eve types providerOptions as Record<string,
 * JsonObject>, and only a type alias satisfies that index signature.
 */
export type GatewayRouting = {
  only?: string[]
  order?: string[]
  sort?: (typeof GATEWAY_SORTS)[number]
}

/**
 * The policy as the agent reads it. Every field is optional: the wire may come
 * from a neighbouring deployment, and validModelPolicy keeps only the fields
 * that validate.
 */
export type ModelPolicy = {
  contextWindowTokens?: number
  reasoning?: ReasoningEffort
  providerOptions?: Record<string, JsonObject>
  gateway?: GatewayRouting
}

/**
 * Shape-guard a spec's `modelPolicy` before it rides a model selection. Each
 * field is checked against what eve's resolveRuntimeModelSelection accepts, and
 * one that doesn't validate is DROPPED, never thrown on: a resolver throw or an
 * invalid selection fails the turn with MODEL_SELECTION_FAILED.
 *   - `reasoning`: one of REASONING_EFFORTS.
 *   - `contextWindowTokens`: a positive integer (eve's own rule).
 *   - `providerOptions`: each entry a plain JSON object; a bad entry is dropped
 *     on its own. A `gateway` entry is dropped too: routing travels in
 *     `gateway` and attribution in the telemetry.
 *   - `gateway`: `only` / `order` non-empty arrays of non-empty strings (an
 *     empty `only` would leave no host to serve the call), `sort` one of
 *     GATEWAY_SORTS.
 * Null when nothing survives: the resolver then calls the model as it did
 * before the policy existed.
 */
export function validModelPolicy(p: unknown): ModelPolicy | null {
  if (!isPlainObject(p)) return null
  const guarded: ModelPolicy = {}
  if (isReasoningEffort(p.reasoning)) guarded.reasoning = p.reasoning
  if (isPositiveInteger(p.contextWindowTokens)) guarded.contextWindowTokens = p.contextWindowTokens
  const providerOptions = validPolicyProviderOptions(p.providerOptions)
  if (providerOptions) guarded.providerOptions = providerOptions
  const gateway = validGatewayRouting(p.gateway)
  if (gateway) guarded.gateway = gateway
  return Object.keys(guarded).length > 0 ? guarded : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A value eve's parseJsonObject accepts: finite numbers, plain objects, arrays (depth-bounded). */
function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 8) return false
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1))
  if (isPlainObject(v)) return Object.values(v).every((x) => isJsonValue(x, depth + 1))
  return false
}

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function validPolicyProviderOptions(v: unknown): Record<string, JsonObject> | null {
  if (!isPlainObject(v)) return null
  const out: Record<string, JsonObject> = {}
  for (const [provider, opts] of Object.entries(v)) {
    if (provider === 'gateway') continue
    if (isPlainObject(opts) && isJsonValue(opts)) out[provider] = opts as JsonObject
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A non-empty list of non-empty Gateway host slugs. */
function isHostList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim() !== '')
}

function validGatewayRouting(v: unknown): GatewayRouting | null {
  if (!isPlainObject(v)) return null
  const out: GatewayRouting = {}
  if (isHostList(v.only)) out.only = [...v.only]
  if (isHostList(v.order)) out.order = [...v.order]
  const sort = v.sort
  if (typeof sort === 'string' && (GATEWAY_SORTS as readonly string[]).includes(sort)) {
    out.sort = sort as GatewayRouting['sort']
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The share of a model selection's window at which eve compacts: the agent's
 * `compaction.thresholdPercent`, set EXPLICITLY in each agent.ts that uses
 * this file (it equals eve's default, 0.9) so every window below means what
 * it says even if eve's default moves. eve 0.79.1 computes the threshold as
 * floor(modelContextWindowTokens × thresholdPercent) for every selection
 * (harness/model-call/model.js updateCompactionThresholdForModelReference;
 * execution/session.js createCompactionConfig for the first one).
 *
 * Why the WINDOW is the knob, not thresholdPercent: thresholdPercent is one
 * static fraction per agent, while the model (and so its real window) is
 * chosen per run or per turn, from 200K to 1M. An absolute target needs a
 * per-selection number, and the selection's window is the only one eve takes.
 */
export const COMPACTION_THRESHOLD_PERCENT = 0.9

/**
 * The mid-conversation compaction safety ceiling: the largest window a
 * session compacts against. Large-window models stay sharp to ~500-600K;
 * routine compaction happens while the person is away (app side), so this
 * only catches a session that grows past that. eve compacts at
 * COMPACTION_THRESHOLD_PERCENT of a selection's modelContextWindowTokens, so a
 * 1M model compacts at 540K instead of 900K; a model with a smaller real
 * window (262K, 200K) keeps its own 90%. eve reads the window for nothing else
 * (harness/compaction/engine.js sizes its summary budget and kept window from
 * the same threshold): it never caps input or validates a request against it.
 */
export const COMPACTION_WINDOW_TOKENS = 600_000

/**
 * The window to hand eve for a model whose real window is
 * `contextWindowTokens`: the smaller of the two. Unknown stays unknown (eve
 * then uses its 100K default threshold).
 */
export function compactionWindow(contextWindowTokens?: number): number | undefined {
  if (!contextWindowTokens || contextWindowTokens <= 0) return undefined
  return Math.min(contextWindowTokens, COMPACTION_WINDOW_TOKENS)
}

/** The policy with its window capped by {@link compactionWindow}. */
export function withCompactionWindow(policy: ModelPolicy | null): ModelPolicy | null {
  const window = compactionWindow(policy?.contextWindowTokens)
  return policy && window ? { ...policy, contextWindowTokens: window } : policy
}

/**
 * The real context windows of the models the app runs, by Gateway slug: the
 * same numbers as src/lib/ai/models.ts chatModelPolicy (a drift test pins
 * them). A spec policy carries a window only for DeepSeek on the background
 * surfaces (deepseekSurfacePolicy), so without this every other model fell
 * back to eve's Gateway catalog window (a 1M model compacting at 900K) or,
 * when the lookup failed, eve's 100K default.
 */
export const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-sonnet-5.5': 1_000_000,
  'anthropic/claude-opus-5.5': 1_000_000,
  'anthropic/claude-haiku-5.5': 1_000_000,
  'openai/gpt-5.6-terra': 1_000_000,
  'openai/gpt-5.6-luna': 1_000_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
}

/**
 * The policy for `model` with the compaction ceiling applied to every model:
 * the policy's own window when it carries one, else the model's known real
 * window (KNOWN_CONTEXT_WINDOWS), capped by {@link compactionWindow}. A model
 * of unknown window keeps eve's own (its catalog window): handing eve 600K
 * for a smaller model would push its threshold past what the model accepts.
 */
export function withCompactionWindowFor(model: string, policy: ModelPolicy | null): ModelPolicy | null {
  if (policy?.contextWindowTokens) return withCompactionWindow(policy)
  const window = compactionWindow(KNOWN_CONTEXT_WINDOWS[model])
  return window ? { ...policy, contextWindowTokens: window } : policy
}

/** Gateway attribution, already shape-guarded by the agent's validGatewayTelemetry. */
export type PolicyTelemetry = { user?: string; tags: string[] }

/**
 * The value a model resolver returns to eve: a bare model-id STRING, or the
 * OBJECT selection form. Exactly the keys eve's resolveRuntimeModelSelection
 * accepts ({ model, reasoning?, modelContextWindowTokens?, modelOptions? }; any
 * other key throws); eve merges providerOptions into every step call.
 */
export type ModelSelection =
  | string
  | {
      model: string
      reasoning?: ReasoningEffort
      modelContextWindowTokens?: number
      modelOptions?: { providerOptions: Record<string, JsonObject> }
    }

/**
 * The selection for `model` with valid attribution and a validated policy. The
 * policy adds `reasoning` and `modelContextWindowTokens`, its provider options
 * beside `gateway`, and its host routing inside `gateway` next to user/tags.
 * eve's `mergeGatewayAutoCaching` (harness/prompt-cache.js) shallow-merges
 * `caching: 'auto'` into that same entry, so the routing survives. With neither
 * it is the plain string, exactly as before either existed.
 */
export function selectionWithPolicy(
  model: string,
  telemetry: PolicyTelemetry | null,
  policy: ModelPolicy | null,
): ModelSelection {
  if (!telemetry && !policy) return model
  const gateway = { ...telemetry, ...policy?.gateway }
  const providerOptions: Record<string, JsonObject> = {
    ...policy?.providerOptions,
    ...(Object.keys(gateway).length > 0 ? { gateway } : {}),
  }
  return {
    model,
    ...(policy?.reasoning ? { reasoning: policy.reasoning } : {}),
    ...(policy?.contextWindowTokens ? { modelContextWindowTokens: policy.contextWindowTokens } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { modelOptions: { providerOptions } } : {}),
  }
}
