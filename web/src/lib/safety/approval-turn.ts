/**
 * The agent carries on once the person approves a call it held (migration
 * 445; the follow-up to GEN-1172).
 *
 * A held call runs in the card's own Accept, outside any turn of the agent's
 * (approvals.ts approveToolCall). GEN-1172 gave the agent its outcome at the
 * conversation's next turn (approval-results.ts), but that turn waited for
 * the person to type. Now, once the call has run, the Accept requests one
 * home turn with reason 'approval' (requestApprovalTurn): its own event and a
 * short debounce (src/lib/inngest/home-turn.ts approvalTurn), so a few cards
 * approved in a row are one turn. The turn's body names the calls
 * (gatherApprovalTurn); how each ended, and what it returned, rides the
 * turn's `approval-…` context section as on any turn, never the body. The
 * agent tells the person what it showed and takes the next step, or calls
 * no_reply when it already did. Each call is carried once
 * (tool_approval.home_turn_id, markApprovalsCarried, in the step that frees
 * the turn's lease). A call the person's own turn already saw (they wrote
 * after it ran: that turn had its section) is dropped at the plan
 * (approvalsRanAfter), so the agent never takes the same next step twice.
 *
 * Only a call the person's own chat turn raised, that ran (succeeded or
 * failed), starts one (startsApprovalTurn). A declined, expired or refused
 * call starts none: the person already sees why on the card and the bubble,
 * and the agent reads it at its next turn. Nor does a home turn's own card,
 * so an approval turn never leads to another without the person typing.
 * Server turns run only in the person's home thread: a call raised in another
 * thread of theirs is skipped by the plan (`not_home`) and reaches the agent
 * at that thread's next turn.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { APPROVAL_TURN_REQUESTED_EVENT, type HomeTurnApprovals, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { approvalOutcomeOf, toolLabel, type ApprovalOutcomeRow } from './approval-results'

/**
 * How long after its yes a call still starts a turn: past the debounce and a
 * busy thread's lease waits (HOME_TURN_LEASE_WAITS × HOME_TURN_LEASE_WAIT,
 * 30 min), as RECENT_RUN_MS.
 */
export const APPROVAL_TURN_WINDOW_MS = 60 * 60_000
/** The most calls one approval turn names (the newest). */
export const APPROVAL_TURN_MAX = 5

/** What a settled call is judged and named from. */
export interface ApprovalTurnRow extends ApprovalOutcomeRow {
  door: string
  conversation_id: string | null
  context?: unknown
}

const APPROVAL_TURN_COLUMNS = 'id, tool, status, result, decided_at, executed_at, expires_at, door, conversation_id, context'

/**
 * True for a call the person's own chat turn in the app raised. Not a device
 * ask or a channel's (Slack, text, another person's agent: `surface`), a home
 * turn's own card, a guest's, a linked agent's, a teammate chat's, the agent
 * on their Mac's, or a cloud browser step's (its task carries on by itself).
 * Pure.
 */
export function startsApprovalTurn(row: Pick<ApprovalTurnRow, 'door' | 'conversation_id' | 'context'>): boolean {
  if (row.door !== 'chat' || !row.conversation_id) return false
  const ctx = row.context && typeof row.context === 'object' ? (row.context as Record<string, unknown>) : {}
  return !ctx.surface && ctx.homeTurn !== true && !ctx.guest && !ctx.agentLink && !ctx.teammateId && !ctx.localAgent && !ctx.browser
}

/** One call's line in the turn's body: our own words around its id and sanitized tool name, never its result. Pure. */
export function approvalTurnLine(row: Pick<ApprovalOutcomeRow, 'id' | 'tool' | 'status' | 'result' | 'decided_at' | 'executed_at' | 'expires_at'>, now = Date.now()): string {
  const outcome = approvalOutcomeOf(row, now) === 'ran_failed' ? 'ran, but failed' : 'ran'
  return `approval_id ${row.id} · ${toolLabel(row.tool)} · ${outcome}`
}

