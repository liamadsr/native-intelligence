/**
 * Server-checked approvals (docs/plans/always-on-agent.md §6, A5 slice 3;
 * migration 335).
 *
 * A tool call the server holds until the person says yes on a card. Raised by
 *   - mcp_confirm_call (src/lib/mcp-client/adapter.ts), which never runs what
 *     the model passes: it creates an approval;
 *   - action.review once enforced (src/lib/safety/action-review.ts): a risky
 *     call it blocks. In shadow it only records, so nothing is raised.
 *
 * What the person sees is what runs: the card carries the FULL stored input
 * (an input too large to show is refused, never held), and the stored input's
 * canonical hash is checked again before it runs.
 *
 * On the person's Accept (PATCH /api/account/attention-items, the card's own
 * click, settle-card.ts acceptApprovalCard):
 *   1. pending → approved by compare-and-swap, so it runs at most once;
 *   2. re-checks, now: membership, the kill switch (loop and MCP doors), the
 *      input hash, and the ceiling the door would grant today
 *      (approvalCeilingPermits: the door's ceiling, its surface exclusions,
 *      the run's withheld tools);
 *   3. the STORED call runs once, as the person, through createTools rebuilt
 *      with the door's exact options (strict workspace, no private captures,
 *      unattended, actions filed as suggestions, the run's origin), so an
 *      approved loop or MCP call reaches no more than the run could;
 *   4. the result is stored (status stays 'approved', or 'failed' when a
 *      re-check refused it) and a templated line goes to the home thread,
 *      any quoted result text fenced as untrusted. The agent that raised it
 *      reads the outcome, result and all, at its conversation's next turn
 *      (approval-results.ts, GEN-1172): the run happens outside its turn.
 *      A call the person's own chat turn raised that ran also starts that
 *      turn (approval-turn.ts, migration 445), so the agent carries on.
 * Dismiss denies it. The model can never approve: settle_card,
 * accept_proposal and send_work_answer refuse an approval card, and
 * settleAttentionCard accepts one only from the person's own click. Both
 * approve and deny take an Approver and hold only for the owner's own
 * principal (the one trust authority, caller.ts mayApprove).
 *
 * Where the person sees it (P13; Liam, 2026-10-20: "approvals are questions
 * too"): never For you. Raised in a chat turn the person is in (the chat
 * door with its conversation), the card renders inline right after the
 * agent's message, from the tool result's `approval_id`
 * (src/lib/attention/chat-asks.ts approvalIdOfToolOutput). Raised with nobody
 * there (a loop's step, a skill run's staged write, a card meant for someone
 * else, a device ask), one templated message from the agent lands in the
 * owner's home thread with the card inline (askHomeMessage). Either way it is
 * the same row, the same stored input and hash, and the same person-only
 * click: only the surface moved.
 *
 * Flooding: a pending approval for the same person, tool and input is
 * reused, and a person (or one conversation) can hold only so many pending.
 *
 * Flow steps (F4, door 'flow_step', src/lib/flows/call-tool.ts): a loop's
 * unattended outward step holds its exact call here and its run parks. The
 * run stands in for the conversation (5 pending per run), a pending call is
 * reused only within the same run, and the card's Accept may carry the
 * person's own edit of the inputs (their hand, their words: it runs what they
 * typed, re-checked against the tool's schema). Accept, Skip (dismiss),
 * expiry and the kill switch each tell the parked run (flow-step-resume.ts),
 * which carries on from the step or ends with a note.
 */
