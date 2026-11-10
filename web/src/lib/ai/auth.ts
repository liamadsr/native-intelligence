import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { isDeviceToken, resolveDeviceToken } from '@/lib/device-tokens'
import { inngest } from '@/lib/inngest/client'
import { CHATGPT_PLAN_PROVIDER } from '@/lib/chatgpt/plan-models'

// Emergency escape hatch: when the usage-limit RPC itself fails, we block the
// request (fail closed) rather than hand out free AI. Set BILLING_FAIL_OPEN=true
// during an incident to temporarily allow requests through when billing is down.
// Read at call time so ops can flip it via env without a redeploy.
function billingFailOpen(): boolean {
  return process.env.BILLING_FAIL_OPEN === 'true'
}

/**
 * Authenticates a request using either:
 * 1. Bearer JWT from the Authorization header, or
 * 2. Supabase session cookies (fallback for Next.js app routes)
 *
 * Returns the authenticated user and a Supabase client scoped to that user
 * (RLS-enforced), plus `via` — which credential actually authenticated
 * ('device' | 'jwt' | 'cookie'). An invalid bearer falls through to the
 * cookie, so a caller that relays the credential onward (/api/device/ask →
 * the chat-agent) must relay the one named here, not merely the one present.
 */
export type AuthenticatedVia = 'device' | 'jwt' | 'cookie'

