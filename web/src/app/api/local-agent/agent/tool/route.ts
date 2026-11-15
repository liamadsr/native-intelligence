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
 * 8. A job on the person's own coding agent (migration 658's worker; board
 *    step 4, src/lib/local-agent/worker-tools.ts): everything above for its
 *    caller class (macWorkerCeiling), less the server-run web tools and the
 *    Mac's teammate tools (TOOL_OUT_OF_CEILING), through the same ceiling,
 *    caller policy, go-ahead check, reviewer (BLOCKING), outward gate and
 *    cards. Its `search_tools` answers each match's schema; `call_tool` never
 *    reaches here (the adapter unwraps it). The desktop posts `callId` (the
 *    call's own id), `turnId` (one per agent turn) and `sessionId` (the
 *    job's id), all required: the breaker and the go-ahead guard key on the
 *    job, `sessionId` and `turnId`.
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
  macWorkerCeiling,
  usageRefusal,
  withMacConfirmWording,
} from '@/lib/local-agent/agent-access'
import { createWorkerSearchTool } from '@/lib/local-agent/worker-tools'
import { WRITE_BUDGET_CODE, WRITE_BUDGET_MESSAGE, countWorkerWrite } from '@/lib/local-agent/worker-write-budget'
import { agentWriterFor } from '@/lib/actions/agent-writer'
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

  // A job on the person's own coding agent (board step 4): everything Native Intelligence's
  // own agent on the Mac has for the class (macWorkerCeiling, below), through
  // the same checks, reviewer and cards, but never the server-run web tools or
  // the Mac's teammate tools. The ids are required: the breaker counts by them.
  const worker = mac.session.worker
  if (worker) {
    for (const [field, value] of [['sessionId', body.sessionId], ['turnId', body.turnId], ['callId', body.callId]] as const) {
      if (typeof value !== 'string' || !value || value.length > 200) return badRequest(`${field} is required (a string of at most 200 characters)`)
    }
    if (isMacNativeTool(toolName) || isMacWebTool(toolName)) return outOfCeiling(toolName, "isn't one of a coding agent's Native Intelligence tools (it has its own)")
  }

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
  const ceilingOpts = { caller: mac.caller, localModel: mac.session.localModel }
  const ceiling = worker ? macWorkerCeiling(chatCeiling, externalMcpToolNames, ceilingOpts) : macCeiling(chatCeiling, externalMcpToolNames, ceilingOpts)
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
  // The person's own job keeps the flag: they are there to give it. Not a
  // job on their own coding agent, whatever its class: nobody can say yes
  // inside its turn, and the paid tools (enrich_contact, the prospecting
  // searches) are internal writes the reviewer never sees, so the agent, or
  // text it read, could claim the yes and run them in a loop.
  if (unattended || worker) {
    const noYes = unattendedGoAheadRefusal(body.input)
    if (noYes) return NextResponse.json({ output: noYes })
  }
  // A coding agent's writes are bounded per job (worker-write-budget.ts:
  // process-local counts), last before the call runs: refused ones don't count.
  if (worker && !countWorkerWrite(mac.session.id, toolName, body.input).allowed) {
    return apiError(WRITE_BUDGET_MESSAGE, { status: 429, code: WRITE_BUDGET_CODE })
  }

  // ── The REAL tools, under the session's tenancy ─────────────────────────────
  // A session token carries no JWT: no accessToken (the tools that need one are excluded).
  return runTool(
    ctx,
    toolName,
    body.input,
    scope,
    {
      // A worker has no dynamic loading: its search answers each match's schema (worker-tools.ts).
      search_tools: worker ? createWorkerSearchTool(ceiling, externalMcp.tools) : createSearchToolsTool(ceiling),
      // A worker's writes go through the person's agent's client (agent-writer.ts): the activity log credits "<name>'s agent".
      ...createTools(mac.session.userId, worker ? agentWriterFor(mac.session.userId) : svc, mac.session.workspaceId, undefined, macCreateToolsOptions(mac, ctx, { ...scope, timeZone: body.timeZone })),
      ...withMacConfirmWording(externalMcp.tools, svc, mac),
    },
    { externalTool: externalToolPolicy(externalMcp.meta, toolName), gate: macGate(mac, svc) },
  )
}