import 'server-only'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tool } from 'ai'
import { createTools, type CreateToolsOptions } from '@/lib/ai/tools'
import { ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { createExternalMcpTools, executeExternalMcpCall } from '@/lib/mcp-client/adapter'
import type { AlwaysAllowOffer } from '@/lib/mcp-client/always-allow'
import {
  isToolExcludedForSurface,
  resolveAgentToolCeiling,
  resolveChatCeiling,
  resolveTeammateChatBounds,
  resolveTeammateChatCeiling,
} from '@/lib/chat/chat-ceiling'
import type { ChatRunSurface } from '@/lib/chat/chat-run-token'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { ASK_CARD_PART_TYPE, ASK_MESSAGE_KIND, type AskCardPartData } from '@/lib/attention/chat-asks'
import { guestRef, type GuestAskData } from '@/lib/guests/chat-parts'
import { agentLinkAskData } from '@/lib/agent-links/chat-parts'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { deferLogWrite } from '@/lib/log/agent-log'
import { requestRoute } from '@/lib/reach/route'
import { recordAgentEvents } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'
import type { BotApprovalContext, ConnectionApprovalContext, DocumentApprovalContext, FlowApprovalContext, FlowStepApprovalContext, LoopStepApprovalContext, OutreachApprovalContext, QuoteReplyApprovalContext, SkillRunMcpContext, StudioSpendApprovalContext, TimeOfferApprovalContext, UnsubscribeApprovalContext } from './approved-call'
import { mayApprove, type Approver } from './caller'
import { requestApprovalTurn } from './approval-turn'
import { activeGuestCeiling } from '@/lib/guests/guest-turn'
import { macJobAgentName, macJobPlace, type LocalAgentApprovalContext } from './mac-job'
import type { AgentLinkCardContext } from '@/lib/agent-links/views'
import type { BookingApprovalContext } from '@/lib/customers/booking'
import type { WebsiteApprovalContext } from '@/lib/website/types'
import { mergeAskLine } from '@/lib/website/brief'

export { macJobAgentName, macJobPlace, type LocalAgentApprovalContext } from './mac-job'
import { callToolByServerId, McpTokenExpiredError } from '@/lib/mcp-client'
import { fenceMcpContent } from '@/lib/mcp-client/adapter'
import { notifyFlowStepSettled, type FlowStepOutcome } from '@/lib/flows/flow-step-notify'
import { connectionProblem, loadOwnerConnection, mcpContentText, toolOf } from '@/lib/mcp-client/owner-connection'
import { checkToolInputAtRun } from '@/lib/flows/tool-input-schema'
import { capStepOutput } from '@/lib/flows/redact'
import { bareToolName } from '@/lib/mcp/tool-names'

/**
 * Where a held call came from. tool_approval's CHECK still admits a retired
 * 'mcp' door (historic rows, from the removed desktop runs); code never raises
 * one, and a stored row with any other door fails closed below.
 */
export type ApprovalDoor = 'chat' | 'skill_run' | 'flow_step'
/**
 * The held call's class. 'internal-write' (migration 438) is never the
 * reviewer's: only a door's own "ask first" holds one (a guest's tool the
 * owner set to Needs approval, action-review.ts holdEveryCallAs).
 */
export type ApprovalSideEffect = 'external-write' | 'delete' | 'automation-write' | 'unclassified' | 'internal-write'

/** How long a held call waits for the person. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
/** The largest input an approval holds: the card must be able to show all of it. */
export const APPROVAL_INPUT_MAX_BYTES = 16_000
/**
 * Pending approvals one person can hold at once, and one conversation (a
 * loop run counts as one, F4). Enforced here in app code by a read then an
 * insert, not by the database: holds raised at the same instant can pass the
 * count together and land one or two over. The caps stop floods, not races.
 */
export const APPROVAL_PENDING_MAX_PER_USER = 20
/**
 * Customers' bookings waiting on the owner (roadmap B4): their own cap, apart
 * from the owner's, so a flood of requests from a public booking page never
 * keeps the owner's own agent from holding a call.
 */
export const APPROVAL_PENDING_MAX_BOOKINGS = 10
export const APPROVAL_PENDING_MAX_PER_CONVERSATION = 5
/**
 * Pending approvals one job on the person's Mac can hold at once (C1: its
 * cards land in the home thread, with no conversation of their own to cap).
 */
export const APPROVAL_PENDING_MAX_PER_MAC_JOB = 5
/** The most of a result kept on the row. */
const RESULT_MAX_CHARS = 8_000
/** The most of a result quoted (fenced) in the home thread. */
const HOME_QUOTE_MAX_CHARS = 400

/**
 * The createTools options the door ran the call under, recorded so the
 * approved call runs under the same fence (never wider). JSON-safe.
 */
export interface ApprovalToolOptions {
  strictWorkspace?: boolean
  omitPrivateCaptures?: boolean
  unattended?: boolean
  /** actionRules.fileActionsAsSuggested (an unattended run's actions arrive as suggestions). */
  fileActionsAsSuggested?: boolean
  origin?: { actor?: 'agent' | 'person'; depth?: number; run_id?: string }
  /**
   * CreateToolsOptions.omitGrants: a guest's or a linked agent's call, which
   * reads no grant (492) shared with the owner. A replay of a call held from
   * either (context.guest or context.agentLink) omits grants even with no
   * flag stored (storedToolOptions fails closed).
   */
  omitGrants?: boolean
}

/** What the re-checks need at accept time, recorded when the approval is raised. */
export interface ApprovalContext {
  agentId?: string
  teammateId?: string
  surface?: string
  /** A loop's run mode (skill_run). */
  mode?: 'report' | 'act'
  /** The door's createTools options. */
  tools?: ApprovalToolOptions
  /**
   * A flow card's own check (F1, src/lib/flows/flow-approvals.ts): which loop,
   * what it was when the card was made. The replayed flow tool refuses when
   * the loop changed since.
   */
  flow?: FlowApprovalContext
  /** A connection card's own check (F2: disconnect, a loosened tool access). */
  connection?: ConnectionApprovalContext
  /** An agent card's own check (GEN-1168: delete_bot, merge_bots). */
  bots?: BotApprovalContext
  /** A document delete card's own check (delete_document): which document, at which revision. */
  document?: DocumentApprovalContext
  /** An outreach launch card's own check (launch_sequence, launch_campaign): the copy it showed and who it named. */
  outreach?: OutreachApprovalContext
  /** A flow step's held call (F4, door 'flow_step'): the loop, the step, the run, the connection. */
  flowStep?: FlowStepApprovalContext
  /** A connected app's write a loop's skill run staged (F4, door 'skill_run'). */
  mcp?: SkillRunMcpContext
  /** A loop's flow step raised this native card (F4 review N1): its loop must still be on, unless a Test. */
  loopStep?: LoopStepApprovalContext
  /** P9: a post card's own Typefully click, set by the server (settle-card.ts), never by a model. */
  postCard?: true
  /** C1: a call from the Native Intelligence agent on the person's Mac (its job, its Mac, its folder). */
  localAgent?: LocalAgentApprovalContext
  /**
   * The card's Always allow (mcp-client/always-allow.ts): the connected app's
   * server and tool, set by the server only (NewApproval.alwaysAllow), never by a model.
   */
  alwaysAllow?: AlwaysAllowOffer
  /** The cloud browser: the one step of a browser task the card asks about (browser-agent/approval-grant.ts). */
  browser?: { origin: string; target: string; context_hash: string }
  /** An unsubscribe card (GEN-1166): the way to unsubscribe it showed, set by the server's outward gate, never by a model. */
  unsubscribe?: UnsubscribeApprovalContext
  /** A quote reply card (send_quote, book_quote): which quote and its words' hash, set by the server's outward gate, never by a model. */
  quoteReply?: QuoteReplyApprovalContext
  /** A time offer card (offer_times by email or text): the offer made for it and its words' hash, set by the server's outward gate, never by a model. */
  timeOffer?: TimeOfferApprovalContext
  /** A Studio spend card (generate_studio_narration, generate_studio_shot): the request's hash and price, set by the server's outward gate, never by a model. */
  studioSpend?: StudioSpendApprovalContext
  /**
   * Guest access: a call by the agent the owner made for one person who texts
   * it (src/lib/guests/). At accept the guest must still be active and still
   * hold the tool (approvalCeilingPermits).
   */
  guest?: { guestId: string; name: string }
  /**
   * A customer's booking (roadmap B4, src/lib/customers/booking.ts): the
   * owner's yes confirms this booking (tool confirm_booking). At accept the
   * booking must still be requested (bookingApprovalPermits). Set by the
   * server only.
   */
  booking?: BookingApprovalContext
  /**
   * A business's website change (roadmap track E, src/lib/website/approval.ts):
   * the owner's yes merges this pull request at this head (tool
   * merge_website_change). At accept the change must still wait on its card
   * at that head (websiteApprovalPermits). Set by the server only.
   */
  website?: WebsiteApprovalContext
  /**
   * A home turn raised it (NewApproval.reachPerson): the agent working on its
   * own, not the person's own turn. Its cards are capped apart from theirs in
   * the same thread (APPROVAL_PENDING_MAX_PER_CONVERSATION each). Set by the
   * server only.
   */
  homeTurn?: true
  /**
   * Agent links: a call the other person's agent asked for, over this link
   * (src/lib/agent-links/). Named above the card in the home thread; it wins
   * over `guest`, which the answering side's half may also set.
   */
  agentLink?: AgentLinkCardContext
}

/** An unattended loop's fence (the skill_run door): what its approved call keeps. */
export const UNATTENDED_TOOL_OPTIONS: ApprovalToolOptions = Object.freeze({
  strictWorkspace: true,
  omitPrivateCaptures: true,
  unattended: true,
  fileActionsAsSuggested: true,
})

export interface NewApproval {
  door: ApprovalDoor
  userId: string
  workspaceId: string
  toolName: string
  sideEffect: ApprovalSideEffect
  input: unknown
  conversationId?: string | null
  skillId?: string | null
  workItemId?: string | null
  context?: ApprovalContext
  decisionId?: string | null
  reason: string
  personMessageSeq?: number | null
  /** The card's words, templated by the caller (action-review.ts approvalCardCopy). */
  card: { title: string; why: string }
  /**
   * Offer the card's Always allow: the connected app's server and tool to set
   * to Always allow when the person picks it (mcp-client/always-allow.ts).
   * Only the chat door's outward gate passes it, for a tool its own permission
   * held (not the reviewer) that may take Always allow.
   */
  alwaysAllow?: AlwaysAllowOffer
  /**
   * F4: the loop run that raised it (a flow step, or a skill step's staged
   * write): it stands in for the conversation in the per-conversation cap.
   */
  flowRunId?: string | null
  /**
   * False: no home-thread message (a post card's own Typefully click, which
   * approves at once). Otherwise the home thread asks whenever nobody is in a
   * chat to see the card (asksAtHome).
   */
  announce?: false
  /**
   * A home turn raised it: the card renders inline in their home thread, which
   * nobody is reading when the agent works on its own. It marks the context
   * (homeTurn) for the per-conversation cap; the turn's written message
   * carries the card, and the router (src/lib/reach/route.ts) takes that
   * message, the card's reply code with it, to the person.
   */
  reachPerson?: true
}

/**
 * Whether the card asks in the owner's home thread (P13): yes unless a chat
 * turn they are in raised it (the chat door with its conversation, not a
 * device ask, whose conversation nobody reads back), where it renders inline
 * after the agent's message. Pure.
 */
export function asksAtHome(approval: Pick<NewApproval, 'door' | 'conversationId' | 'context' | 'announce'>): boolean {
  if (approval.announce === false) return false
  if (approval.door !== 'chat' || !approval.conversationId) return true
  return approval.context?.surface === 'device_ask'
}

/** The home thread's line for a held call: what it wants and that it waits on them, by where it came from. Pure. */
export function askHomeText(approval: Pick<NewApproval, 'door' | 'context' | 'card'>): string {
  const publicContent = approval.context?.flowStep?.public_content === true
  switch (approval.door) {
    case 'flow_step':
      // The card under it says which loop, what runs and what each button does.
      return publicContent ? 'One of your loops wants to post this. It waits for your yes.' : 'One of your loops stopped here for your yes.'
    case 'skill_run':
      // A connected app's write the run staged (F4), or a Native Intelligence tool the
      // reviewer held: only the first is "in a connected app".
      return approval.context?.mcp
        ? 'A loop wants to make this change in a connected app. Nothing has run: it waits for your yes.'
        : 'A loop wants to make this change. Nothing has run: it waits for your yes.'
    default: {
      // A call from the Native Intelligence agent on the person's Mac: it names the Mac and
      // the job (the person's own Mac name and folder label).
      const mac = approval.context?.localAgent
      // A guest's call (guest access): who asked, through the agent you made for them.
      const guest = approval.context?.guest
      // Another person's agent, over a link (agent links): whose agent asked.
      const link = agentLinkAskData(approval.context?.agentLink)
      if (link) return `${link.peer_name}’s agent asked for this. Nothing has run: it waits for your yes.`
      // A website change (roadmap track E): what changed and its preview, texted when they're away.
      if (approval.context?.website) {
        const site = approval.context.website
        return mergeAskLine({
          summary: typeof site.summary === 'string' ? site.summary : null,
          previewUrl: typeof site.previewUrl === 'string' ? site.previewUrl : null,
          asked: typeof site.asked === 'string' ? site.asked : null,
          outside: Array.isArray(site.outside) ? site.outside.filter((h): h is string => typeof h === 'string') : null,
          replaces: site.replaces === true,
          unchecked: site.unchecked === true,
        })
      }
      // A customer's booking (roadmap B4): by text through the business's number, or on its booking page.
      if (approval.context?.booking) {
        return guest && typeof guest.name === 'string' && guest.name.trim()
          ? `${guest.name.trim().slice(0, 80)} asked to book this by text. Nothing is booked: it waits for your yes.`
          : 'A customer asked to book this on your booking page. Nothing is booked: it waits for your yes.'
      }
      if (guest && typeof guest.name === 'string' && guest.name.trim()) {
        return `${guest.name.trim().slice(0, 80)} asked their agent for this by text. Nothing has run: it waits for your yes.`
      }
      if (mac) return `${macJobAgentName(mac)} wants to do this for ${macJobPlace(mac)}. Nothing has run: it waits for your yes.`
      // A card someone else's ask raised for you (a takeover, a hand-over, a
      // loop to switch on), or one from a device ask. Fixed words: the card
      // under it says what (another member's loop title is their text, never
      // the agent's line).
      return 'This waits for your yes.'
    }
  }
}

export type NewApprovalResult =
  | { ok: true; approvalId: string; cardId: string; reused?: true }
  | { ok: false; code: 'NOT_A_MEMBER' | 'INPUT_TOO_LARGE' | 'TOO_MANY_PENDING' | 'WRITE_FAILED'; error: string }

/** JSON with every object's keys sorted, so equal inputs hash equal. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value ?? {})) ?? '{}'
}

/** sha256 of a call's input in canonical form (sorted keys), as stored beside it and checked before it runs. */
export function inputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

/**
 * Hold a call for the person: a tool_approval row and its approval card, in
 * the person's own queue. Service-role client. Refuses (with a reason the
 * model can pass on) for a non-member, an input too large to show in full,
 * or too many pending approvals; reuses a pending one for the same tool and
 * input. A card that cannot be written fails the whole approval.
 */
export async function createToolApproval(supabase: SupabaseClient, approval: NewApproval): Promise<NewApprovalResult> {
  try {
    const input = approval.input ?? {}
    const canonical = canonicalJson(input)
    if (new TextEncoder().encode(canonical).length > APPROVAL_INPUT_MAX_BYTES) {
      return { ok: false, code: 'INPUT_TOO_LARGE', error: `The inputs are too large to show on an approval card (over ${APPROVAL_INPUT_MAX_BYTES / 1000} KB), so nothing was held. Make the call smaller.` }
    }
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', approval.workspaceId)
      .eq('user_id', approval.userId)
      .maybeSingle<{ id: string }>()
    if (!member?.id) return { ok: false, code: 'NOT_A_MEMBER', error: 'The person is not a member of this workspace.' }
    // Their lapsed approvals leave pending first (expired, cards too), so the
    // queue and the caps below count only live ones. Best effort.
    await expireLapsedApprovals(supabase, { userId: approval.userId }).catch((err) => {
      console.warn('[approvals] could not expire lapsed approvals:', err instanceof Error ? err.message : String(err))
    })
    const hash = inputHash(input)
    const nowIso = new Date().toISOString()
    const { data: pendingRows, error: pendingError } = await supabase
      .from('tool_approval')
      .select('id, tool, input_hash, conversation_id, card_id, flow_run_id, door, context')
      .eq('user_id', approval.userId)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
    if (pendingError) return { ok: false, code: 'WRITE_FAILED', error: 'Could not check pending approvals.' }
    const pending = (pendingRows ?? []) as Array<{
      id: string
      tool: string
      input_hash: string
      conversation_id: string | null
      card_id: string | null
      flow_run_id?: string | null
      door?: string | null
      context?: ApprovalContext | null
    }>
    // The same call already waiting: reuse it (one card, not a pile). A loop
    // run's held call is reused only within that run: another run parked on
    // it would never hear its answer. Likewise within one chat, and one job
    // on the Mac: another chat's or job's card would answer someone else.
    const runId = approval.flowRunId ?? null
    const conversationId = approval.conversationId ?? null
    const macJobId = approval.context?.localAgent?.sessionId ?? null
    // A quote reply's card is its words (roadmap F3): the same input with other words is a new card.
    const quoteCardHash = approval.context?.quoteReply?.card_hash ?? null
    const offerCardHash = approval.context?.timeOffer?.card_hash ?? null
    const studioRequestHash = approval.context?.studioSpend?.request_hash ?? null
    const same = pending.find((row) =>
      row.tool === approval.toolName && row.input_hash === hash && row.card_id &&
      (row.flow_run_id ?? null) === runId &&
      (row.conversation_id ?? null) === conversationId &&
      (row.context?.localAgent?.sessionId ?? null) === macJobId &&
      (row.context?.quoteReply?.card_hash ?? null) === quoteCardHash &&
      (row.context?.timeOffer?.card_hash ?? null) === offerCardHash &&
      (row.context?.studioSpend?.request_hash ?? null) === studioRequestHash)
    if (same) return { ok: true, approvalId: same.id, cardId: same.card_id as string, reused: true }
    // A loop step's card is ONE per run and step, whatever its input (F4
    // review S3): a retried dispatch re-renders earlier steps, and a second
    // card for the same post while the first waits would let both run.
    const stepId = approval.door === 'flow_step' ? approval.context?.flowStep?.action_id : undefined
    const sameStep = stepId && runId
      ? pending.find((row) => row.door === 'flow_step' && row.card_id && (row.flow_run_id ?? null) === runId && row.context?.flowStep?.action_id === stepId)
      : undefined
    if (sameStep) return { ok: true, approvalId: sameStep.id, cardId: sameStep.card_id as string, reused: true }
    // Customers' bookings are capped apart (APPROVAL_PENDING_MAX_BOOKINGS): they never crowd out the person's own.
    const bookings = pending.filter((row) => !!row.context?.booking)
    if (approval.context?.booking) {
      if (bookings.length >= APPROVAL_PENDING_MAX_BOOKINGS) {
        return { ok: false, code: 'TOO_MANY_PENDING', error: `The owner already has ${bookings.length} booking requests waiting; nothing more is held until they answer those.` }
      }
    } else if (pending.length - bookings.length >= APPROVAL_PENDING_MAX_PER_USER) {
      return { ok: false, code: 'TOO_MANY_PENDING', error: `The person already has ${pending.length - bookings.length} approvals waiting; nothing more is held until they answer those.` }
    }
    // A home turn's cards and the person's own share their home thread, each
    // under its own cap: what the agent raised on its own never crowds out
    // what the person asks for.
    const homeTurn = approval.reachPerson === true
    if (approval.conversationId && pending.filter((row) => row.conversation_id === approval.conversationId && (row.context?.homeTurn === true) === homeTurn).length >= APPROVAL_PENDING_MAX_PER_CONVERSATION) {
      return {
        ok: false,
        code: 'TOO_MANY_PENDING',
        error: homeTurn
          ? 'Several cards you raised on your own already wait in this thread; nothing more is held until the person answers those.'
          : 'This conversation already has several approvals waiting; nothing more is held until the person answers those.',
      }
    }
    if (runId && pending.filter((row) => row.flow_run_id === runId).length >= APPROVAL_PENDING_MAX_PER_CONVERSATION) {
      return { ok: false, code: 'TOO_MANY_PENDING', error: 'This loop run already has several approvals waiting; nothing more is held until the person answers those.' }
    }
    // A job on the person's Mac has no conversation of its own to cap: its own count.
    const localAgent = approval.context?.localAgent?.sessionId
    if (localAgent && pending.filter((row) => row.context?.localAgent?.sessionId === localAgent).length >= APPROVAL_PENDING_MAX_PER_MAC_JOB) {
      return { ok: false, code: 'TOO_MANY_PENDING', error: 'This job on the Mac already has several approvals waiting; nothing more is held until the person answers those.' }
    }
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
    const { data: row, error } = await supabase
      .from('tool_approval')
      .insert({
        workspace_id: approval.workspaceId,
        member_id: member.id,
        user_id: approval.userId,
        door: approval.door,
        conversation_id: approval.conversationId ?? null,
        skill_id: approval.skillId ?? null,
        work_item_id: approval.workItemId ?? null,
        tool: approval.toolName,
        side_effect: approval.sideEffect,
        input,
        input_hash: hash,
        // The offer only ever comes from NewApproval.alwaysAllow: one riding in a copied context is dropped.
        context: {
          ...withoutOffer(approval.context),
          ...(approval.alwaysAllow ? { alwaysAllow: approval.alwaysAllow } : {}),
          ...(approval.reachPerson === true ? { homeTurn: true as const } : {}),
        },
        decision_id: approval.decisionId ?? null,
        reason: approval.reason,
        person_message_seq: approval.personMessageSeq ?? null,
        ...(runId ? { flow_run_id: runId } : {}),
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id')
      .single<{ id: string }>()
    if (error || !row?.id) return { ok: false, code: 'WRITE_FAILED', error: 'Could not hold the call.' }
    const { data: card, error: cardError } = await supabase
      .from('attention_item')
      .insert({
        workspace_id: approval.workspaceId,
        member_id: member.id,
        kind: 'approval',
        title: approval.card.title.slice(0, 200),
        why: approval.card.why.slice(0, 500),
        // The FULL input: the card shows every field of what will run. A flow
        // step's card can be edited before it runs (the person's own words).
        payload: {
          approval_id: row.id,
          tool: approval.toolName,
          side_effect: approval.sideEffect,
          door: approval.door,
          input,
          ...(approval.door === 'flow_step' ? { editable: true, ...(approval.context?.flowStep?.public_content ? { public_content: true } : {}) } : {}),
          // The card offers Always allow beside Approve (the stored context names what it changes).
          ...(approval.alwaysAllow ? { always_allow: true } : {}),
        },
        run_key: `approval:${row.id}`,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id')
      .single<{ id: string }>()
    if (cardError || !card?.id) {
      // No card, no approval: the person could never see or answer it.
      await supabase.from('tool_approval').update({ status: 'failed', decided_at: nowIso, result: { ran: false, code: 'CARD_FAILED' } }).eq('id', row.id)
      return { ok: false, code: 'WRITE_FAILED', error: 'Could not create the approval card.' }
    }
    await supabase.from('tool_approval').update({ card_id: card.id }).eq('id', row.id)
    // Nobody is in a chat to see it: the agent asks in their home thread, the
    // card inline (P13), and the router takes the ask to them wherever they are.
    if (asksAtHome(approval)) {
      await askAtHome(supabase, { approval, approvalId: row.id, cardId: card.id, runId }).catch((err) => {
        console.warn('[approvals] could not ask in the home thread:', err instanceof Error ? err.message : String(err))
      })
    }
    // The agent's inbox (A6): one `work.approval` row, for "while you were
    // away" and the digest. Never a home turn (router.ts, P13): the card
    // already asks in the chat. Off the caller's path, never throwing.
    deferLogWrite(
      recordAgentEvents(
        [
          {
            workspaceId: approval.workspaceId,
            userId: approval.userId,
            kind: 'work.approval',
            priority: 2,
            expiresAt,
            refType: 'tool_approval',
            refId: row.id,
            facts: { title: approval.card.title, door: approval.door },
            dedupeKey: agentEventKey.approval(row.id),
          },
        ],
        supabase,
      ),
    )
    return { ok: true, approvalId: row.id, cardId: card.id }
  } catch (err) {
    console.error('[approvals] could not hold the call:', err instanceof Error ? err.message : String(err))
    return { ok: false, code: 'WRITE_FAILED', error: 'Could not hold the call.' }
  }
}

interface ApprovalRow {
  id: string
  workspace_id: string
  user_id: string
  door: ApprovalDoor
  conversation_id: string | null
  skill_id: string | null
  tool: string
  input: unknown
  input_hash: string
  context: ApprovalContext | null
  status: string
  expires_at: string
  flow_run_id?: string | null
}

/** The largest edit of a flow step's inputs (the card must still show all of it). */
const EDITED_INPUT_MAX_BYTES = APPROVAL_INPUT_MAX_BYTES

/**
 * The person's edit of a flow step's held inputs (F4): a plain object with
 * exactly the stored keys (values may change; nothing may be added or
 * dropped, so the card showed every field that runs), small enough to show.
 * Null when it is not a usable edit.
 */
export function acceptableEdit(stored: unknown, edited: unknown): Record<string, unknown> | null {
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) return null
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const a = Object.keys(stored as object).sort()
  const b = Object.keys(edited as object).sort()
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return null
  if (new TextEncoder().encode(canonicalJson(edited)).length > EDITED_INPUT_MAX_BYTES) return null
  return edited as Record<string, unknown>
}

export type ApprovalOutcome =
  | { ok: true; status: 'executed'; success: boolean; result: unknown }
  | { ok: false; status: number; code: string; error: string }

/** What an approver who is not the owner, in their own hand, reads (caller.ts mayApprove). */
const NOT_THE_OWNER = 'Only the person this is held for can approve or decline it, from their own account.'

/**
 * The person accepted the approval card: run the stored call once, as them.
 * `approver` is who said yes, built only by a door that verified the person
 * (the card's own click; later a reply bound by caller.ts
 * bindReplyToApproval); only the owner's own principal may approve
 * (caller.ts mayApprove, decision 11). `approvalId` comes from the card's own
 * payload; the row must be the approver's and in the card's workspace.
 * Service-role client.
 */
export async function approveToolCall(
  supabase: SupabaseClient,
  approver: Approver,
  card: { workspace_id: string; payload: unknown },
  deps: {
    execute?: typeof executeStoredCall
    permits?: typeof approvalCeilingPermits
    settled?: typeof notifyFlowStepSettled
    /** F4: the person's own edit of a flow step's inputs, from the card's Edit. */
    editedInput?: unknown
    /** Test seam: why an edit doesn't fit the tool's schema (null: it fits). */
    editMisfit?: typeof flowStepEditMisfit
    /** Test seam: the agent's turn once the call ran (approval-turn.ts). */
    requestTurn?: typeof requestApprovalTurn
  } = {},
): Promise<ApprovalOutcome> {
  if (!mayApprove(approver, approver?.userId)) return { ok: false, status: 403, code: 'APPROVAL_PERSON_ONLY', error: NOT_THE_OWNER }
  const userId = approver.userId
  const approvalId = approvalIdOf(card.payload)
  if (!approvalId) return { ok: false, status: 409, code: 'APPROVAL_MISSING', error: 'This card has no held call.' }
  const { data: row } = await supabase
    .from('tool_approval')
    .select('id, workspace_id, user_id, door, conversation_id, skill_id, tool, input, input_hash, context, status, expires_at, flow_run_id')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .eq('workspace_id', card.workspace_id)
    .maybeSingle<ApprovalRow>()
  if (!row) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' }
  // The owner's own principal, against the row itself (never only the query's filter).
  if (!mayApprove(approver, row.user_id)) return { ok: false, status: 403, code: 'APPROVAL_PERSON_ONLY', error: NOT_THE_OWNER }
  if (row.status !== 'pending') return { ok: false, status: 409, code: 'ALREADY_RESOLVED', error: `Approval already ${row.status}` }
  // An edit is only a flow step's, and only one the card could show in full.
  const edit = deps.editedInput === undefined ? undefined : row.door === 'flow_step' ? acceptableEdit(row.input, deps.editedInput) : null
  if (edit === null) return { ok: false, status: 400, code: 'EDIT_REFUSED', error: 'Only the fields the card shows can be edited, and only on a loop step.' }
  // An edit must still fit the tool, checked BEFORE the claim, so a bad edit
  // leaves the card waiting (the run stays parked) instead of ending the run.
  if (edit) {
    const misfit = await (deps.editMisfit ?? flowStepEditMisfit)(supabase, row, edit)
    if (misfit) return { ok: false, status: 400, code: 'EDIT_REFUSED', error: `That edit doesn't fit the tool: ${misfit} Nothing ran; the card is still waiting.` }
  }
  const nowIso = new Date().toISOString()
  if (Date.parse(row.expires_at) <= Date.now()) {
    // The row and its card both leave pending.
    await expireLapsedApprovals(supabase, { approvalId: row.id }).catch(() => {})
    return { ok: false, status: 409, code: 'EXPIRED', error: 'This approval has expired. Ask again.' }
  }
  // At most once: only the caller that moves it off pending runs it.
  const { data: claimed } = await supabase
    .from('tool_approval')
    .update({ status: 'approved', decided_at: nowIso })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
  if (!claimed?.length) return { ok: false, status: 409, code: 'ALREADY_RESOLVED', error: 'Approval already resolved' }

  // A refusal after the claim: the audit row says failed, never approved-and-silent.
  // A flow step's run hears it too (it ends with the reason).
  const settle = deps.settled ?? notifyFlowStepSettled
  const refuse = async (status: number, code: string, error: string): Promise<ApprovalOutcome> => {
    await supabase.from('tool_approval').update({ status: 'failed', result: { ran: false, code, error } }).eq('id', row.id)
    await postHomeResult(supabase, row, { ran: false, reason: error })
    await settle(row, 'failed').catch(warnUnsettled)
    if (row.context?.guest) deferLogWrite(tellGuests(supabase, [row.id]))
    return { ok: false, status, code, error }
  }
  // Membership, now: approving later must not act for someone who left.
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', row.workspace_id)
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>()
  if (!member?.id) return refuse(403, 'NOT_A_MEMBER', 'You are no longer a member of this workspace, so the held call did not run.')
  // The kill switch, now: a loop's held call does not run while the agent is
  // paused (the person's own chat asks are theirs).
  if (row.door !== 'chat' && (await isAgentPaused(supabase, row.workspace_id))) {
    return refuse(409, 'AGENT_PAUSED', 'Agent work is switched off for this workspace, so the held call did not run.')
  }
  // What runs is what the card showed.
  if (inputHash(row.input) !== row.input_hash) {
    return refuse(409, 'INPUT_CHANGED', 'The held inputs no longer match what was shown, so the call did not run.')
  }
  // The ceiling, now: a tool switched off since must not run on an old yes.
  if (!(await (deps.permits ?? approvalCeilingPermits)(supabase, row))) {
    return refuse(403, 'TOOL_OUT_OF_CEILING', `${row.tool} is no longer available here, so the held call did not run.`)
  }
  // The person's edit (F4): what runs is what they typed, recorded before it runs.
  if (edit) {
    const editedHash = inputHash(edit)
    if (editedHash !== row.input_hash) {
      await supabase.from('tool_approval').update({ input: edit, input_hash: editedHash, context: { ...(row.context ?? {}), edited_from_hash: row.input_hash } }).eq('id', row.id)
      row.input = edit
      row.input_hash = editedHash
    }
  }

  let result: unknown
  let success = false
  try {
    result = await (deps.execute ?? executeStoredCall)(supabase, row)
    success = !(result && typeof result === 'object' && ((result as { success?: unknown }).success === false || (result as { isError?: unknown }).isError === true))
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  const stored = capResult(result)
  await supabase.from('tool_approval').update({ executed_at: new Date().toISOString(), result: stored }).eq('id', row.id)
  await postHomeResult(supabase, row, { ran: true, success, quote: summaryOf(stored) })
  // The agent that raised it carries on (its own chat turn's calls only;
  // never throws), sent after the response so the Accept never waits on it.
  deferLogWrite((deps.requestTurn ?? requestApprovalTurn)(row))
  // A guest's call: the guest hears how it ended (never throws).
  if (row.context?.guest) deferLogWrite(tellGuests(supabase, [row.id]))
  // A flow step's parked run carries on from the step, with its output.
  await settle(row, 'approved').catch(warnUnsettled)
  return { ok: true, status: 'executed', success, result: stored }
}

/**
 * The person dismissed the approval card: the held call is denied (never run).
 * Only the owner, in their own hand (caller.ts mayApprove), declines it.
 */
export async function denyToolCall(
  supabase: SupabaseClient,
  approver: Approver,
  card: { workspace_id: string; payload: unknown },
  deps: { settled?: typeof notifyFlowStepSettled } = {},
): Promise<void> {
  if (!mayApprove(approver, approver?.userId)) return
  const approvalId = approvalIdOf(card.payload)
  if (!approvalId) return
  const { data } = await supabase
    .from('tool_approval')
    .update({ status: 'denied', decided_at: new Date().toISOString() })
    .eq('id', approvalId)
    .eq('user_id', approver.userId)
    .eq('workspace_id', card.workspace_id)
    .eq('status', 'pending')
    .select('id, door, context, flow_run_id, workspace_id')
  // Skip on a loop step: its parked run ends cleanly, with a note.
  for (const row of (data ?? []) as SettledRow[]) await (deps.settled ?? notifyFlowStepSettled)(row, 'denied').catch(warnUnsettled)
  // A customer's booking: its slot opens again and they are told (roadmap B4).
  await settleBookings(supabase, (data ?? []) as SettledRow[], 'denied')
  // A time offer's card: its held times go (availability phase 3a).
  await settleTimeOffers(supabase, (data ?? []) as SettledRow[], 'denied')
  // A website change: its pull request is closed (roadmap track E).
  await settleWebsites(supabase, (data ?? []) as SettledRow[], 'denied')
  // A guest's call: the guest hears it was declined, after the response.
  deferLogWrite(tellGuests(supabase, guestRowIds((data ?? []) as SettledRow[])))
}

/** The ids among `rows` a guest's agent raised (context.guest). */
function guestRowIds(rows: readonly SettledRow[]): string[] {
  return rows.filter((row) => row.context?.guest).map((row) => row.id)
}

/** Tell the guests whose held calls settled (src/lib/guests/guest-approvals.ts; never throws). */
async function tellGuests(supabase: SupabaseClient, approvalIds: readonly string[]): Promise<void> {
  if (!approvalIds.length) return
  const { notifyGuestOfSettledCalls } = await import('@/lib/guests/guest-approvals')
  await notifyGuestOfSettledCalls(supabase, approvalIds)
}

/** Each booking approval among `rows` that was declined or lapsed: its booking settles (best effort, never throws). */
async function settleBookings(supabase: SupabaseClient, rows: readonly SettledRow[], outcome: 'denied' | 'expired'): Promise<void> {
  const bookings = rows.filter((row) => row.context?.booking && typeof row.workspace_id === 'string')
  if (!bookings.length) return
  const { settleBookingApproval } = await import('@/lib/customers/booking')
  for (const row of bookings) await settleBookingApproval(supabase, { workspace_id: row.workspace_id as string, context: row.context }, outcome)
}

/** Each time offer card among `rows` that was declined or lapsed: its offer's held times go (best effort, never throws). */
async function settleTimeOffers(supabase: SupabaseClient, rows: readonly SettledRow[], outcome: 'denied' | 'expired'): Promise<void> {
  const offers = rows.filter((row) => typeof row.context?.timeOffer?.offer_id === 'string')
  if (!offers.length) return
  const { settleTimeOfferApproval } = await import('@/lib/time-offers/send')
  for (const row of offers) await settleTimeOfferApproval(supabase, { context: row.context }, outcome)
}

/** Each website merge card among `rows` that was declined or lapsed: its change settles (best effort, never throws). */
async function settleWebsites(supabase: SupabaseClient, rows: readonly SettledRow[], outcome: 'denied' | 'expired'): Promise<void> {
  const sites = rows.filter((row) => row.context?.website && typeof row.workspace_id === 'string')
  if (!sites.length) return
  const { settleWebsiteApproval } = await import('@/lib/website/approval')
  for (const row of sites) await settleWebsiteApproval(supabase, { id: row.id, workspace_id: row.workspace_id as string, context: row.context }, outcome)
}

/**
 * A parked run's answer could not be sent: logged, never thrown (the answer
 * itself stands). The hourly sweep (flow-step-resume.ts sweepParkedRuns)
 * tells the run again from the approval's own status.
 */
function warnUnsettled(err: unknown): void {
  console.warn('[approvals] could not tell a parked loop run its answer; the sweep will:', err instanceof Error ? err.message : String(err))
}

/** The columns a settled approval's parked run (or its booking) is told from. */
type SettledRow = Pick<ApprovalRow, 'id' | 'door' | 'context' | 'flow_run_id'> & { workspace_id?: string }

/** Tell each expired flow step's parked run (best effort: the resume sweep also ends a run whose card lapsed). */
async function settleExpired(rows: SettledRow[], outcome: FlowStepOutcome): Promise<void> {
  for (const row of rows) if (row.door === 'flow_step') await notifyFlowStepSettled(row, outcome).catch(warnUnsettled)
}

/**
 * The kill switch's fan-out (A5 slice 5, stopPausedWorkspaceExtras): expire a
 * workspace's pending loop approvals (every door but chat) and their cards, so
 * nothing an unattended run raised can be approved into running while the agent
 * is paused. The person's own chat-door approvals stay: they asked for those.
 * Throws on a failed read or write, so the Inngest step retries.
 */
export async function expirePendingApprovals(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('tool_approval')
    .select('id, card_id, door, context, flow_run_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .neq('door', 'chat')
  if (error) throw new Error(`expire approvals: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; card_id: string | null } & SettledRow>
  if (!rows.length) return
  const expired = await supabase
    .from('tool_approval')
    .update({ status: 'expired', decided_at: nowIso })
    .in('id', rows.map((row) => row.id))
    .eq('status', 'pending')
  if (expired.error) throw new Error(`expire approvals: ${expired.error.message}`)
  const cardIds = rows.map((row) => row.card_id).filter((id): id is string => !!id)
  if (cardIds.length) {
    const cards = await supabase.from('attention_item').update({ status: 'expired', resolved_at: nowIso }).in('id', cardIds).eq('status', 'pending')
    if (cards.error) throw new Error(`expire approval cards: ${cards.error.message}`)
  }
  // A loop step's parked run ends: the agent is off.
  await settleExpired(rows, 'paused')
}

/**
 * How many lapsed approvals one sweep expires: its ids (and card ids) go in an
 * `in` filter on the URL, so it stays well short of a URL-length (414) limit.
 * The cron runs several sweeps per tick.
 */
export const EXPIRE_SWEEP_MAX = 100

/**
 * Expire held calls whose wait is over (expires_at passed, still pending) and
 * their cards, so nothing reads a lapsed approval as pending: the row goes to
 * 'expired', its card to 'expired' (the rail's realtime UPDATE drops it on
 * every device). Scoped to one person, one approval or one card, or (the
 * hourly cron, /api/cron/approval-expiry) everyone, at most EXPIRE_SWEEP_MAX
 * (100) at a time. Service client. Returns how many were expired; throws on a failed
 * read or write.
 *
 * Reads never needed this to hide one (listPendingCards and the queue reads
 * skip a card whose expires_at passed, and createToolApproval's caps skip a
 * lapsed row); it is what makes the stored status true.
 */
export async function expireLapsedApprovals(
  supabase: SupabaseClient,
  scope: { userId?: string; approvalId?: string; cardId?: string; limit?: number } = {},
): Promise<number> {
  const nowIso = new Date().toISOString()
  let query = supabase
    .from('tool_approval')
    .select('id, card_id, door, context, flow_run_id, workspace_id')
    .eq('status', 'pending')
    .lt('expires_at', nowIso)
  if (scope.userId) query = query.eq('user_id', scope.userId)
  if (scope.approvalId) query = query.eq('id', scope.approvalId)
  if (scope.cardId) query = query.eq('card_id', scope.cardId)
  const { data, error } = await query.limit(Math.min(scope.limit ?? EXPIRE_SWEEP_MAX, EXPIRE_SWEEP_MAX))
  if (error) throw new Error(`expire lapsed approvals: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; card_id: string | null } & SettledRow>
  if (!rows.length) return 0
  const expired = await supabase
    .from('tool_approval')
    .update({ status: 'expired', decided_at: nowIso })
    .in('id', rows.map((row) => row.id))
    .eq('status', 'pending')
    .select('id')
  if (expired.error) throw new Error(`expire lapsed approvals: ${expired.error.message}`)
  // Only the rows this sweep moved: a yes that won the race at the boundary keeps its booking.
  const moved = new Set(((expired.data ?? []) as Array<{ id: string }>).map((r) => r.id))
  const cardIds = rows.map((row) => row.card_id).filter((id): id is string => !!id)
  if (cardIds.length) {
    const cards = await supabase
      .from('attention_item')
      .update({ status: 'expired', resolved_at: nowIso })
      .in('id', cardIds)
      .eq('status', 'pending')
    if (cards.error) throw new Error(`expire lapsed approval cards: ${cards.error.message}`)
  }
  // A loop step whose card lapsed: its parked run ends (24-hour expiry).
  await settleExpired(rows, 'expired')
  // A customer's booking nobody answered: its slot opens again (roadmap B4).
  await settleBookings(supabase, rows.filter((row) => moved.has(row.id)), 'expired')
  // A time offer's card nobody answered: its held times go (availability phase 3a).
  await settleTimeOffers(supabase, rows.filter((row) => moved.has(row.id)), 'expired')
  // A website change nobody answered: it lapses, its pull request left open (roadmap track E).
  await settleWebsites(supabase, rows.filter((row) => moved.has(row.id)), 'expired')
  // A guest's call nobody answered: the guest hears it lapsed.
  await tellGuests(supabase, guestRowIds(rows.filter((row) => moved.has(row.id))))
  return rows.length
}

function approvalIdOf(payload: unknown): string | null {
  const id = payload && typeof payload === 'object' ? (payload as { approval_id?: unknown }).approval_id : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

/**
 * Is the held tool still within what its door would grant the person today?
 *   chat:      the chat ceiling (edition ∩ agent ∪ their external tools) minus
 *              the surface's exclusions, or a teammate chat's own ceiling;
 *   skill_run: the loop's skill ceiling in its mode (null = the registry).
 * Any other stored door (a retired one) is refused. An external mcp__ tool must still be one of the person's enabled tools, and
 * only the chat door holds those.
 */
export async function approvalCeilingPermits(
  supabase: SupabaseClient,
  row: Pick<ApprovalRow, 'door' | 'workspace_id' | 'user_id' | 'tool' | 'skill_id' | 'context'>,
): Promise<boolean> {
  const context = row.context ?? {}
  // A loop step (F4): the step still calls this tool on this connection, the
  // loop is still the person's, and the person still lets the agent use it.
  if (row.door === 'flow_step') return flowStepPermits(supabase, row)
  // A customer's booking (roadmap B4): the booking itself must still be waiting.
  if (context.booking) {
    if (row.door !== 'chat') return false
    const { bookingApprovalPermits } = await import('@/lib/customers/booking')
    return bookingApprovalPermits(supabase, row)
  }
  // A website change (roadmap track E): the change itself must still wait on its card, at its head.
  if (context.website) {
    if (row.door !== 'chat') return false
    const { websiteApprovalPermits } = await import('@/lib/website/approval')
    return websiteApprovalPermits(supabase, row)
  }
  const external = row.tool.startsWith('mcp__')
  // A skill run's staged write on one of its step's connections (F4).
  if (external && row.door === 'skill_run' && context.mcp) return skillRunMcpPermits(supabase, row, context.mcp)
  if (external) {
    if (row.door !== 'chat') return false
    const { meta } = await createExternalMcpTools(row.user_id, supabase)
    if (!meta.has(row.tool)) return false
  } else if (!(ALL_TOOL_NAMES as readonly string[]).includes(bareName(row.tool))) {
    return false
  }
  if (row.door === 'chat') {
    if (context.surface && isToolExcludedForSurface(row.tool, context.surface as ChatRunSurface)) return false
    // A guest's held call: still theirs to make, today.
    if (context.guest) {
      if (external || typeof context.guest.guestId !== 'string') return false
      return (await activeGuestCeiling(supabase, row.user_id, context.guest.guestId)).has(row.tool)
    }
    if (context.teammateId) {
      const bounds = await resolveTeammateChatBounds(supabase, row.workspace_id, context.teammateId, row.user_id)
      if (!bounds) return false
      return (await resolveTeammateChatCeiling(supabase, { workspaceId: row.workspace_id, teammateId: context.teammateId, bounds })).has(row.tool)
    }
    const ceiling = await resolveChatCeiling(supabase, {
      workspaceId: row.workspace_id,
      agentToolCeiling: await resolveAgentToolCeiling(supabase, context.agentId),
      externalMcpToolNames: external ? [row.tool] : [],
    })
    return ceiling ? ceiling.has(row.tool) : true
  }
  if (row.door === 'skill_run') {
    if (!row.skill_id) return false
    // A flow step's card: its loop is still the person's, still has the step,
    // and is still on (a person's Test excepted).
    if (context.loopStep) {
      const step = await liveFlowStep(supabase, { workspaceId: row.workspace_id, ownerId: row.user_id, flowId: context.loopStep.flow_id, actionId: context.loopStep.action_id, allowOff: context.loopStep.manual === true })
      if (!step) return false
    }
    const { data: recipe } = await supabase
      .from('recipe')
      .select('agent_config')
      .eq('id', row.skill_id)
      .eq('category', 'skill')
      .or(`workspace_id.eq.${row.workspace_id},is_system.eq.true`)
      .maybeSingle<{ agent_config: Parameters<typeof computeSkillCeiling>[0] }>()
    if (!recipe) return false
    const ceiling = computeSkillCeiling(recipe.agent_config, context.mode === 'report' ? 'report' : 'act', false)
    return ceiling ? ceiling.has(row.tool) : true
  }
  // A retired door (a historic 'mcp' row): fail closed.
  return false
}

/** A context without an Always allow offer or a home turn's mark (only NewApproval.alwaysAllow and reachPerson set those). */
function withoutOffer(context: ApprovalContext | undefined): ApprovalContext {
  if (!context) return {}
  const { alwaysAllow: _dropped, homeTurn: _home, ...rest } = context
  return rest
}

/** A Native Intelligence MCP name without its prefix (the registry's name). */
function bareName(tool: string): string {
  return bareToolName(tool)
}

/** Why an edit of a flow step's inputs doesn't fit the tool's schema now, or null when it does. */
export async function flowStepEditMisfit(
  supabase: SupabaseClient,
  row: Pick<ApprovalRow, 'user_id' | 'context'>,
  edit: Record<string, unknown>,
): Promise<string | null> {
  const step = row.context?.flowStep
  if (!step) return 'the held step is missing its record.'
  const server = await loadOwnerConnection(supabase, row.user_id, step.connection)
  if (!server) return 'the connection is gone.'
  const check = checkToolInputAtRun(edit, toolOf(server, step.tool)?.inputSchema)
  return check.ok ? null : `${check.error}.`
}

/** The accept-time re-check of a flow step's held call (see approvalCeilingPermits). */
async function flowStepPermits(supabase: SupabaseClient, row: Pick<ApprovalRow, 'workspace_id' | 'user_id' | 'context'>): Promise<boolean> {
  const step = row.context?.flowStep
  if (!step || typeof step.flow_id !== 'string' || typeof step.connection !== 'string' || typeof step.tool !== 'string') return false
  const action = await liveFlowStep(supabase, { workspaceId: row.workspace_id, ownerId: row.user_id, flowId: step.flow_id, actionId: step.action_id, allowOff: step.manual === true })
  if (!action || action.type !== 'call_tool' || action.config?.connection !== step.connection || action.config?.tool !== step.tool) return false
  const server = await loadOwnerConnection(supabase, row.user_id, step.connection)
  return connectionProblem(server, step.tool) === null
}

/**
 * A loop's step as it is NOW, for an accept: the loop still exists in the
 * workspace, is still the approver's, and is still ON (a loop switched off
 * while its card waited runs nothing on an old yes), and the step is still in
 * it. Null otherwise.
 */
async function liveFlowStep(
  supabase: SupabaseClient,
  ref: { workspaceId: string; ownerId: string; flowId: unknown; actionId: unknown; allowOff?: boolean },
): Promise<{ type?: unknown; config?: { connection?: unknown; tool?: unknown; connections?: unknown } } | null> {
  if (typeof ref.flowId !== 'string' || typeof ref.actionId !== 'string') return null
  const { data: flow } = await supabase
    .from('flow')
    .select('id, created_by, enabled, actions')
    .eq('id', ref.flowId)
    .eq('workspace_id', ref.workspaceId)
    .maybeSingle<{ id: string; created_by: string | null; enabled: boolean | null; actions: unknown }>()
  // A person's Test of a loop still off (R1) is answered anyway; anything else needs the loop on.
  if (!flow || flow.created_by !== ref.ownerId || (flow.enabled !== true && ref.allowOff !== true)) return null
  const action = (Array.isArray(flow.actions) ? flow.actions : []).find((a) => a && typeof a === 'object' && (a as { id?: unknown }).id === ref.actionId)
  return (action as { type?: unknown; config?: { connection?: unknown; tool?: unknown; connections?: unknown } } | undefined) ?? null
}

/**
 * The accept-time re-check of a skill run's staged connected-app write: the
 * loop is still on and the approver's, its skill step STILL names this
 * connection now (never the list the card itself carried), and the person
 * still lets the agent see the tool.
 */
async function skillRunMcpPermits(supabase: SupabaseClient, row: Pick<ApprovalRow, 'user_id' | 'workspace_id'>, mcp: SkillRunMcpContext): Promise<boolean> {
  const action = await liveFlowStep(supabase, { workspaceId: row.workspace_id, ownerId: row.user_id, flowId: mcp.flow_id, actionId: mcp.action_id, allowOff: mcp.manual === true })
  const current = Array.isArray(action?.config?.connections) ? (action!.config!.connections as unknown[]) : []
  if (!action || action.type !== 'run_skill' || !current.includes(mcp.connection)) return false
  const server = await loadOwnerConnection(supabase, row.user_id, mcp.connection)
  return connectionProblem(server, mcp.tool) === null
}

/**
 * Run a flow step's held call once, as the person, on the exact connection
 * the step names (never by a display-name slug another server could share).
 * The input is checked against the tool's schema again first (the person
 * may have edited it). The result keeps the app's text RAW (capped,
 * redacted): it becomes the step's output, which the resume fences for a
 * model step and sends plain to the next app.
 */
async function executeFlowStepCall(
  supabase: SupabaseClient,
  row: Pick<ApprovalRow, 'user_id' | 'input' | 'context'>,
): Promise<unknown> {
  const step = row.context?.flowStep
  if (!step) return { success: false, error: 'The held step is missing its record.' }
  const server = await loadOwnerConnection(supabase, row.user_id, step.connection)
  const problem = connectionProblem(server, step.tool)
  if (problem || !server) return { success: false, error: problem ?? 'The connection is gone.' }
  const args = (row.input && typeof row.input === 'object' ? row.input : {}) as Record<string, unknown>
  const check = checkToolInputAtRun(args, toolOf(server, step.tool)?.inputSchema)
  if (!check.ok) return { success: false, error: `The inputs don't match ${step.tool}: ${check.error}` }
  try {
    const out = await callToolByServerId(supabase, server.id, step.tool, args, row.user_id)
    const text = capStepOutput(mcpContentText(out.content)).output
    return { success: !out.isError, isError: out.isError, text, message: out.isError ? `${step.tool} returned an error.` : `${step.tool} ran on ${server.display_name}.` }
  } catch (err) {
    if (err instanceof McpTokenExpiredError) return { success: false, code: 'MCP_TOKEN_EXPIRED', error: `${server.display_name} needs reconnecting.` }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The createTools options an approved call runs under: the door's own,
 * recorded on the row. A non-chat row with none recorded gets the unattended
 * fence anyway (fail closed). Actions an unattended run files are
 * suggestions, and nothing it touched counts as its own to confirm.
 */
export function storedToolOptions(row: Pick<ApprovalRow, 'door' | 'context' | 'conversation_id' | 'skill_id'>): CreateToolsOptions {
  const recorded = row.context?.tools
  const fence: ApprovalToolOptions = row.door === 'chat' ? (recorded ?? {}) : { ...UNATTENDED_TOOL_OPTIONS, ...(recorded ?? {}), strictWorkspace: true }
  return {
    ...(fence.strictWorkspace ? { strictWorkspace: true } : {}),
    ...(fence.omitPrivateCaptures ? { omitPrivateCaptures: true } : {}),
    ...(fence.unattended ? { unattended: true } : {}),
    // A guest's or a linked agent's held call never reads the owner's grants on replay, flag stored or not.
    ...(fence.omitGrants || row.context?.guest || row.context?.agentLink ? { omitGrants: true } : {}),
    ...(fence.fileActionsAsSuggested
      ? { actionRules: { unattended: true, fileActionsAsSuggested: true, filedByRun: async (ids: readonly string[]) => new Set(ids.map((id) => id.toLowerCase())) } }
      : {}),
    ...(fence.origin ? { origin: fence.origin as CreateToolsOptions['origin'] } : row.door === 'chat' ? {} : { origin: { actor: 'agent', depth: 1, ...(row.skill_id ? { run_id: row.skill_id } : {}) } as CreateToolsOptions['origin'] }),
    ...(row.conversation_id ? { suggestionContext: { origin: 'chat' as const, conversationId: row.conversation_id } } : {}),
  }
}

/**
 * Run the stored call once, as the person: an external MCP tool through its
 * server (the approval gate IS this), anything else through createTools
 * rebuilt with the door's exact options and its real schema.
 */
export async function executeStoredCall(
  supabase: SupabaseClient,
  row: Pick<ApprovalRow, 'workspace_id' | 'user_id' | 'tool' | 'input' | 'conversation_id' | 'door' | 'context' | 'skill_id'> & { id?: string },
): Promise<unknown> {
  const args = (row.input && typeof row.input === 'object' ? row.input : {}) as Record<string, unknown>
  if (row.door === 'flow_step') return executeFlowStepCall(supabase, row)
  // A skill run's staged write: on its exact connection, its text fenced (a model reads it).
  const mcp = row.context?.mcp
  if (row.tool.startsWith('mcp__') && row.door === 'skill_run' && mcp) {
    // The tool's schema, again, right before it runs.
    const server = await loadOwnerConnection(supabase, row.user_id, mcp.connection)
    const check = checkToolInputAtRun(args, server ? toolOf(server, mcp.tool)?.inputSchema : undefined)
    if (!server || !check.ok) return { success: false, error: check.ok ? 'The connection is gone.' : `The inputs don't match ${mcp.tool}: ${check.error}` }
    try {
      const out = await callToolByServerId(supabase, mcp.connection, mcp.tool, args, row.user_id)
      return { success: !out.isError, isError: out.isError, content: fenceMcpContent(out.content) }
    } catch (err) {
      if (err instanceof McpTokenExpiredError) return { success: false, code: 'MCP_TOKEN_EXPIRED', error: err.message }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (row.tool.startsWith('mcp__')) return executeExternalMcpCall(supabase, row.user_id, row.tool, args)
  const name = bareName(row.tool)
  // A message to another person's agent (agent links): chat-native, so no
  // createTools execute. The person's yes on this card is their own word, so
  // it may start an exchange; keyed on the approval, it sends once.
  if (name === 'ask_agent') {
    const [{ askAgent }, { askAgentSchema }] = await Promise.all([import('@/lib/agent-links/exchange'), import('@/lib/ai/tools/agent-link-ask')])
    const parsed = askAgentSchema.safeParse(args)
    if (!parsed.success) return { success: false, error: "The held message no longer matches ask_agent's inputs, so it was not sent." }
    return askAgent(supabase, { userId: row.user_id, workspaceId: row.workspace_id, mayStart: true, callKey: row.id ? `approval:${row.id}` : null }, parsed.data)
  }
  // A customer's booking (roadmap B4): the owner's yes books it. Never a
  // registry tool: only the server's own booking card holds one.
  if (row.context?.booking) {
    const { CONFIRM_BOOKING_TOOL, confirmBooking } = await import('@/lib/customers/booking')
    if (name !== CONFIRM_BOOKING_TOOL || typeof row.context.booking.bookingId !== 'string') return { success: false, error: 'This held booking is not valid.' }
    return confirmBooking(supabase, { userId: row.user_id, workspaceId: row.workspace_id, bookingId: row.context.booking.bookingId })
  }
  // A website change (roadmap track E): the owner's yes merges the head they
  // were shown. Never a registry tool: only the server's own merge card holds one.
  if (row.context?.website) {
    const { mergeWebsiteChange } = await import('@/lib/website/approval')
    const { MERGE_WEBSITE_CHANGE_TOOL } = await import('@/lib/website/types')
    const site = row.context.website
    if (name !== MERGE_WEBSITE_CHANGE_TOOL || typeof site.changeId !== 'string' || typeof site.headSha !== 'string') return { success: false, error: 'This held website change is not valid.' }
    return mergeWebsiteChange(supabase, { userId: row.user_id, workspaceId: row.workspace_id, changeId: site.changeId, headSha: site.headSha })
  }
  // The replay knows it is one (approved-call.ts): a tool that raised its own
  // verified card (the flow tools' F1 cards) runs the stored call instead of
  // raising another. Only here, after every re-check above passed.
  const approvedCall = row.id
    ? {
        approvedCall: {
          approvalId: row.id,
          tool: name,
          ...(row.context?.flow ? { flow: row.context.flow } : {}),
          ...(row.context?.connection ? { connection: row.context.connection } : {}),
          ...(row.context?.bots ? { bots: row.context.bots } : {}),
          ...(row.context?.document ? { document: row.context.document } : {}),
          ...(row.context?.outreach ? { outreach: row.context.outreach } : {}),
          ...(row.context?.postCard === true ? { postCard: true as const } : {}),
          ...(row.context?.browser ? { browser: row.context.browser } : {}),
          ...(row.context?.unsubscribe ? { unsubscribe: row.context.unsubscribe } : {}),
          ...(row.context?.quoteReply ? { quoteReply: row.context.quoteReply } : {}),
          ...(row.context?.timeOffer ? { timeOffer: row.context.timeOffer } : {}),
          ...(row.context?.studioSpend ? { studioSpend: row.context.studioSpend } : {}),
        },
      }
    : {}
  const tools = createTools(row.user_id, supabase, row.workspace_id, undefined, { ...storedToolOptions(row), ...approvedCall }) as Record<string, Tool>
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined
  if (!tool || typeof tool.execute !== 'function') return { success: false, error: `${name} is not available.` }
  const schema = tool.inputSchema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown } } | undefined
  let parsed: unknown = args
  if (schema && typeof schema.safeParse === 'function') {
    const check = schema.safeParse(args)
    if (!check.success) return { success: false, error: 'The held call no longer matches the tool\'s inputs, so it did not run.' }
    parsed = check.data
  }
  return tool.execute(parsed as never, { toolCallId: `approval-${row.tool}`, messages: [] } as never)
}

/**
 * The result as the row keeps it: whole when it fits RESULT_MAX_CHARS as
 * JSON, else a preview that keeps the success flags (the card's outcome and
 * the agent's, approval-results.ts, read them).
 */
export function capResult(result: unknown): unknown {
  let text: string
  try {
    text = JSON.stringify(result ?? null) ?? 'null'
  } catch {
    return { note: 'The result could not be stored.' }
  }
  if (text.length <= RESULT_MAX_CHARS) return result ?? null
  const r = result && typeof result === 'object' ? (result as { success?: unknown; isError?: unknown }) : {}
  return {
    truncated: true,
    ...(typeof r.success === 'boolean' ? { success: r.success } : {}),
    ...(r.isError === true ? { isError: true } : {}),
    preview: text.slice(0, RESULT_MAX_CHARS),
  }
}

function summaryOf(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    for (const key of ['message', 'summary', 'error']) if (typeof r[key] === 'string' && r[key]) return String(r[key]).slice(0, HOME_QUOTE_MAX_CHARS)
  }
  return ''
}

/**
 * The outcome in the person's home thread (A3): one bubble per approval,
 * retried writes collapse onto it. Our own words are templated; any text the
 * tool returned (another service's, possibly attacker-written) is quoted
 * inside the untrusted fence, never as the agent's words.
 */
/**
 * The home thread's ask for a held call nobody saw raised (P13): one agent
 * message, templated (askHomeText), with the card inline (`data-ask-card`:
 * chat-ask-card.tsx finds the live card by its id, and reads the outcome once
 * it is settled). Its id is the approval's, so a retry writes nothing new. A
 * loop's run names its work item, for the card's "Open run" (the item,
 * beside the run's chat). Best effort.
 */
async function askAtHome(
  supabase: SupabaseClient,
  args: { approval: NewApproval; approvalId: string; cardId: string; runId: string | null },
): Promise<void> {
  const { approval } = args
  let workItemId = approval.workItemId ?? null
  if (!workItemId && args.runId) {
    const { data } = await supabase
      .from('tracked_job')
      .select('id')
      .eq('workspace_id', approval.workspaceId)
      .eq('flow_run_id', args.runId)
      .limit(1)
    const id = (data as Array<{ id?: unknown }> | null)?.[0]?.id
    workItemId = typeof id === 'string' ? id : null
  }
  const agentLink = agentLinkAskData(approval.context?.agentLink)
  const guest = agentLink ? null : await guestOfApproval(supabase, approval)
  const part: AskCardPartData = {
    card_id: args.cardId,
    approval_id: args.approvalId,
    workspace_id: approval.workspaceId,
    title: approval.card.title.slice(0, 200),
    ...(workItemId ? { work_item_id: workItemId } : {}),
    ...(guest ? { guest } : {}),
    ...(agentLink ? { agent_link: agentLink } : {}),
  }
  const written = await appendHomeMessage(supabase, {
    userId: approval.userId,
    workspaceId: approval.workspaceId,
    messageId: `approval-ask-${args.approvalId}`,
    parts: [
      { type: 'text', text: askHomeText(approval) },
      { type: ASK_CARD_PART_TYPE, data: part },
    ],
    metadata: { kind: ASK_MESSAGE_KIND, approval_id: args.approvalId, card_id: args.cardId },
  })
  // The router takes the ask (its reply code with it) to the person: a banner
  // at an app, a text or Slack when they are away. Ids only, off the caller's path.
  if (written.written && written.conversationId) {
    deferLogWrite(requestRoute({ userId: approval.userId, workspaceId: approval.workspaceId, conversationId: written.conversationId }, `approval:${args.approvalId}`))
  }
}

/**
 * Who a guest's held call is from (guest access), for the person line above
 * its card in the home thread: the approval's context names the guest; their
 * preset is read here, best effort (the line goes without it). Null for every
 * other approval.
 */
async function guestOfApproval(supabase: SupabaseClient, approval: NewApproval): Promise<GuestAskData | null> {
  const ref = approval.context?.guest
  if (!ref || typeof ref.guestId !== 'string' || typeof ref.name !== 'string') return null
  let preset: string | null = null
  try {
    const { data } = await supabase
      .from('agent_guest')
      .select('preset')
      .eq('id', ref.guestId)
      .eq('owner_user_id', approval.userId)
      .maybeSingle<{ preset: string | null }>()
    preset = data?.preset ?? null
  } catch {
    // The line names them without it.
  }
  return guestRef({ id: ref.guestId, name: ref.name, preset, channel: 'sms', conversation_id: approval.conversationId ?? undefined })
}

async function postHomeResult(
  supabase: SupabaseClient,
  row: Pick<ApprovalRow, 'id' | 'user_id' | 'workspace_id' | 'tool'>,
  outcome: { ran: false; reason: string } | { ran: true; success: boolean; quote: string },
): Promise<void> {
  // The tool's name as code: an mcp__app__tool name read as markdown would turn its underscores into emphasis.
  const tool = `\`${row.tool.replace(/`/g, '')}\``
  const text = !outcome.ran
    ? `I didn't run ${tool}. ${outcome.reason}`
    : [
        outcome.success ? `Done: ${tool} ran after you approved it.` : `${tool} ran after you approved it, but it failed.`,
        outcome.quote ? `What it returned:\n${wrapUntrusted(outcome.quote, 'TOOL')}` : '',
      ].filter(Boolean).join('\n\n')
  await appendHomeMessage(supabase, {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    messageId: `approval-${row.id}`,
    parts: [{ type: 'text', text }],
    metadata: { kind: 'approval_result', approval_id: row.id },
  })
}
