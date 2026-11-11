/**
 * The reviewer's gate (always-on-agent §6, decisions 7 and 14; A5 slice 2).
 *
 * Before a RISKY tool runs, Jev's action.review
 * (src/lib/ai/decisions/tasks/action-review.ts) is asked whether the person
 * asked for this call, with this target. Risky means:
 *   - the registry classes external-write, delete and automation-write;
 *   - an external mcp__* tool (no class: treated as unclassified);
 *   - any other name with no class (unclassified, so a new tool that ships
 *     without one is reviewed, never waved through).
 * read and internal-write never reach Jev.
 *
 * The doors (each runs the gate after its own auth, ceiling and input checks,
 * immediately before execute):
 *   - the chat tool route (/api/internal/chat/tool): main chat, teammate
 *     chats, the device ask, and the chat-native relay and helper tools
 *     (refused, never carded, when blocked); the person's words are
 *     forwarded by the chat agent with a monotonic personMessageSeq and how
 *     many of them are from earlier turns (a relayed or server-started turn
 *     never counts as the person's words);
 *   - the skill-run route (/api/internal/skill-run/tool): unattended loops,
 *     reviewed against the loop's saved instructions; a loop's follow-up chat
 *     turn as a chat, against the person's forwarded words.
 * The Native Intelligence MCP server has no door: its only callers are the person's own
 * OAuth clients (Claude Code, Cowork), and the person is driving them.
 * Work runs and the live agent cannot reach a risky tool at all (their
 * ceilings admit read and internal-write / staging tools only), which their
 * own tests pin.
 *
 * WHERE IT BLOCKS is ACTION_REVIEW_MODE's call (review-mode.ts; L5,
 * docs/plans/teammate-agent.md, 2026-10-21):
 *   unset     'default': blocking for the Native Intelligence agent on the person's Mac
 *             only (every call it makes carries `mustEnforce`, or names its
 *             job in approval.context.localAgent; a job a loop started
 *             included). Everything that runs today stays shadow, as on PROD:
 *             the person's own turns, relays, server turns, and loops and
 *             skill runs that don't use the Mac. The live eval held 8 to 9 of
 *             14 asked-for calls and scored a loop keeping to its saved
 *             instructions at 0.22;
 *   blocking  every caller;
 *   shadow    no caller (the kill switch);
 *   other     blocking.
 * Blocking, an allow (P ≥ 0.9) runs the call; anything else (a no, an
 * uncertain answer, Jev down or slow, no words to check against, an unknown
 * tool) never runs it: it is held for the person as an approval card
 * (src/lib/safety/approvals.ts), whose words say why, and the model reads
 * APPROVAL_REQUIRED; a chat-native tool the server can't replay is refused
 * NEEDS_PERSON instead. A review that couldn't run is a hold, never a run.
 *
 * SHADOW (a person's own turn under the default, anyone's under the kill
 * switch): the review (with any instruction read) runs AFTER the response, so
 * it adds no latency; its answer lands in ai_usage_logs (decision.action.review,
 * decision_mode 'shadow'), the card it WOULD raise is logged, and the call
 * runs. Loops don't start Mac jobs while the switch says shadow
 * (src/lib/local-agent/unattended.ts).
 *
 * THE OUTWARD GATE (outward-gate.ts) runs inside gateRiskyCall at all three
 * doors BEFORE either mode, and does not depend on Jev: a calendar invite to
 * anyone outside the workspace, or a connected app's tool that is not
 * read-only (unless the person made it approval-free), is held as a card
 * for the person (in the app or remote) and refused NEEDS_PERSON for every
 * other caller class (caller.ts, the one trust authority).
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import { reviewArguments, reviewPersonMessages } from '@/lib/ai/decisions/tasks/action-review'
import { getToolSideEffect, type ToolSideEffect } from '@/lib/ai/tool-registry'
import { createToolApproval, type ApprovalContext, type ApprovalDoor, type ApprovalSideEffect } from './approvals'
import { macJobAgentName, macJobPlace, type LocalAgentApprovalContext } from './mac-job'
import { offerBookingOutwardHold, outwardHoldOf, type ExternalToolPolicy, type OutwardHold } from './outward-gate'
import type { TimeOfferApprovalContext } from './approved-call'
import { BOOK_QUOTE_TOOL, SEND_QUOTE_TOOL } from '@/lib/customers/quote-reply-input'
import { NUDGE_TIME_OFFER_TOOL, OFFER_BOOKING_TOOLS, offerTimesSends, OFFER_TIMES_TOOL } from '@/lib/time-offers/input'

import { isReadShapedExternalName } from '@/lib/mcp/read-names'
import type { AlwaysAllowOffer } from '@/lib/mcp-client/always-allow'
import { decideAction, type CallerClass } from './caller'
import { actionReviewMode, reviewerBlocks, type ReviewedCaller } from './review-mode'
import { bareToolName } from '@/lib/mcp/tool-names'

/**
 * The tools whose text-turn hold is the outward gate's own card (see
 * gateRiskyCall). They run only as the replay of that card
 * (src/lib/customers/quote-reply.ts), so a call the gate makes no card for (no
 * price, a plain member, rows it couldn't read) goes on to the tool, which
 * refuses it and says why: never a generic card that could never run.
 */
