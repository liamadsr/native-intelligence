'use client'

/**
 * A For you column card, compact (Liam, 2026-10-16: "simplify their UI to
 * look more like Hard where you just see the action button and hide away all
 * the details"): the card's verb as a small pill (its primary action, done
 * right there), then one sentence that carries on from it, with a small
 * round icon for the bot or the kind of thing it's about. The words are
 * column-card-copy.ts's templates over what the shared source holds.
 *
 * A click anywhere else on the card (or Enter / Space on it) opens its focus
 * view (column-focus-view.tsx): the card grows in place with its details
 * under a divider, the rest of the screen blurs, and a menu card below holds
 * its other verbs: Reply (the card into the main chat's composer:
 * lib/chat/card-reply.ts), the verbs its full card offers today, and, where
 * those need the full card's controls (pickers, a target to choose), a row
 * that shows the full card (AttentionCard) in the focus view instead of the
 * details, so nothing the column could do is lost. Only delivered work is
 * here (P13): an approval or a question asks in the chat (chat-ask-card.tsx).
 *
 * Only the column wears it: a bot's bubble and page keep the full cards.
 * Every verb is the shared source's (AgentWorkProvider), with its optimistic
 * removal, so a card settled here leaves its bot too; an attention card's go
 * through useAttentionCardVerbs, the full card's own. A delivered review's
 * verb opens its OUTPUT (#722: useOpenOutput). Each card's impression goes
 * once per card per session, once in view (useCardImpression, the full
 * cards' rule and ids, so opening its full card sends nothing more).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  Copy,
  CornerUpLeft,
  Loader2,
  Mail as MailIcon,
  MessageSquare,
  Pencil,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { usePostHog } from 'posthog-js/react'
import { cn } from '@/lib/utils'
import { AGENT_ICON } from '@/components/agents/agent-icon'
import { SentenceIcon } from './sentence-icon'
import type { AgentWorkShared } from '@/components/work/agent-work-provider'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { RailAiMember, RailMember, RailProject } from '@/hooks/use-rail-picker-data'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { useOpenOutput } from '@/hooks/use-open-output'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import type { CardPickerLookup } from '@/lib/bots/card-pickers'
import type { ColumnSource } from '@/lib/bots/for-you-column'
import { openBotPage } from '@/lib/bots/bot-page'
import { requestCardReply, type CardReplyRef } from '@/lib/chat/card-reply'
import { launchCardReplyFlight } from '@/lib/chat/card-reply-flight'
import { useIsReplyingCard } from '@/lib/chat/card-reply-focus'
import { kindLabel, primaryDeliverable, relativeTime } from '@/lib/work/presentation'
import { isAttempt } from '@/lib/work/agent-work-lanes'
import { DocumentSuggestionsChip } from '@/components/suggestions/document-suggestions-chip'
import { ActionTargetPicker } from '@/components/capture/action-target-picker'
import { AttentionCard, useCardImpression } from './attention-card'
import { AttemptedChip } from './review-card'
import { FLOATING_CARD_CLASS, VERB_PILL_CLASS } from './card-skin'
import { ColumnFocusView } from './column-focus-view'
import { attentionCopy, focusMetaLine, reviewCopy, type CompactCopy } from './column-card-copy'
import { useAttentionCardVerbs } from './use-attention-card-verbs'
import type { ReviewCardItem } from './rail-cards'
import { agentDraftSentence, type AgentDraft } from '@/lib/email/agent-drafts'
import { postDraftFromPayload } from '@/lib/content/post-draft'
import { openTarget } from '@/lib/chat-cards/open-card'

/** What the column shows, one card each (for-you-column-panel.tsx). `area`: the agent's area label. */
export type ColumnShown =
  | { kind: 'card'; id: string; at: string; card: AttentionItem; source: ColumnSource; area?: string }
  | { kind: 'review'; id: string; at: string; card: ReviewCardItem; source: ColumnSource; area?: string }
  | { kind: 'draft'; id: string; at: string; draft: AgentDraft; source: ColumnSource; area?: string }

/** Stable empties for a card whose workspace hasn't loaded its picker lists. */
const NO_MEMBERS: RailMember[] = []
const NO_AI_MEMBERS: RailAiMember[] = []
const NO_PROJECTS: RailProject[] = []


