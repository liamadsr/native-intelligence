/**
 * POST /api/local-agent/agent/tool  { toolName, input } — the Mac body's tools
 * (docs/plans/teammate-agent.md C1).
 *
 * The Mac body's Native Intelligence tools and connected MCP tools are thin proxies, as the
 * cloud body's are: they post here and the REAL tool runs on the server, the
 * same way /api/internal/chat/tool runs it (the shared run,
 * src/lib/chat/chat-tool-dispatch.ts: the repeat breaker, the go-ahead guard,
 * the real schema, the reviewer and the outward gate, approval cards,
 * outside-text marking, touches).
 *
 * ── What this route owns ────────────────────────────────────────────────────
 * 1. AUTH: `Authorization: Bearer <session token>` (the job's `la1.…` model
 *    token), never the shared internal secret. Every call re-checks the token,
 *    the session (live, the token user's own, not idle, not asked to stop),
 *    the workspace and its membership, the session's conversation and its
 *    local-model flag (authorizeMacBody), then the person's usage limit.
 *    Tenancy comes ONLY from the session row.
 * 2. CEILING, re-derived on every call, as the MAIN chat of the session's
 *    conversation (the one resolveChatCeiling, no agent: edition ∪ the
 *    person's MCP tools), narrowed for the Mac (macCeiling): never the relay,
 *    helper, local-agent or browser tools, the screen's tools, or the
 *    attended-only tools its caller class is denied. What the spec route
 *    advertises is what is enforced here.
 * 3. THE CALLER (src/lib/safety/caller.ts): person_remote only for a job the
 *    person started, or the cloud agent started from their typed turn (the
 *    chat tool's start key), so an outward call is the person's card;
 *    unattended otherwise. Every call is reviewed BLOCKING (mustEnforce), on
 *    the person's words as the server stored them at the job's start or join;
 *    a job a loop started (L5, WS-D: unattendedToolReview) on the loop's
 *    saved request instead.
 * 4. web_fetch / web_search (src/lib/local-agent/web-tools.ts): run here, so the
 *    Mac's network stays off; reads, never reviewed. Never on a local model.
 * 5. A LOCAL MODEL (local_agent_session.local_model): every RISKY call is held
 *    as the person's card, whatever the reviewer says (localModelGate);
 *    internal writes stay apply-with-undo.
 * 6. CARDS ask in the person's home thread (nobody reads the Mac's turns in a
 *    chat), name the Mac and the job (context.localAgent), at most five per
 *    job wait at once, and the model is told where they are (macGate,
 *    withMacConfirmWording). The words, seq and staleness the Mac posts are
 *    never the reviewer's evidence.
 * 7. The Mac's own teammate tools (C4, WS-C: src/lib/local-agent/agent-seams.ts):
 *    their handler's answer as is, no reviewer (neither writes outside Native Intelligence;
 *    each keys on eve's ids).
 *
 * Status writes are an agent's (one hop from the person), id-based tools are
 * fenced to the session's workspace, and a session token carries no JWT, so
 * the tools that call back into the app as the person are not here.
 */
import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { createTools } from '@/lib/ai/tools'
import { createSearchToolsTool } from '@/lib/ai/tool-discovery'
import { resolveChatCeiling } from '@/lib/chat/chat-ceiling'
import {
  deferAfterResponse,
  externalToolPolicy,
  loadChatExternalTools,
  runTool,
  type ToolCallScope,
} from '@/lib/chat/chat-tool-dispatch'
import { callerMayCall, callerRefusalMessage } from '@/lib/safety/caller'
import {
  authorizeMacBody,
  macCeiling,
  macCreateToolsOptions,
  macDispatchContext,
  macExcludedTools,
  macGate,
  usageRefusal,
  withMacConfirmWording,
} from '@/lib/local-agent/agent-access'
import { isMacNativeTool, runMacNativeTool, unattendedToolReview } from '@/lib/local-agent/agent-seams'
import { createMacWebTools, isMacWebTool } from '@/lib/local-agent/web-tools'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { unattendedGoAheadRefusal } from '@/lib/ai/tools/go-ahead'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A web_fetch may take 120 s; a tool's own work fits beside it. */
export const maxDuration = 300

interface MacToolCallBody {
  toolName?: unknown
  input?: unknown
  /** eve's durable call, turn and session ids (the Mac's eve session, not the local_agent_session). */
  callId?: unknown
  turnId?: unknown
  sessionId?: unknown
  /** The Mac's IANA zone. Checked, never trusted. (Posted person words, seq and staleness are ignored.) */
  timeZone?: unknown
}

function outOfCeiling(toolName: string, why: string): Response {
  return apiError(`'${toolName}' ${why}`, { status: 403, code: 'TOOL_OUT_OF_CEILING' })
}

