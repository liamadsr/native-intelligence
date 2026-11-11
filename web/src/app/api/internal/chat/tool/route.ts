import { isPersonTextTurn } from '@/lib/onboarding/text-setup'
import { browserSourceRequestSchema } from '@/lib/browser-agent/task-contract'
/**
 * POST /api/internal/chat/tool   (token via header)
 *
 * INTERNAL-ONLY tool-dispatch for the eve main-chat runtime (Phase 4, "Option
 * B" HTTP proxy — see docs/plans/eve-phase4-chat.md §Tools). The eve chat
 * agent's workspace tools are thin PROXIES: their `execute` posts here with
 * { toolName, input }. This route runs the REAL tool — createTools(), plus the
 * user's external-MCP tools + the read-only search_tools meta-tool — so the
 * Next-coupled tool code never has to compile into the separate eve Nitro
 * runtime.
 *
 * ── The security boundaries this route owns ─────────────────────────────
 * 1. AUTH: the shared internal secret (constant-time) proves the caller is our
 *    own eve runtime; the HMAC-signed chat-run token proves + scopes the run to
 *    one conversation.
 * 2. CEILING (STRUCTURAL, server-side): the requested tool MUST be in the
 *    conversation's ceiling, RE-DERIVED here from the verified token —
 *    the workspace edition's ceiling ∩ the agentId's computeToolCeiling, then
 *    ∪ the user's external-MCP tool names — never from anything model-visible.
 *    The edition half is what keeps a hidden feature's tools (evals) from
 *    executing here in a workspace that does not have the feature, including on
 *    a default-assistant run where the agent side imposes no limit at all.
 *    This is the F1 lesson as defense in depth: even
 *    though the eve resolver only advertises ceiling tools, an out-of-ceiling
 *    call is rejected here regardless of what the model believes. The ceiling is
 *    computed by the SAME function the spec rebuild advertises from
 *    (resolveChatCeiling, src/lib/chat/chat-ceiling.ts) — NOT report-mode.
 *    A SURFACE token (device_ask) additionally loses its surface's structural
 *    exclusions (SURFACE_EXCLUDED_TOOLS: no mcp_confirm_call on the unattended
 *    device), in both the ceiling and the inherit-all branch.
 *    A TEAMMATE-CHAT token (bots v2, `teammateId`) takes its own rule instead:
 *    the teammate's bounds — resolved live from the token's teammate, failing
 *    closed (403) when it is gone or out of the token user's reach (a private
 *    team they are not on) — over edition ∩ persona
 *    (resolveTeammateChatCeiling, the call the spec rebuild makes too), with no
 *    external-MCP tools loaded at all, and the tools run as the teammate's
 *    (status writes carry an agent origin, as a work run's do).
 * 3. LIVENESS (surface tokens only): the token's ephemeral ownership row must
 *    still exist (surface-run-guard.ts). Deleting it when the device ask ends
 *    revokes the token (403), so an uncancellable session stops dispatching
 *    here; a lookup that errors refuses too, but as a transient 503.
 *
 * 4. THE REVIEWER (A5, src/lib/safety/action-review.ts): last before execute,
 *    a risky call (external-write, delete, automation-write, an external or
 *    unclassified tool) is checked by Jev's action.review against the
 *    person's own latest words, which the chat agent forwards with a
 *    monotonic personMessageSeq. SHADOW today: it records and allows.
 *    Enforced, a block holds the call as an approval card instead. And
 *    mcp_confirm_call never runs the model's call: it raises an approval
 *    (src/lib/safety/approvals.ts) that the person accepts on its card.
 *    Whatever the reviewer's mode, the outward gate inside it
 *    (src/lib/safety/outward-gate.ts) holds a calendar invite to anyone
 *    outside the workspace and a connected app's non-read-only tool as the
 *    person's card (refused NEEDS_PERSON on a relayed turn).
 *
 * 5. THE CALLER (src/lib/safety/caller.ts, the one trust authority): the
 *    token maps to a caller class (the person; the person remote on the
 *    device ask; unattended for a server or relayed turn), and past its
 *    ceiling a call must pass callerMayCall for that class (403
 *    CALLER_NOT_ALLOWED otherwise). The same class decides what the outward
 *    gate's hold becomes.
 *
 * ── The caller's bearer ─────────────────────────────────────────────────────
 * generate_email_drafts / draft_followup_email call back into the app as the
 * user and need the caller's Supabase JWT (createTools' accessToken). A token
 * minted for a JWT caller (the browser chat mint, from its own Bearer; the
 * device ask) carries it sealed (`cred`, chat-run-credential.ts); it is opened
 * here only after every gate above passed, only when it decrypts under this
 * token's binding and names the token's own user — the in-process routes'
 * createTools(…, bearer), nothing more. Without it both tools answer 401.
 *
 * ── Chat-native tools (no generic execute; run here with eve's ids) ─────────
 * start_helper and stop_helper (background helpers, always-on-agent §4;
 * src/lib/chat/start-helper.ts) and the main agent's relay to the bots
 * (bots-v4 Phase A3: send_bot_message, wait_for_bot_reply, which also steers a
 * running helper; src/lib/bots/bot-relay.ts). All four are refused outright
 * on a teammate or surface token. The relay states this route's maxDuration:
 * it waits 40 s for a bot's reply, then finishes the bot's turn in after().
 * The Native Intelligence agent's local agents on the person's Mac (docs/plans/local-agents.md:
 * local_agents, start_local_agent, message_local_agent, read_local_agent,
 * stop_local_agent; src/lib/chat/local-agent-tools.ts) are chat-native the
 * same way, and so is their cloud counterpart, start_cloud_coding_run
 * (docs/plans/environments.md E2; src/lib/chat/cloud-coding-tools.ts).
 * start_local_agent and start_cloud_coding_run run only in a typed turn,
 * keyed on eve's ids;
 * a home turn may read them, stop one, and answer one's open question
 * (serverTurnMayCall, then the handler checks last_signal = 'ask').
 *
 * ── The check-in (docs/plans/now-file.md "Who may write the note") ─────────
 * A home turn minted for reason 'check_in' runs in a fresh session of its
 * own and holds only its allow-list (serverTurnMayCall's check_in branch:
 * update_now, start_helper and internal-text reads). It is the one server
 * turn granted an attended-only tool, update_now (checkInNowGrant), and the one
 * whose createTools gets a Now context (writer 'check_in', not readable).
 * A result that still carries outside text (an internal tool's untrusted
 * fence) is withheld from it (chat-tool-dispatch.ts withholdOutsideText).
 * Its start_helper is kind 'check_in' (start-helper.ts: a tracked item, a
 * light model, migration 443's caps).
 *
 * Tenancy (workspaceId, userId) comes ONLY from the verified token. The tools
 * are createTools(userId, supabase, workspaceId) + the external-MCP tools +
 * search_tools, over a service-role client.
 *
 * ── get_attachment_content — SIGNED-URL FALLBACK (resolved decision) ─────────
 * eve's tool output is strictly text|json — there is no inline-image variant. So
 * on the eve path get_attachment_content returns a signed URL + text metadata
 * and NEVER inline image bytes: the internal image-transport keys
 * (__imageBase64/__imageMimeType) an in-process toModelOutput would consume are
 * STRIPPED here before the output is returned. The model does not receive raw
 * image bytes on the eve path (slight visual-reasoning loss, accepted).
 */
