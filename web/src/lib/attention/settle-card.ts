/**
 * Settling one attention card (loop-closure Phase 2, Workstream D): the logic
 * behind PATCH /api/account/attention-items, moved here unchanged so the bots
 * v3 Phase 5 `settle_card` tool (src/lib/ai/tools/follow-through.ts) settles a
 * card through EXACTLY the same path a click does (docs/plans/bots-v3.md
 * "Phase 5: tell it what to do next").
 *
 *   accept   DELEGATES to the same apply path a capture proposal uses
 *            (applyChange), with the card's corrected properties folded in, so
 *            the board write is single-source-of-truth. The card flips to
 *            'accepted'.
 *   dismiss  flips the card to 'dismissed'. The backing proposal is left alone
 *            (it stays visible in the capture; the rail just stops nagging),
 *            except behind a WORK card, where it is dismissed too (dismissCard).
 *   start    a work card: files the tracked action and launches its run.
 *
 * OWNER-ONLY. Every card is owned by exactly one member (attention_item.
 * member_id). The route loads the card on the caller's RLS client (owner-only
 * SELECT); a service-role caller (the tool) passes `ownerMemberId`, the
 * caller's own member row in the card's workspace, and the load is fenced on
 * it, so a card that is someone else's is a 404 either way. Every write below
 * is fenced on the card's own member and workspace too, and the caller's
 * membership of the card's workspace is re-verified before anything applies,
 * so a card can never drive a write into a workspace the caller doesn't
 * belong to.
 *
 * Returns the route's own response, so the route and the tool read the same
 * statuses and bodies (409 ALREADY_RESOLVED, 404, 403, ...).
 */
import { normalizeWorkExpects } from '@/lib/work/roles'
import { existsInWorkspace, isAssignableTeammate } from '@/lib/workspace-fences'
import { getServiceClient } from '@/lib/supabase/service'
import { applyChange } from '@/lib/proposed-changes/apply-engine'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { generateOutreachDraft } from '@/lib/email/outreach-draft-generator'
import { fileTrackedAction, launchWorkItem, markProposalApplied, planWorkItem, type WorkItemPlan } from '@/lib/work/start-work-item'
import { startWorkOnMac } from '@/lib/environments/start'
import { startCardCodingRun } from '@/lib/chat/cloud-coding-tools'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { CHATGPT_PLAN_NO_CODING_REASON } from '@/lib/chatgpt/plan-models'
import { parseWorkRunPlace, type WorkRunPlace, type WorkRunWhere } from './work-place'
import { resolveStartTeammate } from '@/lib/work/role-routing'
import { startProvenance } from '@/lib/work/provenance'
import { readDigestOnceSettled } from './read-digest'
import type { WorkProposalPayload } from '@/lib/agent-run/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { approveToolCall, createToolApproval, denyToolCall, expireLapsedApprovals } from '@/lib/safety/approvals'
import { alwaysAllowHeldTool } from '@/lib/mcp-client/always-allow'
import { postDraftFromPayload } from '@/lib/content/post-draft'
import { typefullyCardCopy } from '@/lib/content/typefully'
import { callerClassOf, mayApprove, type Approver, type OutsideChannel } from '@/lib/safety/caller'
import { PROPOSAL_PERSON_ONLY_NOTE, proposalNeedsPerson } from '@/lib/safety/person-only-proposals'

export interface SettleCardBody {
  id?: string
  action?: 'accept' | 'dismiss' | 'start'
  /**
   * Property corrections the user edited on the card before accepting (project,
   * priority, due date, assignee, agent assignee). Folded onto the backing
   * proposal so the created entity reflects what the card shows. Ignored on
   * dismiss.
   */
  corrections?: {
    project_id?: string | null
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
    due_date?: string | null
    assignee_member_id?: string | null
    assignee_ai_member_id?: string | null
  }
  /**
   * W-4c: the action the user picked for a target-less update:action accept. Only
   * consulted on accept; verified (workspace-fenced) to belong to the card's own
   * workspace before it's stamped onto the change and the apply retried. An
   * out-of-workspace or non-existent id is REFUSED (never silently dropped, unlike
   * corrections — a wrong target would mutate the wrong action).
   */
  target_entity_id?: string | null
  /**
   * F4: an approval card for a loop STEP (door 'flow_step') may be edited
   * before it runs: the person's own values for the fields the card shows
   * (approvals.ts acceptableEdit: the same keys, nothing added or dropped).
   * Only on accept, only from the person's own click. Refused on any other card.
   */
  edited_input?: Record<string, unknown>
  /**
   * C2a (P9): a post card's Typefully button. "now" posts it through the
   * person's Typefully, "next_free_slot" adds it to their queue. The click is
   * the person's approval: the server holds the exact post as a tool_approval
   * (the same audit, input hash and run-once claim as any approval card) and
   * runs it at once, as them. Only on accept, only on a post card, only from
   * their own click.
   */
  publish?: 'now' | 'next_free_slot'
  /**
   * An approval card's Always allow (Claude's Allow once / Always allow): run
   * the held call once, as Approve does, then set that connected-app tool to
   * Always allow (mcp-client/always-allow.ts), from what the held call stored,
   * never from this body. Only on accept of an approval card, only from the
   * person's own click (the approval guard above already requires both).
   */
  always_allow?: boolean
  /**
   * Where a work card's Start runs (the card's picker, work-place.ts): one of
   * the person's own shared Mac folders, or a shared cloud environment of the
   * card's workspace on a project's repo. Absent: a Native Intelligence work run, as
   * always. Only on start, only from the person's own click: the model never
   * picks the person's Mac.
   */
  run_in?: unknown
}

/** Who is settling, and how the card load is fenced (see the module doc). */
export interface SettleCardScope {
  /**
   * The caller's member id in the card's workspace, for a SERVICE-ROLE caller:
   * the card load adds `member_id = ownerMemberId`. Absent for the route,
   * whose RLS client already restricts the load to the caller's own cards.
   */
  ownerMemberId?: string
  /**
   * Who is settling. 'person' only for the card's own click (PATCH
   * /api/account/attention-items). An APPROVAL card (A5, a held tool call)
   * is settled ONLY by the person: anything else (the settle_card tool, a
   * bot) is refused, so the model can never approve its own blocked call.
   */
  actor?: 'person'
  /**
   * The person's own click came from an outside channel, verified by that
   * channel's route (Slack: a button pressed by their linked Slack account,
   * src/app/api/slack/interactivity/route.ts). Only with actor 'person'. The
   * approver is then the channel's verified sender as the owner
   * (caller.ts channelCaller), so mayApprove decides exactly as for a click
   * in the app.
   */
  channel?: OutsideChannel
}