/** One of the focus view's menu rows. */
interface MenuRow {
  key: string
  label: string
  icon: LucideIcon
  /** What it does; the focus view closes once it's done. */
  onSelect: () => unknown
}

/** What a kind gives the shell: its words, its verb, its other verbs and its full card. */
interface CompactModel {
  /** The impression's id (the full card's own). */
  id: string
  copy: CompactCopy
  /** The verb itself. */
  act: () => unknown
  /** One of its verbs is under way (the pill shows it). */
  busy: boolean
  rows: MenuRow[]
  /** The row that shows the full card, and the card (null: nothing it needs). */
  full: { label: string; icon: LucideIcon; card: ReactNode } | null
  /** Beside the details: what an approval runs with, an attempt's mark. */
  extra?: ReactNode
  /**
   * An update whose accept came back with no target it could resolve (409
   * UPDATE_TARGET_UNRESOLVED: useAttentionCardVerbs opens its picker): while
   * open, the focus view shows with its pill as the picker's trigger, and the
   * action chosen retries the accept with it.
   */
  targetPicker?: { open: boolean; setOpen: (open: boolean) => void; pick: (actionId: string) => unknown; workspaceId: string }
  /** The focus view's small line after the bot's name (focusMetaLine): its kind, when, seen, its area, its workspace. */
  meta: Array<string | null | undefined>
  reply: CardReplyRef
  impression: () => void
}

export function ColumnCompactCard({ entry, shared, pickerFor }: { entry: ColumnShown; shared: AgentWorkShared; pickerFor: CardPickerLookup }) {
  if (entry.kind === 'review') return <CompactReview entry={entry} shared={shared} />
  if (entry.kind === 'draft') return <CompactDraft entry={entry} />
  return <CompactAttention entry={entry} shared={shared} pickerFor={pickerFor} />
}

/** The name of the card's workspace when it isn't the one on screen (and the cache can name it). */
function useForeignName(workspaceId: string): string | null {
  const { workspaces, currentId } = useWorkspaces()
  return currentId && workspaceId !== currentId ? (workspaces.find((w) => w.id === workspaceId)?.name ?? null) : null
}

/**
 * The tag on a card (Liam, 11-09: the agent or area it came from as "a tag or
 * something on the task", not a header over it): the area the agent's card
 * came from ("Captures", "CRM"), else the bot's name ("Writer").
 */
export function columnTag(entry: ColumnShown): string {
  return entry.area ?? entry.source.name
}

/** "Open Writer": the agent's own page, its conversation with you. Not the main agent's (Reply is its chat). */
function botRow(source: ColumnSource): MenuRow[] {
  if (source.agent) return []
  return [{ key: 'bot', label: `Open ${source.name}`, icon: AGENT_ICON, onSelect: () => openBotPage(source.teammateId, { focus: 'work' }) }]
}

