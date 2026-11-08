/**
 * The tool route's guest branch (POST /api/internal/chat/tool with a token
 * carrying `guestId`): a call by the agent the owner made for one person
 * who texts it. Every gate is re-derived from the verified token and the
 * live guest row, never from anything model-visible:
 *
 *   1. the guest is still the owner's, active, and this is their thread
 *      (loadGuestTurn): otherwise 403 GUEST_UNAVAILABLE;
 *   2. the tool is one the owner gave them (guestCeiling): otherwise 403
 *      TOOL_OUT_OF_CEILING;
 *   3. the guest class allows it (caller.ts decideAction 'guest' with their
 *      asks and the owner's per-tool word), and a tool the owner set to Needs
 *      approval (agent_guest.ask_tools, 429) asks whatever the class says: a
 *      deny is 403 CALLER_NOT_ALLOWED. A tool the owner set to Always allow
 *      runs, an outward one or a delete included (Liam, 2026-11-02: the
 *      owner decides; outward tools only start on Needs approval).
 *      An 'ask' on a tool the reviewer doesn't hold (an internal write) is
 *      held as the owner's card all the same (holdEveryCallAs, stored as an
 *      internal write, migration 438);
 *   4. the reviewer's gate with the text-turn hold: every risky call
 *      (external-write, delete) is the OWNER's approval card in their home
 *      thread, never run on a message, except one the owner set to Always
 *      allow for this person (guestCallRuns). A booking carries the
 *      payment stop while "Paying for anything asks you first" is on
 *      (withGuestPaymentStop). Only the owner approves it (caller.ts
 *      mayApprove), and at accept the guest must still hold the tool
 *      (approvals.ts approvalCeilingPermits).
 *
 * The tools run as the owner's (createTools for the owner), with an agent's
 * origin, one hop from the guest's message. get_free_busy runs here: busy
 * blocks only (free-busy.ts); so do the tools every guest's agent holds to
 * reach the owner and remember the person (./reach-owner.ts).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTools } from '@/lib/ai/tools'
import { createSearchToolsTool } from '@/lib/ai/tool-discovery'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import { listCalendarEventsUnified } from '@/lib/integrations/calendar'
import { parseRangeEdge } from '@/lib/integrations/calendar-zone'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { runTool, type ToolCallScope, type ToolDispatchContext } from '@/lib/chat/chat-tool-dispatch'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { holdEveryCallAs, riskClassOf } from '@/lib/safety/action-review'
import type { ApprovalContext } from '@/lib/safety/approvals'
import { callerRefusalMessage, decideAction, policyEffectOf } from '@/lib/safety/caller'
import { busyBlocks } from './free-busy'
import { guestCeiling, loadGuestTurn } from './guest-turn'
import {
  askOwnerAgent,
  askOwnerAgentInputSchema,
  callKeyOf,
  guestVia,
  messageOwner,
  messageOwnerInputSchema,
  rememberAboutGuest,
  rememberAboutGuestInputSchema,
  type GuestChannel,
  type GuestToolScope,
} from './reach-owner'
import type { AgentGuest } from './store'
import { cardContextForHalf } from '@/lib/agent-links/store'
import type { AgentLinkCardContext } from '@/lib/agent-links/views'
import { CUSTOMER_ROUTE_TOOLS, customerToolCall } from '@/lib/customers/customer-tools'

/** The longest range one get_free_busy call reads. */
export const FREE_BUSY_MAX_DAYS = 31
const DAY_MS = 24 * 60 * 60_000

export const freeBusyInputSchema = z.object({
  from: z.string().min(1).max(40).optional().describe('Start of the range: an ISO date (2026-10-27) or date-time. Default: now'),
  to: z.string().min(1).max(40).optional().describe(`End of the range: an ISO date or date-time. Default: 7 days after the start. At most ${FREE_BUSY_MAX_DAYS} days after it`),
})

/** get_free_busy's input as plain JSON Schema, for the guest spec's proxy. */
export const FREE_BUSY_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Start of the range: an ISO date (2026-10-27) or date-time. Default: now' },
    to: { type: 'string', description: `End of the range: an ISO date or date-time. Default: 7 days after the start. At most ${FREE_BUSY_MAX_DAYS} days after it` },
  },
  additionalProperties: false,
} as const

