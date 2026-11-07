/**
 * Client for the Next app's internal agent-run routes, for the `coding-agent`
 * eve agent's dynamic resolvers, sandbox selector, and terminal tools
 * (Phase 3).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TWIN of agents/skill-runner/lib/spec-client.ts (eve roots cannot share    │
 * │ imports). Same idiom — read the run token off the verified session        │
 * │ principal, call the Next app's internal routes with it + the shared       │
 * │ secret. The deltas: the header names (x-agent-run-*), the secret env var   │
 * │ (AGENT_RUN_INTERNAL_SECRET → RUN_SKILL_INTERNAL_SECRET fallback), the      │
 * │ EveSpec shape (a coding-run spec, not a skill-run spec), and two POST      │
 * │ helpers (event + outcome) instead of the tool-dispatch proxy.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The eve runtime is a SEPARATE service from the Next app. The dispatch minted an
 * HMAC-signed run token carrying the routing facts; the resolvers/hook read that
 * token off the session principal (`ctx.session.auth.current.attributes.runToken`)
 * and call the internal routes with it (plus the shared secret) to get back the
 * rebuilt spec, to append log/progress events, and to settle the run — all REBUILT
 * / re-verified server-side from live DB state. Nothing coupled compiles into the
 * eve runtime; only these tiny fetches do.
 */
import type { SessionAuth } from 'eve/context'

/** Header names — kept in sync with agents/coding-agent/lib/auth.ts and the
 *  Next-side src/lib/agent-run/agent-run-token.ts. */
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
 * The rebuilt coding-run spec, per the design doc §trust boundary contract. All
 * fields are re-derived server-side from live DB state keyed by the verified
 * token — nothing large crosses the boundary as in-process state.
 */
export interface EveSpec {
  /** Composed agent persona system prompt (loadAgentPersona/composeEveCodingSystemPrompt). */
  systemPrompt: string
  /** The issue/task prompt (the XML issue block the run should work). */
  taskPrompt: string
  /** Bare or provider-qualified model id (e.g. 'claude-opus-4-8' or 'anthropic/...'). */
  model: string
  /** "owner/repo" to clone and open a PR against. */
  repoFullName: string
  /** Branch to clone at (the repo's base branch, e.g. 'main'). */
  baseBranch: string
  /** Branch the agent works on and pushes. */
  branchName: string
  /** Cloud-environment egress class → sandbox network policy (see sandbox.ts). */
  networkAccess: 'trusted' | 'restricted' | 'isolated'
  /** Bash run after clone, before the agent starts. Null when the env has none. */
  setupScript: string | null
  /** User-supplied environment vars (from the linked cloud environment). */
  envVars: Record<string, string>
  /**
   * The triggering user's GitHub OAuth token. The sandbox brokers it for git
   * READS only (clone, fetch, LFS): it never pushes with it.
   */
  githubToken: string
  /**
   * The run's push credential for the app's git push gate (GIT_PUSH_PATH),
   * the only place a run's commits reach GitHub, and only on its own branch.
   * The sandbox refuses to start without it.
   */
  gitPushToken?: string
  /**
   * A CI fix run on an open PR (P10 F7): the PR's branch, fetched and forked
   * into the working branch (a side branch) instead of branching from the base.
   */
  startFrom?: string
  /** Per-user Gateway attribution (Phase A). Present only when the Next side has
   *  GATEWAY_USER_TAGGING on. The session model resolver rebuilds
   *  `providerOptions.gateway` from this (shape-guarded — see agent.ts). */
  gatewayTelemetry?: GatewayTelemetry
}

/** Event kinds the log pump appends to agent_run.log_tail. */
export type AgentRunEventKind = 'log' | 'progress'

/** The event route's response — the log pump doubles as the cancel signal. */
export interface AgentRunEventResult {
  /** True when the run has been asked to cancel — the tool must STOP the model. */
  canceling: boolean
}

/** The terminal result the agent reports. Mirrors the outcome route body. */
export type AgentRunResult = 'pr_open' | 'completed' | 'failed'

/** A PR the outcome route should open server-side (with the user's OAuth token). */
export interface AgentRunPr {
  title: string
  body: string
  head: string
  base: string
}

