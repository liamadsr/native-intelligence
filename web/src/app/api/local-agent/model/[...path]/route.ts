/**
 * POST /api/local-agent/model/language-model — the local agent's metered model relay.
 *
 * The Mac's local eve reaches the AI Gateway through here with a per-session
 * model token (src/lib/local-agent/tokens.ts) instead of a gateway key:
 *   1. Auth: `Authorization: Bearer <modelToken>`: the HMAC and its expiry, then
 *      the session is live and owned by the token's `uid`.
 *   2. Only the `language-model` path, for an allowlisted model id (the local
 *      agent's model and its fallbacks); any other path is 404.
 *   3. The person's usage limit (checkUsageLimits: 429, or a fail-closed 503).
 *   4. Forward the body and the `ai-language-model-*` headers to the Gateway
 *      with the server's own credential (AI_GATEWAY_API_KEY, else Vercel OIDC,
 *      as @ai-sdk/gateway resolves it), and stream the answer back unchanged.
 *   5. Meter it after the response (logUsage, feature 'local_agent'): the
 *      Gateway's marketCost, keyed once per generation id.
 *
 * Not a model call (the eve-everywhere tripwire): this route imports no 'ai'
 * and no provider package and builds no LanguageModel. It forwards the bytes
 * of a call the Mac's eve agent makes, the way the Gateway itself does.
 *
 * Usage accuracy: a call is metered from the Gateway's usage (a JSON result,
 * or a stream's `finish` part). When none comes back (the client cancelled
 * mid-stream, or the stream was cut), the upstream request is aborted to stop
 * the spend and the call is metered from an ESTIMATE: the request body's text
 * for input, the output deltas seen for output (metadata.estimated). A
 * forwarded call is never free. The Gateway's own report keeps the truth
 * (requests are tagged with the person via providerOptions.gateway.user).
 *
 * The ChatGPT free tier: POST /api/local-agent/model/plan/responses. A local
 * agent whose person runs on their own ChatGPT plan (its model token's `cp`
 * flag, src/lib/local-agent/tokens.ts) runs an AI SDK OpenAI Responses model
 * against `<relay>/plan` (agents/local-agent/lib/model.ts). Same token,
 * session and slot checks; the usage check opts in to the plan
 * (check_ai_usage_limit(user, true)); then src/lib/chatgpt/plan-proxy.ts calls
 * OpenAI with the person's plan token, and the call is logged at $0 as
 * `chatgpt-plan/<model>`. The Gateway path's usage check stays the one-argument
 * form, so a free user never reaches Native Intelligence's models, whatever the token says.
 *
 * Never for a job on the person's own coding agent (migration 658's
 * `worker`): 403 on both paths, whatever its token says (session-worker.ts).
 *
 * Abuse bounds: at most MAX_CALLS_IN_FLIGHT calls per person at once (a
 * per-person slot, migration 410's local_agent_relay_acquire, freed when the
 * call settles or by its own expiry), and an idle session (24 h) is expired,
 * so its token stops working with it.
 */
import { after } from 'next/server'
import { apiError, forbidden, notFound } from '@/lib/api-errors'
import { checkUsageLimits, extractGatewayCost, logUsage } from '@/lib/ai/auth'
import { appModelIdFromGatewaySlug, usageProviderLabel } from '@/lib/ai/models'
import { getServiceClient } from '@/lib/supabase/service'
import {
  GATEWAY_BASE_URL,
  MAX_BODY_BYTES,
  MAX_CALLS_IN_FLIGHT,
  RELAY_PATH,
  RELAY_PLAN_PATH,
  SLOT_TTL_SECONDS,
  checkSessionToken,
  downstreamHeaders,
  estimateUsage,
  gatewayCredential,
  isAllowedModel,
  meterSse,
  prepareBody,
  upstreamHeaders,
  usageOf,
  type RelayUsage,
} from '@/lib/local-agent/relay'
import type { SupabaseClient } from '@supabase/supabase-js'
import { proxyPlanResponses, type PlanCallSettled } from '@/lib/chatgpt/plan-proxy'
import { readSessionWorker } from '@/lib/local-agent/session-worker'
import { CHATGPT_PLAN_PROVIDER, planModelSlug } from '@/lib/chatgpt/plan-models'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Ctx = { params: Promise<{ path?: string[] }> }

