/**
 * POST /api/internal/live-agent/tool   (token via header; body { toolName, input })
 *
 * INTERNAL-ONLY tool dispatch for the eve `live-agent` mount (LIVE-AGENT-DESIGN
 * §5.3). The mount's workspace tools are thin PROXIES whose `execute` posts
 * here; this route runs the REAL tool — the createLiveAgentTools +
 * buildLiveAgentReadTools factories, assembled into the ceiling-built map
 * (assembleLiveAgentToolSet) — so the Next-coupled tool code never compiles into
 * the eve runtime. Since the cloud route's model call moved to eve this is the
 * ONLY place the cloud live agent's tools execute (the cloud route runs none
 * in-process; /stage calls only propose_change + write_summary), using /stage's
 * calling convention (a synthetic `{}` options object); neither factory changes.
 *
 * ── The two security boundaries this route owns ─────────────────────────────
 * 1. AUTH: the shared internal secret (constant-time) proves the caller is our
 *    own eve runtime; the HMAC-signed run token proves + scopes the call to one
 *    turn of one capture.
 * 2. CEILING (STRUCTURAL, server-side): the requested tool MUST be in the turn's
 *    ceiling, RE-DERIVED here from the verified token alone —
 *    computeLiveAgentCeiling(turnType, assistOnly, persona selection), with the
 *    persona (and so assist-only) re-resolved from the database, never read off
 *    the request. The eve resolver only ever advertises ceiling tools; this is
 *    the third, independent layer (the F1 lesson). `search_tools` is permitted
 *    unconditionally — it is read-only discovery, clamped to the same ceiling.
 *
 * Tenancy (captureId, workspaceId, userId) comes ONLY from the verified token;
 * the capture's team/project and the assisted member are re-derived from their
 * rows (./live-agent-spec.ts loadLiveAgentTurnState). Tool behavior that
 * branches on eval isolation is left INSIDE the tools: `isEvalCapture` is
 * threaded through exactly as the cloud route threads it (record_commitment's
 * claim-write suppression, the read surface's private-capture omission) — this
 * route never short-circuits an eval call itself.
 *
 * ── TIME GUARD (copilot ticks) ──────────────────────────────────────────────
 * After the ceiling check, liveTimeGuard (src/lib/live-agent/time-guard.ts)
 * measures the window's age from the token's optional windowFlushedAt claim
 * (else the turn start, exp - TTL): past 25 s a read tool is refused on an
 * assist-only copilot (a record-writing copilot keeps its reads), and past 45 s
 * say_to_user is dropped as stale on every copilot tick, before it persists or
 * broadcasts anything.
 *
 * ── CONNECTED-APP LOOKUPS (copilot turns; src/lib/live-agent/mcp-lookups.ts) ─
 * An `mcp__<server>__<tool>` call is permitted only when the name is in the
 * turn's lookup catalog, RE-DERIVED here from the person's live server rows
 * (and read only for an `mcp__` call on a token stamped `mcpLookups`). The
 * catalog holds only tools chat runs without approval that the server ALSO
 * marks readOnlyHint and that carry a read-shaped name, so no write is
 * reachable through this path even if a server mislabels one signal. Past the
 * ceiling and the time guard (the 25 s research cutoff covers lookups on an
 * assist-only copilot), a call runs through chat's adapter path with a 5 s
 * deadline, at most 3 per token (an in-memory count per instance; the eve
 * mount counts per session too), and a ~4K-character result fenced as
 * untrusted. An expired connection answers as a normal tool result.
 *
 * ── SHADOW nudge.worth (live sidekick Phase 7) ──────────────────────────────
 * After say_to_user DELIVERS a nudge, shadowNudgeWorth (nudge-worth-shadow.ts)
 * asks Jev whether it was worth the interruption, inside Next's after(): the
 * tool result returns first, the check never changes it, and a stale nudge
 * (dropped by the time guard above) never reaches it. Eval captures skip it.
 *
 * ── search_contacts — CONTACT VISIBILITY FENCE ──────────────────────────────
 * The route's client is service-role, so RLS no longer hides another member's
 * PRIVATE contacts. search_contacts fences its own rows through
 * contact_visible_to(contact, token user) — the userId this route hands the
 * factory — over-fetching first so hidden rows cannot crowd visible matches
 * out (src/lib/live-agent/tools.ts). The route no longer re-fences its output:
 * a second pass after the tool's 5-row cut could only drop, never refill.
 *
 * ── get_attachment_content — SIGNED-URL FALLBACK ────────────────────────────
 * get_attachment_content IS in LIVE_AGENT_READ_TOOLS. eve tool output is text|
 * json only, so its internal image-transport keys (__imageBase64 /
 * __imageMimeType) are STRIPPED before the output crosses the boundary — the
 * model gets the signed URL + text metadata, never raw image bytes (the same
 * treatment as /api/internal/chat/tool).
 */
