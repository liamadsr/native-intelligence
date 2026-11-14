/**
 * Fetch one utility call's spec from the Next app's internal route, for the
 * utility agent's dynamic resolvers (WS-4).
 *
 * The dispatcher (src/lib/eve/utility/run-utility.ts) signed a small token of
 * routing facts; the resolvers read it off the session principal and call
 * GET /api/internal/utility/spec with it (plus the shared internal secret) to
 * get back the model slug, the kind's system prompt and provider options —
 * rebuilt server-side by the kind registry. Nothing Next-coupled compiles into
 * this runtime; only this fetch does.
 */
import { gateway, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import type { SessionAuth } from 'eve/context'
import { PLAN_MODELS, planStepSelection, planTurnSelection, validChatGptPlan, type PlanProxy } from './chatgpt-plan-model.js'

/** Header names — kept in sync with src/lib/eve/utility-run-token.ts. */
const UTILITY_SECRET_HEADER = 'x-utility-run-secret'
const UTILITY_TOKEN_HEADER = 'x-utility-run-token'

/**
 * JSON object — a structural mirror of eve's JsonObject (which `eve` does not
 * export publicly). A `type` alias, not an interface, so it satisfies eve's
 * `Record<string, JsonObject>` providerOptions index signature.
 */
export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface UtilitySpec {
  kind: string
  /** Gateway catalog slug, already provider-qualified server-side. */
  model: string
  /** The kind's system instructions, or null when the kind has none. */
  systemPrompt: string | null
  /** Gateway telemetry + provider tuning, keyed by provider. */
  providerOptions?: Record<string, JsonObject>
  /** Per-call output-token cap (the pre-port call's maxOutputTokens), when the kind has one. */
  maxOutputTokens?: number
  /** How many model steps the session may take (see stepCeilingError). */
  maxSteps?: number
  /** Present when the call runs on the person's own ChatGPT plan: read only
   *  through validChatGptPlan (./chatgpt-plan-model.ts). */
  chatgptPlan?: unknown
  /** Present when another agent runs the kind (the web-research agent): never this one (planSpecError). */
  agent?: unknown
}

function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 8) return false
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1))
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1))
  }
  return false
}

/**
 * Shape-guard the spec's providerOptions before they ride a model selection:
 * every entry must be a plain JSON object (eve's selection keys are strict, and
 * a malformed object must never reach the provider call). Anything else → null
 * and the resolver selects the bare model.
 */
export function validProviderOptions(value: unknown): Record<string, JsonObject> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, JsonObject> = {}
  for (const [provider, opts] of Object.entries(value as Record<string, unknown>)) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts) || !isJsonValue(opts)) return null
    out[provider] = opts as JsonObject
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A positive integer (token cap, step count), or undefined for anything else. */
function validOutputCap(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The step ceiling a spec allows. A spec without a valid one gets ONE step —
 * fail closed: the pre-port call made one model call, and a structured kind
 * that loses its repair step fails like a bad generateObject did.
 */
export function maxStepsFor(spec: UtilitySpec): number {
  return validOutputCap(spec.maxSteps) ?? 1
}

/**
 * The 0-based index of the step about to run, from a `step.started` resolver
 * event and the resolver's `ctx.messages`. eve types the resolver's event as
 * `unknown`; it dispatches `{ type: 'step.started', data: { sequence,
 * stepIndex, turnId } }` (harness/model-call/run.js selectModel). An event
 * without a readable index → undefined (and stepCeilingError then refuses the
 * step).
 *
 * eve 0.79 fills `stepIndex` from the turn's coordinates BEFORE the step
 * starts (session-projection.js turnCoordinates), so a step past the first
 * reads the PREVIOUS step's index (0, 0, 1, 2, …; eve 0.66.3 read 0, 1, 2).
 * Every step that ran left an assistant message after the turn's user message,
 * so their count is the true index; the larger of the two holds on either eve.
 * __tests__/step-event-contract.test.ts reads the installed eve to pin both,
 * so an eve bump that moves the field fails a test instead of every utility
 * session in production.
 */
export function stepIndexOf(event: unknown, messages: readonly unknown[] = []): unknown {
  if (!event || typeof event !== 'object') return undefined
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== 'object') return undefined
  const reported = (data as { stepIndex?: unknown }).stepIndex
  if (typeof reported !== 'number' || !Number.isInteger(reported) || reported < 0) return reported
  return Math.max(reported, stepsRunIn(messages))
}

