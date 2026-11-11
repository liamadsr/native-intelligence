'use client'

/**
 * The chat's tool cards: a tool name mapped to what it draws in a reply
 * (docs/plans/one-agent-and-chat-pages.md, "Renderer registry").
 *
 * chat-message.tsx used to hard-code each card in renderToolPart; the cards
 * moved here unchanged, one entry each. A renderer returns what to draw, null
 * to draw nothing, or undefined to fall through to the generic chip (a call
 * still in flight, an error, a result it cannot read). `wide` marks a card
 * that breaks out of the message's 80% width to the reading column.
 */
import type { ReactNode } from 'react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { Tool, type EntityLink, type ToolState } from '@/components/prompt-kit/tool'
import { EmailDraftCard, extractDraftFromToolResult } from './email-draft-card'
import { AnsweredQuestionsSummary } from './question-picker'
import { AttachmentImagePreview, type AttachmentImage } from './attachment-image-preview'
import { WebSearchCard, WEB_SEARCH_TOOL_NAME } from './web-search-card'
import { ProspectingRunCard, SCOUT_RUN_CARD_TOOLS, canRenderProspectingRunCard } from './prospecting-run-card'
import { SuggestionGroup } from '@/components/suggestions/suggestion-card'
import { markerIdsIn } from '@/components/suggestions/remark-suggestion-markers'
import { stagedSuggestionIds } from '@/components/suggestions/staged-ids'
import { ShowToolCard } from '@/components/chat-cards/show-tool-card'
import { SHOW_TOOL_NAME, cardFromShowOutput } from '@/lib/chat-cards/kinds'
import { OPENED_CARD_PART_TYPE, openedCardFromPart } from '@/lib/chat-cards/opened-card'
import { RememberedChip, rememberedFromToolOutput } from '@/components/memory/remembered-chip'
import { NowFileChip, nowFileFromToolOutput } from '@/components/memory/now-file-chip'
import { SESSION_LIMIT_TOOL_NAME, SessionLimitCard, sessionLimitChoiceOf, sessionLimitFromInput } from './session-limit-card'
import { EmailTriageChip, emailTriageFromToolOutput } from '@/components/email/email-triage-chip'
import { EmailAutoArchiveChip } from '@/components/email/email-auto-archive-chip'
import { EMAIL_AUTO_ARCHIVE_PART_TYPE, emailAutoArchivePartData } from '@/lib/email/auto-archive-part'
import { ActionDoneChip } from '@/components/email/action-done-chip'
import { ACTION_DONE_PART_TYPE, actionDonePartData } from '@/lib/email/action-done-part'
import { PlanChecklist, PlanSummaryLine } from '@/components/work/plan-checklist'
import { planProgress } from '@/lib/work/plan'
import { HelpersRow, helpersRowModel } from './helpers-row'
import { UPDATE_PLAN_TOOL_NAME, planStepsOfPart } from './chat-widgets-model'
import { MeetingGoalSetLine, meetingGoalToolResult } from './meeting-goal-composer'
import { ConnectCard } from './connect-card'
import { FindTimesCard } from './find-times-card'
import { findTimesCardOf } from '@/lib/availability/find-times-card'
import { TimeOfferCard } from './time-offer-card'
import { TIME_OFFER_CARD_TOOLS, timeOfferCardOf } from '@/lib/time-offers/offer-card'
import { connectCardFromOutput } from '@/lib/connections/connect-card'
import { ASK_CARD_PART_TYPE, ASK_CARDS_PART_TYPE, askCardPartData, askCardsPartData } from '@/lib/attention/chat-asks'
import { ChatAskCard, ChatAskCardGroup } from '@/components/attention/chat-ask-card'
import {
  GUEST_ACTIVITY_PART_TYPE,
  GUEST_MESSAGE_PART_TYPE,
  GUEST_REQUEST_PART_TYPE,
  guestActivityPartData,
  guestMessagePartData,
  guestRequestPartData,
} from '@/lib/guests/chat-parts'
import { GuestActivityChip, GuestNote, GuestRequestCard } from '@/components/guests/guest-chat-cards'
import { AGENT_LINK_ACTIVITY_PART_TYPE, agentLinkActivityPartData } from '@/lib/agent-links/chat-parts'
import { AgentLinkActivityChip } from '@/components/agent-links/agent-link-chat-cards'