const QUOTE_REPLY_TOOLS: ReadonlySet<string> = new Set([SEND_QUOTE_TOOL, BOOK_QUOTE_TOOL])
/** And offer_times or nudge_time_offer by email or text (src/lib/time-offers/send.ts): each sends only as the replay of its own card. */
const isQuoteReply = (toolName: string, input?: unknown) => QUOTE_REPLY_TOOLS.has(bareToolName(toolName)) || offerTimesSends(bareToolName(toolName), input)

/**
 * Calls the reviewer never sees and no door holds, whose registry class says
 * more than they do (availability phase 3a, src/lib/time-offers/):
 * offer_times by link makes the offer and holds the person's own time, and
 * hands the link back to them; nudge_time_offer by link hands the person
 * each guest's reminder. Nothing leaves Native Intelligence (by email or
 * text each is the outward gate's card).
 *
 * The agent's bookings from an offer's own times (OFFER_BOOKING_TOOLS:
 * accept_time_offer, record_time_offer_answer, book_poll_time) are not
 * here: the calendar emails the offer's guests, so each runs on its own only
 * when the person saw who the offer went to, which takes a read
 * (gateRiskyCall, src/lib/time-offers/agent-booking.ts).
 */
function preApprovedCall(name: string, input: unknown): boolean {
  return (name === OFFER_TIMES_TOOL || name === NUDGE_TIME_OFFER_TOOL) && input !== undefined && !offerTimesSends(name, input)
}

// The mode (ACTION_REVIEW_MODE) lives in ./review-mode, which has only a type
// import, so a caller that only needs the mode (src/lib/local-agent/
// unattended.ts) doesn't load the tool registry through ./approvals.
export { ACTION_REVIEW_MODE_ENV, actionReviewMode, reviewerBlocks, type ActionReviewMode, type ReviewedCaller } from './review-mode'

/** What the reviewer judges: every held class but an internal write (only a door's own ask holds one). */
export type RiskClass = Exclude<ApprovalSideEffect, 'internal-write'>

/**
 * Names the gate never reviews although they carry no registry class:
 * search_tools (read-only discovery) and mcp_confirm_call (it only raises an
 * approval card now: it is the approval).
 *
 * And the outreach launches (roadmap D1/D2), whose registry class is
 * external-write: launch_sequence and launch_campaign send nothing on a call.
 * Each raises its OWN card, showing the emails and every recipient, and sends
 * only on the replay of that card's yes (approvedCall.outreach,
 * src/lib/sequences/launch-card.ts). Held here as well, a text turn would get
 * the generic card first ({sequence_id} and nothing else), and its yes would
 * only raise the real one: two codes for one launch.
 */
const UNREVIEWED: ReadonlySet<string> = new Set(['search_tools', 'mcp_confirm_call', 'launch_sequence', 'launch_campaign'])

/**
 * Registry internal-writes that also write OUTSIDE Native Intelligence, so the reviewer
 * treats them as external-write: create_contact and update_crm_contact (a
 * HubSpot writeback when the CRM is connected) and revise_email_draft (it
 * rewrites the draft in the person's mailbox). Their registry class stays
 * internal-write on purpose: the work-run ceiling admits only read and
 * internal-write, and work runs keep these tools (unattended, create_contact
 * skips the writeback). The reviewer's class is the only one widened.
 */
export const REVIEWED_AS_EXTERNAL: ReadonlySet<string> = new Set(['create_contact', 'update_crm_contact', 'revise_email_draft'])

const RISKY: ReadonlySet<ToolSideEffect> = new Set<ToolSideEffect>(['external-write', 'delete', 'automation-write'])

/**
 * A call whose input makes it more than its registry class: settle_work_item
 * (internal-write) dismissing a Mail draft item (`draft:<id>`) discards that
 * draft from the person's mailbox and Native Intelligence, as discard_email_draft (a
 * delete) does (GEN-1165), so the reviewer reads that call as a delete.
 */
function callRiskClass(name: string, input: unknown): RiskClass | null {
  if (name !== 'settle_work_item' || !input || typeof input !== 'object') return null
  const { item_id: itemId, action } = input as { item_id?: unknown; action?: unknown }
  return action === 'dismiss' && typeof itemId === 'string' && itemId.trim().startsWith('draft:') ? 'delete' : null
}

/**
 * A tool's risk class for the reviewer (from the registry, widened by
 * callRiskClass when the call's `input` is given), or null when it is not
 * reviewed.
 */
export function riskClassOf(toolName: string, input?: unknown): RiskClass | null {
  if (UNREVIEWED.has(bareToolName(toolName))) return null
  if (preApprovedCall(bareToolName(toolName), input)) return null
  const byCall = callRiskClass(bareToolName(toolName), input)
  if (byCall) return byCall
  if (REVIEWED_AS_EXTERNAL.has(bareToolName(toolName))) return 'external-write'
  const cls = getToolSideEffect(toolName)
  if (cls) return RISKY.has(cls) ? (cls as RiskClass) : null
  // An external MCP tool, or a name nobody classified: reviewed, and in
  // enforce it fails closed (no allow, a card).
  return 'unclassified'
}