/**
 * The calls in this conversation the person approved, that ran, and that no
 * approval turn carried yet: the newest APPROVAL_TURN_MAX within the window,
 * oldest first. Null when there are none. Throws on a failed read (the plan
 * skips as `lookup_failed`).
 */
export async function gatherApprovalTurn(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; workspaceId: string },
  now: number = Date.now(),
): Promise<HomeTurnApprovals | null> {
  const { data, error } = await supabase
    .from('tool_approval')
    .select(APPROVAL_TURN_COLUMNS)
    .eq('conversation_id', scope.conversationId)
    .eq('user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .eq('door', 'chat')
    .eq('status', 'approved')
    .not('executed_at', 'is', null)
    .is('home_turn_id', null)
    .gt('decided_at', new Date(now - APPROVAL_TURN_WINDOW_MS).toISOString())
    .order('decided_at', { ascending: false })
    .limit(APPROVAL_TURN_MAX * 4)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as ApprovalTurnRow[])
    .filter((row) => typeof row.id === 'string' && typeof row.tool === 'string' && startsApprovalTurn(row))
    .slice(0, APPROVAL_TURN_MAX)
    .reverse()
  if (rows.length === 0) return null
  return { lines: rows.map((row) => approvalTurnLine(row, now)), approvalIds: rows.map((row) => row.id), ranAt: rows.map((row) => row.executed_at ?? '') }
}

/**
 * The calls that finished running after the person last wrote (`sinceMs`):
 * a call that ran before their message was in that turn's context, so their
 * own turn already carried on from it. Null when none is left. Pure.
 */
export function approvalsRanAfter(approvals: HomeTurnApprovals, sinceMs: number): HomeTurnApprovals | null {
  const keep = approvals.approvalIds.map((_, i) => i).filter((i) => !(Date.parse(approvals.ranAt[i] ?? '') <= sinceMs))
  if (keep.length === 0) return null
  return { lines: keep.map((i) => approvals.lines[i]), approvalIds: keep.map((i) => approvals.approvalIds[i]), ranAt: keep.map((i) => approvals.ranAt[i]) }
}

/** The calls an approval turn delivered: carried, so no later turn names them again. Best effort (logged). */
export async function markApprovalsCarried(supabase: SupabaseClient, input: { approvalIds: readonly string[]; homeTurnId: string }): Promise<void> {
  if (input.approvalIds.length === 0) return
  try {
    const { error } = await supabase
      .from('tool_approval')
      .update({ home_turn_id: input.homeTurnId })
      .in('id', [...input.approvalIds])
      .is('home_turn_id', null)
    if (error) console.warn('[approval-turn] carried mark failed:', error.message)
  } catch (err) {
    console.warn('[approval-turn] carried mark failed:', err instanceof Error ? err.message : String(err))
  }
}

export interface ApprovalTurnDeps {
  send?: (event: { name: typeof APPROVAL_TURN_REQUESTED_EVENT; data: HomeTurnRequestedData; id: string }) => Promise<unknown>
}

/**
 * The person's yes ran the call: ask for the agent's turn in the
 * conversation that raised it. Once per call (the event id). Never throws:
 * a call that starts none sends nothing, and a failed send leaves the outcome
 * to the conversation's next turn.
 */
export async function requestApprovalTurn(
  row: Pick<ApprovalTurnRow, 'id' | 'door' | 'conversation_id' | 'context'> & { user_id: string; workspace_id: string },
  deps: ApprovalTurnDeps = {},
): Promise<void> {
  if (!startsApprovalTurn(row) || !row.conversation_id) return
  const send = deps.send ?? (async (event) => (await import('@/lib/inngest/client')).inngest.send(event as never))
  try {
    await send({
      name: APPROVAL_TURN_REQUESTED_EVENT,
      id: `approval-turn-${row.id}`,
      data: { conversationId: row.conversation_id, userId: row.user_id, workspaceId: row.workspace_id, workItemIds: [], reason: 'approval' },
    })
  } catch (err) {
    console.warn('[approval-turn] not requested:', err instanceof Error ? err.message : String(err))
  }
}