/** Assistant messages after the last user message: the steps this one-shot turn has run. */
function stepsRunIn(messages: readonly unknown[]): number {
  let steps = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: unknown } | null)?.role
    if (role === 'user') break
    if (role === 'assistant') steps += 1
  }
  return steps
}

/**
 * Null when step `stepIndex` (0-based, from the step.started event) may run;
 * otherwise the Error the step resolver throws, which eve turns into a failed
 * model selection → a terminally failed session (MODEL_SELECTION_FAILED). This
 * bounds model STEPS: eve
 * re-runs a step after an invalid `eve__reply` input (a truncated structured
 * answer) with the whole message again, and nothing else stops that short of
 * the session token limits.
 *
 * It is not a bound on model CALLS. Inside one step, after this resolver has
 * run, eve 0.79.1 may re-issue the call without a new step.started: once
 * after an empty response (harness/model-call/recovery.js recoverModelCall),
 * and up to 3 attempts on a transient error (runModelCallWithRetries). So a
 * session makes at most
 * 2 × maxSteps completed model calls, plus any transiently failed attempts.
 * Count Gateway requests, not steps, when checking this live.
 */
export function stepCeilingError(spec: UtilitySpec, stepIndex: unknown): Error | null {
  const max = maxStepsFor(spec)
  // A missing or malformed index is treated as over the limit — never as step 0.
  const index = typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : Infinity
  if (index < max) return null
  return new Error(
    `[utility] ${spec.kind || 'utility'} session reached its ${max}-step ceiling (step index ${String(stepIndex)}) — refusing another model call`,
  )
}

/**
 * Why a spec must not run, or null: it names the person's plan (a
 * `chatgptPlan`, or the plan's guard slug `openai/<plan model>`, which the
 * spec route sends only for a plan call) but carries no plan this module can
 * read. Running it anyway would put the plan's model on the Gateway, on
 * Native Intelligence's key, so both resolvers refuse it.
 */
export function planSpecError(spec: UtilitySpec): Error | null {
  // A kind for another agent (one with web access) never runs here, where a
  // prompt built from workspace data has none.
  if (spec.agent !== undefined) return new Error(`[utility] ${spec.kind || 'utility'} is another agent's kind — refusing`)
  if (validChatGptPlan(spec.chatgptPlan)) return null
  const named = spec.model.startsWith('openai/') && PLAN_MODELS.has(spec.model.slice('openai/'.length))
  if (spec.chatgptPlan === undefined && !named) return null
  return new Error(`[utility] ${spec.kind || 'utility'} names the person's ChatGPT plan without a plan to run on — refusing`)
}

/**
 * The session-level model selection for a spec (see ../agent.ts). Serializable.
 * A call on the person's ChatGPT plan gets the plan's guard selection, which
 * the Gateway serves from no host: every step runs on the plan model instead.
 */
export function modelSelectionFor(
  spec: UtilitySpec,
):
  | string
  | { model: string; modelOptions: { providerOptions: Record<string, JsonObject> } }
  | ReturnType<typeof planTurnSelection> {
  const refused = planSpecError(spec)
  if (refused) throw refused
  const plan = validChatGptPlan(spec.chatgptPlan)
  if (plan) return planTurnSelection(plan)
  const providerOptions = validProviderOptions(spec.providerOptions)
  return providerOptions ? { model: spec.model, modelOptions: { providerOptions } } : spec.model
}

/**
 * Middleware that caps a model call's output tokens at `cap` — the pre-port
 * `maxOutputTokens:` a generateText/generateObject call used to send. It
 * lowers a larger (or absent) request to the cap and never raises a smaller
 * one. eve has no per-call output cap of its own: `limits.
 * maxOutputTokensPerSession` is checked BETWEEN steps, after usage arrives,
 * so it cannot stop a single long generation.
 */