/** The words a call is checked against, or a loader for them (read only when a review runs). */
export type ReviewWords = readonly unknown[] | (() => Promise<readonly unknown[]>)

export interface ReviewRequest {
  door: ApprovalDoor
  userId: string
  workspaceId: string
  toolName: string
  input: unknown
  sideEffect: RiskClass
  /**
   * The person's latest messages, or a loop's saved instructions (source
   * 'loop_instructions'). A loader is read inside the review: in shadow that
   * is after the response, so the read adds no latency to the call.
   */
  personMessages: ReviewWords
  source: 'person' | 'loop_instructions'
  personMessageSeq?: number | null
  /** How many of the oldest personMessages are from earlier turns (stale words). */
  personMessagesStale?: number
  toolsThisTurn?: readonly string[]
  surface?: string
  /** For the usage row (ai_usage_logs run_id): the conversation or the loop's run. */
  runId?: string
  /**
   * C1: the call comes from the Native Intelligence agent on the person's Mac, for this job
   * (gateRiskyCall takes it from approval.context.localAgent). Its card names the
   * Mac and the job instead of "this conversation".
   */
  localAgent?: LocalAgentApprovalContext
}

export interface ReviewOutcome {
  verdict: 'allow' | 'block'
  /** Why: 'asked' | 'not_asked' | 'no_request' | an escalate reason ('uncertain', 'unavailable', …). */
  reason: string
  probability?: number
  inferenceId?: string
  mode: 'shadow' | 'enforce'
  /** The approval card a block raises (or, in shadow, would). */
  card: { title: string; why: string } | null
}

const VERB: Record<ApprovalSideEffect, string> = {
  'external-write': 'changes something outside Native Intelligence',
  'internal-write': 'changes something in Native Intelligence',
  delete: 'deletes something',
  'automation-write': 'changes an automation',
  unclassified: 'runs an outside tool',
}

/**
 * The block reasons where the review never judged the call: Jev answered
 * nothing usable (runDecision's escalations other than 'uncertain', or a
 * throw). Everything else is a judgement: 'not_asked', 'uncertain' (Jev
 * answered, below the bar) or 'no_request' (no words to check against).
 */
export function reviewCouldNotRun(reason: string): boolean {
  return reason !== 'not_asked' && reason !== 'uncertain' && reason !== 'no_request' && reason !== 'asked'
}

/**
 * The approval card's words, templated from the decision (Jev picks; it
 * doesn't explain). They say what the card shows: the tool, run once, with
 * exactly the inputs listed on it, and why it is asking (the block's reason;
 * absent: "not asked").
 */
export function approvalCardCopy(
  request: Pick<ReviewRequest, 'toolName' | 'source' | 'localAgent'> & { sideEffect: ApprovalSideEffect },
  reason: string = 'not_asked',
  /** The door's own words for why it asks, over the reason's (a text turn's alwaysHold: they did ask, by text). */
  told?: string,
): { title: string; why: string } {
  const loop = request.source === 'loop_instructions'
  if (request.localAgent) return macCardCopy(request, request.localAgent, reason, loop)
  const because = told ?? (reviewCouldNotRun(reason)
    ? "Native Intelligence's safety check couldn't run just now, so it asks you first"
    : reason === 'no_request'
      ? loop
        ? 'the loop has no saved instructions to check it against'
        : "it didn't come from a message you typed"
      : reason === 'uncertain'
        ? loop
          ? "Native Intelligence couldn't tell whether the loop's instructions ask for that"
          : "Native Intelligence couldn't tell whether you asked for that in this conversation"
        : loop
          ? "the loop's instructions don't ask for that"
          : "you didn't ask for that in this conversation")
  return {
    title: `Approve ${request.toolName}?`,
    why: `This ${VERB[request.sideEffect]} (${request.toolName}), once, with exactly the inputs below; ${because}.`,
  }
}

/**
 * A Mac call's card (C1): it names "Native Intelligence on <Mac>" and the job, and why it
 * asks, against the job's own request (the person's words that started it,
 * or the loop's saved request), never "this conversation".
 */
function macCardCopy(
  request: Pick<ReviewRequest, 'toolName'> & { sideEffect: ApprovalSideEffect },
  mac: LocalAgentApprovalContext,
  reason: string,
  loop: boolean,
): { title: string; why: string } {
  const because = reviewCouldNotRun(reason)
    ? "Native Intelligence's safety check couldn't run just now, so it asks you first"
    : reason === 'no_request'
      ? loop
        ? 'the loop that started the job has no saved request to check it against'
        : 'the job has no request of yours to check it against'
      : reason === 'uncertain'
        ? loop
          ? "Native Intelligence couldn't tell whether the loop's request for the job asks for that"
          : "Native Intelligence couldn't tell whether you asked the job for that"
        : loop
          ? "the loop's request for the job doesn't ask for that"
          : "you didn't ask the job for that"
  const agent = macJobAgentName(mac)
  return {
    title: `Approve ${request.toolName} from ${agent}?`,
    why: `${agent} wants this for ${macJobPlace(mac)}: it ${VERB[request.sideEffect]} (${request.toolName}), once, with exactly the inputs below; ${because}.`,
  }
}

