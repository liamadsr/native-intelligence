/**
 * The email drafts a bot wrote and the person hasn't sent or dismissed yet
 * (Liam, 10-18): each is its own For you card, under the bot that wrote it,
 * opening Mail on that draft (docs/plans/chat-ui-polish.md Phase 6). Before,
 * a drafting pass was one work item ("Reply drafts for 29 threads") whose
 * drafts sat in a side panel.
 *
 * The draft row is the truth: a sent or dismissed draft's row is deleted
 * (migration 344), so an open one is a row in an open status. Only the
 * automatic ones (`metadata.origin = 'automatic'`: the arrival pass and the
 * daily safety net, src/lib/crm/email-drafts.ts): a draft the person asked
 * for in the chat is already in the chat. RLS: the mailbox owner's own rows.
 *
 * Client-safe (the type and the card's words); the read is server-only
 * (./agent-drafts-server.ts).
 */

/**
 * A draft's item id where For you and the agent list it (list_bot_work):
 * `draft:<email_draft row id>`, never one of a card's or a row's.
 * discard_email_draft and settle_work_item take it as it is.
 */
export const AGENT_DRAFT_ITEM_PREFIX = 'draft:'

export interface AgentDraft {
  /** The email_draft row id (what revise_email_draft takes). */
  id: string
  workspace_id: string
  subject: string | null
  /** Who it goes to: the first recipient's address, or null. */
  to: string | null
  provider_thread_id: string | null
  /** The draft message's id in the mailbox (the thread view's message id), or null when the mailbox write failed. */
  provider_draft_id: string | null
  /** The thread's folder in Mail, or null. */
  folder: string | null
  created_at: string
}

/** The card's sentence after its verb: "the reply to dana@acme.com: “Re: Pricing”". */
export function agentDraftSentence(draft: Pick<AgentDraft, 'to' | 'subject'>): string {
  const subject = draft.subject ? `: “${draft.subject}”` : ''
  return draft.to ? `the reply to ${draft.to}${subject}` : `the draft${subject || ' reply'}`
}