/** The hold for a guest's risky call (by text or on Slack): the owner's card, worded for the guest's agent. */
export function guestTextHold(guestName: string, via: GuestChannel = 'sms'): { reason: string; message: string; cardWhy: string } {
  return {
    reason: 'guest_text',
    message:
      "Nothing ran: this needs the owner's OK, and they now have a card for it in Native Intelligence. It runs once they approve it there. " +
      `Tell ${guestName} you've asked and it isn't done yet. Do not call it again.`,
    cardWhy: `${guestName} asked for it ${guestVia(via)}, and nothing they ask for runs without your OK`,
  }
}

// A range edge as an instant, a bare date at midnight in the zone: shared with
// get_calendar_events (src/lib/integrations/calendar-zone.ts), still exported here.
export { parseRangeEdge }

/** The range a get_free_busy call reads, or an error the model reads. */
export function freeBusyRange(input: z.infer<typeof freeBusyInputSchema>, timeZone: string, now: number): { from: number; to: number } | { error: string } {
  const from = input.from ? parseRangeEdge(input.from, timeZone) : now
  if (from === null) return { error: `Could not read "from" (${input.from}). Use an ISO date like 2026-10-27.` }
  let to = input.to ? parseRangeEdge(input.to, timeZone) : from + 7 * DAY_MS
  if (to === null) return { error: `Could not read "to" (${input.to}). Use an ISO date like 2026-10-28.` }
  // A bare end date means through that whole day.
  if (input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to)) to += DAY_MS
  if (to <= from) return { error: '"to" must be after "from".' }
  if (to - from > FREE_BUSY_MAX_DAYS * DAY_MS) return { error: `That range is too long: ask for at most ${FREE_BUSY_MAX_DAYS} days at a time.` }
  return { from, to }
}

/** get_free_busy for the owner: busy blocks only, in their zone. */
export async function runFreeBusy(
  supabase: SupabaseClient,
  owner: { userId: string; workspaceId: string },
  input: z.infer<typeof freeBusyInputSchema>,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const zone = await readMemberTimeZone(supabase, owner)
  const range = freeBusyRange(input, zone.timeZone, now)
  if ('error' in range) return { success: false, code: 'INPUT_INVALID', message: range.error }
  const timeMin = new Date(range.from).toISOString()
  const timeMax = new Date(range.to).toISOString()
  const events = await listCalendarEventsUnified(owner.userId, { timeMin, timeMax, maxResults: 250, workspaceId: owner.workspaceId })
  const busy = busyBlocks(events, timeMin, timeMax)
  return { success: true, from: timeMin, to: timeMax, time_zone: zone.timeZone, busy, note: busy.length ? 'Busy times only. Any time not listed is free.' : 'Free the whole range.' }
}

/** Where a guest's turn came from: the token's surface (by text unless it is Slack or their agent). */
export function guestChannelOf(claims: Pick<ChatRunTokenClaims, 'surface'>): GuestChannel {
  return claims.surface === 'slack' ? 'slack' : claims.surface === 'dial8' ? 'dial8' : 'sms'
}

/** What a guest's held call records for its accept-time re-check, and (agent links) the link it came over. */
export function guestApprovalContext(guest: Pick<AgentGuest, 'id' | 'displayName'>, agentLink?: AgentLinkCardContext | null): ApprovalContext {
  return { guest: { guestId: guest.id, name: guest.displayName }, tools: { origin: { actor: 'agent', depth: 1 } }, ...(agentLink ? { agentLink } : {}) }
}

/**
 * The dispatch context of a guest's call: the owner's tenancy, the guest
 * class, cards in the owner's home thread. Every risky call is held as the
 * owner's card (the text hold), unless `hold` is false: a call the owner let
 * this person make without asking (see guestCallRuns).
 */