import { NextResponse } from 'next/server'
import { browserCommandAttribution } from '@/lib/browser-agent/attribution'
import { getServiceClient } from '@/lib/admin'
import { createTools } from '@/lib/ai/tools'
import { createSearchToolsTool } from '@/lib/ai/tool-discovery'
import { ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { resolveFollowThrough } from '@/lib/chat/follow-through'
import {
  resolveAgentToolCeiling,
  resolveChatCeiling,
  resolveTeammateChatBounds,
  resolveTeammateChatCeiling,
  serverTurnMayCall,
  channelTurnMayUseNative,
  isToolExcludedForSurface,
  surfaceExternalToolNames,
} from '@/lib/chat/chat-ceiling'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'
import { openRunCredential } from '@/lib/chat/chat-run-credential'
import { parseCardContext } from '@/lib/chat-cards/context'
import type { PersonalCardKind } from '@/lib/ai/tools/show'
import { personalCardKindsFor } from '@/lib/chat/personal-card-kinds'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractChatRunToken,
  isCheckInClaims,
  verifyChatRunToken,
  type ChatRunTokenClaims,
} from '@/lib/chat/chat-run-token'
import { shadowHelperChoice, startChatHelper, stopChatHelper } from '@/lib/chat/start-helper'
import { startHelperSchema, stopHelperSchema } from '@/lib/ai/tools/chat-helpers'
import { sendBotMessageSchema, waitForBotReplySchema } from '@/lib/ai/tools/bot-relay'
import {
  localAgentsSchema,
  messageLocalAgentSchema,
  readLocalAgentSchema,
  startLocalAgentSchema,
  stopLocalAgentSchema,
} from '@/lib/ai/tools/local-agent'
import { listLocalAgents, messageLocalAgent, readLocalAgent, startLocalAgent, stopLocalAgent, type LocalAgentLaunch } from '@/lib/chat/local-agent-tools'
import { startCloudCodingRunSchema } from '@/lib/ai/tools/cloud-coding'
import { startCloudCodingRun } from '@/lib/chat/cloud-coding-tools'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { validWriterModel } from '@/lib/ai/tools/content'
import { sendBotMessage, waitForBotReply } from '@/lib/bots/bot-relay'
import { goAheadTurnKey } from '@/lib/chat/flow-go-ahead-guard'
import { turnOutsideReadTools } from '@/lib/chat/turn-outside-reads'
import { helpersGate, isHelperTool } from '@/lib/chat/helpers-gate'
import type { HeldCallOutput } from '@/lib/safety/action-review'
import { createToolApproval, type ApprovalContext } from '@/lib/safety/approvals'
import { TEXT_TURN_HOLD } from '@/lib/chat/text-turn'
import { WEBSITE_PREPARE_TOOLS } from '@/lib/website/types'
import { CALL_TURN_HOLD } from '@/lib/chat/call-turn'
import { guestToolCall } from '@/lib/guests/guest-tools'
import { answerGuestAsk } from '@/lib/guests/guest-asks'
import { callKeyOf } from '@/lib/guests/reach-owner'
import { answerGuestSchema } from '@/lib/ai/tools/guest-answer'
import { askAgentSchema } from '@/lib/ai/tools/agent-link-ask'
import { askAgent } from '@/lib/agent-links/exchange'
import { callerClassOf, callerMayCall, callerRefusalMessage, type CallerClass, type DecideOptions } from '@/lib/safety/caller'
import { checkInNowGrant, nowContextForChatCall } from '@/lib/now/now-context'
import type { NowToolContext } from '@/lib/ai/tools/now'
import {
  REGISTRY_TOOLS,
  chatGate as dispatchGate,
  externalToolPolicy,
  loadChatExternalTools,
  personMessageSeqOf,
  runTool,
  type ToolCallScope,
  type ToolDispatchContext,
} from '@/lib/chat/chat-tool-dispatch'

export const dynamic = 'force-dynamic'

/**
 * What a home turn's tools run under (it acts on its own, nobody watching):
 * the unattended rules a work run's own turns keep. An approved card runs
 * later with the person's own options (approvals.ts), not these.
 */
const HOME_TURN_TOOL_OPTIONS = {
  unattended: true,
  automaticDrafts: true,
  origin: { actor: 'agent' as const, depth: 1 },
  actionRules: { unattended: true, fileActionsAsSuggested: true },
}
/**
 * Stated, not left to the platform default (bots-v4 Phase A3): the main
 * agent's relay waits up to 40 s for a bot's reply and then finishes the
 * bot's turn in after(), cancelling it at 270 s (src/lib/bots/bot-relay.ts),
 * and wait_for_bot_reply waits up to 240 s. Both fit inside this.
 */
export const maxDuration = 300

/**
 * The main agent's relay to the bots (bots-v4 Phase A3): chat-native, so only
 * the main chat runs them. A teammate token (a bot's thread, a Phase C bot
 * conversation, a relayed thread turn) and a surface token (the device ask)
 * are refused before anything else, so a bot can never call back into the
 * main agent or another bot, whatever a ceiling says. The background-helper
 * tools (start_helper, stop_helper) are the main chat's alone the same way.
 */
const RELAY_TOOLS: ReadonlySet<string> = new Set([
  'send_bot_message',
  'wait_for_bot_reply',
  'start_helper',
  'stop_helper',
  // The local agents on the person's Mac: the main chat's alone too.
  'local_agents',
  'start_local_agent',
  'message_local_agent',
  'read_local_agent',
  'stop_local_agent',
  // …and their cloud counterpart (docs/plans/environments.md E2).
  'start_cloud_coding_run',
  // The main agent's answer to a guest's ask (guest access): never a bot's or a surface's.
  'answer_guest',
  // The main agent asking a linked person's agent (agent links): the main chat's alone too.
  'ask_agent',
])