/**
 * What the model reads when a chat-native call (holdAs 'refusal') is held:
 * nothing ran, and why. An unattended caller has nobody to ask in chat: it
 * is told not to retry and to say what it would have done.
 */
export function refusalMessage(toolName: string, reason: string, caller?: CallerClass): string {
  if (caller === 'agent_unattended') {
    return reviewCouldNotRun(reason)
      ? `Nothing ran. Native Intelligence's safety check couldn't confirm ${toolName} was asked for: it couldn't run just now. Don't retry; say in your report what you would have done.`
      : `Nothing ran. Nobody asked for ${toolName} in their own words. Don't retry; say in your report what you would have done.`
  }
  return reviewCouldNotRun(reason)
    ? `Nothing ran. Native Intelligence's safety check couldn't confirm the person asked for ${toolName}: it couldn't run just now. Tell them in one line; if they still want it, they can ask again in a moment.`
    : `Nothing ran. The person hasn't asked for ${toolName} in their own words. Ask them in chat; once they say so, call it again.`
}

async function wordsOf(words: ReviewWords): Promise<readonly unknown[]> {
  try {
    return typeof words === 'function' ? await words() : words
  } catch {
    return []
  }
}

/**
 * Ask action.review about one risky call. Never throws: any failure is a
 * block (with its reason), which shadow only logs.
 */
export async function reviewRiskyCall(
  request: ReviewRequest & ReviewedCaller,
  enforce: boolean = reviewerBlocks(actionReviewMode(), { caller: request.caller, mustEnforce: request.mustEnforce === true || !!request.localAgent }),
): Promise<ReviewOutcome> {
  const mode = enforce ? 'enforce' : 'shadow'
  const raw = await wordsOf(request.personMessages)
  const personMessages = reviewPersonMessages(raw)
  // reviewPersonMessages keeps the last 3; the stale ones are the oldest, so
  // the count is what is left of them once the dropped head is gone.
  const dropped = Math.max(0, raw.filter((m) => typeof m === 'string' && m.trim()).length - personMessages.length)
  const staleCount = request.personMessagesStale === undefined
    ? undefined
    : Math.max(0, Math.min(personMessages.length, request.personMessagesStale - dropped))
  const card = (reason: string) => approvalCardCopy(request, reason)
  let outcome: ReviewOutcome
  if (!personMessages.length) {
    // No words to check the call against (a wake turn, a loop with no saved
    // instructions): nothing to ask Jev. A block.
    outcome = { verdict: 'block', reason: 'no_request', mode, card: card('no_request') }
  } else {
    try {
      const result = await runDecision('action.review', {
        // A flow step's call is a loop's (the reviewer's skill_run door).
        door: request.door === 'flow_step' ? 'skill_run' : request.door,
        ...(request.surface ? { surface: request.surface.slice(0, 40) } : {}),
        tool: request.toolName.slice(0, 200),
        sideEffect: request.sideEffect,
        arguments: reviewArguments(request.input),
        source: request.source,
        personMessages,
        ...(staleCount !== undefined ? { staleCount } : {}),
        toolsThisTurn: (request.toolsThisTurn ?? []).slice(-30).map((name) => name.slice(0, 200)),
      }, { userId: request.userId, workspaceId: request.workspaceId, runId: request.runId, mode })
      outcome = result.status === 'accepted'
        ? { verdict: result.value.allow ? 'allow' : 'block', reason: result.value.allow ? 'asked' : 'not_asked',
            probability: result.value.probability, inferenceId: result.inferenceId, mode, card: result.value.allow ? null : card('not_asked') }
        : { verdict: 'block', reason: result.reason, ...(result.inferenceId ? { inferenceId: result.inferenceId } : {}), mode, card: card(result.reason) }
    } catch {
      outcome = { verdict: 'block', reason: 'unavailable', mode, card: card('unavailable') }
    }
  }
  if (outcome.verdict === 'block') {
    // The card it raises (or, in shadow, would). Ids and the class only, never arguments or words.
    console.info(`[action-review] ${enforce ? 'blocked: holding the call' : 'shadow: would raise an approval card'}`, JSON.stringify({
      door: request.door, tool: request.toolName, side_effect: request.sideEffect, reason: outcome.reason,
      probability: outcome.probability ?? null, inference_id: outcome.inferenceId ?? null,
      person_message_seq: request.personMessageSeq ?? null, stale_words: staleCount ?? null, card_title: outcome.card?.title ?? null,
    }))
  }
  return outcome
}

/** A home turn's card: why the agent's own call waits (it acted on its own; sends need their yes). */
export const HOME_TURN_CARD_WHY = 'Native Intelligence did this work on its own, and anything that leaves Native Intelligence waits for your yes'

/** A home turn's calendar writes that run when nobody else is on the event (outward-gate.ts holds any other attendee first). */
const HOME_TURN_OWN_CALENDAR_TOOLS: ReadonlySet<string> = new Set(['create_calendar_event', 'update_calendar_event'])

