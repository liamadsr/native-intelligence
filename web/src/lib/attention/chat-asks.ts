/**
 * Where a pending attention card lives (P13; Liam, 2026-10-20: "For you is
 * like delivered artifacts, not a place to ask me a question… approvals are
 * questions too… 'Add this?' is a question. For you only shows drafts,
 * reports and docs").
 *
 *   For you   delivered work only. Of the cards: a post draft or a
 *             slow-week idea (a `question` card carrying `post_draft`). The
 *             rest of For you is not cards at all: an email draft waiting in
 *             Mail, and a run's review (a report, a document, a PR, a
 *             draft). The person acting on a delivered draft (Post, Copy,
 *             Typefully's Post now and Queue) is not a question.
 *   the chat  every other card is an ASK: an approval (a held tool call,
 *             src/lib/safety/approvals.ts), a suggested action ("Add this?",
 *             "Apply the update?"), an offer to draft an email, a work
 *             proposal ("Start?"), a question. It renders inline in the
 *             conversation it belongs to: right after the agent's message in
 *             the chat turn that raised it, or in the owner's home thread
 *             when nobody was in a chat to see it (an approval one message
 *             each, src/lib/safety/approvals.ts; a run's suggestions batched
 *             per call, src/lib/attention/home-asks.ts).
 *
 * The store is the same `attention_item` row either way (and, for an
 * approval, its `tool_approval`): one GET returns both halves, `items` for
 * For you and `asks` for the chat, so the client keeps one fetch and one
 * realtime channel. Pure and client-safe.
 */
import { postDraftFromPayload } from '@/lib/content/post-draft'
import { guestRef, type GuestAskData } from '@/lib/guests/chat-parts'
import { agentLinkRef, type AgentLinkAskData } from '@/lib/agent-links/chat-parts'

/** A card as far as where it lives goes. */
export interface PlacedCard {
  kind: string
  payload?: unknown
}

/** True for For you's one kind of card: a post draft (or a slow-week idea), delivered work. */
export function isForYouCard(card: PlacedCard): boolean {
  return card.kind === 'question' && !!postDraftFromPayload(card.payload)
}

/** True for a card the chat asks with: every card but a post draft. */
export function isChatAskCard(card: PlacedCard): boolean {
  return !isForYouCard(card)
}

/** The cards split by where they live, each list in the order given. */
export function splitCardsByPlace<T extends PlacedCard>(cards: readonly T[]): { forYou: T[]; asks: T[] } {
  const forYou: T[] = []
  const asks: T[] = []
  for (const card of cards) (isChatAskCard(card) ? asks : forYou).push(card)
  return { forYou, asks }
}

/** The part a server-written chat message carries an ask card in (the home thread). */
export const ASK_CARD_PART_TYPE = 'data-ask-card' as const

/** `ui_message.metadata.kind` of an ask message in the home thread (one approval). */
export const ASK_MESSAGE_KIND = 'ask_card' as const

/** The part a home-thread message carries a source's batch of suggestions in (home-asks.ts). */
export const ASK_CARDS_PART_TYPE = 'data-ask-cards' as const

/** `ui_message.metadata.kind` of a batched suggestions message in the home thread. */
export const ASK_CARDS_MESSAGE_KIND = 'ask_cards' as const

/** `ui_message.metadata.kind` of a run's notice in the home thread ("CI is still red", ci-fix.ts). */
export const RUN_NOTICE_MESSAGE_KIND = 'ci_red' as const

const HOME_ASK_KINDS: ReadonlySet<unknown> = new Set([ASK_MESSAGE_KIND, ASK_CARDS_MESSAGE_KIND, RUN_NOTICE_MESSAGE_KIND])

/** True for a message the server wrote into the home thread to ask or tell (the live bridge takes these). */
export function isHomeAskMessage(message: unknown): boolean {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  return !!meta && typeof meta === 'object' && HOME_ASK_KINDS.has((meta as { kind?: unknown }).kind)
}

/**
 * Something a run added on its own (an auto-applied create, Triage's existing
 * gate), said in the home thread with an Undo (home-asks.ts). The Undo is the
 * capture's own undo route, so only an item from a call (`capture_id`) has one.
 */
export interface AddedItem {
  /** The proposal it applied (the undo route re-stages it). */
  change_id: string
  /** What it created. */
  entity_id: string
  entity_type: string
  capture_id?: string
  /** Native Intelligence's words for where it came from ("your call “Acme sync”"). */
  source?: string
  title?: string
  /** An action's identifier (ENG-51). */
  identifier?: string
}

/** One source's outcome in a batched message: what was added, the cards that ask, and where they came from. */
export interface AskCardsPartData {
  card_ids: string[]
  workspace_id: string
  /** What the line above them names ("your call “Acme sync”"), for the settled line. */
  source?: string
  /** What the source's runs added on their own, each with an Undo. */
  added?: AddedItem[]
}

