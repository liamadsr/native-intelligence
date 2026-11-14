/**
 * Fetch the rebuilt run spec from the Next app's internal route, for the
 * skill-runner eve agent's dynamic resolvers (Phase 2).
 *
 * The eve runtime is a SEPARATE service from the Next app. The dispatch minted an
 * HMAC-signed run token carrying the routing facts; the resolvers read that token
 * off the session principal (`ctx.session.auth.current.attributes.runToken`) and
 * call GET /api/internal/skill-run/spec with it (plus the shared internal secret)
 * to get back the system prompt, model, and ceiling tools — REBUILT server-side
 * from live DB state. Nothing coupled compiles into the eve runtime; only this
 * tiny fetch does.
 *
 * The tool proxies use a mirror POST helper against /api/internal/skill-run/tool.
 */
import { skillChatEvidence } from './person-messages.js'
import type { SessionAuth } from 'eve/context'
import type { PlanProxy } from './chatgpt-plan-model.js'
import {
  type ModelPolicy,
} from './model-policy.js'

/** Header names — kept in sync with src/lib/flows/skill-run-token.ts. */
const RUN_SKILL_SECRET_HEADER = 'x-skill-run-secret'
const RUN_SKILL_TOKEN_HEADER = 'x-skill-run-token'

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
 * `JsonObject` (shared/json.d.ts), which eve does not export from its public
 * `eve/tools` entrypoint. `defineTool` accepts a plain JsonObject as
 * `inputSchema`, so typing the wire schema this way lets the proxies pass it
 * straight through without casts.
 */
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ToolInputSchemaJson = { readonly [key: string]: JsonValue }

export interface EveSpec {
  systemPrompt: string
  model: string
  mode: 'report' | 'act'
  outputContract: 'verdict' | 'prose'
  /** Bare ceiling tool names, or `null` for inherit-all. The resolver never
   *  reads this directly — it iterates `ceilingTools`, which already enumerates
   *  the full registry when inherit-all — but it stays on the wire shape so the
   *  eve-facing view mirrors the Next-side RebuiltEveSpec exactly. */
  ceiling: string[] | null
  /** One {name, description, inputSchema?} per tool to advertise — the FULL
   *  registry when the run is inherit-all, else the ceiling set. The dynamic
   *  resolver builds one proxy per entry. `inputSchema` is the tool's REAL
   *  input schema as plain JSON Schema (the shape the gateway path's streamText
   *  advertises); absent → the proxy falls back to its permissive pass-through. */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputSchemaJson }>
  /** Per-user Gateway attribution (Phase A). Present only when the Next side has
   *  GATEWAY_USER_TAGGING on. The session model resolver rebuilds
   *  `providerOptions.gateway` from this (shape-guarded — see agent.ts). */
  gatewayTelemetry?: GatewayTelemetry
  /** How `model` is called (lib/model-policy.ts): DeepSeek thinks at its
   *  default effort, on private hosts. Absent for other models, and from an
   *  app that predates it. */
  modelPolicy?: ModelPolicy
  /** Whether this run may use the web — decided server-side from the app's
   *  USE_GATEWAY kill switch (skill-run-rebuild.ts). Read ONLY through
   *  {@link webAccessEnabled}, which fails closed. */
  webAccess?: boolean
  /**
   * Present when the run's person runs on their own ChatGPT plan (the free
   * tier, skill-run-rebuild.ts): every step then runs on the plan model
   * through the app's plan proxy, never the Gateway. Read only through
   * validChatGptPlan (./chatgpt-plan-model.ts).
   */
  chatgptPlan?: unknown
  /** Bots v3 Phase 4: present only for a follow-up CHAT turn's token. Its
   *  `instructions` are the turn-scoped system text (instructions/chat_turn.ts):
   *  the run is over, someone is here. `ceilingTools` is then the bot's chat
   *  ceiling, which tools/workspace_tools.ts re-resolves on `turn.started`. */
  chatTurn?: {
    instructions: string
    /** The tools the run's own session advertised that this chat may NOT use
     *  (the run's ceiling minus the bot's chat ceiling). eve keeps a session's
     *  `session.started` tools under a turn's, so the chat turn shadows each of
     *  these with a refusal stub (tools/workspace_tools.ts). Absent: none. */
    shadowTools?: string[]
  }
}

/**
 * Whether the session keeps its native web tools (web_search + web_fetch).
 * FAILS CLOSED: only an explicit `webAccess: true` from the server-rebuilt spec
 * enables the web. A spec that could not be fetched, or one missing the field,
 * means the kill switch could not be confirmed off — so no web. (A spec-less
 * session never reaches a model call: the model resolver refuses it.)
 */
export function webAccessEnabled(spec: Pick<EveSpec, 'webAccess'> | null): boolean {
  return spec?.webAccess === true
}