interface ToolCallBody {
  toolName?: string
  input?: unknown
  callId?: unknown
  /** eve's durable turn id (ctx.session.turn.id); start_helper and the relay scope callId by it. */
  turnId?: unknown
  /** eve's durable session id (ctx.session.id); turn ids restart per session, so it scopes turnId. */
  sessionId?: unknown
  /** Authenticated Eve envelope, never a model tool argument. */
  browserSourceRequest?: unknown
  /** The turn's cards (spec.cards), forwarded with a read_card call. Parsed, never trusted. */
  cards?: unknown
  /** The browser's IANA zone (spec.timeZone), forwarded with show, read_card, create_flow and update_flow. Checked, never trusted. */
  timeZone?: unknown
  /**
   * The evidence rule (agents/chat-agent/lib/person-messages.ts): with a
   * remember of a profile fact, whether its `quote` is one of the person's
   * latest messages. Only `true` lets the fact save active; anything else
   * (absent, false, junk) saves a proposal.
   */
  quoteVerified?: unknown
  /**
   * Set by a quick helper's proxies (agents/chat-agent/tools/workspace_tools.ts,
   * role 'helper'): the call comes from a `helper` child session, which holds
   * read plus drafts only. Its tool resolver advertises nothing else; this is
   * the server-side fence behind it (src/lib/chat/helpers-gate.ts).
   */
  helper?: unknown
  /**
   * The reviewer's evidence (A5 slice 2, src/lib/safety/action-review.ts):
   * the person's latest messages in this session, oldest first, as the chat
   * agent keeps them (agents/chat-agent/lib/person-messages.ts: never a
   * seeded send, an eve-authored or a framework message), and their count so
   * far (monotonic). Parsed, capped; read only by action.review.
   */
  personMessages?: unknown
  personMessageSeq?: unknown
  /** How many of personMessages (oldest first) came in earlier turns than this call's. */
  personMessagesStale?: unknown
  /**
   * With review_post (content C0): the chat turn's model, from the chat
   * agent's own turn state (agents/chat-agent/lib/turn-model-selection.ts),
   * never the model's input. The post reviewer is picked from another vendor
   * (decision 13). Checked (validWriterModel), never trusted for anything else.
   */
  writerModel?: unknown
}

/**
 * What the model reads when send_bot_message failed before it sent anything
 * (a failed read or claim: bot-relay.ts throws only then).
 */
const RELAY_NOT_SENT =
  "The message could not be sent to the agent, and nothing was sent. Tell the person; they can ask again, or open the agent's chat"

/**
 * What the model reads when a start_local_agent call could not be confirmed
 * (the session may or may not have been written). A retry of the same call is
 * idempotent, but the model's retry is a new call id, so a second session.
 */
const LOCAL_AGENT_UNCONFIRMED =
  'Could not confirm the local agent started. Do not call start_local_agent again for this request: tell the person, who can ask you to check local_agents (it lists what is running) and ask again'

/**
 * What the model reads when a start_cloud_coding_run call could not be
 * confirmed (the action or the run may or may not have been written). A retry
 * of the same call finds its run (agent_run.fire_key); the model's retry is a
 * new call id.
 */
const CLOUD_CODING_UNCONFIRMED =
  'Could not confirm the coding run started. Do not call start_cloud_coding_run again for this request: tell the person, who can check the project’s actions and ask again'

/**
 * What the model reads when a start_helper launch could not be confirmed.
 * Raised only BEFORE the admission committed or when its outcome is unknown
 * (an admitted launch answers `queued`, startChatHelper), so it must not
 * invite an automatic relaunch: a retry is a new call id, so new work.
 */
const HELPER_UNCONFIRMED =
  'Could not confirm the helper started. Do not call start_helper again for this request: tell the person, who can check list_bot_work (it lists what is working) and ask again'

