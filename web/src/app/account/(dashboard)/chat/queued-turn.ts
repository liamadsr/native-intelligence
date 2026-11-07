import type { VoiceAskContext } from '@/lib/voice/voice-ask'
import type { CaptureListItem } from '../views/capture-utils'
import type { MentionCompany, MentionContact } from './mention-picker'
import type { MentionRecord } from '@/lib/search/menu-search'
import type { ChatFileAttachment, EditorSelection, SkillCommand, SystemContext } from './chat-panel'
import type { SteerPhase } from '@/lib/chat/eve/eve-chat-transport'
import type { ReactionTurnMetadata } from '@/lib/chat/message-reactions'

/**
 * A message sent while a reply was still running: shown above the composer,
 * not sent yet, and sent as the next turn the moment the chat is free (the
 * reply finished, was stopped, or failed). "Send now" stops the reply so it
 * goes at once; "Edit" hands it back to the composer.
 *
 * It holds what the composer held, so it sends exactly what a typed turn sends
 * and Edit can put it all back: the words, the ready files, the @-mentions,
 * the armed skill, the agent, the editor selection, and an Interactive-mode
 * ask, with the page it was typed on (the tab may show another by the time it
 * goes). Sending again while one waits adds to it (one turn, not a pile).
 *
 * Sending over a running reply was never safe: the reply's stream kept
 * writing after the new message, and the SDK appended a second copy of it
 * (the duplicate-key warning). Waiting for the chat to be free removes that.
 */
export interface QueuedTurn {
  /** The words, joined with a blank line when several sends were added. */
  text: string
  /** Every part was spoken: voice mode stops the reply first, so it goes as
   *  soon as the stop settles and the row above the composer stays hidden. */
  spokenOnly: boolean
  /**
   * Every part came from a surface (A3: the agent's bubble, its page, a card's
   * Refine or the desktop bubble handing words to the home thread): plain
   * words, never the composer's attachments. Shown in the row above the
   * composer like typed words, it can steer by the same rules, and its words
   * go back into the composer when it is taken back.
   */
  surface?: true
  files: ChatFileAttachment[]
  notes: CaptureListItem[]
  contacts: MentionContact[]
  companies: MentionCompany[]
  /** Actions, docs, projects and initiatives @-mentioned (the main chat's). */
  records?: MentionRecord[]
  skill: SkillCommand | null
  agentId: string | null
  selection: EditorSelection | null
  /** The tab's context (the page it showed) when the words were sent. */
  context: SystemContext
  /** The user had moved to another entity since the last message. */
  contextSwitched: boolean
  voiceAsk?: VoiceAskContext
  /** Said in voice mode: the reply is read aloud (systemContext.voiceMode). */
  voiceMode?: true
  /** Set while it steers the running reply (UI-2): see QueuedSteer. */
  steer?: QueuedSteer
  /** Its steer was refused, or Send now took it back: it goes as an ordinary
   *  turn and is not asked to steer again (more words added clear it). */
  noSteer?: true
  /**
   * A reaction's own turn (message-reactions.ts): its words are the reaction's
   * line for the agent, and this rides the message, which the thread draws as
   * "You reacted 👍 to …". Never queued: it goes only when the chat is free.
   */
  reaction?: ReactionTurnMetadata
}

function byId<T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] {
  return [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))]
}

/** `next` added to what already waits: the words in order, everything attached
 *  kept once, the first skill, and the newest agent, selection, page and ask.
 *  The result carries no steer: a held steer is taken back and the joined turn
 *  asked again (a posted one is never added to — it gets a row after it). */
export function mergeQueuedTurn(prev: QueuedTurn | null, next: QueuedTurn): QueuedTurn {
  if (!prev) return next
  return {
    text: [prev.text, next.text].filter((t) => t.trim()).join('\n\n'),
    spokenOnly: prev.spokenOnly && next.spokenOnly,
    ...(prev.surface && next.surface ? { surface: true as const } : {}),
    files: byId(prev.files, next.files),
    notes: byId(prev.notes, next.notes),
    contacts: byId(prev.contacts, next.contacts),
    companies: byId(prev.companies, next.companies),
    ...(prev.records?.length || next.records?.length ? { records: byId(prev.records ?? [], next.records ?? []) } : {}),
    skill: prev.skill ?? next.skill,
    agentId: next.agentId ?? prev.agentId,
    selection: next.selection ?? prev.selection,
    context: mergedCards(prev.context, next.context),
    contextSwitched: prev.contextSwitched || next.contextSwitched,
    ...(next.voiceAsk ?? prev.voiceAsk ? { voiceAsk: next.voiceAsk ?? prev.voiceAsk } : {}),
    // Spoken in voice mode only if all of it was: typed words joined to it get a written reply.
    ...(prev.voiceMode && next.voiceMode ? { voiceMode: true as const } : {}),
  }
}