export function outputCapMiddleware(cap: number): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      maxOutputTokens: params.maxOutputTokens === undefined ? cap : Math.min(params.maxOutputTokens, cap),
    }),
  }
}

/**
 * The tool eve offers a turn that requested an outputSchema, to deliver its
 * structured answer. eve 0.76 renamed it from `final_output` into its reserved
 * `eve` namespace (protocol/reply-tool.js REPLY_TOOL_NAME).
 */
export const REPLY_TOOL_NAME = 'eve__reply'

/**
 * A utility can return text or Eve's structured answer, never invoke another
 * capability. Files disable known defaults; this boundary also covers tools
 * contributed later by extensions and unsolicited provider tool calls.
 */
export function utilityToolContractMiddleware(): LanguageModelMiddleware {
  const forbidden = () => new Error('[utility] unexpected tool output; no external tools are permitted')
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      const finalOutput = params.tools?.find(tool => tool.type === 'function' && tool.name === REPLY_TOOL_NAME)
      return { ...params,
        tools: finalOutput ? [finalOutput] : undefined,
        toolChoice: finalOutput
          ? (params.toolChoice?.type === 'tool' && params.toolChoice.toolName !== REPLY_TOOL_NAME ? { type: 'auto' } : params.toolChoice)
          : { type: 'none' },
      }
    },
    wrapGenerate: async ({ params, doGenerate }) => {
      const allowsFinalOutput = params.tools?.some(tool => tool.type === 'function' && tool.name === REPLY_TOOL_NAME) === true
      const result = await doGenerate()
      for (const part of result.content) {
        if ((part.type === 'tool-call' && (!allowsFinalOutput || part.toolName !== REPLY_TOOL_NAME || part.providerExecuted)) ||
            part.type === 'tool-result' || part.type === 'tool-approval-request') throw forbidden()
      }
      return result
    },
    wrapStream: async ({ params, doStream }) => {
      const allowsFinalOutput = params.tools?.some(tool => tool.type === 'function' && tool.name === REPLY_TOOL_NAME) === true
      const result = await doStream()
      const finalInputs = new Set<string>()
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'tool-input-start') {
            if (!allowsFinalOutput || part.toolName !== REPLY_TOOL_NAME || part.providerExecuted) throw forbidden()
            finalInputs.add(part.id)
          } else if (part.type === 'tool-input-delta' || part.type === 'tool-input-end') {
            if (!finalInputs.has(part.id)) throw forbidden()
          } else if (part.type === 'tool-call') {
            if (!allowsFinalOutput || part.toolName !== REPLY_TOOL_NAME || part.providerExecuted) throw forbidden()
          } else if (part.type === 'tool-result' || part.type === 'tool-approval-request') {
            throw forbidden()
          }
          controller.enqueue(part)
        },
      })) }
    },
  }
}

/**
 * Every utility step enforces its tool-free contract at the model boundary,
 * optionally with an output cap. Eve accepts
 * live model objects ONLY from a `step.started` resolver, which is why this is
 * separate from modelSelectionFor. `gateway(slug)` is the same AI Gateway
 * provider a bare model-id string resolves through, so routing, BYOK (team
 * level), cost metadata and eve's context-window lookup (by gateway model id)
 * are unchanged. The wrapper delegates each call exactly once; Eve retains
 * ownership of execution, retries, persistence, cancellation and accounting.
 */
export function stepModelSelectionFor(
  spec: UtilitySpec,
  runToken: string,
):
  | { model: LanguageModel; modelOptions?: { providerOptions: Record<string, JsonObject> } }
  | ReturnType<typeof planStepSelection> {
  // The person's own ChatGPT plan: the plan model through the plan proxy,
  // under the same tool-free contract. No output cap: the plan route refuses
  // max_output_tokens (the session limits below still bound it).
  const refused = planSpecError(spec)
  if (refused) throw refused
  const plan = validChatGptPlan(spec.chatgptPlan)
  if (plan) {
    const step = planStepSelection(plan, chatGptPlanProxy(runToken))
    return { ...step, model: wrapLanguageModel({ model: step.model, middleware: [utilityToolContractMiddleware()] }) }
  }
  const cap = validOutputCap(spec.maxOutputTokens)
  const model = wrapLanguageModel({ model: gateway(spec.model), middleware: [utilityToolContractMiddleware(),
    ...(cap === undefined ? [] : [outputCapMiddleware(cap)])] })
  const providerOptions = validProviderOptions(spec.providerOptions)
  return providerOptions ? { model, modelOptions: { providerOptions } } : { model }
}