export async function POST(request: Request) {
  // When the call came in: the relay's 40 s hand-off and 270 s cancel count from here.
  const startedAt = Date.now()
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid chat-run token — the authoritative source of tenancy + routing.
  const claims = verifyChatRunToken(extractChatRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  // Its writes are the agent's, for this person (the activity log).
  const supabase = getServiceClient({ agentFor: claims.userId })

  // Gate 3 (surface tokens only): the run must still own its ephemeral row.
  // /api/device/ask deletes that row when the ask ends, so an uncancellable
  // session stops dispatching tools there and then, not at the token's `exp`.
  const refused = await chatRunBindingRefusal(claims, supabase)
  if (refused) return refused

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

  // The relay is the main chat's alone (see RELAY_TOOLS): never on a bot's
  // token or a surface's, before any ceiling is consulted.
  // The one exception: the person's own text or Slack DM may start and stop
  // a background helper and message another person's agent (chat-ceiling.ts
  // CHANNEL_TURN_NATIVE_TOOLS).
  if (RELAY_TOOLS.has(toolName) && (claims.teammateId || claims.surface) && !channelTurnMayUseNative(toolName, claims)) {
    return NextResponse.json(
      { error: 'only the main chat can message an agent or run a helper', code: 'RELAY_NOT_ALLOWED' },
      { status: 403 },
    )
  }

  // A turn the server started is held to what serverTurnMayCall admits,
  // before any ceiling is consulted. A server token carries no credential.
  // A home turn (a background update in the person's home thread) minted for
  // an acting reason (a helper's report, an event, another agent's answer)
  // acts on its own since 2026-10-26: its writes inside Native Intelligence run, and the
  // gate holds anything that leaves Native Intelligence as the person's card
  // (chatDispatchContext sets homeTurn). It never holds the relay, the
  // attended-only tools, the browser, a tool that needs the person's JWT or
  // one that settles their review items. A guest's ask and the digest stay
  // read-only, as does any other server turn (idle compaction). A channel turn
  // (`channel_turn`: the person messaging from Slack or texting the Native Intelligence
  // number) is not read-only: it passes here and meets its surface's
  // exclusions in the ceiling below.
  if (claims.server !== undefined && !serverTurnMayCall(toolName, claims.server, claims.homeTurnReason)) {
    return NextResponse.json(
      {
        error:
          `'${toolName}' isn't available in a background update the server started. ` +
          'Tell the person what you would do instead, or call no_reply.',
        code: 'SERVER_TURN_READ_ONLY',
      },
      { status: 403 },
    )
  }

  // A quick helper's call (A4 slice 3): only on a token that may start
  // helpers, and only a read-plus-drafts tool, before any ceiling is consulted.
  if (body.helper === true) {
    const gate = helpersGate(claims)
    if (!gate.allowed || !isHelperTool(toolName)) {
      return NextResponse.json(
        { error: gate.allowed ? `a helper cannot call '${toolName}' (read and drafts only)` : gate.reason, code: 'HELPER_TOOL_NOT_ALLOWED' },
        { status: 403 },
      )
    }
  }

  // ── A guest's own agent (guest access): its own ceiling, the owner's cards ─
  // The guest is read live for the TOKEN's guest (src/lib/guests/guest-tools.ts):
  // removed, someone else's, or another thread refuses every call. No
  // external tools, no chat-native tools, and every risky call is the owner's
  // approval card.
  if (claims.guestId) {
    return guestToolCall(supabase, claims, toolName, body)
  }

  // ── Teammate chat (bots v2): its own ceiling, no external tools ──────────
  // The bounds are read live for the TOKEN's teammate (never anything
  // model-visible); a teammate that is gone, moved out of the token's
  // workspace, or out of the token user's reach (a private team they are not
  // on) refuses every call. resolveTeammateChatCeiling is the call the spec
  // rebuild advertises from, so what is advertised is what is enforced.
  if (claims.teammateId) {
    const bounds = await resolveTeammateChatBounds(supabase, claims.workspaceId, claims.teammateId, claims.userId)
    if (!bounds) {
      return NextResponse.json(
        { error: 'this teammate is no longer available', code: 'TEAMMATE_UNAVAILABLE' },
        { status: 403 },
      )
    }
    const teammateCeiling = await resolveTeammateChatCeiling(supabase, {
      workspaceId: claims.workspaceId,
      teammateId: claims.teammateId,
      bounds,
    })
    if (!teammateCeiling.has(toolName)) {
      return NextResponse.json(
        { error: `tool '${toolName}' is not in this conversation's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
        { status: 403 },
      )
    }
    // The caller's class (caller.ts). A turn the main agent relays keeps an
    // attended-only tool only when it is one of THIS bot's follow-through
    // grants (follow-through.ts), read for that tool alone.
    const granted = chatCallerClass(claims) === 'agent_unattended' && ATTENDED_ONLY_TOOL_NAMES.has(toolName)
      ? (await resolveFollowThrough(supabase, { workspaceId: claims.workspaceId, teammateId: claims.teammateId })).has(toolName)
      : false
    const callerRefused = callerRefusal(claims, toolName, { granted })
    if (callerRefused) return callerRefused
    const accessToken = claims.cred ? (openRunCredential(claims.cred, claims) ?? undefined) : undefined
    return runTool(chatDispatchContext(supabase, claims), toolName, body.input, body, {
      search_tools: createSearchToolsTool(teammateCeiling),
      // The teammate acts, as on a work run: its status writes are an AGENT's,
      // one hop from the person's message (flows/types.ts StatusChangeOrigin),
      // so an automation does not re-fire on them by default. The person is
      // present and sees their own private captures, so no strict/unattended
      // fencing (that is for runs nobody watches).
      ...createTools(claims.userId, supabase, claims.workspaceId, accessToken, {
        origin: { actor: 'agent', depth: 1 },
        // A canon section edit's provenance (canon D2): a relayed turn in the
        // bot's thread is unattended (the main agent's words, not the
        // person's), so with no run to check its edit is labelled outside.
        canonContext: chatCanonContext(claims),
        // A connection card's re-check context (F2): the persona's ceiling at Accept.
        approvalContext: chatApprovalContext(claims),
        // A chat: its prompt carries the search-scope guidance, so a search
        // starts at the past 4 weeks and the model widens (search-scope.ts).
        searchDefaultWindow: 'past_4_weeks',
        browserAttribution: browserCommandAttribution(claims, body),
        browserSourceRequest: validBrowserSourceRequest(body.browserSourceRequest),
        // suggest_changes shows its cards in this teammate conversation.
        suggestionContext: { origin: 'chat', conversationId: claims.conversationId },
        // A loop asked for after this turn read outside text is saved off and asked about in chat (#835 S1).
        flowContext: chatFlowContext(claims, body),
        // The zone a calendar card's days are in (and a schedule loop's, should a bot ever hold the loop tools).
        ...(isTimeZone(body.timeZone) ? { timeZone: body.timeZone } : {}),
      }),
    })
  }

  // Load the user's external-MCP tools first — their names are part of the
  // ceiling union (user opt-in trumps agent restriction) AND they must be
  // dispatchable here. Loaded by the token's userId, exactly as the spec route
  // loads them. mcp_confirm_call holds the call for the person (A5 slice 3):
  // a card, and the server runs the stored call once they accept it.
  const externalMcp = await loadChatExternalTools(chatDispatchContext(supabase, claims), body)
  // Minus the token surface's structural exclusions (device_ask: no
  // mcp_confirm_call) — the same filter the spec rebuild applies.
  const externalMcpToolNames = surfaceExternalToolNames(Object.keys(externalMcp.tools), claims.surface)

  // ── CEILING CHECK (structural, RE-DERIVED from the token — never model-visible) ─
  // The agent persona's ceiling comes from live config for the TOKEN's agentId
  // (null → inherit-all: default assistant / inherit-all agent), then the shared
  // resolveChatCeiling composes it with the WORKSPACE edition's ceiling and the
  // external-MCP union — the ONE function rebuildChatSpec (the advertise half)
  // also calls, so what is advertised is what is enforced. The edition half is
  // what keeps a hidden feature's tools (evals) from executing here under a
  // service-role client in a workspace that does not have the feature, including
  // on a default-assistant run where the agent side imposes no limit at all.
  // NOT report-mode (chat never uses computeReportModeCeiling).
  const agentToolCeiling = await resolveAgentToolCeiling(supabase, claims.agentId)
  const effectiveCeiling = await resolveChatCeiling(supabase, {
    workspaceId: claims.workspaceId,
    agentToolCeiling,
    externalMcpToolNames,
  })

  // Resolve the permission against the ACTUAL tool surface in every case.
  // search_tools (read-only discovery) is always permitted. A null ceiling is
  // inherit-all — but that means "any tool that EXISTS" (registry ∪ external
  // tools), NEVER "any string": otherwise a prototype-magic name ('__proto__',
  // 'constructor', 'hasOwnProperty') would pass the gate and reach the lookup
  // below. Both branches test Set membership, so this is prototype-pollution-safe.
  const externalMcpNameSet = new Set(externalMcpToolNames)
  const permitted =
    !isToolExcludedForSurface(toolName, claims.surface) &&
    (toolName === 'search_tools' ||
    (effectiveCeiling
      ? effectiveCeiling.has(toolName)
      : REGISTRY_TOOLS.has(toolName) || externalMcpNameSet.has(toolName)))
  if (!permitted) {
    // Fail-closed boundary (F1 lesson). An out-of-ceiling or unknown call never executes.
    return NextResponse.json(
      { error: `tool '${toolName}' is not in this conversation's ceiling`, code: 'TOOL_OUT_OF_CEILING' },
      { status: 403 },
    )
  }
  // The caller's class (caller.ts): past the ceiling, the one trust authority.
  // One grant (docs/plans/now-file.md "Who may write the note"): the check-in,
  // in its own fresh session, may write the person's Now file. Exactly that
  // pair: every other server turn stays refused the attended-only tools.
  const callerRefused = callerRefusal(claims, toolName, checkInNowGrant(claims, toolName, body) ? { granted: true } : undefined)
  if (callerRefused) return callerRefused

  // The registry schema has no generic execute (MCP and other surfaces cannot
  // use it). Only this token-authenticated chat boundary supplies its identity:
  // eve's call, turn and session ids, and this conversation's ceiling, which
  // bounds the helper's run (and every handoff under it) to what this chat
  // could call.
  if (toolName === 'start_helper') {
    if (typeof body.callId !== 'string' || !body.callId.trim() || body.callId.length > 200) {
      return NextResponse.json({ error: 'missing durable callId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.turnId !== 'string' || !/^[^:]{1,200}$/.test(body.turnId)) {
      return NextResponse.json({ error: 'missing durable turnId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.sessionId !== 'string' || !/^[^:]{1,200}$/.test(body.sessionId)) {
      return NextResponse.json({ error: 'missing durable sessionId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    const input = startHelperSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    let output: Record<string, unknown>
    try {
      // The person's newest message (the reviewer's evidence): "use the best
      // model" there makes the helper Strong (src/lib/ai/model-route.ts).
      const personMessages = Array.isArray(body.personMessages) ? body.personMessages.filter((m): m is string => typeof m === 'string') : []
      const personMessage = personMessages.length > 0 ? personMessages[personMessages.length - 1].slice(0, 2000) : undefined
      const launch = { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId, chatCeiling: effectiveCeiling, ...(personMessage ? { personMessage } : {}) }
      // The reviewer (A5): a helper acts for the person, so it must trace back
      // to their own words. Chat-native: an enforced block refuses (the server
      // cannot replay a launch later), it never becomes a card. A home turn
      // has no words of the person's to trace to, and a text's would always
      // be held (a caller ID can be spoofed: TEXT_TURN_HOLD), so their start
      // is fenced structurally instead (startChatHelper: the generic
      // read-and-draft helper only; a home turn's on its own budget). The
      // app and a Slack DM go through the reviewer.
      const gated = claims.server === 'home_turn' || isTextTurn(claims)
        ? { held: false as const, value: await startChatHelper(supabase, claims, launch, input.data) }
        : await chatGate(supabase, claims, toolName, input.data, body, () => startChatHelper(supabase, claims, launch, input.data))
      if (gated.held) return NextResponse.json({ output: gated.output })
      output = gated.value
    } catch (err) {
      console.error('[chat-helper] launch failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: HELPER_UNCONFIRMED, code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
    // Jev's helper.choice, in shadow (always-on-agent §6b): after the answer,
    // only for a new start, and only when there were two or more helpers to
    // pick from (shadowHelperChoice checks). It records and changes nothing.
    if (!claims.server && typeof output.run_id === 'string' && output.status !== 'refused' && output.reused !== true) {
      shadowHelperChoice({ supabase, claims, input: input.data, runId: output.run_id })
    }
    return NextResponse.json({ output })
  }
  if (toolName === 'stop_helper') {
    const input = stopHelperSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    try {
      // Stopping a helper sends, deletes and writes nothing outside Native Intelligence (what
      // it drafted stays), so a text stops one without the hold every risky
      // call from a text gets; elsewhere it goes through the reviewer.
      const gated = isTextTurn(claims)
        ? { held: false as const, value: await stopChatHelper(supabase, claims, input.data) }
        : await chatGate(supabase, claims, toolName, input.data, body, () => stopChatHelper(supabase, claims, input.data))
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error('[chat-helper] stop failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not stop the helper right now. Nothing changed; try stop_helper again.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }

  // The main agent talks to the bots (bots-v4 Phase A3): one turn in the chat
  // of an item's run (or a steer into a running helper's turn), keyed on
  // eve's call, turn and session ids like start_helper's launch, so a retried
  // call sends once. The bot acts under
  // its own attended chat ceiling, never this chat's (bot-relay.ts).
  if (toolName === 'send_bot_message') {
    if (typeof body.callId !== 'string' || !body.callId.trim() || body.callId.length > 200) {
      return NextResponse.json({ error: 'missing durable callId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.turnId !== 'string' || !/^[^:]{1,200}$/.test(body.turnId)) {
      return NextResponse.json({ error: 'missing durable turnId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.sessionId !== 'string' || !/^[^:]{1,200}$/.test(body.sessionId)) {
      return NextResponse.json({ error: 'missing durable sessionId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    const input = sendBotMessageSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    try {
      const launch = { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId, startedAt }
      const gated = await chatGate(supabase, claims, toolName, input.data, body, () => sendBotMessage(supabase, claims, launch, input.data))
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error('[bot-relay] not sent:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: RELAY_NOT_SENT, code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  // A guest's ask, answered by the owner's agent (guest access, migration 429):
  // only one of the TOKEN owner's own pending asks (answerGuestAsk). A home
  // turn's guest_ask update answers without the gate (no words of the
  // person's to trace to, the ask fenced as data); a typed turn's answer is
  // the person's outward call, through the gate.
  if (toolName === 'answer_guest') {
    if (claims.relay) {
      return NextResponse.json({ error: 'only the main chat can answer a guest', code: 'RELAY_NOT_ALLOWED' }, { status: 403 })
    }
    const input = answerGuestSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    const run = () => answerGuestAsk(supabase, { userId: claims.userId, workspaceId: claims.workspaceId }, input.data)
    try {
      const gated = claims.server === 'home_turn' ? { held: false as const, value: await run() } : await chatGate(supabase, claims, toolName, input.data, body, run)
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error('[guest-ask] answer failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not confirm the answer was sent. Do not send it again: tell the person.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  // A linked person's agent, asked by the owner's agent (agent links, migration
  // 435): only over the TOKEN owner's own active links (askAgent). Since
  // 2026-10-26 every message to another person's agent waits for the
  // person's yes (nothing reaches another person without it): checked first
  // (it could go, and to whom), then held as their approval card, which sends
  // it once on accept (approvals.ts executeStoredCall). So the person's card
  // is what starts an exchange (decision 6 holds): a home turn may propose a
  // new one too (a hand-off after a call), never send it.
  if (toolName === 'ask_agent') {
    if (claims.relay) {
      return NextResponse.json({ error: "only the main chat can ask another person's agent", code: 'RELAY_NOT_ALLOWED' }, { status: 403 })
    }
    const input = askAgentSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    const caller = chatCallerClass(claims)
    const mayStart = claims.server === 'home_turn' || caller === 'person' || caller === 'person_remote'
    try {
      const check = await askAgent(supabase, { userId: claims.userId, workspaceId: claims.workspaceId, mayStart, callKey: callKeyOf(body), check: true }, input.data)
      if (check.success !== true) return NextResponse.json({ output: check })
      const peerName = typeof check.peer_name === 'string' && check.peer_name ? check.peer_name : 'the other person'
      return NextResponse.json({ output: await holdAgentMessage(supabase, claims, body, input.data, peerName, !!input.data.hand_off) })
    } catch (err) {
      console.error('[agent-link] ask failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not confirm the message was held for the person. Do not send it again: tell the person.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  // The Native Intelligence agent's local agents on the person's Mac (docs/plans/local-agents.md).
  // The library (src/lib/local-agent) checks every id against the token's user.
  // start_local_agent: a typed turn only (decision 8; serverTurnMayCall refused
  // a server token above), keyed on eve's call, turn and session ids. The
  // mutators go through the reviewer as chat-native (CHAT_NATIVE_REVIEWED: an
  // enforced block refuses, never a card the server would replay). A home
  // turn skips it, as its helper start does: it has no words of the person's
  // to trace to, and its message is fenced structurally instead (an answer to
  // an open question only, messageLocalAgent).
  if (toolName === 'local_agents' || toolName === 'read_local_agent') {
    let read: () => Promise<Record<string, unknown>>
    if (toolName === 'local_agents') {
      const input = localAgentsSchema.safeParse(body.input ?? {})
      if (!input.success) {
        return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
      }
      read = () => listLocalAgents(supabase, claims, input.data)
    } else {
      const input = readLocalAgentSchema.safeParse(body.input)
      if (!input.success) {
        return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
      }
      read = () => readLocalAgent(supabase, claims, input.data)
    }
    try {
      return NextResponse.json({ output: await read() })
    } catch (err) {
      console.error(`[local-agent] ${toolName} failed:`, err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: `Could not read the local agents right now. Try ${toolName} again.`, code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  if (toolName === 'start_local_agent') {
    if (claims.server) {
      return NextResponse.json(
        { error: 'A local agent starts only from a message the person typed. Tell the person what you would start, or call no_reply.', code: 'SERVER_TURN_READ_ONLY' },
        { status: 403 },
      )
    }
    if (typeof body.callId !== 'string' || !body.callId.trim() || body.callId.length > 200) {
      return NextResponse.json({ error: 'missing durable callId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.turnId !== 'string' || !/^[^:]{1,200}$/.test(body.turnId)) {
      return NextResponse.json({ error: 'missing durable turnId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.sessionId !== 'string' || !/^[^:]{1,200}$/.test(body.sessionId)) {
      return NextResponse.json({ error: 'missing durable sessionId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    const input = startLocalAgentSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    const launch: LocalAgentLaunch & { personWords?: string[] } = { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId, ...personWordsOf(claims, body) }
    try {
      const gated = await chatGate(supabase, claims, toolName, input.data, body, () => startLocalAgent(supabase, claims, launch, input.data))
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error('[local-agent] start failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: LOCAL_AGENT_UNCONFIRMED, code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  // The cloud counterpart (docs/plans/environments.md E2): a typed turn only,
  // keyed on eve's ids like start_local_agent, reviewed as chat-native.
  if (toolName === 'start_cloud_coding_run') {
    if (claims.server) {
      return NextResponse.json(
        { error: 'A coding run starts only from a message the person typed. Tell the person what you would start, or call no_reply.', code: 'SERVER_TURN_READ_ONLY' },
        { status: 403 },
      )
    }
    if (typeof body.callId !== 'string' || !body.callId.trim() || body.callId.length > 200) {
      return NextResponse.json({ error: 'missing durable callId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.turnId !== 'string' || !/^[^:]{1,200}$/.test(body.turnId)) {
      return NextResponse.json({ error: 'missing durable turnId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    if (typeof body.sessionId !== 'string' || !/^[^:]{1,200}$/.test(body.sessionId)) {
      return NextResponse.json({ error: 'missing durable sessionId', code: 'INPUT_INVALID' }, { status: 400 })
    }
    const input = startCloudCodingRunSchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    const launch: LocalAgentLaunch = { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId }
    try {
      const gated = await chatGate(supabase, claims, toolName, input.data, body, () => startCloudCodingRun(supabase, claims, launch, input.data))
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error('[cloud-coding] start failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: CLOUD_CODING_UNCONFIRMED, code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }
  if (toolName === 'message_local_agent' || toolName === 'stop_local_agent') {
    let input: unknown
    let run: () => Promise<Record<string, unknown>>
    if (toolName === 'message_local_agent') {
      // Keyed on eve's ids like start_local_agent, so a retried call sends once.
      if (typeof body.callId !== 'string' || !body.callId.trim() || body.callId.length > 200) {
        return NextResponse.json({ error: 'missing durable callId', code: 'INPUT_INVALID' }, { status: 400 })
      }
      if (typeof body.turnId !== 'string' || !/^[^:]{1,200}$/.test(body.turnId)) {
        return NextResponse.json({ error: 'missing durable turnId', code: 'INPUT_INVALID' }, { status: 400 })
      }
      if (typeof body.sessionId !== 'string' || !/^[^:]{1,200}$/.test(body.sessionId)) {
        return NextResponse.json({ error: 'missing durable sessionId', code: 'INPUT_INVALID' }, { status: 400 })
      }
      const parsed = messageLocalAgentSchema.safeParse(body.input)
      if (!parsed.success) {
        return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(parsed.error) }, { status: 400 })
      }
      input = parsed.data
      const launch: LocalAgentLaunch & { personWords?: string[] } = { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId, ...personWordsOf(claims, body) }
      run = () => messageLocalAgent(supabase, claims, launch, parsed.data)
    } else {
      const parsed = stopLocalAgentSchema.safeParse(body.input)
      if (!parsed.success) {
        return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(parsed.error) }, { status: 400 })
      }
      input = parsed.data
      run = () => stopLocalAgent(supabase, claims, parsed.data)
    }
    try {
      const gated = claims.server ? { held: false as const, value: await run() } : await chatGate(supabase, claims, toolName, input, body, run)
      return NextResponse.json({ output: gated.held ? gated.output : gated.value })
    } catch (err) {
      console.error(`[local-agent] ${toolName} failed:`, err instanceof Error ? err.message : String(err))
      return NextResponse.json(
        {
          error:
            toolName === 'message_local_agent'
              ? 'Could not confirm the message reached the local agent. Do not send it again: tell the person, and check with read_local_agent.'
              : 'Could not stop the local agent right now. Nothing changed; try stop_local_agent again.',
          code: 'TOOL_EXECUTE_FAILED',
        },
        { status: 503 },
      )
    }
  }
  if (toolName === 'wait_for_bot_reply') {
    const input = waitForBotReplySchema.safeParse(body.input)
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    try {
      return NextResponse.json({ output: await waitForBotReply(supabase, claims, input.data) })
    } catch (err) {
      console.error('[bot-relay] wait failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not read the agent\'s reply. Try wait_for_bot_reply again.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }

  // ── Rebuild the REAL tools under the TOKEN's tenancy ─
  // The caller's own JWT for the tools that call back into the app as the user
  // (tokens minted for a JWT caller only — see the header).
  const accessToken = claims.cred ? (openRunCredential(claims.cred, claims) ?? undefined) : undefined
  // The search tools take their scope from the model's own arguments. The main
  // chat starts at the past 4 weeks (its prompt says when to widen); a surface
  // token (device ask) keeps the all-time default every non-chat caller has. A
  // `searchSettings` an older chat-agent still forwards is ignored.
  return runTool(chatDispatchContext(supabase, claims, toolName), toolName, body.input, body, {
    search_tools: createSearchToolsTool(effectiveCeiling),
    ...createTools(claims.userId, supabase, claims.workspaceId, accessToken, {
      // A canon section edit's provenance (canon D2): a server-started home
      // turn is unattended (nobody asked), so with no run to check its edit is
      // labelled outside.
      canonContext: chatCanonContext(claims),
      // A connection card's re-check context (F2): the persona's ceiling at Accept.
      approvalContext: chatApprovalContext(claims),
      // A home turn has nobody watching: the unattended rules every run with
      // nobody at the keyboard keeps (new actions filed as suggestions, no
      // confirming a suggestion, the shared cap on automatic drafts, no
      // HubSpot push before someone looks, its status writes an agent's).
      ...(claims.server === 'home_turn' ? HOME_TURN_TOOL_OPTIONS : {}),
      // The person at the keyboard, reading this turn: an offer they make by link is shown to them (time_offer.recipients_shown).
      ...(chatCallerClass(claims) === 'person' ? { personAttended: true } : {}),
      // A remember of a profile fact saves active only on a verified quote.
      ...(body.quoteVerified === true ? { rememberQuoteVerified: true } : {}),
      // The person's own text: connect_link may text them a link (src/lib/ai/tools/text-setup.ts).
      ...(isPersonTextTurn(claims) ? { textTurn: true } : {}),
      // A text or a call from the person's verified phone: a caller ID can be spoofed (the website tools' guards).
      ...(isPersonTextTurn(claims) || isPersonCallTurn(claims) ? { remoteTurn: true } : {}),
      searchDefaultWindow: claims.surface ? 'all_time' : 'past_4_weeks',
      browserAttribution: browserCommandAttribution(claims, body),
      browserSourceRequest: validBrowserSourceRequest(body.browserSourceRequest),
      // suggest_changes shows its cards in this conversation.
      suggestionContext: { origin: 'chat', conversationId: claims.conversationId },
      // A loop asked for after this turn read outside text is saved off and asked about in chat (#835 S1).
      flowContext: chatFlowContext(claims, body),
      // The cards on the person's screen, as the chat-agent forwarded them
      // with a read_card call (spec.cards); checked again here.
      ...cardsOption(body.cards),
      // Calendar and mail cards, each only where its own tool is permitted.
      ...personalCardKinds(effectiveCeiling, claims.surface),
      // The zone a calendar card's days are in, and a schedule loop's default zone.
      ...(isTimeZone(body.timeZone) ? { timeZone: body.timeZone } : {}),
      // The post reviewer's other-vendor pick (content C0): the turn's writer.
      ...(validWriterModel(body.writerModel) ? { contentContext: { writerModel: validWriterModel(body.writerModel) } } : {}),
      // The person's Now file (docs/plans/now-file.md): read and written only
      // in their own main chat in the app, never a quick helper's call.
      ...nowContextOption(claims, body),
    }),
    ...externalMcp.tools,
  }, { externalTool: externalToolPolicy(externalMcp.meta, toolName) })
}

/**
 * What an approval raised in this chat needs at accept time: the ceiling's
 * inputs (agent, teammate, surface) and the createTools options the call ran
 * under (a teammate's writes are an agent's, one hop from the person).
 */
function chatApprovalContext(claims: ChatRunTokenClaims): ApprovalContext {
  return {
    ...(claims.agentId ? { agentId: claims.agentId } : {}),
    ...(claims.teammateId ? { teammateId: claims.teammateId, tools: { origin: { actor: 'agent' as const, depth: 1 } } } : {}),
    ...(claims.surface ? { surface: claims.surface } : {}),
  }
}

/**
 * This chat's call context for the shared dispatch (src/lib/chat/chat-tool-dispatch.ts):
 * tenancy and conversation from the verified token, its caller class, what
 * an approval records, and the token's user as the per-turn guards' scope.
 */
function chatDispatchContext(supabase: ReturnType<typeof getServiceClient>, claims: ChatRunTokenClaims, toolName?: string): ToolDispatchContext {
  return {
    supabase,
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    conversationId: claims.conversationId,
    surface: claims.surface,
    caller: chatCallerClass(claims),
    approvalContext: chatApprovalContext(claims),
    keyScope: claims.userId,
    // A text turn (a caller ID can be spoofed): every risky call becomes the
    // person's card in the app, whatever the reviewer's mode. Except a change
    // the owner asks for on their own connected website (roadmap track E,
    // WEBSITE_PREPARE_TOOLS): it only prepares a pull request on that repo,
    // and its merge card IS the hold (a code to the real phone); it still goes
    // through the reviewer under its mode.
    ...(isTextTurn(claims) && !websiteMayPrepareByText(claims, toolName) ? { reviewOverride: { alwaysHold: TEXT_TURN_HOLD } } : {}),
    // A call turn (a caller ID can be spoofed too): the same, held as a card in the app.
    ...(isCallTurn(claims) ? { reviewOverride: { alwaysHold: CALL_TURN_HOLD } } : {}),
    // A home turn (the agent working on its own): anything that leaves Native Intelligence
    // is the person's card in the home thread, and they are pinged.
    ...(claims.server === 'home_turn' ? { reviewOverride: { homeTurn: true as const } } : {}),
    // The check-in (docs/plans/now-file.md): a fenced outside result never reaches it.
    ...(isCheckInClaims(claims) ? { withholdOutsideText: true as const } : {}),
  }
}

/**
 * Hold a message to another person's agent as the person's approval card
 * (every send to another person waits for their yes). The card shows the
 * exact words and who gets them; on accept the server sends it once
 * (approvals.ts executeStoredCall → askAgent). A home turn's card waits in
 * the home thread, and the person is pinged.
 */
async function holdAgentMessage(
  supabase: ReturnType<typeof getServiceClient>,
  claims: ChatRunTokenClaims,
  body: ToolCallBody,
  input: unknown,
  peerName: string,
  /** The message hands them an action item too (a suggestion on their board). */
  handOff: boolean,
): Promise<Record<string, unknown>> {
  const home = claims.server === 'home_turn'
  const held = await createToolApproval(supabase, {
    door: 'chat',
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    toolName: 'ask_agent',
    sideEffect: 'external-write',
    input,
    conversationId: claims.conversationId,
    context: chatApprovalContext(claims),
    reason: 'agent_message',
    personMessageSeq: personMessageSeqOf(body.personMessageSeq),
    card: {
      title: handOff ? `Hand ${peerName} this action item?` : `Send this to ${peerName}'s agent?`,
      why: handOff
        ? `Your agent wants to send this to ${peerName}'s agent and put the action item on ${peerName}'s board as a suggestion for them to confirm. Nothing reaches another person without your yes. It sends once, exactly as below, when you accept.`
        : `Your agent wants to send this message to ${peerName}'s agent. Nothing reaches another person without your yes. It sends once, with exactly the words below, when you accept.`,
    },
    ...(home ? { reachPerson: true as const } : {}),
  })
  if (!held.ok) {
    return { success: false, code: 'NOT_HELD', approval_id: null, message: `Nothing was sent, and no approval card was made: ${held.error} Tell the person.` }
  }
  return {
    success: false,
    code: 'APPROVAL_REQUIRED',
    approval_id: held.approvalId,
    message: `Nothing sent yet: the message to ${peerName}'s agent ${agentMessageWaits(claims)} It sends once they approve it, and the answer comes back on its own. Do not call ask_agent again for it. ${agentMessageSay(claims)}`,
  }
}

/** Where a held message to another person's agent waits, by where the turn is (a text's and a Slack DM's approvals follow the reply there). */
function agentMessageWaits(claims: ChatRunTokenClaims): string {
  if (claims.server === 'home_turn') return "waits for the person's yes as a card in their home thread, and they are pinged."
  if (isTextTurn(claims)) return "waits for the person's yes: right after your reply they get a text with a code to approve it by replying, or they can approve it in Native Intelligence."
  if (claims.server === 'channel_turn' && claims.surface === 'slack') return "waits for the person's yes: right after your reply it is posted in this DM with Approve and Decline buttons."
  return "waits for the person's yes, as a card right under your message."
}

/** What the model tells the person about a held message to another person's agent. */
function agentMessageSay(claims: ChatRunTokenClaims): string {
  if (claims.server === 'home_turn') return 'Say in one line that it is waiting for their OK.'
  if (claims.server === 'channel_turn') return "Tell them in your reply that it needs their OK first. Don't write a code yourself."
  return 'Tell them in one line it is waiting just below.'
}

/**
 * A chat-native call through the reviewer (A5, src/lib/safety/action-review.ts):
 * the relay and the helper tools are reviewed too (they act for the person)
 * and, enforced, are refused rather than carded.
 */
function chatGate<T>(
  supabase: ReturnType<typeof getServiceClient>,
  claims: ChatRunTokenClaims,
  toolName: string,
  input: unknown,
  scope: ToolCallScope,
  run: () => Promise<T>,
): Promise<{ held: false; value: T } | { held: true; output: HeldCallOutput }> {
  return dispatchGate(chatDispatchContext(supabase, claims), toolName, input, scope, run)
}

/**
 * The person's own words behind a local-agent start or message, from a turn
 * they typed (never a server, relayed, surface or teammate turn's): the chat
 * agent's forwarded words, the newest 3, each capped. WS-C stores them on the
 * job at start or join, and they are the Mac body's reviewer evidence there
 * (docs/plans/teammate-agent.md C1), never found by timestamp.
 */
function personWordsOf(claims: ChatRunTokenClaims, body: { personMessages?: unknown }): { personWords?: string[] } {
  if (claims.server || claims.relay || claims.surface || claims.teammateId) return {}
  const words = Array.isArray(body.personMessages)
    ? body.personMessages.filter((m): m is string => typeof m === 'string' && !!m.trim()).slice(-3).map((m) => m.slice(0, 2000))
    : []
  return words.length ? { personWords: words } : {}
}

/**
 * A website change the owner texted for (roadmap track E): the person's own
 * text (never a guest's, a relay or a teammate's), and one of the tools that
 * only prepare a pull request on their connected site.
 */
function websiteMayPrepareByText(claims: ChatRunTokenClaims, toolName: string | undefined): boolean {
  return !!toolName && WEBSITE_PREPARE_TOOLS.has(toolName) && isPersonTextTurn(claims)
}

/** A turn the person texted to the Native Intelligence number (a channel turn on SMS): a caller ID can be spoofed (TEXT_TURN_HOLD). */
function isTextTurn(claims: ChatRunTokenClaims): boolean {
  return claims.server === 'channel_turn' && claims.surface === 'sms'
}

/** The person's own call (never a guest's, a relay or a teammate's): as spoofable as their text. */
function isPersonCallTurn(claims: ChatRunTokenClaims): boolean {
  return claims.server === 'channel_turn' && claims.surface === 'call' && !claims.guestId && !claims.teammateId && !claims.relay
}

/** What the person said on a call to the Native Intelligence number (a channel turn on a call): caller ID again (CALL_TURN_HOLD). */
function isCallTurn(claims: ChatRunTokenClaims): boolean {
  return claims.server === 'channel_turn' && claims.surface === 'call'
}

/** The chat-run token's caller class (caller.ts): the verified claims only. */
function chatCallerClass(claims: ChatRunTokenClaims): CallerClass {
  return callerClassOf({ kind: 'chat_run', claims })
}

/** The Now file's context for createTools (src/lib/now/now-context.ts): set only for the person's own main-chat call. */
function nowContextOption(claims: ChatRunTokenClaims, body: { helper?: unknown }): { nowContext?: NowToolContext } {
  const nowContext = nowContextForChatCall(claims, body)
  return nowContext ? { nowContext } : {}
}

/**
 * What create_flow reads about this turn (#835 S1): the tools that brought
 * untrusted outside text into it so far (turn-outside-reads.ts), keyed like
 * the go-ahead guard. No session or turn id: nothing is known, nothing held.
 */
function chatFlowContext(claims: ChatRunTokenClaims, body: { sessionId?: unknown; turnId?: unknown }): { turnReadOutside: () => string[] } {
  const key = goAheadTurnKey({ userId: claims.userId, sessionId: body.sessionId, turnId: body.turnId })
  return { turnReadOutside: () => turnOutsideReadTools(key) }
}

/**
 * Who is asking, for a canon section edit's provenance label (src/lib/
 * documents/canon-sources.ts), from the caller class: a server-started or
 * relayed turn is unattended. A chat turn belongs to no agent_run, so there is
 * no run whose outside reads could be checked: an unattended chat turn's edit
 * is labelled as resting on outside text (fail closed). It applies either way.
 */
function chatCanonContext(claims: ChatRunTokenClaims): { attended: boolean; outsideReadsRunId: string | null } {
  return { attended: chatCallerClass(claims) !== 'agent_unattended', outsideReadsRunId: null }
}

/** A 403 when the trust authority refuses this caller the call, else null. */
function callerRefusal(claims: ChatRunTokenClaims, toolName: string, options?: DecideOptions): Response | null {
  const caller = chatCallerClass(claims)
  if (callerMayCall(caller, toolName, options)) return null
  return NextResponse.json({ error: callerRefusalMessage(toolName), code: 'CALLER_NOT_ALLOWED', caller }, { status: 403 })
}

/** The per-person card kinds this chat may show (lib/chat/personal-card-kinds.ts). */
function personalCardKinds(
  ceiling: ReadonlySet<string> | null,
  surface: Parameters<typeof isToolExcludedForSurface>[1],
): { personalCardKinds?: PersonalCardKind[] } {
  const kinds = personalCardKindsFor(ceiling, surface)
  return kinds.length ? { personalCardKinds: kinds } : {}
}

/** The turn's cards for createTools, checked; nothing when the call carried none. */
function cardsOption(value: unknown): { cards?: ReturnType<typeof parseCardContext> } {
  const cards = parseCardContext(value)
  return cards.length ? { cards } : {}
}

function validBrowserSourceRequest(value: unknown): string | undefined {
  const parsed = browserSourceRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