import { NextResponse } from 'next/server'
import { recordToolCallTouches } from '@/lib/work/touch'
import type { ToolSet } from 'ai'
import { createLiveAgentTools } from '@/lib/live-agent/tools'
import { buildLiveAgentReadTools } from '@/lib/live-agent/read-tools'
import { resolveClaimsAutoAcceptPolicyFromSettings } from '@/lib/knowledge/auto-accept'
import { computeLiveAgentCeiling } from '@/lib/live-agent/ceiling'
import { callerClassOf, callerMayCall, callerRefusalMessage } from '@/lib/safety/caller'
import { personaToolSelection } from '@/lib/live-agent/read-tool-names'
import { assembleLiveAgentToolSet } from '@/lib/live-agent/turn-composition'
import { loadLiveAgentTurnState, loadLiveLookupsForTurn, type LiveAgentTurnState } from '@/lib/live-agent/live-agent-spec'
import { shadowNudgeWorth } from '@/lib/live-agent/nudge-worth-shadow'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { withoutToolImage } from '@/lib/ai/tools/tool-image'
import { liveTimeGuard } from '@/lib/live-agent/time-guard'
import { LIVE_MCP_TOOL_PREFIX } from '@/lib/live-agent/read-tool-names'
import { MCP_LIMIT_MESSAGE, claimLiveMcpCall, runLiveMcpLookup } from '@/lib/live-agent/mcp-lookups'
import { trackServerEvent } from '@/lib/posthog'
import {
  extractInternalSecret,
  extractLiveAgentRunToken,
  liveAgentRunTokenKey,
  liveWindowStartedAt,
  verifyInternalSecret,
  verifyLiveAgentRunToken,
} from '@/lib/live-agent/live-agent-run-token'

export const dynamic = 'force-dynamic'