// The plan's part reading lives with the chat's Plan widget (one rule for both).
export { UPDATE_PLAN_TOOL_NAME, planStepsOfPart }

/** A reply's tool part, as the AI SDK hands it over. */
export type ToolPart = ToolUIPart | DynamicToolUIPart

/** What a renderer gets: the part, and the per-message facts some cards need. */
export interface ToolRenderContext {
  part: ToolPart
  toolName: string
  toolCallId: string
  state: ToolState
  /** The reply's whole text (suggestion markers placed in it). */
  textContent: string
  /** Entity chips the generic chip would show for this result. */
  links: EntityLink[] | undefined
  /** The last completed create_email_draft in the reply (earlier ones are superseded). */
  lastEmailDraftToolCallId: string | null
  /** The last update_plan in the reply with a plan to draw (earlier ones fold to one line). */
  lastPlanToolCallId: string | null
  /** The last image get_attachment_content in the reply (the carousel draws there). */
  lastAttachmentImageToolCallId: string | null
  allAttachmentImages: AttachmentImage[]
  attachmentLinks: EntityLink[]
  onEntityClick: (link: EntityLink) => void
}

export type ToolRenderer = (ctx: ToolRenderContext) => ReactNode | null | undefined

export interface ToolRendererEntry {
  render: ToolRenderer
  /** True when this part's card breaks out of the message's 80% width to the reading column. */
  wide?: (part: ToolPart) => boolean
}

function output(part: ToolPart): unknown {
  return part.state === 'output-available' ? part.output : undefined
}

/**
 * Pull a `{ question: answer }` map out of an answered ask_user tool result,
 * for the read-only summary: `{ answers: {...} }`, or `{ response }` for a
 * typed reply or a skip. Returns null when there's nothing structured to show.
 */
export function extractQuestionAnswers(output: unknown): Record<string, string> | null {
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (o.answers && typeof o.answers === 'object') {
      return o.answers as Record<string, string>
    }
    if (typeof o.response === 'string' && o.response) {
      return { Response: o.response }
    }
  }
  return null
}

// Clarifying-question tool (`ask_user`). The interactive picker lives in a
// POPOUT over the chat (see
// QuestionPopover in chat-panel), NOT inline — so while a question is
// unanswered we render NOTHING here. Once answered, drop a compact summary
// into the transcript so the conversation records what was chosen.
const askUser: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state === 'result') {
    const answers = extractQuestionAnswers(output(part))
    if (answers) return <AnsweredQuestionsSummary key={toolCallId} answers={answers} />
  }
  // Unanswered (or an unparseable result) → nothing inline; the popout owns it.
  return null
}

// Staged suggestions (suggest_changes, docs/plans/suggestions-everywhere.md).
// The answer's text places most of them with markers, where they render
// inline; this part shows the rest, with Apply all.
const suggestChanges: ToolRenderer = ({ part, state, textContent, toolCallId }) => {
  if (state === 'result' && part.state === 'output-available') {
    const staged = stagedSuggestionIds(part.output)
    const placed = new Set(markerIdsIn(textContent))
    const unplaced = staged.filter((id) => !placed.has(id))
    return unplaced.length ? <SuggestionGroup key={toolCallId} ids={unplaced} /> : null
  }
  // Still staging (or it failed): the generic chip shows that.
  return undefined
}

// Provider-executed web search (eve's built-in, Exa-backed via the AI
// Gateway). It is NOT a workspace tool — its result is a bag of external
// URLs, which the generic Tool chip would render as collapsed JSON — so it
// gets its own "Searched the web" card with clickable sources.
//
// Reached identically from both runtimes: the classic path emits a static
// `tool-web_search` part (providerExecuted), and eve emits a dynamic part
// whose toolName is the same (eve surfaces provider-executed calls on the
// session stream as ordinary tool-call actions — see web-search-card).
const webSearch: ToolRenderer = ({ part, state, toolCallId }) => (
  <WebSearchCard
    key={toolCallId}
    running={state === 'partial-call' || state === 'call'}
    input={part.input ?? undefined}
    output={output(part)}
    errorText={part.state === 'output-error' ? part.errorText : undefined}
  />
)

