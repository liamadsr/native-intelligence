/**
 * Running one chat tool call, after a door's own auth and ceiling: the part
 * /api/internal/chat/tool (the cloud body) and /api/local-agent/agent/tool
 * (the Mac body, docs/plans/teammate-agent.md C1) share, so both bodies run a
 * tool exactly the same way:
 *
 *   - the person's connected MCP tools, with mcp_confirm_call's approval card
 *     in the conversation, or the home thread (cardConversationId) ({@link loadChatExternalTools});
 *   - the repeat-failure breaker, the same-turn go-ahead guard, the REAL
 *     schema check, the reviewer and the outward gate (A5,
 *     src/lib/safety/action-review.ts), touches, the outside-text mark and
 *     the output's sanitising ({@link runTool});
 *   - the reviewer alone, for the chat-native tools a door runs itself
 *     ({@link chatGate}).
 *
 * What differs per door rides the {@link ToolDispatchContext}: whose call it
 * is (tenancy, conversation, the caller class from the door's verified
 * principal), what an approval records for its accept-time re-check, and the
 * key the per-turn guards are scoped by. Nothing here reads a token.
 */
import { NextResponse, after } from 'next/server'
import type { Tool } from 'ai'
import type { getServiceClient } from '@/lib/admin'
import { recordToolCallTouches } from '@/lib/work/touch'
import { ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { createExternalMcpTools, type ExternalMcpToolsResult, type ServerToolMeta } from '@/lib/mcp-client/adapter'
import type { ExternalToolPolicy } from '@/lib/safety/outward-gate'
import { failureFingerprint, recordCallOutcome, repeatKey, repeatedFailureOutput } from '@/lib/chat/tool-repeat-breaker'
import { goAheadTurnKey, recordGoAheadOutcome, sameTurnGoAheadRefusal } from '@/lib/chat/flow-go-ahead-guard'
import { markTurnReadOutside } from '@/lib/chat/turn-outside-reads'
import { classifyToolRead, knownOrOwnSenders, readOutsideText } from '@/lib/safety/outside-text'
import { gateRiskyCall, riskClassOf, type GateRequest, type HeldCallOutput, type RiskClass } from '@/lib/safety/action-review'
import { createToolApproval, inputHash, type ApprovalContext } from '@/lib/safety/approvals'
import { recentApprovedRun } from '@/lib/safety/approval-results'
import { noteTurnTool, turnTools, turnToolsKey } from '@/lib/safety/turn-tools'
import type { CallerClass } from '@/lib/safety/caller'
import type { ChatRunSurface } from '@/lib/chat/chat-run-token'

type Supabase = ReturnType<typeof getServiceClient>

/**
 * The full workspace tool surface, as a membership Set. Reached when BOTH the
 * edition and the agent impose no limit — every workspace with nothing switched
 * off, since every feature is on for everyone (lib/editions/manifest.ts,
 * invariant 5) — so it must stay fail-closed. It
 * permits EXACTLY the tools that exist in the registry — the same surface
 * pickPermittedTools(null) grants an in-process caller (the whole createTools()
 * map) — never "any string". search_tools (the read-only discovery meta-tool)
 * is always reachable, so it's part of this set. A Set membership test is
 * prototype-pollution-safe (a name like '__proto__' is a plain key, not a
 * lookup against Object.prototype).
 */
export const REGISTRY_TOOLS: ReadonlySet<string> = new Set<string>([...ALL_TOOL_NAMES, 'search_tools'])

/** The chat-native tools: run by the door itself, never replayable from an approval later. */
export const CHAT_NATIVE_REVIEWED: ReadonlySet<string> = new Set([
  'start_helper',
  'stop_helper',
  'send_bot_message',
  // The local agents' mutators: run on the person's Mac, never replayable from a card.
  'start_local_agent',
  'message_local_agent',
  'stop_local_agent',
  // The cloud counterpart: it files an action and starts a coding run; never replayable from a card.
  'start_cloud_coding_run',
])

/**
 * Whose call this is, from the door's VERIFIED principal (never anything the
 * model sends).
 */
export interface ToolDispatchContext {
  supabase: Supabase
  userId: string
  workspaceId: string
  /** The conversation the call is in: the reviewer's run id, and where its approvals land. */
  conversationId: string
  /**
   * Where approval cards land instead, when nobody reads this conversation
   * in a chat (the Mac body's turns): null asks in the person's home thread
   * (approvals.ts asksAtHome). Absent: the conversation.
   */
  cardConversationId?: string | null
  /** A chat-run token's surface (the device ask), for the reviewer's record. */
  surface?: ChatRunSurface
  /** The trust authority's class for this caller (src/lib/safety/caller.ts). */
  caller: CallerClass
  /** What an approval raised here records for its accept-time re-check. */
  approvalContext: ApprovalContext
  /**
   * The principal the per-turn guards (the breaker, the go-ahead guard, the
   * turn's tools, the outside-text mark) are keyed by, beside eve's session
   * and turn ids: the person's user id for the cloud body, a per-session
   * scope for the Mac body, so one body's turns never count as the other's.
   */
  keyScope: string
  /**
   * What a door's own review policy sets on every gate request, over the
   * defaults (a job a loop started on the Mac: the loop's saved request as
   * the evidence, its run, reviewed blocking). Absent: the person's words.
   */
  reviewOverride?: Partial<Omit<GateRequest, 'caller' | 'approval'>>
  /**
   * The Now file's check-in (docs/plans/now-file.md "Who may write the
   * note"): a result that still carries outside text never reaches it (an
   * internal tool's untrusted fence: a document made from a file, a field
   * enrichment read off the web). The call answers CHECK_IN_OUTSIDE_TEXT
   * instead. Its allow-list is internal by name (chat-ceiling.ts
   * checkInMayCall); this is the same one definition's result half
   * (outside-text.ts classifyToolRead).
   */
  withholdOutsideText?: boolean
}

/** What a check-in reads in place of a result that carried outside text. */
export const CHECK_IN_OUTSIDE_TEXT_OUTPUT = {
  success: false,
  code: 'CHECK_IN_OUTSIDE_TEXT',
  error: 'This result carries outside text (mail, the web or a file), which your check-in never reads. Nothing is shown; work from the rest, or leave it for your chat with the person.',
} as const

/** True when a check-in may not see this result: it carries outside text by the one definition, or mail senders to check. Pure. */
export function withheldFromCheckIn(toolName: string, output: unknown): boolean {
  const read = classifyToolRead(toolName, output)
  return read.outside || (read.senders?.length ?? 0) > 0
}

/** The per-turn identity and evidence the agent forwards with a call. Parsed, never trusted. */
export interface ToolCallScope {
  sessionId?: unknown
  turnId?: unknown
  personMessages?: unknown
  personMessageSeq?: unknown
  personMessagesStale?: unknown
}

/** The per-door overrides of how a call is gated. */
export interface GateOptions {
  /** The adapter's approval policy for an external tool (the outward gate), when this call is one. */
  externalTool?: ExternalToolPolicy | null
  /**
   * The tool's class for the reviewer when the door knows better than the
   * registry (a door's own read-only tool that has no registry entry). Absent:
   * riskClassOf, or automation-write for a chat-native tool.
   */
  sideEffect?: RiskClass | null
  /** The gate itself (default gateRiskyCall): a door may hold more than the reviewer would. */
  gate?: typeof gateRiskyCall
  /**
   * What an enforced block becomes for a door's own tool the server can't
   * replay from a card: 'refusal'. Absent: the chat-native tools refuse,
   * everything else is carded.
   */
  holdAs?: 'approval' | 'refusal'
}

/** Where this context's approval cards land (see ToolDispatchContext.cardConversationId). */
function cardConversationOf(ctx: ToolDispatchContext): string | null {
  return ctx.cardConversationId === undefined ? ctx.conversationId : ctx.cardConversationId
}

/** The person-message count the chat agent forwarded, when it is a sane integer. */
export function personMessageSeqOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 31 ? value : null
}

