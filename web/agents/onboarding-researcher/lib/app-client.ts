/**
 * Client for the Next app's internal CRM-enrichment route, for the
 * onboarding-researcher's `enrich_company` / `enrich_me` tools.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Same idiom as agents/coding-agent/lib/spec-client.ts (eve roots cannot   │
 * │ share imports, so the base-url / secret / bypass trio is re-declared     │
 * │ here). The deltas: ONE POST helper, no run token — an onboarding session │
 * │ is not an agent_run row, so the route's tenancy gate is the live         │
 * │ `member` row of the workspaceId+userId this client sends, which must be  │
 * │ running the research session it names (sessionId).                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY OVER HTTP: the eve runtime is a SEPARATE service and the eve compile
 * bundles only this agent's own tree, so it cannot import src/lib/crm/enrichment.
 * Reimplementing the Exa deep-search + fill-empty write-back inside the agent
 * would fork the CRM's single enrichment pipeline into two copies that drift.
 * Instead the tool makes one authenticated fetch and the app does the real work,
 * so onboarding and the CRM's own Sparkles button produce identical rows.
 *
 * The workspaceId/userId in the body are derived by the CALLER from the verified
 * session principal (lib/tool-context.ts requireOwner) and the sessionId is the
 * session's own id (ctx.session.id, the id the kickoff route stores as
 * `research.sessionId`); the route re-verifies all three against a live member
 * row — never taken from model input on either side.
 */

/** Kept in sync with src/lib/agent-run/agent-run-token.ts. */
const AGENT_RUN_SECRET_HEADER = 'x-agent-run-secret'

/** Target of the enrichment call — mirrors the route's zod body. */
export type EnrichmentTarget =
  | { kind: 'company'; domain: string; name?: string }
  | { kind: 'self_contact' }

export interface EnrichmentRequest {
  workspaceId: string
  userId: string
  /** This research session's id: the route enriches only for a run in progress. */
  sessionId: string
  target: EnrichmentTarget
}

/**
 * Thrown when the route answers non-2xx (or is unreachable). Carries the status
 * so a tool can distinguish "not configured / not found" from a transport blip
 * when it phrases its model-visible failure.
 */
export class AppRequestError extends Error {
  status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'AppRequestError'
    this.status = status
  }
}

/**
 * The Next app's own origin. On Vercel, pin to THIS deployment's URL: the
 * internal route ships with the same commit as this agent, so the deployment's
 * own origin is the only version-correct target (NEXT_PUBLIC_APP_URL points at
 * the canonical PROD domain — from a preview it would call OLD code that may not
 * even have this route). In dev the eve sidecar and Next dev share localhost:3000.
 */
export function appBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/**
 * The dedicated internal secret, falling back to RUN_SKILL_INTERNAL_SECRET so
 * one secret can bootstrap dev (mirrors lib/auth.ts and the coding agent).
 * Throws when neither is set so a caller degrades to its failure path.
 */
export function internalSecret(): string {
  const s = process.env.AGENT_RUN_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  if (!s) {
    throw new Error(
      '[onboarding-researcher] AGENT_RUN_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set',
    )
  }
  return s
}

/**
 * Vercel Deployment Protection guards preview URLs with SSO — including
 * server-to-server fetches like ours. When the project has "Protection Bypass
 * for Automation" enabled, Vercel injects this secret into every deployment;
 * sending it as a header lets the agent through. Absent (prod custom domain,
 * local dev) this contributes nothing.
 */
export function protectionBypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret } : {}
}

/**
 * POST the enrichment request and return the parsed JSON body. Throws
 * AppRequestError on any non-2xx (with the route's `error` string, or a short
 * body excerpt) and on transport failure — tools catch it and return a
 * model-visible `{ success: false, error }` rather than crashing the turn.
 */
export async function postInternalEnrichment(
  body: EnrichmentRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = `${appBaseUrl()}/api/internal/crm-enrichment`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_RUN_SECRET_HEADER]: internalSecret(),
      ...protectionBypassHeaders(),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  })

  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') detail = parsed.error
    } catch {
      // keep the raw excerpt
    }
    throw new AppRequestError(`enrichment route failed (${res.status}): ${detail}`, res.status)
  }

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new AppRequestError('enrichment route returned a non-JSON body', res.status)
  }
}

/**
 * Settle the run's Activity row after finish_research persisted its outcome
 * (Sequence row 6). The route reads the member's stored state and mirrors it;
 * this sends only the session id. Best-effort by contract: the caller logs a
 * failure and never fails the research run on it.
 */
export async function postInternalResearchSettle(sessionId: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${appBaseUrl()}/api/internal/onboarding-research/settle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_RUN_SECRET_HEADER]: internalSecret(),
      ...protectionBypassHeaders(),
    },
    body: JSON.stringify({ sessionId }),
    redirect: 'error',
    signal,
  })
  if (!res.ok) {
    throw new AppRequestError(`research settle route failed (${res.status})`, res.status)
  }
}
