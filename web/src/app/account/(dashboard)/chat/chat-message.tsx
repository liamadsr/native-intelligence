'use client'

import { Copy, Check } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageActions,
  MessageAction,
} from '@/components/ui/message'
import { Tool } from '@/components/prompt-kit/tool'
import type { UIMessage } from '@ai-sdk/react'
import type { ToolState, EntityLink } from '@/components/prompt-kit/tool'
import { isToolUIPart } from 'ai'
import type { AttachmentImage } from './attachment-image-preview'
import { ChatProposalsCard } from './chat-proposals-card'
import { TeammateReportChip, teammateReportPartData } from './teammate-report-chip'
import { MeetingGoalComposer } from './meeting-goal-composer'
import { TEAMMATE_REPORT_PART_TYPE } from '@/lib/chat/teammate-report'
import { ReasoningCard } from './reasoning-card'
import { ReadAloudButton } from './read-aloud-button'
import { MessageFeedbackButtons, canRateMessage } from './message-feedback-buttons'
import { UPDATE_PLAN_TOOL_NAME, dataPartRendererFor, planStepsOfPart, rendererFor } from './tool-renderers'
import { approvalIdOfToolOutput } from '@/lib/attention/chat-asks'
import { ChatApprovalCard, RunQuestionInline } from '@/components/attention/chat-ask-card'
import { NewestPlanContext } from './chat-plan-thread'
import { useChatCardHost } from '@/components/chat-cards/card-host'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { ChatFilePart, type ChatFilePartData } from './chat-file-part'
import type { SeededSkillMetadata } from './chat-panel'
import { cardReplyOfMetadata } from '@/lib/chat/card-reply'
import { messageChannel } from '@/lib/chat/channel-turn'
import { CardReplyQuote } from './card-reply-chip'
import { messageQuoteText, messageReplyOfMetadata } from '@/lib/chat/message-reply'
import { reactionTurnOfMetadata } from '@/lib/chat/message-reactions'
import { MessageReplyQuote, ReplyCapsule } from './message-reply-chip'
import { MessageInteractionsContext } from './message-interactions'
import { ReactionBadge } from './message-reaction-controls'
import { MessageToolbar, TOOLBAR_INSET_PX, TOOLBAR_RISE_PX } from './message-toolbar'
import { stripSuggestionMarkers } from '@/components/suggestions/remark-suggestion-markers'
import { messageBubbles, textPartPieces } from '@/lib/chat/message-bubbles'
import { ReplyDocument } from './reply-document'
import { useOnSkyAttr } from '@/components/sky/on-sky'
import { cn } from '@/lib/utils'

/**
 * Per-output cache so a completed tool part returns the SAME EntityLink[]
 * reference across re-renders. Tool outputs are referentially stable once a
 * part finishes (the AI SDK clones only the actively-streaming part), and
 * `Tool` is memo'd with shallow compare — a fresh array per render would defeat
 * that bail-out for every find/list chip on every streamed token.
 */
const entityLinksCache = new WeakMap<object, EntityLink[] | null>()

/**
 * The tools that change a document's text in place: when one lands, the open
 * document refetches (document-detail-panel.tsx listens for
 * dial8:content-edited) instead of waiting for the realtime echo.
 */
const DOCUMENT_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit_document_content',
  'edit_document_lines',
  'replace_section',
  'append_to_section',
  'remove_section',
  'insert_section_after',
  'restore_document_revision',
  'propose_section_edit',
  'revert_section_edit',
])

/**
 * Map of tool names to functions that extract entity links from tool output.
 * Each extractor receives the raw tool output and returns EntityLink[] or null.
 */

export function extractEntityLinks(toolName: string, output: unknown): EntityLink[] | null {
  if (!output || typeof output !== 'object') return null
  if (entityLinksCache.has(output)) return entityLinksCache.get(output)!
  const links = computeEntityLinks(toolName, output as Record<string, unknown>)
  entityLinksCache.set(output, links)
  return links
}