/** The stale-words count the chat agent forwarded (0-3), when sane. */
export function personMessagesStaleOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : undefined
}

/** Shadow work after the response (Next's `after`); outside a request scope it just runs. */
export function deferAfterResponse(task: () => Promise<void>): void {
  try {
    after(task)
  } catch {
    void task().catch(() => {})
  }
}

/** The adapter's approval policy for an external tool (the outward gate), when this call is one. */
export function externalToolPolicy(meta: Map<string, ServerToolMeta>, toolName: string): ExternalToolPolicy | null {
  if (!toolName.startsWith('mcp__')) return null
  const entry = meta.get(toolName)
  return entry
    ? {
        serverName: entry.serverName,
        requiresApproval: entry.requiresApproval,
        serverId: entry.serverId,
        toolName: entry.toolName,
        alwaysAsks: entry.alwaysAsks,
        ...(entry.pinnedRead ? { pinnedRead: true } : {}),
      }
    : null
}

/**
 * The person's external-MCP tools, loaded by the context's user (their names
 * are part of the ceiling union, and they must be dispatchable). mcp_confirm_call
 * holds the call for the person (A5 slice 3): a card in the context's
 * conversation, and the server runs the stored call once they accept it.
 * The same call already approved in that conversation lately raises no
 * second card (GEN-1172): mcp_confirm_call answers with that run's outcome,
 * unless the person asked to run it again.
 */
