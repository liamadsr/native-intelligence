/**
 * POST /api/internal/skill-run/tool   (token via header)
 *
 * INTERNAL-ONLY tool-dispatch for the eve `skill-runner` runtime (Phase 2,
 * "Option B" — see docs/plans/eve-migration-plan.md). The eve agent's workspace
 * tools are thin PROXIES: their `execute` posts here with { toolName, input }.
 * This route runs the REAL tool — the same `createTools()` the gateway path
 * builds, with its real Zod schema and execute body — so the Next-coupled tool
 * code never has to compile into the separate eve Nitro runtime.
 *
 * ── The two security boundaries this route owns ─────────────────────────────
 * 1. AUTH: the shared internal secret (constant-time) proves the caller is our
 *    own eve runtime; the HMAC-signed run token proves + scopes the run.
 * 2. CEILING (STRUCTURAL, server-side): the requested tool MUST be in the run's
 *    ceiling, RE-DERIVED here from the verified token via computeSkillCeiling —
 *    never from anything model-visible. This is the F1 lesson as defense in
 *    depth: even though the eve resolver only advertises ceiling tools, an
 *    out-of-ceiling call is rejected here regardless of what the model believes.
 *
 * 3. THE CALLER (src/lib/safety/caller.ts, the one trust authority): a loop's
 *    run and a turn the main agent relayed are unattended, a follow-up chat
 *    turn is the person. Past the ceiling a call must pass callerMayCall for
 *    that class (403 CALLER_NOT_ALLOWED otherwise), and the class decides
 *    what the outward gate's hold becomes.
 *
 * Tenancy (workspaceId, runAsUserId) comes ONLY from the verified token. The
 * tools are constructed exactly as run-skill.ts's gateway branch does: a
 * service-role client from getServiceClient() + createTools(runAsUserId,
 * supabase, workspaceId), plus the read-only search_tools meta-tool.
 */
import { NextResponse, after } from 'next/server'
import { entitiesFiledByWork, recordToolCallTouches } from '@/lib/work/touch'
import { REVIEW_ROUTED_TOOLS, reviewActionIdsForWork } from '@/lib/work/review-actions'
import { getServiceClient } from '@/lib/admin'
import { createTools } from '@/lib/ai/tools'
import { createSearchToolsTool } from '@/lib/ai/tool-discovery'
import { ATTENDED_ONLY_TOOL_NAMES, NON_CHAT_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { resolveFollowThrough } from '@/lib/chat/follow-through'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { withoutToolImage } from '@/lib/ai/tools/tool-image'
import { unattendedGoAheadRefusal } from '@/lib/ai/tools/go-ahead'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractRunToken,
  verifyRunToken,
  type RunTokenClaims,
} from '@/lib/flows/skill-run-token'
import { skillRunBindingRefusal } from '@/lib/flows/skill-run-binding'
import { resolveSkillRunChatCeiling } from '@/lib/flows/skill-run-chat-ceiling'
import { AGENT_PAUSED_CODE, AGENT_PAUSED_REASON, checkAgentPaused } from '@/lib/work/agent-paused'
import { setWorkPlan } from '@/lib/work/plan'
import { gateRiskyCall, riskClassOf } from '@/lib/safety/action-review'
import { UNATTENDED_TOOL_OPTIONS } from '@/lib/safety/approvals'
import { skillRunLoopInstructions } from '@/lib/safety/loop-instructions'
import { noteTurnTool, turnTools, turnToolsKey } from '@/lib/safety/turn-tools'
import { callerClassOf, callerMayCall, callerRefusalMessage, type DecideOptions } from '@/lib/safety/caller'
import { dryRunStubs, dryRunWriteEcho } from '@/lib/flows/dry-run-tools'
import { runConnectionTool, runConnectionTools } from '@/lib/flows/skill-run-connections'
import { noteRunReadOutside, skillRunOutsideReads } from '@/lib/flows/skill-run-reads'
import { knownOrOwnSenders, readOutsideText } from '@/lib/safety/outside-text'
import type { Tool } from 'ai'

export const dynamic = 'force-dynamic'