function computeEntityLinks(toolName: string, o: Record<string, unknown>): EntityLink[] | null {
  // The prospecting family is checked BEFORE the `success` gate: its results are
  // plain data objects (a list, a run, a page of entries) rather than the
  // `{ success: true, ... }` envelope the CRM/actions tools use, and a run that
  // ends `budget_exhausted` is a real outcome the user should still be able to
  // open the list from. An explicit `success: false` (or an `error`) is still a
  // failure — no chip.
  if (PROSPECTING_LIST_TOOLS.has(toolName)) {
    if (o.success === false || typeof o.error === 'string') return null
    const link = prospectListLink(o)
    return link ? [link] : null
  }

  if (!o.success) return null

  switch (toolName) {
    case 'create_action': {
      const action = o.action as Record<string, unknown> | undefined
      if (!action?.id) return null
      return [{
        id: action.id as string,
        label: (action.identifier as string) || (action.title as string) || 'Action',
        type: 'action',
      }]
    }
    case 'create_actions_batch': {
      const created = o.created as Array<Record<string, unknown>> | undefined
      if (!created?.length) return null
      return created.map(a => ({
        id: a.id as string,
        label: (a.identifier as string) || (a.title as string) || 'Action',
        type: 'action' as const,
      }))
    }
    case 'create_project': {
      const project = o.project as Record<string, unknown> | undefined
      if (!project?.id) return null
      return [{
        id: project.id as string,
        label: (project.name as string) || 'Project',
        type: 'project',
      }]
    }
    case 'create_contact': {
      const contact = o.contact as Record<string, unknown> | undefined
      if (!contact?.id) return null
      return [{
        id: contact.id as string,
        label: (contact.display_name as string) || 'Contact',
        type: 'contact',
      }]
    }
    case 'create_capture': {
      const capture = o.capture as Record<string, unknown> | undefined
      if (!capture?.id) return null
      return [{
        id: capture.id as string,
        label: (capture.title as string) || 'Capture',
        type: 'capture',
      }]
    }
    case 'create_document': {
      const doc = o.document as Record<string, unknown> | undefined
      if (!doc?.id) return null
      return [{
        id: doc.id as string,
        label: (doc.title as string) || 'Document',
        type: 'document',
      }]
    }
    case 'create_calendar_event': {
      const event = o.event as Record<string, unknown> | undefined
      if (!event?.id) return null
      return [{
        id: event.id as string,
        label: (event.title as string) || (event.summary as string) || 'Event',
        type: 'calendar-event',
      }]
    }
    // Search/list tools: link each result the user can open. These return
    // PLURAL arrays (unlike the singular create_* shapes above), so they map to
    // multiple chips — capped so a broad search doesn't flood the message.
    case 'find': {
      const results = o.results as Array<Record<string, unknown>> | undefined
      if (!results?.length) return null
      const links: EntityLink[] = []
      for (const r of results) {
        const type = FIND_RESULT_TYPE_MAP[r.result_type as string]
        if (!type || typeof r.result_id !== 'string') continue
        links.push({ id: r.result_id, label: (r.title as string) || type, type })
        if (links.length >= MAX_SEARCH_ENTITY_LINKS) break
      }
      return links.length ? links : null
    }
    case 'list_captures': {
      const captures = o.captures as Array<Record<string, unknown>> | undefined
      if (!captures?.length) return null
      return captures
        .filter((c): c is Record<string, unknown> & { id: string } => typeof c.id === 'string')
        .slice(0, MAX_SEARCH_ENTITY_LINKS)
        .map((c) => ({ id: c.id, label: (c.title as string) || 'Capture', type: 'capture' as const }))
    }
    case 'get_capture_content': {
      const capture = o.capture as Record<string, unknown> | undefined
      if (!capture?.id) return null
      return [{
        id: capture.id as string,
        label: (capture.title as string) || 'Capture',
        type: 'capture',
      }]
    }
    default:
      return null
  }
}

/**
 * Prospecting (Scout) tools whose result names a list. Each gets ONE "Open list"
 * chip, so the user can jump from Scout's narration straight to the board it is
 * building — not one chip per entry: entries live INSIDE the list and have no
 * detail surface of their own to open.
 */
const PROSPECTING_LIST_TOOLS = new Set([
  'create_prospect_list',
  'update_prospect_list',
  'list_prospect_entries',
  'run_prospect_discovery',
  'research_prospect_companies',
  'find_prospect_people',
  // Two runs, ONE list — the chip points at the list both legs are filling.
  'find_prospects',
  'wait_for_prospecting_run',
  'cancel_prospecting_run',
  'get_prospecting_run_candidates',
  // A publish is per-LIST — the list is the group it writes — so its result
  // carries the id and name the chip needs.
  'publish_prospect_list',
  // NOT save_prospect_entries: a save is per-ENTRY and its result carries no
  // list id — a batch may even span lists — so there is no single list a chip
  // could honestly point at. Scout narrates the save right after the run whose
  // result already carried the chip.
])

/**
 * Pull the list id (+ a display name when the payload carries one) out of a
 * prospecting tool result. The tools return different shapes — a created list
 * nests under `list`, a run nests under `run` and carries only `list_id`, an
 * entries page returns the id it was asked about — so this reads all of them
 * rather than one extractor per tool that would drift as the tools evolve.
 * Anything without a string id yields no chip.
 */