/**
 * Settle card `body.id` as user `userId` would by clicking: validate the
 * action against the card, then accept, dismiss or start it. Once it is
 * settled, a run whose last card this was has its digest read
 * (readDigestOnceSettled), so the bot's dot and the banner clear together.
 */
export async function settleAttentionCard(
  supabase: SupabaseClient,
  userId: string,
  body: SettleCardBody,
  scope: SettleCardScope = {},
): Promise<NextResponse> {
  const { id, action } = body
  if (!id || (action !== 'accept' && action !== 'dismiss' && action !== 'start')) {
    return NextResponse.json(
      { error: 'id and action (accept|dismiss|start) are required' },
      { status: 400 },
    )
  }

  // Load the card: the caller's own only. The route's RLS client restricts
  // SELECT to the caller's member rows; a service-role caller fences on its
  // member id (scope.ownerMemberId). maybeSingle → clean 404 on no match (or a
  // card owned by someone else).
  let cardQuery = supabase
    .from('attention_item')
    .select(
      'id, workspace_id, member_id, kind, title, why, status, proposal_id, payload, expires_at',
    )
    .eq('id', id)
  if (scope.ownerMemberId) cardQuery = cardQuery.eq('member_id', scope.ownerMemberId)
  const { data: card } = await cardQuery.maybeSingle<CardRow>()

  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Action/kind compatibility (checked before the pending/expiry guards so a
  // wrong-action call gets a clear 400, not a status 409). `start` is valid
  // ONLY for a work_proposal; `accept` is invalid ON a work_proposal (a work
  // card is Started, never accepted onto the board).
  // An approval card (a held tool call, src/lib/safety/approvals.ts): the
  // person's click alone, and only accept (run it once) or dismiss (deny it).
  if (card.kind === 'approval') {
    // Only the owner's own principal approves (caller.ts mayApprove,
    // decision 11): the person's own click is one; the model's settle_card
    // (actor 'agent') never is, whoever it runs for.
    if (!mayApprove(cardApprover(scope, userId), userId)) {
      return NextResponse.json(
        { error: 'Only the person can approve or decline this, on its card.', code: 'APPROVAL_PERSON_ONLY' },
        { status: 403 },
      )
    }
    if (action !== 'accept' && action !== 'dismiss') {
      return NextResponse.json({ error: 'an approval is accepted or dismissed', code: 'INVALID_ACTION' }, { status: 400 })
    }
  }

  // A card whose proposal runs a connected app's tool (mcp_call): only the
  // person's own click applies it, never the model (settle_card), whatever
  // door it came through. Dismissing stays open to the model.
  if (scope.actor !== 'person' && card.proposal_id && action !== 'dismiss') {
    const { data: proposal, error: proposalError } = await supabase
      .from('proposed_change')
      .select('change_type')
      .eq('id', card.proposal_id)
      .maybeSingle<{ change_type: string | null }>()
    if (proposalError || proposalNeedsPerson(proposal)) {
      return NextResponse.json(
        proposalError
          ? { error: 'Could not check what this card runs, so it was not settled.', code: 'PROPOSAL_UNCHECKED' }
          : { error: PROPOSAL_PERSON_ONLY_NOTE, code: 'PROPOSAL_PERSON_ONLY' },
        { status: proposalError ? 503 : 403 },
      )
    }
  }

  const isWork = card.kind === 'work_proposal'
  if (action === 'start' && !isWork) {
    return NextResponse.json(
      { error: 'start is only valid for a work proposal', code: 'INVALID_ACTION' },
      { status: 400 },
    )
  }
  if (action === 'accept' && isWork) {
    return NextResponse.json(
      { error: 'a work proposal is Started, not accepted', code: 'INVALID_ACTION' },
      { status: 400 },
    )
  }
  let runIn: WorkRunPlace | null = null
  if (body.run_in !== undefined && body.run_in !== null) {
    if (scope.actor !== 'person') {
      return NextResponse.json({ error: 'Only the person picks where work runs, on its card.', code: 'RUN_IN_PERSON_ONLY' }, { status: 403 })
    }
    runIn = action === 'start' ? parseWorkRunPlace(body.run_in) : null
    if (!runIn) {
      return NextResponse.json({ error: 'run_in is a Mac folder or a cloud environment and project, only on start', code: 'INVALID_RUN_IN' }, { status: 400 })
    }
  }

  // Already resolved (accepted/dismissed elsewhere) or expired → 409 so the
  // client drops it cleanly instead of double-acting.
  if (card.status !== 'pending') {
    return NextResponse.json(
      { error: `Card already ${card.status}`, code: 'ALREADY_RESOLVED' },
      { status: 409 },
    )
  }
  if (card.expires_at && Date.parse(card.expires_at) <= Date.now()) {
    // A lapsed approval leaves pending for good (its held call and its card),
    // instead of lingering until the hourly sweep. Best effort.
    if (card.kind === 'approval') {
      await expireLapsedApprovals(getServiceClient(), { cardId: card.id }).catch(() => {})
    }
    return NextResponse.json(
      { error: 'Card has expired', code: 'EXPIRED' },
      { status: 409 },
    )
  }
  if (body.publish !== undefined) {
    // Only the person's own click on their post card sends it anywhere.
    if (scope.actor !== 'person') {
      return NextResponse.json({ error: 'Only the person can post this, on its card.', code: 'POST_PERSON_ONLY' }, { status: 403 })
    }
    if (action !== 'accept' || card.kind !== 'question' || !postDraftFromPayload(card.payload) || (body.publish !== 'now' && body.publish !== 'next_free_slot')) {
      return NextResponse.json({ error: 'publish is only for accepting a post card, now or next_free_slot', code: 'INVALID_ACTION' }, { status: 400 })
    }
    const sent = await publishPostCard(supabase, userId, card, body.publish)
    if (sent.ok) await readDigestOnceSettled(supabase, card)
    return sent
  }
  const res =
    card.kind === 'approval'
      ? action === 'dismiss'
        ? await dismissApprovalCard(supabase, cardApprover(scope, userId)!, card)
        : await acceptApprovalCard(supabase, cardApprover(scope, userId)!, card, body.edited_input, body.always_allow === true && !scope.channel)
      : action === 'dismiss'
      ? await dismissCard(supabase, card)
      : action === 'start'
        ? await startWorkCard(supabase, userId, card, runIn)
        : await acceptCard(supabase, userId, card, body.corrections, body.target_entity_id)
  if (res.ok) await readDigestOnceSettled(supabase, card)
  return res
}

/**
 * Accept an approval card: the server runs the held call once, as the person
 * (approveToolCall re-checks membership and the ceiling first, and posts the
 * result to their home thread). The card settles either way: accepted when
 * the call ran, dismissed when it could not (expired, gone out of reach).
 */
async function acceptApprovalCard(supabase: SupabaseClient, approver: Approver, card: CardRow, editedInput?: unknown, alwaysAllow = false) {
  const outcome =
    editedInput !== undefined
      ? await approveToolCall(getServiceClient(), approver, card, { editedInput })
      : await approveToolCall(getServiceClient(), approver, card)
  if (!outcome.ok) {
    // A refused edit leaves the card waiting (nothing was claimed); anything else settles it.
    if (outcome.status !== 404 && outcome.code !== 'EDIT_REFUSED') await markCardAccepted(supabase, card.id, card.member_id, card.workspace_id, 'dismissed')
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
  }
  await markCardAccepted(supabase, card.id, card.member_id, card.workspace_id, 'accepted')
  // Always allow: the call ran (whatever it answered); now the tool runs without a card.
  if (!alwaysAllow) return NextResponse.json({ ok: true, status: 'executed', success: outcome.success })
  const approvalId = typeof card.payload?.approval_id === 'string' ? card.payload.approval_id : ''
  const alwaysAllowed = await alwaysAllowHeldTool(getServiceClient(), approver.userId, approvalId).catch(() => false)
  return NextResponse.json({ ok: true, status: 'executed', success: outcome.success, always_allowed: alwaysAllowed })
}

/**
 * A post card's Typefully button (C2a): the person's click is their approval
 * of exactly this post. It is held as a tool_approval like any approval card
 * (createToolApproval: the input, its hash, the caps), then approved at once
 * by their own principal (approveToolCall: run once, the ceiling and
 * membership re-checked, the result in their home thread), and the held
 * call's own card settles with it.
 *
 * The post card is CLAIMED first, atomically (pending → accepted by
 * compare-and-swap): a second click (two tabs, the desktop app and the web,
 * the rail and the column) finds it taken and gets a 409, so one card never
 * posts twice (P9 review B1). It goes back to waiting ONLY when the post
 * provably never reached Typefully: nothing was held, a re-check refused it,
 * or the adapter stopped before its create call (NEVER_SENT_CODES). Anything
 * else (Typefully refused it, a throw mid-call) leaves it settled with the
 * reason: it may have gone out, and a retry could post it twice.
 */
async function publishPostCard(supabase: SupabaseClient, userId: string, card: CardRow, when: 'now' | 'next_free_slot') {
  const draft = postDraftFromPayload(card.payload)
  if (!draft) return NextResponse.json({ error: 'Not a post card', code: 'INVALID_ACTION' }, { status: 400 })
  const { data: claimed } = await supabase
    .from('attention_item')
    .update({ status: 'accepted', resolved_at: new Date().toISOString() })
    .eq('id', card.id)
    .eq('status', 'pending')
    .eq('member_id', card.member_id)
    .eq('workspace_id', card.workspace_id)
    .select('id')
  if (!claimed?.length) return NextResponse.json({ error: 'This post is already being sent, or was settled.', code: 'ALREADY_RESOLVED' }, { status: 409 })
  const reopen = async () => {
    await supabase
      .from('attention_item')
      .update({ status: 'pending', resolved_at: null })
      .eq('id', card.id)
      .eq('status', 'accepted')
      .eq('member_id', card.member_id)
      .eq('workspace_id', card.workspace_id)
  }
  const service = getServiceClient()
  const tool = when === 'now' ? 'publish_post' : 'schedule_post'
  const input = {
    surface: draft.surface,
    text: draft.text,
    ...(draft.typefully_account_id !== null ? { account_id: draft.typefully_account_id } : {}),
    ...(draft.typefully_account ? { account: draft.typefully_account } : {}),
  }
  const held = await createToolApproval(service, {
    door: 'chat',
    userId,
    workspaceId: card.workspace_id,
    toolName: tool,
    sideEffect: 'external-write',
    input,
    reason: 'post_card',
    card: typefullyCardCopy(tool, input),
    // The account this card resolved and showed: the send may honour it (content.ts).
    context: { postCard: true },
    // This click is the approval: nothing to ask in the home thread.
    announce: false,
  })
  if (!held.ok) {
    await reopen()
    const error = held.code === 'TOO_MANY_PENDING' ? 'You have too many approvals waiting: answer some of them in your chat first. Nothing was posted.' : held.error
    return NextResponse.json({ error, code: held.code }, { status: held.code === 'NOT_A_MEMBER' ? 403 : 409 })
  }
  const approver: Approver = { callerClass: callerClassOf({ kind: 'app_session' }), userId }
  let outcome: Awaited<ReturnType<typeof approveToolCall>>
  try {
    outcome = await approveToolCall(service, approver, { workspace_id: card.workspace_id, payload: { approval_id: held.approvalId } })
  } catch (err) {
    // Unknown whether it went out: the card stays settled, never retried into a double post.
    await markCardAccepted(supabase, held.cardId, card.member_id, card.workspace_id, 'dismissed')
    return NextResponse.json(
      { error: `Something went wrong while sending; check your Typefully before trying again (${err instanceof Error ? err.message : String(err)}).`, code: 'TYPEFULLY_UNKNOWN' },
      { status: 502 },
    )
  }
  // The held call's own card was this click: it settles with it.
  await markCardAccepted(supabase, held.cardId, card.member_id, card.workspace_id, outcome.ok && outcome.success ? 'accepted' : 'dismissed')
  if (!outcome.ok) {
    // Refused before it ran (a re-check, an expiry): nothing reached Typefully.
    await reopen()
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
  }
  if (!outcome.success) {
    const r = (outcome.result ?? {}) as { error?: unknown; code?: unknown }
    const code = typeof r.code === 'string' ? r.code : 'TYPEFULLY_FAILED'
    if (NEVER_SENT_CODES.has(code)) await reopen()
    return NextResponse.json({ error: typeof r.error === 'string' ? r.error : 'Typefully did not take it.', code }, { status: 502 })
  }
  const message = (outcome.result as { message?: unknown } | null)?.message
  return NextResponse.json({ ok: true, status: when === 'now' ? 'posted' : 'queued', message: typeof message === 'string' ? message : null })
}

/** Failures that provably stopped before the post reached Typefully: only these put the card back. */
export const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  'NOT_CONNECTED',
  'TOOL_NOT_FOUND',
  'TOOL_OFF',
  'NO_SOCIAL_SET',
  'NEEDS_ACCOUNT',
  'SHAPE_MISMATCH',
  'NOT_PUBLIC_SAFE',
  'APPROVAL_REQUIRED',
])