/** The outcome route's response, surfaced back to the model. */
export interface AgentRunOutcomeResult {
  /** True when the route settled (or replay-acknowledged) the run. */
  settled: boolean
  /** The PR URL the route opened, if any. */
  prUrl?: string | null
  /** True when the run was ALREADY terminally settled and this outcome conflicts (409). */
  alreadySettled?: boolean
  /** A human-readable message the model can read. */
  message?: string
  /** An error string when the settle failed for a non-409 reason. */
  error?: string
  /**
   * The reviewer asked for changes before the PR opens (P10 F6): nothing is
   * settled; `message` says what to change. Fix, push, call finish_run again.
   */
  changesRequested?: boolean
  /** The review stopped the run without a PR (rejected, or out of rounds): settled, `message` says why. */
  reviewStopped?: boolean
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[coding-agent] missing required env var ${name}`)
  return v
}

/**
 * The dedicated internal secret, falling back to RUN_SKILL_INTERNAL_SECRET so one
 * secret can bootstrap dev (mirrors lib/auth.ts). Throws when neither is set so a
 * caller degrades to its graceful failure path.
 */
function internalSecret(): string {
  const s = process.env.AGENT_RUN_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) throw new Error('[coding-agent] AGENT_RUN_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  return s
}

/**
 * The Next app's own origin. On Vercel, pin to THIS deployment's URL: the
 * internal routes ship with the same commit as this agent, so the deployment's
 * own origin is the only version-correct target (NEXT_PUBLIC_APP_URL points at
 * the canonical PROD domain — from a preview it would call OLD code that may
 * not even have these routes). In dev the eve sidecar and Next dev share
 * localhost:3000.
 */
export function appBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/**
 * Vercel Deployment Protection guards preview URLs with SSO — including
 * server-to-server fetches like ours. When the project has "Protection Bypass
 * for Automation" enabled, Vercel injects this secret into every deployment;
 * sending it as a header lets the agent through. Absent (e.g. prod custom
 * domain, local dev) this contributes nothing.
 */
function protectionBypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret } : {}
}

/**
 * Where the app's git push gate is mounted. Twin of GIT_PUSH_PATH in
 * src/lib/agent-run/git-push-proxy.ts (eve roots can't import the app).
 */
export const GIT_PUSH_PATH = '/api/internal/agent-run/git'

/**
 * The push URL a run's sandbox pushes to: the app's PUBLIC origin
 * (NEXT_PUBLIC_APP_URL; production is not behind Vercel's deployment
 * protection). Never the deployment URL with a protection-bypass secret: the
 * sandbox must not be handed that secret or the cookie it buys. A deployment
 * whose public origin is protected refuses the push (closed). Only main
 * deploys, so the gate there is the same code as this agent. Off Vercel
 * (NEXT_PUBLIC_APP_URL unset or local) it is the local app, which a local
 * sandbox VM may not reach: local runs can clone and work, but a push needs the
 * app reachable from the sandbox.
 *
 * Null on Vercel without NEXT_PUBLIC_APP_URL: the only other origin is the
 * deployment URL, which is protected, so every push would fail with Vercel's
 * 401. The sandbox refuses to start such a run instead (sandbox.ts).
 */
export function gitPushUrl(): string | null {
  const publicOrigin = process.env.NEXT_PUBLIC_APP_URL
  if (!publicOrigin && process.env.VERCEL) return null
  const origin = (publicOrigin || appBaseUrl()).replace(/\/+$/, '')
  return `${origin}${GIT_PUSH_PATH}`
}

/** Read the run token off the verified session principal, or '' when absent. */
export function runTokenFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.runToken
  return typeof raw === 'string' ? raw : ''
}

/**
 * Fetch the rebuilt spec for `runToken`. Returns null on any failure (unknown
 * token, route error) so a resolver/hook can degrade (no dynamic instructions /
 * fallback model / no sandbox clone) rather than crash the session.
 */
export async function fetchEveSpec(runToken: string): Promise<EveSpec | null> {
  if (!runToken) return null
  let secret: string
  try {
    secret = internalSecret()
  } catch {
    return null
  }
  const url = `${appBaseUrl()}/api/internal/agent-run/spec`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
        ...protectionBypassHeaders(),
      },
      redirect: 'error',
    })
    if (!res.ok) {
      // Degrading to a spec-less session is deliberate — but it must never be
      // silent, or a misrouted/blocked fetch looks like model failure.
      console.error(`[coding-agent] spec fetch failed: ${res.status} ${url}`)
      return null
    }
    return (await res.json()) as EveSpec
  } catch (err) {
    console.error(
      `[coding-agent] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Append one log/progress event to agent_run.log_tail. The response carries the
 * cancel signal ({ canceling }): the log pump doubles as the cancel channel, so
 * post_progress can turn a `canceling: true` into a hard STOP for the model.
 * Fails open to { canceling: false } on any transport/route error so a flaky log
 * write never falsely stops a healthy run — the watcher is the backstop that
 * settles a canceled row.
 */
export async function postEvent(
  runToken: string,
  kind: AgentRunEventKind,
  text: string,
): Promise<AgentRunEventResult> {
  if (!runToken) return { canceling: false }
  let secret: string
  try {
    secret = internalSecret()
  } catch {
    return { canceling: false }
  }
  const url = `${appBaseUrl()}/api/internal/agent-run/event`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_RUN_SECRET_HEADER]: secret,
        [AGENT_RUN_TOKEN_HEADER]: runToken,
        ...protectionBypassHeaders(),
      },
      body: JSON.stringify({ kind, text }),
      redirect: 'error',
    })
    if (!res.ok) return { canceling: false }
    const json = (await res.json().catch(() => ({}))) as { canceling?: unknown }
    return { canceling: json.canceling === true }
  } catch {
    return { canceling: false }
  }
}

