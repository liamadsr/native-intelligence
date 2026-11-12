'use client'

import { useChat, type UIMessage } from '@ai-sdk/react'
import { useStickToBottom, type GetTargetScrollTop } from 'use-stick-to-bottom'
import { isToolUIPart } from 'ai'
import { ChatCardStore } from '@/components/chat-cards/card-store'
import { closeFrontCards, setComposerReserve } from '@/components/chat-cards/front-card'
import { EMPTY_PRESS_ZONE_ATTR } from '@/components/chat-cards/outside-card-press'
import { useSkyChatReport } from '@/lib/sky/use-sky-chat-report'
import { ConditionsLine } from '@/components/sky/conditions-line'
import { readProspectingSelection, type ProspectingSelectionSnapshot } from '../prospecting/selection-context'
import { ChatCardHostProvider } from '@/components/chat-cards/card-host'
import { SHOW_TOOL_NAME, cardFromShowOutput, type CardSpec } from '@/lib/chat-cards/kinds'
import { pagesFor, personalToolsFor, type OfferedPage } from '@/lib/chat-cards/page-menu'
import { isOpenedCardMessage, nextCardNumber, openedCardFromPart, openedCardMessage } from '@/lib/chat-cards/opened-card'
import { FOLD_CARDS_EVENT, cardForTarget, cardMatches, sameCardPlace, type CardMatch, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { menuRowTarget, type MenuSearchRow } from '@/lib/search/menu-search'
import { seedCardState } from '@/components/chat-cards/card-storage'
import { nestedPageOpen } from '../rail/rail-pages'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '../../workspace-switcher'
import { startersFor } from '@/lib/chat/starters'
import { QuestionPopover } from './question-popover'
import { useAskArrivalSound } from '@/lib/sounds/use-ask-arrival-sound'
import type { AnswerPermissionOptions, AgentQuestion } from '@/lib/chat/eve/agent-question'
import { isDesktopApp } from '@/lib/platform'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  attachedFilesText,
  chatFilesMeta,
  chatFileUIParts,
  clearStaleModelPicks,
  readyChatFiles,
  recordIdsBody,
  useComposerEnvironment,
  useComposerFiles,
  useComposerFolders,
  useComposerMentions,
} from './composer-state'
import { applyChatRetention, MAX_LIVE_MESSAGES, needsChatRetention } from '@/lib/chat/message-retention'
import { caughtUpThread } from '@/lib/chat/thread-catch-up'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Loader } from '@/components/ui/loader'
import {
  ChatContainerRoot,
  ChatContainerContent,
  ChatContainerScrollAnchor,
} from '@/components/ui/chat-container'
import { ScrollButton } from '@/components/ui/scroll-button'
import { ChatMessageList } from './chat-message-list'
import { EarlierMessages, earlierDayBefore, useEarlierMessages } from './earlier-messages'
import { KeptCardHost } from './kept-card-host'
import { ChatFeedPublisher } from '../side-panels/chat-feed'
import { compactChatContext, isCompactCommand } from '@/lib/chat/context-client'
import { isCaptureCard, useLiveCaptureDockSlot } from '@/components/chat-cards/card-dock-slot'
import { ChatInput, type ChatInputVoice } from './chat-input'
import { useRecipeCommands } from './slash-command-picker'
import { useFloatingChatCollapse, useFloatingChatExpanded, useFloatingChatForceExpanded } from './floating-chat'
import { useChatAutoSave } from './use-chat-auto-save'
import { useLiveConversation } from './use-live-conversation'
import { QueuedTurnRow } from './queued-turn-row'
import {
  canSteer,
  composerTextWithQueued,
  mergeQueuedTurn,
  steerAfterPhase,
  steerContextKey,
  withSteer,
  withoutSteer,
  type QueuedTurn,
  type RunningTurnKey,
} from './queued-turn'
import { EveChatTransport, EVE_SESSION_BUSY, SESSION_TIDYING_COPY, type SteerPhase } from '@/lib/chat/eve/eve-chat-transport'
import { toast } from 'sonner'
import { usePostHog } from 'posthog-js/react'
import { useOnboardingBriefPlaceholder } from './use-onboarding-brief-placeholder'
import { ChatCapturePanel } from './chat-capture-panel'
import { useRecordingStable } from '@/hooks/recording-context'
import { useReadAloud } from '@/hooks/use-read-aloud'
import { useMessageFeedback } from '@/hooks/use-message-feedback'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useVoiceMode } from '@/hooks/use-voice-mode'
import type { VoiceRefusalInfo } from '@/lib/voice/messages'
import { reportMainVoice } from '@/components/birds/voice-bird'
import { ReadAloudContext } from './read-aloud-button'
import { MessageFeedbackContext } from './message-feedback-buttons'
import type { ChatSlice } from '../main-chat/types'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted } from '@/components/desktop-titlebar'
import { createClient } from '@/lib/supabase/client'
import {
  PROSPECT_LIST_SKILL_SLUG,
  FIND_EMAIL_SKILL_SLUG,
  isStickySkill,
  buildAskAboutListHint,
  buildProspectingSeedText,
  buildFindEmailSeedText,
  type ProspectingAskDetail,
  type ProspectingStartDetail,
  type FindContactEmailContext,
} from '../prospecting/start-event'
import { buildEmailReplySeedText, type EmailReplyRequest } from '@/lib/email/reply-in-chat'
import { cardReplyMetadata, parseCardReplyRef, type CardReplyRef } from '@/lib/chat/card-reply'
import { clearConnectionNotes, pendingConnectionNotes, type ConnectionNote } from '@/lib/connections/connect-card'
import { lastMessageTime, messageTime, stampCreatedAt } from '@/lib/chat/message-time'
import { reportHomeView } from '@/lib/presence/client'
import { setReplyFocus, setReplyingCard } from '@/lib/chat/card-reply-focus'
import { CardReplyChip, CARD_REPLY_HELD_NOTE, CARD_REPLY_PLACEHOLDER } from './card-reply-chip'
import { launchFlight } from '@/lib/chat/card-reply-flight'
import {
  messageQuoteText,
  messageReplyFlightKey,
  messageReplyMetadata,
  parseMessageReplyRef,
  type MessageReplyRef,
} from '@/lib/chat/message-reply'
import {
  REACTION_EXCERPT_CHARS,
  REACTION_TURN_DELAY_MS,
  asksSomething,
  messageWords,
  reactionStartsTurn,
  reactionTurnMetadata,
  reactionTurnText,
  reactionsSince,
  type ReactionNote,
} from '@/lib/chat/message-reactions'
import { messageReactionsStoreFor, shownReaction, type MessageReactionsStore } from '@/hooks/use-message-reactions'
import { stripSuggestionMarkers } from '@/components/suggestions/remark-suggestion-markers'
import { messageBubbles } from '@/lib/chat/message-bubbles'
import { MessageInteractionsContext, jumpToMessageWhenDrawn, type MessageInteractions } from './message-interactions'
import { HOME_MESSAGE_CATCH_UP_EVENT } from '@/lib/chat/home-message'
import { OpenSessionLimitContext, continuesOnItsOwn, openSessionLimitOf, type SessionLimitChoice } from './session-limit-card'
import { MessageReplyChip, MESSAGE_REPLY_CHIP_MAX_PX, MESSAGE_REPLY_PLACEHOLDER, replyBubbleShape, type ReplyBubbleShape } from './message-reply-chip'
import { SelectionReply } from './selection-reply'
import { useSwipeToReply } from './use-swipe-to-reply'
import type { VoiceAskContext } from '@/lib/voice/voice-ask'
import type { VoiceAskDelivery } from '@/lib/voice/voice-ask-delivery'
import { useVoiceAskReplies } from './use-voice-ask-replies'
import { markSeededSend } from '@/lib/chat/seeded-send'
import { FadingBlur } from '@/components/ui/fading-blur'
import {
  publishScoutActivity,
  type ScoutEnrollEvent,
  type ScoutListActivity,
  type ScoutSaveEvent,
} from '../prospecting/scout-activity'
import { OnSkyContext } from '@/components/sky/on-sky'

export interface ProposalChatContext {
  captureId: string
  proposalId: string
  displayText: string
  description: string | null
  reasoning: string | null
  triggerQuote: string | null
  changeType: string
  entityType: string
  /** For send_email proposals — used to seed the draft. */
  emailToName?: string | null
  emailToAddress?: string | null
  emailSubject?: string | null
  emailContext?: string | null
}

/** Does the thread already hold a card of this record (opened by the person, or shown by the agent)? */
export function threadHasRecordCard(messages: readonly UIMessage[], type: string, id: string): boolean {
  for (const message of messages) {
    for (const part of message.parts) {
      const opened = openedCardFromPart(part)
      const spec = opened?.spec ?? (isToolUIPart(part) && part.state === 'output-available' ? cardFromShowOutput(part.output)?.spec : null)
      if (spec?.kind === 'record' && spec.record.type === type && spec.record.id === id) return true
    }
  }
  return false
}

export interface ChatPanelHandle {
  /**
   * Put a card in this chat as one the person opened, full screen at once
   * (src/lib/chat-cards/open-card.ts): every way into a page comes here. While
   * a turn is out it opens over the chat straight away and joins the thread
   * once the turn settles.
   */
  openCard: (request: OpenCardRequest) => void
  triggerSkill: (recipe: SkillCommand) => void
  triggerSkillBySlug: (slug: string) => void
  /** Open chat with full context about a proposed change */
  chatAboutProposal: (ctx: ProposalChatContext) => void
  /** Hand the Prospecting page's "Learn about my company" button to Scout:
   *  select the `build-prospect-list` system skill and auto-send the seeded first turn.
   *  Scout runs in the docked chat beside the page the user is already on
   *  (Liam's decision 2) — no new tab, so this only has to focus the input. */
  startProspecting: (ctx: ProspectingStartDetail) => void
  /** Arm the composer for a question about the prospect rows the user has
   *  selected (the list page's "Ask about this list" button). Unlike startProspecting
   *  this sends NOTHING: it selects the `build-prospect-list` skill, focuses the input and
   *  shows a hint naming the selection. The user's own words are the turn, and
   *  the selection itself rides on the per-turn system context, not on this
   *  call. */
  askAboutList: (ctx: ProspectingAskDetail) => void
  /** Hand the contact panel's "Find email" button to the `find-email` system
   *  skill: select it and auto-send the seeded turn naming the contact. Same
   *  auto-send posture as startProspecting — the click means one thing — but
   *  NOT sticky: it is one turn's work, so the skill releases after the send. */
  findContactEmail: (ctx: FindContactEmailContext) => void
  /** Mail's Reply / Reply All (src/lib/email/reply-in-chat.ts): auto-send the
   *  seeded turn asking the assistant to draft the reply on the thread. No
   *  skill (the reply skill is retired): the general assistant drafts it with
   *  its email tools. A click while a turn is in flight goes out once it settles. */
  replyToEmail: (request: EmailReplyRequest) => void
  /** Reply on a For you card (src/lib/chat/card-reply.ts): the card waits as a
   *  chip above the composer, its placeholder says "Reply to message", and it
   *  rides the person's next message (systemContext.replyCard). Nothing is
   *  sent; a new Reply replaces the chip. */
  replyToCard: (ref: CardReplyRef) => void
  /** Interactive mode's spoken ask (src/lib/voice/voice-ask-delivery.ts): send
   *  the request through the composer's own send path (submitTurn, so the turn
   *  keeps the chat's context and agent) with
   *  systemContext.voiceAsk, read the reply aloud whatever the auto-read
   *  setting, and report on the delivery when it starts being read and when
   *  it is over. A spoken ask's reply still generating is replaced; any other
   *  turn in flight is waited for. Accepts it at once. */
  askByVoice: (delivery: VoiceAskDelivery) => void
  /** Read the LIVE conversation (messages/input/conversationId) as a ChatSlice.
   *  Live state lives in useChat, not the stored slice: the workspace switch
   *  and the pagehide handler write this (main-chat-context.tsx), and the host
   *  reads which conversation the chat is on now. Returns rather than updates
   *  state, so it can be written in the same tick. */
  flushSnapshot: () => ChatSlice
  /** Move keyboard focus into this panel's input. Never scrolls. */
  focusInput: () => void
  /** Settles once no reply is running (at once when none is). The host waits
   *  on it before putting the chat back on the home thread. */
  whenIdle: () => Promise<void>
  /** Load a conversation into this panel, replacing its thread: the home
   *  thread (the host puts the chat back on it at boot). Never a capture's
   *  conversation: that is the call's live agent's (components/live-chat),
   *  and the main chat never sends on it (one-chat Slice 3), so one is
   *  refused (`missing`). Settles with what happened. `ifUntouched`: only
   *  while nothing happens in this chat meanwhile: a send, or any message, in
   *  the meantime aborts it, and nothing of the chat is touched. */
  loadConversation: (conversationId: string, opts?: { ifUntouched?: boolean }) => Promise<LoadConversationOutcome>
  /**
   * The words a surface sends as the person's own message in this chat (A3:
   * the agent bubble or page opening the home thread with something said),
   * through the composer's send path: they wait behind a reply still running,
   * and the draft is left alone. `cardIds` (the cards the surface showed) ride
   * the turn's systemContext as `aboutCardIds`. Resolves whether it went.
   */
  sendFromSurface: (text: string, opts?: { cardIds?: string[] }) => Promise<boolean>
  /** Start this chat's voice mode, as the composer's waveform does (the voice
   *  bird, components/birds/voice-bird.ts). Resolves null once started (or
   *  when it already runs), or the refusal; the caller reports it. */
  startVoiceMode: () => Promise<VoiceRefusalInfo | null>
  /** End this chat's voice mode (nothing when it isn't on). */
  endVoiceMode: () => void
  /**
   * A banner said the agent wrote message `messageId` in this thread
   * (lib/chat/home-message.ts): read the thread's newest server-written rows
   * in, unless the chat holds it already. The live bridge's own gap-closing
   * read; null (an older banner) reads them anyway.
   */
  catchUpServerTurns: (messageId: string | null) => Promise<void>
  /**
   * A banner's click: land on message `messageId`, read in first when the
   * chat lacks it. Resolves whether it was drawn and scrolled to; null (an
   * older banner) only reads the newest rows in.
   */
  revealMessage: (messageId: string | null) => Promise<boolean>
}

export interface SkillCommand {
  id: string
  slug: string
  name: string
  icon: string | null
  color: string | null
  description: string | null
  views_context: string[] | null
}

/**
 * What a SEEDED turn carries so the transcript can say where it came from.
 *
 * A button handoff ("Find email", "Learn about my company") auto-sends a
 * sentence the user never typed, and the armed skill's badge clears at send — so the
 * turn used to land in the transcript as an ordinary user message with no sign
 * a skill drove it. This rides on the message's `metadata`, which the AI SDK
 * keeps on the UIMessage and `chat_messages.ui_message` stores verbatim, so it
 * survives a reload with no server change.
 */
export interface SeededSkillMetadata {
  skillSlug: string
  skillName: string
}

/** A repeat of the same Reply within this long is a double click, not a second ask. */
export const REPEAT_REPLY_MS = 1500

/** The metadata for a seeded send. Kept as a function so the two handoffs and
 *  their tests cannot drift on the key names. */
export function seededSkillMetadata(recipe: SkillCommand): SeededSkillMetadata {
  return { skillSlug: recipe.slug, skillName: recipe.name }
}

/**
 * A turn's context with the card the person replied to (card-reply.ts): the
 * card itself, and an attention card's id among the cards the turn is about,
 * so the server adds its "About this item" section when the chat's workspace
 * holds it (aboutCardIds, teammate-about.ts). Its id goes first: the server
 * keeps only the first few (MAIN_ABOUT_CARDS_MAX).
 */
export function withReplyCard(context: SystemContext, card: CardReplyRef): SystemContext {
  const about = card.kind === 'card' ? [...new Set([card.id, ...(context.aboutCardIds ?? [])])] : context.aboutCardIds
  return { ...context, replyCard: card, ...(about?.length ? { aboutCardIds: about } : {}) }
}

/** A turn's context with the message the person replied to (message-reply.ts), when one waits. */
export function withReplyTo(context: SystemContext, reply: MessageReplyRef | null): SystemContext {
  return reply ? { ...context, replyTo: reply } : context
}

/**
 * Whether `bubble` of `message` is the last thing the agent said in `thread`:
 * the last bubble of its newest message. What a reaction's yes or no answers
 * (message-reactions.ts).
 */
function isNewestWords(thread: readonly UIMessage[], message: UIMessage, bubble: number): boolean {
  let newest: UIMessage | null = null
  for (let i = thread.length - 1; i >= 0 && !newest; i--) if (thread[i].role === 'assistant') newest = thread[i]
  return newest?.id === message.id && bubble === messageBubbles(message).length - 1
}

/** How long a slug lookup waits for the skill list to arrive, and how often it
 *  re-checks. The list is fetched once on ChatPanel mount; a click in the first
 *  moments after a cold load can beat it. Short enough that a genuinely missing
 *  skill doesn't stall the send by more than a blink. */
export const SKILL_LOOKUP_TIMEOUT_MS = 3000
const SKILL_LOOKUP_POLL_MS = 100

/**
 * Resolve a skill by slug, waiting briefly for the (async, once-per-mount) skill
 * fetch if the list isn't populated yet. Resolves `null` when the skill doesn't
 * exist — callers decide whether that's a no-op or a degraded send.
 *
 * `read` is a getter rather than the array itself so the poll sees each fresh
 * fetch result through the caller's ref. A list of slugs takes the first one
 * present (a skill mid-rename answers to its new and its legacy slug).
 */
export async function waitForSkillBySlug(
  read: () => SkillCommand[],
  slug: string,
  { timeoutMs = SKILL_LOOKUP_TIMEOUT_MS, pollMs = SKILL_LOOKUP_POLL_MS } = {},
): Promise<SkillCommand | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = read().find((c) => c.slug === slug)
    if (found) return found
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * An agent selected to drive the conversation (the persistent persona). Unlike
 * a skill (transient, slash-invoked), an agent is set for the whole chat and is
 * the tool boundary: its enabled_tools/disabled_tools cap what tools any turn —
 * including a skill layered on top — may call. Mirrors the recipe row's
 * agent_config tool fields.
 */
export interface AgentOption {
  id: string
  name: string
  icon: string | null
  color: string | null
  description: string | null
  /** Absent key ≠ empty list: undefined = inherit-all (legacy rows), [] = core-only. */
  enabled_tools?: string[]
  disabled_tools?: string[]
}

export interface ChatFileAttachment {
  id: string
  file: File
  status: 'uploading' | 'ready' | 'error'
  /** Signed URL after upload completes */
  url?: string
  /** Storage path in Supabase for the AI tool to reference */
  storagePath?: string
  error?: string
}

/**
 * What loading a conversation into a panel came to (ChatPanelHandle
 * .loadConversation): `loaded`; `aborted` (a newer load, or an `ifUntouched`
 * load whose chat moved on meanwhile); `missing` (no such conversation of the
 * caller's here); `failed` (the read failed).
 */
export type LoadConversationOutcome = 'loaded' | 'aborted' | 'missing' | 'failed'

/** A thread's position, cheaply: an `ifUntouched` load aborts when it moved. */
function threadMark(messages: readonly UIMessage[]): string {
  return `${messages.length}:${messages[messages.length - 1]?.id ?? ''}`
}

export interface SystemContext {
  /** Cards (attention items) a surface showed when it sent the turn (A3, sendFromSurface). */
  aboutCardIds?: string[]
  /** The For you card the person replied to, on the message they sent with its chip (card-reply.ts). */
  replyCard?: CardReplyRef
  /** The message the person replied to, on the message they sent with its chip (message-reply.ts). */
  replyTo?: MessageReplyRef
  /** Their reactions on the agent's messages since their last message (message-reactions.ts), that turn only. */
  reactions?: ReactionNote[]
  /** What the person did on a Connect card since the last send (connect-card.ts), that turn only. */
  connectionNotes?: ConnectionNote[]
  attachedNoteIds?: string[]
  /** People @-mentioned in the turn (CRM contact ids). */
  attachedContactIds?: string[]
  /** Companies @-mentioned in the turn (CRM company ids). */
  attachedCompanyIds?: string[]
  /** Records @-mentioned in the turn (their ids, by MENTION_RECORD_KEYS). */
  attachedActionIds?: string[]
  attachedDocumentIds?: string[]
  attachedProjectIds?: string[]
  attachedInitiativeIds?: string[]
  attachedDealIds?: string[]
  attachedFlowIds?: string[]
  attachedFileIds?: string[]
  attachedCalendarEventIds?: string[]
  /** Studio videos @-mentioned in the turn. */
  attachedStudioVideoIds?: string[]
  /** True when the turn is sent from the desktop app. Gates advertising the
   *  in-app browser tools (they can only run on the desktop). */
  isDesktopClient?: boolean
  /** What the user has selected on the prospect list a card in this chat is
   *  showing (B6). Read at send time (turnSystemContext), and the server turns
   *  it into the "## Prospecting selection" prompt block so "research these"
   *  resolves to the rows the user is actually looking at. */
  prospectingSelection?: ProspectingSelectionSnapshot
  /** Interactive mode: this turn is a spoken ask, and what the user was
   *  listening to (src/lib/voice/voice-ask.ts). On that turn only. */
  voiceAsk?: VoiceAskContext
  /** Voice mode: this turn is what the person said in the composer's spoken
   *  conversation, and the reply is read aloud (src/lib/voice/voice-mode-prompt.ts).
   *  On those turns only. */
  voiceMode?: boolean
  /** The name the user gave their assistant on this device (Settings → Preferences). */
  assistantName?: string
  /** A call is going on: its capture (one-chat Slice 3). The main agent hears
   *  one line about it ("On a call now: …"), never the live meeting's context:
   *  the call's live agent talks in its own chat. */
  onCallCaptureId?: string
}