function addedItem(value: unknown): AddedItem | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const changeId = uuid(v.change_id)
  const entityId = uuid(v.entity_id)
  if (!changeId || !entityId) return null
  const captureId = uuid(v.capture_id)
  return {
    change_id: changeId,
    entity_id: entityId,
    entity_type: typeof v.entity_type === 'string' && /^[a-z_]{1,40}$/.test(v.entity_type) ? v.entity_type : 'action',
    ...(captureId ? { capture_id: captureId } : {}),
    ...(typeof v.source === 'string' && v.source.trim() ? { source: v.source.trim().slice(0, 200) } : {}),
    ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
    ...(typeof v.identifier === 'string' && /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(v.identifier) ? { identifier: v.identifier } : {}),
  }
}

/** A stored `data-ask-cards` part's data, or null when it isn't one (ids must be ids, at most 20 of each; something to show). */
export function askCardsPartData(value: unknown): AskCardsPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const ids = Array.isArray(d.card_ids) ? d.card_ids.map(uuid).filter((id): id is string => !!id).slice(0, 20) : []
  const added = Array.isArray(d.added) ? d.added.map(addedItem).filter((a): a is AddedItem => !!a).slice(0, 20) : []
  if (!ids.length && !added.length) return null
  return {
    card_ids: [...new Set(ids)],
    workspace_id: typeof d.workspace_id === 'string' ? d.workspace_id : '',
    ...(typeof d.source === 'string' && d.source.trim() ? { source: d.source.trim().slice(0, 200) } : {}),
    ...(added.length ? { added } : {}),
  }
}

/** What a `data-ask-card` part holds: enough to find the live card and to say what it was once settled. */
export interface AskCardPartData {
  /** The attention card (the live one is looked up by it). */
  card_id: string
  /** An approval's held call (its outcome is read by it once the card is settled). */
  approval_id?: string
  workspace_id: string
  /** The card's title, for the settled line. */
  title?: string
  /** The run it came from, for "Open run" (its item, beside its run chat). */
  work_item_id?: string
  /** A guest's held call (guest access): who asked, named above the card (src/lib/guests/chat-parts.ts). */
  guest?: GuestAskData
  /** A held call another person's agent asked for (agent links): the link it came over, named above the card (src/lib/agent-links/chat-parts.ts). */
  agent_link?: AgentLinkAskData
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null
}

/** A stored `data-ask-card` part's data, or null when it isn't one (a part is data). */
export function askCardPartData(value: unknown): AskCardPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const cardId = uuid(d.card_id)
  if (!cardId) return null
  const approvalId = uuid(d.approval_id)
  const workItemId = uuid(d.work_item_id)
  const guest = guestRef(d.guest)
  const agentLink = agentLinkRef(d.agent_link)
  return {
    card_id: cardId,
    ...(approvalId ? { approval_id: approvalId } : {}),
    workspace_id: typeof d.workspace_id === 'string' ? d.workspace_id : '',
    ...(typeof d.title === 'string' && d.title.trim() ? { title: d.title.trim().slice(0, 200) } : {}),
    ...(workItemId ? { work_item_id: workItemId } : {}),
    ...(guest ? { guest } : {}),
    ...(agentLink ? { agent_link: agentLink } : {}),
  }
}

/** The tools that hold a call for the person by their own door (each says so in its result, with the approval's id). */
const HOLDING_TOOLS: ReadonlySet<string> = new Set([
  // A connected app's approval-gated call (adapter.ts): `status: 'approval_requested'`.
  'mcp_confirm_call',
  // A connection change (connections.ts): `code: 'APPROVAL_REQUIRED'`.
  'disconnect',
  'set_tool_access',
  // A loop change (flows.ts, flow-approvals.ts): a delete, a hand-over, a takeover, a switch-on card.
  'create_flow',
  'update_flow',
  'delete_flow',
  'transfer_flow_owner',
  'request_flow_takeover',
  // A permanent document delete (documents.ts, delete-card.ts): `code: 'APPROVAL_REQUIRED'`.
  'delete_document',
])

/** The outward gate's held-call result (action-review.ts HeldCallOutput): exactly these keys. */
const GATE_KEYS = ['approval_id', 'code', 'message', 'success']

/**
 * The approval a chat turn's tool result raised, or null. Only the doors that
 * hold calls: a tool in HOLDING_TOOLS whose result says so (`code:
 * 'APPROVAL_REQUIRED'`, `status: 'approval_requested'` or `awaiting_approval:
 * true`, beside a uuid `approval_id`), or a Native Intelligence tool's result that is
 * exactly the outward gate's held-call shape. Never a connected app's own
 * tool (`mcp__…`), whose result is that app's. The card renders after the
 * agent's message instead of the generic chip.
 */
export function approvalIdOfToolOutput(toolName: string, output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  if (toolName.startsWith('mcp__')) return null
  const o = output as Record<string, unknown>
  const id = uuid(o.approval_id)
  if (!id) return null
  if (HOLDING_TOOLS.has(toolName)) {
    return o.code === 'APPROVAL_REQUIRED' || o.status === 'approval_requested' || o.awaiting_approval === true ? id : null
  }
  const keys = Object.keys(o).sort()
  const gate = o.success === false && o.code === 'APPROVAL_REQUIRED' && keys.length === GATE_KEYS.length && keys.every((k, i) => k === GATE_KEYS[i])
  return gate ? id : null
}