/**
 * True when a home turn's risky call, which the outward gate let through,
 * runs without the person's card: it never leaves Native Intelligence or reaches nobody
 * but them. A delete of Native Intelligence's own items; a connected app's tool the
 * approval policy frees AND whose name reads as a plain read (a tool the
 * person freed to write still waits: nothing is sent without their yes), or
 * one its server can't make a write (`pinnedRead`: the GitHub integration's
 * tools on GitHub's read-only server, pull_request_read included); the
 * person's own calendar with no one else on it. Everything else (a post, a
 * push to Jira, a sequence enrollment, an automation) is held.
 */
export function homeTurnRunsOnItsOwn(request: Pick<GateRequest, 'toolName' | 'sideEffect' | 'externalTool'>): boolean {
  if (request.sideEffect === 'delete') return true
  if (request.toolName.startsWith('mcp__')) {
    const policy = request.externalTool
    if (!policy || policy.requiresApproval) return false
    return policy.pinnedRead === true || isReadShapedExternalName(policy.toolName ?? request.toolName.split('__').pop() ?? '')
  }
  return HOME_TURN_OWN_CALENDAR_TOOLS.has(bareToolName(request.toolName))
}

/** What the model reads when an enforced review held (or refused) its call. */
export interface HeldCallOutput {
  success: false
  /** NOT_HELD: a hold that could not be prepared (a time offer whose times are no longer free): no card, nothing ran. */
  code: 'APPROVAL_REQUIRED' | 'NEEDS_PERSON' | 'NOT_HELD'
  approval_id: string | null
  message: string
}

/** Run work after the response (Next's `after`, a platform waitUntil); default: fire and forget. */
export type Defer = (task: () => Promise<void>) => void
const fireAndForget: Defer = (task) => { void task().catch(() => {}) }

export interface GateRequest extends Omit<ReviewRequest, 'sideEffect'> {
  /** The tool's class for the reviewer (riskClassOf, or the door's own classifier). */
  sideEffect: RiskClass | null
  /**
   * In shadow, where the review runs: after the response (the route passes
   * Next's `after`), so shadow adds no latency to the call.
   */
  defer?: Defer
  /**
   * What an enforced block becomes: 'approval' (default) holds the call as
   * an approval card the server runs on accept; 'refusal' (a chat-native
   * tool the server cannot replay later: the relay, start_helper,
   * stop_helper) refuses it and the model asks the person in chat instead.
   */
  holdAs?: 'approval' | 'refusal'
  /**
   * Who is calling, from the door's verified principal (caller.ts
   * callerClassOf, never anything model-visible). Decides what the outward
   * gate's hold becomes (decideAction(caller, 'outward', tool)): the
   * person's card for the person, in the app or remote; a NEEDS_PERSON
   * refusal for an unattended run, a relayed or server turn, another person
   * or an unknown caller. Absent: unknown (fail closed, refused).
   */
  caller?: CallerClass
  /** The adapter's meta for an external mcp__ tool (the outward gate's approval policy). Absent: held. */
  externalTool?: ExternalToolPolicy | null
  /**
   * F4: the call is a flow step's (the run token's verified flowStep claim):
   * an unattended outward hold becomes the owner's card, not NEEDS_PERSON
   * (caller.ts decideAction). Absent everywhere else.
   */
  flowStep?: boolean
  /**
   * The call is a home turn's (a background update in the person's home
   * thread), from the verified chat-run token (`server === 'home_turn'`),
   * never anything model-visible. The agent works on its own there: internal
   * writes and deletes run, but anything that leaves Native Intelligence (an outward hold,
   * an external write, an automation write, an outside app's tool) is held as
   * the person's approval card in the home thread, whatever the reviewer's
   * mode, and the person is pinged on Slack or by text (Liam, 2026-10-26).
   */
  homeTurn?: true
  /**
   * Blocking under the default mode whoever the caller is: every call from
   * the Native Intelligence agent on the person's Mac (C1) carries it, a person-started job
   * included, since the Mac body reads files and output the server never
   * sees. Only the kill switch (ACTION_REVIEW_MODE=shadow) logs it instead.
   * Set from what the door verified, never from anything model-visible.
   */
  mustEnforce?: true
  /**
   * Hold EVERY risky call (any class riskClassOf gives: external-write,
   * delete, automation-write, unclassified/mcp__) as the person's approval
   * card, before any review and whatever the reviewer's mode (the kill switch
   * included: this is not the reviewer's judgement): a text turn
   * (docs/plans/text-and-calling.md), whose sender is only a caller ID that
   * can be spoofed. Internal writes (the person's own items) still run.
   * `message` is what the model reads once the card is made; `cardWhy`, the
   * card's reason it waits (the person did ask, by text). A quote reply
   * (send_quote, book_quote) gets the outward gate's own card instead, its
   * check kept on the approval, since it runs only as that card's replay.
   */
  alwaysHold?: { reason: string; message: string; cardWhy?: string }
  /** For the approval an enforced block raises. */
  approval: {
    supabase: SupabaseClient
    conversationId?: string | null
    skillId?: string | null
    workItemId?: string | null
    /** F4: a flow step's run (its per-run cap of 5). */
    flowRunId?: string | null
    context?: ApprovalContext
  }
}