/**
 * The newer context, with the cards both turns were about (A3: a surface's
 * `aboutCardIds`, a union in order) and the card the person replied to (the
 * newer one's, else the one already waiting: card-reply.ts), its id first as
 * withReplyCard puts it (the server keeps only the first few). The message
 * replied to goes the same way (the newer one's, else the one waiting:
 * message-reply.ts); the reactions are the newer context's (it was read
 * later, so it holds every one since the last message).
 */
function mergedCards(prev: SystemContext, next: SystemContext): SystemContext {
  const replyCard = next.replyCard ?? prev.replyCard
  const replyTo = next.replyTo ?? prev.replyTo
  const first = replyCard?.kind === 'card' ? [replyCard.id] : []
  const cards = [...new Set([...first, ...(prev.aboutCardIds ?? []), ...(next.aboutCardIds ?? [])])]
  return { ...next, ...(cards.length ? { aboutCardIds: cards } : {}), ...(replyCard ? { replyCard } : {}), ...(replyTo ? { replyTo } : {}) }
}

/** The words back in the composer, ahead of anything typed since. */
export function composerTextWithQueued(queued: string, current: string): string {
  if (!queued.trim()) return current
  return current.trim() ? `${queued}\n\n${current}` : queued
}

// ── Steering (UI-2, docs/plans/always-on-agent.md §2b) ──────────────────────
//
// A held message no longer only waits for the end: when it is plain words
// typed in the composer on the page the running reply has, the transport
// steers that reply with it at the next safe point (requestSteer). The row
// then says "Waiting for a good moment…" until it goes.

/**
 * Where a steering row is: held (not sent; Edit works), posting / posted (eve
 * has it, or is getting it: Edit is gone). A refused mint or POST drops the
 * steer and the message waits for the end as an ordinary held turn.
 */
export type SteerRowState = 'held' | 'posting' | 'posted'

export interface QueuedSteer {
  /** The transport's id for it (requestSteer); the flush sends it as `body.steerId`. */
  id: string
  state: SteerRowState
  /** An Edit came too late: eve already has it, and the row says so. */
  onItsWay?: true
}

/** What a turn running now was sent with: the page (its context key) and the agent. */
export interface RunningTurnKey {
  contextKey: string
  agentId: string | null
}

/** JSON with sorted keys, so two equal contexts give one key whatever the key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The page a turn was typed on, as one comparable key (its context: a call
 * going on rides in it). Not the reactions since the last message
 * (message-reactions.ts): they change between any two sends, and they never
 * make two pages different.
 */
export function steerContextKey(context: SystemContext): string {
  return stableJson({ context: { ...context, reactions: undefined } })
}

/**
 * Whether a held turn may steer the running one (v1, decision 2): plain typed
 * words only — no files, mentions, skill, selection, spoken words or
 * Interactive ask — on the page and with the agent the running turn was sent
 * with (a steer carries no turn context of its own: eve builds it only when a
 * turn starts). Anything else waits for the end, as before.
 */
export function canSteer(turn: QueuedTurn, running: RunningTurnKey | null, contextKey: string): boolean {
  if (!running || turn.noSteer) return false
  if (!turn.text.trim() || turn.spokenOnly || turn.voiceAsk) return false
  if (turn.files.length || turn.notes.length || turn.contacts.length || turn.companies.length || turn.records?.length) return false
  if (turn.skill || turn.selection || turn.contextSwitched) return false
  return (turn.agentId ?? null) === running.agentId && contextKey === running.contextKey
}

/**
 * The row after a transport phase (the client state machine):
 *   held → posting → posted → applied | next_turn (shown until the flush adopts it)
 *   posting | posted → failed → no steer (an ordinary held turn: it goes at the end)
 */
export function steerAfterPhase(steer: QueuedSteer | undefined, phase: SteerPhase): QueuedSteer | undefined {
  if (!steer) return undefined
  switch (phase) {
    case 'held':
      return steer
    case 'posting':
      return steer.state === 'held' ? { ...steer, state: 'posting' } : steer
    case 'posted':
    case 'applied':
    case 'next_turn':
      return steer.state === 'posted' ? steer : { ...steer, state: 'posted' }
    case 'failed':
    case 'lost':
    case 'dropped':
      return undefined
  }
}

/** `turn` with its steer replaced (or removed). */
export function withSteer(turn: QueuedTurn, steer: QueuedSteer | undefined): QueuedTurn {
  const rest = { ...turn }
  delete rest.steer
  return steer ? { ...rest, steer } : rest
}

/** `turn` as an ordinary held turn for good: no steer, and none asked again. */
export function withoutSteer(turn: QueuedTurn): QueuedTurn {
  return { ...withSteer(turn, undefined), noSteer: true }
}