export function loadChatExternalTools(ctx: ToolDispatchContext, scope: ToolCallScope): Promise<ExternalMcpToolsResult> {
  return createExternalMcpTools(ctx.userId, ctx.supabase, {
    requestApproval: async ({ toolName: gated, serverName, args, serverId, remoteTool, alwaysAsks, runAgain }) => {
      const conversationId = cardConversationOf(ctx)
      const ran = runAgain
        ? null
        : await recentApprovedRun(ctx.supabase, { userId: ctx.userId, workspaceId: ctx.workspaceId, conversationId, tool: gated, inputHash: inputHash(args) })
      if (ran) return { ok: true, approvalId: ran.id, alreadyRan: ran }
      return createToolApproval(ctx.supabase, {
        door: 'chat',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        toolName: gated,
        sideEffect: 'unclassified',
        input: args,
        conversationId,
        context: ctx.approvalContext,
        reason: 'requires_approval',
        personMessageSeq: personMessageSeqOf(scope.personMessageSeq),
        card: {
          title: `Approve ${gated}?`,
          why: `${serverName} asks for your approval before this runs. It runs once, with exactly the inputs below, when you accept.`,
        },
        // Held by the tool's own permission (not the reviewer), in the
        // person's own chat (never a Mac job's, never an unattended run): the
        // card may offer Always allow, unless the tool always asks.
        ...(alwaysAsks || ctx.caller !== 'person' || ctx.approvalContext?.localAgent ? {} : { alwaysAllow: { serverId, tool: remoteTool } }),
      })
    },
  })
}

/**
 * Every chat call through the reviewer (A5, src/lib/safety/action-review.ts),
 * with the person's forwarded words, their seq and how many are stale. The
 * relay and the helper tools are reviewed too (they act for the person) and,
 * enforced, are refused rather than carded. Shadow defers the review past the
 * response (`after`): no added latency.
 */