/**
 * Run a tool call through the reviewer. Not risky: `run()` as is.
 *   first, in both modes, the outward gate (outward-gate.ts): an invite to
 *             someone outside the workspace or a connected app's write tool
 *             is held as the person's card or refused NEEDS_PERSON, as the
 *             trust authority decides for the caller (caller.ts
 *             decideAction), and never runs from here;
 *   shadow  — the call runs at once and the review (with any instruction
 *             read) is deferred past the response: NO added latency. Nothing
 *             is ever held.
 *   enforce — the review first: an allow runs the call; a block holds it as
 *             an approval (or refuses it, `holdAs: 'refusal'`) and returns
 *             HeldCallOutput instead of running.
 * `enforce` defaults to ACTION_REVIEW_MODE for this caller (reviewerBlocks:
 * the caller class and `mustEnforce`); the parameter is the seam the tests
 * drive.
 */
export async function gateRiskyCall<T>(
  request: GateRequest,
  run: () => Promise<T>,
  enforceParam?: boolean,
): Promise<{ held: false; value: T } | { held: true; output: HeldCallOutput }> {
  if (!request.sideEffect) return { held: false, value: await run() }
  const localAgent = request.localAgent ?? request.approval.context?.localAgent
  // A call whose approval names a job on the Mac is the Mac body's, whatever
  // the door forgot to say: it is reviewed as one (S6).
  const macCall = request.mustEnforce === true || !!localAgent
  const mode = actionReviewMode()
  const byMode = reviewerBlocks(mode, { caller: request.caller, mustEnforce: macCall })
  // The test seam may turn the reviewer on, never off for a Mac call: only the kill switch does (N1).
  const enforce = enforceParam === undefined ? byMode : enforceParam || (macCall && mode !== 'shadow')
  const review = { ...request, sideEffect: request.sideEffect, ...(localAgent ? { localAgent } : {}) }
  // An agent booking from an offer's own times: pre-approved when the person
  // saw who the offer went to (its card, or their own turn made it), never
  // reviewed; else the card naming its guests (or NEEDS_PERSON), before
  // anything else and whatever the mode, a text turn and a home turn alike.
  if (OFFER_BOOKING_TOOLS.has(bareToolName(request.toolName))) {
    const hold = await offerBookingOutwardHold({ userId: request.userId, workspaceId: request.workspaceId, toolName: request.toolName, input: request.input })
    if (!hold) return { held: false, value: await run() }
    return { held: true, output: await holdOutward(review, hold) }
  }
  // A text turn: nothing risky runs on a text alone, whatever the mode. The
  // hold is the person's card only when the person is the caller (a text from
  // their verified phone is person_remote, caller.ts), or a guest the person
  // added (the card is the owner's: only they approve it); anyone else is refused.
  if (request.alwaysHold) {
    ;(request.defer ?? fireAndForget)(async () => { await reviewRiskyCall(review, false).catch(() => null) })
    const caller = request.caller ?? 'unknown'
    if (request.holdAs === 'refusal' || (caller !== 'person' && caller !== 'person_remote' && caller !== 'guest')) {
      return { held: true, output: { success: false, code: 'NEEDS_PERSON', approval_id: null, message: `Nothing ran. ${request.toolName} needs the person in the Native Intelligence app.` } }
    }
    const always = request.alwaysHold
    // A quote reply (send_quote, book_quote) runs only as the replay of its
    // own card, so by text too it is held with the outward gate's card (the
    // exact text and who gets it) and that card's check rides on the
    // approval. Every other hold keeps the text turn's own card.
    const quoteReply = isQuoteReply(request.toolName, request.input)
    const outwardText = quoteReply
      ? await outwardHoldOf({
          userId: request.userId,
          workspaceId: request.workspaceId,
          toolName: request.toolName,
          input: request.input,
          externalTool: request.externalTool,
        })
      : null
    if (outwardText) {
      return {
        held: true,
        output: await withPreparedHold(review, outwardText, (held) => holdForPerson(held, { reason: always.reason, decisionId: null, card: outwardText.card }, { heldMessage: always.message })),
      }
    }
    // No card for a quote reply: the tool refuses it (it runs only as a card's replay), and the model reads why.
    if (quoteReply) return { held: false, value: await run() }
    return { held: true, output: await holdForPerson(review, { reason: always.reason, decisionId: null, card: approvalCardCopy(review, always.reason, always.cardWhy) }, { heldMessage: always.message }) }
  }
  // A home turn (the agent working on its own): nothing that leaves Native Intelligence
  // runs on its word. The outward gate's hold (an invite or change that
  // reaches anyone but the person, a connected app's write) is its own card;
  // else every risky call is the person's card, unless it never leaves Native Intelligence
  // or reaches nobody else (homeTurnRunsOnItsOwn): a delete of Native Intelligence's own
  // items (Liam, 2026-10-26: let those run), a plain read of a connected app,
  // or the person's own calendar with nobody else on it. Before any review,
  // whatever the mode.
  if (request.homeTurn === true && request.holdAs !== 'refusal') {
    const outwardHome = await outwardHoldOf({
      userId: request.userId,
      workspaceId: request.workspaceId,
      toolName: request.toolName,
      input: request.input,
      externalTool: request.externalTool,
    })
    if (outwardHome || (!homeTurnRunsOnItsOwn(request) && !isQuoteReply(request.toolName, request.input))) {
      ;(request.defer ?? fireAndForget)(async () => { await reviewRiskyCall(review, false).catch(() => null) })
      if (outwardHome) return { held: true, output: await holdOutward(review, outwardHome) }
      return { held: true, output: await holdForPerson(review, { reason: 'home_turn', decisionId: null, card: approvalCardCopy(review, 'home_turn', HOME_TURN_CARD_WHY) }) }
    }
  }
  // The outward gate (outward-gate.ts), whatever the reviewer's mode: an
  // invite to anyone but the person, or a connected app's write tool, never
  // runs on the model's word alone.
  const outward = await outwardHoldOf({
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: request.toolName,
    input: request.input,
    externalTool: request.externalTool,
  })
  if (outward) {
    // The reviewer still records what it would have said about the held call
    // (after the response, shadow mode), so its falseAllow metrics see it.
    ;(request.defer ?? fireAndForget)(async () => { await reviewRiskyCall(review, false).catch(() => null) })
    return { held: true, output: await holdOutward(review, outward) }
  }
  // A quote reply the gate made no card for: the tool refuses it, whatever the reviewer would say.
  if (!enforce || isQuoteReply(request.toolName, request.input)) {
    ;(request.defer ?? fireAndForget)(async () => { await reviewRiskyCall(review, false).catch(() => null) })
    return { held: false, value: await run() }
  }
  const outcome = await reviewRiskyCall(review, true)
  if (outcome.verdict === 'allow') return { held: false, value: await run() }
  if (request.holdAs === 'refusal') {
    return {
      held: true,
      output: { success: false, code: 'NEEDS_PERSON', approval_id: null, message: refusalMessage(request.toolName, outcome.reason, request.caller) },
    }
  }
  return { held: true, output: await holdForPerson(review, { reason: outcome.reason, decisionId: outcome.inferenceId ?? null, card: outcome.card ?? approvalCardCopy(review, outcome.reason) }) }
}

