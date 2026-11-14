/**
 * The web-research agent's link to the Next app: one call's spec from the
 * utility spec route, and the plan proxy its model calls.
 *
 * A web-research call is a utility call (src/lib/eve/utility/run-utility.ts)
 * whose kind names this agent (UtilityKindSpec.agent): the same signed token,
 * the same GET /api/internal/utility/spec, the same internal secret. A trimmed
 * copy of agents/utility/lib/spec-client.ts (an agent bundles only its own
 * folder): this agent runs only plan calls, so there is no Gateway selection,
 * provider options or output cap here, and webResearchPlan refuses anything
 * else.
 */
import type { SessionAuth } from 'eve/context'
import { validChatGptPlan, type ChatGptPlan, type PlanProxy } from './chatgpt-plan-model.js'

/** Header names — kept in sync with src/lib/eve/utility-run-token.ts. */
const UTILITY_SECRET_HEADER = 'x-utility-run-secret'
const UTILITY_TOKEN_HEADER = 'x-utility-run-token'

/** This agent's name in a spec (UtilityKindSpec.agent in src/lib/eve/utility/spec.ts). */
export const WEB_RESEARCH_AGENT = 'web-research'

export interface WebResearchSpec {
  kind: string
  /** OpenAI's catalog slug for the plan model (the session's guard selection). */
  model: string
  /** The kind's system instructions, or null when it has none. */
  systemPrompt: string | null
  /** How many model steps the session may take (see stepCeilingError). */
  maxSteps?: number
  /** The person's plan: read only through validChatGptPlan. */
  chatgptPlan?: unknown
  /** The agent the spec is for: this one, or the call is refused. */
  agent?: unknown
}

/**
 * The plan a spec runs on, or the Error both resolvers throw (eve fails the
 * session): this agent runs a call only when the spec is for it and on the
 * person's own plan. Anything else would be a web-enabled model on Native Intelligence's
 * Gateway, or a utility kind (a prompt built from workspace data) given the
 * web.
 */
export function webResearchPlan(spec: WebResearchSpec | null): ChatGptPlan | Error {
  if (!spec) return new Error('[web-research] no spec for this session — refusing to run without its instructions')
  if (spec.agent !== WEB_RESEARCH_AGENT) return new Error(`[web-research] ${spec.kind || 'a kind'} is not this agent's — refusing`)
  return validChatGptPlan(spec.chatgptPlan) ?? new Error(`[web-research] ${spec.kind} is not on the person's ChatGPT plan — refusing`)
}

/** A positive integer, or undefined for anything else. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The 0-based index of the step about to run, from a `step.started` resolver
 * event and the resolver's `ctx.messages` (agents/utility/lib/spec-client.ts
 * stepIndexOf: eve 0.79 reports the previous step's index past step 0, so the
 * larger of it and the steps already run is the true index).
 */
export function stepIndexOf(event: unknown, messages: readonly unknown[] = []): unknown {
  if (!event || typeof event !== 'object') return undefined
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== 'object') return undefined
  const reported = (data as { stepIndex?: unknown }).stepIndex
  if (typeof reported !== 'number' || !Number.isInteger(reported) || reported < 0) return reported
  let steps = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: unknown } | null)?.role
    if (role === 'user') break
    if (role === 'assistant') steps += 1
  }
  return Math.max(reported, steps)
}

/**
 * Null when the step may run; otherwise the Error the step resolver throws.
 * A spec without a valid ceiling gets one step, and a missing or malformed
 * index is treated as over the limit — never as step 0.
 */
export function stepCeilingError(spec: WebResearchSpec, stepIndex: unknown): Error | null {
  const max = positiveInt(spec.maxSteps) ?? 1
  const index = typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : Infinity
  if (index < max) return null
  return new Error(`[web-research] ${spec.kind || 'session'} reached its ${max}-step ceiling (step index ${String(stepIndex)}) — refusing another model call`)
}

/** The configured internal secret (UTILITY_INTERNAL_SECRET → RUN_SKILL_INTERNAL_SECRET). */
function internalSecret(): string {
  const s = process.env.UTILITY_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) throw new Error('[web-research] UTILITY_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
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
 * the base URL the plan model calls, and a fetch that adds the internal
 * secret and the call's token to each request. They
 * ride the fetch, never a provider's `headers`, which the AI SDK's workflow
 * serializer would write out with the model.
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
 * The model and instructions resolvers, and every step, need the same spec:
 * a short-lived in-flight memo keyed by the token collapses them into one
 * fetch (the spec is a pure function of the token). Failures are not memoized.
 */
const MEMO_TTL_MS = 60_000
const MEMO_MAX = 256
const memo = new Map<string, { at: number; spec: Promise<WebResearchSpec | null> }>()

/** Test hook. */
export function __resetSpecMemo(): void {
  memo.clear()
}

/** Fetch the rebuilt spec for `runToken`, or null on any failure (logged, never silent). */
export function fetchWebResearchSpec(runToken: string): Promise<WebResearchSpec | null> {
  if (!runToken) return Promise.resolve(null)
  const now = Date.now()
  const hit = memo.get(runToken)
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.spec
  const spec = fetchUncached(runToken).then((s) => {
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

async function fetchUncached(runToken: string): Promise<WebResearchSpec | null> {
  const url = `${appBaseUrl()}/api/internal/utility/spec`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { [UTILITY_SECRET_HEADER]: internalSecret(), [UTILITY_TOKEN_HEADER]: runToken },
      redirect: 'error',
    })
    if (!res.ok) {
      console.error(`[web-research] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    const body = (await res.json()) as Partial<WebResearchSpec>
    if (typeof body.model !== 'string' || body.model.length === 0) {
      console.error(`[web-research] spec fetch returned no model: ${url}`)
      return null
    }
    return {
      kind: typeof body.kind === 'string' ? body.kind : '',
      model: body.model,
      systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : null,
      ...(positiveInt(body.maxSteps) !== undefined ? { maxSteps: body.maxSteps } : {}),
      ...(body.chatgptPlan !== undefined ? { chatgptPlan: body.chatgptPlan } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
    }
  } catch (err) {
    console.error(`[web-research] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
