/**
 * One hand-off on a call (the spike): what the person said since GPT-Live's
 * last hand-off becomes their message in their home thread (channel 'call'),
 * and a channel turn with reason 'call' answers it, in-process. The same plan,
 * claim, send, read and finish as a text turn (src/lib/inngest/text-turn.ts),
 * without Inngest: someone is on the line, so there is no debounce, a short
 * lease wait, and the reply goes back to the bridge to be spoken rather than
 * texted. The thread keeps both sides, marked "On a call".
 *
 * Someone is waiting, so the first read gets CALL_TURN_SPEAK_BUDGET_MS. A turn
 * still running then is told to the caller (the answer will be in the app)
 * and finished in the background, which the bridge waits for. With no
 * Inngest retry behind it, a step that throws is tried once more (a retried
 * send reads on from the row's start), and a turn that still can't go on is
 * marked failed, so it never holds the thread's lease.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureHomeThread } from '@/lib/chat/home-thread'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { CALL_CHANNEL, CHANNEL_MESSAGE_KIND, callMessageId } from '@/lib/chat/channel-turn'
import { replyTextOfParts } from '@/lib/chat/channel-reply'
import { homeTurnMessageId, isQuietReply, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import {
  HOME_TURN_MAX_READ_STEPS,
  claimHomeTurn,
  continueHomeTurn,
  finishHomeTurn,
  planHomeTurn,
  recordSkippedHomeTurn,
  sendHomeTurn,
  type HomeTurnClaim,
  type HomeTurnPlan,
  type HomeTurnReadState,
  type HomeTurnRow,
  type HomeTurnSkip,
  type HomeTurnStepResult,
} from '@/lib/chat/home-turn-server'
import type { CallCaller } from './caller'

/** How long a call turn waits for another turn's lease in the home thread, and how many times (12 s in all). */
export const CALL_TURN_LEASE_WAIT_MS = 1_500
export const CALL_TURN_LEASE_WAITS = 8

/** How long the caller waits on a turn's first read before they are told it's taking a while. */
export const CALL_TURN_SPEAK_BUDGET_MS = 20_000

/** What the bridge does with a hand-off's turn. */
export type CallTurnResult =
  /** The agent's answer, for GPT-Live to say. */
  | { kind: 'reply'; text: string; outcome: string; rowId: string }
  /** Nothing to say (`[quiet]`, or nothing new to answer). */
  | { kind: 'quiet'; outcome: string; rowId?: string }
  /** The turn could not answer: a short line for GPT-Live to say instead. */
  | { kind: 'notice'; text: string; outcome: string; rowId?: string }

/** Seams for the tests: every home-turn step, and the clock. */
export interface CallTurnDeps {
  ensureHome?: typeof ensureHomeThread
  persist?: typeof persistEveMessage
  plan?: typeof planHomeTurn
  claim?: typeof claimHomeTurn
  send?: typeof sendHomeTurn
  continueRead?: typeof continueHomeTurn
  finish?: typeof finishHomeTurn
  recordSkip?: typeof recordSkippedHomeTurn
  readReply?: (supabase: SupabaseClient, scope: { conversationId: string; userId: string; rowId: string }) => Promise<string>
  markFailed?: (supabase: SupabaseClient, rowId: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  /** Where a slow turn's finish runs (the bridge waits for it); without one it runs detached. */
  background?: (work: Promise<void>) => void
  speakBudgetMs?: number
}

/**
 * What the person hears when their request could not become a turn, or null
 * to say nothing: the agent's own words to them, which GPT-Live says (in its
 * own words) like any answer.
 */
export function callTurnSkipNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished' | 'held'): string | null {
  switch (reason) {
    case 'question_pending':
      return "There's a question from me waiting for you in the Dial8 app. Answer it there first, then ask me again."
    case 'autonomy_off':
      return "Dial8's agent is switched off for this workspace in Settings, so I can't act on calls right now."
    case 'usage_limited':
      return "You've reached your Dial8 usage limit, so I can't answer right now."
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return "I couldn't find your Dial8 workspace for this number."
    case 'busy':
      return "I'm still busy with something else in Dial8. Try me again in a minute."
    case 'unfinished':
      return "That's taking me a while. I'll keep working on it, and the answer will be in the Dial8 app."
    case 'held':
      return "That needs your OK first. It's waiting for you in the Dial8 app."
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
      return "Sorry, I couldn't get to that just now. Try again in a moment."
    default:
      return null
  }
}

/** The turn's written reply (its final answer), '' when none. */
async function readTurnReply(supabase: SupabaseClient, scope: { conversationId: string; userId: string; rowId: string }): Promise<string> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('ui_message')
    .eq('conversation_id', scope.conversationId)
    .eq('user_id', scope.userId)
    .eq('ui_message->>id', homeTurnMessageId(scope.rowId))
    .maybeSingle<{ ui_message: { parts?: unknown } | null }>()
  if (error) throw new Error(`call turn: reply read failed: ${error.message}`)
  return replyTextOfParts(data?.ui_message?.parts)
}

/** Fail a row a call turn can't go on with (it has no retry behind it), so its lease is let go. Best-effort. */
async function markCallTurnFailed(supabase: SupabaseClient, rowId: string): Promise<void> {
  try {
    await supabase.from('home_turn').update({ status: 'failed', error: 'call_turn_threw', updated_at: new Date().toISOString() }).eq('id', rowId).in('status', ['claimed', 'sent'])
  } catch {
    // The lease still goes stale on its own (HOME_TURN_RESUME_AFTER_MS).
  }
}