export function chatGate<T>(
  ctx: ToolDispatchContext,
  toolName: string,
  input: unknown,
  scope: ToolCallScope,
  run: () => Promise<T>,
  options: GateOptions = {},
): Promise<{ held: false; value: T } | { held: true; output: HeldCallOutput }> {
  const native = CHAT_NATIVE_REVIEWED.has(toolName)
  const holdAs = options.holdAs ?? (native ? 'refusal' : undefined)
  const request: GateRequest = {
    door: 'chat',
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    toolName,
    input,
    sideEffect: options.sideEffect !== undefined ? options.sideEffect : (riskClassOf(toolName, input) ?? (native ? 'automation-write' : null)),
    personMessages: Array.isArray(scope.personMessages) ? scope.personMessages : [],
    source: 'person',
    personMessageSeq: personMessageSeqOf(scope.personMessageSeq),
    personMessagesStale: personMessagesStaleOf(scope.personMessagesStale),
    toolsThisTurn: turnTools(turnToolsKey(ctx.keyScope, scope.sessionId, scope.turnId)),
    surface: ctx.surface,
    runId: ctx.conversationId,
    defer: deferAfterResponse,
    ...(holdAs ? { holdAs } : {}),
    // Who is calling (caller.ts), from the verified principal: the outward
    // gate's hold is the person's card for the person (in the app, on the
    // device ask, on their Mac); a relayed turn (the main agent's words in a
    // bot's thread) or a server turn is unattended, so it is refused.
    caller: ctx.caller,
    ...(options.externalTool ? { externalTool: options.externalTool } : {}),
    approval: { supabase: ctx.supabase, conversationId: cardConversationOf(ctx), context: ctx.approvalContext },
  }
  return (options.gate ?? gateRiskyCall)(ctx.reviewOverride ? { ...request, ...ctx.reviewOverride } : request, run)
}

/**
 * Look up the permitted tool in `tools`, validate its input against the REAL
 * schema and run it — for every door, after its ceiling check.
 *
 * Through the repeat-failure breaker (src/lib/chat/tool-repeat-breaker.ts):
 * keyed on the context's key scope, eve's session and turn ids (`scope`, from
 * the body), the tool and its input, a call that already failed the same way 3
 * times in this turn, the last within 90 s, is not run again; it answers REPEATED_FAILURE, as an ordinary output the model
 * reads. Schema refusals, `success: false` outputs and throws count as
 * failures; a success clears the count.
 *
 * And through the same-turn go-ahead guard (src/lib/chat/flow-go-ahead-guard.ts,
 * the same scope): once create_flow / update_flow came
 * back `awaiting_go_ahead` (a fresh summary) in a turn, a loop-tool call in
 * that turn claiming the person's yes is not run; it answers
 * GO_AHEAD_SAME_TURN as an ordinary output.
 *
 * And every output is judged by the one outside-text definition
 * (src/lib/safety/outside-text.ts, mail senders checked against the person's
 * own): one that brought untrusted outside text marks the turn
 * (src/lib/chat/turn-outside-reads.ts), so a loop create_flow is asked for
 * later in it is saved off and asked about in the chat (#835 S1).
 */