// Interactive email draft card for create_email_draft.
const emailDraft: ToolRenderer = ({ part, state, toolCallId, lastEmailDraftToolCallId }) => {
  if (state !== 'result') return undefined
  const args = part.input != null ? (part.input as Record<string, unknown>) : undefined
  const draftData = extractDraftFromToolResult(args, output(part))
  if (!draftData) return undefined
  // Only the last completed draft renders; earlier ones are superseded.
  return toolCallId === lastEmailDraftToolCallId ? <EmailDraftCard key={toolCallId} draft={draftData} /> : null
}

// Image preview for get_attachment_content — non-last images render just the
// pill; the carousel of all images renders on the last image's part.
const attachmentImage: ToolRenderer = (ctx) => {
  const { part, state, toolCallId, toolName } = ctx
  if (state !== 'result' || part.state !== 'output-available') return undefined
  const result = part.output as Record<string, unknown> | undefined
  const isImage = Boolean(result?.signed_url && result?.mime_type && (result.mime_type as string).startsWith('image/'))
  if (!isImage) return undefined
  const args = part.input != null ? (part.input as Record<string, unknown>) : undefined
  if (toolCallId !== ctx.lastAttachmentImageToolCallId) {
    return (
      <Tool key={toolCallId} name={toolName} state={state} args={args} result={result} entityLinks={ctx.links} onEntityClick={ctx.onEntityClick} />
    )
  }
  return (
    <div key={toolCallId} className="flex flex-col gap-2">
      <Tool
        name={toolName}
        state={state}
        args={args}
        result={result}
        entityLinks={ctx.attachmentLinks.length > 0 ? ctx.attachmentLinks : undefined}
        onEntityClick={ctx.onEntityClick}
      />
      <AttachmentImagePreview images={ctx.allAttachmentImages} />
    </div>
  )
}

// Scout's run tools: the result is a machine still working, and the
// countable rail plus a Stop button says far more than a collapsed JSON
// blob. Only the RESULT state — a call in flight has no progress to draw,
// and an errored call has only its error text, both of which the generic
// chip already renders correctly. The card itself returns null for any
// shape it cannot read, so a payload from an older build falls through
// here rather than rendering an empty box.
const scoutRun: ToolRenderer = ({ part, state, toolCallId, onEntityClick }) => {
  if (state !== 'result' || part.state !== 'output-available' || !canRenderProspectingRunCard(part.output)) return undefined
  return <ProspectingRunCard key={toolCallId} output={part.output} onEntityClick={onEntityClick} />
}

// A page in the chat (show): the live page the agent described. While the
// call runs, or when it was refused, the generic chip says so.
const showCard: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result') return undefined
  const card = cardFromShowOutput(output(part))
  return card ? <ShowToolCard key={toolCallId} toolCallId={toolCallId} spec={card.spec} count={card.count} number={card.number} /> : undefined
}

// What the person told the agent to remember (one-agent plan Part 3,
// "Memory"): a "Remembered: …" chip with Undo. A failed save, or one still
// running, falls through to the generic chip.
const remembered: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result' || part.state !== 'output-available') return undefined
  const data = rememberedFromToolOutput(part.output)
  return data ? <RememberedChip key={toolCallId} data={data} /> : undefined
}

// The person's Now file (docs/plans/now-file.md): "Now file updated" with
// Open, which puts the note in the chat as a card. A call still running, or a
// refused one, falls through to the generic chip, which says why.
const nowFile: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result' || part.state !== 'output-available') return undefined
  const data = nowFileFromToolOutput(part.output)
  return data ? <NowFileChip key={toolCallId} data={data} /> : undefined
}

// eve's session-limit prompt: Continue / Stop while it waits, then one line
// saying which. Drawn in every state: an open prompt has no result, and the
// generic chip would sit on "Running…" with nothing to press. A turn that
// failed under it falls through to the generic chip, which says so.
const sessionLimit: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state === 'error') return undefined
  return (
    <SessionLimitCard
      key={toolCallId}
      toolCallId={toolCallId}
      limit={sessionLimitFromInput(part.input)}
      answered={part.state === 'output-available' ? sessionLimitChoiceOf(part.output) : null}
    />
  )
}

// What the agent did to the person's inbox (update_email_thread, GEN-1166):
// "Archived and marked read · 4 threads" with Undo. A result that changed
// nothing, a refusal or a call still running falls through to the generic chip.
const emailTriage: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result' || part.state !== 'output-available') return undefined
  const data = emailTriageFromToolOutput(part.output)
  return data ? <EmailTriageChip key={toolCallId} data={data} /> : undefined
}