function CompactAttention({
  entry,
  shared,
  pickerFor,
}: {
  entry: Extract<ColumnShown, { kind: 'card' }>
  shared: AgentWorkShared
  pickerFor: CardPickerLookup
}) {
  const item = entry.card
  const p = item.payload ?? {}
  const picker = pickerFor(item.workspace_id)
  const aiMembers = picker?.aiMembers ?? NO_AI_MEMBERS
  const verbs = useAttentionCardVerbs({
    item,
    aiMembers,
    onAccept: shared.attention.accept,
    onStart: shared.attention.start,
    onDismiss: shared.attention.dismiss,
    surface: 'column',
  })
  const foreign = useForeignName(item.workspace_id)
  const agentName = p.assignee_ai_member_id ? (aiMembers.find((a) => a.id === p.assignee_ai_member_id)?.name ?? null) : null
  const copy = attentionCopy(item, { agentName })
  // The pills (project, assignee, priority, due) are the action cards'; the rest show their whole card for what it adds.
  const pills = item.kind === 'action_card'
  // A post draft (F3): Copy beside Post, so the text can go anywhere.
  // C2a's Typefully buttons live only on the opened card, where the whole post shows (P9 review B2).
  const post = item.kind === 'question' && !!postDraftFromPayload(p)
  const model: CompactModel = {
    id: item.id,
    copy,
    // No place picker on the compact card: a Dial8 run (Edit… shows the full card, which has one).
    act: item.kind === 'work_proposal' ? () => verbs.handleStart(null) : () => verbs.handleAccept(),
    busy: verbs.busy,
    rows: [
      ...(post ? [{ key: 'copy', label: 'Copy text', icon: Copy, onSelect: verbs.handleCopy }] : []),
      ...botRow(entry.source),
      { key: 'dismiss', label: 'Dismiss', icon: Trash2, onSelect: verbs.handleDismiss },
    ],
    full:
      item.kind === 'question'
        ? null
        : {
            label: pills ? 'Edit…' : 'More options',
            icon: pills ? Pencil : SlidersHorizontal,
            card: (
              <AttentionCard
                item={item}
                editable={!!picker?.loaded}
                members={picker?.members ?? NO_MEMBERS}
                aiMembers={aiMembers}
                projects={picker?.projects ?? NO_PROJECTS}
                onEdit={shared.attention.editCard}
                onAccept={shared.attention.accept}
                onStart={shared.attention.start}
                onDismiss={shared.attention.dismiss}
                surface="column"
              />
            ),
          },
    targetPicker: {
      open: verbs.targetPickerOpen,
      setOpen: verbs.setTargetPickerOpen,
      pick: (actionId) => verbs.handleAccept(actionId),
      workspaceId: item.workspace_id,
    },
    meta: [relativeTime(item.created_at), entry.area, foreign ? `In ${foreign}` : null],
    reply: { kind: 'card', id: item.id, workspaceId: item.workspace_id, verb: copy.verb, sentence: copy.sentence, subkind: item.kind, ...(copy.icon ? { icon: copy.icon } : {}) },
    impression: () => verbs.capture('attention_card_impression'),
  }
  return <CompactShell model={model} source={entry.source} tag={columnTag(entry)} />
}

function CompactReview({ entry, shared }: { entry: Extract<ColumnShown, { kind: 'review' }>; shared: AgentWorkShared }) {
  const { work } = entry.card
  const posthog = usePostHog()
  const openWorkItem = useOpenWorkItem()
  const openOutput = useOpenOutput()
  const foreign = useForeignName(work.workspace_id)
  const output = primaryDeliverable(work)
  const copy = reviewCopy(work)
  // Where any item opens: its bot's page, beside its run's chat, in its own workspace.
  const openItem = () =>
    openWorkItem(work.id, work.ai_team_member_id ? [work.ai_team_member_id] : [], {
      workspaceId: work.workspace_id,
      title: work.title,
      teammateId: work.ai_team_member_id ?? null,
    })
  const model: CompactModel = {
    id: work.id,
    copy,
    // Delivered: its output (#722), else the item.
    act: output
      ? () => openOutput({ workItemId: work.id, workspaceId: work.workspace_id, title: work.title, teammateId: work.ai_team_member_id ?? null, output })
      : openItem,
    busy: false,
    rows: [
      { key: 'reviewed', label: 'Mark reviewed', icon: Check, onSelect: () => shared.work.reviewed(work.id) },
      // The run's chat, when the verb opens the output instead.
      ...(output ? [{ key: 'chat', label: 'Open chat', icon: MessageSquare, onSelect: openItem }] : []),
      { key: 'dismiss', label: 'Dismiss', icon: Trash2, onSelect: () => shared.work.dismissReview(work.id) },
    ],
    full: null,
    extra:
      isAttempt(work) || (output?.type === 'document' && output.id) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {isAttempt(work) && <AttemptedChip />}
          {output?.type === 'document' && output.id && <DocumentSuggestionsChip documentId={output.id} />}
        </div>
      ) : undefined,
    // The kind alone: the bot's name leads the line already (kindLine would say it twice).
    meta: [kindLabel(work.kind), relativeTime(entry.card.created_at), entry.card.seen ? 'Seen' : null, entry.area, foreign ? `In ${foreign}` : null],
    reply: { kind: 'review', id: work.id, workspaceId: work.workspace_id, verb: copy.verb, sentence: copy.sentence, subkind: work.kind, ...(copy.icon ? { icon: copy.icon } : {}) },
    impression: () => posthog?.capture('attention_card_impression', { kind: 'work_review', work_kind: work.kind, surface: 'column' }),
  }
  return <CompactShell model={model} source={entry.source} tag={columnTag(entry)} />
}