// ── Scout activity extraction (C2) ───────────────────────────────────────────
// The tools whose completed output tells the prospect-list page something
// happened to it. All fourteen prospecting tools count as a "touch" (that is
// what stands the page's own gates down while Scout is working the list);
// save / dismiss / enroll additionally carry numbers the page retells.
const SCOUT_ACTIVITY_TOOLS = new Set([
  'research_my_company',
  'create_prospect_list',
  'update_prospect_list',
  'list_prospect_entries',
  'run_prospect_discovery',
  'research_prospect_companies',
  'find_prospect_people',
  'find_prospects',
  'wait_for_prospecting_run',
  'get_prospecting_run_candidates',
  'cancel_prospecting_run',
  'save_prospect_entries',
  'publish_prospect_list',
  'dismiss_prospect_entries',
  'enroll_contacts_in_sequence',
])

function asScoutRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function scoutString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** `count` when it's a real number, else the length of the array beside it. */
function scoutCount(count: unknown, fallbackArray: unknown): number {
  if (typeof count === 'number' && Number.isFinite(count)) return count
  return Array.isArray(fallbackArray) ? fallbackArray.length : 0
}

/**
 * Every list id a prospecting tool result names, in first-seen order.
 *
 * Reads the same shapes chat-message.tsx's `prospectListLink` reads (a created
 * list nests under `list`, a run under `run`, find_prospects' two legs under
 * `cards`/`people`) plus the plural forms the save/dismiss tools carry, because
 * one save CAN span lists and a summary that picked just the first would
 * silently misattribute the rest.
 */
function scoutListIds(o: Record<string, unknown>): string[] {
  const ids: string[] = []
  const push = (v: unknown) => {
    const id = scoutString(v)
    if (id && !ids.includes(id)) ids.push(id)
  }
  push(asScoutRecord(o.list)?.id)
  push(o.list_id)
  push(o.listId)
  push(asScoutRecord(o.run)?.list_id)
  push(asScoutRecord(asScoutRecord(o.cards)?.run)?.list_id)
  push(asScoutRecord(asScoutRecord(o.people)?.run)?.list_id)
  if (Array.isArray(o.list_ids)) for (const v of o.list_ids) push(v)
  if (Array.isArray(o.by_list)) for (const row of o.by_list) push(asScoutRecord(row)?.list_id)
  // The save/dismiss tools' per-item list_id is the same fact one layer down;
  // read it too so the extractor still works if only half of the plural
  // contract has landed.
  for (const key of ['saved', 'skipped', 'failed'] as const) {
    const rows = o[key]
    if (!Array.isArray(rows)) continue
    for (const row of rows) push(asScoutRecord(row)?.list_id)
  }
  return ids
}

type ScoutSaveCounts = Omit<ScoutSaveEvent, 'toolCallId' | 'published'>

/**
 * Per-list counts from one save.
 *
 * Prefers the tool's own `by_list` roll-up; falls back to counting the per-item
 * `list_id` on saved[]/skipped[] (the same numbers, one layer down) so this
 * survives either half of P1's contract landing first. A single-list save with
 * neither — an older tool build — still gets its totals, since there is exactly
 * one list they can belong to.
 */
function scoutSaveCounts(
  o: Record<string, unknown>,
  listIds: string[],
): Map<string, ScoutSaveCounts> {
  const out = new Map<string, ScoutSaveCounts>()
  const blank = (): ScoutSaveCounts => ({
    saved_companies: 0,
    saved_people: 0,
    needs_review: 0,
    skipped_other: 0,
    sequenceable_count: 0,
  })
  const at = (listId: string) => {
    let row = out.get(listId)
    if (!row) {
      row = blank()
      out.set(listId, row)
    }
    return row
  }
  const sequenceable = scoutCount(null, o.sequenceable_contact_ids)

  if (Array.isArray(o.by_list) && o.by_list.length > 0) {
    for (const raw of o.by_list) {
      const row = asScoutRecord(raw)
      const listId = scoutString(row?.list_id)
      if (!row || !listId) continue
      const target = at(listId)
      target.saved_companies = scoutCount(row.saved_companies, null)
      target.saved_people = scoutCount(row.saved_people, null)
      target.needs_review = scoutCount(row.needs_review, null)
      target.skipped_other = scoutCount(row.skipped_other, null)
    }
    // The sequenceable ids are a flat list with no per-list breakdown; a
    // single-list save can own them outright, a split one cannot claim them.
    if (out.size === 1) at([...out.keys()][0]).sequenceable_count = sequenceable
    return out
  }

  const saved = Array.isArray(o.saved) ? o.saved : []
  const skipped = Array.isArray(o.skipped) ? o.skipped : []
  const only = listIds.length === 1 ? listIds[0] : null
  for (const raw of saved) {
    const row = asScoutRecord(raw)
    const listId = scoutString(row?.list_id) ?? only
    if (!row || !listId) continue
    const target = at(listId)
    if (row.kind === 'person') target.saved_people += 1
    else target.saved_companies += 1
  }
  for (const raw of skipped) {
    const row = asScoutRecord(raw)
    const listId = scoutString(row?.list_id) ?? only
    if (!row || !listId) continue
    const target = at(listId)
    if (row.reason === 'needs_review') target.needs_review += 1
    else target.skipped_other += 1
  }
  if (only) {
    const target = at(only)
    target.sequenceable_count = sequenceable
    // Nothing itemised (an output shape we don't know) — fall back to totals.
    if (saved.length === 0 && typeof o.saved_count === 'number' && o.saved_count > 0) {
      target.saved_companies = o.saved_count
    }
    if (skipped.length === 0 && typeof o.skipped_count === 'number' && o.skipped_count > 0) {
      target.skipped_other = o.skipped_count
    }
  } else if (out.size === 1) {
    at([...out.keys()][0]).sequenceable_count = sequenceable
  }
  return out
}

export interface EditorSelection {
  entityType: string
  entityId: string
  field: string
  selectedText: string
}

/** The most a restored chat's dock waits on its catch-up before putting the capture's card in (ms). */
const CATCH_UP_WAIT_MS = 6000

/** How long a banner's click lets the thread draw what it holds before reading the message in (revealMessage, ms). */
const REVEAL_SETTLE_MS = 500