/** The configured internal secret (UTILITY_INTERNAL_SECRET → RUN_SKILL_INTERNAL_SECRET). */
function internalSecret(): string {
  const s = process.env.UTILITY_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) throw new Error('[utility] UTILITY_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  return s
}

/**
 * The Next app's own origin: NEXT_PUBLIC_APP_URL (the internal routes are the
 * app's). In dev the eve sidecar and Next dev share localhost:3000.
 */
export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/**
 * The ChatGPT plan proxy (src/app/api/internal/chatgpt-plan/v1/responses):
 * the base URL a plan model calls, and a fetch that adds this agent's secret
 * and the call's token to each request as it goes.
 * They ride the fetch, never a provider's `headers`, which the AI SDK's
 * workflow serializer would write out with the model.
 */
export function chatGptPlanProxy(runToken: string): PlanProxy {
  return {
    baseURL: `${appBaseUrl()}/api/internal/chatgpt-plan/v1`,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      // The SDK's placeholder key: the proxy authenticates the call's token.
      headers.delete('authorization')
      headers.set(UTILITY_SECRET_HEADER, internalSecret())
      headers.set(UTILITY_TOKEN_HEADER, runToken)
      return fetch(input, { ...init, headers })
    },
  }
}

/** Read the call's token off the verified session principal, or '' when absent. */
export function runTokenFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.runToken
  return typeof raw === 'string' ? raw : ''
}

/**
 * Both resolvers (model + instructions) need the same spec at session.started.
 * A short-lived in-flight memo keyed by the token collapses them into ONE
 * fetch — the spec is a pure function of the token, so sharing it is exact.
 * Failures are not memoized.
 */
const MEMO_TTL_MS = 60_000
const MEMO_MAX = 256
const memo = new Map<string, { at: number; spec: Promise<UtilitySpec | null> }>()

/** Test hook. */
export function __resetSpecMemo(): void {
  memo.clear()
}

/**
 * Fetch the rebuilt spec for `runToken`, or null on any failure (logged, never
 * silent). Callers decide what a missing spec means — the model resolver fails
 * the session closed rather than run a kind without its instructions.
 */
export function fetchUtilitySpec(runToken: string): Promise<UtilitySpec | null> {
  if (!runToken) return Promise.resolve(null)
  const now = Date.now()
  const hit = memo.get(runToken)
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.spec

  const spec = fetchUtilitySpecUncached(runToken).then((s) => {
    if (!s) memo.delete(runToken)
    return s
  })
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(runToken, { at: now, spec })
  return spec
}

async function fetchUtilitySpecUncached(runToken: string): Promise<UtilitySpec | null> {
  const url = `${appBaseUrl()}/api/internal/utility/spec`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [UTILITY_SECRET_HEADER]: internalSecret(),
        [UTILITY_TOKEN_HEADER]: runToken,
      },
      redirect: 'error',
    })
    if (!res.ok) {
      console.error(`[utility] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    const body = (await res.json()) as Partial<UtilitySpec>
    if (typeof body.model !== 'string' || body.model.length === 0) {
      console.error(`[utility] spec fetch returned no model: ${url}`)
      return null
    }
    return {
      kind: typeof body.kind === 'string' ? body.kind : '',
      model: body.model,
      systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : null,
      ...(body.providerOptions ? { providerOptions: body.providerOptions } : {}),
      ...(validOutputCap(body.maxOutputTokens) !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(validOutputCap(body.maxSteps) !== undefined ? { maxSteps: body.maxSteps } : {}),
      // A call on the person's plan: without this the resolvers would run
      // the plan's model on the Gateway, on Native Intelligence's key (planSpecError).
      ...(body.chatgptPlan !== undefined ? { chatgptPlan: body.chatgptPlan } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
    }
  } catch (err) {
    console.error(`[utility] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
