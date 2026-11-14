/**
 * Client for the Next app's internal work-run routes, for the `work-agent` eve
 * agent's dynamic resolvers, tool proxies, and terminal tool (Loops v3 work
 * proposals — docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SIBLING of agents/skill-runner/lib/spec-client.ts + agents/coding-agent/  │
 * │ lib/spec-client.ts (eve roots cannot share imports). Same idiom — read     │
 * │ the run token off the verified session principal, call the Next app's      │
 * │ internal routes with it + the shared secret. The deltas: the spec/tool      │
 * │ routes are the WORK-RUN ones (/api/internal/work-run/*), the EveSpec is a   │
 * │ work-run spec, and the outcome POST targets the SHARED agent-run outcome    │
 * │ route (/api/internal/agent-run/outcome), which now settles workspace-kind   │
 * │ runs too.                                                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The eve runtime is a SEPARATE service from the Next app. The dispatch minted an
 * HMAC-signed run token carrying the routing facts; the resolvers/tools read that
 * token off the session principal (`ctx.session.auth.current.attributes.runToken`)
 * and call the internal routes with it (plus the shared secret) to get back the
 * rebuilt spec, dispatch a workspace tool, or settle the run — all REBUILT /
 * re-verified server-side from live DB state. Nothing coupled compiles into the
 * eve runtime; only these tiny fetches do.
 */
import type { SessionAuth } from 'eve/context'
import type { PlanProxy } from './chatgpt-plan-model.js'
import {
  type ModelPolicy,
} from './model-policy.js'

/** Header names — kept in sync with ./auth.ts and the Next-side
 *  src/lib/agent-run/agent-run-token.ts. */
const AGENT_RUN_SECRET_HEADER = 'x-agent-run-secret'
const AGENT_RUN_TOKEN_HEADER = 'x-agent-run-token'

/**
 * Per-user Gateway attribution (Phase A) as it rides the spec wire. Mirrors the
 * Next-side `GatewayTelemetryValues` (src/lib/ai/gateway-telemetry.ts) — a plain
 * JSON-serializable object (eve requires each providerOptions entry be one). The
 * eve runtime never imports the Next helper, so the shape is redeclared here.
 *
 * A `type` alias (not an `interface`) on purpose: eve types a model selection's
 * `providerOptions` as `Record<string, JsonObject>`, and only an object-literal
 * type alias structurally satisfies that index signature — an interface does not. */
export type GatewayTelemetry = {
  user?: string
  tags: string[]
}

/**
 * Shape-guard a spec's `gatewayTelemetry` before it rides a model selection. A
 * malformed telemetry object must NEVER crash the model resolver (that would kill
 * the run) — eve's selection keys are strict, and every providerOptions entry must
 * be a JSON-serializable plain object. `user` must be a string or absent; `tags`
 * an array of strings; anything else → return null and the resolver uses the plain
 * model string. Lives here (not agent.ts) so it's unit-testable.
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
 * `JsonObject`, which eve does not export from its public `eve/tools` entrypoint.
 * `defineTool` accepts a plain JsonObject as `inputSchema`, so typing the wire
 * schema this way lets the proxies pass it straight through without casts.
 */
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ToolInputSchemaJson = { readonly [key: string]: JsonValue }

/** The rebuilt work-run spec, per WORK-PROPOSALS-DESIGN.md. */
export interface EveSpec {
  systemPrompt: string
  model: string
  /** One {name, description, inputSchema?} per ceiling tool to advertise — the
   *  registry tools whose `sideEffect` is read / internal-write
   *  (computeWorkRunCeiling). The dynamic resolver builds one proxy per entry. `inputSchema` is the tool's
   *  REAL input schema as plain JSON Schema; absent → permissive pass-through. */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputSchemaJson }>
  /** Per-user Gateway attribution (Phase A). Present only when the Next side has
   *  GATEWAY_USER_TAGGING on. The model resolver rebuilds providerOptions.gateway
   *  from this (shape-guarded — see agent.ts). */
  gatewayTelemetry?: GatewayTelemetry
  /** How `model` is called (lib/model-policy.ts): DeepSeek thinks at its
   *  default effort, on private hosts. Absent for other models, and from an
   *  app that predates it. */
  modelPolicy?: ModelPolicy
  /**
   * Present when the run's person runs on their own ChatGPT plan (the free
   * tier, run-work-spec-rebuild.ts): every step then runs on the plan model
   * through the app's plan proxy, never the Gateway. Read only through
   * validChatGptPlan (./chatgpt-plan-model.ts).
   */
  chatgptPlan?: unknown
}

/** One reviewable artifact a work run produced — mirrors WorkDeliverable in
 *  src/lib/agent-run/types.ts (the eve runtime can't import it). */
export interface WorkDeliverable {
  type: 'email_draft' | 'document' | 'action' | 'entity'
  id: string
  label: string
  entity_type?: string
}

