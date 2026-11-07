/**
 * What a teammate chat's turn is about (bots v3 1d, docs/plans/bots-v3.md "The
 * conversation, per run kind"): one of the person's own items, named by id
 * only. A click on a loop's peek opens the bot's bubble on that run, and what's
 * said there goes to the teammate's own thread with this ref; the mint
 * (POST /api/account/chat/eve-session) checks it against the caller's access
 * and signs it into the run token, and the spec rebuild builds the "About this
 * item" section from it (teammate-about.ts). The client never sends text.
 *
 * Pure and client-safe: the bubble, the transport and the routes share it.
 */

/** The item a turn is about: the run's ledger row (`tracked_job`), else one card (`attention_item`). */
export interface TeammateAboutRef {
  workItemId?: string
  cardId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A row id the about section can name: a uuid. */
export function isAboutId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * The ref in `value`, or null: a uuid `workItemId`, else a uuid `cardId`. A
 * work item wins (a card that names its run is about the run); anything else
 * in the object is dropped.
 */
export function parseTeammateAboutRef(value: unknown): TeammateAboutRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { workItemId?: unknown; cardId?: unknown }
  if (isAboutId(v.workItemId)) return { workItemId: v.workItemId }
  if (isAboutId(v.cardId)) return { cardId: v.cardId }
  return null
}

/**
 * The line a FOCUSED main-agent conversation's message carries for the item it
 * is about (one-agent plan S3: an area face's page chats there, and its
 * "Refine in chat" posts there). The main agent's token takes no item, so the
 * ref rides the text, ids only, the way the main chat's "chat about it" names
 * its capture (chat-panel.tsx handleChatAboutProposal): with them the main
 * agent reads THAT item with get_bot_item and revises or settles it, never
 * another. Empty for no ref.
 */
export function focusedAboutLine(ref: TeammateAboutRef | null | undefined): string {
  if (ref?.workItemId && isAboutId(ref.workItemId)) {
    return `(This is about my work item ${ref.workItemId}: read it with get_bot_item, id ${ref.workItemId}, and use the draft_ids it gives for revise_email_draft.)`
  }
  if (ref?.cardId && isAboutId(ref.cardId)) {
    return `(This is about my card ${ref.cardId}: read it with get_bot_item, id ${ref.cardId}; settle it with settle_card, card_id ${ref.cardId}, only when I ask.)`
  }
  return ''
}

/**
 * What a hand-off to the home thread carries for an item (one face: the agent's
 * face sends through the chat strip, openHomeThread): a card rides as its id
 * (`cardIds`: the turn's systemContext.aboutCardIds, checked and rendered by
 * the chat spec); a work item has no such field, so its ids ride the text
 * (focusedAboutLine). Nothing for no item, or one that isn't an id.
 */
export function homeHandoffAbout(text: string, ref: TeammateAboutRef | null | undefined): { text: string; cardIds?: string[] } {
  if (ref?.cardId && isAboutId(ref.cardId)) return { text, cardIds: [ref.cardId] }
  const line = focusedAboutLine(ref)
  return { text: line ? `${text}\n\n${line}` : text }
}

/** Whether two refs name the same item (both null counts). */
export function sameAboutRef(a: TeammateAboutRef | null | undefined, b: TeammateAboutRef | null | undefined): boolean {
  return (a?.workItemId ?? null) === (b?.workItemId ?? null) && (a?.cardId ?? null) === (b?.cardId ?? null)
}