/** Dismiss an approval card: the card is dismissed and its held call denied (never run). */
async function dismissApprovalCard(supabase: SupabaseClient, approver: Approver, card: CardRow) {
  const res = await dismissCard(supabase, card)
  if (res.ok) await denyToolCall(getServiceClient(), approver, card)
  return res
}

/**
 * Who is answering an approval card, for the trust authority: the person's
 * own click on their app session is the person; their own click in an
 * outside channel is the channel's verified owner (a linked Slack account:
 * the person); the model (settle_card, as actor 'agent') is no approver at all.
 */
function cardApprover(scope: SettleCardScope, userId: string): Approver | null {
  if (scope.actor !== 'person') return null
  if (scope.channel) {
    const callerClass = callerClassOf({ kind: 'channel', channel: scope.channel, ownerUserId: userId, senderUserId: userId, senderIsMember: true, place: 'direct' })
    return { callerClass, userId }
  }
  return { callerClass: callerClassOf({ kind: 'app_session' }), userId }
}

/** Dismiss: flip the card to 'dismissed'. CAS on status='pending' so a
 *  concurrent resolve doesn't double-write.
 *
 *  The backing proposal is untouched — it stays in the capture; the rail just
 *  stops surfacing it — EXCEPT behind a work card. Triage leaves a draftable
 *  commitment's proposal pending as its work's anchor (migration 285), so a
 *  work card dismissed with its proposal still pending would be proposed
 *  again by the next triage pass over the queue (the daily sweep) until the
 *  30-day stale rule cleared it. Dismissing the work IS the user's answer to
 *  the proposal, so it closes the proposal too. */