// The agent's plan for a long job (update_plan, A4): a compact checklist under
// the reply. Only the reply's newest plan draws in full; an earlier one folds
// to "Plan · 3 of 5". A call in flight draws nothing (it returns at once); a
// refused or failed one falls through to the generic chip, which says why.
// Never animated: a stored reply would spin forever.
const planCard: ToolRenderer = ({ part, state, toolCallId, lastPlanToolCallId }) => {
  if (state === 'partial-call' || state === 'call') return null
  const steps = planStepsOfPart(part)
  if (!steps) return undefined
  if (toolCallId !== lastPlanToolCallId) return <PlanSummaryLine key={toolCallId} steps={steps} />
  const { finished, total } = planProgress(steps)
  return (
    <div key={toolCallId} data-chat-plan="" className="w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        Plan · {finished} of {total}
      </p>
      <PlanChecklist steps={steps} live={false} />
    </div>
  )
}

// Quick helpers (A4 slice 3): one row for the whole batch, "3 helpers
// working · 1/3 done", each task's label with its state, from the call's
// input, its progress snapshots (preliminary output) and then its results. A
// refusal or an error falls through to the generic chip.
const helpersRow: ToolRenderer = ({ part, toolCallId }) => {
  const model = helpersRowModel(part)
  return model ? <HelpersRow key={toolCallId} model={model} /> : undefined
}

// A meeting's goal, set from the chat (set_meeting_goal): "Goal set: …", and
// the meeting's prep card re-reads it. A failed call falls through to the
// generic chip, which says why.
const meetingGoalSet: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result') return undefined
  const result = meetingGoalToolResult(output(part))
  return result ? <MeetingGoalSetLine key={toolCallId} toolCallId={toolCallId} result={result} /> : undefined
}

// The Connect card (connect, flows-connectors F2): the Connectors panel's row
// in a small card; one tap opens the provider's own sign-in. A refusal (no
// card in the result) or a call in flight falls through to the generic chip.
const connectCard: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result') return undefined
  const card = connectCardFromOutput(output(part))
  return card ? <ConnectCard key={toolCallId} card={card} /> : undefined
}

// The times find_times found (availability): the ones to offer, and for a
// group each person with a tick or why their time is unknown. A call still
// running, or one that failed before reading anyone, falls through to the
// generic chip, which says why.
const findTimesCard: ToolRenderer = ({ part, state, toolCallId }) => {
  if (state !== 'result') return undefined
  const data = findTimesCardOf(output(part))
  return data ? <FindTimesCard key={toolCallId} data={data} /> : undefined
}

// Time offers (availability phase 3b): what offer_times held and its link
// to copy, the meeting accept_time_offer booked, list_time_offers' offers.
// A refusal, a call still running or an empty list is the generic chip.
const timeOfferCard: ToolRenderer = ({ part, state, toolName, toolCallId }) => {
  if (state !== 'result') return undefined
  const data = timeOfferCardOf(toolName, output(part))
  return data ? <TimeOfferCard key={toolCallId} data={data} /> : undefined
}

const ENTRIES: Record<string, ToolRendererEntry> = {
  connect: { render: connectCard },
  find_times: { render: findTimesCard },
  ...Object.fromEntries(TIME_OFFER_CARD_TOOLS.map((name) => [name, { render: timeOfferCard }])),
  ask_user: { render: askUser },
  suggest_changes: { render: suggestChanges },
  [WEB_SEARCH_TOOL_NAME]: { render: webSearch },
  create_email_draft: { render: emailDraft },
  get_attachment_content: { render: attachmentImage },
  ...Object.fromEntries([...SCOUT_RUN_CARD_TOOLS].map((name) => [name, { render: scoutRun }])),
  [SHOW_TOOL_NAME]: { render: showCard, wide: (part) => cardFromShowOutput(output(part)) !== null },
  remember: { render: remembered },
  update_now: { render: nowFile },
  [SESSION_LIMIT_TOOL_NAME]: { render: sessionLimit },
  update_email_thread: { render: emailTriage },
  set_meeting_goal: { render: meetingGoalSet },
  [UPDATE_PLAN_TOOL_NAME]: { render: planCard },
  helpers: { render: helpersRow },
}

