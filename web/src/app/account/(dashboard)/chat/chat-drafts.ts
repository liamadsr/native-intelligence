/**
 * A half-typed message belongs to the chat it was typed in (docs/plans/
 * one-home.md, "Starting a coding session", decision 4). Home has one box and
 * one current chat (current-chat-store.ts); before, the words in the box
 * followed the person from chat to chat, so a note half typed for the agent
 * sat in the box under a coding chat, one Enter from being sent to a coding
 * agent.
 *
 *   Each chat   the agent's, each coding chat's and the new coding chat's
 *               keep their own words. Switching swaps the box's.
 *   One carry   between the agent and a NEW coding chat, the words cross
 *               when the other side's box is empty: nothing was sent, and the
 *               person is only choosing who gets them ("Fix the flaky test",
 *               then: that's a Code job). Never into an existing chat.
 *   Sent        a new coding chat's first send makes it a real chat: its
 *               words went with the send, they are nobody's draft (draftSent).
 *   Kept        in memory, for the window's session, per workspace. The
 *               agent's draft is also saved with the chat as before (its
 *               snapshot asks agentDraft, so a coding chat's words are never
 *               saved as the agent's).
 *
 * A plain module, pure but for its map. Both rules are one value each in
 * one-home-decisions.ts.
 */
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { chatKey, type CurrentChat } from './current-chat-store'
import { DRAFT_CARRIES_TO_NEW_CODING_CHAT, DRAFT_PER_CHAT } from './one-home-decisions'

const drafts = new Map<string, string>()
/** The chat whose words in the box were just sent: its next swap keeps nothing of them. */
let sent: string | null = null

const keyOf = (chat: CurrentChat): string => `${getClientWorkspaceId() ?? ''}|${chatKey(chat)}`

/** The agent and a new coding chat: the one pair the words cross between. */
const carries = (from: CurrentChat, to: CurrentChat): boolean =>
  DRAFT_CARRIES_TO_NEW_CODING_CHAT && ((from.kind === 'agent' && to.kind === 'code-new') || (from.kind === 'code-new' && to.kind === 'agent'))

/**
 * The current chat went from `from` to `to` with `text` in the box: what the
 * box holds now. `from`'s words are kept for its return.
 */
export function swapDraft(from: CurrentChat, to: CurrentChat, text: string): string {
  if (!DRAFT_PER_CHAT || chatKey(from) === chatKey(to)) return text
  const fromKey = keyOf(from)
  const toKey = keyOf(to)
  const words = sent === fromKey ? '' : text
  sent = null
  const waiting = drafts.get(toKey) ?? ''
  if (carries(from, to) && words.trim() && !waiting.trim()) {
    // They move: the side left keeps none of them.
    drafts.delete(fromKey)
    drafts.delete(toKey)
    return words
  }
  if (words) drafts.set(fromKey, words)
  else drafts.delete(fromKey)
  return waiting
}

/** The words in `chat`'s box were sent (a new coding chat's first send): they are not its draft when it is left. */
export function draftSent(chat: CurrentChat): void {
  sent = keyOf(chat)
  drafts.delete(sent)
}

/**
 * The agent's draft, for the chat's saved copy: the box's own words while the
 * agent's chat is the current one, else what was kept for it. Never another
 * chat's words.
 */
export function agentDraft(current: CurrentChat, boxText: string): string {
  if (!DRAFT_PER_CHAT || current.kind === 'agent') return boxText
  return drafts.get(keyOf({ kind: 'agent' })) ?? ''
}

/** A chat's kept words (none: ''), for the tests. */
export function draftOf(chat: CurrentChat): string {
  return drafts.get(keyOf(chat)) ?? ''
}

export function __resetChatDraftsForTests(): void {
  drafts.clear()
  sent = null
}