/**
 * An email draft a bot wrote, still waiting in Mail (Liam, 10-18: each draft
 * its own card, src/lib/email/agent-drafts.ts): "Review the reply to …".
 * The verb opens Mail on that draft, its thread open and the draft in view
 * (the mail card's `draftId`). Reply hands it to the chat like any card; it
 * leaves once the draft is sent or dismissed (its row goes, Realtime says so).
 */
function CompactDraft({ entry }: { entry: Extract<ColumnShown, { kind: 'draft' }> }) {
  const { draft, source } = entry
  const posthog = usePostHog()
  const foreign = useForeignName(draft.workspace_id)
  const sentence = agentDraftSentence(draft)
  const copy: CompactCopy = { verb: 'Review', sentence, details: [], primary: 'act', icon: 'mail' }
  const openDraft = () =>
    openTarget(
      {
        type: 'mail',
        folder: draft.folder || 'drafts',
        threadId: draft.provider_thread_id,
        draftId: draft.provider_draft_id,
        title: draft.subject ?? 'Draft',
      },
      { from: 'card', workspaceId: draft.workspace_id },
    )
  const model: CompactModel = {
    id: draft.id,
    copy,
    act: openDraft,
    busy: false,
    rows: [{ key: 'mail', label: 'Open in Mail', icon: MailIcon, onSelect: openDraft }, ...botRow(source)],
    full: null,
    meta: ['Email draft', relativeTime(draft.created_at), entry.area, foreign ? `In ${foreign}` : null],
    reply: { kind: 'draft', id: draft.id, workspaceId: draft.workspace_id, verb: copy.verb, sentence, icon: 'mail' },
    impression: () => posthog?.capture('attention_card_impression', { kind: 'email_draft', surface: 'column' }),
  }
  return <CompactShell model={model} source={source} tag={columnTag(entry)} />
}

