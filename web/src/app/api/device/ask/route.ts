import { usageProviderLabel } from '@/lib/ai/models'
import { surfaceModel } from '@/lib/ai/model-defaults'
import { authenticateUser, checkUsageLimits, logUsage } from '@/lib/ai/auth'
import { isChatGptPlanUsage, PLAN_MAIN_MODEL, planModelSlug } from '@/lib/chatgpt/plan-models'
import { apiError } from '@/lib/api-errors'
import { isDeviceToken, resolveDeviceToken } from '@/lib/device-tokens'
import {
  runDeviceAskViaEve,
  assertDeviceAskMembership,
  DeviceAskEveError,
  DeviceAskNotMemberError,
  DeviceAskMembershipLookupError,
  deviceAskCredential,
  deviceAskEveBudgetMs,
  deviceAskBilledModel,
  type DeviceAskUsage,
} from '@/lib/chat/device-ask-eve'

export const maxDuration = 60

/**
 * POST /api/device/ask
 *
 * A thin, NON-STREAMING entry point to the same agent that powers the in-app
 * chat — built for memory-constrained hardware clients (the ESP32 device) that
 * can't comfortably parse a streamed UI-message protocol.
 *
 * The device sends a single plain-text question; the server runs the full
 * tool-using chat agent (the eve chat-agent: the chat's layered prompt, the
 * edition-ceilinged workspace tools, the user's connected external MCP servers,
 * web access) to completion as a one-shot TASK session, capped at 12 model
 * steps — see src/lib/chat/device-ask-eve.ts for why that agent and that mode,
 * and how the session is owned — and returns one JSON blob:
 *
 *   Request:  { question: string }   (an old device's `model` is ignored: the model is fixed)
 *   Response: { ok: true, text: string, tool_calls: number, duration_ms: number }
 *   Errors:   400 { error } · 401/429/503 from auth + the usage gate ·
 *             403 { error } when the user is not a member of the resolved workspace ·
 *             500 { error, code: 'MEMBERSHIP_LOOKUP_FAILED' } when that membership
 *               check itself failed (transient — retry; nothing ran) ·
 *             500 { error: 'Agent request failed' }
 *
 * Auth: cookie session OR `Authorization: Bearer` (a Supabase JWT or a d8d_
 * device token). The same credential is relayed to the chat-agent, whose
 * session-ownership ACL admits only the principal that owns the session.
 * Conversation is stateless — one question, one answer.
 */
