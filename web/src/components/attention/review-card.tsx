'use client'

import { useRef, useState } from 'react'
import { Activity, Building2, Check, ChevronRight, Eye, ExternalLink, Loader2, MessageSquare, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { usePostHog } from 'posthog-js/react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { useOpenOutput } from '@/hooks/use-open-output'
import { deliverableContextFor, openDeliverable } from '@/lib/work/open-deliverable'
import { DocumentSuggestionsChip } from '@/components/suggestions/document-suggestions-chip'
import { deliverableVerb, kindLine, primaryDeliverable, relativeTime, reviewLine } from '@/lib/work/presentation'
import { isAttempt } from '@/lib/work/agent-work-lanes'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { CardControlBar } from './card-control-bar'
import { COLUMN_CARD_SKIN, useCardImpression, type CardSurface } from './attention-card'
import type { ReviewCardItem, DeckPager } from './rail-cards'

/**
 * A review card (ACTIVITY-AND-REVIEW-DESIGN §4.4): a work item waiting on the
 * user, on the attention rail in the same skin as an attention card —
 * "Reply to Dana · Send 1 draft — Review draft / Reviewed / Dismiss".
 *
 * The card carries no verb of its own beyond the item's (NORTH-STAR invariant
 * 5): the primary button opens the deliverable on ITS surface — Mail for a
 * draft, the document, the pull request — where Send / Merge / Accept live and
 * resolve the item; "Reviewed" is the detail panel's Mark reviewed; the bin is
 * its Dismiss. The chevron opens the item where any item opens (bots-v4.md
 * Phase 3, useOpenWorkItem): on its teammate's bot's page, beside its run's
 * chat, else its panel on a card of its own (every deliverable, the step timeline,
 * the outcome), but only when there is nothing to open: a delivered item's
 * chevron opens its output, and the item is the caret menu's Open chat (see
 * `opensOutput`). A review you've opened already wears "Seen" (a bot's
 * bubble and page list those after what's new).
 *
 * CROSS-WORKSPACE like every card on the rail: a foreign item wears its
 * workspace's name and everything it opens is a card in that workspace,
 * switched to first.
 */
interface ReviewCardProps {
  card: ReviewCardItem
  onReviewed: (workId: string) => Promise<{ ok: boolean }>
  onDismiss: (workId: string) => Promise<void>
  /** Deck browse state, rendered in this card's bottom control bar. */
  pager?: DeckPager
  /** Where it's shown, on its impression event (bots-v4.md Phase 3). */
  surface?: CardSurface
  /** A bot's narrow column: the card grows to fit rather than clipping. */
  narrow?: boolean
  /** Its chevron opened the item (a bot's bubble closes then, as its own Open does). */
  onItemOpened?: () => void
}

export function ReviewCard({ card, pager, onReviewed, onDismiss, surface, narrow = false, onItemOpened }: ReviewCardProps) {
  const { work } = card
  const [opening, setOpening] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const posthog = usePostHog()
  const openWorkItem = useOpenWorkItem()
  const openOutput = useOpenOutput()
  const { workspaces, currentId } = useWorkspaces()

  // Foreign = the card's workspace is not the active one. Named only when the
  // cache can name it (an unnamed badge tells the user nothing).
  const foreign = !!currentId && work.workspace_id !== currentId
  const foreignWorkspaceName = foreign
    ? (workspaces.find((w) => w.id === work.workspace_id)?.name ?? null)
    : null

  // One impression per card mount — the deck mounts only the top card (the column: once in view).
  const rootRef = useRef<HTMLDivElement>(null)
  useCardImpression(rootRef, work.id, surface, () =>
    posthog?.capture('attention_card_impression', { kind: 'work_review', work_kind: work.kind, ...(surface ? { surface } : {}) }),
  )

  const primary = primaryDeliverable(work)
  const external = primary?.type === 'pr' || primary?.type === 'url'

  // Where any item opens: its bot's page, else on a card of its own, in its own workspace.
  const openItem = () => {
    openWorkItem(work.id, work.ai_team_member_id ? [work.ai_team_member_id] : [], {
      workspaceId: work.workspace_id,
      title: work.title,
      teammateId: work.ai_team_member_id ?? null,
    })
    onItemOpened?.()
  }

  const openPrimary = async () => {
    if (!primary) {
      openItem()
      return
    }
    setOpening(true)
    try {
      const ok = await openDeliverable(primary, await deliverableContextFor(work.id, primary), {
        workspaceId: work.workspace_id,
        foreignWorkspaceId: foreign ? work.workspace_id : null,
      })
      if (!ok) toast.error("Couldn't open it", { description: 'Open the item for the details.' })
    } finally {
      setOpening(false)
    }
  }

  // A delivered item opens to its OUTPUT, wherever the card stands (the
  // chat's For you column, a bot's bubble, a bot's page; Liam, 10-15: "it
  // should go to the output and not to the process"): the chevron opens the
  // primary deliverable, and the run's chat moves to the caret menu's Open
  // chat. Nothing to open (or it won't open): the item, as before. Either
  // way a host hears something opened (a bot's bubble closes then).
  const opensOutput = !!primary
  const openCard = () => {
    if (!opensOutput) {
      openItem()
      return
    }
    void openOutput({
      workItemId: work.id,
      workspaceId: work.workspace_id,
      title: work.title,
      teammateId: work.ai_team_member_id ?? null,
      output: primary,
    })
    onItemOpened?.()
  }
  const cardLabel = opensOutput && primary ? deliverableVerb(primary) : 'Open it'

  const handleReviewed = async () => {
    setReviewing(true)
    try {
      await onReviewed(work.id)
    } finally {
      setReviewing(false)
    }
  }

  const handleDismiss = async () => {
    setDismissing(true)
    try {
      await onDismiss(work.id)
    } finally {
      setDismissing(false)
    }
  }

  const busy = opening || reviewing || dismissing
  const since = new Date(card.created_at)

  // Same fixed box as an attention card so the deck's peek stack lines up;
  // the chips + actions pin to the bottom (mt-auto).
  return (
    <div
      ref={rootRef}
      data-review-card={work.id}
      className={cn(
        'flex w-full min-w-0 flex-col rounded-xl border border-border/60',
        surface === 'column'
          ? cn('h-auto', COLUMN_CARD_SKIN)
          : narrow
            ? 'h-auto min-h-[196px] bg-background/60 dark:bg-white/[0.04]'
            : 'h-[196px] bg-background/70 hud-surface-shadow backdrop-blur-md',
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3.5 pb-1 pt-3">
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90">{work.title}</p>
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{reviewLine(work)}</p>
          </div>
          <button
            type="button"
            onClick={openCard}
            aria-label={cardLabel}
            title={cardLabel}
            data-review-card-opens={opensOutput && primary ? primary.type : 'item'}
            className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-auto pt-2">
          <div className="mb-2 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
            <span className="flex h-5 min-w-0 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground">
              <Activity className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate">{kindLine(work)}</span>
            </span>
            {isAttempt(work) && <AttemptedChip />}
            {/* A delivered document's pending suggestions, settled from here. */}
            {primary?.type === 'document' && primary.id && <DocumentSuggestionsChip documentId={primary.id} />}
            {card.seen && (
              <span
                data-review-card-seen=""
                className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground"
                title="You’ve opened this; it still waits on you"
              >
                <Eye className="h-2.5 w-2.5 shrink-0" />
                Seen
              </span>
            )}
            <span
              className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
              title={Number.isFinite(since.getTime()) ? `Waiting since ${since.toLocaleString()}` : undefined}
            >
              {relativeTime(card.created_at)}
            </span>
            {foreignWorkspaceName && (
              <span
                className="flex h-5 min-w-0 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground"
                title={`In ${foreignWorkspaceName}`}
              >
                <Building2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{foreignWorkspaceName}</span>
              </span>
            )}
          </div>

        </div>
      </div>

      {/* Bottom control bar — matches the attention card: pager left, split
          CTA right, dismiss demoted into the caret menu. */}
      <CardControlBar
        pager={pager}
        busy={busy}
        extra={
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => void handleReviewed()}
            disabled={busy}
            title="Mark reviewed"
          >
            {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Reviewed
          </Button>
        }
        menu={
          <>
            {opensOutput && (
              <DropdownMenuItem onSelect={openItem} data-review-card-open-chat="">
                <MessageSquare />
                Open chat
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => void handleDismiss()}
              disabled={busy}
              // `text-destructive` is a BACKGROUND token: in dark mode it resolves to a
              // dark red (0 62.8% 30.6%) that sits at ~1.5:1 on the dark popover —
              // effectively invisible. Use the codebase's red-text pair instead.
              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
            >
              {dismissing ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Dismiss
            </DropdownMenuItem>
          </>
        }
        primary={
          <Button size="sm" className="h-6 gap-1 px-2.5 text-[11px]" onClick={() => void openPrimary()} disabled={busy}>
            {opening ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : external ? (
              <ExternalLink className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {primary ? deliverableVerb(primary) : 'Open'}
          </Button>
        }
      />
    </div>
  )
}

/**
 * The mark on an unattended attempt (`origin = 'attempt'`, plan Part 5 row 7):
 * a teammate did this on its own, from a capture, without anyone asking. It
 * rides on the review card (a bot's bubble and its page's For you) and on a
 * bot's page rows.
 */
export function AttemptedChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex h-5 shrink-0 items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-300',
        className,
      )}
      title="A teammate did this on its own. Nobody asked for it."
    >
      <Sparkles className="h-2.5 w-2.5 shrink-0" />
      Attempted
    </span>
  )
}