async function dismissCard(
  supabase: SupabaseClient,
  card: Pick<CardRow, 'id' | 'workspace_id' | 'member_id' | 'kind' | 'proposal_id'>,
) {
  const { data, error } = await supabase
    .from('attention_item')
    .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
    .eq('id', card.id)
    .eq('status', 'pending')
    .eq('member_id', card.member_id)
    .eq('workspace_id', card.workspace_id)
    .select('id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    // Lost the CAS — another turn resolved it first.
    return NextResponse.json(
      { error: 'Card already resolved', code: 'ALREADY_RESOLVED' },
      { status: 409 },
    )
  }
  if (card.kind === 'work_proposal' && card.proposal_id) {
    await dismissProposalBehindWorkCard(card.proposal_id, card.workspace_id)
  }
  return NextResponse.json({ ok: true, status: 'dismissed' })
}

/**
 * Dismiss the pending proposal behind a dismissed work card, the way a triage
 * dismiss writes it (verdict-apply markDismissed: status + extra.dismiss_reason).
 * The SERVICE client, fenced on the card's own workspace (the card came back
 * under the caller's RLS, so the caller owns it; Start's proposal CAS runs on
 * the same client). Best-effort: the card is already dismissed and a failed
 * write here is logged, never surfaced — the proposal then ages out as before.
 */