/** The outcome route's response, surfaced back to the model. */
export interface WorkOutcomeResult {
  /** True when the route settled (or replay-acknowledged) the run. */
  settled: boolean
  /** True when the run was ALREADY terminally settled and this is a no-op. */
  alreadySettled?: boolean
  /** A human-readable message the model can read. */
  message?: string
  /** An error string when the settle failed for a non-409 reason. */
  error?: string
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[work-agent] missing required env var ${name}`)
  return v
}

/**
 * The dedicated internal secret, falling back to RUN_SKILL_INTERNAL_SECRET so one
 * secret can bootstrap dev (mirrors ./auth.ts). Throws when neither is set so a
 * caller degrades to its graceful failure path.
 */
function internalSecret(): string {
  const s = process.env.AGENT_RUN_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) throw new Error('[work-agent] AGENT_RUN_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
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
 * and the run's token to each request as it goes. They
 * ride the fetch, never a provider's `headers`, which the AI SDK's workflow
 * serializer would write out with the model.
 */
export function chatGptPlanProxy(runToken: string): PlanProxy {
  return {
    baseURL: `${appBaseUrl()}/api/internal/chatgpt-plan/v1`,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      // The SDK's placeholder key: the proxy authenticates the run's token.
      headers.delete('authorization')
      headers.set(AGENT_RUN_SECRET_HEADER, internalSecret())
      headers.set(AGENT_RUN_TOKEN_HEADER, runToken)
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
 * Whether `runToken` drives a LATER turn on the run's session: a follow-up
 * chat turn (its claims carry `chat: true`, /api/account/agent-runs/[id]/chat)
 * or the resume of a parked run (`resume: true`, an answer or returned
 * handoffs). Read off the payload WITHOUT verifying it: only a routing hint
 * for the tools resolver (re-resolve this turn's proxies from this token,
 * since the session's were minted with a token that expires 60 minutes after
 * the run started). The Next app verifies the token on every spec and tool
 * call, so a forged claim gets nothing. Never throws. Mirrors the
 * skill-runner's isChatRunToken (eve roots cannot share imports).
 */
export function isLaterTurnRunToken(runToken: string): boolean {
  const claims = laterTurnClaims(runToken)
  return claims.chat || claims.resume
}

/**
 * Whether `runToken` drives a follow-up CHAT turn (`chat: true`), read the
 * same way as isLaterTurnRunToken (unverified, a routing hint only). A
 * session whose first delivery carries one is a run chat that reopened after
 * its session expired (src/lib/agent-run/run-chat-reopen.ts).
 */
export function isChatTurnRunToken(runToken: string): boolean {
  return laterTurnClaims(runToken).chat
}

/** The token payload's literal `chat` / `resume` claims, unverified; both false on anything malformed. */
function laterTurnClaims(runToken: string): { chat: boolean; resume: boolean } {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return { chat: false, resume: false }
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as {
      chat?: unknown
      resume?: unknown
    }
    return { chat: claims?.chat === true, resume: claims?.resume === true }
  } catch {
    return { chat: false, resume: false }
  }
}

/**
 * Fetch the rebuilt spec for `runToken`. Returns null on any failure (unknown
 * token, route error), never throws: the model resolver (agent.ts) turns a null
 * into a failed session, and the persona and tool resolvers return nothing.
 */
export async function fetchEveSpec(runToken: string): Promise<EveSpec | null> {
  if (!runToken) return null
  let secret: string
  try {
    secret = internalSecret()
  } catch {
    return null
  }
  const url = `${appBaseUrl()}/api/internal/work-run/spec`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
      },
      redirect: 'error',
    })
    if (!res.ok) {
      // The session fails on the null (agent.ts NO_SPEC); log why, or a
      // misrouted/blocked fetch looks like a model failure.
      console.error(`[work-agent] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    return (await res.json()) as EveSpec
  } catch (err) {
    console.error(
      `[work-agent] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Dispatch ONE workspace tool call to the Next app's internal work-run tool
 * route. Called by the eve tool proxies' inline execute. Returns the tool's
 * output on success; THROWS on any failure (eve converts a thrown execute into a
 * `tool-result` with `isError: true` and the message as model-visible output —
 * no retry storm, no session crash; the model reads the error and adapts within
 * the same turn). The run token scopes tenancy + ceiling server-side; the model
 * can only supply `input`.
 */
export async function dispatchWorkspaceTool(
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
  const url = `${appBaseUrl()}/api/internal/work-run/tool`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify({ toolName, input }),
      redirect: 'error',
    })
  } catch (err) {
    console.error(
      `[work-agent] tool dispatch errored: ${toolName} — ${err instanceof Error ? err.message : String(err)}`,
    )
    throw new Error(
      `${toolName}: tool dispatch failed to reach the workspace (${err instanceof Error ? err.message : 'network error'}). ${toolName === 'run_browser_task'
        ? 'Delivery is unknown and the browser task may already be running. Do not automatically resubmit it; report the uncertainty.'
        : 'You may retry once.'}`,
    )
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    // Surface the FULL structured error to the model so it can adapt — `details`
    // carries the real Zod issues on INPUT_INVALID (which fields were wrong).
    console.error(`[work-agent] tool dispatch failed: ${toolName} ${res.status} ${url}`)
    const error = typeof json.error === 'string' ? json.error : `tool dispatch failed (${res.status})`
    const code = typeof json.code === 'string' ? ` [${json.code}]` : ''
    const details = typeof json.details === 'string' && json.details ? ` — ${json.details}` : ''
    throw new Error(`${toolName}: ${error}${code}${details}`)
  }
  return json.output
}

/**
 * Settle the work run terminally: report the summary + the deliverables the agent
 * actually produced. The SHARED agent-run outcome route is the SINGLE writer of
 * the terminal state. Idempotent on replay: a re-POST of the same outcome (or a
 * finish against an already-terminal run) returns `alreadySettled: true` so the
 * model learns the run is already settled and stops.
 *
 * Returns a structured result the tool hands back to the model. Never throws for
 * expected route errors — the failure is in the returned object.
 */
export async function postWorkOutcome(
  runToken: string,
  body: { summary: string; deliverables: WorkDeliverable[] },
): Promise<WorkOutcomeResult> {
  if (!runToken) {
    return { settled: false, error: 'no run token on this session — outcome refused' }
  }
  let secret: string
  try {
    secret = internalSecret()
  } catch (err) {
    return { settled: false, error: err instanceof Error ? err.message : 'secret unset' }
  }
  const url = `${appBaseUrl()}/api/internal/agent-run/outcome`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
      },
      // The shared outcome route discriminates on `result: 'work_completed'` to
      // take the workspace-kind settle branch (vs the coding pr_open/completed).
      body: JSON.stringify({ result: 'work_completed', summary: body.summary, deliverables: body.deliverables }),
      redirect: 'error',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // 409 = the run was already terminally settled (canceled by the watcher, or a
    // conflicting terminal). Surface it as settled-elsewhere so the model stops.
    if (res.status === 409) {
      return {
        settled: true,
        alreadySettled: true,
        message: (json.error as string) ?? 'run already settled',
      }
    }
    if (!res.ok) {
      return {
        settled: false,
        error: (json.error as string) ?? `outcome route failed (${res.status})`,
      }
    }
    // Success / same-outcome replay (both 200): { ok, alreadySettled }.
    return {
      settled: true,
      alreadySettled: json.alreadySettled === true,
      message: json.alreadySettled === true ? 'run already settled' : 'run settled',
    }
  } catch (err) {
    return { settled: false, error: err instanceof Error ? err.message : 'outcome network error' }
  }
}

/** What one `update_plan` post came back with. */
export type WorkPlanPostResult =
  | { ok: true; steps: unknown; canceling: boolean }
  | { ok: false; error: string; canceling: boolean }

/**
 * Write the run's job plan: POST `{ kind: 'plan', steps }` to the shared
 * agent-run event route, which resolves the job from the verified run token and
 * stores the plan through its one validating writer (src/lib/work/plan.ts).
 * The model supplies only the steps; it cannot name a job or a workspace.
 * Never throws: a failure comes back as `{ ok: false, error }` for the model.
 */
export async function postWorkPlan(runToken: string, steps: unknown): Promise<WorkPlanPostResult> {
  if (!runToken) return { ok: false, error: 'no run token on this session — plan refused', canceling: false }
  let secret: string
  try {
    secret = internalSecret()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'secret unset', canceling: false }
  }
  try {
    const res = await fetch(`${appBaseUrl()}/api/internal/agent-run/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify({ kind: 'plan', steps }),
      redirect: 'error',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const canceling = json.canceling === true
    if (res.ok && json.ok === true) {
      const plan = json.plan as { steps?: unknown } | undefined
      return { ok: true, steps: plan?.steps ?? steps, canceling }
    }
    return { ok: false, error: typeof json.error === 'string' ? json.error : `plan route failed (${res.status})`, canceling }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'plan network error', canceling: false }
  }
}

/**
 * What one `delegate_work` call handed back — the child's settled result or the
 * refusal — fetched by the tool's call id from the Next app's internal
 * delegation route (src/app/api/internal/work-run/delegation). Never throws: a
 * failure comes back as `{ status: 'unknown', error }` so the tool can tell the
 * model the result could not be read.
 */
export async function fetchDelegationResult(
  runToken: string,
  callId: string,
): Promise<Record<string, unknown>> {
  if (!runToken) return { status: 'unknown', error: 'no run token on this session' }
  let secret: string
  try {
    secret = internalSecret()
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message : 'secret unset' }
  }
  try {
    const res = await fetch(`${appBaseUrl()}/api/internal/work-run/delegation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify({ call_id: callId }),
      redirect: 'error',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { status: 'unknown', error: (json.error as string) ?? `delegation route failed (${res.status})` }
    return json
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message : 'delegation network error' }
  }
}