export async function runTool(
  ctx: ToolDispatchContext,
  toolName: string,
  rawInput: unknown,
  scope: ToolCallScope,
  tools: Record<string, Tool>,
  options: GateOptions = {},
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

  const breakerKey = repeatKey({ userId: ctx.keyScope, sessionId: scope.sessionId, turnId: scope.turnId }, toolName, rawInput)
  const repeated = repeatedFailureOutput(breakerKey)
  if (repeated) {
    console.warn(`[chat-tool] ${toolName}: identical call refused after repeated failures (REPEATED_FAILURE)`)
    return NextResponse.json({ output: repeated })
  }

  const turnKey = goAheadTurnKey({ userId: ctx.keyScope, sessionId: scope.sessionId, turnId: scope.turnId })
  const sameTurn = sameTurnGoAheadRefusal(turnKey, toolName, rawInput)
  if (sameTurn) {
    console.warn(`[chat-tool] ${toolName}: the person's yes claimed in the turn that asked for it (GO_AHEAD_SAME_TURN)`)
    return NextResponse.json({ output: sameTurn })
  }

  // ── Validate input against the REAL Zod schema, then run (as streamText would) ─
  let parsedInput: unknown = rawInput ?? {}
  const schema = tool.inputSchema as
    | { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }
    | undefined
  if (schema && typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(parsedInput)
    if (!parsed.success) {
      recordCallOutcome(breakerKey, 'code:INPUT_INVALID')
      return NextResponse.json(
        { error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(parsed.error) },
        { status: 400 },
      )
    }
    parsedInput = parsed.data
  }

  try {
    // The reviewer (A5 slice 2), last before execute: a risky call
    // (external-write, delete, automation-write, an unclassified or external
    // tool) is checked against the person's own latest words. In shadow it
    // only records; enforced, a block holds the call as an approval card.
    const turnToolsAt = turnToolsKey(ctx.keyScope, scope.sessionId, scope.turnId)
    const gated = await chatGate(ctx, toolName, parsedInput, scope, () => tool.execute!(parsedInput as never, {
      toolCallId: `chat-tool-${String(ctx.conversationId).slice(0, 8)}`,
      messages: [],
    } as never), options)
    if (gated.held) {
      recordCallOutcome(breakerKey, failureFingerprint(gated.output))
      return NextResponse.json({ output: gated.output })
    }
    const output = gated.value
    noteTurnTool(turnToolsAt, toolName)
    // Sequence step 2: a chat turn is not a work-ledger row (tracked_job has
    // no conversation column), so nothing is recorded here yet; the hook is in
    // place for when a chat surface gets one.
    await recordToolCallTouches(ctx.supabase, {
      workspaceId: ctx.workspaceId,
      workItemId: null,
      toolName,
      input: parsedInput,
      output,
    })
    recordCallOutcome(breakerKey, failureFingerprint(output))
    recordGoAheadOutcome(turnKey, toolName, output)
    // Outside text this turn read (never throws; a failed sender lookup counts).
    if (turnKey) {
      const known = (addresses: string[]) => knownOrOwnSenders(ctx.supabase, { workspaceId: ctx.workspaceId, userId: ctx.userId, addresses })
      if (await readOutsideText(toolName, output, known)) markTurnReadOutside(turnKey, toolName)
    }
    // The check-in's context holds only what the person typed or Dial8 wrote.
    if (ctx.withholdOutsideText && withheldFromCheckIn(toolName, output)) {
      console.warn(`[chat-tool] ${toolName}: a result carrying outside text withheld from a check-in`)
      return NextResponse.json({ output: CHECK_IN_OUTSIDE_TEXT_OUTPUT })
    }
    return NextResponse.json({ output: sanitizeOutput(toolName, output) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordCallOutcome(breakerKey, 'code:TOOL_EXECUTE_FAILED')
    return NextResponse.json({ error: message, code: 'TOOL_EXECUTE_FAILED' }, { status: 500 })
  }
}

/**
 * SIGNED-URL FALLBACK enforcement (resolved decision). get_attachment_content's
 * real execute returns the attachment at full size under internal
 * image-transport keys (__imageBase64/__imageMimeType); those MUST NOT cross
 * the eve boundary. Strip them so the eve model receives the signed URL + text
 * metadata the output already carries, never raw image bytes.
 *
 * read_chat_file's photo is the exception, by design: it is scaled for the
 * model (src/lib/ai/tools/tool-image.ts), and the chat-agent's proxy turns the
 * keys into an image for a model that reads one, or a note for one that can't
 * (agents/chat-agent/lib/chat-image-output.ts). It is how the chat's photos
 * reach the model at all: never as a file part on the message, which makes eve
 * provision a sandbox.
 * A no-op for every other tool and for non-image attachments.
 */
export function sanitizeOutput(toolName: string, output: unknown): unknown {
  if (toolName !== 'get_attachment_content') return output
  if (!output || typeof output !== 'object') return output
  const clean = { ...(output as Record<string, unknown>) }
  delete clean.__imageBase64
  delete clean.__imageMimeType
  return clean
}