export async function POST(request: Request) {
  const svc = getServiceClient()
  const authorized = await authorizeMacBody(request, svc)
  if (authorized instanceof Response) return authorized
  const usage = await usageRefusal(authorized.session.userId)
  if (usage) return usage
  // A job a loop started (L5): its class, and the loop's saved request as the
  // reviewer's evidence. A failed read refuses: never the attended policy.
  let unattended: Awaited<ReturnType<typeof unattendedToolReview>>
  try {
    unattended = await unattendedToolReview(svc, { userId: authorized.session.userId, sessionId: authorized.session.id })
  } catch (err) {
    console.error('[local-agent] unattended review lookup failed:', err instanceof Error ? err.message : err)
    return apiError('Could not check how this job was started. Try again.', { status: 503, code: 'UNAVAILABLE' })
  }
  // The kill switch or the workspace's pause reached a loop's job mid-flight:
  // nothing runs, and the job was asked to stop (S1, S2).
  if (unattended && 'refused' in unattended) return apiError(unattended.reason, { status: 403, code: unattended.code })
  const mac = unattended ? { ...authorized, caller: unattended.caller } : authorized

  let body: MacToolCallBody
  try {
    body = (await request.json()) as MacToolCallBody
  } catch {
    return badRequest('invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('invalid JSON body')
  const toolName = body.toolName
  if (!toolName || typeof toolName !== 'string') return badRequest('missing toolName')

  const ctx = macDispatchContext(svc, mac)
  if (unattended) {
    // The loop's saved request is the evidence, not the person's words.
    const { caller: _caller, ...review } = unattended
    ctx.reviewOverride = review
  }
  // eve's ids key the per-turn guards. The person's words come from the server (ctx.reviewOverride).
  const scope: ToolCallScope = { sessionId: body.sessionId, turnId: body.turnId }

  // Never on the Mac, before anything else is consulted.
  if (macExcludedTools(mac.caller).has(toolName)) return outOfCeiling(toolName, "isn't available to Native Intelligence on the Mac")

  // The Mac's own teammate tools (C4): the handler checks eve's ids and the
  // input, and its answer goes back as is.
  if (isMacNativeTool(toolName)) {
    try {
      const result = await runMacNativeTool(
        svc,
        { userId: mac.session.userId, workspaceId: mac.session.workspaceId, sessionId: mac.session.id },
        toolName,
        body.input,
        { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId },
      )
      return NextResponse.json(result.body, { status: result.status })
    } catch (err) {
      console.error(`[local-agent] ${toolName} failed:`, err instanceof Error ? err.message : err)
      return apiError(`Could not confirm ${toolName} went through. Don't call it again; tell the person.`, { status: 503, code: 'TOOL_EXECUTE_FAILED' })
    }
  }

  // The web, run here so the Mac's network stays off: reads, never reviewed.
  if (isMacWebTool(toolName)) {
    if (mac.session.localModel) return outOfCeiling(toolName, "isn't available while Native Intelligence on the Mac runs on a model on the Mac")
    // A person on their own ChatGPT plan (the free tier) never runs Exa
    // (Native Intelligence's). A plan that can't be read runs no web tool.
    let chatgptPlan: boolean
    try {
      chatgptPlan = await chatgptPlanFor(mac.session.userId, { attempts: 2, failClosed: true })
    } catch (err) {
      console.error('[local-agent] plan check failed:', err instanceof Error ? err.message : err)
      return apiError('Could not check where this runs. Try again.', { status: 503, code: 'UNAVAILABLE' })
    }
    const web = createMacWebTools({
      sessionId: mac.session.id,
      userId: mac.session.userId,
      workspaceId: mac.session.workspaceId,
      defer: deferAfterResponse,
      chatgptPlan,
    })
    return runTool(ctx, toolName, body.input, scope, web, { sideEffect: null })
  }

  // ── CEILING (re-derived from the session, never model-visible) ─────────────
  // The main chat's (no agent persona): the edition ∪ the person's MCP tools,
  // the same resolveChatCeiling the spec rebuild advertises from, narrowed for
  // the Mac by the same macCeiling the spec route applies.
  const externalMcp = await loadChatExternalTools(ctx, scope)
  const externalMcpToolNames = Object.keys(externalMcp.tools)
  const chatCeiling = await resolveChatCeiling(svc, {
    workspaceId: mac.session.workspaceId,
    agentToolCeiling: null,
    externalMcpToolNames,
  })
  const ceiling = macCeiling(chatCeiling, externalMcpToolNames, { caller: mac.caller, localModel: mac.session.localModel })
  if (toolName !== 'search_tools' && !ceiling.has(toolName)) {
    // Fail-closed boundary (F1 lesson). An out-of-ceiling or unknown call never executes.
    return outOfCeiling(toolName, "is not in this conversation's ceiling")
  }
  // The trust authority (caller.ts): past the ceiling, the one policy.
  if (!callerMayCall(mac.caller, toolName)) {
    return apiError(callerRefusalMessage(toolName), { status: 403, code: 'CALLER_NOT_ALLOWED', details: { caller: mac.caller } })
  }
  // A job a loop started has nobody to have said yes: a paid call (a
  // prospecting search, enrich_contact) with `confirmed_with_user: true` is the
  // model guessing, refused before it runs, as on a skill run (go-ahead.ts).
  // The person's own job keeps the flag: they are there to give it.
  if (unattended) {
    const noYes = unattendedGoAheadRefusal(body.input)
    if (noYes) return NextResponse.json({ output: noYes })
  }

  // ── The REAL tools, under the session's tenancy ─────────────────────────────
  // A session token carries no JWT: no accessToken (the tools that need one are excluded).
  return runTool(
    ctx,
    toolName,
    body.input,
    scope,
    {
      search_tools: createSearchToolsTool(ceiling),
      ...createTools(mac.session.userId, svc, mac.session.workspaceId, undefined, macCreateToolsOptions(mac, ctx, { ...scope, timeZone: body.timeZone })),
      ...withMacConfirmWording(externalMcp.tools, svc, mac),
    },
    { externalTool: externalToolPolicy(externalMcp.meta, toolName), gate: macGate(mac, svc) },
  )
}