/** The verb pill. */
function VerbPill({ verb, busy, onClick, className }: { verb: string; busy: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-compact-verb=""
      disabled={busy}
      onClick={(e) => {
        // The pill acts; the card around it would open the focus view.
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        VERB_PILL_CLASS,
        'mr-1.5 align-middle transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none',
        className,
      )}
    >
      {busy && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
      {verb}
    </button>
  )
}

/** The card in the column and, while open, its focus view. */
function CompactShell({ model, source, tag }: { model: CompactModel; source: ColumnSource; tag: string }) {
  const { copy } = model
  const rootRef = useRef<HTMLDivElement>(null)
  // The card as the focus view shows it, grown: where Reply's flight takes off.
  const focusCardRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState<null | 'details' | 'full'>(null)
  const [running, setRunning] = useState(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  useCardImpression(rootRef, model.id, 'column', model.impression)

  const busy = model.busy || running
  const picking = model.targetPicker?.open ? model.targetPicker : null
  // The picker an unresolved update opened keeps the focus view up (its pill
  // is the picker's anchor), whether or not a click opened the view.
  const view = focus ?? (picking ? 'details' : null)
  const close = () => {
    setFocus(null)
    picking?.setOpen(false)
  }
  // A verb or a row: done, then the focus view closes (a card it settled is gone by then anyway).
  const run = async (fn: () => unknown) => {
    setRunning(true)
    try {
      await fn()
    } finally {
      if (mounted.current) {
        setRunning(false)
        setFocus(null)
      }
    }
  }
  // The pill in the column: the verb, or the focus view where the verb needs it first.
  const onPill = () => {
    if (copy.primary === 'act') void run(model.act)
    else setFocus(copy.primary === 'full' && model.full ? 'full' : 'details')
  }
  // The pill in the focus view: the verb (an approval's, now its inputs are shown), or the controls it needs.
  const onFocusPill = () => {
    if (copy.primary === 'full' && model.full && focus !== 'full') setFocus('full')
    else void run(model.act)
  }
  const label = `${copy.verb} ${copy.sentence}`
  const hintId = useId()
  const metaLine = focusMetaLine(source.name, model.meta)

  const reply = () => {
    // Seen to travel: the card lifts off here and flies into the chat's Reply chip (card-reply-flight.ts), launched before the focus view closes.
    launchCardReplyFlight(model.reply, focusCardRef.current ?? rootRef.current)
    requestCardReply(model.reply)
    close()
  }
  // Waiting as the chat's Reply chip: the one in hand, faded here.
  const replying = useIsReplyingCard(model.reply)
  const rows: Array<MenuRow & { keepOpen?: boolean }> = [
    { key: 'reply', label: 'Reply', icon: CornerUpLeft, onSelect: reply, keepOpen: true },
    ...(model.full && focus !== 'full' ? [{ key: 'full', label: model.full.label, icon: model.full.icon, onSelect: () => setFocus('full'), keepOpen: true }] : []),
    ...model.rows,
  ]

  return (
    <>
      <div
        ref={rootRef}
        tabIndex={0}
        role="group"
        aria-label={label}
        aria-describedby={hintId}
        data-compact-card={model.id}
        data-compact-replying={replying ? '' : undefined}
        onClick={() => setFocus('details')}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          setFocus('details')
        }}
        className={cn(
          FLOATING_CARD_CLASS,
          // Hover lifts the glass (brighter, never more see-through).
          'cursor-pointer rounded-2xl px-3 py-2.5 transition-[background-color,opacity] hover:bg-background/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:hover:bg-neutral-800/70',
          replying && 'opacity-55',
        )}
      >
        <span id={hintId} className="sr-only">
          Enter shows its details and its other actions.
        </span>
        <p data-compact-sentence="" className="line-clamp-2 text-[13px] leading-6 text-foreground/90">
          <VerbPill verb={copy.verb} busy={busy} onClick={onPill} />
          <SentenceIcon icon={copy.icon} />
          {copy.sentence}
        </p>
        {/* Where it came from, as a tag on the card (the column has no headers). */}
        <span
          data-compact-tag=""
          className="mt-1.5 inline-flex h-5 max-w-full items-center rounded-full bg-foreground/[0.06] px-2 text-[11px] font-medium text-muted-foreground"
        >
          <span className="truncate">{tag}</span>
        </span>
      </div>
      {view && (
        <ColumnFocusView
          anchorRef={rootRef}
          label={label}
          onClose={close}
          card={
            view === 'full' && model.full ? (
              <div ref={focusCardRef} data-compact-focus-full="">
                {model.full.card}
              </div>
            ) : (
              <div ref={focusCardRef} data-compact-focus-card={model.id} className={cn(FLOATING_CARD_CLASS, 'rounded-2xl px-3.5 py-3 shadow-lg shadow-black/10 dark:shadow-black/40')}>
                <p className="text-[13px] leading-6 text-foreground/90">
                  {picking ? (
                    <ActionTargetPicker
                      open
                      onOpenChange={picking.setOpen}
                      onPick={(a) => void run(() => picking.pick(a.id))}
                      workspaceId={picking.workspaceId}
                      align="start"
                    >
                      <button type="button" data-compact-verb="" data-compact-target-picker="" className={cn(VERB_PILL_CLASS, 'mr-1.5 align-middle')}>
                        {copy.verb}
                      </button>
                    </ActionTargetPicker>
                  ) : (
                    <VerbPill verb={copy.verb} busy={busy} onClick={onFocusPill} />
                  )}
                  <SentenceIcon icon={copy.icon} />
                  {copy.sentence}
                </p>
                <div aria-hidden className="my-2.5 h-px bg-border/60" />
                <div data-compact-details="" className="space-y-2 text-[12.5px] leading-relaxed text-muted-foreground">
                  {copy.details.map((d) => (
                    <p key={d} className="whitespace-pre-wrap">
                      {d}
                    </p>
                  ))}
                  {model.extra}
                  {metaLine && (
                    <p data-compact-meta="" className="text-[11px] text-muted-foreground/80">
                      {metaLine}
                    </p>
                  )}
                </div>
              </div>
            )
          }
          menu={
            <div data-compact-menu="" className={cn(FLOATING_CARD_CLASS, 'divide-y divide-border/50 overflow-hidden rounded-2xl shadow-lg shadow-black/10 dark:divide-white/10 dark:shadow-black/40')}>
              {rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  data-compact-row={row.key}
                  disabled={busy && !row.keepOpen}
                  onClick={() => (row.keepOpen ? row.onSelect() : void run(row.onSelect))}
                  // One tone for every row, Dismiss too (Liam's reference: a plain trash icon and the word).
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
                >
                  <row.icon aria-hidden className="h-4 w-4 shrink-0 opacity-80" />
                  {row.label}
                </button>
              ))}
            </div>
          }
        />
      )}
    </>
  )
}