async function dismissProposalBehindWorkCard(proposalId: string, workspaceId: string): Promise<void> {
  try {
    const service = getServiceClient()
    const { data: proposal, error: readErr } = await service
      .from('proposed_change')
      .select('id, extra')
      .eq('id', proposalId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .maybeSingle()
    if (readErr) throw new Error(readErr.message)
    if (!proposal) return // already resolved elsewhere
    const extra = (proposal.extra && typeof proposal.extra === 'object' ? proposal.extra : {}) as Record<string, unknown>
    const { error } = await service
      .from('proposed_change')
      .update({ status: 'dismissed', extra: { ...extra, dismiss_reason: 'Work card dismissed' } })
      .eq('id', proposalId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error('[attention-items] could not dismiss the proposal behind a work card:', proposalId, err instanceof Error ? err.message : err)
  }
}

/**
 * Start a work_proposal card: resolve the card, file a TRACKED action on the
 * board, create a generalized agent_run (kind='workspace'), and dispatch the
 * durable eve work session via Inngest. When the run delivers, the outcome
 * route moves the tracked action to REVIEW, never Done; the person's Reviewed
 * on the job marks it Done (decision 9, src/lib/actions/agent-finish.ts).
 *
 * Sequence (mirrors the accept path's fencing — WORK-PROPOSALS-DESIGN.md §Start):
 *   1. Re-verify caller membership on the CARD's OWN workspace (not the active
 *      one) and resolve their member id THERE (authorship stamp).
 *   2. CAS the card pending→accepted (the run is the live object from here).
 *   3. Create the tracked action (title=card.title, description=payload.task,
 *      context_data={work_run, attention_item_id}, OMIT source_type (it keeps
 *      its default, 'user'; its CHECK refuses a value it does not list),
 *      agent_run_status='starting', default workflow state).
 *   4. Best-effort CAS the backing proposed_change pending→applied with
 *      result_entity_id=action id (the proposal became real tracked work). Never
 *      fail Start on this.
 *   5. Insert the agent_run (kind='workspace', queued, task_prompt, resources
 *      snapshot, attention_item_id, proposal_id, triggered_by).
 *   6. Emit Inngest work/run.requested { agent_run_id, workspace_id } (event id
 *      work-run-requested:<run id>, so a re-emit for the same run is dropped).
 *   Steps 3–6 live in src/lib/work/start-work-item.ts (launchWorkItem), shared
 *   with the auto-attempt gate; the route keeps the card's claim and revert.
 *   7. Respond { ok, status:'started', agent_run_id, entity_id, entity_kind:
 *      'action', identifier }.
 */
async function startWorkCard(
  supabase: SupabaseClient,
  userId: string,
  card: CardRow,
  runIn: WorkRunPlace | null = null,
) {
  const workspaceId = card.workspace_id

  // 1. Re-verify membership on the card's workspace + resolve the member id there.
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) {
    return NextResponse.json(
      { error: 'Not a member of this card’s workspace' },
      { status: 403 },
    )
  }

  // `card.payload` is a shape-checked jsonb blob (Record<string,unknown>), so we
  // read it as a Partial — every field is optional here and the task-presence
  // check below narrows it before we rely on `task`. Downstream reads
  // (payload.resources) already tolerate absence.
  const payload = (card.payload ?? {}) as Partial<WorkProposalPayload>
  const task = typeof payload.task === 'string' ? payload.task : ''
  if (!task.trim()) {
    return NextResponse.json(
      { error: 'This work card has no task to run', code: 'NO_TASK' },
      { status: 400 },
    )
  }

  // 2. Resolve everything FALLIBLE-BUT-PURE (no writes) BEFORE the card CAS, so a
  //    pure-lookup failure never consumes the card: the team/default-state lookup
  //    and the resource snapshot (each id re-validated against the card's OWN
  //    workspace). Only after they succeed do we claim the card.
  const plan = await planWorkItem(supabase as unknown as SupabaseClient, {
    workspaceId,
    resources: payload.resources,
  })
  if (!plan) {
    // No team / default state — can't file the tracked action. The card is STILL
    // pending (we haven't claimed it), so this is a clean retryable error.
    return NextResponse.json(
      { error: 'No team or default workflow state for this workspace', code: 'NO_DEFAULT_STATE' },
      { status: 500 },
    )
  }

  // The place the person picked on the card: their Mac, or a cloud environment.
  if (runIn) {
    return startWorkCardIn(supabase, userId, member.id, card, {
      task,
      plan,
      title: (card.title && card.title.trim()) || task.slice(0, 200),
    }, runIn)
  }

  // Who does it, and where it came from (B PR 4) — pure reads, fail-soft to
  // "no one" / "nothing", so neither can block a Start. The teammate is the one
  // the card names, else its role's default among the teammates this person can
  // see (role-routing.ts); the run then carries that teammate's persona. The
  // provenance becomes the brief's source quote and capture excerpt.
  const sb = supabase as unknown as SupabaseClient
  const [teammate, provenance] = await Promise.all([
    resolveStartTeammate(sb, { workspaceId, payload }),
    startProvenance(sb, { workspaceId, proposalId: card.proposal_id, payload, why: card.why ?? null }),
  ])

  // 3. CAS the card pending→accepted (Start resolves it onto the run). Do this
  //    only AFTER the pure lookups above — the one-pending-card-per-proposal uidx
  //    makes this the claim point; a loser (concurrent Start) gets a clean 409.
  if (!(await claimWorkCard(supabase, card, member.id))) return alreadyResolved()

  // 4–7. File the tracked action, insert the run, open its ledger row, mark the
  //    backing proposal applied, dispatch (src/lib/work/start-work-item.ts — the
  //    same body the auto-attempt gate starts work through). A failure there has
  //    already compensated its own writes; the card goes back to pending so
  //    approved work isn't silently dropped and a retry sees a fresh card.
  const launched = await launchWorkItem(supabase as unknown as SupabaseClient, getServiceClient(), {
    workspaceId,
    userId,
    memberId: member.id,
    title: (card.title && card.title.trim()) || task.slice(0, 200),
    task,
    plan,
    attentionItemId: card.id,
    proposalId: card.proposal_id,
    ledgerTitle: card.title,
    ...(teammate ? { aiTeamMemberId: teammate.id } : {}),
    ...(provenance ? { provenance } : {}),
    expects: normalizeWorkExpects(payload.expects),
  })
  if (!launched.ok) {
    await revertClaimedCard(supabase, card.id, member.id, workspaceId)
    return NextResponse.json(
      launched.stage === 'dispatch'
        ? { error: launched.error, code: 'DISPATCH_FAILED' }
        : { error: launched.error },
      { status: 500 },
    )
  }

  // 8. Started.
  return NextResponse.json({
    ok: true,
    status: 'started',
    agent_run_id: launched.agentRunId,
    entity_id: launched.actionId,
    entity_kind: 'action',
    identifier: launched.identifier,
  })
}

/** Claim a pending work card for its Start (pending → accepted), fenced to its owner and workspace. */
async function claimWorkCard(supabase: SupabaseClient, card: CardRow, memberId: string): Promise<boolean> {
  const { data: claimedCard } = await supabase
    .from('attention_item')
    .update({ status: 'accepted', resolved_at: new Date().toISOString() })
    .eq('id', card.id)
    .eq('status', 'pending')
    .eq('member_id', memberId)
    .eq('workspace_id', card.workspace_id)
    .select('id')
    .maybeSingle()
  return !!claimedCard
}

function alreadyResolved() {
  return NextResponse.json({ error: 'Card already resolved', code: 'ALREADY_RESOLVED' }, { status: 409 })
}

/**
 * Start a work card in the place the person picked on it (work-place.ts),
 * after startWorkCard's membership, task and plan checks. The card is claimed
 * first, as every Start claims it; anything that doesn't start puts it back
 * (and takes back the action it filed), with the sentence the person reads.
 *
 *   mac    the card's tracked action (fileTrackedAction, as a Native Intelligence run files
 *          it), then a job in their folder on their Mac (startWorkOnMac:
 *          their own folder, online, unattended, the title and task fenced);
 *   cloud  a coding run in the cloud environment, on the project's repo
 *          (startCardCodingRun files the action in the project, as the chat's
 *          coding run does). Never on a person's own ChatGPT plan.
 *
 * The backing proposal is marked applied once it started, as a Native Intelligence run's is.
 */
async function startWorkCardIn(
  supabase: SupabaseClient,
  userId: string,
  memberId: string,
  card: CardRow,
  work: { task: string; plan: WorkItemPlan; title: string },
  runIn: WorkRunPlace,
) {
  const workspaceId = card.workspace_id
  // A coding run is NI-paid compute in a cloud sandbox (start-agent's rule).
  if (runIn.kind === 'cloud' && (await chatgptPlanFor(userId))) {
    return NextResponse.json({ error: CHATGPT_PLAN_NO_CODING_REASON, code: 'CHATGPT_PLAN_NO_CODING' }, { status: 403 })
  }
  if (!(await claimWorkCard(supabase, card, memberId))) return alreadyResolved()
  const service = getServiceClient()
  const giveBack = () => revertClaimedCard(supabase, card.id, memberId, workspaceId)
  const applied = async (actionId: string) => {
    if (card.proposal_id) await markProposalApplied(supabase, { workspaceId, proposalId: card.proposal_id, memberId, actionId })
  }

  if (runIn.kind === 'mac') {
    const filed = await fileTrackedAction(supabase, { workspaceId, userId, plan: work.plan, title: work.title, task: work.task, attentionItemId: card.id })
    if (!filed.ok) {
      await giveBack()
      return NextResponse.json({ error: filed.error }, { status: 500 })
    }
    // Taken back on the service client: a member's own client may not delete
    // actions (actions_delete is owners' and admins'), and RLS would skip the
    // row without an error, leaving it on the board 'starting'. Fenced on the
    // action this Start filed: its id, workspace and author.
    const dropAction = async () => {
      const { data, error } = await service
        .from('actions')
        .delete()
        .eq('id', filed.actionId)
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .select('id')
      if (error || !data?.length) {
        console.error('[attention-items] taking back an unstarted work card action failed:', filed.actionId, error?.message ?? 'no row')
      }
    }
    let onMac: Awaited<ReturnType<typeof startWorkOnMac>>
    try {
      onMac = await startWorkOnMac(service, {
        userId,
        workspaceId,
        folderId: runIn.folder_id,
        action: { id: filed.actionId, identifier: filed.identifier, title: work.title, task: work.task },
      })
    } catch (err) {
      console.error('[attention-items] work card Mac start failed:', err instanceof Error ? err.message : err)
      await dropAction()
      await giveBack()
      return NextResponse.json({ error: 'Could not start it on your Mac. Try again.' }, { status: 500 })
    }
    if (onMac.status === 'refused') {
      await dropAction()
      await giveBack()
      return NextResponse.json({ error: onMac.reason, code: onMac.code }, { status: onMac.httpStatus })
    }
    await applied(filed.actionId)
    const where: WorkRunWhere = { kind: 'mac', mac: onMac.mac, folder: onMac.folder, edits: onMac.edits, session_id: onMac.sessionId }
    return NextResponse.json({ ok: true, status: 'started', entity_id: filed.actionId, entity_kind: 'action', identifier: filed.identifier, where })
  }

  let out: Record<string, unknown>
  try {
    out = await startCardCodingRun(
      service,
      { userId, workspaceId },
      { projectId: runIn.project_id, environmentId: runIn.environment_id, title: work.title, request: work.task, attentionItemId: card.id },
    )
  } catch (err) {
    console.error('[attention-items] work card cloud start failed:', err instanceof Error ? err.message : err)
    await giveBack()
    return NextResponse.json({ error: 'Could not start it in the cloud. Try again.' }, { status: 500 })
  }
  const action = out.action as { id?: string; identifier?: string | null } | undefined
  if (out.status !== 'started' || !action?.id) {
    await giveBack()
    return NextResponse.json({ error: String(out.reason ?? 'Could not start it in the cloud.'), code: String(out.code ?? 'NOT_STARTED') }, { status: 409 })
  }
  await applied(action.id)
  const env = out.environment as { name?: string } | undefined
  const where: WorkRunWhere = { kind: 'cloud', environment: env?.name ?? 'the cloud', repo: String(out.repo ?? '') }
  return NextResponse.json({
    ok: true,
    status: 'started',
    agent_run_id: out.agent_run_id,
    entity_id: action.id,
    entity_kind: 'action',
    identifier: action.identifier ?? action.id,
    where,
  })
}

/**
 * Revert a card we CAS'd pending→accepted back to pending on a post-CAS failure,
 * so approved work isn't silently dropped and a retry sees a fresh pending card
 * (not a 409). CAS on status='accepted' + owner + workspace — a card someone else
 * has since re-resolved is left alone. Mirrors the accept path's revert discipline
 * (which flips the backing proposed_change back to pending on apply failure).
 * The realtime UPDATE this produces re-adds the card on every device (the hook
 * upserts a card that lands pending).
 */
async function revertClaimedCard(
  supabase: SupabaseClient,
  cardId: string,
  memberId: string,
  workspaceId: string,
) {
  await supabase
    .from('attention_item')
    .update({ status: 'pending', resolved_at: null })
    .eq('id', cardId)
    .eq('status', 'accepted')
    .eq('member_id', memberId)
    .eq('workspace_id', workspaceId)
}

type CardRow = {
  id: string
  workspace_id: string
  member_id: string
  kind: string
  title: string | null
  why?: string | null
  status: string
  proposal_id: string | null
  payload: Record<string, unknown> | null
  expires_at: string | null
}

/**
 * Accept: apply the backing proposal via the shared apply-engine (single source
 * of truth for board writes), then flip the card to 'accepted'.
 *
 * Fenced on the CARD's OWN workspace_id, with the caller's membership re-verified
 * — a card can only ever drive a write into a workspace the caller belongs to.
 */
async function acceptCard(
  supabase: SupabaseClient,
  userId: string,
  card: CardRow,
  corrections?: SettleCardBody['corrections'],
  targetEntityId?: string | null,
) {
  const workspaceId = card.workspace_id

  // Re-verify the caller is a member of the card's workspace and resolve their
  // member id THERE (the apply-engine stamps authorship with it). RLS proved the
  // card is theirs; this proves they can write into its workspace.
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) {
    return NextResponse.json(
      { error: 'Not a member of this card’s workspace' },
      { status: 403 },
    )
  }

  // W-4c: the user picked a target action for a target-less update. VERIFY it
  // belongs to the card's OWN workspace before we trust it — a client-supplied
  // id must never mutate an action in a workspace the caller can see elsewhere.
  // A bad id is REFUSED (a wrong update target is worse than no update), unlike
  // property corrections which silently drop. Stamped onto the change below.
  if (targetEntityId != null) {
    if (typeof targetEntityId !== 'string' || !targetEntityId.trim()) {
      return NextResponse.json(
        { error: 'target_entity_id must be a non-empty string' },
        { status: 400 },
      )
    }
    const { data: targetAction } = await supabase
      .from('actions')
      .select('id')
      .eq('id', targetEntityId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!targetAction) {
      return NextResponse.json(
        {
          error: 'That action is not in this workspace',
          code: 'TARGET_NOT_IN_WORKSPACE',
        },
        { status: 400 },
      )
    }
  }

  // A pure question card (no backing proposal) can't be "accepted" onto the
  // board — it's acknowledged. Treat accept as a resolve so it leaves the rail.
  if (!card.proposal_id) {
    return resolveAcknowledged(supabase, card, member.id)
  }

  // Load the backing proposal, fenced to the card's workspace. It must still be
  // pending — if a prior card-accept / capture-accept already applied it, this is
  // a no-op resolve (the work exists), not a 500.
  const { data: rawChange } = await supabase
    .from('proposed_change')
    .select('*')
    .eq('id', card.proposal_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!rawChange) {
    return NextResponse.json({ error: 'Backing proposal not found' }, { status: 404 })
  }
  const change = rawChange as unknown as ProposedChange

  // A draft_email card backed by a send_email proposal produces a FILLED email
  // draft on accept (WS-2a): the claim-then-apply flow below creates the shell,
  // then the generator writes its body. Computed once, used in three branches.
  const isDraftEmail = card.kind === 'draft_email' && change.change_type === 'send_email'

  if (change.status !== 'pending') {
    // RETRY (WS-2a): a draft_email whose shell already exists — proposal applied,
    // draft_id stamped by a prior failed generation — re-runs generation into
    // that SAME shell, never creating a new draft. This replaces the generic
    // resolve for this case ONLY; every other already-resolved outcome below is
    // unchanged.
    if (isDraftEmail && change.status === 'applied') {
      const existingDraftId = draftIdFromPayload(card.payload)
      if (existingDraftId) {
        return fillDraftAndRespond(supabase, card, member.id, workspaceId, existingDraftId, change)
      }
    }

    // The proposal is already resolved (accepted from the capture, or a
    // concurrent card-accept). Resolve the card to match, HONESTLY: an already-
    // APPLIED proposal means the work exists → 'accepted'; an already-DISMISSED
    // one means nothing was created → 'dismissed' (don't claim we accepted it).
    const applied = change.status === 'applied'
    await markCardAccepted(
      supabase,
      card.id,
      member.id,
      workspaceId,
      applied ? 'accepted' : 'dismissed',
    )
    const entityId = applied ? change.result_entity_id ?? null : null
    return NextResponse.json({
      ok: true,
      status: applied ? 'accepted' : 'dismissed',
      note: `proposal already ${change.status}`,
      entity_id: entityId,
      ...(applied ? await buildReceipt(supabase, change, workspaceId, entityId) : {}),
    })
  }

  // CLAIM-THEN-APPLY. The old order (apply → CAS) had a TOCTOU: two concurrent
  // accepts both read status='pending', both called applyChange, and BOTH
  // created a board entity (the CAS only decided who stamped the proposal). For
  // an external side effect (send_email / mcp_call) that meant the effect fired
  // TWICE, unrecoverably. So we CLAIM the proposal FIRST — atomically flip
  // pending→applied guarded on status='pending' — and only the winner proceeds
  // to applyChange. A loser never touches the board. (Adversarial review: the
  // apply-then-CAS double-create.)
  const { data: claimed } = await supabase
    .from('proposed_change')
    .update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: member.id })
    .eq('id', change.id)
    .eq('status', 'pending')
    .eq('workspace_id', workspaceId)
    .select('id')
    .maybeSingle()

  if (!claimed) {
    // Lost the claim — another turn is applying (or applied) it. Do NOT apply.
    // Re-read to report the honest outcome.
    const { data: after } = await supabase
      .from('proposed_change')
      .select('status, result_entity_id')
      .eq('id', change.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const applied = after?.status === 'applied'
    await markCardAccepted(
      supabase,
      card.id,
      member.id,
      workspaceId,
      applied ? 'accepted' : 'dismissed',
    )
    const entityId = applied ? after?.result_entity_id ?? null : null
    return NextResponse.json({
      ok: true,
      status: applied ? 'accepted' : 'dismissed',
      note: 'applied by another turn',
      entity_id: entityId,
      ...(applied ? await buildReceipt(supabase, change, workspaceId, entityId) : {}),
    })
  }

  // We own the claim. Fold the card's corrections onto the change (mirrors the
  // capture card's onEdit → apply) and apply exactly once.
  const corrected = await applyValidatedCorrections(supabase, change, workspaceId, corrections)
  // W-4c: stamp the user-picked, workspace-verified target so updateAction applies
  // to THAT action deterministically instead of re-running (and re-failing) the
  // fuzzy resolver. Only set for a target-less update — a proposal that already
  // has an entity_id keeps it.
  if (targetEntityId != null && !corrected.entity_id) {
    corrected.entity_id = targetEntityId
  }
  const result = await applyChange(supabase, corrected, workspaceId, member.id, userId)

  if (!result.success) {
    // Apply failed AFTER we claimed. Revert the claim to pending so the item
    // isn't stuck 'applied' with no entity, and record the error (mirrors the
    // capture apply route). The card stays pending so it can be retried.
    await supabase
      .from('proposed_change')
      .update({ status: 'pending', applied_at: null, applied_by: null, error_message: result.error })
      .eq('id', change.id)
      .eq('status', 'applied')
      .eq('workspace_id', workspaceId)
    // W-4c: a target-less update reached here because its target couldn't be
    // resolved (and the user didn't pick one, or the picked one didn't stick).
    // This is NOT a hard failure — it's a rescuable card. Return a 409 with the
    // code so the client opens the action picker and retries with target_entity_id
    // instead of surfacing a dead "could not accept" toast. The claim is already
    // reverted, so the card is pending and retryable.
    if (result.code === 'UPDATE_TARGET_UNRESOLVED') {
      return NextResponse.json(
        { error: result.error, code: 'UPDATE_TARGET_UNRESOLVED' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  // Success — stamp the created entity id + any normalized change_type onto the
  // (already-claimed) proposal. Also clear any stale error_message from a prior
  // failed attempt: the claim above flipped pending→applied but carried the old
  // error forward, and this is the point where the apply is confirmed durable.
  const entityId = result.entity_id ?? null
  await supabase
    .from('proposed_change')
    .update({
      result_entity_id: entityId,
      error_message: null,
      ...(result.applied_change_type ? { change_type: result.applied_change_type } : {}),
      ...(result.applied_entity_type ? { entity_type: result.applied_entity_type } : {}),
    })
    .eq('id', change.id)
    .eq('workspace_id', workspaceId)

  // A draft_email accept just created its email_draft SHELL (entity_id = draft
  // id, body NULL — apply-engine sendEmail). FILL it before the card resolves; a
  // generation failure keeps the card pending for retry, never a silent empty
  // shell (WS-2a).
  if (isDraftEmail && entityId) {
    return fillDraftAndRespond(supabase, card, member.id, workspaceId, entityId, change)
  }

  await markCardAccepted(supabase, card.id, member.id, workspaceId, 'accepted')
  return NextResponse.json({
    ok: true,
    status: 'accepted',
    entity_id: entityId,
    ...(await buildReceipt(supabase, change, workspaceId, entityId)),
  })
}

/** A question card with no backing proposal: accept = acknowledge → resolve. */
async function resolveAcknowledged(
  supabase: SupabaseClient,
  card: CardRow,
  memberId: string,
) {
  await markCardAccepted(supabase, card.id, memberId, card.workspace_id, 'accepted')
  return NextResponse.json({ ok: true, status: 'accepted' })
}

/** Flip the card to a terminal status. CAS on pending + owner + workspace. */
async function markCardAccepted(
  supabase: SupabaseClient,
  cardId: string,
  memberId: string,
  workspaceId: string,
  status: 'accepted' | 'dismissed',
) {
  await supabase
    .from('attention_item')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', cardId)
    .eq('status', 'pending')
    .eq('member_id', memberId)
    .eq('workspace_id', workspaceId)
}

/**
 * The accept receipt (WS-1c). `entity_kind` is the kind the accept produced —
 * 'email_draft' for a send_email proposal, otherwise the proposal's entity_type.
 * For a created action we also return its human identifier (e.g. GEN-42), fetched
 * with one cheap workspace-fenced select, so the client can say "GEN-42 created".
 */
async function buildReceipt(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  entityId: string | null,
): Promise<{ entity_kind: string; identifier?: string }> {
  const entityKind = change.change_type === 'send_email' ? 'email_draft' : change.entity_type
  if (change.entity_type === 'action' && entityId) {
    const { data } = await supabase
      .from('actions')
      .select('identifier')
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (data?.identifier) return { entity_kind: entityKind, identifier: data.identifier as string }
  }
  return { entity_kind: entityKind }
}

/** Read a previously-stamped draft id off the card payload (WS-2a retry key). */
function draftIdFromPayload(payload: Record<string, unknown> | null): string | null {
  const id = payload?.draft_id
  return typeof id === 'string' && id ? id : null
}

/**
 * Fill a just-created (or retried) email_draft shell via the outreach generator,
 * then resolve the card (WS-2a). On success the card flips to 'accepted' and we
 * return a 'draft_ready' receipt deep-linking the internal draft. On generation
 * FAILURE the shell + already-applied proposal survive, so we stamp
 * payload.draft_id and LEAVE the card pending — returning 502
 * DRAFT_GENERATION_FAILED so the UI offers a retry that re-enters this same shell.
 */
async function fillDraftAndRespond(
  supabase: SupabaseClient,
  card: CardRow,
  memberId: string,
  workspaceId: string,
  draftId: string,
  change: ProposedChange,
) {
  const gen = await generateOutreachDraft(supabase, workspaceId, draftId, {
    to_name: change.email_to_name,
    to_address: change.email_to_address,
    subject: change.email_subject,
    email_context: change.email_context,
    trigger_quote: change.trigger_quote,
    capture_id: change.capture_id,
  })

  if (!gen.success) {
    await stampDraftIdOnCard(supabase, card, memberId, workspaceId, draftId)
    return NextResponse.json(
      {
        error: gen.error ?? 'Draft generation failed',
        code: 'DRAFT_GENERATION_FAILED',
        draft_id: draftId,
      },
      { status: 502 },
    )
  }

  await markCardAccepted(supabase, card.id, memberId, workspaceId, 'accepted')
  return NextResponse.json({
    ok: true,
    status: 'draft_ready',
    entity_id: draftId,
    entity_kind: 'email_draft',
    draft_id: draftId,
  })
}

/** Merge payload.draft_id onto the STILL-pending card so a retry accept knows
 *  which shell to re-fill. CAS on pending + owner + workspace (a resolved card is
 *  left alone). */
async function stampDraftIdOnCard(
  supabase: SupabaseClient,
  card: CardRow,
  memberId: string,
  workspaceId: string,
  draftId: string,
) {
  const nextPayload = { ...(card.payload ?? {}), draft_id: draftId }
  await supabase
    .from('attention_item')
    .update({ payload: nextPayload })
    .eq('id', card.id)
    .eq('status', 'pending')
    .eq('member_id', memberId)
    .eq('workspace_id', workspaceId)
}

/**
 * Fold the card's edited properties onto the proposal before applying — but
 * VALIDATE every referenced entity belongs to the card's own workspace first.
 * The corrections come from the client; without this a caller could stamp a
 * project / member / agent id from a DIFFERENT workspace (one they can see
 * elsewhere) onto the action being created here. Any id that doesn't resolve in
 * this workspace is dropped, not applied. (Adversarial review: cross-workspace
 * corrections.) Priority (an enum) and due_date (a string) carry no tenancy.
 */
async function applyValidatedCorrections(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  corrections?: SettleCardBody['corrections'],
): Promise<ProposedChange> {
  if (!corrections) return change
  const next: ProposedChange = { ...change }

  if (corrections.priority !== undefined) next.priority = corrections.priority
  if (corrections.due_date !== undefined) next.due_date = corrections.due_date

  // project_id — must be a project in this workspace.
  if (corrections.project_id !== undefined) {
    if (corrections.project_id === null) {
      next.project_id = null
    } else if (await existsInWorkspace(supabase, 'projects', corrections.project_id, workspaceId)) {
      next.project_id = corrections.project_id
    }
    // else: silently drop the out-of-workspace project id.
  }

  // assignee_member_id — must be a member of this workspace.
  if (corrections.assignee_member_id !== undefined) {
    if (corrections.assignee_member_id === null) {
      next.assignee_member_id = null
    } else if (
      await existsInWorkspace(supabase, 'member', corrections.assignee_member_id, workspaceId)
    ) {
      next.assignee_member_id = corrections.assignee_member_id
      // Human and agent assignee are mutually exclusive.
      next.extra = { ...(next.extra ?? {}), assignee_ai_member_id: null }
    }
  }

  // assignee_ai_member_id — must be an assignable AI teammate in this workspace
  // (not a built-in loop's, not a loop's work bot: isAssignableTeammate).
  if (corrections.assignee_ai_member_id !== undefined) {
    if (corrections.assignee_ai_member_id === null) {
      next.extra = { ...(next.extra ?? {}), assignee_ai_member_id: null }
    } else if (
      await isAssignableTeammate(supabase, corrections.assignee_ai_member_id, workspaceId)
    ) {
      next.extra = { ...(next.extra ?? {}), assignee_ai_member_id: corrections.assignee_ai_member_id }
      next.assignee_member_id = null
    }
  }

  return next
}