/**
 * A gate (chat-tool-dispatch.ts GateOptions.gate) that holds the call as the
 * person's approval card whatever its class, before any review and whatever
 * the reviewer's mode: a door's own "ask first" over a call the reviewer
 * would let run. Today: a guest's tool the owner set to Needs approval that
 * only changes Native Intelligence (src/lib/guests/guest-tools.ts), stored as
 * `sideEffect`. As with a text turn's alwaysHold, the card is the person's
 * only when the person or their guest is the caller; anyone else is refused.
 */
export function holdEveryCallAs(sideEffect: ApprovalSideEffect, hold: { reason: string; message: string; cardWhy?: string }) {
  return async <T>(request: GateRequest, _run: () => Promise<T>): Promise<{ held: false; value: T } | { held: true; output: HeldCallOutput }> => {
    const caller = request.caller ?? 'unknown'
    if (request.holdAs === 'refusal' || (caller !== 'person' && caller !== 'person_remote' && caller !== 'guest')) {
      return { held: true, output: { success: false, code: 'NEEDS_PERSON', approval_id: null, message: `Nothing ran. ${request.toolName} needs the person in the Native Intelligence app.` } }
    }
    const held = { ...request, sideEffect }
    return { held: true, output: await holdForPerson(held, { reason: hold.reason, decisionId: null, card: approvalCardCopy(held, hold.reason, hold.cardWhy) }, { heldMessage: hold.message }) }
  }
}

/**
 * An outward hold, as the trust authority decides it for the caller
 * (caller.ts decideAction(caller, 'outward', tool)): 'ask' is the person's
 * card; anything else is a NEEDS_PERSON refusal (an unattended run raises no
 * card, it is denied, never left waiting).
 */
async function holdOutward(request: GateRequest & { sideEffect: RiskClass }, hold: OutwardHold): Promise<HeldCallOutput> {
  const caller = request.caller ?? 'unknown'
  const decision = decideAction(caller, 'outward', request.toolName, { flowStep: request.flowStep === true, homeTurn: request.homeTurn === true })
  console.info('[outward-gate] held', JSON.stringify({ door: request.door, tool: request.toolName, reason: hold.reason, caller, decision }))
  if (decision !== 'ask') {
    return { success: false, code: 'NEEDS_PERSON', approval_id: null, message: hold.refusal }
  }
  // A Mac call's card says whose ask it is (C1): Native Intelligence on their Mac, for its job.
  const card = request.localAgent
    ? { title: hold.card.title, why: `${macJobAgentName(request.localAgent)}, for ${macJobPlace(request.localAgent)}: ${hold.card.why}` }
    : hold.card
  return withPreparedHold(request, hold, (held) => holdForPerson(held, { reason: hold.reason, decisionId: null, card }, { alwaysAllow: alwaysAllowOffer(request, hold, caller) }))
}