/**
 * The full workspace tool surface, as a membership Set. inherit-all (null
 * ceiling) permits EXACTLY the tools that exist in the registry — the same
 * surface pickPermittedTools(null) grants on the gateway path (the whole
 * createTools() map) — never "any string". The chat-native tools are not part
 * of it (NON_CHAT_TOOL_NAMES): only the main chat can run start_helper.
 * search_tools (the read-only discovery meta-tool) is always reachable, so it's
 * part of this set. Built once at module load; a Set membership test is also
 * prototype-pollution-safe (a name like '__proto__' is a plain key, not a
 * lookup against Object.prototype).
 */
const FULL_REGISTRY_TOOLS = new Set<string>([...NON_CHAT_TOOL_NAMES, 'search_tools'])

/** The skill-runner's native plan tool (agents/skill-runner/tools/update_plan.ts), handled before the ceiling. */
const UPDATE_PLAN_TOOL_NAME = 'update_plan'

interface ToolCallBody {
  toolName?: string
  input?: unknown
  /**
   * A follow-up chat turn's evidence for the reviewer (A5): the person's own
   * latest words and their count, as the skill-runner keeps them
   * (agents/skill-runner/lib/person-messages.ts). Ignored on a run, and on a
   * turn the main agent relayed (`chat.relay`).
   */
  personMessages?: unknown
  personMessageSeq?: unknown
}

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid run token — the authoritative source of tenancy + routing.
  const claims = verifyRunToken(extractRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }
  // Gate 3: the claims must bind to live rows of their workspace (member,
  // skill, ledger row, teammate) — a token forged by a secret-holder without
  // real ids fails here (skill-run-binding.ts).
  const bindingRefusal = await skillRunBindingRefusal(claims)
  if (bindingRefusal) return bindingRefusal

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

  // Its writes are the agent's, for the person it runs as (the activity log).
  const supabase = getServiceClient({ agentFor: claims.runAsUserId })

  // ── The run's plan (A4): the skill-runner's native update_plan ─────────────
  // Not a workspace tool (no createTools entry, so no ceiling and no MCP): the
  // name is handled here, before the ceiling, and writes only the token's own
  // job (`workItemId`) through the one validating writer. A run with no job
  // (no ledger row) is told to skip it; a settled job keeps its plan.
  if (toolName === UPDATE_PLAN_TOOL_NAME) {
    if (!claims.workItemId) {
      return NextResponse.json({ output: { ok: false, note: 'This run has no job to keep a plan on. Skip update_plan.' } })
    }
    const steps = body.input && typeof body.input === 'object' ? (body.input as { steps?: unknown }).steps : undefined
    const written = await setWorkPlan(supabase, { workspaceId: claims.workspaceId, workItemId: claims.workItemId, steps })
    if (!written.ok && written.code === 'INPUT_INVALID') {
      return NextResponse.json({ error: written.error, code: 'INPUT_INVALID' }, { status: 400 })
    }
    return NextResponse.json({ output: written.ok ? { ok: true, plan: written.plan.steps } : { ok: false, error: written.error } })
  }

  // ── A follow-up CHAT turn (bots v3 Phase 4): the bot's attended ceiling ─────
  // A token with a `chat` claim drives one turn on a run's parked session. Its
  // ceiling is the fronting bot's chat ceiling (the call the spec rebuild
  // advertises from), never the run's own; a bot that's gone or out of the
  // run-as user's reach refuses every call.
  if (claims.chat) {
    const chatCeiling = await resolveSkillRunChatCeiling(supabase, { ...claims, chat: claims.chat })
    if (!chatCeiling) {
      return NextResponse.json({ error: 'this agent is no longer available', code: 'TEAMMATE_UNAVAILABLE' }, { status: 403 })
    }
    if (!chatCeiling.has(toolName)) {
      return NextResponse.json(
        { error: `tool '${toolName}' is not in this chat's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
        { status: 403 },
      )
    }
    // The caller's class (caller.ts). A relayed turn keeps an attended-only
    // tool only when it is one of THIS bot's follow-through grants
    // (follow-through.ts), read for that tool alone.
    const granted = callerClassOf({ kind: 'skill_run', claims }) === 'agent_unattended' && ATTENDED_ONLY_TOOL_NAMES.has(toolName)
      ? (await resolveFollowThrough(supabase, { workspaceId: claims.workspaceId, teammateId: claims.chat.teammateId })).has(toolName)
      : false
    const callerRefused = callerRefusal(claims, toolName, { granted })
    if (callerRefused) return callerRefused
    return runSkillRunTool(supabase, claims, toolName, body.input, {
      search_tools: createSearchToolsTool(chatCeiling),
      // The person is here (attended), as in a teammate chat: no unattended
      // fencing beyond the run's one workspace. The bot's writes are an
      // AGENT's, one hop from the person's message.
      ...createTools(claims.runAsUserId, supabase, claims.workspaceId, undefined, {
        strictWorkspace: true,
        origin: { actor: 'agent', depth: 1, run_id: claims.skillId },
        suggestionContext: { origin: 'skill_run', trackedJobId: claims.workItemId ?? null },
      }),
    }, {
      // The reviewer (A5): the person is here, so this turn is reviewed as a
      // chat, against their own forwarded words. A relayed turn's message is
      // the main agent's, never theirs: no words, so a risky call blocks.
      review: {
        door: 'chat',
        personMessages: claims.chat.relay ? [] : Array.isArray(body.personMessages) ? body.personMessages : [],
        personMessageSeq: typeof body.personMessageSeq === 'number' && Number.isInteger(body.personMessageSeq) && body.personMessageSeq >= 0 ? body.personMessageSeq : null,
      },
    })
  }

  // ── F4: the flow owner's connected apps (the token's connections only) ────
  // Their own ceiling: the apps the step names, the tools the owner lets the
  // agent see, reads only in report mode (skill-run-connections.ts). Then the
  // same gates as any loop call: the trust authority, the kill switch, the
  // go-ahead flag and a dry run. A write is staged as the owner's card on a
  // flow step, never run unattended.
  if (toolName.startsWith('mcp__')) {
    const entry = (await runConnectionTools(supabase, claims)).get(toolName)
    if (!entry) {
      return NextResponse.json({ error: `tool '${toolName}' is not in this run's ceiling`, code: 'TOOL_OUT_OF_CEILING' }, { status: 403 })
    }
    const refusedCaller = callerRefusal(claims, toolName)
    if (refusedCaller) return refusedCaller
    if (await checkAgentPaused(supabase, claims.workspaceId, 'skill_run_tool')) {
      return NextResponse.json({ output: { success: false, code: AGENT_PAUSED_CODE, error: `${AGENT_PAUSED_REASON}. Do not call any more tools: stop and report what you have.` } })
    }
    const noYes = unattendedGoAheadRefusal(body.input)
    if (noYes) return NextResponse.json({ output: noYes })
    if (claims.dryRun === true && entry.requiresApproval) {
      return NextResponse.json({ output: dryRunWriteEcho(toolName, body.input) })
    }
    const answer = await runConnectionTool(supabase, claims, entry, body.input)
    if (answer.status !== 200) return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status })
    await recordToolCallTouches(supabase, {
      workspaceId: claims.workspaceId,
      workItemId: claims.workItemId ?? null,
      toolName,
      input: body.input ?? {},
      output: answer.output,
    })
    return NextResponse.json({ output: answer.output })
  }

  // ── CEILING CHECK (structural, RE-DERIVED from the token — never model-visible) ─
  // Reload the skill's agent_config so the ceiling is derived from live config,
  // identical to computeSkillCeiling's use in assembleSkillRun.
  const { data: recipe } = await supabase
    .from('recipe')
    .select('agent_config')
    .eq('id', claims.skillId)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${claims.workspaceId},is_system.eq.true`)
    .maybeSingle<{ agent_config: Parameters<typeof computeSkillCeiling>[0] }>()
  if (!recipe) {
    return NextResponse.json({ error: 'skill not found for this run' }, { status: 404 })
  }

  const ceilingSet = computeSkillCeiling(recipe.agent_config, claims.mode, claims.hasCapture)
  // Resolve the permission against the ACTUAL tool registry in every case.
  // search_tools (read-only discovery) is always permitted. A null ceiling is
  // inherit-all (act mode, no restriction) — but that means "any tool that EXISTS
  // in the full registry", NEVER "any string": otherwise a prototype-magic name
  // ('__proto__', 'constructor', 'hasOwnProperty') would pass the gate and reach
  // the tool lookup below. Both the ceiling Set and FULL_REGISTRY_TOOLS are Sets,
  // so membership is prototype-pollution-safe.
  const permitted =
    toolName === 'search_tools' ||
    (ceilingSet ? ceilingSet.has(toolName) : FULL_REGISTRY_TOOLS.has(toolName))
  if (!permitted) {
    // Fail-closed boundary (F1 lesson). An out-of-ceiling or unknown call never executes.
    return NextResponse.json(
      { error: `tool '${toolName}' is not in this run's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
      { status: 403 },
    )
  }
  // The caller's class (caller.ts): an unattended loop run.
  const callerRefused = callerRefusal(claims, toolName)
  if (callerRefused) return callerRefused

  // The kill switch (A5 slice 5, src/lib/work/agent-paused.ts): with autonomy
  // off, an unattended loop run gets no tool at all, so a loop already running
  // when the switch flipped ends at its next call. Model-visible, so the run
  // finishes and reports instead of failing the turn. A follow-up chat turn
  // (the branch above) is the person's own and is not gated.
  if (await checkAgentPaused(supabase, claims.workspaceId, 'skill_run_tool')) {
    return NextResponse.json({
      output: {
        success: false,
        code: AGENT_PAUSED_CODE,
        error: `${AGENT_PAUSED_REASON}. Do not call any more tools: stop and report what you have.`,
      },
    })
  }

  // Nobody is here to have said yes: a paid prospecting search, a publish or a
  // dismiss with confirmed_with_user true is refused before it runs (go-ahead.ts).
  // The chat-turn branch above keeps the flag, since the person is there.
  const noGoAhead = unattendedGoAheadRefusal(body.input)
  if (noGoAhead) return NextResponse.json({ output: noGoAhead })

  // A test_flow DRY run (F1, the token's dryRun claim): no write runs, not
  // even report mode's documents, comments and suggestions (a test on a real
  // ENG-42 must not comment on it). The model gets what it would have written.
  if (claims.dryRun === true && dryRunStubs(toolName)) {
    return NextResponse.json({ output: dryRunWriteEcho(toolName, body.input) })
  }

  // ── Rebuild the REAL tools under the TOKEN's tenancy (mirrors the gateway branch) ─
  const ceilingArg = ceilingSet && ceilingSet.size > 0 ? ceilingSet : null
  const tools: Record<string, Tool> = {
    // Discovery searches what this run may call: never a chat-native tool, even
    // for an inherit-all skill.
    search_tools: createSearchToolsTool(ceilingArg ?? FULL_REGISTRY_TOOLS),
    // strictWorkspace: a skill run is fenced to exactly one workspace and uses a
    // SERVICE-ROLE client (RLS-bypassed), so a model-authored entity id for another
    // workspace the run-as user belongs to must not resolve via the cross-workspace
    // slow path. Strict treats a foreign id as not-found (same fence as work-run).
    // omitPrivateCaptures: an unattended run writes into workspace-readable
    // tables, so it must never read a private capture — not even the run-as
    // user's own. See docs/design-capture-visibility.md.
    ...createTools(claims.runAsUserId, supabase, claims.workspaceId, undefined, {
      strictWorkspace: true,
      omitPrivateCaptures: true,
      // A canon edit's label (canon D2): what this loop run has read so far.
      canonContext: { attended: false, readOutside: () => skillRunOutsideReads(supabase, claims) },
      // No person at the keyboard: create_contact's HubSpot writeback is skipped
      // (CreateToolsOptions.unattended, Sequence step 2).
      unattended: true,
      // Its drafts count against the shared daily cap, never twice per thread.
      automaticDrafts: true,
      // ... and the actions it files arrive as suggestions a person confirms
      // (the promotion guard, A4 slice 8). The chat-turn branch above keeps
      // the model's choice, since the person is there.
      actionRules: {
        unattended: true,
        fileActionsAsSuggested: true,
        // The actions this fire works: its ledger row's trigger action (a
        // loop fired by an action's status change) and its root's. A flow
        // completing the action that fired it moves it to review, never Done.
        // Read only for the calls that can complete one.
        reviewActionIds: REVIEW_ROUTED_TOOLS.has(toolName) ? await reviewActionIdsForWork(supabase, claims.workItemId) : [],
        // What this fire filed, from its own ledger row's touches: it never
        // confirms those (the person does). No ledger row, or a failed read:
        // everything (fail closed).
        filedByRun: async (ids: readonly string[]) =>
          claims.workItemId ? entitiesFiledByWork(supabase, { workItemId: claims.workItemId, ids }) : new Set(ids.map((id) => id.toLowerCase())),
      },
      // Loop guard: this run's status writes are an AGENT's, at the depth the
      // dispatching fire minted into the token (flow-functions.ts).
      origin: { actor: 'agent', depth: claims.originDepth ?? 1, run_id: claims.skillId },
      // suggest_changes stages against the fire's work-ledger row; delivery
      // re-homes them onto the document the run writes.
      suggestionContext: { origin: 'skill_run', trackedJobId: claims.workItemId ?? null },
    }),
  }
  return runSkillRunTool(supabase, claims, toolName, body.input, tools, { review: { door: 'skill_run' } })
}