/**
 * Settle the run terminally: report the result + summary, and (when `pr` is
 * present) have the route open the GitHub PR server-side and link it. The route
 * is the SINGLE writer of the terminal state + PR link. Idempotent on replay: a
 * re-POST of the same outcome returns 200; a CONFLICTING outcome after the run
 * is already terminal returns 409 → we surface `alreadySettled` so the model
 * learns the run is already settled and stops.
 *
 * Returns a structured result the tool hands back to the model. Never throws for
 * expected route errors — the failure is in the returned object.
 */
export async function postOutcome(
  runToken: string,
  body: {
    result: AgentRunResult
    summary: string
    error?: string
    pr?: AgentRunPr
  },
): Promise<AgentRunOutcomeResult> {
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
        ...protectionBypassHeaders(),
      },
      body: JSON.stringify(body),
      redirect: 'error',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // 409 = the run was already terminally settled with a DIFFERENT outcome, or
    // it was canceled (the watcher owns settling canceling → canceled). The route
    // body is { error, code } — no prUrl. Surface it as a settled-elsewhere
    // signal so the model stops rather than retrying.
    if (res.status === 409) {
      return {
        settled: true,
        alreadySettled: true,
        message: (json.error as string) ?? 'run already settled',
        prUrl: null,
      }
    }
    if (!res.ok) {
      return {
        settled: false,
        error: (json.error as string) ?? `outcome route failed (${res.status})`,
      }
    }
    // The reviewer sent it back (P10 F6): a 200 that settled nothing.
    if (json.changesRequested === true) {
      return {
        settled: false,
        changesRequested: true,
        message: typeof json.message === 'string' ? json.message : 'The reviewer requested changes.',
      }
    }
    // The review stopped the run without a PR: settled, with the reason.
    if (json.reviewStopped === true) {
      return {
        settled: true,
        reviewStopped: true,
        prUrl: null,
        message: typeof json.message === 'string' ? json.message : 'The review stopped the run; no pull request was opened.',
      }
    }
    // Success / same-outcome replay (both 200): the route body is
    // { ok, alreadySettled, prUrl } — note prUrl is camelCase here (NOT pr_url).
    return {
      settled: true,
      alreadySettled: json.alreadySettled === true,
      prUrl: (json.prUrl as string | null) ?? null,
      message: json.alreadySettled === true ? 'run already settled' : 'run settled',
    }
  } catch (err) {
    return { settled: false, error: err instanceof Error ? err.message : 'outcome network error' }
  }
}
