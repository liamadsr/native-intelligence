'use client'

import { Bug, ChevronUp, Globe, Lightbulb, Lock, MessageSquare, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'

// ─── Shared types + presentation for the feedback board ──────────────────────
// Used by the Settings → Feedback view (feedback-settings-view).

export type FeatureRequestStatus =
  | 'open'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'declined'

/** The three kinds of post the board hosts (migration 137). */
export type FeedbackType = 'feedback' | 'feature_request' | 'bug'

/** Post visibility (migration 138): public board vs. author-only. */
export type FeedbackVisibility = 'public' | 'private'

export interface FeatureRequestAuthor {
  user_id: string
  name: string
  is_self: boolean
}

export interface FeatureRequest {
  id: string
  title: string
  description: string | null
  type: FeedbackType
  visibility: FeedbackVisibility
  status: FeatureRequestStatus
  vote_count: number
  comment_count: number
  created_at: string
  updated_at: string
  author: FeatureRequestAuthor
  has_voted: boolean
  can_edit: boolean
}

/** Status → label + dot + text colors, matching the app's dot-status grammar. */
const STATUS_META: Record<
  FeatureRequestStatus,
  { label: string; dot: string; text: string }
> = {
  open: { label: 'Open', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
  planned: { label: 'Planned', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  completed: { label: 'Completed', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  declined: { label: 'Declined', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
}

/** A dot + label pill, matching the initiative/project detail pills. */
export function StatusPill({
  status,
  className,
}: {
  status: FeatureRequestStatus
  className?: string
}) {
  const meta = STATUS_META[status] ?? STATUS_META.open
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}

// ─── Type (feedback / feature request / bug) ─────────────────────────────────

/** Type → label + icon + accent colors. The icon-led badge distinguishes the
 *  three kinds at a glance without competing with the dot-led status pill. */
export const TYPE_META: Record<
  FeedbackType,
  { label: string; short: string; icon: LucideIcon; text: string; bg: string; border: string }
> = {
  feedback: {
    label: 'Feedback',
    short: 'Feedback',
    icon: MessageSquare,
    text: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
  },
  feature_request: {
    label: 'Feature request',
    short: 'Feature',
    icon: Lightbulb,
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
  },
  bug: {
    label: 'Bug',
    short: 'Bug',
    icon: Bug,
    text: 'text-rose-600 dark:text-rose-400',
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20',
  },
}

/** Ordered list for the create selector. */
export const TYPE_OPTIONS: { value: FeedbackType; label: string; description: string }[] = [
  { value: 'feedback', label: 'Feedback', description: 'Share a thought or impression' },
  { value: 'feature_request', label: 'Feature request', description: 'Suggest something new' },
  { value: 'bug', label: 'Bug', description: 'Report something broken' },
]

/** Type filter chips for the toolbar (with an "all" option). */
export const TYPE_FILTERS: { value: FeedbackType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'feature_request', label: 'Features' },
  { value: 'bug', label: 'Bugs' },
]

/** An icon + label badge identifying the kind of post. */
export function TypeBadge({
  type,
  className,
}: {
  type: FeedbackType
  className?: string
}) {
  const meta = TYPE_META[type] ?? TYPE_META.feedback
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        meta.bg,
        meta.border,
        meta.text,
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.short}
    </span>
  )
}

// ─── Visibility (public / private) ───────────────────────────────────────────

const VISIBILITY_META: Record<
  FeedbackVisibility,
  { label: string; description: string; icon: LucideIcon }
> = {
  public: {
    label: 'Public',
    description: 'Visible on the board — anyone can see and upvote it',
    icon: Globe,
  },
  private: {
    label: 'Private',
    description: 'Only you (and the Dial8 team) can see it',
    icon: Lock,
  },
}

/** A subtle lock badge shown on the author's own private posts. */
export function PrivateBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      <Lock className="h-2.5 w-2.5" />
      Private
    </span>
  )
}

/**
 * Public/private as a single switch: ON (green) = public, OFF = private.
 * Public is the default-on state. Shows a short Public/Private label + icon next
 * to the switch so the state is unambiguous.
 */
export function VisibilityToggle({
  visibility,
  onChange,
  disabled,
  className,
}: {
  visibility: FeedbackVisibility
  onChange: (next: FeedbackVisibility) => void
  disabled?: boolean
  className?: string
}) {
  const isPublic = visibility === 'public'
  const meta = VISIBILITY_META[visibility]
  const Icon = meta.icon
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {meta.label}
      </span>
      <Switch
        checked={isPublic}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? 'public' : 'private')}
        aria-label={isPublic ? 'Public — anyone can see this' : 'Private — only you can see this'}
        className="data-[state=checked]:bg-emerald-500"
      />
    </div>
  )
}

// ─── Upvote / endorse control ────────────────────────────────────────────────

/**
 * The endorsement control, shared by the list row and the detail hero.
 *
 * Two deliberate calibrations (see the theming note below):
 *  - `row`  — compact, SOFT tint when voted (`bg-primary/15`). Solid fill is
 *             never used in a dense list.
 *  - `hero` — large, SOLID fill when voted, and shows the literal word
 *             "Upvote"/"Upvoted" so the affordance is unmistakable.
 *
 * Theming note: in dark mode `--primary` is a desaturated light grey that is
 * identical to `--foreground`, so hue carries almost no signal — the
 * outline→fill luminance flip (and the word on the hero) is the real "voted"
 * cue. That's why rows stay soft-tinted and only the single hero goes solid.
 */
export function UpvoteButton({
  voted,
  count,
  onVote,
  size = 'row',
  className,
}: {
  voted: boolean
  count: number
  onVote: () => void
  size?: 'row' | 'hero'
  className?: string
}) {
  const isHero = size === 'hero'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onVote()
      }}
      aria-pressed={voted}
      aria-label={voted ? `Upvoted, ${count} ${count === 1 ? 'vote' : 'votes'}` : `Upvote, ${count} ${count === 1 ? 'vote' : 'votes'}`}
      title={voted ? 'Remove upvote' : 'Upvote'}
      className={cn(
        'group/vote flex shrink-0 flex-col items-center justify-center border transition-colors',
        isHero ? 'w-14 gap-0.5 rounded-lg py-2' : 'w-11 gap-0.5 rounded-md py-1.5',
        voted
          ? isHero
            ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
            : 'border-primary bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground',
        className,
      )}
    >
      <ChevronUp className={cn(isHero ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
      <span
        className={cn(
          'font-semibold tabular-nums leading-none',
          isHero ? 'text-sm' : 'text-[11px]',
          // At rest the count is data, so force foreground; when voted it
          // inherits the active color (primary / primary-foreground).
          !voted && 'text-foreground',
        )}
      >
        {count}
      </span>
      {isHero && (
        <span className="text-[10px] font-medium leading-none">
          {voted ? 'Upvoted' : 'Upvote'}
        </span>
      )}
    </button>
  )
}