async function recordUsage(
  ids: { userId: string; sessionId: string; workspaceId: string },
  modelSlug: string,
  usage: RelayUsage,
  durationMs: number,
): Promise<void> {
  const model = appModelIdFromGatewaySlug(modelSlug) ?? modelSlug
  const cost = extractGatewayCost({ providerMetadata: usage.providerMetadata })
  await logUsage(ids.userId, {
    provider: usageProviderLabel(model),
    model,
    feature: 'local_agent',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs,
    // A 0 cost is "unavailable" (BYOK), not free: let the RPC price the tokens.
    ...(cost !== undefined && cost > 0 ? { costUsd: cost } : {}),
    metadata: {
      local_agent_session_id: ids.sessionId,
      workspace_id: ids.workspaceId,
      gateway_model: modelSlug,
      ...(usage.estimated ? { estimated: true } : {}),
      ...(usage.generationId ? { generationIds: [usage.generationId] } : {}),
      ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens > 0 ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
    },
    ...(usage.generationId ? { idempotencyKey: `local-agent:${usage.generationId}` } : {}),
  })
}

/** Free a relay slot. Never throws: a missed release frees itself at the slot's expiry. */
async function releaseSlot(svc: SupabaseClient, slotId: string | null): Promise<void> {
  if (!slotId) return
  try {
    await svc.from('local_agent_relay_slot').delete().eq('id', slotId)
  } catch {
    /* it expires on its own */
  }
}

/** After the response: meter the call (its usage, else an estimate) and free its slot. */
function settle(
  svc: SupabaseClient,
  slotId: string | null,
  ids: { userId: string; sessionId: string; workspaceId: string },
  modelSlug: string,
  started: number,
  usage: Promise<RelayUsage> | RelayUsage,
) {
  after(async () => {
    try {
      await recordUsage(ids, modelSlug, await usage, Date.now() - started)
    } catch (err) {
      console.error('[local-agent] relay metering failed:', err instanceof Error ? err.message : err)
    } finally {
      await releaseSlot(svc, slotId)
    }
  })
}

/** A slot: at most MAX_CALLS_IN_FLIGHT calls per person at once. The slot id, or the refusal. */
async function acquireSlot(svc: SupabaseClient, uid: string, sid: string): Promise<string | Response> {
  const { data: slot, error: slotError } = await svc.rpc('local_agent_relay_acquire', {
    p_user_id: uid,
    p_session_id: sid,
    p_max: MAX_CALLS_IN_FLIGHT,
    p_ttl_seconds: SLOT_TTL_SECONDS,
  })
  if (slotError) return apiError('Relay unavailable', { status: 503, code: 'UNAVAILABLE' })
  if (typeof slot !== 'string' || !slot) {
    return apiError('Too many model calls in flight', { status: 429, code: 'TOO_MANY_CALLS' })
  }
  return slot
}

/** Log a plan call (its usage, from the stream) at no cost: the person's own ChatGPT plan paid. */
async function recordPlanUsage(
  ids: { userId: string; sessionId: string; workspaceId: string },
  settled: PlanCallSettled,
  durationMs: number,
): Promise<void> {
  const usage = settled.outcome?.usage
  if (!settled.model || !usage) return
  await logUsage(ids.userId, {
    provider: CHATGPT_PLAN_PROVIDER,
    model: planModelSlug(settled.model),
    feature: 'local_agent',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs,
    metadata: {
      local_agent_session_id: ids.sessionId,
      workspace_id: ids.workspaceId,
      cost_source: 'chatgpt_plan',
      ...(usage.cachedInputTokens > 0 ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningTokens > 0 ? { reasoning_tokens: usage.reasoningTokens } : {}),
    },
  })
}

/**
 * The plan path (the ChatGPT free tier, the file comment): the person's own
 * plan through plan-proxy.ts, after the opted-in usage check and a slot.
 */
async function planCall(request: Request, svc: SupabaseClient, auth: { sid: string; uid: string; row: { workspace_id: string } }): Promise<Response> {
  const { sid, uid, row } = auth
  try {
    await checkUsageLimits(uid, undefined, { chatgptPlan: true })
  } catch (err) {
    if (err instanceof Response) return err
    throw err
  }
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return apiError('Request too large', { status: 413, code: 'TOO_LARGE' })
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) return apiError('Request too large', { status: 413, code: 'TOO_LARGE' })

  const slot = await acquireSlot(svc, uid, sid)
  if (slot instanceof Response) return slot
  const ids = { userId: uid, sessionId: sid, workspaceId: row.workspace_id }
  const started = Date.now()
  // Metered and freed after the response, as the Gateway path's settle does:
  // registered here, in the request's scope, and run once the call settles
  // (the core settles exactly once, however the stream ends), so the stream
  // never waits on these writes.
  let settle: (settled: PlanCallSettled) => void = () => undefined
  const settled = new Promise<PlanCallSettled>((resolve) => (settle = resolve))
  after(async () => {
    try {
      await recordPlanUsage(ids, await settled, Date.now() - started)
    } catch (err) {
      console.error('[local-agent] plan metering failed:', err instanceof Error ? err.message : err)
    } finally {
      await releaseSlot(svc, slot)
    }
  })
  try {
    return await proxyPlanResponses(request, uid, { rawBody, onSettled: settle })
  } catch (err) {
    // Never expected (the core answers every known state), but the slot is freed either way.
    settle({ model: null, outcome: null })
    throw err
  }
}