/**
 * The session's web tools: every LIVE authored tool file under
 * agents/skill-runner/tools/ other than the workspace_tools resolver. The web
 * kill switch replaces exactly these (tools/workspace_tools.ts), and the resolver
 * never mints a workspace proxy under these names. web-access-gate.test.ts
 * derives the live authored set from the filesystem and requires it to equal
 * this list, so a renamed or newly added web tool cannot slip past the switch.
 */
export const NATIVE_WEB_TOOL_NAMES: readonly string[] = ['web_search', 'web_fetch']

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[skill-runner] missing required env var ${name}`)
  return v
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
      headers.set(RUN_SKILL_SECRET_HEADER, env('RUN_SKILL_INTERNAL_SECRET'))
      headers.set(RUN_SKILL_TOKEN_HEADER, runToken)
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
 * Whether `runToken` drives a follow-up CHAT turn (bots v3 Phase 4: its claims
 * carry `chat`), read off its payload WITHOUT verifying it. Only a routing
 * hint for the turn resolvers (re-fetch the spec on a chat turn, leave a run's
 * own turn on its session-scoped tools); the Next app verifies the token on
 * every spec and tool call, so a forged claim gets nothing. Never throws.
 */
export function isChatRunToken(runToken: string): boolean {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return false
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as { chat?: unknown }
    const chat = claims?.chat as { teammateId?: unknown } | null | undefined
    return !!chat && typeof chat === 'object' && typeof chat.teammateId === 'string' && chat.teammateId.length > 0
  } catch {
    return false
  }
}

/**
 * Fetch the rebuilt spec for `runToken`. Returns null on any failure (unknown
 * token, route error), never throws: the model resolver (agent.ts) turns a null
 * into a failed session, and the persona and tool resolvers return nothing.
 */
export async function fetchEveSpec(runToken: string): Promise<EveSpec | null> {
  if (!runToken) return null
  const url = `${appBaseUrl()}/api/internal/skill-run/spec`
  try {
    // Inside the try so a misconfigured runtime (secret unset) answers null like
    // every other failure path here instead of throwing from a resolver.
    const secret = env('RUN_SKILL_INTERNAL_SECRET')
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [RUN_SKILL_SECRET_HEADER]: secret,
        [RUN_SKILL_TOKEN_HEADER]: runToken,
      },
      redirect: 'error',
    })
    if (!res.ok) {
      // The session fails on the null (agent.ts NO_SPEC); log why, or a
      // misrouted/blocked fetch looks like a model failure.
      console.error(`[skill-runner] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    return (await res.json()) as EveSpec
  } catch (err) {
    console.error(
      `[skill-runner] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Dispatch ONE workspace tool call to the Next app's internal tool route. Called
 * by the eve tool proxies' inline execute. Returns the tool's output on success;
 * THROWS on any failure. The run token scopes tenancy + ceiling server-side; the
 * model can only supply `input`.
 *
 * ── Why throw (not return an error object) ──────────────────────────────────
 * eve converts a thrown execute into a `tool-result` action with `isError: true`
 * and the error MESSAGE as the model-visible output — no retry storm, no session
 * crash; the model reads the error and adapts within the same turn (matches the
 * gateway path's native AI SDK error tool-results). The message carries the
 * route's `details` (the stringified Zod error on INPUT_INVALID) so the model
 * can actually self-correct instead of seeing a bare failure label.
 */
export async function dispatchWorkspaceTool(
  toolName: string,
  runToken: string,
  input: unknown,
): Promise<unknown> {
  if (!runToken) {
    throw new Error(`${toolName}: no run token on this session — tool call refused (NO_RUN_TOKEN)`)
  }
  // Wrap config resolution so a misconfigured runtime (secret env unset) still
  // throws the uniform `${toolName}: …` shape every other failure path uses.
  let secret: string
  try {
    secret = env('RUN_SKILL_INTERNAL_SECRET')
  } catch (err) {
    throw new Error(
      `${toolName}: tool dispatch unavailable — ${err instanceof Error ? err.message : 'runtime misconfigured'}`,
    )
  }
  const url = `${appBaseUrl()}/api/internal/skill-run/tool`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RUN_SKILL_SECRET_HEADER]: secret,
        [RUN_SKILL_TOKEN_HEADER]: runToken,
      },
      // A follow-up chat turn carries the person's own words for the reviewer
      // (lib/person-messages.ts); a run or a relayed turn carries none.
      body: JSON.stringify({ toolName, input, ...skillChatEvidence(runToken) }),
      redirect: 'error',
    })
  } catch (err) {
    console.error(
      `[skill-runner] tool dispatch errored: ${toolName} — ${err instanceof Error ? err.message : String(err)}`,
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
    console.error(`[skill-runner] tool dispatch failed: ${toolName} ${res.status} ${url}`)
    const error = typeof json.error === 'string' ? json.error : `tool dispatch failed (${res.status})`
    const code = typeof json.code === 'string' ? ` [${json.code}]` : ''
    const details = typeof json.details === 'string' && json.details ? ` — ${json.details}` : ''
    throw new Error(`${toolName}: ${error}${code}${details}`)
  }
  return json.output
}