export function guestDispatchContext(
  supabase: SupabaseClient,
  claims: ChatRunTokenClaims,
  guest: AgentGuest,
  agentLink?: AgentLinkCardContext | null,
  hold: boolean = true,
): ToolDispatchContext {
  return {
    supabase,
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    conversationId: claims.conversationId,
    // The guest's thread isn't where the owner reads: the card waits in their home thread.
    cardConversationId: null,
    caller: 'guest',
    approvalContext: guestApprovalContext(guest, agentLink),
    keyScope: `guest:${guest.id}`,
    ...(hold ? { reviewOverride: { alwaysHold: guestTextHold(guest.displayName, guestChannelOf(claims)) } } : {}),
  }
}

/**
 * A call that runs without the owner's card: the owner set this tool to
 * Always allow for this person, so the policy said run (caller.ts
 * decideForGuest `allowed`). Every other risky call keeps the text hold.
 */
export function guestCallRuns(decision: 'run' | 'ask' | 'deny'): boolean {
  return decision === 'run'
}

/** What a booking is told when the person's "Paying for anything asks you first" is on. */
export const GUEST_PAYMENT_STOP =
  'Stop before paying for anything: never confirm a purchase, a payment, a deposit or a checkout, and never use a saved card. ' +
  'If the task needs a payment to finish, stop there and report what it would cost and what is left, so the owner can decide.'

/** Whether "Paying for anything asks you first" is on for this person ('payments' or 'changes'; missing asks read as every ask). */
export function guestPaymentsAsk(askBefore: readonly string[] | null | undefined): boolean {
  const asks = Array.isArray(askBefore) ? askBefore : ['payments']
  return asks.includes('payments') || asks.includes('changes')
}

/**
 * The tools that wait for the owner's card for this person: their Needs
 * approval tools, and a browser task while "Paying for anything asks you
 * first" is on, whatever its own row says. A browser task can reach a
 * checkout, and the payment stop is only words in its goal, so the switch
 * keeps the card (the owner turns the switch off to let it run). Pure.
 */
export function guestCardTools(guest: Pick<AgentGuest, 'tools' | 'askTools' | 'askBefore'>): string[] {
  const browser = guest.tools.includes('run_browser_task') && guestPaymentsAsk(guest.askBefore) && !guest.askTools.includes('run_browser_task')
  return browser ? [...guest.askTools, 'run_browser_task'] : [...guest.askTools]
}

/**
 * A guest's browser task, with the payment stop added to its goal when the
 * person's asks hold 'payments' (guestPaymentsAsk). The owner's card shows
 * the goal as it will run.
 */
export function withGuestPaymentStop(toolName: string, input: unknown, askBefore: readonly string[] | null | undefined): unknown {
  if (toolName !== 'run_browser_task' || !input || typeof input !== 'object') return input
  if (!guestPaymentsAsk(askBefore)) return input
  const goal = (input as { goal?: unknown }).goal
  if (typeof goal !== 'string' || goal.includes(GUEST_PAYMENT_STOP)) return input
  return { ...input, goal: `${goal.trimEnd()}\n\n${GUEST_PAYMENT_STOP}` }
}

/** The tools a guest's agent always holds, run here (./reach-owner.ts). */
const GUEST_REACH_TOOLS: Record<string, { schema: z.ZodTypeAny; run: (supabase: SupabaseClient, scope: GuestToolScope, guest: AgentGuest, input: never) => Promise<Record<string, unknown>> }> = {
  message_owner: { schema: messageOwnerInputSchema, run: (s, scope, guest, input) => messageOwner(s, scope, guest, input) },
  ask_owner_agent: { schema: askOwnerAgentInputSchema, run: (s, scope, guest, input) => askOwnerAgent(s, scope, guest, input) },
  remember_about_guest: { schema: rememberAboutGuestInputSchema, run: (s, scope, guest, input) => rememberAboutGuest(s, scope, guest, input) },
}

