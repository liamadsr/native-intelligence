/**
 * POST /api/internal/work-run/tool   (token via header)
 *
 * INTERNAL-ONLY tool-dispatch for the eve `work-agent` runtime (Loops v3 work
 * proposals — docs/loop-engine/WORK-PROPOSALS-DESIGN.md). The eve agent's
 * workspace tools are thin PROXIES: their `execute` posts here with { toolName,
 * input }. This route runs the REAL tool — the same `createTools()` the gateway
 * path builds, with its real Zod schema and execute body — so the Next-coupled
 * tool code never has to compile into the separate eve Nitro runtime.
 *
 * ── The two security boundaries this route owns ─────────────────────────────
 * 1. AUTH: the shared internal secret (constant-time) proves the caller is our
 *    own eve runtime; the HMAC-signed run token proves + scopes the run; the
 *    agent_run row (looked up by the token's run id AND workspace) must be a
 *    `kind = 'workspace'` run, so a coding-run token never gets this surface,
 *    and must not be canceled/canceling (409 RUN_NOT_ACTIVE).
 * 2. CEILING (STRUCTURAL, server-side): a work run's surface is exactly the
 *    registry tools whose required `sideEffect` classification is 'read' or
 *    'internal-write' (WORK_RUN_ADMITTED_SIDE_EFFECTS in @/lib/ai/tool-registry
 *    → computeWorkRunCeiling) — or, for an ATTEMPTED run (agent_run.origin),
 *    the narrower drafting ceiling (read + artifact writes; ceilingForWorkRun),
 *    narrowed again to the teammate's own classes and allowlist when a
 *    teammate does it unattended (B PR 4), and to the delegating chat's own
 *    ceiling for chat work and its handoffs. A follow-up CHAT turn's token
 *    (`chat`, bots v3 Phase 5) may add two things, both attended: its bot's
 *    follow-through grants (attended-only tools such as revise_email_draft),
 *    and, with a skill picked in the run chat's composer (`skillId`, bots v4),
 *    the tools that skill selects, capped to the RUN'S OWN CLASSES (drafting
 *    for an attempted run, read + internal-write for a person-started one:
 *    workRunClassProfile), to the bot's attended chat ceiling and to the chat
 *    bound (skillChatTurnTools). A skill never gives a run more than the run
 *    itself may do, and every other token gets exactly the run's ceiling. Any tool nobody has
 *    classified as admitted is out. The requested tool MUST be in that set —
 *    RE-DERIVED here, never from anything model-visible. Even though the eve
 *    resolver only advertises ceiling tools, an out-of-ceiling call (e.g.
 *    `publish_draft`, `push_action_to_jira`, `update_skill`, `accept_proposal`,
 *    `delete_action`) is rejected here regardless of what the model believes.
 *    The eve resolver and this gate call the SAME ceilingForWorkRunTurn(run,
 *    claims), so the advertised surface and the enforced ceiling are one
 *    thing.
 *
 * 3. THE CALLER (src/lib/safety/caller.ts, the one trust authority): the
 *    run's own turns are unattended, a follow-up chat turn (`chat`) is the
 *    person. Past the ceiling a call must pass callerMayCall for that class
 *    (403 CALLER_NOT_ALLOWED otherwise). The ceiling already admits nothing
 *    it denies; it is the second fence.
 *
 * Tenancy (workspaceId, userId) comes ONLY from the verified token. The tools are
 * constructed exactly as the skill-run branch does: a service-role client +
 * createTools(userId, supabase, workspaceId), plus the read-only search_tools
 * meta-tool (discovery is never a mutation, so it stays reachable).
 */