/**
 * Look up `toolName` in the tools built for this call (a run's, or a chat
 * turn's), validate its input against its real schema and run it, recording
 * what it touched on the run's work item. Shared by both branches.
 */
async function runSkillRunTool(
  supabase: ReturnType<typeof getServiceClient>,
  claims: RunTokenClaims,
  toolName: string,
  input: unknown,
  tools: Record<string, Tool>,
  options: {
    review?:
      | { door: 'skill_run' }
      | { door: 'chat'; personMessages: readonly unknown[]; personMessageSeq: number | null }
  } = {},
): Promise<Response> {
  // Own-property lookup only: never reach an inherited member ('constructor',
  // 'toString', …) off Object.prototype even if one slipped past the ceiling gate.
  const tool = Object.hasOwn(tools, toolName) ? tools[toolName] : undefined
  if (!tool) {
    return NextResponse.json({ error: `unknown tool '${toolName}'` }, { status: 404 })
  }
  if (typeof tool.execute !== 'function') {
    return NextResponse.json(
      { error: `tool '${toolName}' has no server-side execute`, code: 'TOOL_NO_EXECUTE' },
      { status: 400 },
    )
  }

  // ── Validate input against the REAL Zod schema, then run (as generateText would) ─
  let parsedInput: unknown = input ?? {}
  const schema = tool.inputSchema as
    | { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }
    | undefined
  if (schema && typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(parsedInput)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(parsed.error) },
        { status: 400 },
      )
    }
    parsedInput = parsed.data
  }

  try {
    const execute = () => tool.execute!(parsedInput as never, {
      toolCallId: `skill-run-${claims.skillId.slice(0, 8)}`,
      messages: [],
    } as never)
    // The reviewer (A5): a risky call on an unattended loop's run is checked
    // against the loop's saved instructions (read inside the review, so in
    // shadow it is after the response); a follow-up chat turn's against the
    // person's own words. In shadow it only records, with no added latency;
    // enforced, a block holds the call as an approval card that runs, on
    // accept, under this door's exact fence.
    let output: unknown
    const runKey = turnToolsKey(claims.skillId, claims.workItemId ?? String(claims.exp))
    const review = options.review
    if (review) {
      const loop = review.door === 'skill_run'
      const gated = await gateRiskyCall(
        {
          door: review.door,
          userId: claims.runAsUserId,
          workspaceId: claims.workspaceId,
          toolName,
          input: parsedInput,
          sideEffect: riskClassOf(toolName, parsedInput),
          personMessages: loop ? () => skillRunLoopInstructions(supabase, claims) : review.personMessages,
          source: loop ? 'loop_instructions' : 'person',
          ...(loop ? {} : { personMessageSeq: review.personMessageSeq }),
          // Who is calling (caller.ts), from the verified token: an
          // unattended loop, or a relayed turn, has nobody to answer a card,
          // so its outside invites are refused NEEDS_PERSON; a follow-up chat
          // turn with the person (not a relay) gets the card.
          caller: callerClassOf({ kind: 'skill_run', claims }),
          // F4: a loop's flow step (the token's verified claim; never a chat turn,
          // a test or an eval): an outward hold becomes the owner's card.
          ...(loop && claims.flowStep ? { flowStep: true } : {}),
          toolsThisTurn: turnTools(runKey),
          runId: claims.workItemId ?? claims.skillId,
          defer: deferAfterResponse,
          approval: {
            supabase,
            skillId: claims.skillId,
            workItemId: claims.workItemId ?? null,
            ...(loop && claims.flowStep?.flowRunId ? { flowRunId: claims.flowStep.flowRunId } : {}),
            context: loop
              ? {
                  mode: claims.mode,
                  tools: { ...UNATTENDED_TOOL_OPTIONS, origin: { actor: 'agent', depth: claims.originDepth ?? 1, run_id: claims.skillId } },
                  // A flow step's card (N1): its accept checks the loop is still on (a Test excepted).
                  ...(claims.flowStep ? { loopStep: { flow_id: claims.flowStep.flowId, action_id: claims.flowStep.actionId, ...(claims.flowStep.manual ? { manual: true as const } : {}) } } : {}),
                }
              : { mode: claims.mode, ...(claims.chat ? { teammateId: claims.chat.teammateId } : {}), tools: { strictWorkspace: true, origin: { actor: 'agent', depth: 1, run_id: claims.skillId } } },
          },
        },
        execute,
      )
      if (gated.held) return NextResponse.json({ output: gated.output })
      output = gated.value
      noteTurnTool(runKey, toolName)
    } else {
      output = await execute()
    }
    // F4 review R2: a loop run notes the moment it reads outside text (P6's
    // one notion), before the result reaches the model, so its later
    // connected-app calls know and a canon edit it makes is labelled
    // (skill-run-reads.ts).
    if (claims.runId && !claims.chat) {
      const outside = await readOutsideText(toolName, output, (addresses) =>
        knownOrOwnSenders(supabase, { workspaceId: claims.workspaceId, userId: claims.runAsUserId, addresses }),
      ).catch(() => true)
      if (outside) await noteRunReadOutside(supabase, { runId: claims.runId, workspaceId: claims.workspaceId, tool: toolName })
    }
    // Sequence step 2: record what the call touched on the fire's work item
    // (the token carries it when the caller had a ledger row; fail-soft).
    await recordToolCallTouches(supabase, {
      workspaceId: claims.workspaceId,
      workItemId: claims.workItemId ?? null,
      toolName,
      input: parsedInput,
      output,
    })
    // An image a tool returns (read_chat_file, get_attachment_content) never
    // reaches this agent's model as base64 text: it is stripped, with a note.
    return NextResponse.json({ output: withoutToolImage(output) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, code: 'TOOL_EXECUTE_FAILED' }, { status: 500 })
  }
}

/** A 403 when the trust authority (caller.ts) refuses this run's caller the call, else null. */
function callerRefusal(claims: RunTokenClaims, toolName: string, options?: DecideOptions): Response | null {
  const caller = callerClassOf({ kind: 'skill_run', claims })
  if (callerMayCall(caller, toolName, options)) return null
  return NextResponse.json({ error: callerRefusalMessage(toolName), code: 'CALLER_NOT_ALLOWED', caller }, { status: 403 })
}

/** Shadow review after the response (Next's `after`); outside a request scope it just runs. */
function deferAfterResponse(task: () => Promise<void>): void {
  try {
    after(task)
  } catch {
    void task().catch(() => {})
  }
}
