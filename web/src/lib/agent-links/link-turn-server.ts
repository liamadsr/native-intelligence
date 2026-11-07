/**
 * The answering half's turn beyond the home-turn steps (agent links,
 * migration 435): another Dial8 user's agent messaged the agent this owner
 * set up for them, the turn ran in that half's thread as a guest's turn
 * (reason 'agent_ask', surface 'dial8'), and its reply goes back over the
 * link (./exchange.ts recordLinkReply), never to a phone or Slack. Its
 * consumer is src/lib/inngest/agent-link-turn.ts.
 *
 * When the turn couldn't answer (over the owner's limits, a held call, a
 * failure), the asking agent gets a short note instead, so it never waits on
 * an answer that won't come. The note never names a reason the other side
 * shouldn't know: only that the owner was asked, or to try later.
 *
 * Privacy as the text turn's: the reply is read back from the thread inside
 * the step that sends it, and the step returns outcomes only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { homeTurnMessageId, isQuietReply, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { replyTextOfParts } from '@/lib/chat/channel-reply'
import { finishHomeTurn, type HomeTurnReadResult, type HomeTurnRow, type HomeTurnSkip } from '@/lib/chat/home-turn-server'
import { ownerDisplayName } from '@/lib/guests/guest-turn'
import { recordLinkReply, type LinkReplyDeps } from './exchange'

/** What a settled agent-link turn hands the consumer (ids and outcomes only). */
export interface LinkTurnSettled {
  outcome: string
  written: boolean
  replied: boolean
  /** The note sent over the link instead of a reply, when one was. */
  note?: 'failed' | 'unfinished' | 'held'
}

export interface LinkTurnDeps extends LinkReplyDeps {
  finish?: typeof finishHomeTurn
  ownerName?: (userId: string, workspaceId: string) => Promise<string>
}

/** The note the asking agent gets when this side couldn't answer, or null to say nothing. */
export function linkTurnNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished' | 'held', owner: string): string | null {
  switch (reason) {
    case 'held':
      return `That needs ${owner}'s OK first. I've asked them, and nothing has happened yet.`
    case 'unfinished':
      return `That's taking me too long to answer. Ask again in a bit, or check with ${owner} directly.`
    case 'busy':
      return "I'm still working on your last message. Ask again in a few minutes."
    case 'usage_limited':
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
    case 'question_pending':
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return `I can't answer right now. Ask again later, or check with ${owner} directly.`
    default:
      return null
  }
}

/** Send `reason`'s note over the link for this turn (`key` keeps a retried step to one). Never throws. */
export async function sendLinkTurnNotice(
  supabase: SupabaseClient,
  data: Pick<HomeTurnRequestedData, 'userId' | 'workspaceId' | 'guestId'>,
  reason: Parameters<typeof linkTurnNotice>[0],
  key: string,
  deps: LinkTurnDeps = {},
): Promise<boolean> {
  if (!data.guestId) return false
  try {
    const owner = await (deps.ownerName ?? ((u, w) => ownerDisplayName(supabase, u, w)))(data.userId, data.workspaceId).catch(() => 'the owner')
    const note = linkTurnNotice(reason, owner)
    if (!note) return false
    const recorded = await recordLinkReply(supabase, { ownerUserId: data.userId, workspaceId: data.workspaceId, guestId: data.guestId, rowId: key }, { kind: 'note', body: note }, deps)
    return recorded.recorded
  } catch (err) {
    console.warn('[agent-link-turn] note not sent:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** The turn's reply (its final answer: replyTextOfParts) as written in the half's thread (`home-turn:<row>`), or '' when none. Throws on a failed read. */
async function readTurnReply(supabase: SupabaseClient, data: Pick<HomeTurnRequestedData, 'userId' | 'conversationId'>, rowId: string): Promise<string> {
  const { data: row, error } = await supabase
    .from('chat_messages')
    .select('ui_message')
    .eq('conversation_id', data.conversationId)
    .eq('user_id', data.userId)
    .eq('ui_message->>id', homeTurnMessageId(rowId))
    .maybeSingle<{ ui_message: { parts?: unknown } | null }>()
  if (error) throw new Error(error.message)
  return replyTextOfParts(row?.ui_message?.parts)
}

/**
 * Finish the turn (write the reply in the half's thread), then send it over
 * the link: the reply when there is one, else a note for a turn that held a
 * call for the owner, failed, or ran past the read cap. Nothing for a quiet
 * turn. Never throws.
 */
export async function settleAgentLinkTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: Pick<HomeTurnRow, 'id'>,
  read: HomeTurnReadResult,
  deps: LinkTurnDeps = {},
): Promise<LinkTurnSettled> {
  const finished = await (deps.finish ?? finishHomeTurn)(supabase, data, row, read)
  const outcome = read.done && read.end !== 'completed' ? `${finished.outcome}:${read.end}` : finished.outcome
  if (!read.done) {
    await sendLinkTurnNotice(supabase, data, 'unfinished', row.id, deps)
    return { outcome, written: finished.written, replied: false, note: 'unfinished' }
  }
  let text = ''
  try {
    text = await readTurnReply(supabase, data, row.id)
  } catch {
    text = ''
  }
  if (!isQuietReply(text) && data.guestId) {
    try {
      const recorded = await recordLinkReply(supabase, { ownerUserId: data.userId, workspaceId: data.workspaceId, guestId: data.guestId, rowId: row.id }, { kind: 'answer', body: text }, deps)
      return { outcome, written: finished.written, replied: recorded.recorded }
    } catch (err) {
      console.warn('[agent-link-turn] reply not sent:', err instanceof Error ? err.message : String(err))
      return { outcome, written: finished.written, replied: false }
    }
  }
  if (finished.heldApproval) {
    await sendLinkTurnNotice(supabase, data, 'held', row.id, deps)
    return { outcome, written: finished.written, replied: false, note: 'held' }
  }
  if (read.end === 'failed' || read.end === 'cancelled' || read.end === 'session_ended') {
    await sendLinkTurnNotice(supabase, data, 'failed', row.id, deps)
    return { outcome, written: finished.written, replied: false, note: 'failed' }
  }
  return { outcome, written: finished.written, replied: false }
}