export async function POST(request: Request, ctx: Ctx) {
  const { path } = await ctx.params
  const joined = (path ?? []).join('/')
  if (joined !== RELAY_PATH && joined !== RELAY_PLAN_PATH) return notFound()

  // The token, then the session: live, owned by the token's `uid`, not idle
  // (checkSessionToken, shared with the Mac body's spec and tool routes).
  const svc = getServiceClient()
  const checked = await checkSessionToken(request, svc)
  if (!checked.ok) return checked.response
  const { sid, uid } = checked.claims
  const row = checked.session
  // A job on the person's own coding agent (migration 658) runs on their own
  // account with its vendor: never on ours, on either path. A worker that
  // can't be read is refused too.
  try {
    if (await readSessionWorker(svc, sid, uid)) {
      return forbidden('This job runs on your own coding agent: it has no Native Intelligence model.')
    }
  } catch {
    return apiError('Session check failed', { status: 503, code: 'UNAVAILABLE' })
  }
  // The person's own ChatGPT plan (the free tier): its own path, never the Gateway.
  if (joined === RELAY_PLAN_PATH) return planCall(request, svc, { sid, uid, row })

  const modelSlug = (request.headers.get('ai-language-model-id') ?? '').trim()
  if (!isAllowedModel(modelSlug)) return forbidden('This model is not available to local agents')

  try {
    await checkUsageLimits(uid)
  } catch (err) {
    if (err instanceof Response) return err
    throw err
  }

  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return apiError('Request too large', { status: 413, code: 'TOO_LARGE' })
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return apiError('Request too large', { status: 413, code: 'TOO_LARGE' })
  const prepared = prepareBody(raw, { userId: uid, sessionId: sid })
  if (!prepared.ok) {
    if (prepared.reason === 'model') return forbidden('This model is not available to local agents')
    if (prepared.reason === 'tool') return forbidden('Local agents cannot use provider-run tools (their network is off)')
    return apiError('Invalid request body', { status: 400, code: 'BAD_REQUEST' })
  }

  const cred = await gatewayCredential(request)
  if (!cred) return apiError('Model gateway not configured', { status: 503, code: 'NOT_CONFIGURED' })

  const slot = await acquireSlot(svc, uid, sid)
  if (slot instanceof Response) return slot

  const ids = { userId: uid, sessionId: sid, workspaceId: row.workspace_id }
  const started = Date.now()
  const inputChars = raw.length
  const controller = new AbortController()
  let upstream: Response
  try {
    upstream = await fetch(`${GATEWAY_BASE_URL}/${RELAY_PATH}`, {
      method: 'POST',
      headers: upstreamHeaders(request.headers, cred),
      body: prepared.body,
      signal: controller.signal,
    })
  } catch (err) {
    console.error('[local-agent] relay upstream failed:', err instanceof Error ? err.message : err)
    await releaseSlot(svc, slot)
    return apiError('Model gateway unreachable', { status: 502, code: 'UPSTREAM' })
  }

  const headers = downstreamHeaders(upstream.headers)
  if (!upstream.ok || !upstream.body) {
    // The Gateway's own error body, unchanged: the Mac's provider parses it.
    // A refused call generated nothing: no usage.
    await releaseSlot(svc, slot)
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    let resolve: (u: RelayUsage) => void = () => undefined
    const usage = new Promise<RelayUsage>((r) => (resolve = r))
    const body = meterSse(
      upstream.body,
      // The finish part's usage, else (cancelled or cut short) an estimate: never free.
      (tally) => resolve(tally.usage ?? estimateUsage(inputChars, tally.outputChars)),
      () => controller.abort(),
    )
    settle(svc, slot, ids, modelSlug, started, usage)
    return new Response(body, { status: upstream.status, headers })
  }

  const text = await upstream.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* passed back as is; metered from an estimate */
  }
  settle(svc, slot, ids, modelSlug, started, usageOf(parsed) ?? estimateUsage(inputChars, text.length))
  return new Response(text, { status: upstream.status, headers })
}