/**
 * Raise an outward hold's card: the hold's own check rides on the approval,
 * for the replay (an unsubscribe card's method, a quote card's words). A hold
 * with work to do once a card is really raised (a time offer's held times,
 * OutwardHold.prepare) does it first: what it made rides on the approval too,
 * and is undone when no card came of it.
 */
async function withPreparedHold<R extends Omit<GateRequest, 'sideEffect'> & { sideEffect: ApprovalSideEffect }>(
  request: R,
  hold: OutwardHold,
  raise: (held: R) => Promise<HeldCallOutput>,
): Promise<HeldCallOutput> {
  let extra: { timeOffer?: TimeOfferApprovalContext } = {}
  if (hold.prepare) {
    const prepared = await hold.prepare().catch((err: unknown) => ({ ok: false as const, message: `Nothing ran: ${err instanceof Error ? err.message : String(err)}` }))
    if (!prepared.ok) return { success: false, code: 'NOT_HELD', approval_id: null, message: prepared.message }
    extra = prepared.context
  }
  const context = hold.context || hold.prepare ? { ...request.approval.context, ...hold.context, ...extra } : undefined
  const held = context ? { ...request, approval: { ...request.approval, context: context as ApprovalContext } } : request
  const output = await raise(held)
  if (hold.prepare) {
    if (output.approval_id) await hold.held?.(extra, output.approval_id).catch(() => {})
    else await hold.abandon?.(extra).catch(() => {})
  }
  return output
}

/**
 * A connected app's write its own permission held, in the person's own chat
 * (not a Mac job, not an unattended run, not a loop): its card offers Always
 * allow (mcp-client/always-allow.ts), unless the tool always asks. The same
 * offer mcp_confirm_call's card makes (chat-tool-dispatch.ts loadChatExternalTools).
 */
function alwaysAllowOffer(request: GateRequest, hold: OutwardHold, caller: string): AlwaysAllowOffer | undefined {
  const tool = request.externalTool
  if (hold.reason !== 'mcp_write' || request.door !== 'chat' || caller !== 'person' || request.localAgent) return undefined
  if (!tool?.serverId || !tool.toolName || tool.alwaysAsks !== false) return undefined
  return { serverId: tool.serverId, tool: tool.toolName }
}

/** Hold the call as the person's approval card and tell the model what happened. */
async function holdForPerson(
  request: Omit<GateRequest, 'sideEffect'> & { sideEffect: ApprovalSideEffect },
  why: { reason: string; decisionId: string | null; card: { title: string; why: string } },
  /** The card's Always allow offer (alwaysAllowOffer), and the model's message in place of the default. */
  { alwaysAllow, heldMessage }: { alwaysAllow?: AlwaysAllowOffer; heldMessage?: string } = {},
): Promise<HeldCallOutput> {
  const held = await createToolApproval(request.approval.supabase, {
    door: request.door,
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: request.toolName,
    sideEffect: request.sideEffect,
    input: request.input,
    conversationId: request.approval.conversationId ?? null,
    skillId: request.approval.skillId ?? null,
    workItemId: request.approval.workItemId ?? null,
    flowRunId: request.approval.flowRunId ?? null,
    context: request.approval.context,
    decisionId: why.decisionId,
    reason: why.reason,
    personMessageSeq: request.personMessageSeq ?? null,
    card: why.card,
    ...(alwaysAllow ? { alwaysAllow } : {}),
    // A home turn's card shows in the home thread, which the person isn't
    // reading: the turn's written message carries it, and the router takes it
    // to them (src/lib/reach/route.ts).
    ...(request.homeTurn === true ? { reachPerson: true as const } : {}),
  })
  // Nobody is watching an unattended run, and nobody reads a Mac job's turns
  // in a chat: the card waits in the person's home thread, and the work
  // carries on without the call.
  const mac = !!request.localAgent
  const unattended = request.caller === 'agent_unattended' || mac
  return {
    success: false,
    code: 'APPROVAL_REQUIRED',
    approval_id: held.ok ? held.approvalId : null,
    message: held.ok
      ? heldMessage ?? (request.homeTurn === true
        ? `Nothing ran yet: ${request.toolName} reaches outside Native Intelligence, so it waits for the person's yes as a card in their home thread, and they are pinged about it. It runs once they approve it there. Do not call it again; carry on with the rest, and say in one line what is waiting for their OK.`
        : mac
        ? `Nothing ran. ${request.toolName} needs the person's approval: it waits as a card in their Native Intelligence home thread and runs once they approve it there. Do not call it again; carry on without it and say in your report that it is waiting for them.`
        : unattended
        ? `Nothing ran. ${request.toolName} needs the person's approval: it waits as a card in their chat and runs once they approve it there. Do not call it again; carry on without it and say in your report that it is waiting for them.`
        : `Nothing ran. ${request.toolName} needs the person's approval: its card shows in the chat right under your message, and it runs once they approve it there. Tell them in one line it is waiting just below; do not call it again.`)
      : `Nothing ran. ${request.toolName} needs the person's approval, and no approval card was made: ${held.error} ${unattended ? 'Do not call it again; say so in your report.' : 'Tell the person.'}`,
  }
}