/** The tool route's answer to a guest's call (see the header). */
export async function guestToolCall(
  supabase: SupabaseClient,
  claims: ChatRunTokenClaims,
  toolName: string,
  body: ToolCallScope & { input?: unknown },
): Promise<Response> {
  const guest = await loadGuestTurn(supabase, claims)
  if (!guest) {
    return NextResponse.json({ error: 'this person no longer has access to the agent', code: 'GUEST_UNAVAILABLE' }, { status: 403 })
  }
  const ceiling = guestCeiling(guest)
  if (toolName !== 'search_tools' && !ceiling.has(toolName)) {
    return NextResponse.json({ error: `tool '${toolName}' is not in this conversation's ceiling`, code: 'TOOL_OUT_OF_CEILING' }, { status: 403 })
  }
  // A business's customer (roadmap B2): their own tools, scoped to them (src/lib/customers/customer-tools.ts).
  if (guest.preset === 'customer' && CUSTOMER_ROUTE_TOOLS.has(toolName)) return customerToolCall(supabase, claims, guest, toolName, body)
  // Held and not waiting on the owner's card: their Always allow for this person.
  const allowed = ceiling.has(toolName) && !guestCardTools(guest).includes(toolName)
  const classDecision = decideAction('guest', policyEffectOf(toolName), toolName, { guest: { askBefore: guest.askBefore, allowed } })
  // Needs approval (429): the owner's word for this tool, whatever the class would let run.
  const decision = classDecision === 'run' && guestCardTools(guest).includes(toolName) ? 'ask' : classDecision
  if (decision === 'deny') {
    return NextResponse.json({ error: callerRefusalMessage(toolName), code: 'CALLER_NOT_ALLOWED', caller: 'guest' }, { status: 403 })
  }
  // An ask the reviewer wouldn't hold (an internal write): the owner's card all the same.
  const ownersAsk = decision === 'ask' && toolName !== 'search_tools' && !riskClassOf(toolName)

  if (toolName === 'get_free_busy') {
    // Free/busy set to Needs approval: there is no card for a read like this,
    // so it never runs; the agent asks the owner instead.
    if (decision === 'ask') {
      return NextResponse.json(
        { error: 'The owner asks to be checked with before their free times are shared: ask the owner’s agent with ask_owner_agent instead.', code: 'OWNER_ASKS_FIRST' },
        { status: 403 },
      )
    }
    const input = freeBusyInputSchema.safeParse(body.input ?? {})
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    try {
      return NextResponse.json({ output: await runFreeBusy(supabase, { userId: claims.userId, workspaceId: claims.workspaceId }, input.data) })
    } catch (err) {
      console.error('[guest-tool] get_free_busy failed:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not read the calendar right now. Try again in a moment.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }

  const reach = GUEST_REACH_TOOLS[toolName]
  if (reach) {
    const input = reach.schema.safeParse(body.input ?? {})
    if (!input.success) {
      return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(input.error) }, { status: 400 })
    }
    const scope: GuestToolScope = { ownerUserId: claims.userId, workspaceId: claims.workspaceId, conversationId: claims.conversationId, callKey: callKeyOf(body), channel: guestChannelOf(claims) }
    try {
      return NextResponse.json({ output: await reach.run(supabase, scope, guest, input.data as never) })
    } catch (err) {
      console.error(`[guest-tool] ${toolName} failed:`, err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Could not reach the owner right now. Try again in a moment.', code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
    }
  }

  // A customer holds nothing else: no registry tool ever runs for them.
  if (guest.preset === 'customer') {
    return NextResponse.json({ error: `tool '${toolName}' is not in this conversation's ceiling`, code: 'TOOL_OUT_OF_CEILING' }, { status: 403 })
  }

  // A linked agent's turn (surface 'dial8'): its cards name the link and who is on the other side.
  const agentLink = claims.surface === 'dial8' ? await cardContextForHalf(supabase, guest) : null
  const ctx = guestDispatchContext(supabase, claims, guest, agentLink, !guestCallRuns(decision))
  return runTool(
    ctx,
    toolName,
    withGuestPaymentStop(toolName, body.input, guest.askBefore),
    body,
    {
      search_tools: createSearchToolsTool(ceiling),
      ...createTools(claims.userId, supabase, claims.workspaceId, undefined, {
        // The guest's agent acts for the owner: its writes are an agent's, one hop from the guest's message.
        origin: { actor: 'agent', depth: 1 },
        approvalContext: ctx.approvalContext,
        searchDefaultWindow: 'all_time',
      }),
    },
    ownersAsk ? { gate: holdEveryCallAs('internal-write', guestTextHold(guest.displayName, guestChannelOf(claims))) } : {},
  )
}