export async function authenticateUser(req: Request) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  // Device token: opaque `nid_…` secret resolving to a user. These endpoints
  // pass user.id / workspaceId explicitly and don't lean on RLS, so a
  // service-role client is the right scoped client to hand back.
  if (token && isDeviceToken(token)) {
    const resolved = await resolveDeviceToken(token)
    if (resolved) {
      const supabase = getServiceClient()
      const { data: { user } } = await supabase.auth.admin.getUserById(resolved.userId)
      if (user) return { user, supabase, via: 'device' as AuthenticatedVia }
    }
    // Fall through to the 401 below if the device token was invalid/expired.
  }

  if (token) {
    // JWT-based auth
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    )

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (!error && user) {
      return { user, supabase, via: 'jwt' as AuthenticatedVia }
    }
  }

  // Fallback: cookie-based auth (Next.js server client reads cookies automatically)
  const supabase = await createServerClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    throw new Response(
      JSON.stringify({ error: 'Authentication required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return { user, supabase, via: 'cookie' as AuthenticatedVia }
}

/**
 * Checks the user's AI usage limits via the check_ai_usage_limit RPC.
 * Throws a 429 Response if over limit, or a 503 if the check itself fails
 * (fail-closed). On success returns the limit row so callers can read plan tier
 * (e.g. is_paid_plan for model clamping) without a second query.
 */
export interface UsageLimitRow {
  allowed: boolean
  reason?: string
  plan_name?: string
  is_paid_plan?: boolean
  usage_reset_date?: string | null
  credit_balance_usd?: number
}

/**
 * `opts.chatgptPlan`: this caller runs the person's AI on their own ChatGPT
 * plan (the free tier, docs/plans/chatgpt-free-tier.md), so a ChatGPT
 * free-tier person is allowed ('chatgpt_plan', or 'chatgpt_plan_exhausted'
 * when the last call ran out of plan credits: trying again costs Native Intelligence
 * nothing). Every other caller leaves it
 * off and such a person is refused ('chatgpt_plan_unsupported', migration 409):
 * a path that would spend Native Intelligence's own models on them fails closed.
 */
export async function checkUsageLimits(
  userId: string,
  signal?: AbortSignal,
  opts: { chatgptPlan?: boolean } = {},
): Promise<UsageLimitRow | undefined> {
  const serviceClient = getServiceClient()

  // p_chatgpt_plan is sent only when opting in, so every other call keeps the
  // one-argument form (which also works before migration 409 is applied).
  const query = serviceClient.rpc(
    'check_ai_usage_limit',
    opts.chatgptPlan ? { p_user_id: userId, p_chatgpt_plan: true } : { p_user_id: userId },
  )
  const { data: limitCheck, error } = await (signal ? query.abortSignal(signal) : query)
  // Caller cancellation is not a billing outage and must never enable a
  // fail-open path. Existing callers without a signal retain their behavior.
  signal?.throwIfAborted()

  if (error) {
    console.error('Usage limit check failed:', error)
    Sentry.captureException(error, {
      tags: { area: 'billing', op: 'check_ai_usage_limit' },
      extra: { userId },
    })
    // Fail CLOSED: a failed limit check must not hand out free unlimited AI.
    // BILLING_FAIL_OPEN can be flipped during an incident to allow through.
    if (billingFailOpen()) return undefined
    throw new Response(
      JSON.stringify({ error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const limit = (limitCheck && limitCheck.length > 0 ? limitCheck[0] : undefined) as
    | UsageLimitRow
    | undefined

  if (limit && !limit.allowed) {
    throw new Response(
      JSON.stringify({
        error: 'Usage limit exceeded',
        reason: limit.reason,
        plan: limit.plan_name,
        isPaidPlan: limit.is_paid_plan,
        usageResetDate: limit.usage_reset_date,
        creditBalanceUsd: limit.credit_balance_usd ?? 0,
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return limit
}

/** Params for logUsage / the log_ai_usage RPC. Exported for the retry worker. */
export interface LogUsageParams {
  provider: string
  model: string
  feature: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  metadata?: Record<string, unknown>
  /** Authoritative cost in USD (e.g. from AI Gateway). If omitted, RPC computes locally. */
  costUsd?: number
  /** Seconds of audio processed (for duration-priced models like Deepgram/Whisper). */
  audioSeconds?: number
  /**
   * This run's compute is NOT billed to the user (an eval run). Force a zero
   * cost into the RPC so nothing accrues to the plan and the wallet is never
   * debited; the row is logged for visibility only. Any real cost stays in
   * `metadata`, never `p_cost_usd`.
   */
  skipBilling?: boolean
  /**
   * Once-only key for a producer that can deliver the same bill more than once
   * (the eve chat usage meter's at-least-once hook). When set, the row is
   * written by `log_ai_usage_once` (migration 278), which claims the key and
   * bills in ONE transaction: an already-claimed key bills nothing (outcome
   * 'duplicate'), and a failed bill rolls its claim back so a retry can bill.
   * The durable Inngest retry reuses the same key, so a failure that actually
   * committed is never billed twice.
   */
  idempotencyKey?: string
}

/** The keyed variant of log_ai_usage (migration 278). */
export const LOG_AI_USAGE_ONCE_RPC = 'log_ai_usage_once'

/**
 * How one logUsage call ended:
 *  - 'logged'         — the RPC recorded (and billed) the row;
 *  - 'duplicate'      — an idempotencyKey that was already billed; nothing written;
 *  - 'retry-enqueued' — the RPC failed and the durable Inngest retry will bill it;
 *  - 'lost'           — the RPC failed AND the retry could not be enqueued: the
 *                       spend is unrecorded (alerted). A caller that can retry on
 *                       its own (the chat usage route → the hook) must do so.
 */
export type LogUsageOutcome = 'logged' | 'duplicate' | 'retry-enqueued' | 'lost'

/** PostgREST / Postgres codes for "that function does not exist". */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883'])

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> }

/**
 * Run log_ai_usage (or, with `idempotencyKey`, log_ai_usage_once) for one
 * usage row. Shared by logUsage and the Inngest retry so both bill the same
 * way. Returns the RPC error (never throws) and whether the key was a duplicate.
 *
 * If the keyed RPC does not exist yet (migration 278 not applied), the row is
 * billed through plain log_ai_usage WITHOUT the dedup and the gap is alerted:
 * an unbilled turn is worse than a rare double row.
 */
export async function runLogUsageRpc(
  client: RpcClient,
  userId: string,
  params: LogUsageParams,
  edgeFunction: string,
): Promise<{ error: { message: string; code?: string } | null; duplicate: boolean }> {
  const onPlan = params.provider === CHATGPT_PLAN_PROVIDER
  const args = {
    p_user_id: userId,
    p_provider: params.provider,
    p_model: params.model,
    p_feature: params.feature,
    p_input_tokens: params.inputTokens,
    p_output_tokens: params.outputTokens,
    p_duration_ms: params.durationMs,
    p_edge_function: edgeFunction,
    // A step on the person's own ChatGPT plan (the free tier): Native Intelligence paid
    // nothing, wherever the row comes from, and the row says so.
    p_metadata: onPlan ? { ...params.metadata, billed_to: 'chatgpt_plan' } : (params.metadata ?? {}),
    // skipBilling (eval runs) and plan steps: force a zero cost into the RPC so
    // nothing accrues to the user's Native Intelligence plan; any real cost rides in metadata only.
    p_cost_usd: params.skipBilling || onPlan ? 0 : (params.costUsd ?? null),
    p_audio_seconds: params.audioSeconds ?? 0,
  }
  if (params.idempotencyKey) {
    const { data, error } = await client.rpc(LOG_AI_USAGE_ONCE_RPC, {
      p_idempotency_key: params.idempotencyKey,
      ...args,
    })
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data
      return { error: null, duplicate: (row as { duplicate?: unknown } | null)?.duplicate === true }
    }
    if (!MISSING_FUNCTION_CODES.has(error.code ?? '')) return { error, duplicate: false }
    console.error('[billing] log_ai_usage_once is missing (migration 278 unapplied?) — billing without dedup')
    Sentry.captureException(new Error(`log_ai_usage_once unavailable: ${error.message}`), {
      tags: { area: 'billing', op: 'log_ai_usage_once_missing' },
      extra: { feature: params.feature, code: error.code ?? null },
    })
  }
  const { error } = await client.rpc('log_ai_usage', args)
  return { error, duplicate: false }
}

/**
 * Logs AI usage via the log_ai_usage RPC, which now ALSO debits the user's
 * credit wallet for any spend beyond their plan allowance (atomically, in the
 * same transaction — see migration 160). There is no Stripe meter event
 * anymore: `ai_usage_logs` + `ai_credit_ledger` are the system of record.
 *
 * When `costUsd` is provided (e.g. from Vercel AI Gateway's
 * providerMetadata.gateway.marketCost), it is used directly and the RPC skips
 * its local pricing-table lookup. When omitted, the RPC computes cost from
 * ai_model_costs.
 *
 * Usage that fails to record is spend we can't bill against, so on RPC failure
 * we hand the payload to a durable Inngest retry (billing/usage-log-failed)
 * and alert — it must never be silently free. It never throws; the returned
 * {@link LogUsageOutcome} says whether the spend is recorded, deduped, queued
 * for retry, or lost (callers that ignore it keep the old fire-and-forget
 * behavior). With `params.idempotencyKey` the row is billed at most once.
 */
export async function logUsage(userId: string, params: LogUsageParams): Promise<LogUsageOutcome> {
  const serviceClient = getServiceClient()

  const { error, duplicate } = await runLogUsageRpc(serviceClient, userId, params, 'next-api')
  if (!error) return duplicate ? 'duplicate' : 'logged'

  console.error('Failed to log AI usage:', error)
  Sentry.captureException(error, {
    tags: { area: 'billing', op: 'log_ai_usage' },
    extra: {
      userId,
      provider: params.provider,
      model: params.model,
      feature: params.feature,
      costUsd: params.costUsd ?? null,
    },
  })
  // Durable retry: Inngest re-runs the RPC with backoff so the spend is
  // eventually recorded and drawn from the wallet. Best-effort emit — if
  // even the emit fails we've already captured to Sentry, and the caller
  // learns the spend is 'lost' so it can retry on its own.
  try {
    await inngest.send({
      name: 'billing/usage-log-failed',
      data: { userId, params },
    })
    return 'retry-enqueued'
  } catch (emitErr) {
    console.error('Failed to enqueue usage-log retry:', emitErr)
    Sentry.captureException(emitErr, {
      tags: { area: 'billing', op: 'usage-log-retry-enqueue' },
      extra: { userId },
    })
    return 'lost'
  }
}

/**
 * Extracts the authoritative cost (USD) from an AI SDK result's provider metadata.
 *
 * When calling models through the Vercel AI Gateway, the response includes
 * `providerMetadata.gateway` with two cost fields:
 *   - `cost`       — what Vercel bills you for this request. On BYOK this is "0".
 *   - `marketCost` — list-price cost of the tokens (what you actually pay the provider).
 *
 * We always want `marketCost` — it's the real cost regardless of whether you're
 * on BYOK or Vercel-managed credits, and it's what we charge against user plan limits.
 *
 * Returns undefined if the result didn't come through Gateway (direct provider call,
 * or non-Gateway provider like Deepgram). Callers should fall back to RPC-computed
 * pricing in that case by simply not passing `costUsd` to logUsage().
 */
export function extractGatewayCost(result: {
  providerMetadata?: Record<string, unknown> | undefined
}): number | undefined {
  const gateway = result.providerMetadata?.gateway as
    | { marketCost?: unknown; cost?: unknown }
    | undefined
  if (!gateway) return undefined

  // Side channel: surface a BYOK → system-credential fallback. Every metered
  // call already flows through here, so this is the one place that sees the
  // Gateway routing trace for the whole classic path.
  reportGatewayCredentialFallback(gateway)

  // Prefer marketCost (list price) over cost (BYOK = 0).
  // Gateway returns these as strings, not numbers.
  const raw = gateway.marketCost ?? gateway.cost
  if (raw === undefined || raw === null) return undefined

  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * One provider attempt from the Gateway's routing trace
 * (`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`).
 * Only the fields this detector reads are typed; the trace carries more.
 */
interface GatewayProviderAttempt {
  provider?: unknown
  credentialType?: unknown
  success?: unknown
  error?: unknown
}

/**
 * Describes a BYOK → system-credential fallback found in a Gateway routing
 * trace, or `null` when the request ran on our own key (or the trace is absent).
 *
 * The Gateway tries the team's Bring-Your-Own-Key credential first and, when
 * that attempt FAILS, silently retries on Vercel's system credentials — billed
 * against AI Gateway credits at list price. That is the documented behaviour,
 * and it is invisible from the response itself: the call succeeds, cost fields
 * are populated, nothing errors. Prod 2026-09-01/02: the Anthropic BYOK key ran
 * out of Anthropic credits ("credit balance is too low"), every Anthropic call
 * fell back to system credentials, and ~$10 of Gateway credits burned over two
 * days before anyone noticed. This reads the trace so the fallback is LOUD.
 *
 * Pure + exported for tests. Never throws on a malformed trace (the shape is
 * Gateway-owned and may change) — any surprise → `null`.
 */
export function detectGatewayCredentialFallback(gateway: unknown): {
  provider: string
  byokError: string
} | null {
  try {
    const routing = (gateway as { routing?: { modelAttempts?: unknown } } | undefined)?.routing
    const modelAttempts = routing?.modelAttempts
    if (!Array.isArray(modelAttempts)) return null
    for (const attempt of modelAttempts) {
      const providerAttempts = (attempt as { providerAttempts?: unknown })?.providerAttempts
      if (!Array.isArray(providerAttempts)) continue
      const failedByok = (providerAttempts as GatewayProviderAttempt[]).find(
        (a) => a?.credentialType === 'byok' && a?.success === false,
      )
      const succeededSystem = (providerAttempts as GatewayProviderAttempt[]).find(
        (a) => a?.credentialType === 'system' && a?.success === true,
      )
      if (failedByok && succeededSystem) {
        return {
          provider: typeof succeededSystem.provider === 'string' ? succeededSystem.provider : 'unknown',
          byokError: typeof failedByok.error === 'string' ? failedByok.error : 'unknown error',
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Throttle window for the fallback alert — once per process per interval. */
const CREDENTIAL_FALLBACK_ALERT_INTERVAL_MS = 5 * 60 * 1000
let lastCredentialFallbackAlertAt = 0

/**
 * Log + Sentry-message a detected BYOK → system fallback, throttled so a burst
 * (e.g. an enrichment sweep of 300 calls) produces one alert per 5 minutes per
 * process rather than one per call. Best-effort: never throws, never changes
 * the cost that is returned to the caller.
 */
function reportGatewayCredentialFallback(gateway: unknown): void {
  const fallback = detectGatewayCredentialFallback(gateway)
  if (!fallback) return
  const now = Date.now()
  if (now - lastCredentialFallbackAlertAt < CREDENTIAL_FALLBACK_ALERT_INTERVAL_MS) return
  lastCredentialFallbackAlertAt = now
  const message = `[ai-gateway] BYOK credential failed; request billed to Gateway system credentials via ${fallback.provider}: ${fallback.byokError}`
  console.warn(message)
  try {
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: { component: 'ai-gateway', gateway_provider: fallback.provider },
      extra: { byokError: fallback.byokError },
    })
  } catch {
    // Sentry must never break a metered request.
  }
}