/** Finish a read turn and say what it answered. */
async function settle(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: HomeTurnRow,
  read: Extract<HomeTurnStepResult, { kind: 'read' }>['result'],
  deps: CallTurnDeps,
): Promise<CallTurnResult> {
  const finished = await (deps.finish ?? finishHomeTurn)(supabase, data, row, read)
  const outcome = read.done && read.end !== 'completed' ? `${finished.outcome}:${read.end}` : finished.outcome
  if (!read.done) return { kind: 'notice', text: callTurnSkipNotice('unfinished')!, outcome, rowId: row.id }
  const reply = await (deps.readReply ?? readTurnReply)(supabase, { conversationId: data.conversationId, userId: data.userId, rowId: row.id })
  if (reply && !isQuietReply(reply)) return { kind: 'reply', text: reply, outcome, rowId: row.id }
  if (finished.heldApproval) return { kind: 'notice', text: callTurnSkipNotice('held')!, outcome, rowId: row.id }
  if (read.end === 'failed' || read.end === 'cancelled' || read.end === 'session_ended') return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome, rowId: row.id }
  return { kind: 'quiet', outcome, rowId: row.id }
}

/** A slow turn, read on to its end with the full budget and finished (its reply lands in the thread). Never throws. */
async function finishLater(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: HomeTurnRow,
  first: Extract<HomeTurnStepResult, { kind: 'read' }>,
  deps: CallTurnDeps,
): Promise<void> {
  try {
    let step: HomeTurnStepResult = first
    for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step.kind === 'read' && !step.result.done; n++) {
      const state: HomeTurnReadState = step.result.state
      step = await twice((): Promise<HomeTurnStepResult> => (deps.continueRead ?? continueHomeTurn)(supabase, data, plan, row, state))
    }
    if (step.kind === 'read') await (deps.finish ?? finishHomeTurn)(supabase, data, row, step.result)
  } catch {
    await (deps.markFailed ?? markCallTurnFailed)(supabase, row.id)
  }
}

/** Run a step, and once more if it throws. */
async function twice<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch {
    return await step()
  }
}

/**
 * Answer one hand-off. Writes the person's words (id
 * `call-in:<session>:<delegation>`, so a retry converges on one row), then
 * runs the turn to its end. Never throws: a failure is a notice.
 */
export async function runCallTurn(
  supabase: SupabaseClient,
  args: { caller: CallCaller; sessionId: string; delegationId: string; words: string },
  deps: CallTurnDeps = {},
): Promise<CallTurnResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let data: HomeTurnRequestedData
  try {
    const home = await (deps.ensureHome ?? ensureHomeThread)(supabase, { userId: args.caller.userId, workspaceId: args.caller.workspaceId })
    const written = await (deps.persist ?? persistEveMessage)(supabase, {
      conversationId: home.id,
      userId: args.caller.userId,
      workspaceId: args.caller.workspaceId,
      role: 'user',
      parts: [{ type: 'text', text: args.words }],
      messageId: callMessageId(args.sessionId, args.delegationId),
      metadata: { kind: CHANNEL_MESSAGE_KIND, channel: CALL_CHANNEL, live_session_id: args.sessionId },
    })
    if (!written.written && written.reason) return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome: `not_written:${written.reason}` }
    data = { conversationId: home.id, userId: args.caller.userId, workspaceId: args.caller.workspaceId, workItemIds: [], reason: 'call', callSessionId: args.sessionId }
  } catch {
    return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome: 'write_failed' }
  }

  try {
    for (let attempt = 0; ; attempt++) {
      const plan = await (deps.plan ?? planHomeTurn)(supabase, data)
      if (!plan.ok) {
        if (plan.record) await (deps.recordSkip ?? recordSkippedHomeTurn)(supabase, data, { reason: plan.reason, record: plan.record })
        const notice = callTurnSkipNotice(plan.reason)
        return notice ? { kind: 'notice', text: notice, outcome: plan.reason } : { kind: 'quiet', outcome: plan.reason }
      }
      const claim: HomeTurnClaim = await (deps.claim ?? claimHomeTurn)(supabase, data, plan)
      if (claim.kind === 'duplicate') return { kind: 'quiet', outcome: 'duplicate' }
      if (claim.kind === 'busy') {
        if (attempt >= CALL_TURN_LEASE_WAITS) return { kind: 'notice', text: callTurnSkipNotice('busy')!, outcome: 'busy' }
        await sleep(CALL_TURN_LEASE_WAIT_MS)
        continue
      }
      const row = claim.row
      const markFailed = deps.markFailed ?? markCallTurnFailed
      let step: HomeTurnStepResult
      try {
        step = await twice(() => (deps.send ?? sendHomeTurn)(supabase, data, plan, row, { budgetMs: deps.speakBudgetMs ?? CALL_TURN_SPEAK_BUDGET_MS }))
      } catch (err) {
        await markFailed(supabase, row.id)
        return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome: `error:${err instanceof Error ? err.name : 'unknown'}`, rowId: row.id }
      }
      if (step.kind === 'failed') return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome: step.error, rowId: row.id }
      if (!step.result.done) {
        // Still running: tell the caller, and finish it (thread reply, lease) in the background.
        const later = finishLater(supabase, data, plan, row, step, deps)
        if (deps.background) deps.background(later)
        else void later
        return { kind: 'notice', text: callTurnSkipNotice('unfinished')!, outcome: 'slow', rowId: row.id }
      }
      return await settle(supabase, data, row, step.result, deps)
    }
  } catch (err) {
    // The server log keeps why (an internal error, never the caller's words).
    console.warn(`[live-call] call turn threw: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`)
    return { kind: 'notice', text: callTurnSkipNotice('failed')!, outcome: `error:${err instanceof Error ? err.name : 'unknown'}` }
  }
}