/** The registry, read-only. */
export const TOOL_RENDERERS: Readonly<Record<string, ToolRendererEntry>> = ENTRIES

/** A tool's card, or undefined for the generic chip. */
export function rendererFor(toolName: string): ToolRendererEntry | undefined {
  return Object.hasOwn(ENTRIES, toolName) ? ENTRIES[toolName] : undefined
}

// ── Data parts ────────────────────────────────────────────────────────────────

/**
 * Cards a message carries as a data part rather than a tool result: a page the
 * person opened from `/` (lib/chat-cards/opened-card.ts), drawn by the same
 * card component as a `show` card; an ask the server wrote into the home
 * thread (`data-ask-card`, P13: an approval or a question, inline); a guest's
 * activity or access request (guest access); an exchange between the
 * person's agent and a linked person's agent (agent links). `wide`: the message spans the
 * reading column for it.
 */
export interface DataPartRendererEntry {
  render: (part: unknown, key: string) => ReactNode | null
  wide?: boolean
}

const DATA_PART_ENTRIES: Record<string, DataPartRendererEntry> = {
  // An ask the server wrote into the home thread (P13): the live card inline, or what became of it.
  [ASK_CARD_PART_TYPE]: {
    render: (part, key) => {
      const data = askCardPartData((part as { data?: unknown }).data)
      return data ? <ChatAskCard key={key} data={data} /> : null
    },
  },
  // A call's (or run's) suggestions, batched (P13, home-asks.ts): its cards inline.
  [ASK_CARDS_PART_TYPE]: {
    render: (part, key) => {
      const data = askCardsPartData((part as { data?: unknown }).data)
      return data ? <ChatAskCardGroup key={key} data={data} /> : null
    },
  },
  // A stretch of a guest's conversation (guest access): one card, opening it.
  [GUEST_ACTIVITY_PART_TYPE]: {
    render: (part, key) => {
      const data = guestActivityPartData((part as { data?: unknown }).data)
      return data ? <GuestActivityChip key={key} data={data} /> : null
    },
  },
  // Someone asking to reach the agent (guest access): allow with a preset, or ignore.
  [GUEST_REQUEST_PART_TYPE]: {
    render: (part, key) => {
      const data = guestRequestPartData((part as { data?: unknown }).data)
      return data ? <GuestRequestCard key={key} data={data} /> : null
    },
  },
  // A note a guest's agent passed on (guest access, message_owner): their words, under their line.
  [GUEST_MESSAGE_PART_TYPE]: {
    render: (part, key) => {
      const data = guestMessagePartData((part as { data?: unknown }).data)
      return data ? <GuestNote key={key} data={data} /> : null
    },
  },
  // One exchange between the person's agent and a linked person's agent (agent links): one card, opening it.
  [AGENT_LINK_ACTIVITY_PART_TYPE]: {
    render: (part, key) => {
      const data = agentLinkActivityPartData((part as { data?: unknown }).data)
      return data ? <AgentLinkActivityChip key={key} data={data} /> : null
    },
  },
  // The morning tidy (src/lib/email/auto-archive.ts): what it archived, with Undo.
  [EMAIL_AUTO_ARCHIVE_PART_TYPE]: {
    render: (part, key) => {
      const data = emailAutoArchivePartData((part as { data?: unknown }).data)
      return data ? <EmailAutoArchiveChip key={key} data={data} /> : null
    },
  },
  // A to-do arriving mail marked done (src/lib/email/action-done-from-mail.ts), with Undo.
  [ACTION_DONE_PART_TYPE]: {
    render: (part, key) => {
      const data = actionDonePartData((part as { data?: unknown }).data)
      return data ? <ActionDoneChip key={key} data={data} /> : null
    },
  },
  [OPENED_CARD_PART_TYPE]: {
    render: (part, key) => {
      const card = openedCardFromPart(part)
      return card ? <ShowToolCard key={key} toolCallId={card.id} spec={card.spec} count={null} number={card.number} opened /> : null
    },
    wide: true,
  },
}

/** A data part's card, or undefined when it is not one of the registry's. */
export function dataPartRendererFor(type: string): DataPartRendererEntry | undefined {
  return Object.hasOwn(DATA_PART_ENTRIES, type) ? DATA_PART_ENTRIES[type] : undefined
}