interface ToolCallBody {
  toolName?: unknown
  input?: unknown
}

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid run token — the authoritative source of tenancy + turn type.
  const claims = verifyLiveAgentRunToken(extractLiveAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  let body: ToolCallBody
  try {
    body = (await request.json()) as ToolCallBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const toolName = body.toolName
  if (!toolName || typeof toolName !== 'string') {
    return NextResponse.json({ error: 'missing toolName' }, { status: 400 })
  }

  const state = await loadLiveAgentTurnState(claims)
  if (!state) {
    return NextResponse.json(
      { error: 'live-agent turn not found for this token', code: 'TURN_NOT_FOUND' },
      { status: 404 },
    )
  }

  // ── Connected-app lookups (copilot turns; mcp-lookups.ts) ──────────────────
  // Only an `mcp__` call reads the person's servers, and only on a token whose
  // cloud route found lookups: the catalog is RE-DERIVED here from the live
  // rows (a tool disabled, or flagged for approval, mid-call drops out at
  // once), whole rows because the call dials the server.
  const isMcpCall = toolName.startsWith(LIVE_MCP_TOOL_PREFIX)
  const { lookups, servers: mcpServers } = isMcpCall
    ? await loadLiveLookupsForTurn(state, { credentials: true })
    : { lookups: [], servers: [] }

  // ── CEILING CHECK (structural, RE-DERIVED from the token — never model-visible) ─
  // A Set membership test, so a prototype-magic name ('__proto__',
  // 'constructor') can never pass as "permitted".
  const { ceiling, mcpLookups } = computeLiveAgentCeiling({
    turnType: claims.turnType,
    assistOnly: state.assistOnly,
    agentConfig: personaToolSelection(state.recipe),
    mcpLookups: lookups.map((l) => l.name),
  })
  if (toolName !== 'search_tools' && !ceiling.has(toolName)) {
    return NextResponse.json(
      { error: `tool '${toolName}' is not in this turn's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
      { status: 403 },
    )
  }
  // The caller's class (src/lib/safety/caller.ts, the one trust authority): a
  // live turn is driven by what anyone in the meeting says, so it is
  // unattended. Its ceiling admits nothing the class denies; this is the
  // second fence.
  const caller = callerClassOf({ kind: 'live_agent' })
  if (!callerMayCall(caller, toolName)) {
    return NextResponse.json({ error: callerRefusalMessage(toolName), code: 'CALLER_NOT_ALLOWED', caller }, { status: 403 })
  }

  // ── TIME GUARD (copilot ticks only; pure arithmetic on the token's claims) ──
  // Past the research cutoff a read is refused (assist-only copilots, which
  // write no record); past the nudge expiry a say_to_user is dropped without
  // its chat row or broadcast (every copilot tick). Both answer as a
  // normal tool result, so eve never retries them (see time-guard.ts).
  const guard = liveTimeGuard({
    toolName,
    turnKind: claims.turnKind,
    turnType: claims.turnType,
    assistOnly: state.assistOnly,
    mcpLookups,
    windowStartedAt: liveWindowStartedAt(claims),
    now: Date.now(),
  })
  if (guard.action !== 'run') {
    console.info(`[live-agent] time guard: ${guard.action === 'drop' ? 'dropped' : 'refused'} ${toolName} at ${guard.ageMs} ms`)
    if (guard.action === 'drop') {
      trackServerEvent(
        'live_agent_nudge_drop',
        { userId: claims.userId, workspaceId: claims.workspaceId },
        { capture_id: claims.captureId, stage: 'time_guard', reason: 'stale', age_ms: guard.ageMs },
      )
    }
    return NextResponse.json({ output: guard.output })
  }

  // ── A connected-app lookup: chat's adapter path, bounded ───────────────────
  // Never reaches the workspace tools map. In the ceiling (so in the catalog,
  // so a read by chat's policy and by both of the server's signals), then at
  // most LIVE_MCP_CALLS_PER_TURN per token, a 5 s deadline, ~4K fenced
  // characters (runLiveMcpLookup). Every refusal is a normal tool result.
  if (isMcpCall) {
    const lookup = lookups.find((l) => l.name === toolName)
    const server = lookup ? mcpServers.find((s) => s.id === lookup.serverId) : undefined
    if (!lookup || !server) {
      return NextResponse.json({ error: `unknown tool '${toolName}'` }, { status: 404 })
    }
    const input = body.input ?? {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return NextResponse.json(
        { error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: 'input must be an object' },
        { status: 400 },
      )
    }
    const tokenKey = liveAgentRunTokenKey(extractLiveAgentRunToken(request)) ?? `${claims.captureId}:${claims.exp}`
    if (!claimLiveMcpCall(tokenKey, claims.exp)) {
      return NextResponse.json({ output: { refused: 'mcp_limit', message: MCP_LIMIT_MESSAGE } })
    }
    const output = await runLiveMcpLookup(server, lookup.toolName, input as Record<string, unknown>)
    return NextResponse.json({ output })
  }

  // ── Rebuild the REAL tools under the TOKEN's tenancy (mirrors the cloud route) ─
  const { supabase, capture, isEvalCapture } = state
  const allStagingTools = createLiveAgentTools(
    claims.userId,
    supabase,
    claims.workspaceId,
    claims.captureId,
    capture.team_id,
    capture.project_id,
    state.currentMemberId,
    state.currentMemberName,
    resolveClaimsAutoAcceptPolicyFromSettings(state.workspaceSettings),
    { isEvalCapture },
  )
  const readTools = buildLiveAgentReadTools(
    claims.userId,
    supabase,
    claims.workspaceId,
    undefined,
    isEvalCapture ? { omitPrivateCaptures: true } : undefined,
  )
  const { tools } = assembleLiveAgentToolSet({
    allStagingTools,
    readTools,
    // Web access is eve-native on this runtime (never proxied), so the map
    // never carries it here.
    webTools: {},
    turnType: claims.turnType,
    assistOnly: state.assistOnly,
    agentConfig: personaToolSelection(state.recipe),
    packageBlock: null,
  })

  // Own-property lookup only: never reach an inherited member off Object.prototype.
  const tool = Object.hasOwn(tools, toolName) ? (tools as ToolSet)[toolName] : undefined
  if (!tool) {
    return NextResponse.json({ error: `unknown tool '${toolName}'` }, { status: 404 })
  }
  if (typeof tool.execute !== 'function') {
    return NextResponse.json(
      { error: `tool '${toolName}' has no server-side execute`, code: 'TOOL_NO_EXECUTE' },
      { status: 400 },
    )
  }

  // ── Validate input against the REAL Zod schema (as the model call would) ─────
  let parsedInput: unknown = body.input ?? {}
  const schema = tool.inputSchema as
    | { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }
    | undefined
  if (schema && typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(parsedInput)
    if (!parsed.success) {
      // Full Zod text so the model can self-correct within the same turn.
      return NextResponse.json(
        { error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(parsed.error) },
        { status: 400 },
      )
    }
    parsedInput = parsed.data
  }

  // ── Tenancy preflight for the one resolver that reads by a bare id ─────────
  // get_project_details reads `projects`/`milestone` by project_id alone. Under
  // a user's own client RLS fences that; this route runs SERVICE-ROLE, so a
  // project id from another workspace must be refused here before the tool
  // reads it. (The tool body itself is shared with /stage and stays untouched.)
  if (toolName === 'get_project_details') {
    const projectId = (parsedInput as { project_id?: unknown }).project_id
    const { data: owned } = await supabase
      .from('projects')
      .select('id')
      .eq('id', typeof projectId === 'string' ? projectId : '')
      .eq('workspace_id', claims.workspaceId)
      .maybeSingle()
    if (!owned) {
      return NextResponse.json(
        { error: 'project not found in this workspace', code: 'NOT_FOUND_IN_WORKSPACE' },
        { status: 404 },
      )
    }
  }

  try {
    // The synthetic `{}` options object — /stage's calling convention. No
    // live-agent tool reads the options argument.
    const output = await tool.execute(parsedInput as never, {} as never)
    // The shadow nudge.worth check (nudge-worth-shadow.ts): a DELIVERED nudge
    // only (a stale one never got here: the time guard dropped it above).
    // Deferred past the response and never awaited, so it adds no latency and
    // can't change the result; eval captures are skipped inside.
    if (toolName === 'say_to_user') shadowDeliveredNudge(state, parsedInput, output)
    // Sequence step 2: a live turn has no work-ledger row while it runs (the
    // extraction pass's item is created at flush, which records its own
    // touches), so nothing is recorded here yet; the hook is in place for when
    // a turn gets one.
    await recordToolCallTouches(state.supabase, {
      workspaceId: claims.workspaceId,
      workItemId: null,
      toolName,
      input: parsedInput,
      output,
    })
    return NextResponse.json({ output: sanitizeOutput(output) })
  } catch (err) {
    // Thrown back to eve as a tool-result {isError: true} (the proxy rethrows),
    // matching the AI-SDK error tool-result the cloud route's model call gets.
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, code: 'TOOL_EXECUTE_FAILED' }, { status: 500 })
  }
}

/** Hand a delivered say_to_user nudge to the shadow nudge.worth check. Never throws. */
function shadowDeliveredNudge(state: LiveAgentTurnState, input: unknown, output: unknown): void {
  const out = output as { delivered?: unknown; id?: unknown } | null
  const said = input as { message?: unknown; kind?: unknown } | null
  if (out?.delivered !== true || typeof out.id !== 'string' || typeof said?.message !== 'string') return
  const kind = said.kind === 'reminder' || said.kind === 'suggestion' ? said.kind : 'insight'
  try {
    shadowNudgeWorth({
      supabase: state.supabase,
      userId: state.claims.userId,
      workspaceId: state.claims.workspaceId,
      captureId: state.claims.captureId,
      isEvalCapture: state.isEvalCapture,
      nudge: { id: out.id, message: said.message.trim(), kind },
      ...(state.claims.recentTail ? { recent: state.claims.recentTail } : {}),
    })
  } catch (err) {
    console.warn('[live-agent] nudge.worth shadow skipped:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * SIGNED-URL FALLBACK enforcement. get_attachment_content and read_chat_file
 * return an image under internal keys (__imageBase64/__imageMimeType); the
 * live agent's proxies hand a tool's JSON to the model as is, so the image
 * MUST NOT cross the boundary: it is stripped, with a note in its place
 * (withoutToolImage). A no-op for any output without one.
 */
function sanitizeOutput(output: unknown): unknown {
  return withoutToolImage(output)
}