export async function POST(req: Request) {
  const startTime = Date.now()
  // Set once the eve session is about to run, so the catch can meter a failed ask.
  let billing: { userId: string; model: string } | null = null

  try {
    const { user, supabase, via } = await authenticateUser(req)
    // Throws the 429 / 503 Response when the person may not spend. Opted in to
    // the ChatGPT free tier: a person on their own plan asks on it (the turn's
    // rebuild puts it there), billed to the plan, never Dial8's models.
    const onPlan = isChatGptPlanUsage(await checkUsageLimits(user.id, undefined, { chatgptPlan: true }))

    const body = await req.json()
    const { question } = body as { question?: string }

    if (!question || typeof question !== 'string' || !question.trim()) {
      return Response.json({ error: 'question is required' }, { status: 400 })
    }

    // Resolve workspace. For a device token, use the token's resolved active
    // workspace (active_workspace_id, else the owner's oldest) — the device's
    // workspace picker controls this, so the agent runs where the device is
    // pointed. For cookie/JWT auth, fall back to the user's OLDEST workspace
    // (deterministic order by created_at — not an unordered limit(1), which
    // could non-deterministically pick the wrong workspace).
    // The device path ONLY when the device token is what authenticated (`via`):
    // a stale d8d_ bearer next to a valid cookie authenticated as the COOKIE
    // user, and must not pick that user's workspace from another user's device.
    const authHeader = req.headers.get('authorization') || ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined

    let workspaceId: string | null = null
    if (via === 'device' && bearerToken && isDeviceToken(bearerToken)) {
      const resolved = await resolveDeviceToken(bearerToken)
      workspaceId = resolved?.workspaceId ?? null
    }
    if (!workspaceId) {
      const { data: membership } = await supabase
        .from('member')
        .select('workspace_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      workspaceId = membership?.workspace_id ?? null
    }
    if (!workspaceId) {
      return Response.json({ error: 'No workspace found' }, { status: 400 })
    }
    // Owner derivation BEFORE any workspace-scoped read: a device token's
    // active_workspace_id is not membership-checked when it resolves, and the
    // ask runs in this workspace. A non-member is 403 and a
    // lookup error 500 (both mapped in the catch), with nothing read or run.
    await assertDeviceAskMembership(user.id, workspaceId)

    // A fixed model (auto selection: the desktop quick ask runs Flash with
    // thinking off, the one chat call that does: 60 s holds no reasoning): the chat spec the session runs on decides the same way
    // (routeChatTurn's 'device' kind), and usage is billed against the model
    // that actually ran.
    const selectedModel = onPlan ? planModelSlug(PLAN_MAIN_MODEL) : surfaceModel('device_ask')

    // Relay the credential that authenticated (a stale bearer next to a valid
    // cookie authenticated via the cookie — relay the cookie, not the bearer).
    const credential = deviceAskCredential(req, via)
    if (!credential) throw new Error('device ask: no relayable credential on an authenticated request')

    billing = { userId: user.id, model: selectedModel }
    const result = await runDeviceAskViaEve({
      userId: user.id,
      workspaceId,
      question,
      model: selectedModel,
      chatgptPlan: onPlan,
      credential,
      // Wall budget for the eve session: what is LEFT of maxDuration after the
      // prelude above, minus the timeout's cancel + cleanup + usage log — so a
      // slow agent still gets this route's own 500 JSON (the device prints it)
      // and its failed-usage row, not the platform's timeout page.
      timeoutMs: deviceAskEveBudgetMs({ startTime, maxDurationMs: maxDuration * 1000 }),
    })

    await logDeviceAskUsage(user.id, selectedModel, result.usage, Date.now() - startTime)

    return Response.json({
      ok: true,
      text: result.text,
      tool_calls: result.usage.toolCalls,
      duration_ms: Date.now() - startTime,
    })
  } catch (error) {
    if (error instanceof Response) return error
    // Refused before anything ran (no session, no spend): the resolved workspace
    // is not one the user belongs to — typically a device pointed at a
    // workspace they have left. The device can print this and re-pick.
    if (error instanceof DeviceAskNotMemberError) {
      return Response.json({ error: 'Not a member of the selected workspace' }, { status: 403 })
    }
    // The membership check itself failed (a DB error): membership is UNKNOWN,
    // not refused — a 500 the device can retry, with its own code, never the
    // 403 that would tell it to re-pick its workspace. Nothing ran.
    if (error instanceof DeviceAskMembershipLookupError) {
      console.error('Device ask membership lookup failed:', error)
      return apiError('Could not verify workspace membership', { status: 500, code: 'MEMBERSHIP_LOOKUP_FAILED' })
    }
    // A failed / timed-out ask still spent model tokens before the session was
    // cancelled — meter them (same feature key; outcome:'failed'), never drop
    // them. An ask that completed no step logs nothing rather than a 0 row.
    if (
      billing &&
      error instanceof DeviceAskEveError &&
      error.usage &&
      (error.usage.inputTokens > 0 || error.usage.outputTokens > 0)
    ) {
      await logDeviceAskUsage(billing.userId, billing.model, error.usage, Date.now() - startTime, 'failed').catch(
        (logErr) => console.error('Device ask usage log failed:', logErr),
      )
    }
    console.error('Device ask error:', error)
    return Response.json({ error: 'Agent request failed' }, { status: 500 })
  }
}

/**
 * The device ask's ai_usage_logs row — one shape for success and failure.
 * Feature 'device_ask' (byte-identical to the in-process route). Tokens are
 * SUMMED over every completed step (summarizeDeviceAskUsage → mapEveTurnUsage;
 * the in-process route billed only its final step, which under-billed every
 * multi-step ask); the model is the one the final step ran on
 * ({@link deviceAskBilledModel}); `costUsd` follows the eve rule (null →
 * omitted, so the log_ai_usage RPC prices from ai_model_costs) and is only ever
 * read off the eve stream by this server. Metadata keys as before: toolCalls,
 * steps, webSearchCostUsd when present — plus generationIds when the Gateway
 * returned any (reconciliation only), the cache keys log_ai_usage reads to
 * price cached Claude input at the cache rates (only when present),
 * requestedModel when the run fell back to another model, and outcome:'failed'
 * on a failed ask only.
 */
function logDeviceAskUsage(
  userId: string,
  requestedModel: string,
  usage: DeviceAskUsage,
  durationMs: number,
  outcome?: 'failed',
) {
  const model = deviceAskBilledModel(requestedModel, usage)
  return logUsage(userId, {
    provider: usageProviderLabel(model),
    model,
    feature: 'device_ask',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs,
    ...(usage.costUsd !== null ? { costUsd: usage.costUsd } : {}),
    metadata: {
      toolCalls: usage.toolCalls,
      steps: usage.steps,
      ...(usage.webSearchCostUsd !== null ? { webSearchCostUsd: usage.webSearchCostUsd } : {}),
      // The Gateway reconciliation key, as on eve chat rows (persist-eve-turn).
      ...(usage.generationIds.length > 0 ? { generationIds: usage.generationIds } : {}),
      // Cached input (INCLUDED in inputTokens), as the chat and live-agent rows send it.
      ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens > 0 ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
      ...(model !== requestedModel ? { requestedModel } : {}),
      ...(outcome ? { outcome } : {}),
    },
  })
}