import { NextResponse } from 'next/server'
import { entitiesFiledByWork, recordToolCallTouches, resolveWorkItemIdForAgentRun } from '@/lib/work/touch'
import { REVIEW_ROUTED_TOOLS, reviewActionIdsForWork } from '@/lib/work/review-actions'
import { getServiceClient } from '@/lib/admin'
import { createTools } from '@/lib/ai/tools'
import { createSearchToolsTool } from '@/lib/ai/tool-discovery'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { withoutToolImage } from '@/lib/ai/tools/tool-image'
import {
  ceilingForWorkRunTurn,
  statusChangeDepthForWorkRun,
  WORK_RUN_ROW_SELECT,
  type WorkRunRow,
} from '@/lib/agent-run/run-work-spec-rebuild'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractAgentRunToken,
  verifyAgentRunToken,
} from '@/lib/agent-run/agent-run-token'
import { callerClassOf, callerMayCall, callerRefusalMessage } from '@/lib/safety/caller'
import { knownOrOwnSenders, noteOutsideRead, readOutsideText } from '@/lib/safety/outside-text'
import { markIfRunReadOutside } from '@/lib/documents/outside-derived'
import { resolveFollowThrough } from '@/lib/chat/follow-through'
import { ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import type { Tool } from 'ai'

export const dynamic = 'force-dynamic'

interface ToolCallBody {
  toolName?: string
  input?: unknown
}

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid run token — the authoritative source of tenancy + routing.
  const claims = verifyAgentRunToken(extractAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  // Gate 3: the token must belong to a WORK run in the claimed workspace. Coding
  // and work runs mint tokens with the same key and the same claim shape, so a
  // valid signature alone does not say which kind of run this is. Re-derive it
  // from the row, the same way rebuildWorkRunSpec does.
  //
  // Status: a CANCELED (or canceling) run gets no more tool calls — that covers
  // the window between the user's cancel and run-work-eve's cancel poll aborting
  // the session. Every other status dispatches: live runs obviously, and settled
  // completed/failed runs because the user's follow-up chat
  // (api/account/agent-runs/[id]/chat, CHATTABLE_STATUSES) keeps acting through
  // these same tools after the run settles. Its writes are the agent's, for
  // this person (the activity log).
  const supabase = getServiceClient({ agentFor: claims.userId })
  const { data: run } = await supabase
    .from('agent_run')
    .select(`${WORK_RUN_ROW_SELECT}, action_id`)
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .maybeSingle<WorkRunRow & { action_id?: string | null }>()
  if (!run) {
    return NextResponse.json({ error: 'run not found', code: 'RUN_NOT_FOUND' }, { status: 404 })
  }
  if (run.kind !== 'workspace') {
    return NextResponse.json({ error: 'token is not for a work run', code: 'RUN_KIND_MISMATCH' }, { status: 403 })
  }
  if (run.status === 'canceling' || run.status === 'canceled') {
    return NextResponse.json({ error: 'this work run was canceled', code: 'RUN_NOT_ACTIVE' }, { status: 409 })
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

  // ── CEILING CHECK (structural, RE-DERIVED — never model-visible) ─────────────
  // search_tools (read-only discovery) is always permitted. Every other name must
  // be in the run's ceiling, picked by the ROW's origin (Sequence step 3, plan
  // A.3): a run a person started gets the registry tools classified read or
  // internal-write; an attempted run (or any other origin) gets the drafting
  // ceiling — read + artifact writes, no board or CRM mutation — narrowed to
  // its teammate's classes and allowlist (B PR 4), and for work delegated from
  // the main chat to what that chat could call (chat_ceiling, migration 299).
  // Both are Sets, so membership is prototype-pollution-safe (a name like
  // '__proto__' is a plain key, not a lookup against Object.prototype).
  // A follow-up chat turn's token (`chat`, bots v3 Phase 5) also holds its
  // bot's follow-through grants and, with a picked skill (`skillId`, bots v4),
  // that skill's tools within the run's own classes, the bot's attended chat
  // ceiling and the chat bound; every other token, exactly the run's ceiling.
  const ceiling = await ceilingForWorkRunTurn(supabase, run, claims)
  const permitted = toolName === 'search_tools' || ceiling.has(toolName)
  if (!permitted) {
    // Fail-closed boundary. An out-of-ceiling or unknown call never executes.
    return NextResponse.json(
      { error: `tool '${toolName}' is not in this run's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
      { status: 403 },
    )
  }
  // The caller's class (caller.ts): a follow-up chat turn is the person, a
  // relayed one (the main agent's words) and the run's own turns are
  // unattended. A relayed turn keeps an attended-only tool only when it is one
  // of the run's bot's follow-through grants (follow-through.ts).
  const caller = callerClassOf({ kind: 'work_run', claims })
  const granted = caller === 'agent_unattended' && ATTENDED_ONLY_TOOL_NAMES.has(toolName)
    ? (await resolveFollowThrough(supabase, { workspaceId: claims.workspaceId, teammateId: run.ai_team_member_id })).has(toolName)
    : false
  if (!callerMayCall(caller, toolName, { granted })) {
    return NextResponse.json({ error: callerRefusalMessage(toolName), code: 'CALLER_NOT_ALLOWED', caller }, { status: 403 })
  }

  // ── Rebuild the REAL tools under the TOKEN's tenancy (mirrors the gateway branch) ─
  const tools: Record<string, Tool> = {
    // search_tools scoped to the work-run ceiling so discovery never surfaces an
    // excluded tool as callable.
    search_tools: createSearchToolsTool(ceiling),
    // strictWorkspace: an unattended work run is fenced to exactly one workspace.
    // The tools use a SERVICE-ROLE client (RLS-bypassed), so without this a
    // model-authored entity id in ANOTHER workspace the user belongs to would
    // resolve via resolveEntityWorkspace's slow path and let the run mutate it.
    // Strict disables that slow path — a foreign id resolves as not-found.
    // omitPrivateCaptures: an unattended run writes into workspace-readable
    // tables, so it must never read a private capture — not even the run-as
    // user's own. See docs/design-capture-visibility.md.
    ...createTools(claims.userId, supabase, claims.workspaceId, undefined, {
      strictWorkspace: true,
      omitPrivateCaptures: true,
      // No person at the keyboard: create_contact's HubSpot writeback is skipped
      // (CreateToolsOptions.unattended, Sequence step 2).
      unattended: true,
      // A server-started helper (a meeting prep, a home-turn helper) writes for
      // one person: what it creates is theirs alone unless it says otherwise
      // (migration 369). Every other run writes for the workspace.
      ...(run.server_helper ? { defaultDocumentVisibility: 'private' as const } : {}),
      // Its own turns draft for nobody who asked: the shared cap and the
      // open-draft check hold (a follow-up chat turn has the person there).
      automaticDrafts: !claims.chat,
      // The run's own turns have nobody watching (a follow-up chat turn has
      // the person there, so it keeps the model's choice and may close the
      // action on their word): actions it files arrive as suggestions (the
      // promotion guard, A4 slice 8), and finishing its own action moves that
      // action to review, never Done (decision 9).
      ...(claims.chat
        ? {}
        : {
            actionRules: {
              unattended: true,
              fileActionsAsSuggested: true,
              // The actions this run works: its own, its ledger row's and its
              // root row's (a delegated child working the parent's action).
              // Read only for the calls that can complete one.
              reviewActionIds: [
                ...new Set([
                  ...(run.action_id ? [run.action_id] : []),
                  ...(REVIEW_ROUTED_TOOLS.has(toolName)
                    ? await reviewActionIdsForWork(supabase, await resolveWorkItemIdForAgentRun(supabase, claims.agentRunId))
                    : []),
                ]),
              ],
              // What this run filed, from its own ledger row's touches: it
              // never confirms those (the person does). No ledger row, or a
              // failed read: everything (fail closed).
              filedByRun: async (ids: readonly string[]) => {
                const workItemId = await resolveWorkItemIdForAgentRun(supabase, claims.agentRunId)
                return workItemId ? entitiesFiledByWork(supabase, { workItemId, ids }) : new Set(ids.map((id) => id.toLowerCase()))
              },
            },
          }),
      // Loop guard: a work run's status writes are an AGENT's, at the depth its
      // ROW says (A3 residual, Sequence step 3): 1 for a run a person started,
      // 2 for an attempted run, plus the delegation chain depth.
      origin: { actor: 'agent', depth: statusChangeDepthForWorkRun(run), run_id: claims.agentRunId },
      // A canon section edit's provenance (canon D2): the run's own turns are
      // unattended and its outside reads label the edit; a follow-up chat turn
      // has the person there.
      canonContext: { attended: !!claims.chat, outsideReadsRunId: claims.agentRunId },
      // suggest_changes stages against the run's work-ledger row (looked up
      // only when the tool runs); finishing the run re-homes them onto its
      // document.
      suggestionContext: {
        origin: 'work_run',
        trackedJobId: () => resolveWorkItemIdForAgentRun(supabase, claims.agentRunId),
      },
    }),
  }

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
  let parsedInput: unknown = body.input ?? {}
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
    const output = await tool.execute!(parsedInput as never, {
      toolCallId: `work-run-${claims.agentRunId.slice(0, 8)}`,
      messages: [],
    } as never)
    // Outside text the run's own turns read (outside-text.ts, migration 374):
    // what this run teaches or writes into a canon document is labelled with
    // it. Off the reply's path for everything but the mail sender check.
    if (!claims.chat) {
      const known = (addresses: string[]) => knownOrOwnSenders(supabase, { workspaceId: claims.workspaceId, userId: claims.userId, addresses })
      if (await readOutsideText(toolName, output, known)) {
        await noteOutsideRead(supabase, { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId, toolName })
      }
      // A document this run writes after reading outside text is marked so,
      // for good (document.outside_derived, F3 review R2).
      await markIfRunReadOutside(supabase, { workspaceId: claims.workspaceId, agentRunId: claims.agentRunId, toolName, input: parsedInput, output })
    }
    // Sequence step 2: record what the call touched on the run's work item
    // (fail-soft — never fails the call; a settled run's follow-up chat maps to
    // the same item).
    await recordToolCallTouches(supabase, {
      workspaceId: claims.workspaceId,
      workItemId: await resolveWorkItemIdForAgentRun(supabase, claims.agentRunId),
      agentRunId: claims.agentRunId,
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