function prospectListLink(o: Record<string, unknown>): EntityLink | null {
  const list = asRecord(o.list)
  const run = asRecord(o.run)
  // `find_prospects` is two runs under one result; if its top-level list_id
  // ever goes missing the legs still carry it, and a card without a chip is a
  // dead end for the user.
  const legRun = asRecord(asRecord(o.cards)?.run) ?? asRecord(asRecord(o.people)?.run)
  const id =
    asString(list?.id) ??
    asString(o.list_id) ??
    asString(run?.list_id) ??
    asString(legRun?.list_id) ??
    asString(o.listId)
  if (!id) return null
  const name =
    asString(list?.name) ??
    asString(o.name) ??
    asString(o.list_name) ??
    asString(run?.list_name) ??
    asString(legRun?.list_name)
  return { id, label: name || 'Prospect list', type: 'prospect_list' }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** Cap on chips from plural search/list results — enough to be useful, not a wall. */
const MAX_SEARCH_ENTITY_LINKS = 5

/** `find` result_type values that have an openable detail view. claim /
 *  attachment / email results have no detail panel to navigate to — skipped. */
const FIND_RESULT_TYPE_MAP: Record<string, EntityLink['type'] | undefined> = {
  capture: 'capture',
  document: 'document',
  contact: 'contact',
}

/**
 * What a chip opens: the entity it names, as a card the person opened (every
 * way in opens a card, lib/chat-cards/open-card.ts). A record opens as its
 * record card, an event on its day, a prospect list on the Prospecting card.
 * A chip always names an entity (it has an id), so it opens that entity in
 * every edition: refusing would gate access to data that exists, which
 * editions never do (manifest invariant 2).
 */
export function chipOpenTarget(link: EntityLink): OpenTarget | null {
  if (!link.id) return null
  if (link.type === 'calendar-event') return { type: 'calendar-event', id: link.id, title: link.label }
  if (link.type === 'prospect_list') return { type: 'prospect_list', id: link.id, title: link.label || 'Prospect list' }
  return { type: link.type, id: link.id, title: link.label }
}

function ChatMessageImpl({
  message,
  userAvatarUrl,
  userInitials,
  streaming = false,
  wholeReadAloud = false,
  replyCopy = null,
}: {
  message: UIMessage
  userAvatarUrl: string | null
  userInitials: string
  /** This reply is still arriving: its turn hasn't settled. Its last text
   *  part shows no section play buttons until it has. */
  streaming?: boolean
  /** The chat shows each reply's own Read aloud button (ChatPanel), so a
   *  section that is a whole text part gets no play button of its own. */
  wholeReadAloud?: boolean
  /**
   * The copy of what the person's reply answers, for its capsule (reply-link.ts,
   * from the list): the message's (or bubble's) markdown, when it is drawn
   * there. Unset: the words selected, if that's what it answered, else the
   * reply's one-line quote.
   */
  replyCopy?: string | null
}) {
  const [copied, setCopied] = useState(false)
  // In the main chat these controls sit straight on the sky: ink by its tone.
  const onSky = useOnSkyAttr()
  const isUser = message.role === 'user'
  // A seeded turn (a "Find email" / "Learn about my company" button) auto-sends
  // a sentence the user never typed, under a skill whose chip clears at send.
  // The name rides on the message metadata so the bubble can say so.
  const skillName = isUser
    ? (message.metadata as SeededSkillMetadata | undefined)?.skillName
    : undefined
  const stopped = !isUser && (message.metadata as { stopped?: unknown } | undefined)?.stopped === true
  // The For you card the person replied to with this message (card-reply.ts), shown above their words.
  const repliedCard = isUser ? cardReplyOfMetadata(message.metadata) : null
  // The person's message from an outside channel, or the reply sent back there
  // (docs/plans/slack-connect.md, docs/plans/text-and-calling.md).
  const channel = messageChannel(message)
  // The message they replied to with it (message-reply.ts), the same way.
  const repliedMessage = isUser ? messageReplyOfMetadata(message.metadata) : null
  // The capsule stacked on the reply (message-reply-chip.tsx ReplyCapsule), which its ┐ points from: a
  // copy of what it answers, or the words the person selected.
  const capsuleRef = useRef<HTMLDivElement>(null)
  const copy = repliedMessage && !repliedMessage.selected ? replyCopy : null
  const capsule = !!repliedMessage && (!!copy || !!repliedMessage.selected)
  // A reaction that started a turn of its own (message-reactions.ts): nothing to draw.
  const reactionTurn = isUser ? reactionTurnOfMetadata(message.metadata) : null
  // Reply and React (ChatPanel's); none in a host without them.
  const interactions = useContext(MessageInteractionsContext)
  const rootRef = useRef<HTMLDivElement>(null)
  // The bubbles it draws, in order (message-bubbles.ts): what Reply, Copy and React act on, one at a time.
  const bubbles = useMemo(() => messageBubbles(message), [message])
  const handleEntityClick = useCallback((link: EntityLink) => {
    // Only on the person's click: nothing here ever runs off a tool result landing.
    const target = chipOpenTarget(link)
    if (target) openTarget(target, { from: 'chip' })
  }, [])

  // Track which tool calls we've already dispatched for
  const dispatchedEditsRef = useRef<Set<string>>(new Set())

  // Dispatch content-refresh events when edit tools complete
  useEffect(() => {
    if (isUser) return
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      if (part.state !== 'output-available') continue
      const name = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
      if (name !== 'edit_capture_content' && !DOCUMENT_EDIT_TOOLS.has(name)) continue
      if (dispatchedEditsRef.current.has(part.toolCallId)) continue

      const output = part.output as Record<string, unknown> | undefined
      if (!output?.success) continue

      dispatchedEditsRef.current.add(part.toolCallId)
      window.dispatchEvent(
        new CustomEvent('dial8:content-edited', {
          detail: {
            toolName: name,
            entityId: name === 'edit_capture_content'
              ? (part.input as Record<string, unknown>)?.capture_id
              : (part.input as Record<string, unknown>)?.document_id,
            field: (part.input as Record<string, unknown>)?.field || 'content',
          },
        }),
      )
    }
  }, [message.parts, isUser])

  // All per-message part scans, memoized on message.parts. Only the STREAMING
  // message gets a new parts reference each frame (completed messages keep theirs
  // — AI SDK replaceMessage clones only the active one), so for every historical
  // message this recomputes exactly once and then bails, instead of re-walking
  // every part on each unrelated parent re-render (a keystroke, a streamed token).
  const {
    textContent,
    fileParts,
    toolParts,
    hasReasoning,
    hasDataCard,
    lastEmailDraftToolCallId,
    lastPlanToolCallId,
    lastAttachmentImageToolCallId,
    allAttachmentImages,
    attachmentLinks,
    hasWideCard,
    hasOpenedCard,
  } = useMemo(() => {
    const textParts = message.parts.filter(
      (p): p is { type: 'text'; text: string } => p.type === 'text',
    )
    const textContent = textParts.map((p) => p.text).join('')

    // A turn that's still purely reasoning (no text/tool/file yet) must still
    // render — this is what the ReasoningCard's live "Thinking" line is FOR — so
    // hasContent below counts it. `some(t => t.trim())` (not just `.length >
    // 0`) because reasoning-start pushes an empty part before the first delta
    // lands; an empty reasoning part renders nothing (ReasoningCard's own
    // guard), so it shouldn't count as content either.
    const hasReasoning = message.parts.some(
      (p) => p.type === 'reasoning' && (p as { text?: string }).text?.trim(),
    )

    const fileParts = message.parts.filter(
      (p): p is { type: 'file'; mediaType: string; url: string; filename?: string } => p.type === 'file',
    )

    const toolParts = message.parts.filter(isToolUIPart)

    // Precompute the look-ahead state the specialized renderers need, so each part
    // can be rendered INLINE in its original order (text → tool → text → tool …)
    // instead of bucketing all tools above all text. Walking message.parts in
    // order is what makes the UI follow what the agent actually did.

    // Email drafts: only the LAST completed create_email_draft renders the full
    // interactive card; earlier ones are superseded and hidden.
    let lastEmailDraftToolCallId: string | null = null
    for (const p of toolParts) {
      const name = 'toolName' in p ? p.toolName : p.type.replace(/^tool-/, '')
      if (name === 'create_email_draft' && p.state === 'output-available') {
        lastEmailDraftToolCallId = p.toolCallId
      }
    }

    // The agent's plan (update_plan): only the LAST one with a plan draws as the
    // checklist; earlier ones fold to a one-line summary.
    let lastPlanToolCallId: string | null = null
    for (const p of toolParts) {
      const name = 'toolName' in p ? p.toolName : p.type.replace(/^tool-/, '')
      if (name === UPDATE_PLAN_TOOL_NAME && planStepsOfPart(p)) lastPlanToolCallId = p.toolCallId
    }

    // Attachment images: every get_attachment_content image collapses into a
    // single carousel rendered on the LAST image's tool part. Collect the images
    // and their source entities once, up front.
    const isAttachmentImagePart = (p: (typeof toolParts)[number]) => {
      const name = 'toolName' in p ? p.toolName : p.type.replace(/^tool-/, '')
      if (name !== 'get_attachment_content' || p.state !== 'output-available') return false
      const o = p.output as Record<string, unknown> | undefined
      return Boolean(o?.signed_url && o?.mime_type && (o.mime_type as string).startsWith('image/'))
    }

    let lastAttachmentImageToolCallId: string | null = null
    for (const p of toolParts) {
      if (isAttachmentImagePart(p)) lastAttachmentImageToolCallId = p.toolCallId
    }

    // Map attachment_id → source entity (from any deep_search / legacy search
    // results in this message) so the carousel can link back to the capture/action.
    const searchSources = new Map<string, { captureId?: string; actionId?: string }>()
    for (const tp of toolParts) {
      const tpName = 'toolName' in tp ? tp.toolName : tp.type.replace(/^tool-/, '')
      if (tpName === 'deep_search' && tp.state === 'output-available') {
        const searchOutput = tp.output as { attachments?: Array<{ attachment_id?: string; capture_id?: string; action_id?: string }> } | undefined
        for (const r of searchOutput?.attachments ?? []) {
          if (r.attachment_id) {
            searchSources.set(r.attachment_id, { captureId: r.capture_id ?? undefined, actionId: r.action_id ?? undefined })
          }
        }
      }
      if (tpName === 'semantic_search_attachments' && tp.state === 'output-available') {
        const searchOutput = tp.output as { results?: Array<{ attachment_id?: string; capture_id?: string; action_id?: string }> } | undefined
        for (const r of searchOutput?.results ?? []) {
          if (r.attachment_id) {
            searchSources.set(r.attachment_id, { captureId: r.capture_id ?? undefined, actionId: r.action_id ?? undefined })
          }
        }
      }
    }

    const allAttachmentImages: AttachmentImage[] = []
    for (const tp of toolParts) {
      if (!isAttachmentImagePart(tp)) continue
      const o = tp.output as Record<string, unknown>
      const attachmentId = (tp.input as Record<string, unknown> | undefined)?.attachment_id as string | undefined
      const source = attachmentId ? searchSources.get(attachmentId) : undefined
      allAttachmentImages.push({
        url: o.signed_url as string,
        name: (o.file_name as string) || 'Image',
        captureId: source?.captureId ?? null,
        actionId: source?.actionId ?? null,
      })
    }

    // Entity links for the carousel's tool pill, derived from the collected images.
    const attachmentLinks: EntityLink[] = []
    const seenAttachmentSourceIds = new Set<string>()
    for (const img of allAttachmentImages) {
      if (img.captureId && !seenAttachmentSourceIds.has(img.captureId)) {
        seenAttachmentSourceIds.add(img.captureId)
        attachmentLinks.push({ id: img.captureId, label: 'Source capture', type: 'capture' })
      }
      if (img.actionId && !seenAttachmentSourceIds.has(img.actionId)) {
        seenAttachmentSourceIds.add(img.actionId)
        attachmentLinks.push({ id: img.actionId, label: 'Source action', type: 'action' })
      }
    }

    return {
      textContent,
      fileParts,
      toolParts,
      hasReasoning,
      // A card the server wrote as a data part (the morning tidy, an agent
      // link's or a guest's activity): a message of nothing else still draws.
      hasDataCard: message.parts.some((p) => !!dataPartRendererFor(p.type)),
      lastEmailDraftToolCallId,
      lastPlanToolCallId,
      lastAttachmentImageToolCallId,
      allAttachmentImages,
      attachmentLinks,
      // A card that breaks out of the 80% message width (a page in the chat).
      hasWideCard: toolParts.some((p) => {
        const name = 'toolName' in p ? p.toolName : p.type.replace(/^tool-/, '')
        return rendererFor(name)?.wide?.(p) ?? false
      }),
      // A page the person opened from `/`: their message spans the column for it.
      hasOpenedCard: message.parts.some((p) => dataPartRendererFor(p.type)?.wide ?? false),
    }
  }, [message.parts])
  // A narrow host (the bot bubble, a run chat) shows cards as pills: no breakout.
  const cardHost = useChatCardHost()
  // Across the conversation only the newest plan draws in full: once a later
  // reply has one, this reply's plans fold to their one line (chat-plan-thread.ts).
  const newestPlanInThread = useContext(NewestPlanContext)
  const fullPlanToolCallId =
    newestPlanInThread === undefined || newestPlanInThread === lastPlanToolCallId ? lastPlanToolCallId : null
  const wideCards = hasWideCard && cardHost.wide
  const openedCard = hasOpenedCard && cardHost.wide

  function handleCopy() {
    copyTextToClipboard(stripSuggestionMarkers(textContent))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // The main chat's toolbar (message-toolbar.tsx) on the top-right corner of
  // the bubble the pointer is over (Liam, 10-20: each thing a turn says is its
  // own message to reply to or react to), in the column's frame (the bubbles'
  // offsetParent), its place among them in `data-bubble`. Read as the pointer
  // comes over the message (or focus comes in), so nothing is measured until
  // someone hovers. Over, not only enter: a thread that scrolls or redraws
  // under a still pointer never enters, and the bar stays unseen until it is
  // placed (data-placed). Over the tool steps between bubbles, or the bar
  // itself, it stays where it is (the first bubble's, if it was never placed).
  function placeToolbar(e: SyntheticEvent) {
    const root = rootRef.current
    const bar = root?.querySelector<HTMLElement>('[data-message-toolbar]')
    if (!root || !bar) return
    const all = [...root.querySelectorAll<HTMLElement>('.chat-message-bubble')]
    const over = e.target instanceof Element ? e.target.closest<HTMLElement>('.chat-message-bubble') : null
    const bubble = over && all.includes(over) ? over : bar.hasAttribute('data-placed') ? null : all[0]
    if (!bubble) return
    bar.style.top = `${bubble.offsetTop - TOOLBAR_RISE_PX}px`
    bar.style.left = `${bubble.offsetLeft + bubble.offsetWidth - TOOLBAR_INSET_PX}px`
    bar.style.right = 'auto'
    bar.style.transform = 'translateX(-100%)'
    bar.dataset.bubble = String(all.indexOf(bubble))
    bar.dataset.placed = ''
  }

  // Reply to one bubble (the whole message when it is its only one): its
  // words in the chip, the bubble flying down into it.
  function handleReply(bubble: number) {
    const words = stripSuggestionMarkers(bubbles[bubble] ?? '')
    const quote = messageQuoteText(words)
    if (!interactions || !quote) return
    const el = rootRef.current?.querySelectorAll<HTMLElement>('.chat-message-bubble')[bubble] ?? null
    interactions.reply({ messageId: message.id, role: isUser ? 'user' : 'assistant', quote, part: bubbles.length > 1 }, el, words)
  }

  // A reaction's own turn is the agent's to read, never drawn (the list leaves it out too).
  if (reactionTurn) return null

  const hasContent = textContent || toolParts.length > 0 || fileParts.length > 0 || hasReasoning || hasDataCard
  if (!hasContent && !isUser) return null
  // The main chat (Reply and React) draws a settled reply's actions as the corner bar.
  const toolbar = !isUser && !!textContent && !!interactions && !streaming

  // The approval cards this message's tool parts raised (P13), drawn after its last part.
  const heldApprovals: Array<{ key: string; approvalId: string }> = []

  // Render a single tool part: its registered card (tool-renderers.tsx), else
  // the generic chip. Returns the element to render inline at this part's
  // position (or null if suppressed).
  function renderToolPart(part: (typeof toolParts)[number]) {
    const toolName = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
    const toolCallId = part.toolCallId

    let state: ToolState = 'call'
    if (part.state === 'input-streaming') {
      state = 'partial-call'
    } else if (part.state === 'input-available') {
      state = 'call'
    } else if (part.state === 'output-available') {
      state = 'result'
    } else if (part.state === 'output-error') {
      state = 'error'
    }

    const links = state === 'result' && part.state === 'output-available'
      ? extractEntityLinks(toolName, part.output) ?? undefined
      : undefined

    // A held call this turn raised (P13): its approval card goes after the
    // message's last part, under the agent's words about it, whatever tool held
    // it (chat-ask-card.tsx). Nothing here.
    const approvalId = state === 'result' && part.state === 'output-available' ? approvalIdOfToolOutput(toolName, part.output) : null
    if (approvalId) {
      if (!heldApprovals.some((h) => h.approvalId === approvalId)) heldApprovals.push({ key: toolCallId, approvalId })
      return null
    }

    const entry = rendererFor(toolName)
    if (entry) {
      const drawn = entry.render({
        part,
        toolName,
        toolCallId,
        state,
        textContent,
        links,
        lastEmailDraftToolCallId,
        lastPlanToolCallId: fullPlanToolCallId,
        lastAttachmentImageToolCallId,
        allAttachmentImages,
        attachmentLinks,
        onEntityClick: handleEntityClick,
      })
      if (drawn !== undefined) return drawn
    }

    return (
      <Tool
        key={toolCallId}
        name={toolName}
        state={state}
        args={part.input != null ? (part.input as Record<string, unknown>) : undefined}
        // A failed tool carries its message in errorText (output is absent) —
        // surface it as the expandable result so the red Error chip is inspectable.
        result={
          part.state === 'output-available'
            ? part.output
            : part.state === 'output-error'
              ? part.errorText
              : undefined
        }
        entityLinks={links}
        onEntityClick={handleEntityClick}
      />
    )
  }

  // Render a single file part (image inline, others as a badge), its link
  // refreshed when the upload's has expired (ChatFilePart).
  function renderFilePart(part: ChatFilePartData, key: string) {
    return <ChatFilePart key={key} part={part} />
  }

  // Render a single text part as a message bubble: the person's black, the
  // reply's white with a hairline border, hugging its text, so a reply reads
  // as one contained thing under the cards and steps around it. A reply's markdown gets the
  // hover "play this section" buttons (read-aloud, desktop only) once the part
  // has finished streaming, and, where the reply has its own Read aloud button
  // (below), never for a section that is the whole part.
  //
  // A long reply's structured part folds into a document the person opens
  // (ReplyDocument): the talk before it stays the bubble, and a question after
  // it a bubble of its own (lib/chat/split-long-reply.ts).
  function renderTextPart(text: string, key: string, partStreaming: boolean) {
    // Whitespace alone (a model's stray newline between tool calls) draws
    // nothing: in a bubble it would be an empty pill. The pieces are the ones
    // message-bubbles.ts counts, so a bubble's place here is its place there.
    const pieces = textPartPieces(text, !isUser)
    if (pieces.length === 0) return null
    return (
      <Fragment key={key}>
        {pieces.map((piece, j) =>
          piece.kind === 'doc' ? <ReplyDocument key={`${key}-doc`} title={piece.title} body={piece.body} /> : renderBubble(piece.text, `${key}-${j}`, partStreaming),
        )}
      </Fragment>
    )
  }

  // Each bubble's place among the message's (message-bubbles.ts), as they are drawn.
  let nextBubble = 0
  function renderBubble(text: string, key: string, partStreaming: boolean) {
    const bubble = nextBubble++
    return (
      <Fragment key={key}>
        <MessageContent
          markdown={!isUser}
          readAloudSections={!partStreaming}
          readAloudSkipWhole={wholeReadAloud}
          className={cn(
            // `chat-message-bubble`: what a Reply quotes and flies from, and a selection's Reply reads (selection-reply.tsx).
            'chat-message-bubble',
            isUser
              ? // The person's own words: a 30% veil of the page colour over the backdrop, no edge or
                // shadow, in the page's own text colour (Liam's reference, 10-26).
                'chat-user-bubble self-end rounded-[22px] bg-background/30 px-4 py-2.5 text-foreground'
              : // `chat-panel-attachment`: right after an open card, it rides the card's foot (tailwind.css).
                'chat-panel-attachment w-fit max-w-full self-start rounded-[22px] border border-border/60 bg-background px-4 py-2.5 shadow-sm shadow-black/[0.03] dark:border-white/10',
          )}
        >
          {text}
        </MessageContent>
        {/* The person's reaction on this bubble (message-reactions.ts), tucked under its foot. */}
        {!isUser && <ReactionBadge message={message} bubble={bubble} />}
      </Fragment>
    )
  }

  return (
    <>
    {/* What the reply answers, stacked on it (reply-link.ts): a copy of the message, or the words selected. */}
    {capsule && repliedMessage && <ReplyCapsule reply={repliedMessage} body={copy} capsuleRef={capsuleRef} />}
    <Message ref={rootRef} className={isUser ? 'w-full flex-row-reverse' : 'w-full'} onMouseOver={toolbar ? placeToolbar : undefined} onFocusCapture={toolbar ? placeToolbar : undefined}>
      {/* A page card uses the reading column's full width, past the 80% cap:
          the column holds at 80% and the card spans 125% of it. `relative`:
          the frame the main chat's toolbar is placed in. */}
      <div className={cn('relative flex flex-col gap-2', openedCard ? 'w-full' : wideCards ? 'w-[80%]' : 'max-w-[80%]')}>
        {repliedCard && <CardReplyQuote card={repliedCard} />}
        {repliedMessage && <MessageReplyQuote reply={repliedMessage} capsuleRef={capsule ? capsuleRef : undefined} />}
        {channel && (
          <div
            data-chat-via-slack={channel === 'slack' ? '' : undefined}
            data-chat-by-text={channel === 'sms' ? '' : undefined}
            data-chat-on-call={channel === 'call' ? '' : undefined}
            className={cn('text-[11px] font-medium text-muted-foreground', isUser && 'self-end')}
          >
            {channel === 'sms' ? 'By text' : channel === 'call' ? 'On a call' : 'In Slack'}
          </div>
        )}
        {/* Walk message.parts in their original order so text, tool calls, and
            files render inline exactly as the agent produced them — text → tool
            → text → tool … instead of all tools stacked above all text. */}
        {message.parts.map((part, i) => {
          const key = `${message.id}-part-${i}`
          // Reasoning always precedes the text it leads into (see
          // eve-chat-transport.ts's closeReasoningIfOpen), so it renders here,
          // ahead of the `text` case, matching stream order.
          if (part.type === 'reasoning') {
            const reasoningPart = part as {
              type: 'reasoning'
              text: string
              state?: 'streaming' | 'done'
            }
            return (
              <ReasoningCard
                key={key}
                text={reasoningPart.text}
                // A stopped/disconnected SDK message can retain a streaming
                // part in a tab snapshot. Only the current turn's trailing
                // reasoning is live; history must not shimmer forever.
                state={streaming && i === message.parts.length - 1 && reasoningPart.state === 'streaming' ? 'streaming' : 'done'}
              />
            )
          }
          if (part.type === 'text') {
            // Still streaming: the reply's turn hasn't settled, nothing comes
            // after this part yet (as in @/lib/read-aloud/message-text, a
            // later part closes a text part) and its text hasn't ended. A
            // reply stopped mid-stream keeps `state: 'streaming'` for good, so
            // the turn settling is what counts, not the part state alone.
            const partStreaming = streaming && i === message.parts.length - 1 && part.state !== 'done'
            return renderTextPart(part.text, key, partStreaming)
          }
          if (part.type === 'file') {
            return renderFilePart(
              part as { type: 'file'; mediaType: string; url: string; filename?: string },
              key,
            )
          }
          // Live meeting agent's rolling proposals card (WS-2a): accept/dismiss
          // the meeting's staged items inline, without leaving the chat.
          if (part.type === 'data-proposals') {
            const data = (part as { data?: { capture_id?: string; proposal_ids?: string[] } }).data
            if (data?.capture_id && Array.isArray(data.proposal_ids) && data.proposal_ids.length) {
              return (
                <ChatProposalsCard
                  key={key}
                  captureId={data.capture_id}
                  proposalIds={data.proposal_ids}
                />
              )
            }
            return null
          }
          // A delegated teammate reporting back (bots v2 phase 7): the chip
          // that opens its work item. A meeting prep's report also asks for
          // the call's goal under it (MeetingGoalComposer: nothing for any
          // other report).
          if (part.type === TEAMMATE_REPORT_PART_TYPE) {
            const data = teammateReportPartData((part as { data?: unknown }).data)
            // Tied to the report's own words when they sit right above it.
            const joined = i > 0 && message.parts[i - 1]?.type === 'text'
            return data ? (
              <Fragment key={key}>
                {/* A question asks right here, its run's picker under the report (P13). */}
                {data.status === 'needs_input' ? (
                  <RunQuestionInline data={data} metadata={message.metadata} joined={joined} />
                ) : (
                  <TeammateReportChip data={data} metadata={message.metadata} joined={joined} />
                )}
                <MeetingGoalComposer metadata={message.metadata} />
              </Fragment>
            ) : null
          }
          if (isToolUIPart(part)) {
            return renderToolPart(part)
          }
          // A card carried as a data part (a page opened from `/`).
          const dataEntry = dataPartRendererFor(part.type)
          if (dataEntry) return dataEntry.render(part, key)
          return null
        })}

        {/* The calls this turn held for the person's yes (P13): their cards
            under everything the agent said, so "just below" is true. */}
        {heldApprovals.map((h) => (
          <ChatApprovalCard key={`held-${h.key}`} approvalId={h.approvalId} />
        ))}

        {/* "via Find email" — the one visible sign that a button, not the
            user, wrote this turn. Right-aligned with the user bubble. */}
        {skillName && (
          <span {...onSky} className="self-end text-[11px] text-muted-foreground/70">
            via {skillName}
          </span>
        )}

        {/* A reply Stop (or Send now) ended where it was: it says so, here
            and on reload (metadata.stopped, persisted by the transport). */}
        {stopped && (
          <span {...onSky} data-chat-reply-stopped="" className="self-start text-[11px] text-muted-foreground/70">
            Stopped
          </span>
        )}

        {/* The main chat's: the bar on the reply's top-right corner (message-toolbar.tsx), once it has settled. */}
        {toolbar && (
          <MessageToolbar message={message} bubbles={bubbles} onReply={handleReply} />
        )}

        {!isUser && textContent && (
          // Hover-revealed, except while this reply is being read aloud, or is
          // the reading paused last: its Pause / Resume must stay reachable;
          // likewise while its "What went wrong?" popover is open.
          // `data-message-actions`: a host that draws the message in a card of
          // its own (the bot bubble's TeammateChat) floats them on its edge.
          // The main chat keeps Read aloud and the thumbs here, the whole
          // reply's (Liam, 10-20: "where they used to be at the bottom left");
          // its Copy is the corner toolbar's, per bubble.
          <MessageActions {...onSky} data-message-actions="" className="opacity-0 transition-opacity group-hover/msg:opacity-100 has-[[data-read-aloud=speaking]]:opacity-100 has-[[data-read-aloud=paused]]:opacity-100 has-[[data-feedback-open]]:opacity-100">
            {!interactions && (
              <MessageAction tooltip={copied ? 'Copied!' : 'Copy'}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </MessageAction>
            )}
            <ReadAloudButton message={message} />
            {/* Thumbs (the evals flywheel): a settled reply only, and only
                where the host provides the conversation's ratings. */}
            {canRateMessage(message, streaming) && <MessageFeedbackButtons messageId={message.id} />}
          </MessageActions>
        )}
      </div>
    </Message>
    </>
  )
}

// Memoized: the parent re-renders on every keystroke and every streamed token,
// but ChatMessage's props are referentially stable per message — `message` keeps
// its reference for every completed message (AI SDK replaceMessage clones only the
// streaming one), and userAvatarUrl/userInitials are stable strings. So default
// shallow comparison bails for all historical messages; only the actively
// streaming message (new `message` ref) actually re-renders.
export const ChatMessage = memo(ChatMessageImpl)