export const ChatPanel = forwardRef<ChatPanelHandle, {
  /** Stable identity for the main chat in its workspace (main-chat/types.ts).
   *  Keys useChat, the eve session, and auto-save. */
  chatSessionId: string
  initialMessages?: UIMessage[]
  initialInput?: string
  /** The conversation the initial thread belongs to. `initialMessages` are
   *  this device's stored copy of it, which can be behind or empty, so on
   *  mount the panel reads the conversation once and catches the thread up
   *  (caughtUpThread) — unless it is the home conversation, which the
   *  Realtime bridge keeps in step. */
  initialConversationId?: string
  /** F3 — the adopted onboarding HOME conversation id (conversational
   *  onboarding). When set, the Realtime bridge subscribes to it as well as any
   *  live-capture conversation, so the researcher's server-written recap and
   *  brief stream into this panel even before the user sends a first reply. Distinct from initialConversationId: this drives ONLY the
   *  Realtime bridge + skip-race placeholder, never remounts the panel. */
  homeConversationId?: string
  /** The person's home thread in this workspace (A3), once known: the chat is
   *  on it unless a live call holds it. Only the home thread rotates the
   *  first-run starters and re-syncs on focus. */
  homeThreadId?: string | null
  /** Stable id the onboarding brief row uses (`onboarding-brief-<workspaceId>`).
   *  The skip-race placeholder shares it so the real brief supersedes it in
   *  place. Only set alongside an adopted homeConversationId. */
  onboardingBriefMessageId?: string
  userAvatarUrl: string | null
  userInitials: string
  onMessagesChange?: (hasMessages: boolean) => void
  systemContext?: SystemContext
  editorSelectionRef?: React.RefObject<EditorSelection | null>
  editorSelection?: EditorSelection | null
  onClearEditorSelection?: () => void
  /** When true, always show messages (for Simple View where there's no FloatingChat wrapper) */
  alwaysShowMessages?: boolean
  /** When true, auto-focus the chat input on mount */
  autoFocus?: boolean
}>(function ChatPanel({
  chatSessionId,
  initialMessages = [],
  initialInput = '',
  initialConversationId,
  homeConversationId,
  homeThreadId,
  onboardingBriefMessageId,
  userAvatarUrl,
  userInitials,
  onMessagesChange,
  systemContext,
  editorSelectionRef,
  editorSelection,
  onClearEditorSelection,
  alwaysShowMessages = false,
  autoFocus = false,
}, ref) {
  // ChatInput contains several Radix popovers. Mount it only after hydration so
  // their generated useId paths cannot diverge between the server tree and the
  // client tree when other dashboard-only controls restore persisted state.
  const inputControlsMounted = useSyncExternalStore(
    subscribeMounted,
    getMountedSnapshot,
    getMountedServerSnapshot,
  )
  const [accessToken, setAccessToken] = useState<string | null>(null)
  // eve is tidying the conversation up (compacting) before the turn can start
  // (the transport's onSessionBusy): the waiting orb says so instead.
  const [tidying, setTidying] = useState(false)
  const [input, setInput] = useState(initialInput)
  // The composer's mentions and files: the shared state every ChatInput host
  // keeps (composer-state.ts), so a teammate's or a run's chat can't drift.
  const {
    attachedNotes,
    attachedContacts,
    attachedCompanies,
    attachedRecords,
    handleAttachNote,
    handleRemoveNote,
    handleAttachContact,
    handleRemoveContact,
    handleAttachCompany,
    handleRemoveCompany,
    handleAttachRecord,
    handleRemoveRecord,
    clearMentions,
  } = useComposerMentions()
  const { attachedFiles, setAttachedFiles, handleAttachFiles, handleRemoveFile, clearSentFiles } = useComposerFiles()
  // The old model picker's remembered thinking levels: dropped once per page load.
  useEffect(() => {
    clearStaleModelPicks()
  }, [])
  // A message sent while a reply is still running waits here until the chat is
  // free (queued-turn.ts). Sends read the ref, set together with the state.
  const [queuedTurn, setQueuedTurnState] = useState<QueuedTurn | null>(null)
  const queuedTurnRef = useRef<QueuedTurn | null>(null)
  const setQueuedTurn = useCallback((turn: QueuedTurn | null) => {
    queuedTurnRef.current = turn
    setQueuedTurnState(turn)
  }, [])
  // A message sent while the one above is already on its way to eve as a
  // steer (UI-2): one steer at a time, so it waits behind it in a second row
  // and steers the reply that one continues.
  const [followUpTurn, setFollowUpTurnState] = useState<QueuedTurn | null>(null)
  const followUpTurnRef = useRef<QueuedTurn | null>(null)
  const setFollowUpTurn = useCallback((turn: QueuedTurn | null) => {
    followUpTurnRef.current = turn
    setFollowUpTurnState(turn)
  }, [])
  /** Something the person sent waits above the composer. */
  const hasWaitingTurn = useCallback(() => !!(queuedTurnRef.current || followUpTurnRef.current), [])
  // What the running reply was sent with (dispatchTurn): the page and the
  // agent. A held message steers it only when it matches (canSteer).
  const runningTurnKeyRef = useRef<RunningTurnKey | null>(null)
  // The transport's word on the waiting message's steer (requestSteer).
  const onSteerPhase = useCallback(
    (id: string, phase: SteerPhase) => {
      const head = queuedTurnRef.current
      if (!head?.steer || head.steer.id !== id) return
      if (phase === 'lost' || phase === 'dropped') {
        // eve has it, or may: the row goes and its words are never sent
        // again. A message waiting behind it moves up.
        setQueuedTurn(followUpTurnRef.current)
        setFollowUpTurn(null)
        toast.error(
          phase === 'dropped'
            ? 'Your last message went to the agent, but its reply can’t show here now.'
            : 'Couldn’t confirm your last message reached the agent.',
        )
        return
      }
      const next = steerAfterPhase(head.steer, phase)
      // Refused (mint or POST): an ordinary held turn now, not asked again.
      if (next !== head.steer) setQueuedTurn(next ? withSteer(head, next) : withoutSteer(head))
    },
    [setQueuedTurn, setFollowUpTurn],
  )
  // True from the moment a turn starts going out until sendMessage has it (the
  // live transcript is flushed in between), so no second turn starts then.
  const turnDispatchingRef = useRef(false)
  // Loading another conversation hands a waiting message back to the composer
  // (set further down, where the composer's restore lives).
  const returnQueuedTurnRef = useRef<() => void>(() => {})
  // The agent's open question (ask_user), mirrored at render further down: a
  // reply parked on it stays "streaming" until it is answered, so words typed
  // then answer it rather than wait behind it.
  const pendingQuestionRef = useRef<{ toolCallId: string } | null>(null)
  const [activeSkill, setActiveSkill] = useState<SkillCommand | null>(null)
  // A one-turn placeholder for the composer, set when something ARMS the input
  // without sending (today: "Ask about this list" — see handleAskAboutList). It names what the
  // armed turn is about ("Ask about the 5 selected rows…") so the user can
  // see the handoff landed before they've typed a word.
  //
  // Its lifetime is exactly the armed skill's: the effect below drops it the
  // moment activeSkill goes null, which every send and every explicit clear
  // already does. That's one rule instead of a setComposerHint(null) beside each
  // of the six setActiveSkill(null) sites — which is how these drift.
  const [composerHint, setComposerHint] = useState<string | null>(null)
  // The For you card the person replied to, waiting as a chip above the
  // composer for their next message (handleReplyToCard). Mirrored in a ref so
  // the send reads it in the same tick.
  const [replyCard, setReplyCard] = useState<CardReplyRef | null>(null)
  const replyCardRef = useRef<CardReplyRef | null>(null)
  // The person's words answered the agent's question while the chip waited:
  // an answer carries no context, so the chip stays and says it waits on.
  const [replyCardHeld, setReplyCardHeld] = useState(false)
  // The message the person is replying to (message-reply.ts), waiting as a
  // chip the same way (handleReplyToMessage). One chip at a time: a card's
  // Reply takes a message's place, and a message's a card's.
  const [replyMessage, setReplyMessage] = useState<MessageReplyRef | null>(null)
  const replyMessageRef = useRef<MessageReplyRef | null>(null)
  // The whole message the chip shows when the reply is to all of it (its markdown).
  const [replyMessageBody, setReplyMessageBody] = useState<string | null>(null)
  // The bubble Reply was pressed on, whose shape the chip keeps (message-reply-chip.tsx).
  const [replyMessageShape, setReplyMessageShape] = useState<ReplyBubbleShape | null>(null)
  const clearReplyMessage = useCallback(() => {
    replyMessageRef.current = null
    setReplyMessage(null)
    setReplyMessageBody(null)
    setReplyMessageShape(null)
  }, [])
  const attachReplyCard = useCallback((card: CardReplyRef) => {
    replyCardRef.current = card
    setReplyCard(card)
    setReplyCardHeld(false)
    replyMessageRef.current = null
    setReplyMessage(null)
    setReplyMessageBody(null)
    setReplyMessageShape(null)
  }, [])
  const clearReplyCard = useCallback(() => {
    replyCardRef.current = null
    setReplyCard(null)
    setReplyCardHeld(false)
  }, [])
  const attachReplyMessage = useCallback(
    (ref: MessageReplyRef, body: string | null = null, shape: ReplyBubbleShape | null = null) => {
      replyMessageRef.current = ref
      setReplyMessage(ref)
      setReplyMessageBody(body)
      setReplyMessageShape(shape)
      clearReplyCard()
    },
    [clearReplyCard],
  )
  // Everything but the composer goes soft behind a message's chip too, a press
  // on it taking the chip off (card-reply-focus.ts), before paint as a card's.
  useLayoutEffect(() => {
    if (!replyMessage) return
    setReplyFocus(messageReplyFlightKey(replyMessage), clearReplyMessage)
    return () => setReplyFocus(null)
  }, [replyMessage, clearReplyMessage])
  // The reactions since the person's last message, for the next turn's
  // context: set once the thread and the reactions store exist (below).
  const reactionNotesRef = useRef<() => ReactionNote[]>(() => [])
  // Everything but the composer and the column goes soft, a press on it taking
  // the chip off, and the column shows the chip's card as the one in hand
  // (card-reply-focus.ts). Before paint, so the chip's first frame is lifted.
  useLayoutEffect(() => {
    if (!replyCard) return
    setReplyingCard(replyCard, clearReplyCard)
    return () => setReplyingCard(null)
  }, [replyCard, clearReplyCard])
  useEffect(() => {
    if (!activeSkill) setComposerHint(null)
  }, [activeSkill])

  /**
   * What happens to the armed skill once its message has gone out. A one-shot
   * skill is released so the badge doesn't linger; a STICKY one (Scout) stays
   * armed so every following turn still carries its skillId — that is what
   * keeps the skill's prompt and its preferred tools active for the whole
   * conversation. The composer hint is a per-turn thing either way.
   */
  const releaseSkillAfterSend = useCallback(() => {
    setComposerHint(null)
    if (isStickySkill(activeSkillRef.current?.slug)) return
    setActiveSkill(null)
    activeSkillRef.current = null
  }, [])
  // The composer's "x" on the skill badge. Stable (it only calls a state setter)
  // so the memoized ChatInput isn't handed a fresh arrow on every render; same
  // body as the inline `() => setActiveSkill(null)` it replaces.
  const handleClearSkill = useCallback(() => setActiveSkill(null), [])
  // The agent driving this conversation (persistent persona + tool boundary).
  // null → the default assistant (all tools).
  const [activeAgent, setActiveAgent] = useState<AgentOption | null>(null)
  // Recording — the STABLE subset only (low-frequency flags). Deliberately NOT
  // the full volatile context: this panel must not re-render on every ~10Hz
  // audio level / ~150ms transcript update during a call.
  const recording = useRecordingStable()

  // Use refs so the transport's lazy body/headers always read the latest values.
  // useChat stores the transport in a ref and does NOT pick up new instances,
  // so we must keep one stable transport and use getter functions for body/headers.
  const accessTokenRef = useRef(accessToken)
  useEffect(() => {
    accessTokenRef.current = accessToken
  }, [accessToken])

  useEffect(() => {
    const supabase = createClient()
    async function getToken() {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (session?.access_token) {
        setAccessToken(session.access_token)
      }
    }
    getToken()
    // Follow the client's own token refreshes, so the cached JWT the transport
    // reads is fresh at send time and a send never waits on a refresh request
    // (the transport's refresh stays the fallback for a tab that slept).
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.access_token
      if (!next) return
      accessTokenRef.current = next
      setAccessToken(next)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // Every send spreads systemContextRef.current, so stamp `isDesktopClient` onto
  // the base here — it then rides every turn (default + talk-back). The server
  // offers the Mac's local-agent tools to the desktop app (chat-run-rebuild);
  // the browser tools are on every surface (the agent's browser is in the cloud).
  const withClientFlags = useCallback(
    (ctx: SystemContext | undefined): SystemContext =>
      isDesktopApp() ? { ...(ctx ?? {}), isDesktopClient: true } : ctx ?? {},
    [],
  )
  const systemContextRef = useRef(withClientFlags(systemContext))
  useEffect(() => {
    systemContextRef.current = withClientFlags(systemContext)
  }, [systemContext, withClientFlags])

  const activeSkillRef = useRef(activeSkill)
  useEffect(() => {
    activeSkillRef.current = activeSkill
  }, [activeSkill])

  const activeAgentRef = useRef(activeAgent)
  useEffect(() => {
    activeAgentRef.current = activeAgent
  }, [activeAgent])

  // The durable conversation id, mirrored to a ref so the stable transport body
  // (created once in a useMemo) reads the LATEST value each turn. Populated from
  // useChatAutoSave's getConversationId below; the eve transport reads it (via
  // body.conversationId) to mint its run token + register eve_session_id.
  const conversationIdRef = useRef<string | null>(null)

  // Bridge to useChatAutoSave.adoptServerConversationId (defined below, after the
  // transport memo). The eve transport's onConversationEnsured calls this the
  // first time the mint resolves the durable conversation id, so the client
  // auto-save binds to the SAME row the eve session + assistant projection use
  // (the conversation-split fix). Held in a ref because the stable transport memo
  // closes over it once at mount, before the hook exists.
  const adoptConversationIdRef = useRef<((id: string) => void) | null>(null)
  // Bridge to useChatAutoSave.pendingCreate (defined below), for the transport.
  const pendingCreateRef = useRef<(() => Promise<string | null> | null) | null>(null)

  // The conversation's cards (pages in the chat): which are live, which is
  // full screen, and what each shows the person now. Every send carries their
  // compact specs (the transport reads them at send time), so the agent hears
  // about the person's changes by hand and read_card can re-run a card.
  const [cardStore] = useState(() => new ChatCardStore())
  const [cardStage, setCardStage] = useState<HTMLDivElement | null>(null)
  // Cards the person opened while a turn was out (openCard), and the card
  // waiting to go full screen once it is in the store.
  const [pendingOpened, setPendingOpened] = useState<UIMessage[]>([])
  const fullScreenAskRef = useRef<string | null>(null)
  const cardHost = useMemo(() => ({ wide: true, store: cardStore, stage: cardStage }), [cardStore, cardStage])
  // A bot's page full screen brings its own composer (it talks to that bot):
  // the chat's own steps aside meanwhile, so one composer takes input.
  const fullScreenKind = useSyncExternalStore(
    cardStore.subscribe,
    () => {
      const id = cardStore.fullScreen()
      return id ? (cardStore.card(id)?.spec.kind ?? null) : null
    },
    () => null,
  )
  const botPageUp = fullScreenKind === 'bot'
  // Every send's system context: the panel's own, plus what a prospect list in
  // one of this chat's cards has selected right now (the newest such card
  // with a live selection), so "research these" names the rows on screen.
  const turnSystemContext = useCallback((): SystemContext => {
    // A Connect card's outcome since the last send (connect-card.ts): it rides
    // the next turn's context, then the send clears it.
    const notes = pendingConnectionNotes()
    // So do the person's reactions since their last message (message-reactions.ts),
    // read off the thread: once a message of theirs is after them, they're carried.
    const reactions = reactionNotesRef.current()
    const base = {
      ...systemContextRef.current,
      ...(notes.length ? { connectionNotes: notes } : {}),
      ...(reactions.length ? { reactions } : {}),
    }
    for (const id of cardStore.idsWhere((spec) => spec.kind === 'prospecting').reverse()) {
      const spec = cardStore.card(id)?.spec
      const at = cardStore.state(id).at
      const fromSpec = spec && 'target' in spec && spec.target?.type === 'prospect_list' ? spec.target.id : null
      const selection = readProspectingSelection(at?.type === 'prospect_list' ? at.id : fromSpec)
      if (selection) return { ...base, prospectingSelection: selection }
    }
    return base
  }, [cardStore])

  const transport = useMemo(
    () => {
      // One eve durable session per chat on the chat-agent mount. It also
      // exposes resetSession() so New chat / loading a conversation starts a
      // fresh session with clean context. Every send passes its own body
      // (systemContext, agentId/skillId); the transport reads nothing else. No
      // model: the server picks one per turn from the message itself.
      return new EveChatTransport({
        // The eve mount + mint/register/persist routes authenticate with the
        // user's Supabase bearer; the transport reads the latest token via this ref.
        getAccessToken: () => accessTokenRef.current,
        // Refresh the Supabase access token when a mint 401s with an expired
        // JWT — the FIRST send after a machine/tab slept overnight hands the
        // stale cached token to the mint, which now 401s (not 500s). The
        // browser client (@supabase/ssr) auto-refreshes an expired session on
        // getSession(), so this yields a fresh access_token. Update BOTH the
        // state (so a re-render syncs) and the ref the sync getAccessToken
        // reads (so THIS send + later sends immediately use the fresh token).
        refreshAccessToken: async () => {
          const supabase = createClient()
          const {
            data: { session },
          } = await supabase.auth.getSession()
          const next = session?.access_token ?? null
          if (next) {
            accessTokenRef.current = next
            setAccessToken(next)
          }
          return next
        },
        // The durable conversation id the panel tracks, read live. The per-send
        // `sendMessage(..., { body })` never carries conversationId, so WITHOUT
        // this the eve mint on a LOADED historical chat's first turn would get
        // null and fork a new row. The transport prefers its
        // session's own resolved id once it exists; this only seeds the first turn.
        getConversationId: () => conversationIdRef.current,
        // A conversation the first save is creating (a page opened from `/`
        // on a new chat): the first send mints against it.
        getPendingConversation: () => pendingCreateRef.current?.() ?? null,
        // The cards on screen, read at send time (systemContext.cards).
        getCardContext: () => cardStore.contextEntries(),
        // The card in front finishes first what the agent must see (the Studio saves its edits).
        settleCardContext: () => cardStore.settle(),
        // The main chat has no title (one-chat Slice 1): the server's
        // first-turn title backfill stands down (see panelNamesChats).
        panelNamesChats: () => true,
        // The mint resolved the durable conversation id (creating the row on a
        // fresh chat). Bind the client auto-save to it so the user message lands
        // on the SAME row as the eve session + assistant projection — otherwise
        // the mint's row and the client's first-save row diverge (the split bug).
        onConversationEnsured: (_chatId, conversationId) => {
          conversationIdRef.current = conversationId
          adoptConversationIdRef.current?.(conversationId)
        },
        // eve is compacting the conversation before the turn starts: the
        // waiting orb gives way to SESSION_TIDYING_COPY until the reply starts.
        onSessionBusy: (_chatId, state) => setTidying(state === 'compacting'),
      })
    },
    // Stable — only created once. Reads latest values via refs.
    [],
  )

  // The chat no longer masks or reserves a band for the top HUDs. Messages
  // scroll up behind the attention deck / widget dock and stay readable through
  // them; the cards carry a heavier shadow instead, so they read as floating
  // above the text rather than needing it erased underneath.

  // A hydrated tab arrives with whatever was persisted — for a long-lived
  // session that blob can be thousands of messages with full tool-result dumps.
  // Bound it at the seam so the panel never mounts an oversized array in the
  // first place (the continuous trim effect below then holds the line).
  //
  // The useMemo is NOT protecting useChat from reseeding — useChat reads
  // `messages` once, at Chat construction, and ignores the prop on every later
  // render. It is here purely so a re-render does not re-walk a 300-message
  // array on the render path; `applyChatRetention` returns the SAME reference
  // when nothing needed trimming, so the memo's output is stable either way.
  const seedMessages = useMemo(() => applyChatRetention(initialMessages), [initialMessages])

  // The person's Retry after a session stopped answering (A4 live check):
  // useChat's regenerate, read late (the hook returns it below).
  const regenerateRef = useRef<(() => unknown) | null>(null)
  const { messages, setMessages, sendMessage: sendChatMessage, stop, status, regenerate } = useChat({
    transport,
    messages: seedMessages,
    id: chatSessionId,
    // Coalesce streaming updates: without this, every SSE text-delta (10-40/s;
    // eve does not coalesce server-side)
    // produces a new messages array and a full ChatPanel re-render. 50ms keeps
    // streamed text feeling live while capping render frequency at 20/s.
    experimental_throttle: 50,
    // NO sendAutomaticallyWhen, deliberately: eve continues a turn itself,
    // server-side on the durable session (an ask_user answer resumes the parked
    // turn via answerPermission). A client auto-resend after a completed tool call would
    // spawn a competing turn that steals the live one and wedges `streaming`.
    //
    // A failed send must NEVER be silent. Without this, a failed mint/turn
    // throws inside the transport and lands in useChat's `error`
    // state, which nothing here renders — the user's message just sits there
    // with no reply and the agent appears to IGNORE them (exactly the prod
    // live talk-back report: every turn 400'd invisibly). Surface it as a
    // toast, including the server's error body when present so the failure is
    // diagnosable from a screenshot.
    onError: (err) => {
      console.error('[chat] send failed:', err)
      const code = (err as { code?: unknown }).code
      // The session took the message and never started a turn (a retired
      // deployment's run): the transport dropped it, so a Retry sends the
      // message again, once, in a fresh session primed with the thread. Never
      // sent again by itself: nothing goes twice.
      // eve is still finishing up (tidying the conversation): a quiet word,
      // no Retry — the person sends again when it's done.
      if (code === EVE_SESSION_BUSY) {
        void import('sonner').then(({ toast }) => {
          toast.message('Still finishing up', { description: err instanceof Error ? err.message : undefined })
        })
        return
      }
      if (code === 'EVE_SESSION_STALLED') {
        void import('sonner').then(({ toast }) => {
          let retried = false
          toast.error('Your message didn’t reach the agent', {
            description: err instanceof Error ? err.message : undefined,
            action: {
              label: 'Retry',
              onClick: () => {
                if (retried) return
                retried = true
                void regenerateRef.current?.()
              },
            },
          })
        })
        return
      }
      void import('sonner').then(({ toast }) => {
        const msg = err instanceof Error && err.message ? err.message.slice(0, 300) : 'Unknown error'
        toast.error(`Message failed to send: ${msg}`)
      })
    },
  })
  // Every message the person sends carries when it went (message-time.ts):
  // its day line and its hover time, in the tab's snapshot too.
  const sendMessage = useCallback<typeof sendChatMessage>(
    (message, options) =>
      sendChatMessage(message && typeof message === 'object' ? { ...message, metadata: stampCreatedAt(message.metadata) } : message, options),
    [sendChatMessage],
  )

  useEffect(() => {
    regenerateRef.current = regenerate ? () => regenerate() : null
  }, [regenerate])
  // A turn that settled is done tidying, whatever the transport last said.
  useEffect(() => {
    if (status === 'ready' || status === 'error') setTidying(false)
  }, [status])

  // Feed the card store the conversation's cards, in order, each with its
  // number: the agent's show cards (the number their result was stamped with)
  // and the pages the person opened from `/` (the number their message holds).
  useEffect(() => {
    const cards: Array<{ id: string; spec: CardSpec; number: number | null; opened?: boolean }> = []
    for (const message of messages) {
      if (message.role === 'user') {
        for (const part of message.parts) {
          const opened = openedCardFromPart(part)
          if (opened) cards.push({ ...opened, opened: true })
        }
        continue
      }
      if (message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== 'output-available') continue
        const name = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
        if (name !== SHOW_TOOL_NAME) continue
        const card = cardFromShowOutput(part.output)
        if (card) cards.push({ id: part.toolCallId, spec: card.spec, number: card.number })
      }
    }
    // Cards opened while a turn is out: over the chat now, in the thread once it settles.
    for (const waiting of pendingOpened) {
      const opened = openedCardFromPart(waiting.parts[0])
      if (opened && !cards.some((c) => c.id === opened.id)) cards.push({ ...opened, opened: true })
    }
    cardStore.setCards(cards)
    // A card opened from outside the chat goes full screen the moment it is one of the chat's cards.
    const ask = fullScreenAskRef.current
    if (ask && cardStore.card(ask)) {
      fullScreenAskRef.current = null
      cardStore.enterFullScreen(ask)
    }
  }, [messages, cardStore, pendingOpened])

  // Latest useChat status, mirrored to a ref so the imperative handle can read
  // it without re-subscribing.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  // Mirrored at render, not in an effect like statusRef, so a click just as a
  // turn settles reads it settled instead of queueing behind nothing.
  const chatBusyRef = useRef(false)
  chatBusyRef.current = status === 'streaming' || status === 'submitted'
  // Who waits for the chat to be free (whenIdle): let go once no reply runs,
  // and on unmount (the chat they waited on is gone).
  const idleWaitersRef = useRef<Array<() => void>>([])
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    const waiting = idleWaitersRef.current
    idleWaitersRef.current = []
    for (const resolve of waiting) resolve()
  }, [status])
  useEffect(
    () => () => {
      const waiting = idleWaitersRef.current
      idleWaitersRef.current = []
      for (const resolve of waiting) resolve()
    },
    [],
  )
  const whenIdle = useCallback(
    () =>
      chatBusyRef.current
        ? new Promise<void>((resolve) => {
            idleWaitersRef.current.push(resolve)
          })
        : Promise.resolve(),
    [],
  )
  // Mail's Reply waiting on the chat, and one on its way out (handleReplyToEmail).
  const emailReplyQueueRef = useRef<EmailReplyRequest[]>([])
  const emailReplySendingRef = useRef(false)

  /**
   * Nothing is ever sent over a running reply: its stream keeps writing after
   * the new message, and the SDK appends a second copy of it. The chat is
   * occupied while a reply runs or a send is on its way out (the live
   * transcript is flushed before sendMessage).
   */
  const chatOccupied = useCallback(
    () => chatBusyRef.current || turnDispatchingRef.current || emailReplySendingRef.current,
    [],
  )
  // A send on a click elsewhere (a skill picked from a menu, a proposal's
  // "chat about it", Find email, a live question's answer…) waits here while
  // the chat is occupied and goes when it is next free, after a message
  // waiting above the composer. `run` returns once sendMessage has the turn.
  const deferredSendsRef = useRef<Array<() => unknown>>([])
  const runSend = useCallback((run: () => unknown) => {
    turnDispatchingRef.current = true
    let result: unknown
    try {
      result = run()
    } catch (err) {
      turnDispatchingRef.current = false
      throw err
    }
    void Promise.resolve(result).finally(() => {
      turnDispatchingRef.current = false
    })
  }, [])
  const whenChatFree = useCallback(
    (run: () => unknown) => {
      if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0) {
        deferredSendsRef.current.push(run)
        return
      }
      runSend(run)
    },
    [chatOccupied, hasWaitingTurn, runSend],
  )

  // Read-aloud (desktop local-tts only; inert in the browser): the speaker
  // button on each reply, via ReadAloudContext, and auto-read of replies that
  // start streaming here. Silent while a capture records. It cancels itself on
  // a new turn, when the message it reads leaves the chat, and on unmount;
  // Stop and loading a conversation cancel it explicitly below.
  const captureRecording = !!(recording.isRecording || recording.isStarting)
  // The main chat reads in the Read aloud setting's voice.
  const readAloud = useReadAloud({
    messages,
    status,
    recording: captureRecording,
    active: true,
  })
  // Chat voice (desktop only; docs/plans/chat-voice.md): whether the composer
  // shows the dictation mic and the voice-mode waveform, and whether they can
  // start. Inert in the browser.
  const voiceAvailability = useVoiceAvailability({ recording: captureRecording })
  // Voice mode is set up further down (it sends through submitTurn); loading
  // another conversation into this panel ends it through this ref.
  const endVoiceModeRef = useRef<() => void>(() => {})
  // And the handle starts it through this one (ChatPanelHandle.startVoiceMode).
  const startVoiceModeRef = useRef<() => Promise<VoiceRefusalInfo | null>>(async () => ({ code: 'not_ready', detail: null }))
  const stopReadAloud = readAloud.stop
  // Stop (and Send now): the reply ends where it is, and says so — a one-line
  // "Stopped" under it (chat-message.tsx), which the transport also persists
  // (metadata.stopped) so a reload shows it too.
  const handleStop = useCallback(() => {
    stopReadAloud()
    const replyRunning = statusRef.current === 'streaming'
    void stop()
    if (!replyRunning) return
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || (last.metadata as { stopped?: unknown } | undefined)?.stopped) return prev
      return [...prev.slice(0, -1), { ...last, metadata: { ...((last.metadata as object | undefined) ?? {}), stopped: true } }]
    })
  }, [stopReadAloud, stop, setMessages])

  // ── Auto-scroll control ───────────────────────────────────────────────────
  // We own the stick-to-bottom instance up here (rather than letting
  // <ChatContainerRoot> own it internally) so the send handlers — which live
  // outside the StickToBottom provider — can force a snap to the bottom. The
  // instance is handed down to ChatContainerRoot via the `instance` prop.
  // The response runway is real scrollable space, but it must not count as the
  // conversation's logical bottom. While it exists, stay at the submitted user
  // turn until the response fills the visible area, then follow the response's
  // lower edge. This keeps use-stick-to-bottom's isAtBottom/escaped state honest:
  // no false down-arrow, normal streaming follow, and manual scroll-up still
  // escapes the lock.
  const getChatTargetScrollTop = useCallback<GetTargetScrollTop>(
    (physicalBottom, { scrollElement, contentElement }) => {
      const runway = contentElement.querySelector<HTMLElement>('[data-chat-response-runway]')
      const latestUser = contentElement.querySelector<HTMLElement>('[data-latest-user-message]')
      if (!runway || !latestUser) return physicalBottom

      const scrollerRect = scrollElement.getBoundingClientRect()
      const currentScrollTop = scrollElement.scrollTop
      const turnAnchor = Number.parseFloat(
        getComputedStyle(scrollElement).getPropertyValue('--chat-turn-anchor'),
      ) || 340
      const userTop =
        currentScrollTop + latestUser.getBoundingClientRect().top - scrollerRect.top
      const responseBottom =
        currentScrollTop + runway.getBoundingClientRect().top - scrollerRect.top
      const anchoredTurn = userTop - turnAnchor
      const followResponse = responseBottom - scrollElement.clientHeight

      return Math.max(0, Math.min(physicalBottom, Math.max(anchoredTurn, followResponse)))
    },
    [],
  )
  const stickToBottom = useStickToBottom({
    initial: 'instant',
    resize: 'smooth',
    targetScrollTop: getChatTargetScrollTop,
  })
  const stickContentRef = stickToBottom.contentRef
  const stickState = stickToBottom.state
  const handleManagedChatScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const scroller = event.currentTarget
      const content = stickContentRef.current
      if (!content?.querySelector('[data-chat-response-runway]')) return

      const physicalBottom = Math.max(0, scroller.scrollHeight - 1 - scroller.clientHeight)
      const managedBottom = getChatTargetScrollTop(physicalBottom, {
        scrollElement: scroller,
        contentElement: content,
      })
      if (scroller.scrollTop > managedBottom + 1) {
        // Use the library's state setter so its next native scroll event is
        // recognized as our correction, not mistaken for a manual scroll-up.
        stickState.scrollTop = managedBottom
      }
    },
    [getChatTargetScrollTop, stickContentRef, stickState],
  )

  const scrollToBottomFn = stickToBottom.scrollToBottom
  const stopScrollFn = stickToBottom.stopScroll

  // A newly submitted user turn is anchored near the HUD fade's lower edge, leaving a
  // blank runway beneath it for the agent's response. The pending count prevents
  // the layout effect from targeting the previous user message during the render
  // that merely enables the runway; it waits until useChat appends the new turn.
  const [responseRunwayActive, setResponseRunwayActive] = useState(false)
  const pendingFocusAfterCountRef = useRef<number | null>(null)
  const prepareForResponse = useCallback(() => {
    pendingFocusAfterCountRef.current = messages.length
    setResponseRunwayActive(true)
    stopScrollFn()
  }, [messages.length, stopScrollFn])

  useLayoutEffect(() => {
    const previousCount = pendingFocusAfterCountRef.current
    if (previousCount === null || messages.length <= previousCount) return

    pendingFocusAfterCountRef.current = null
    stopScrollFn()
    scrollToBottomFn({ animation: 'smooth', ignoreEscapes: true })
  }, [messages.length, stopScrollFn, scrollToBottomFn])

  // Retire the runway once its turn settles (ready or error — either way the
  // agent is done streaming). Nothing else ever cleared this:
  // `handleLoadConversation` resets it for a DIFFERENT conversation, but a
  // turn finishing inside the SAME conversation left `.chat-response-runway`'s
  // reserved `max(160px, 100dvh - 340px)` spacer mounted — visually correct
  // while it was pulling the fresh reply up into view, permanently wrong once
  // the reply is the last thing in a short (or short-again-after-scroll-up)
  // conversation: the finished exchange sits pinned near the top with a huge
  // dead gap below it instead of settling to the bottom above the composer,
  // for the rest of this ChatPanel's mounted lifetime. `status` (not
  // `messages`) is what settles LAST for a turn, so it's the right trigger;
  // guard on `responseRunwayActive` so this doesn't fire on every idle render.
  useEffect(() => {
    if (!responseRunwayActive) return
    if (status !== 'ready' && status !== 'error') return
    setResponseRunwayActive(false)
  }, [status, responseRunwayActive])

  // While a turn is streaming, keep the view pinned to the bottom as content
  // grows. This is the core fix for "auto-scroll falls out of sync": the library
  // gates ALL auto-scroll on an internal `isAtBottom` flag, and that flag can be
  // spuriously dropped to false during a fast streamed burst — a big code block
  // or tool result that grows the content past the 70px stickiness window (or a
  // 1px browser re-anchor mis-read as a scroll-up) before the smooth spring
  // catches up. Once dropped, every subsequent token renders off-screen.
  //
  // The recovery distinguishes the two ways stickiness is lost via the library's
  // own `escapedFromLock` signal:
  //   • escapedFromLock === true  → the USER scrolled up (wheel/scroll-up). Leave
  //     them alone so they can read history; the scroll-to-bottom button is their
  //     way back. (This is the behavior we agreed to preserve.)
  //   • escapedFromLock === false → a SPURIOUS drop. Re-pin with a real
  //     scrollToBottom(), which re-sets the internal flag so auto-scroll resumes.
  // `messages` (and the streaming status) changing each token is what re-runs
  // this, so the re-pin tracks the stream frame-by-frame.
  const isStreaming = status === 'streaming' || status === 'submitted'
  // The sky behind the chat holds still while a reply streams in or a page is
  // full screen, and shows more strongly behind an empty chat (lib/sky).
  useSkyChatReport({ active: true, streaming: isStreaming, fullScreen: fullScreenKind !== null, empty: messages.length === 0 })
  const escapedFromLock = stickToBottom.escapedFromLock
  const isAtBottom = stickToBottom.isAtBottom
  useEffect(() => {
    if (!isStreaming) return
    if (escapedFromLock) return
    if (isAtBottom) return
    scrollToBottomFn({ animation: 'smooth' })
  }, [messages, isStreaming, escapedFromLock, isAtBottom, scrollToBottomFn])

  // Auto-save conversations to database.
  const { setConversationId, adoptServerConversationId, getConversationId, pendingCreate, markSaved, persistNow } = useChatAutoSave(
    messages,
    status,
    initialConversationId,
  )

  // Bridge adoptServerConversationId into the ref the (stable) eve transport
  // closes over, so onConversationEnsured can bind the auto-save to the mint's row.
  useEffect(() => {
    adoptConversationIdRef.current = adoptServerConversationId
    pendingCreateRef.current = pendingCreate
  }, [adoptServerConversationId, pendingCreate])

  // Keep the transport-facing conversation-id ref fresh. getConversationId()
  // returns null for a brand-new chat until the first auto-save resolves; this
  // re-reads it as messages/status change so the eve transport's next turn mints
  // its token against the real durable id once it exists. Guard against clobbering
  // an id the eve mint already adopted with a null (getConversationId is null
  // until the client's own save path resolves — but on the eve path the mint's
  // adopt is authoritative and lands first).
  // The same id as state, for the teammate-report bridge below: it changes
  // only alongside the messages (a first save, a mint adopt, a load, New chat).
  const [boundConversationId, setBoundConversationId] = useState<string | null>(initialConversationId ?? null)
  useEffect(() => {
    const tracked = getConversationId()
    if (tracked) conversationIdRef.current = tracked
    setBoundConversationId(tracked)
  }, [getConversationId, messages, status])

  // The person's environment for local agents (docs/plans/local-agents.md):
  // folders on their Mac, the same in every chat until they remove one. The
  // + menu's Select folder… adds to it, only in the desktop app with local
  // agents available (the hook's canPick); the side panel's Environment card
  // lists and removes.
  const composerFolders = useComposerFolders({ enabled: true })

  // Earlier messages, a page at a time (A3, earlier-messages.tsx): a loaded
  // conversation opens on its newest page, and scrolling to its top reads the
  // page before. Display only: never part of the live thread.
  const earlier = useEarlierMessages({
    conversationId: boundConversationId,
    firstMessageId: messages[0]?.id ?? null,
    liveCount: messages.length,
    live: messages,
  })
  const earlierRef = useRef(earlier)
  useEffect(() => {
    earlierRef.current = earlier
  }, [earlier])
  // The person's thumbs on this conversation's replies (the evals flywheel),
  // read once per conversation; null until the conversation has an id.
  const messageFeedback = useMessageFeedback(boundConversationId)
  // The person's reactions on its replies (use-message-reactions.ts), kept per conversation for the tab.
  const messageReactions = useMemo(() => messageReactionsStoreFor(boundConversationId), [boundConversationId])
  const reactionsStoreRef = useRef<MessageReactionsStore | null>(messageReactions)
  reactionsStoreRef.current = messageReactions
  // Read once per conversation: the thread restored from the device's copy predates any made since.
  useEffect(() => {
    void messageReactions?.load()
  }, [messageReactions])
  const liveMessageIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages])
  const earlierSlot = useMemo(
    () => <EarlierMessages earlier={earlier} liveIds={liveMessageIds} userAvatarUrl={userAvatarUrl} userInitials={userInitials} />,
    [earlier, liveMessageIds, userAvatarUrl, userInitials],
  )
  // The earlier pages' last day, so the thread's first day line isn't drawn twice across the seam.
  const dayBefore = useMemo(() => earlierDayBefore(earlier.older, liveMessageIds), [earlier.older, liveMessageIds])

  // Server-written rows, merged into this panel over Realtime
  // (use-live-conversation.ts). The main chat is the person's home thread, so
  // it takes the rows the server writes there and nothing else ('server-turns':
  // teammates' reports, the server turns that follow them, an approval's
  // outcome), never 'all', which would swap its own live turns for their
  // stored copies. The adopted onboarding home conversation is the one
  // exception: the researcher's recap and brief are written into it from
  // the start, so it takes every server-written row. A call's
  // live conversation is never this panel's: its live agent's chat
  // (components/live-chat) takes that one.
  // On the home thread (A3), as far as the panel knows: undefined until the
  // home thread's id is known.
  const isHomeThread = homeThreadId ? boundConversationId === homeThreadId : undefined
  // Where this chat's work runs (docs/plans/environments.md §6): the selector
  // under the box, read once per conversation; a new chat starts on your default.
  const composerEnvironment = useComposerEnvironment({ enabled: true, conversationId: boundConversationId })
  const liveConversation = useLiveConversation({
    conversationId: homeConversationId ?? boundConversationId,
    status,
    setMessages,
    markSaved,
    scope: homeConversationId ? 'all' : 'server-turns',
  })

  // A message the agent wrote here, as a banner names it (the router's
  // `agent_message`, lib/chat/home-message.ts). The banner comes two minutes
  // after the message at least, so a chat that lacks it then had its live
  // bridge miss it (PROD 2026-10-31: a home turn never reached the open
  // desktop chat): the bridge's own read brings it in, and the miss is
  // reported, with whether the row waited in the mid-turn buffer or never came.
  const posthog = usePostHog()
  const reportHomeCatchUp = useCallback(
    (props: { trigger: 'banner' | 'click'; before: string; drawn?: boolean }) => {
      try {
        posthog?.capture(HOME_MESSAGE_CATCH_UP_EVENT, { ...props, status: statusRef.current, channel: liveConversation.channelStatus() ?? 'none' })
      } catch {
        // Analytics never stands in the way.
      }
    },
    [posthog, liveConversation],
  )
  /** Where a message this chat lacks is: waiting in the bridge's mid-turn buffer, or never come. */
  const missingFrom = useCallback((messageId: string) => (liveConversation.buffered(messageId) ? 'buffered' : 'absent'), [liveConversation])
  const catchUpServerTurns = useCallback(
    async (messageId: string | null) => {
      if (messageId && messagesRef.current.some((m) => m.id === messageId)) return
      const before = messageId ? missingFrom(messageId) : 'unknown'
      await liveConversation.catchUp()
      if (messageId) reportHomeCatchUp({ trigger: 'banner', before })
    },
    [liveConversation, missingFrom, reportHomeCatchUp],
  )
  const revealMessage = useCallback(
    async (messageId: string | null): Promise<boolean> => {
      // A thread the host just put the chat back on draws its rows (and binds
      // the bridge to it) on the next render: give it that before reading
      // anything, so a catch-up never reads the conversation the chat left.
      if (messageId && (await jumpToMessageWhenDrawn(messageId, REVEAL_SETTLE_MS))) return true
      const before = !messageId ? 'unknown' : messagesRef.current.some((m) => m.id === messageId) ? 'held' : missingFrom(messageId)
      await liveConversation.catchUp()
      if (!messageId) return false
      const drawn = await jumpToMessageWhenDrawn(messageId)
      reportHomeCatchUp({ trigger: 'click', before, drawn })
      return drawn
    },
    [liveConversation, missingFrom, reportHomeCatchUp],
  )

  // Skip-race placeholder (conversational onboarding): if the user lands on the
  // adopted home conversation before the researcher's brief row exists, show a
  // pending bubble that narrates research progress, superseded in place (shared
  // stable id) the instant the real brief arrives via Realtime.
  useOnboardingBriefPlaceholder({
    homeConversationId: homeConversationId ?? null,
    briefMessageId: onboardingBriefMessageId ?? null,
    messages,
    setMessages,
    markSaved,
  })

  // Dispose the transport on unmount: it drops its eve sessions and releases
  // its deploy-reload blocker.
  useEffect(() => {
    return () => {
      void transport.disposeAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Start the NEXT turn on a fresh eve session with clean context: the shared
  // idiom behind New chat and loading a conversation.
  const resetChatSession = useCallback(() => {
    void transport.resetSession(chatSessionId)
  }, [transport, chatSessionId])

  // Hold the live transcript inside its retention budget, continuously.
  //
  // This is the crux of the fix, not the snapshot-time cap below it: a
  // background tab's panel is never unmounted (dashboard-shell hides inactive
  // panels with visibility:hidden + inert), so its snapshot only fires on tab
  // close / workspace switch / pagehide. Between those, the ONLY thing bounding
  // the array it keeps in the WebContent heap is this effect.
  //
  // Gated on a settled status: trimming mid-turn could drop a message the
  // in-flight run still resolves against (an answer targets a pending tool
  // part by toolCallId). Even at 'ready' a pending ask_user
  // can be parked in the array — capMessages clamps the cut in front of the
  // oldest such message so the pendingQuestion popover is never orphaned.
  //
  // Termination is by IDEMPOTENCE, not reference equality: @ai-sdk/react's
  // setter always stores a fresh `[...next]` and notifies, so this effect
  // necessarily re-runs on its own output. `needsChatRetention` then returns
  // false for the already-trimmed array and the loop stops after one pass.
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    if (!needsChatRetention(messages)) return
    setMessages((prev) => applyChatRetention(prev))
  }, [messages, status, setMessages])

  // The latest thread and draft, for the flush and the stable handlers.
  const messagesRef = useRef(messages)
  const inputRef = useRef(input)
  // The reactions since the person's newest message: none before a message of
  // theirs that doesn't say when it went (an old tab snapshot: they went then).
  reactionNotesRef.current = () => {
    const thread = messagesRef.current
    let since: number | null = null
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i].role !== 'user' || isOpenedCardMessage(thread[i])) continue
      since = messageTime(thread[i]) ?? Date.now()
      break
    }
    const store = reactionsStoreRef.current
    return reactionsSince(
      thread,
      since,
      (words) => messageQuoteText(stripSuggestionMarkers(words), REACTION_EXCERPT_CHARS),
      store ? (id, bubble) => store.get(id, bubble) : undefined,
    )
  }
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    inputRef.current = input
  }, [input])

  // ── Pages from `/` (the instant path) ──────────────────────────────────
  // Picking a page in the composer's `/` menu opens it as every other way in
  // does (openCardHere, below): full screen at once, no model call, no eve
  // turn, and put away when the person closes it.
  const workspaceEdition = useWorkspaceEdition()
  // A guest of the workspace is not offered a members-only page (the Studio refuses a guest).
  const workspaceGuest = useIsWorkspaceGuest()
  // Calendar and mail are the person's own: offered only where this chat may
  // read them (show's per-person gate), never in a bot's conversation. The
  // starters follow the same rule.
  const personalTools = useMemo(() => personalToolsFor({ bot: false, agent: activeAgent }), [activeAgent])
  const pages = useMemo(
    () => pagesFor(workspaceEdition, { desktop: isDesktopApp(), personalTools, guest: workspaceGuest }),
    [workspaceEdition, personalTools, workspaceGuest],
  )
  // For openCardHere (below): a nested page opens inside its parent's card.
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  // The first-run starters (lib/chat/starters.ts) the empty chat's composer
  // rotates through in its placeholder: the areas that are on in the
  // workspace, calendar and mail only where this chat may read them.
  const starterPrompts = useMemo(
    () => startersFor(workspaceEdition, personalTools).flatMap((area) => area.prompts),
    [workspaceEdition, personalTools],
  )

  // ── Every way in opens a card (lib/chat-cards/open-card.ts) ────────────
  // A page from `/`, a chip, a notification, a bot's Open, a desktop event:
  // the card is put in the chat as one the person opened (a message of their
  // own, lib/chat-cards/opened-card.ts), numbered on from the chat's cards and
  // saved like any message, and goes full screen at once. The agent hears of
  // it through the cards note on its next turn. It never draws in the chat
  // column: closing it puts it away, and it opens again from wherever it was
  // opened (the same card, brought back). The three visited last stay mounted
  // (kept-card-host.tsx), so one of them opens again at once.
  // Where it starts inside (a flow's editor, an event open on its day) is
  // written to the card's state before it mounts. While a turn is out, the
  // card opens over the chat at once and its message joins the thread once
  // the turn settles (the AI SDK writes a streaming reply onto the LAST
  // message, so a message put under it would take the reply's place).
  const pendingOpenedRef = useRef<UIMessage[]>([])
  // The composer as the device keeps it: a typed message still waiting for
  // the reply goes back in, so a reload never loses it — but not one already
  // on its way to eve as a steer: eve has it.
  const composerSnapshot = useCallback(() => {
    let text = inputRef.current
    for (const waiting of [followUpTurnRef.current, queuedTurnRef.current]) {
      if (!waiting || waiting.spokenOnly || (waiting.steer && waiting.steer.state !== 'held')) continue
      text = composerTextWithQueued(waiting.text, text)
    }
    return text
  }, [])
  // Cards opened over one chat while its turn was out never follow the person
  // into another (a workspace switch remounts with another id; loading a
  // conversation clears them too). Before the effect that settles them.
  useEffect(() => {
    if (!pendingOpenedRef.current.length) return
    pendingOpenedRef.current = []
    setPendingOpened([])
  }, [chatSessionId])
  // The live capture's notepad around this chat (live-capture-dock.tsx): its
  // capture's card docks there instead of going full screen.
  const dockSlot = useLiveCaptureDockSlot()
  const dockRef = useRef(dockSlot)
  dockRef.current = dockSlot
  /** This chat's card the person opened of a place, if any: in the store, waiting on a turn, or just put in the thread. */
  const openedCardOf = useCallback(
    (match: (spec: CardSpec) => boolean): string | null => {
      const inStore = cardStore.newestWhere((spec, card) => !!card.opened && match(spec))
      if (inStore) return inStore
      const waiting = pendingOpenedRef.current.map((m) => openedCardFromPart(m.parts[0])).find((c) => c && match(c.spec))
      if (waiting) return waiting.id
      // Put in the thread a moment ago, not in the store yet (its effect runs after this render).
      for (let i = messagesRef.current.length - 1; i >= 0; i--) {
        for (const part of messagesRef.current[i].parts) {
          const opened = openedCardFromPart(part)
          if (opened && match(opened.spec)) return opened.id
        }
      }
      return null
    },
    [cardStore],
  )
  const openCardHere = useCallback(
    // The card it opened or brought back here, or null (another chat's, or the dock's).
    (asked: OpenCardRequest): string | null => {
      // Projects, Initiatives and Teams nest under Tasks (Liam, 11-11): their page,
      // however it is opened (`/`, Search, a link, openTarget `page`), is My
      // Actions' card on that place inside it (rail/rail-pages.ts
      // nestedPageOpen), the same card brought back when it is open already.
      // Where My Actions is off here, the page opens on its own.
      const nested = nestedPageOpen(asked.spec, pagesRef.current)
      const request: OpenCardRequest = nested
        ? { ...asked, spec: nested.spec, seed: { ...asked.seed, tasksPlace: nested.place } }
        : asked
      // The person's calendar and mail open here too, whatever drives the
      // chat: there is one chat (docs/plans/one-chat.md). `/` and the
      // starters still leave them out where the chat may not read them.
      // The same place already opened here: that card, full screen again (and
      // the one visited last, so kept mounted), not a second one. `reuse` (the
      // browser, a bot's page, the live capture) takes the agent's cards of it too.
      const samePlace = (spec: CardSpec) => sameCardPlace(spec, request.spec)
      // The capture recording now, in the chat its notepad docks beside: its
      // card goes to the dock, not full screen.
      // Only a card the person opened docks (the kept-card host mounts it),
      // never an agent's card in a reply.
      const dock = dockRef.current
      const docking = !!dock && !dock.ending && isCaptureCard(request.spec, dock.captureId)
      if (docking) {
        const docked = openedCardOf(samePlace)
        if (docked) {
          if (request.seed) cardStore.update(docked, seedCardState(request.seed), { touch: true })
          cardStore.setDocked(docked)
          return null
        }
      }
      const held = docking
        ? null
        : (cardStore.newestWhere((spec, card) => (!!request.reuse || !!card.opened) && samePlace(spec)) ??
          pendingOpenedRef.current.map((m) => openedCardFromPart(m.parts[0])).find((c) => c && samePlace(c.spec))?.id ??
          null)
      if (held) {
        // Where it was asked to open (a bot's page on one of its items) wins.
        if (request.seed) cardStore.update(held, seedCardState(request.seed), { touch: true })
        cardStore.enterFullScreen(held)
        return held
      }
      const id = crypto.randomUUID()
      const pendingHighest = pendingOpenedRef.current.reduce((max, m) => Math.max(max, openedCardFromPart(m.parts[0])?.number ?? 0), 0)
      const number = nextCardNumber(Math.max(cardStore.highestNumber(), pendingHighest))
      // Its first visit, so a page that never goes full screen (one of several
      // picked at once) still counts among the pages visited last.
      cardStore.update(id, { ...(request.seed ? seedCardState(request.seed) : {}), visitedAt: Date.now() }, { touch: !!request.seed })
      const message = openedCardMessage({ id, spec: request.spec, number, page: request.from })
      // Docked, it is the dock's from the start (before it is one of the store's cards).
      if (docking) cardStore.setDocked(id)
      else fullScreenAskRef.current = id
      const busy = statusRef.current === 'streaming' || statusRef.current === 'submitted'
      if (busy) {
        pendingOpenedRef.current = [...pendingOpenedRef.current, message]
        setPendingOpened(pendingOpenedRef.current)
        return docking ? null : id
      }
      // Not scrolled to: it never draws in the chat column.
      const thread = [...messagesRef.current, message]
      messagesRef.current = thread
      setMessages(thread)
      persistNow(thread)
      return docking ? null : id
    },
    [cardStore, setMessages, persistNow, openedCardOf],
  )
  // The dock and the store in step: the capture's card is the docked one
  // while it records; when it ends (the dock sliding away) it is let go, a
  // page like any other, the one visited last (so kept mounted). A chat the dock is beside with no card of the capture (a resume,
  // a recovered capture) gets one, docked, after a moment: what was delivered
  // to it at the start (its title with it) lands first.
  const dockCaptureId = dockSlot?.captureId ?? null
  const dockEnding = dockSlot?.ending ?? false
  // A restored chat's catch-up (below) has settled: read, refused, failed, or
  // not needed. A card put in before it would change the thread it compares
  // against, and the catch-up would keep the stale copy (the capture's card
  // in it twice, maybe). At most CATCH_UP_WAIT_MS, so a read that hangs never
  // holds the dock's card back for good.
  const [catchUpSettled, setCatchUpSettled] = useState(() => !initialConversationId || initialConversationId === homeConversationId)
  useEffect(() => {
    if (catchUpSettled) return
    const timer = setTimeout(() => setCatchUpSettled(true), CATCH_UP_WAIT_MS)
    return () => clearTimeout(timer)
  }, [catchUpSettled])
  useEffect(() => {
    if (!dockCaptureId || dockEnding) {
      if (cardStore.docked()) cardStore.setDocked(null)
      return
    }
    const ofCapture = (spec: CardSpec) => isCaptureCard(spec, dockCaptureId)
    const found = openedCardOf(ofCapture)
    if (found) {
      cardStore.setDocked(found)
      return
    }
    // The thread may still be catching up, and may hold the capture's card then.
    if (!catchUpSettled) return
    const timer = setTimeout(() => {
      if (openedCardOf(ofCapture)) return
      const card = cardForTarget({ type: 'capture', id: dockCaptureId })
      if (card) openCardHere({ spec: card.spec, from: 'capture' })
    }, 400)
    return () => clearTimeout(timer)
  }, [dockCaptureId, dockEnding, messages, pendingOpened, cardStore, openedCardOf, openCardHere, catchUpSettled])
  const handleOpenPage = useCallback(
    (page: OfferedPage) => openCardHere({ spec: page.spec(new Date()), from: page.slug }),
    [openCardHere],
  )
  // A record from `/` (or ⌘↵ under `@`): its card, here, at once (docs/plans/slash-search.md).
  const handleOpenRecord = useCallback(
    (row: MenuSearchRow) => {
      const card = cardForTarget(menuRowTarget(row))
      if (card) openCardHere({ spec: card.spec, ...(card.seed ? { seed: card.seed } : {}), from: 'menu' })
    },
    [openCardHere],
  )
  // Cards put back (a discarded capture's, the browser's when the agent
  // closes it): out of full screen, and folded to their pill when asked.
  useEffect(() => {
    const onFold = (e: Event) => {
      const match = (e as CustomEvent<CardMatch>).detail
      if (!match || match.kind !== 'record') return
      for (const id of cardStore.idsWhere((spec) => cardMatches(spec, match))) {
        if (match.collapse) cardStore.collapse(id)
        else if (cardStore.fullScreen() === id) cardStore.exitFullScreen()
      }
    }
    window.addEventListener(FOLD_CARDS_EVENT, onFold)
    return () => window.removeEventListener(FOLD_CARDS_EVENT, onFold)
  }, [cardStore])
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    const waiting = pendingOpenedRef.current
    if (!waiting.length) return
    pendingOpenedRef.current = []
    setPendingOpened([])
    const thread = [...messagesRef.current, ...waiting]
    messagesRef.current = thread
    setMessages(thread)
    // Saved once the turn they waited for has written its own rows (the eve
    // persist), so a reload, which orders rows by when they were written,
    // keeps them below that reply.
    void transport
      .turnPersisted(chatSessionId)
      .catch(() => {})
      .then(() => persistNow(messagesRef.current))
  }, [status, setMessages, persistNow, transport, chatSessionId])

  // ── Catching a restored thread up ───────────────────────────────────────
  // The chat restored after a reload or a workspace switch mounts on the copy
  // of its thread this device stored, and that copy can be behind its
  // conversation, or empty: it is written only on pagehide and a workspace
  // switch, and a full storage bucket refuses the write without a word. The
  // conversation's rows hold every message, so a panel that mounts bound to
  // one reads them once, and takes them when they carry on from what it has —
  // only while nothing has happened here since it mounted.
  useEffect(() => {
    const conversationId = initialConversationId
    if (!conversationId || conversationId === homeConversationId) return
    const mountedWith = messagesRef.current
    let cancelled = false
    void (async () => {
      try {
        // The newest rows, a little past what a live thread keeps (a months-long
        // home thread never loads whole); earlier ones page in on scroll (A3).
        const res = await fetch(`/api/account/chat-history/${conversationId}?limit=${MAX_LIVE_MESSAGES + 50}`)
        if (!res.ok) return
        const data = (await res.json()) as { messages?: unknown; title?: unknown; hasMore?: unknown }
        if (cancelled || messagesRef.current !== mountedWith || statusRef.current !== 'ready') return
        if (getConversationId() !== conversationId) return
        // A page of a longer thread (hasMore): what the copy holds from before it is older history, not a turn of its own.
        const next = caughtUpThread(mountedWith, data.messages, { partial: data.hasMore === true })
        // Older rows remain past this read, or past what the thread holds.
        const rowCount = Array.isArray(data.messages) ? data.messages.length : 0
        earlierRef.current.arm(conversationId, data.hasMore === true || rowCount > (next ?? mountedWith).length)
        if (!next) return
        setMessages(next)
        setConversationId(conversationId, next)
      } catch {
        // Offline, or the conversation is gone: the stored thread stands.
      } finally {
        if (!cancelled) setCatchUpSettled(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the thread the panel mounted with
  }, [])

  // The home thread in more than one window (A3): another window (the desktop
  // app beside a browser tab, the agent bubble) may have carried it on. When
  // this window comes back into focus with no reply running, it reads the
  // newest rows and takes them when they carry on from what it holds
  // (caughtUpThread: never losing a message of its own). Nothing happens
  // while it is busy, and a read that lands after the chat moved is dropped.
  useEffect(() => {
    if (!isHomeThread) return
    let inflight = false
    const resync = async () => {
      if (inflight || document.visibilityState === 'hidden') return
      const conversationId = getConversationId()
      if (!conversationId || statusRef.current !== 'ready') return
      inflight = true
      const mark = threadMark(messagesRef.current)
      try {
        const res = await fetch(`/api/account/chat-history/${conversationId}?limit=${MAX_LIVE_MESSAGES}`)
        if (!res.ok) return
        const data = (await res.json()) as { messages?: unknown; hasMore?: unknown; eveSessionId?: unknown }
        if (getConversationId() !== conversationId || statusRef.current !== 'ready' || threadMark(messagesRef.current) !== mark) return
        // Another window replaced the conversation's eve session: this one's
        // handle is on a session the conversation no longer holds, so it goes,
        // and the next send re-attaches to the row's.
        const held = transport.eveSessionIdOf(chatSessionId)
        if (typeof data.eveSessionId === 'string' && data.eveSessionId && held && held !== data.eveSessionId) void transport.resetSession(chatSessionId)
        // A long thread answers its newest page (hasMore): the copy's older messages are no turn of its own.
        const next = caughtUpThread(messagesRef.current, data.messages, { partial: data.hasMore === true })
        if (!next) return
        setMessages(next)
      } catch {
        // Offline: what this window holds stands.
      } finally {
        inflight = false
      }
    }
    window.addEventListener('focus', resync)
    document.addEventListener('visibilitychange', resync)
    return () => {
      window.removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', resync)
    }
  }, [isHomeThread, getConversationId, setMessages, chatSessionId, transport])

  // The home thread on screen, for the presence client's seen marker
  // (docs/plans/reach-follows-you.md §2): it sends the newest message time
  // only while the person is actually looking, and the router then leaves
  // what they've read alone. Cleared when the panel leaves the home thread.
  const homeNewestAt = isHomeThread ? lastMessageTime(messages) : null
  useEffect(() => {
    if (!isHomeThread || !boundConversationId || homeNewestAt === null) return
    return reportHomeView(boundConversationId, homeNewestAt)
  }, [isHomeThread, boundConversationId, homeNewestAt])

  // Notify parent about message state changes (for floating chat expand/collapse)
  const onMessagesChangeRef = useRef(onMessagesChange)
  useEffect(() => {
    onMessagesChangeRef.current = onMessagesChange
  }, [onMessagesChange])
  useEffect(() => {
    onMessagesChangeRef.current?.(messages.length > 0)
  }, [messages.length])

  const isLoading = status === 'streaming' || status === 'submitted'

  const handleLoadConversation = useCallback(
    async (conversationId: string, opts: { ifUntouched?: boolean } = {}): Promise<LoadConversationOutcome> => {
      // Only the newest load applies: an older one landing late is dropped.
      const generation = ++loadGenerationRef.current
      const guarded = opts.ifUntouched === true
      const markBefore = threadMark(messagesRef.current)
      // Leaving the chat it showed: speech, voice mode, cards opened while a
      // turn was out, and a message waiting for the previous reply (it goes
      // back into the composer). An `ifUntouched` load leaves only once it is
      // sure to apply, so one that aborts touches nothing.
      const leaveCurrent = () => {
        stopReadAloud()
        endVoiceModeRef.current()
        if (pendingOpenedRef.current.length) {
          pendingOpenedRef.current = []
          setPendingOpened([])
        }
        returnQueuedTurnRef.current()
      }
      if (!guarded) leaveCurrent()
      try {
        // The newest rows a live thread keeps (MAX_LIVE_MESSAGES, as a restored
        // tab's catch-up reads); earlier ones page in on scroll (A3).
        const res = await fetch(`/api/account/chat-history/${conversationId}?limit=${MAX_LIVE_MESSAGES}`)
        const data = await res.json()
        if (generation !== loadGenerationRef.current) return 'aborted'
        // The chat moved on while it loaded (a send, a reply): it stays as it is.
        if (guarded && (threadMark(messagesRef.current) !== markBefore || statusRef.current !== 'ready')) return 'aborted'
        if (!res.ok || !Array.isArray(data.messages)) return res.status === 404 ? 'missing' : 'failed'
        // No row of the caller's (deleted, another workspace's): nothing to load.
        if (guarded && data.messages.length === 0 && data.agentTeammateKnown === false) return 'missing'
        // A capture's conversation is its live agent's (components/live-chat):
        // the main chat never binds it, so it never sends there.
        if (data.captureId) return 'missing'
        if (guarded) leaveCurrent()
        {
          earlierRef.current.arm(conversationId, data.hasMore === true)
          pendingFocusAfterCountRef.current = null
          setResponseRunwayActive(false)
          setMessages(data.messages)
          setConversationId(conversationId, data.messages)
          // Loading a different conversation clears the active recipe — it
          // belonged to the previous thread and must not leak into this one.
          // Without this, the loaded conversation's first turn would re-send
          // the stale skillId.
          setActiveSkill(null)

          setActiveAgent(null)
          // The prior thread's eve session must not carry over: the next turn
          // starts a fresh one, primed from the loaded transcript.
          resetChatSession()
        }
        return 'loaded'
      } catch {
        // Failed to load conversation
        return 'failed'
      }
    },
    [setMessages, setConversationId, resetChatSession, stopReadAloud],
  )

  // The newest load's number (handleLoadConversation): older ones are dropped.
  const loadGenerationRef = useRef(0)

  /**
   * Answer an ask_user clarifying prompt from the picker: the transport's
   * answerPermission answers the parked eve session (inputResponses), and eve
   * continues the turn itself. `answers` maps question text → chosen label(s);
   * a non-empty `response` (with empty answers) is the Skip / X dismissal, or,
   * with `options.typed`, words typed into the composer, which ANSWER the question.
   */
  const handleAnswerQuestion = useCallback(
    (toolCallId: string, answers: Record<string, string>, response?: string, options?: AnswerPermissionOptions) => {
      // Flip the ask_user part locally the instant the user answers /
      // dismisses. eve emits NO action.result for a natively-parked ask_user,
      // so nothing else would flip it input-available → output-available
      // client-side — the picker would keep re-opening (pendingQuestion
      // re-scans it) and a failed resume would leave it wedged. The flip makes
      // the popover dismiss immediately regardless of the transport outcome.
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant') return m
          const parts = m.parts.map((p) => {
            const isTarget = isToolUIPart(p) && p.toolCallId === toolCallId
            if (!isTarget) return p
            return {
              ...p,
              state: 'output-available',
              output: response !== undefined ? { response } : { answers },
            } as typeof p
          })
          return parts === m.parts ? m : { ...m, parts }
        }),
      )
      void transport.answerPermission(chatSessionId, toolCallId, answers, response, options)
    },
    [transport, chatSessionId, setMessages],
  )

  /**
   * Continue or Stop on eve's session-limit prompt (session-limit-card.tsx).
   * Held in this tab's turn, it is answered by option id (a Stop as the
   * dismissal), and the card flips once eve has it: false when the answer
   * didn't go, so its buttons come back. A prompt drawn from history (a
   * reload, a server-written turn) has no turn here to answer through, so the
   * choice goes as a message: eve takes a message naming an option
   * ("continue", "stop") as that option. Read through a ref, so
   * messageInteractions keeps one identity per conversation.
   */
  const answerSessionLimitRef = useRef<(toolCallId: string, choice: SessionLimitChoice) => Promise<boolean>>(async () => false)
  answerSessionLimitRef.current = async (toolCallId, choice) => {
    if (transport.hasOpenInputRequest(chatSessionId, toolCallId)) {
      await transport.answerPermission(chatSessionId, toolCallId, {}, choice === 'stop' ? 'stop' : undefined)
      return !transport.hasOpenInputRequest(chatSessionId, toolCallId)
    }
    setMessages((prev) =>
      prev.map((m) => {
        if (m.role !== 'assistant' || !m.parts.some((p) => isToolUIPart(p) && p.toolCallId === toolCallId)) return m
        const parts = m.parts.map((p) =>
          isToolUIPart(p) && p.toolCallId === toolCallId
            ? ({ ...p, state: 'output-available', output: choice === 'stop' ? { response: 'stop' } : { answers: {} } } as typeof p)
            : p,
        )
        return { ...m, parts }
      }),
    )
    whenChatFree(() => {
      prepareForResponse()
      return sendMessage(
        { text: choice },
        {
          body: {
            systemContext: turnSystemContext(),
            ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
          },
        },
      )
    })
    return true
  }
  const handleAnswerSessionLimit = useCallback(
    (toolCallId: string, choice: SessionLimitChoice) => answerSessionLimitRef.current(toolCallId, choice),
    [],
  )

  /** The composer's send. A voice-mode turn comes through here too, with
   *  `spoken` as its text (the field is empty then), so it carries exactly
   *  what a typed turn does: the context, the agent, an armed skill, and
   *  the files, notes, contacts and companies attached (the + menu and drop
   *  still work during voice mode). So does Interactive mode's spoken ask,
   *  whose `voiceAsk` rides on this turn's systemContext (`extra`). Resolves
   *  true once the turn went to the chat or waits for it (false: nothing sent).
   *
   *  While a reply is still running the turn waits above the composer and goes
   *  as the next turn once the chat is free (queued-turn.ts): never sent over
   *  the running reply. */
  /**
   * The main chat's composer sends while a card is full screen: every card in
   * front goes back (this chat's into its message, a page into its place),
   * as their Minimize or X would, so the chat shows the message and its reply.
   * The card stays the one the turn is about (putBackForSend): its note says
   * what it showed as the person sent.
   */
  function putCardsBackForSend(): void {
    if (!alwaysShowMessages) return
    if (cardStore.fullScreen()) cardStore.putBackForSend()
    closeFrontCards()
  }

  async function submitTurn(spoken: string | null, extra?: Pick<SystemContext, 'voiceAsk' | 'voiceMode'>): Promise<boolean> {
    const spokenTurn = typeof spoken === 'string'
    const readyFiles = readyChatFiles(attachedFiles)
    const typed = spokenTurn ? spoken.trim() : input.trim()
    if (!typed && readyFiles.length === 0) return false
    if (!accessToken) return false
    // Sent from the main chat's composer while a card is full screen (Liam,
    // 11-11: the composer stays on screen beside it): the card goes back in
    // the chat, so the person sees their message and the reply. Typing alone
    // changes nothing. Not another panel's composer: one inside a card would
    // put away the card it sits in.
    if (!spokenTurn) putCardsBackForSend()
    // `/compact` on its own compacts the conversation now (the side panel's
    // Compact now: lib/chat/context-client.ts), never a message to the agent.
    // An armed skill stays armed for the next message, unless it is a skill
    // whose own slug is `compact` (then `/compact` is that skill's).
    if (!spokenTurn && readyFiles.length === 0 && activeSkillRef.current?.slug.toLowerCase() !== 'compact' && isCompactCommand(typed)) {
      setInput('')
      const conversationId = boundConversationId
      if (!conversationId) {
        toast('Nothing to compact yet.')
      } else if (isLoading) {
        toast.warning('A reply is still running. Compact once it finishes.')
      } else {
        const id = toast.loading('Compacting the conversation…')
        void compactChatContext(conversationId).then((note) =>
          note.tone === 'attention' ? toast.warning(note.text, { id }) : toast.success(note.text, { id }),
        )
      }
      return true
    }
    // The agent asked a question and its reply waits on the answer: typed
    // words answer it (as the picker's own free text would), never queue
    // behind a reply that can't finish without them. `typed` keeps them an
    // answer on eve, where an unflagged response is the Skip / X dismissal.
    const openQuestion = pendingQuestionRef.current
    if (openQuestion && !spokenTurn && typed) {
      setInput('')
      handleAnswerQuestion(openQuestion.toolCallId, {}, typed, { typed: true })
      // An answer carries only its words: a card waiting as a chip stays for
      // the next message, and says so (never silently left behind).
      if (replyCardRef.current) setReplyCardHeld(true)
      return true
    }
    // Sync the system-context ref from the latest prop synchronously: the single
    // shared panel serves all tabs, so a switch-tab-then-send in the same tick
    // must carry the now-active tab's context (the effect-driven sync is async).
    // Route through withClientFlags so this path keeps isDesktopClient too.
    systemContextRef.current = withClientFlags(systemContext)
    // What the composer holds and the page it was typed on, snapshotted before
    // the composer clears: the turn sends exactly this, now or once the
    // running reply is done (by then the tab may show another page).
    const turn: QueuedTurn = {
      text: typed,
      spokenOnly: spokenTurn,
      files: readyFiles,
      notes: attachedNotes,
      contacts: attachedContacts,
      companies: attachedCompanies,
      ...(attachedRecords.length ? { records: attachedRecords } : {}),
      skill: activeSkillRef.current,
      agentId: activeAgentRef.current?.id ?? null,
      selection: editorSelectionRef?.current ?? null,
      // The card or message waiting as a chip rides typed words, never spoken ones.
      context: withReplyTo(
        !spokenTurn && replyCardRef.current ? withReplyCard(turnSystemContext(), replyCardRef.current) : turnSystemContext(),
        spokenTurn ? null : replyMessageRef.current,
      ),
      contextSwitched: false,
      ...(extra?.voiceAsk ? { voiceAsk: extra.voiceAsk } : {}),
      ...(spokenTurn && extra?.voiceMode === true ? { voiceMode: true as const } : {}),
    }

    if (!spokenTurn) setInput('')
    // The chip goes with the message it rode.
    if (!spokenTurn && replyCardRef.current) clearReplyCard()
    if (!spokenTurn && replyMessageRef.current) clearReplyMessage()
    // So do the Connect cards' outcomes (the turn's context carries them).
    if (turn.context.connectionNotes?.length) clearConnectionNotes()
    clearMentions()
    // Only the sent (ready/error) files leave the input — an upload still in
    // flight stays attached and can be sent with the next message once ready.
    clearSentFiles()
    // Release the attached skill — it's in the turn. A sticky skill (Scout)
    // stays armed for the next turn.
    releaseSkillAfterSend()

    await sendOrQueueTurn(turn)
    return true
  }

  /**
   * Words a surface hands this chat (A3, sendFromSurface): ONLY the words and
   * the cards they were about. Nothing staged in the composer rides along
   * (files, mentions, notes, an armed skill, an editor selection) and nothing
   * of it is cleared: those stay for the person's own next message, as does
   * the draft. Like typed words (not spoken ones), they answer a question the
   * agent is waiting on, show in the row above the composer while a reply
   * runs, and can steer it (canSteer).
   */
  async function submitSurfaceTurn(text: string, cardIds: readonly string[]): Promise<boolean> {
    const typed = text.trim()
    if (!typed || !accessToken) return false
    const openQuestion = pendingQuestionRef.current
    if (openQuestion) {
      // Flagged typed (#706): on eve an unflagged response is the Skip / X
      // dismissal, so surface words would cancel the question they answer.
      handleAnswerQuestion(openQuestion.toolCallId, {}, typed, { typed: true })
      return true
    }
    systemContextRef.current = withClientFlags(systemContext)
    const context = turnSystemContext()
    const turn: QueuedTurn = {
      text: typed,
      spokenOnly: false,
      surface: true,
      files: [],
      notes: [],
      contacts: [],
      companies: [],
      skill: null,
      agentId: activeAgentRef.current?.id ?? null,
      selection: null,
      context: cardIds.length ? { ...context, aboutCardIds: [...cardIds] } : context,
      contextSwitched: false,
    }
    await sendOrQueueTurn(turn)
    return true
  }

  /** A composed turn: to the chat now, or, while the chat is occupied or a
   *  turn already waits, added to the one waiting above the composer — which
   *  steers the running reply when it can (steerQueuedTurn). */
  async function sendOrQueueTurn(turn: QueuedTurn): Promise<void> {
    if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0) {
      const head = queuedTurnRef.current
      // One steer at a time: the one above is on its way to eve (it can't be
      // added to), or the flush just took it. This waits behind it.
      // A row already waits behind a steer: later words join that one, in order.
      const behind =
        !!followUpTurnRef.current ||
        (!!head?.steer &&
          (head.steer.state !== 'held' || !transport.withdrawSteer(chatSessionId, head.steer.id, 'merged')))
      if (behind) {
        setFollowUpTurn(mergeQueuedTurn(followUpTurnRef.current, turn))
        return
      }
      // A held steer was taken back above: the joined words are asked again.
      setQueuedTurn(steerQueuedTurn(mergeQueuedTurn(head ? withSteer(head, undefined) : null, turn)))
      return
    }
    await dispatchTurn(turn)
  }

  /** What a composed turn sends with (its body): the page, the
   *  mentions and files, the agent and skill. A steer's POST carries the same. */
  function turnBody(turn: QueuedTurn): Record<string, unknown> {
    const noteIds = turn.notes.map((n) => n.id)
    const contactIds = turn.contacts.map((c) => c.id)
    const companyIds = turn.companies.map((c) => c.id)
    return {
      systemContext: {
        ...turn.context,
        ...(turn.voiceAsk ? { voiceAsk: turn.voiceAsk } : {}),
        ...(turn.voiceMode ? { voiceMode: true } : {}),
        ...(noteIds.length > 0 ? { attachedNoteIds: noteIds } : {}),
        ...(contactIds.length > 0 ? { attachedContactIds: contactIds } : {}),
        ...(companyIds.length > 0 ? { attachedCompanyIds: companyIds } : {}),
        // The tasks, docs, projects, initiatives, deals, flows, files, events and Studio videos (`attachedActionIds`…).
        ...recordIdsBody(turn.records, 'context'),
        ...(turn.selection ? { editorSelection: turn.selection } : {}),
        ...(turn.contextSwitched ? { contextSwitched: true } : {}),
        // Pass file metadata so the AI knows about uploadable files
        ...(turn.files.length > 0 ? { chatFiles: chatFilesMeta(turn.files) } : {}),
      },
      ...(turn.agentId ? { agentId: turn.agentId } : {}),
      ...(turn.skill ? { skillId: turn.skill.id } : {}),
    }
  }

  /**
   * A waiting turn, steering the running reply when it may (UI-2, §2b): plain
   * words typed on the page and with the agent the reply has (canSteer), on
   * an eve turn the transport can steer (requestSteer). Otherwise it is
   * returned as it was and waits for the end.
   */
  function steerQueuedTurn(turn: QueuedTurn): QueuedTurn {
    if (turn.steer || pendingQuestionRef.current) return turn
    const key = steerContextKey(turn.context)
    if (!canSteer(turn, runningTurnKeyRef.current, key)) return turn
    const id = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const accepted = transport.requestSteer(chatSessionId, {
      id,
      text: turn.text,
      body: turnBody(turn),
      onState: (phase) => onSteerPhase(id, phase),
    })
    return accepted ? withSteer(turn, { id, state: 'held' }) : turn
  }

  /** A composed turn, to the chat now. One the transport already posted as a
   *  steer adopts that steer's reply (`body.steerId`): nothing goes twice. The
   *  plan is decided at once — the turn waits on a POST still in flight inside
   *  its own stream, where the message shows and Stop works. */
  async function dispatchTurn(turn: QueuedTurn): Promise<void> {
    const plan = turn.steer ? transport.steerFlushPlan(chatSessionId, turn.steer.id, turn.steer.state !== 'held') : 'send'
    // Sent as a steer, but its session was dropped since: eve has it; never again.
    if (plan === 'gone') return
    const adopt = plan === 'adopt' && !!turn.steer
    turnDispatchingRef.current = true
    try {
      const text = turn.text || (turn.files.length > 0 ? attachedFilesText(turn.files.length) : '')

      // Build FileUIPart[] for the AI SDK from uploaded files
      const fileParts = chatFileUIParts(turn.files)

      prepareForResponse()
      runningTurnKeyRef.current = {
        contextKey: steerContextKey(turn.context),
        agentId: turn.agentId ?? null,
      }
      // The card or message it replied to stays on the message (the thread
      // shows it above the words), and a reaction's own turn says so.
      const metadata = {
        ...(turn.context.replyCard ? cardReplyMetadata(turn.context.replyCard) : {}),
        ...(turn.context.replyTo ? messageReplyMetadata(turn.context.replyTo) : {}),
        ...(turn.reaction ?? {}),
      }
      sendMessage(
        {
          text,
          ...(fileParts.length > 0 ? { files: fileParts } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
        // How the steer landed is the transport's to say (it reads the steer's
        // own response) and rides on the persisted row.
        { body: { ...turnBody(turn), ...(adopt && turn.steer ? { steerId: turn.steer.id } : {}) } },
      )
    } finally {
      turnDispatchingRef.current = false
    }
  }

  /**
   * A reaction's own turn (handleReact, once its wait is over): sent only if
   * the reaction still stands and still answers, and only when the chat is
   * free; otherwise it rides the person's next turn like any other. Its words
   * are the reaction's line for the agent (reactionTurnText); the thread draws
   * it as "You reacted 👍 to …" (its metadata). The turn's context carries the
   * reactions since the last message, this one among them.
   */
  function sendReactionTurn(messageId: string, bubble: number): void {
    const message = messagesRef.current.find((m) => m.id === messageId)
    const reaction = message ? shownReaction(reactionsStoreRef.current, message, bubble) : null
    if (!message || !reaction || !accessTokenRef.current) return
    const words = stripSuggestionMarkers(messageBubbles(message)[bubble] ?? '')
    const asked = asksSomething(words)
    if (!reactionStartsTurn(reaction.emoji, { newest: isNewestWords(messagesRef.current, message, bubble), asked })) return
    if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0 || pendingQuestionRef.current) return
    const excerpt = messageQuoteText(words, REACTION_EXCERPT_CHARS)
    void dispatchTurn({
      text: reactionTurnText({ emoji: reaction.emoji, excerpt, asked }),
      spokenOnly: false,
      files: [],
      notes: [],
      contacts: [],
      companies: [],
      skill: null,
      agentId: activeAgentRef.current?.id ?? null,
      selection: null,
      context: turnSystemContext(),
      contextSwitched: false,
      reaction: reactionTurnMetadata(reaction.emoji, messageId, bubble, excerpt),
    })
  }
  const sendReactionTurnRef = useRef(sendReactionTurn)
  sendReactionTurnRef.current = sendReactionTurn

  const submitTurnRef = useRef(submitTurn)
  submitTurnRef.current = submitTurn
  const putCardsBackForSendRef = useRef(putCardsBackForSend)
  putCardsBackForSendRef.current = putCardsBackForSend
  const submitSurfaceTurnRef = useRef(submitSurfaceTurn)
  submitSurfaceTurnRef.current = submitSurfaceTurn
  const dispatchTurnRef = useRef(dispatchTurn)
  dispatchTurnRef.current = dispatchTurn
  const steerQueuedTurnRef = useRef(steerQueuedTurn)
  steerQueuedTurnRef.current = steerQueuedTurn
  const sendOrQueueTurnRef = useRef(sendOrQueueTurn)
  sendOrQueueTurnRef.current = sendOrQueueTurn
  // Stable (latest-ref) so the memoized ChatInput isn't re-rendered by a fresh
  // function on every streamed-token render. submitTurnRef holds THIS render's
  // submitTurn, so a send reads exactly the state the old per-render
  // `function onSubmit` closed over.
  const onSubmit = useCallback(() => {
    void submitTurnRef.current(null)
  }, [])
  // Voice mode's turns say so (systemContext.voiceMode): the agent answers to
  // be heard, short and natural, since its reply is read aloud.
  const sendSpokenTurn = useCallback(async (text: string) => {
    await submitTurnRef.current(text, { voiceMode: true })
  }, [])
  // A first-run starter, accepted with Tab from the composer's rotating
  // placeholder: sent as the person's message, carrying only the prompt. Nothing staged in the composer rides along (files, mentions,
  // an armed skill, an editor selection): they stay for the person's own next
  // message, as does the draft. The chat's agent and settings do apply.
  const sendStarter = useCallback(
    (prompt: string) => {
      if (!accessTokenRef.current) return
      // The tab's own context (what is on screen), as every turn has it; the
      // composer's staged layers are added by submitTurn alone.
      systemContextRef.current = withClientFlags(systemContext)
      prepareForResponse()
      sendMessage(
        { text: prompt },
        {
          body: {
            systemContext: turnSystemContext(),
            ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
          },
        },
      )
    },
    [systemContext, withClientFlags, prepareForResponse, sendMessage, turnSystemContext],
  )
  // The composer typed the accepted starter out: send it, and clear the box
  // as a send does. Stable (a latest-ref wrapper), so the memoized ChatInput
  // is not re-rendered. Signed out: the words stay in the box, for Enter.
  const sendStarterRef = useRef(sendStarter)
  sendStarterRef.current = sendStarter
  const acceptSuggestion = useCallback((prompt: string) => {
    if (!accessTokenRef.current) return
    setInput('')
    putCardsBackForSendRef.current()
    sendStarterRef.current(prompt)
  }, [])

  // A blank chat prewarms its eve session as its first message is typed
  // (docs/plans/chat-ttft.md, Phase 5): the mint, the session create and its
  // registration run while the user types, so Enter only sends. Asked on the
  // first keystroke of a draft (and once per chat for a restored draft); the
  // transport makes at most one per blank chat.
  // Stable, like onSubmit, so the memoized ChatInput is not re-rendered.
  const prewarmAskedForRef = useRef<string | null>(null)
  const handleInputChange = useCallback(
    (value: string) => {
      const firstKeystroke = !inputRef.current.trim() || prewarmAskedForRef.current !== chatSessionId
      setInput(value)
      // Typing in an existing conversation keeps its idle compaction away
      // (the transport pings at most once a minute per conversation).
      if (value.trim() && conversationIdRef.current && accessTokenRef.current) {
        transport.presence(conversationIdRef.current)
      }
      if (!firstKeystroke || !value.trim()) return
      // A bare `/token` is the page and skill menu, not a message yet: a page
      // picked there saves the chat itself, and a prewarm would mint a second row.
      if (/^\/\S*$/.test(value.trim())) return
      if (messagesRef.current.length > 0 || conversationIdRef.current || !accessTokenRef.current) return
      prewarmAskedForRef.current = chatSessionId
      void transport.prewarm(chatSessionId, {
        agentId: activeAgentRef.current?.id,
        skillId: activeSkillRef.current?.id,
      })
    },
    [transport, chatSessionId],
  )

  /** Immediately activate a recipe and send it as a message (the handle's
   *  triggerSkill / triggerSkillBySlug): now, or, while a reply runs, waiting
   *  above the composer like a typed one. */
  const runSkillNow = useCallback(
    async (recipe: SkillCommand) => {
      if (!accessToken) return
      setActiveSkill(recipe)
      activeSkillRef.current = recipe
      setInput('')
      const turn: QueuedTurn = {
        text: `/${recipe.slug}`,
        spokenOnly: false,
        files: [],
        notes: [],
        contacts: [],
        companies: [],
        skill: recipe,
        // A skill fires inside the active agent's tool boundary, if any.
        agentId: activeAgentRef.current?.id ?? null,
        selection: null,
        context: turnSystemContext(),
        contextSwitched: false,
      }
      // The skill is in the turn — release it so the badge doesn't linger on
      // the next turn (a sticky skill stays armed).
      releaseSkillAfterSend()
      await sendOrQueueTurnRef.current(turn)
    },
    [accessToken, releaseSkillAfterSend, turnSystemContext],
  )

  const recipeCommands = useRecipeCommands()
  const recipeCommandsRef = useRef(recipeCommands)
  useEffect(() => {
    recipeCommandsRef.current = recipeCommands
  }, [recipeCommands])

  const handleChatAboutProposal = useCallback(
    (ctx: ProposalChatContext) => {
      if (!accessToken) return
      const parts: string[] = []
      if (ctx.changeType === 'send_email') {
        // Drive the AI to actually draft the email (create_email_draft tool),
        // seeded with whatever the proposal already knows.
        const recipient = ctx.emailToName || ctx.emailToAddress
        parts.push(`Draft this email for me${recipient ? ` to ${recipient}` : ''}: "${ctx.displayText}"`)
        if (ctx.emailToAddress) parts.push(`\nRecipient address: ${ctx.emailToAddress}`)
        if (ctx.emailSubject) parts.push(`\nSuggested subject: ${ctx.emailSubject}`)
        if (ctx.emailContext) parts.push(`\nWhat the email should cover: ${ctx.emailContext}`)
        else if (ctx.description) parts.push(`\nContext: ${ctx.description}`)
        if (ctx.triggerQuote) parts.push(`\nTranscript quote: "${ctx.triggerQuote}"`)
        parts.push(`\nRead the full transcript with get_capture_content on capture ${ctx.captureId} for additional context, then use create_email_draft to write the draft. Match my voice and keep it ready to send.`)
      } else {
        // Build a contextual message that includes the proposal details
        parts.push(`Tell me more about this action item: "${ctx.displayText}"`)
        if (ctx.description) parts.push(`\nContext: ${ctx.description}`)
        if (ctx.reasoning) parts.push(`\nReasoning: ${ctx.reasoning}`)
        if (ctx.triggerQuote) parts.push(`\nTranscript quote: "${ctx.triggerQuote}"`)
        parts.push(`\nPlease use get_capture_content on capture ${ctx.captureId} to read the full transcript and give me more context about what was discussed around this item.`)
      }
      // Seeded: the proposal's words are not the person's own (src/lib/chat/seeded-send.ts).
      const text = markSeededSend(parts.join(''))
      // Never over a running reply: it waits for the chat to be free.
      whenChatFree(() => {
        setInput('')
        prepareForResponse()
        return sendMessage(
          { text },
          {
            body: {
              systemContext: {
                ...turnSystemContext(),
                attachedNoteIds: [ctx.captureId],
              },
              ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
            },
          },
        )
      })
    },
    [accessToken, sendMessage, prepareForResponse, whenChatFree, turnSystemContext],
  )

  // Anchor the question popout to the input region (floats just above it, like
  // the chat-history / capture pickers). Also how focusInput reaches the textarea.
  const inputAnchorRef = useRef<HTMLDivElement>(null)
  // The composer floats over the bottom of the chat (Liam's reference: what
  // scrolls down passes beneath it): its dock's height is --chat-bottom-inset
  // on the panel, the room the messages, the scroll button and the card stage
  // keep clear at the bottom.
  // The main chat's dock height is also the room a full-screen card leaves
  // under it, on <html> (front-card.ts COMPOSER_RESERVE_VAR; Liam, 11-11:
  // "you can still see the main chat input even when you have a panel open"):
  // the layer ends above the composer. Same observer, so it changes only when
  // the dock does.
  const composerDockRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const dock = composerDockRef.current
    const panel = dock?.parentElement
    if (!dock || !panel) return
    const measure = () => {
      const height = dock.offsetHeight
      panel.style.setProperty('--chat-bottom-inset', `${height}px`)
      if (alwaysShowMessages) setComposerReserve(height)
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(dock)
    return () => {
      observer?.disconnect()
      if (alwaysShowMessages) setComposerReserve(null)
    }
  }, [alwaysShowMessages])

  /**
   * Prospecting → Scout handoff (see ../prospecting/start-event.ts).
   *
   * Mirrors runSkillNow — select the skill, send inside its tool boundary
   * (`skillId`) — but sends the SEEDED text instead of `/build-prospect-list`, so the skill's
   * first turn already carries the domain and whether the workspace has a
   * source company. When the domain is unknown the seed says so and the skill's
   * prompt has it ask with ask_user.
   *
   * The skill list is fetched on mount (useRecipeCommands), so a click landing
   * in the first moments after a cold load can arrive before the skill is in the
   * list. Rather than silently doing nothing (what triggerSkillBySlug does — its
   * callers are menus that only render once the list is loaded), poll briefly
   * for it. If it never appears — the migration isn't applied on this
   * deployment — fall back to sending the seed WITHOUT a skill: the user still
   * gets an answer from the general assistant instead of a dead button.
   */
  const handleStartProspecting = useCallback(
    async (ctx: ProspectingStartDetail) => {
      if (!accessToken) return
      // Focus first: the send is async (skill lookup + transcript flush) and the
      // strip is always mounted beside the page, so the user should see the
      // caret land in the chat the instant they click.
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })

      const recipe = await waitForSkillBySlug(() => recipeCommandsRef.current, PROSPECT_LIST_SKILL_SLUG)
      const text = buildProspectingSeedText(ctx)
      // Never over a running reply: it waits for the chat to be free.
      whenChatFree(async () => {
        if (recipe) {
          setActiveSkill(recipe)
          activeSkillRef.current = recipe
        }
        setInput('')
        prepareForResponse()
        sendMessage(
          // Same "via <skill>" marker as the Find-email handoff. Conditional
          // because this path deliberately degrades to a plain send when the
          // skill is missing — and an unarmed turn must not claim a skill.
          { text, ...(recipe ? { metadata: seededSkillMetadata(recipe) } : {}) },
          {
            body: {
              systemContext: turnSystemContext(),
              // Like a slash-invoked skill, Scout runs inside the active agent's
              // tool boundary when one is driving the conversation.
              ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
              ...(recipe ? { skillId: recipe.id } : {}),
            },
          },
        )
        // Same release rule as every other send: Scout is sticky, so it stays
        // armed and the user's next turn goes out under the skill too.
        if (recipe) releaseSkillAfterSend()
      })
    },
    [accessToken, sendMessage, prepareForResponse, releaseSkillAfterSend, whenChatFree, turnSystemContext],
  )

  /**
   * "Ask about this list" (see ../prospecting/start-event.ts).
   *
   * The deliberate NON-send. The user has rows selected and a question we don't
   * know; guessing it would spend their money on the wrong thing. So this arms
   * the composer — Scout's skill badge on (so the turn they do write runs inside
   * its tool allowlist), caret in the input, a hint naming the selection — and
   * stops. Their next send carries `skillId` through the existing onSubmit path,
   * and the selection through systemContext.prospectingSelection.
   *
   * A deployment without the skill (migration 253 unapplied) still focuses the
   * input with the hint: they can ask the general assistant instead of clicking
   * a dead button.
   */
  const handleAskAboutList = useCallback(
    async (ctx: ProspectingAskDetail) => {
      // Focus first — the skill lookup is async and the strip is already mounted
      // beside the page, so the caret should land the instant they click.
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })
      setComposerHint(buildAskAboutListHint(ctx))
      const recipe = await waitForSkillBySlug(() => recipeCommandsRef.current, PROSPECT_LIST_SKILL_SLUG)
      if (!recipe) return
      setActiveSkill(recipe)
      activeSkillRef.current = recipe
    },
    [],
  )

  /**
   * "Find email" on the contact panel's email row (see
   * ../prospecting/start-event.ts).
   *
   * Same shape as handleStartProspecting — arm the system skill by slug, send
   * the seeded turn inside its tool boundary — with two differences:
   *
   *   • the skill is NOT sticky, so `releaseSkillAfterSend` clears it: finding
   *     one address is one turn's work, and leaving the chip armed would put
   *     the user's next unrelated question inside a two-category allowlist;
   *   • a MISSING skill (migration 263 unapplied on this deployment) toasts
   *     rather than degrading to a plain send. The seed text is written for a
   *     prompt that authorizes a CRM write off a click — handing that to the
   *     general assistant asks an unarmed model to save an address on the
   *     strength of a sentence, which is exactly the fabrication risk the
   *     skill's confidence tiers exist to prevent. Better a named failure.
   */
  const handleFindContactEmail = useCallback(
    async (ctx: FindContactEmailContext) => {
      if (!accessToken) return
      // Focus first: the send is async (skill lookup + transcript flush), so the
      // caret should land in the chat the instant they click.
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })

      const recipe = await waitForSkillBySlug(
        () => recipeCommandsRef.current,
        FIND_EMAIL_SKILL_SLUG,
      )
      if (!recipe) {
        void import('sonner').then(({ toast }) => {
          toast.error("Find email isn't available in this workspace yet.")
        })
        return
      }
      const text = buildFindEmailSeedText(ctx)
      // Never over a running reply: it waits for the chat to be free.
      whenChatFree(async () => {
        setActiveSkill(recipe)
        activeSkillRef.current = recipe
        setInput('')
        prepareForResponse()
        sendMessage(
          // `metadata` rides on the UIMessage so the transcript can mark the turn
          // "via Find email" — the chip is released a line below, and without
          // this the seeded sentence reads as something the user typed.
          { text, metadata: seededSkillMetadata(recipe) },
          {
            body: {
              systemContext: turnSystemContext(),
              // Like every skill send, it runs inside the active agent's tool
              // boundary when an agent is driving the conversation.
              ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
              skillId: recipe.id,
            },
          },
        )
        // find-email is absent from STICKY_SKILL_SLUGS, so this clears the chip.
        releaseSkillAfterSend()
      })
    },
    [accessToken, sendMessage, prepareForResponse, releaseSkillAfterSend, whenChatFree, turnSystemContext],
  )

  /**
   * Mail's Reply / Reply All → the assistant drafts the reply (see
   * src/lib/email/reply-in-chat.ts). Auto-sent, like Find email: the click
   * means one thing. No skillId: the general assistant drafts replies with its
   * email tools, which an armed skill's allowlist (Scout's, say) may not
   * reach; an active agent's tool boundary still applies, as to any turn. The
   * turn carries the request as systemContext.emailReply, which puts the
   * thread in its prompt. The composer keeps whatever the user was typing.
   *
   * useChat runs a second send alongside a streaming one, so a click while a
   * turn is in flight (or while a reply is on its way out) waits in the queue
   * and goes out as the chat settles (the effect below), one per turn. The
   * same request again within REPEAT_REPLY_MS is a double click: one reply.
   */
  const lastEmailReplyRef = useRef<{ key: string; at: number } | null>(null)
  const sendEmailReply = useCallback(
    async (request: EmailReplyRequest) => {
      emailReplySendingRef.current = true
      try {
        prepareForResponse()
        sendMessage(
          { text: buildEmailReplySeedText(request) },
          {
            body: {
              // emailReply, on this turn only, loads the thread into the prompt
              // (chat-system-prompt.ts §6b-email).
              systemContext: {
                ...turnSystemContext(),
                emailReply: request,
              },
              ...(activeAgentRef.current ? { agentId: activeAgentRef.current.id } : {}),
            },
          },
        )
      } finally {
        emailReplySendingRef.current = false
      }
    },
    [sendMessage, prepareForResponse, turnSystemContext],
  )
  const sendEmailReplyRef = useRef(sendEmailReply)
  sendEmailReplyRef.current = sendEmailReply
  const handleReplyToEmail = useCallback(
    (request: EmailReplyRequest) => {
      if (!accessToken) return
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })
      const key = `${request.threadId}:${request.message?.id ?? ''}`
      const last = lastEmailReplyRef.current
      if (last && last.key === key && Date.now() - last.at < REPEAT_REPLY_MS) return
      lastEmailReplyRef.current = { key, at: Date.now() }
      if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0) {
        emailReplyQueueRef.current.push(request)
        return
      }
      void sendEmailReply(request)
    },
    [accessToken, sendEmailReply, chatOccupied, hasWaitingTurn],
  )
  /**
   * Reply on a For you card (src/lib/chat/card-reply.ts): the card waits as a
   * chip above the composer until the person's next typed message, which it
   * rides (submitTurn, withReplyCard); × takes it off. One card at a time: a
   * new Reply replaces it. Sends nothing, so a reply still running needn't be
   * waited for here: the message waits above the composer as any typed one
   * does, the card in its context.
   */
  const handleReplyToCard = useCallback(
    (ref: CardReplyRef) => {
      const checked = parseCardReplyRef(ref)
      if (!checked) return
      attachReplyCard(checked)
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })
    },
    [attachReplyCard],
  )
  /**
   * Reply to a message (message-reply.ts): its Reply, a swipe, or the Reply
   * over words selected in it. What was pressed (`source`: the bubble, at
   * most the chip's height of it, or the Reply pill) lifts off and flies down
   * into the chip, which shows the bubble or the whole message as written
   * (`body`, else read off the thread) or the words picked out, and waits
   * above the composer for the person's next typed message, as a card's does
   * (handleReplyToCard). Sends nothing.
   */
  const handleReplyToMessage = useCallback(
    (ref: MessageReplyRef, source: HTMLElement | null, given?: string | null) => {
      const checked = parseMessageReplyRef(ref)
      if (!checked) return
      const message = given || checked.part ? null : messagesRef.current.find((m) => m.id === checked.messageId)
      const body = given?.trim() || (message ? stripSuggestionMarkers(messageWords(message)).trim() || null : null)
      // Measured before it lifts off: the chip keeps the bubble's shape.
      const shape = replyBubbleShape(source, checked.role === 'user')
      launchFlight(messageReplyFlightKey(checked), source, { maxHeight: MESSAGE_REPLY_CHIP_MAX_PX })
      attachReplyMessage(checked, body, shape)
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })
    },
    [attachReplyMessage],
  )
  // A swipe let go on a bubble of an agent message (use-swipe-to-reply.ts): reply
  // to that bubble (the whole message when it is its only one).
  const handleSwipeReply = useCallback(
    (row: HTMLElement, bubbleEl: HTMLElement) => {
      const message = messagesRef.current.find((m) => m.id === row.dataset.messageRow)
      if (!message) return
      const all = [...row.querySelectorAll<HTMLElement>('.chat-message-bubble')]
      const bubble = Math.max(0, all.indexOf(bubbleEl))
      const bubbles = messageBubbles(message)
      const words = stripSuggestionMarkers(bubbles[bubble] ?? '')
      const quote = messageQuoteText(words)
      if (!quote) return
      handleReplyToMessage({ messageId: message.id, role: 'assistant', quote, part: bubbles.length > 1 }, all[bubble] ?? null, words)
    },
    [handleReplyToMessage],
  )

  /**
   * A reaction on one bubble of an agent message (message-reactions.ts):
   * saved at once (the store), and carried by the person's next turn. One that
   * answers (a yes or a no on the last bubble of the agent's newest message
   * when it asked something, or a "don't follow") starts a turn of its own
   * after REACTION_TURN_DELAY_MS, in case it changes or comes off; one that
   * changes in the wait starts the wait again.
   */
  const reactionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const handleReact = useCallback((message: UIMessage, bubble: number, emoji: string | null) => {
    const store = reactionsStoreRef.current
    if (!store || message.role !== 'assistant') return
    void store.react(message.id, bubble, emoji)
    const timers = reactionTimersRef.current
    const key = `${message.id}#${bubble}`
    const waiting = timers.get(key)
    if (waiting) {
      clearTimeout(waiting)
      timers.delete(key)
    }
    if (!emoji) return
    const asked = asksSomething(stripSuggestionMarkers(messageBubbles(message)[bubble] ?? ''))
    if (!reactionStartsTurn(emoji, { newest: isNewestWords(messagesRef.current, message, bubble), asked })) return
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        sendReactionTurnRef.current(message.id, bubble)
      }, REACTION_TURN_DELAY_MS),
    )
  }, [])
  useEffect(() => {
    const timers = reactionTimersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])
  const messageInteractions = useMemo<MessageInteractions>(
    () => ({ reply: handleReplyToMessage, react: handleReact, reactions: messageReactions, answerSessionLimit: handleAnswerSessionLimit }),
    [handleReplyToMessage, handleReact, messageReactions, handleAnswerSessionLimit],
  )
  // The thread's messages, for the swipe and the selection's Reply (a `contents` box: no layout of its own).
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null)
  useSwipeToReply(threadEl, handleSwipeReply, true)

  // Keyed on status alone: each time the chat settles, the next queued reply
  // goes out, once nothing the person sent from this panel is waiting (that
  // goes first, in the effect below).
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    if (turnDispatchingRef.current || hasWaitingTurn() || deferredSendsRef.current.length > 0) return
    const next = emailReplyQueueRef.current.shift()
    if (next) void sendEmailReplyRef.current(next)
  }, [status, hasWaitingTurn])

  // No reply runs: nothing to steer (dispatchTurn names the next one's page).
  // A reply runs: the message behind a flushed steer may go once it is done.
  // Keyed on status alone, and ahead of the flush below.
  const followUpHeldRef = useRef(false)
  useEffect(() => {
    if (status !== 'streaming' && status !== 'submitted') runningTurnKeyRef.current = null
    else followUpHeldRef.current = false
  }, [status])

  // The chat is free (the reply finished, was stopped, or failed — or reached
  // the point where eve took a steer in): the message waiting above the
  // composer goes now (adopting its steer's reply when it was posted), then
  // one that waited behind a steer, then any click that waited (one per turn).
  // An email reply goes after them, as its effect above holds back.
  useEffect(() => {
    if (chatOccupied()) return
    const waiting = queuedTurnRef.current
    if (waiting) {
      setQueuedTurn(null)
      // The message behind it waits for the reply this one starts, never goes
      // in the same free moment (that would be two requests at once).
      followUpHeldRef.current = !!followUpTurnRef.current
      void dispatchTurnRef.current(waiting)
      return
    }
    const later = followUpTurnRef.current
    if (later && !followUpHeldRef.current) {
      setFollowUpTurn(null)
      void dispatchTurnRef.current(later)
      return
    }
    const next = deferredSendsRef.current.shift()
    if (next) runSend(next)
  }, [status, queuedTurn, followUpTurn, setQueuedTurn, setFollowUpTurn, chatOccupied, runSend])

  // A reply starts streaming: the message that waited behind a steer moves up
  // (the steer's reply is the running one now), and a waiting message that
  // could not steer yet (sent before the reply streamed) asks again. Keyed on
  // status alone: once per reply, never a retry loop.
  useEffect(() => {
    if (status !== 'streaming') return
    let head = queuedTurnRef.current
    if (!head && followUpTurnRef.current) {
      head = followUpTurnRef.current
      setFollowUpTurn(null)
      setQueuedTurn(head)
    }
    if (!head || head.steer) return
    const steered = steerQueuedTurnRef.current(head)
    if (steered !== head) setQueuedTurn(steered)
  }, [status, setQueuedTurn, setFollowUpTurn])

  /** "Send now": stop the reply; the message goes the moment the stop settles.
   *  A held steer is taken back first (it goes as an ordinary turn); one eve
   *  already has stays: the stop cancels only the reply, eve runs the steer
   *  next, and the flush adopts its reply (EveChatTransport, Send now). */
  const sendQueuedTurnNow = useCallback(() => {
    const head = queuedTurnRef.current
    if (head?.steer?.state === 'held' && transport.withdrawSteer(chatSessionId, head.steer.id, 'sent_now')) {
      setQueuedTurn(withoutSteer(head))
    }
    if (chatBusyRef.current) handleStop()
  }, [handleStop, transport, chatSessionId, setQueuedTurn])

  /** A waiting message's words, files, mentions, skill and replied card back
   *  into the composer, words ahead of anything typed since. */
  const restoreToComposer = useCallback(
    (waiting: QueuedTurn) => {
      // Spoken words were never the composer's (voice mode ends with the load).
      if (waiting.spokenOnly) return
      setInput((current) => composerTextWithQueued(waiting.text, current))
      if (waiting.files.length > 0) {
        setAttachedFiles((prev) => [...waiting.files.filter((f) => !prev.some((p) => p.id === f.id)), ...prev])
      }
      waiting.notes.forEach(handleAttachNote)
      waiting.contacts.forEach(handleAttachContact)
      waiting.companies.forEach(handleAttachCompany)
      waiting.records?.forEach(handleAttachRecord)
      if (waiting.skill && !activeSkillRef.current) {
        activeSkillRef.current = waiting.skill
        setActiveSkill(waiting.skill)
      }
      // The card or message it rode goes back to its chip, unless another waits there now.
      if (waiting.context.replyCard && !replyCardRef.current && !replyMessageRef.current) attachReplyCard(waiting.context.replyCard)
      else if (waiting.context.replyTo && !replyCardRef.current && !replyMessageRef.current) attachReplyMessage(waiting.context.replyTo)
    },
    [setAttachedFiles, handleAttachNote, handleAttachContact, handleAttachCompany, handleAttachRecord, attachReplyCard, attachReplyMessage],
  )

  /** "Edit": the waiting message back into the composer. Not once it is on
   *  its way to eve as a steer (eve can't take it back): the row stays and
   *  says so. */
  const returnQueuedTurn = useCallback(() => {
    const waiting = queuedTurnRef.current
    if (!waiting) return
    const steer = waiting.steer
    if (steer && (steer.state !== 'held' || !transport.withdrawSteer(chatSessionId, steer.id, 'edited'))) {
      if (!steer.onItsWay) {
        setQueuedTurn(withSteer(waiting, { ...steer, state: steer.state === 'held' ? 'posting' : steer.state, onItsWay: true }))
      }
      return
    }
    setQueuedTurn(null)
    restoreToComposer(waiting)
  }, [setQueuedTurn, restoreToComposer, transport, chatSessionId])

  /** "Edit" on the message waiting behind a steer. */
  const returnFollowUpTurn = useCallback(() => {
    const waiting = followUpTurnRef.current
    if (!waiting) return
    setFollowUpTurn(null)
    restoreToComposer(waiting)
  }, [setFollowUpTurn, restoreToComposer])

  /** Loading another conversation: what waits goes back into the composer —
   *  except a steer already on its way: eve has it, in the conversation left. */
  const releaseQueuedTurns = useCallback(() => {
    const head = queuedTurnRef.current
    if (head) {
      setQueuedTurn(null)
      const onItsWay =
        !!head.steer && (head.steer.state !== 'held' || !transport.withdrawSteer(chatSessionId, head.steer.id, 'released'))
      if (!onItsWay) restoreToComposer(head)
    }
    const later = followUpTurnRef.current
    if (later) {
      setFollowUpTurn(null)
      restoreToComposer(later)
    }
  }, [setQueuedTurn, setFollowUpTurn, restoreToComposer, transport, chatSessionId])
  returnQueuedTurnRef.current = releaseQueuedTurns

  /**
   * Interactive mode's spoken asks (askByVoice, see ChatPanelHandle). The
   * request goes out through submitTurn, like a voice-mode turn, so it keeps
   * everything a typed turn carries, plus systemContext.voiceAsk; read-aloud
   * follows its reply whatever the auto-read setting, and useVoiceAskReplies
   * reports on the delivery (speaking, then spoken / interrupted / silent /
   * failed), which is how Interactive mode knows to open its follow-up window.
   * A spoken ask's reply still generating is stopped and replaced (as voice
   * mode's turns are); any other turn in flight is waited for, the newest ask
   * only (an older one waiting is let go as `failed`).
   */
  const voiceAskReplies = useVoiceAskReplies({ messages, status, readAloud })
  const voiceAskWaitingRef = useRef<VoiceAskDelivery | null>(null)
  const followNextTurn = readAloud.followNextTurn
  const sendVoiceAsk = useCallback(
    async (delivery: VoiceAskDelivery) => {
      followNextTurn()
      voiceAskReplies.track(delivery, messagesRef.current)
      const sent = await submitTurnRef.current(delivery.text, { voiceAsk: delivery.voiceAsk })
      if (!sent) voiceAskReplies.drop(delivery, 'failed')
    },
    [followNextTurn, voiceAskReplies],
  )
  const sendVoiceAskRef = useRef(sendVoiceAsk)
  sendVoiceAskRef.current = sendVoiceAsk
  const handleAskByVoice = useCallback(
    (delivery: VoiceAskDelivery) => {
      delivery.accept()
      if (!accessTokenRef.current) {
        delivery.settle('failed')
        return
      }
      if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0) {
        if (chatBusyRef.current && voiceAskReplies.ownsBusyTurn()) {
          // A spoken ask's reply still generating: this one replaces it.
          void Promise.resolve(stop()).then(() => sendVoiceAskRef.current(delivery))
          return
        }
        voiceAskWaitingRef.current?.settle('failed')
        voiceAskWaitingRef.current = delivery
        return
      }
      void sendVoiceAsk(delivery)
    },
    [stop, sendVoiceAsk, voiceAskReplies, chatOccupied, hasWaitingTurn],
  )
  // Each time the chat settles, the ask waiting on it goes out, after anything
  // sent from this panel that waited (so read-aloud and the ask's report
  // follow the ask's own reply, not one that went ahead of it).
  useEffect(() => {
    if (chatOccupied() || hasWaitingTurn() || deferredSendsRef.current.length > 0) return
    const next = voiceAskWaitingRef.current
    if (!next) return
    voiceAskWaitingRef.current = null
    void sendVoiceAskRef.current(next)
  }, [status, chatOccupied, hasWaitingTurn])
  // Gone with the panel: nobody will send it.
  useEffect(
    () => () => {
      voiceAskWaitingRef.current?.settle('failed')
      voiceAskWaitingRef.current = null
    },
    [],
  )

  useImperativeHandle(ref, () => ({
    openCard: openCardHere,
    focusInput: () => {
      // preventScroll: the strip is a fixed column; a focus-scroll would nudge
      // the message list / page on every tab switch.
      inputAnchorRef.current?.querySelector('textarea')?.focus({ preventScroll: true })
    },
    triggerSkill: runSkillNow,
    triggerSkillBySlug: (slug: string) => {
      const recipe = recipeCommandsRef.current.find((c) => c.slug === slug)
      if (!recipe) return
      runSkillNow(recipe)
    },
    chatAboutProposal: handleChatAboutProposal,
    startProspecting: handleStartProspecting,
    askAboutList: handleAskAboutList,
    findContactEmail: handleFindContactEmail,
    replyToEmail: handleReplyToEmail,
    replyToCard: handleReplyToCard,
    askByVoice: handleAskByVoice,
    loadConversation: (conversationId: string, opts?: { ifUntouched?: boolean }) => handleLoadConversation(conversationId, opts),
    sendFromSurface: (text: string, opts?: { cardIds?: string[] }) => {
      const cardIds = (opts?.cardIds ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 64).slice(0, 20)
      return submitSurfaceTurnRef.current(text, cardIds)
    },
    whenIdle,
    startVoiceMode: () => startVoiceModeRef.current(),
    endVoiceMode: () => endVoiceModeRef.current(),
    catchUpServerTurns,
    revealMessage,
    // Read the live conversation as a slice (via refs, so it's correct even when
    // called outside React's render cycle — e.g. synchronously from the
    // workspace-switch effect before it writes the chat).
    flushSnapshot: (): ChatSlice => ({
      chatSessionId,
      chatMessages: messagesRef.current,
      chatInput: composerSnapshot(),
      conversationId: getConversationId() ?? undefined,
    }),
  }), [openCardHere, runSkillNow, handleChatAboutProposal, handleStartProspecting, handleAskAboutList, handleFindContactEmail, handleReplyToEmail, handleReplyToCard, handleAskByVoice, handleLoadConversation, chatSessionId, getConversationId, composerSnapshot, whenIdle, catchUpServerTurns, revealMessage])

  // Voice mode: a spoken conversation in this panel. Each end-of-turn goes out
  // through submitTurn (stopping a reply still generating first) and its reply
  // is read aloud through readAloud. Ends on a chat switch or a capture.
  const voiceMode = useVoiceMode({
    canStart: voiceAvailability.conversation && !voiceAvailability.blocked,
    blocked: !!voiceAvailability.blocked,
    active: true,
    chatKey: chatSessionId,
    status,
    stop,
    sendTurn: sendSpokenTurn,
    readAloud,
  })
  endVoiceModeRef.current = voiceMode.end
  startVoiceModeRef.current = voiceMode.start
  // The only ChatPanel is the main chat's: its voice mode is the voice bird's
  // (components/birds/voice-bird.ts), which leaves once it ends.
  useEffect(() => {
    reportMainVoice(voiceMode.active, voiceMode.active ? voiceMode.phase : null)
  }, [voiceMode.active, voiceMode.phase])
  useEffect(() => () => reportMainVoice(false, null), [])
  const chatInputVoice = useMemo<ChatInputVoice>(
    () => ({ availability: voiceAvailability, mode: voiceMode }),
    [voiceAvailability, voiceMode],
  )

  const hasMessages = messages.length > 0
  // Pages the person opened never draw in the column: a chat that holds only
  // those still looks empty (its rotating starters).
  // Only what draws: the chat is not blank for anything else (it has a
  // conversation).
  const hasColumnMessages = useMemo(() => messages.some((m) => !isOpenedCardMessage(m)), [messages])
  // The starters the composer rotates in its placeholder: only in the main
  // chat's empty conversation, never a bot's or a live meeting's (nor while a
  // bot's page covers the composer). Teammate and run chats pass none.
  const composerSuggestions = useMemo(
    () =>
      alwaysShowMessages && !hasColumnMessages && !botPageUp && starterPrompts.length > 0
        ? isHomeThread === false
          ? null
          : starterPrompts
        : null,
    [alwaysShowMessages, hasColumnMessages, botPageUp, starterPrompts, isHomeThread],
  )
  const isExpanded = useFloatingChatExpanded()
  const collapse = useFloatingChatCollapse()
  const forceExpanded = useFloatingChatForceExpanded()
  const showMessages = alwaysShowMessages ? hasColumnMessages : (hasMessages && isExpanded)


  let latestUserMessageId: string | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user' && !isOpenedCardMessage(messages[index])) {
      latestUserMessageId = messages[index].id
      break
    }
  }

  // The reply streaming in right now: its markdown shows no section play
  // buttons (read-aloud) until the turn settles, stopped mid-stream included.
  const newestMessage = messages[messages.length - 1]
  const streamingMessageId =
    (status === 'submitted' || status === 'streaming') && newestMessage?.role === 'assistant'
      ? newestMessage.id
      : null

  // The latest UNANSWERED clarifying question (ask_user),
  // surfaced as a floating popout over the chat rather than inline. A question
  // is "unanswered" while its tool part is still input-available (no result yet);
  // once answered the part flips to output-available and drops out of this scan,
  // which auto-dismisses the popover. The user dismissed it with X → we record
  // the id so it doesn't immediately re-open for the same still-pending tool call.
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(new Set())
  const pendingQuestion = useMemo<{ toolCallId: string; questions: AgentQuestion[] } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      for (const part of m.parts) {
        if (!isToolUIPart(part)) continue
        const name = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
        if (name !== 'ask_user') continue
        // Only while still awaiting an answer.
        if (part.state === 'output-available' || part.state === 'output-error') continue
        if (dismissedQuestionIds.has(part.toolCallId)) continue
        const input = part.input as { questions?: AgentQuestion[] } | undefined
        const questions = input?.questions
        if (Array.isArray(questions) && questions.length > 0) {
          return { toolCallId: part.toolCallId, questions }
        }
      }
    }
    return null
  }, [messages, dismissedQuestionIds])
  pendingQuestionRef.current = pendingQuestion
  // The budget prompt still holding the session: the one card with buttons.
  const openSessionLimit = useMemo(() => openSessionLimitOf(messages), [messages])
  const openSessionLimitId = openSessionLimit?.toolCallId ?? null
  // eve's lifetime input budget, which the main chat no longer has: Continue
  // on the person's behalf, once per prompt, but only one this tab's turn
  // holds (continuesOnItsOwn says why not one from history). While it goes the
  // card shows "Continuing…"; one that didn't go gets its buttons back.
  const [autoContinuing, setAutoContinuing] = useState<string | null>(null)
  const autoContinuedRef = useRef(new Set<string>())
  const autoContinueOpenLimit =
    openSessionLimitId && continuesOnItsOwn(openSessionLimit?.limit ?? null) && transport.hasOpenInputRequest(chatSessionId, openSessionLimitId)
      ? openSessionLimitId
      : null
  useEffect(() => {
    if (!autoContinueOpenLimit || autoContinuedRef.current.has(autoContinueOpenLimit)) return
    autoContinuedRef.current.add(autoContinueOpenLimit)
    setAutoContinuing(autoContinueOpenLimit)
    void handleAnswerSessionLimit(autoContinueOpenLimit, 'continue').then(
      () => setAutoContinuing((id) => (id === autoContinueOpenLimit ? null : id)),
      () => setAutoContinuing((id) => (id === autoContinueOpenLimit ? null : id)),
    )
  }, [autoContinueOpenLimit, handleAnswerSessionLimit])
  const openSessionLimitValue = useMemo(
    () => (openSessionLimitId ? { toolCallId: openSessionLimitId, continuing: autoContinuing === openSessionLimitId } : null),
    [openSessionLimitId, autoContinuing],
  )

  // A question arriving in a live reply plays agent-alert (never one from history).
  useAskArrivalSound(messages, status)

  // ── What Scout did to a prospect list, published for the list page (C2) ─────
  // The list page sitting beside this strip has no other way to learn that a
  // tool in HERE saved fourteen rows to the CRM: the page's own fetches are
  // driven by its own buttons. So scan this conversation's completed tool calls
  // for prospecting work, fold it per list, and publish it to the store the
  // page subscribes to.
  //
  // Dedupe is not an optimisation here, it is the feature: handleLoadConversation
  // replays a resumed conversation's ENTIRE transcript through setMessages, so
  // without a seen-set every reopened tab would look like a fresh burst of saves
  // and the page would re-tell a story from last week. `version` bumps only for
  // a toolCallId this mount has not seen, which is exactly the signal the page
  // refetches on.
  const seenScoutToolCallsRef = useRef<Set<string>>(new Set())
  const scoutActivityVersionsRef = useRef<Map<string, number>>(new Map())
  // listId → when this mount first saw an event for it. Stamped once per event
  // rather than per render, so a re-render can't make a stale list look newer
  // than another panel's fresher one in the store's merge.
  const scoutActivityStampsRef = useRef<Map<string, number>>(new Map())
  const publishedScoutListsRef = useRef<Set<string>>(new Set())

  const scoutActivity = useMemo<Map<string, ScoutListActivity>>(() => {
    const seen = seenScoutToolCallsRef.current
    const versions = scoutActivityVersionsRef.current
    const stamps = scoutActivityStampsRef.current
    const out = new Map<string, ScoutListActivity>()
    // Lists this conversation has saved to since its last enroll. An enroll's
    // own output names a sequence, never a list — the contacts it enrolls are
    // the ones a preceding save promoted — so that is the correlation that lets
    // "14 enrolled in Q4 Outbound" reach the list page at all.
    let savedSinceEnroll: string[] = []

    const touch = (listId: string, isNew: boolean): ScoutListActivity => {
      let entry = out.get(listId)
      if (!entry) {
        const version = versions.get(listId) ?? 0
        entry = {
          listId,
          version,
          lastEventAt: stamps.get(listId) ?? 0,
          touched: true,
          lastSave: null,
          lastEnroll: null,
          lastDismiss: null,
        }
        out.set(listId, entry)
      }
      if (isNew) {
        entry.version = (versions.get(listId) ?? 0) + 1
        versions.set(listId, entry.version)
        const at = Date.now()
        stamps.set(listId, at)
        entry.lastEventAt = at
      }
      return entry
    }

    // FORWARD order: the last save/enroll/dismiss for a list should win, and the
    // enroll correlation depends on save-then-enroll ordering.
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      for (const part of m.parts) {
        if (!isToolUIPart(part)) continue
        const name = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
        if (!SCOUT_ACTIVITY_TOOLS.has(name)) continue
        if (part.state !== 'output-available') continue
        const output = asScoutRecord(part.output)
        if (!output) continue
        const isNew = !seen.has(part.toolCallId)
        if (isNew) seen.add(part.toolCallId)

        if (name === 'enroll_contacts_in_sequence') {
          const targets = scoutListIds(output)
          const attachTo = targets.length > 0 ? targets : savedSinceEnroll
          const event: ScoutEnrollEvent = {
            toolCallId: part.toolCallId,
            sequence_id: scoutString(output.sequence_id) ?? '',
            sequence_name: scoutString(output.sequence_name),
            enrolled_count: scoutCount(output.enrolled_count, output.enrolled),
            skipped_count: scoutCount(output.skipped_count, output.skipped),
          }
          for (const listId of attachTo) touch(listId, isNew).lastEnroll = event
          savedSinceEnroll = []
          continue
        }

        const listIds = scoutListIds(output)
        if (listIds.length === 0) continue

        if (name === 'save_prospect_entries' || name === 'publish_prospect_list') {
          // Same roll-up, two meanings: a save keeps rows ON THE LIST, a
          // publish writes them to the CRM (migration 259). The page's banner
          // says which.
          const published = name === 'publish_prospect_list'
          const perList = scoutSaveCounts(output, listIds)
          for (const listId of listIds) {
            const counts = perList.get(listId)
            if (!counts) continue
            touch(listId, isNew).lastSave = { toolCallId: part.toolCallId, published, ...counts }
            // Either kind names the list an id-less enroll most plausibly
            // belongs to: the conversation's most recent list is the one the
            // user is working, whether it was just curated or just published.
            if (!savedSinceEnroll.includes(listId)) savedSinceEnroll.push(listId)
          }
          continue
        }

        if (name === 'dismiss_prospect_entries') {
          const updated = scoutCount(output.updated, null)
          for (const listId of listIds) {
            touch(listId, isNew).lastDismiss = { toolCallId: part.toolCallId, updated }
          }
          continue
        }

        // Every other prospecting tool: no counts to carry, but the list has
        // been touched — which is what silences the page's own gates.
        for (const listId of listIds) touch(listId, isNew)
      }
    }
    return out
    // `messages` is the only input; the refs are deliberately not dependencies —
    // they are the mount-scoped watermark this memo advances.
  }, [messages])

  useEffect(() => {
    const published = publishedScoutListsRef.current
    for (const [listId, activity] of scoutActivity) {
      published.add(listId)
      publishScoutActivity(chatSessionId, listId, activity)
    }
    // A list that fell out of the memo (the conversation was replaced) must not
    // keep this panel's stale contribution alive.
    for (const listId of [...published]) {
      if (scoutActivity.has(listId)) continue
      published.delete(listId)
      publishScoutActivity(chatSessionId, listId, null)
    }
  }, [scoutActivity, chatSessionId])

  useEffect(() => {
    const published = publishedScoutListsRef.current
    return () => {
      for (const listId of published) publishScoutActivity(chatSessionId, listId, null)
      published.clear()
    }
  }, [chatSessionId])

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {showMessages && !alwaysShowMessages && (
          /* Header bar — Collapse only, so it exists only for the floating
              panel. "Save as skill" used to live here; it's now the
              /create-skill skill (migration 225) rather than a bespoke button,
              and New chat moved to the input toolbar next to the history button
              it pairs with. Rendering the row unconditionally would leave an
              empty strip of padding in the docked layout, where there's no
              Collapse control. LEFT-aligned: the Attention deck ("Agent alerts")
              floats over the strip's top-RIGHT corner. */
            <div className="flex shrink-0 items-center gap-1 px-4 pt-3 pb-1 justify-start">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-full p-0 text-muted-foreground"
                onClick={collapse}
                disabled={forceExpanded}
                title="Collapse chat"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </div>
      )}

      {(showMessages || alwaysShowMessages) && (
          /* The stage a full-screen card draws on: over the messages, the
             composer below it untouched (pages in the chat). It stands with
             no messages too: the kept pages' host is in it, and a page
             opened in an empty chat goes full screen from there.
             `data-chat-thread-stage`: beside the rail, under a full-screen
             card, this stops painting while the composer below keeps on
             (tailwind.css; Liam, 11-11). */
          <div data-chat-thread-stage="" className="relative flex min-h-0 flex-1 flex-col">
          {/* Clear of the top bar and the composer, which float over the
              messages: a browser card's full screen fills what's between. */}
          <div
            ref={setCardStage}
            data-chat-card-stage
            className="pointer-events-none absolute inset-x-0 bottom-[var(--chat-bottom-inset,0px)] top-[var(--chat-top-inset,0px)] z-30 [&>*]:pointer-events-auto"
          />
          {showMessages ? (
          <ChatContainerRoot
            instance={stickToBottom}
            resize="smooth"
            onScroll={handleManagedChatScroll}
            className={cn(
              // Metrics (the fade-band vars) stay ALWAYS on — the response runway
              // + first-message padding inherit them. The visible mask toggles.
              // The fade metrics stay on: `.chat-response-runway` reads
              // --chat-turn-anchor from here to size a submitted turn's scroll
              // range. Only the mask + reserved band are gone.
              // `overscroll-x-none`: a sideways swipe on a message is a reply (use-swipe-to-reply.ts), never the browser's "back".
              'chat-top-fade-metrics relative flex-1 min-h-0 overflow-y-auto overscroll-y-none overscroll-x-none scrollbar-hide-deep',
              // Paint containment, so the streaming message list is a
              // self-contained paint region. Pixel-neutral: the scroller already
              // clips to its padding box and already contains its one positioned,
              // z-indexed child (the scroll button); nothing in the message list
              // is position:fixed (lightboxes and pickers portal to <body>).
              'contain-paint',
            )}
          >
            {/* In the persistent strip, anchor the conversation to the bottom so
                messages grow upward from just above the input (empty space sits
                at the top) rather than clustering at the top of a tall column.
                StickToBottom.Content fills the scroller height, so justify-end
                (not mt-auto) is what bottom-aligns the message stack. */}
            <ChatContainerContent
              // The main chat's thread: its parent is what scrolls it (side-panels/side-panel-store.ts chatScroller).
              data-main-chat-thread={alwaysShowMessages ? '' : undefined}
              className={cn(
                // Its first and last lines clear the top bar and the composer
                // floating over the scroller, once scrolled to either end.
                'chat-reading-col w-full gap-4 px-5 pb-[calc(var(--chat-bottom-inset,0px)+0.5rem)] pt-[var(--chat-top-inset,0px)]',
                // In-strip chat bottom-anchors its stack. No top band is
                // reserved — the chat uses its full height and messages pass
                // behind the HUDs.
                alwaysShowMessages ? 'min-h-full justify-end' : 'pt-2',
              )}
            >
              <ReadAloudContext.Provider value={readAloud}>
                <ChatCardHostProvider value={cardHost}>
                  <MessageFeedbackContext.Provider value={messageFeedback}>
                    {/* Reply and React on its messages (message-interactions.ts). */}
                    <MessageInteractionsContext.Provider value={messageInteractions}>
                      {/* The main chat is drawn straight on the sky: its replies' controls take the sky's ink. */}
                      <OnSkyContext.Provider value>
                        <div ref={setThreadEl} className="contents">
                          <OpenSessionLimitContext.Provider value={openSessionLimitValue}>
                          <ChatMessageList
                            messages={messages}
                            latestUserMessageId={latestUserMessageId}
                            userAvatarUrl={userAvatarUrl}
                            userInitials={userInitials}
                            streamingMessageId={streamingMessageId}
                            hideOpenedCards
                            topSlot={earlierSlot}
                            dayBefore={dayBefore}
                            messageTimes
                          />
                          </OpenSessionLimitContext.Provider>
                        </div>
                      </OnSkyContext.Provider>
                      <SelectionReply thread={threadEl} />
                    </MessageInteractionsContext.Provider>
                  </MessageFeedbackContext.Provider>
                </ChatCardHostProvider>
              </ReadAloudContext.Provider>

              {(status === 'submitted' || status === 'streaming') &&
                messages.length > 0 &&
                // Show the "thinking" orb whenever a turn is in flight (either
                // AI SDK phase — 'submitted' before the first chunk, or
                // 'streaming' for the whole rest of the turn, including the
                // gaps BETWEEN tool calls, e.g. one tool finishes and the model
                // is deciding what to do next before the following tool call or
                // text arrives) AND the LAST message's TRAILING part has no
                // active indicator of its own. Two things used to hide this:
                //
                //  1. Gating on `status === 'submitted'` only. That status is
                //     true just for the pre-first-chunk window; the SDK flips to
                //     'streaming' on the very first chunk (including a tool-call
                //     chunk) and STAYS 'streaming' for the rest of the turn — so
                //     a multi-tool-call turn went dark for every gap after the
                //     first tool, live-verified: an early "Got it — I'll wait
                //     for your pick" text part, then "Get dashboard summary"
                //     (Done) → "Search workspace" (Done) → nothing on screen at
                //     all while the model decided its next step, for several
                //     seconds, with the network stream still genuinely open.
                //  2. Gating on `role === 'user'` for the last message.
                //     Answering a clarifying question (QuestionPopover →
                //     handleAnswerQuestion) does NOT append a new user message:
                //     it flips the existing ask_user tool part's state to
                //     `output-available` IN PLACE on the last ASSISTANT
                //     message, then resumes the same turn — so the trailing
                //     message was never 'user' for that resume either.
                //
                // What actually indicates "something is visibly happening" is
                // the message's TRAILING part specifically — an EARLIER text
                // part (like a "got it" acknowledgment before a tool call) is
                // old, static content, not evidence of current activity, so
                // checking .some() across every part was itself a bug: it kept
                // finding that stale text part and wrongly suppressing the orb
                // for the exact gap this fix targets. Only the last part
                // counts: a still-running tool part (its own ToolPart card
                // already shows that), or non-empty text that is still the
                // most recent part of an ASSISTANT message (characters visibly
                // arriving is itself motion — but a trailing USER message's
                // text is the user's own already-rendered prompt, not
                // in-progress assistant output, so it must NOT suppress the
                // orb: that was the original bug this whole block exists to
                // fix). Anything else — including a COMPLETED trailing tool
                // part — means nothing on screen currently says "working", so
                // the orb is the only signal the user gets.
                (() => {
                  const lastMessage = messages[messages.length - 1]
                  const parts = lastMessage.parts
                  const last = parts[parts.length - 1]
                  if (!last) return true
                  if (isToolUIPart(last)) {
                    return last.state !== 'input-streaming' && last.state !== 'input-available'
                  }
                  if (lastMessage.role === 'user') return true
                  // Reasoning still streaming draws its own shimmering
                  // "Thinking" line (reasoning-card.tsx), as a running tool
                  // draws its shimmering label: that is the indicator. An
                  // empty one renders nothing yet, and a closed one is static.
                  if (last.type === 'reasoning') {
                    return !(last.state === 'streaming' && last.text.trim().length > 0)
                  }
                  return !(last.type === 'text' && last.text.trim().length > 0)
                })() && (
                  <div className="flex items-center gap-3 px-1">
                    {tidying && status === 'submitted' ? (
                      <span data-chat-tidying="" className="text-sm text-muted-foreground">
                        {SESSION_TIDYING_COPY}
                      </span>
                    ) : (
                      <Loader variant="orb" orbState="working" size="lg" />
                    )}
                  </div>
                )}


              {responseRunwayActive && (
                <div
                  aria-hidden
                  data-chat-response-runway
                  className="chat-response-runway shrink-0"
                />
              )}

              <ChatContainerScrollAnchor />
            </ChatContainerContent>

            <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--chat-bottom-inset,0px)+0.5rem)] z-10 flex justify-center">
              <div className="pointer-events-auto">
                <ScrollButton />
              </div>
            </div>
          </ChatContainerRoot>
          ) : (
            /* In the persistent strip with no messages yet, this spacer pushes
               the input to the bottom of the column instead of the top. What
               Native Intelligence can do rotates in the composer's placeholder
               (composerSuggestions), not here. The main chat greets the
               person, with what it's like outside, centred above the
               composer (components/sky/conditions-line.tsx). */
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center pb-[var(--chat-bottom-inset,0px)] pt-[var(--chat-top-inset,0px)]">
              {alwaysShowMessages && !botPageUp && <ConditionsLine />}
            </div>
          )}
          {/* What the side panel reads of this chat, its plan and quick
              helpers (side-panels/chat-feed.tsx): the main chat only, not
              under a bot's page. The panel lives in the shell, so opening it
              never re-renders this chat. */}
          {alwaysShowMessages && <ChatFeedPublisher messages={messages} conversationId={boundConversationId} busy={isLoading} enabled={!botPageUp} holdScroll={stopScrollFn} />}
          {/* The pages kept mounted out of sight (kept-card-host.tsx). */}
          <ChatCardHostProvider value={cardHost}>
            <KeptCardHost store={cardStore} />
          </ChatCardHostProvider>
          </div>
      )}

      {/* The dock over the bottom of the chat: the capture panel and the
          composer, with the messages passing beneath (composerDockRef). */}
      {/* Raised over the shell's blur while a card waits as the Reply chip (CARD_REPLY_FOCUS_ATTR in lib/chat/card-reply-focus.ts). */}
      <div ref={composerDockRef} data-chat-composer-dock="" className="absolute inset-x-0 bottom-0 z-20 [html[data-card-reply-focus]_&]:z-[46]">
      {/* Behind the dock what scrolls under it goes soft, a blur that fades in
          downward over the whole dock, to full at the window's bottom (the top
          bar's, mirrored), rather than stopping at an edge: no line in the
          clouds, however tall the dock grows (Liam, 10-19). */}
      <FadingBlur direction="up" className="absolute inset-x-0 -top-6 bottom-0" />
      {/* Capture panel — live transcript during recording, saved transcript when viewing a capture */}
      <ChatCapturePanel />

      {/* Clarifying-question popout — floats above the input when the agent asks
          a question; dismissible only via its X / Skip (not by clicking the chat). */}
      <QuestionPopover
        question={pendingQuestion}
        anchorRef={inputAnchorRef}
        onAnswer={(toolCallId, answers) => handleAnswerQuestion(toolCallId, answers)}
        onSkip={(toolCallId, response) => handleAnswerQuestion(toolCallId, {}, response)}
        onClose={(toolCallId) => {
          // X must still resolve the tool call — the eve turn is PARKED waiting
          // for a response, so silently hiding would hang the agent. Treat
          // close as a dismiss/skip (sends a free-text "(dismissed)")
          // AND remember the id so it doesn't re-open before the result lands.
          handleAnswerQuestion(toolCallId, {}, '(dismissed)')
          setDismissedQuestionIds((prev) => new Set(prev).add(toolCallId))
        }}
      />

      {/* `data-chat-composer`: the bottom zone, under the card stage. Around
          the composer (its margins and its reading column's, not the
          composer itself) is the chat's backdrop too: a press there puts a
          full-screen card away, as one beside the card does. That is the
          app's one rule for empty presses now (Liam, 11-11: "anytime you
          click an empty area it does close it"; outside-card-press.ts
          isEmptyAppPress, the dock, this zone and its reading column marked
          EMPTY_PRESS_ZONE_ATTR), not a handler here. On the composer itself
          (its field, its buttons, its menus) a press never does: beside the
          rail it stays on screen under a full-screen card, the layer ending
          above it (Liam, 11-11), and a send from it puts the card back
          (submitTurn). */}
      <div
        className="shrink-0"
        data-chat-composer
        ref={inputAnchorRef}
        hidden={botPageUp}
        inert={botPageUp}
        // Esc in the field takes the Reply chip off, a card's or a message's (a menu's or a type-out's Esc is theirs).
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented || (!replyCardRef.current && !replyMessageRef.current)) return
          if (!(e.target instanceof HTMLTextAreaElement)) return
          e.preventDefault()
          clearReplyCard()
          clearReplyMessage()
        }}
      >
        <div className="chat-reading-col w-full px-2.5 py-2" {...{ [EMPTY_PRESS_ZONE_ATTR]: '' }}>
          <QueuedTurnRow turn={queuedTurn} onSendNow={sendQueuedTurnNow} onEdit={returnQueuedTurn} />
          <QueuedTurnRow turn={followUpTurn} onEdit={returnFollowUpTurn} after />
          {replyCard && <CardReplyChip card={replyCard} onRemove={clearReplyCard} note={replyCardHeld ? CARD_REPLY_HELD_NOTE : null} />}
          {replyMessage && <MessageReplyChip reply={replyMessage} body={replyMessageBody} shape={replyMessageShape} />}
          {inputControlsMounted ? (
            <ChatInput
              value={input}
              onChange={handleInputChange}
              onSubmit={onSubmit}
              onStop={handleStop}
              isLoading={isLoading}
              attachedNotes={attachedNotes}
              onAttachNote={handleAttachNote}
              onRemoveNote={handleRemoveNote}
              attachedContacts={attachedContacts}
              onAttachContact={handleAttachContact}
              onRemoveContact={handleRemoveContact}
              attachedCompanies={attachedCompanies}
              onAttachCompany={handleAttachCompany}
              onRemoveCompany={handleRemoveCompany}
              attachedRecords={attachedRecords}
              onAttachRecord={handleAttachRecord}
              onRemoveRecord={handleRemoveRecord}
              onOpenRecord={handleOpenRecord}
              attachedFiles={attachedFiles}
              onAttachFiles={handleAttachFiles}
              onRemoveFile={handleRemoveFile}
              activeSkill={activeSkill}
              onActivateSkill={setActiveSkill}
              onClearSkill={handleClearSkill}
              pages={pages}
              onOpenPage={handleOpenPage}
              placeholder={replyCard ? CARD_REPLY_PLACEHOLDER : replyMessage ? MESSAGE_REPLY_PLACEHOLDER : (composerHint ?? undefined)}
              suggestions={composerSuggestions}
              onAcceptSuggestion={acceptSuggestion}
              // Pages opened from `/` never draw in the column: a chat holding
              // only those still reads as empty (its hint, its rotating starters).
              hasMessages={hasColumnMessages}
              editorSelection={editorSelection}
              onClearEditorSelection={onClearEditorSelection}
              autoFocus={autoFocus}
              voice={chatInputVoice}
              recording={recording}
              folders={composerFolders}
              environment={composerEnvironment}
              // One row, as team chat's (Liam, 11-09: "update the main agents
              // chat box to match the teams-chat one so it's a single line").
              layout="inline"
            />
          ) : (
            // The composer's footprint until it mounts: the empty one-row pill
            // (the main chat has no row under it now the model is picked per
            // turn by the server), so nothing jumps.
            <div aria-hidden className="relative h-[56px] rounded-[28px]">
              <div className="absolute inset-0 rounded-[28px] border border-border bg-background shadow-sm" />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
})
