'use client'

/**
 * The row pieces a list of work is drawn with (docs/plans/bots-v4.md, Phase
 * 1b): a lane's heading and its empty line, one work item's row, a tree of
 * handoffs under the run they were part of (row 14), and the records a run
 * touched as chips (row 10). Each bot's page (components/bots/bot-page/) draws
 * its lists with them.
 */
import { useState, type ReactNode } from 'react'
import { Building2, ChevronDown, ChevronRight, CornerDownRight, Eye, Inbox, Loader2, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OpenTarget } from '@/lib/chat-cards/open-card'
import { Button } from '@/components/ui/button'
import { AttemptedChip } from '@/components/attention/review-card'
import { StatusIcon } from '@/components/work/work-item-detail-panel'
import { OwnerMark } from '@/components/work/work-owner-mark'
import { isAttempt, ownerOf, reviewOutcome } from '@/lib/work/agent-work-lanes'
import { durationText, isPausedFailure, itemLine, kindLabel, relativeTime, settledAt } from '@/lib/work/presentation'
import type { EntityChip } from '@/lib/work/touch-summary'
import { subtreeSummary, type WorkTree } from '@/lib/work/tree'
import { isWorkLive, type WorkItem } from '@/lib/work/types'
import { planBadge, planProgress, planStepsFrom } from '@/lib/work/plan'

// ── lanes ────────────────────────────────────────────────────────────────────

export function Lane({ title, hint, count, children }: { title: string; hint: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {title}
          {typeof count === 'number' && count > 0 ? <span className="ml-1 font-normal">· {count}</span> : null}
        </h2>
        <span className="truncate text-[11px] text-muted-foreground/60">{hint}</span>
      </div>
      {children}
    </section>
  )
}

export function EmptyLane({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-[11px] text-muted-foreground">
      <Inbox className="h-3.5 w-3.5 text-muted-foreground/60" />
      {children}
    </p>
  )
}

// ── rows ─────────────────────────────────────────────────────────────────────

const OUTCOME_TEXT: Record<'reviewed' | 'dismissed' | 'expired', string> = {
  reviewed: 'reviewed',
  dismissed: 'dismissed',
  expired: 'expired unreviewed',
}

/** Where a row sits in its tree (row 14). */
export interface RowNest {
  /** 0 for the tree's own row, 1+ for a handoff under it. */
  depth: number
  /** A settled root's "2 handoffs" toggle, when its handoffs are folded. */
  handoffs?: { label: string; open: boolean; onToggle: () => void } | null
  /** The root's title, for a handoff listed on its own. */
  partOf?: string | null
}

/** A row's tone by its own status: a handoff under a root in another lane
 *  keeps the colour of what it is doing. */
export function sectionTone(item: Pick<WorkItem, 'status'>): 'needs' | 'running' | 'recent' {
  if (item.status === 'needs_input' || item.status === 'needs_review') return 'needs'
  if (item.status === 'queued' || item.status === 'running' || item.status === 'waiting_on_child') return 'running'
  return 'recent'
}

export function runningStamp(item: WorkItem): string {
  if (item.status === 'queued') return 'queued'
  if (item.status === 'running' || item.status === 'waiting_on_child') return durationText(item.started_at ?? item.created_at)
  return relativeTime(settledAt(item))
}

/**
 * A tree's rows: its own row, then each handoff under it, indented (row 14).
 * `collapsible` (a settled tree) folds the handoffs behind the root's summary.
 */
export function TreeRows({
  tree,
  row,
  collapsible = false,
}: {
  tree: WorkTree
  row: (item: WorkItem, nest: RowNest) => ReactNode
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = subtreeSummary(tree)
  const folded = collapsible && !!summary && !open
  const nodes: ReactNode[] = [
    row(tree.item, {
      depth: 0,
      handoffs: collapsible && summary ? { label: summary, open, onToggle: () => setOpen((o) => !o) } : null,
    }),
  ]
  if (!folded) {
    const walk = (t: WorkTree, depth: number) => {
      for (const child of t.children) {
        nodes.push(row(child.item, { depth }))
        walk(child, depth + 1)
      }
    }
    walk(tree, 1)
  }
  return <>{nodes}</>
}

/**
 * One work item: whose it is (teammate, or the lane named for itself), what
 * it is, the one line to know, and its time. Waiting on you is amber, running
 * blue (with Stop when something can stop it), settled quiet. `seen` marks a
 * row still waiting on you that you've already opened (a bot's page). A row
 * held only in light columns (no title yet) is named by its kind.
 */
export function WorkRow({
  item,
  tone,
  stamp,
  workspaceName,
  onOpen,
  openTitle,
  onStop,
  stopping,
  chips = [],
  onOpenEntity,
  nest,
  seen = false,
}: {
  item: WorkItem
  tone: 'needs' | 'running' | 'recent'
  stamp: string
  workspaceName: string | null
  onOpen: () => void
  /** Where the row goes, said as its tooltip ("Open Writer's page"). */
  openTitle?: string
  onStop?: () => void
  stopping?: boolean
  /** The entities it touched (row 10), each opening that entity. */
  chips?: EntityChip[]
  onOpenEntity?: (chip: EntityChip) => void
  /** Its place in a tree of handoffs (row 14). */
  nest?: RowNest
  /** Still waiting on you, already opened. */
  seen?: boolean
}) {
  const depth = nest?.depth ?? 0
  const owner = ownerOf(item)
  const who = owner.type === 'teammate' ? owner.name : owner.label
  const title = item.title || kindLabel(item.kind)
  const pausedFailure = isPausedFailure(item)
  const failed = item.status === 'failed' && !pausedFailure
  const muted = item.status === 'skipped' || item.status === 'canceled'
  const outcome = tone === 'recent' ? reviewOutcome(item) : null
  // A live job's plan, as a "3/5" badge (the step in progress as its tooltip).
  const planSteps = isWorkLive(item.status) ? planStepsFrom(item.plan) : null
  const planNow = planSteps ? planProgress(planSteps).current : null
  return (
    <li
      style={depth > 0 ? { marginLeft: depth * 20 } : undefined}
      data-depth={depth}
      data-work-row={item.id}
      className={cn(
        'rounded-lg border',
        tone === 'needs' && 'border-amber-500/40 bg-amber-500/10',
        tone === 'running' && 'border-blue-500/30 bg-blue-500/5',
        tone === 'recent' &&
          (pausedFailure
            ? 'border-amber-500/30 bg-amber-500/10'
            : failed
              ? 'border-destructive/30 bg-destructive/10'
              : muted
                ? 'border-border/50 bg-muted/30'
                : 'border-border/50 bg-card/50'),
      )}
    >
      <div className="flex items-stretch">
      <button type="button" onClick={onOpen} title={openTitle} className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left">
        {depth > 0 && (
          <CornerDownRight className="-mr-1 mt-1 h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="Handed off" />
        )}
        <OwnerMark owner={owner} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-xs font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>
              {title}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {planSteps && (
                <span
                  data-work-row-plan=""
                  title={planNow ? `Plan: ${planNow}` : 'Plan'}
                  className="rounded-full border border-border/60 px-1.5 text-[10px] tabular-nums text-muted-foreground"
                >
                  {planBadge(planSteps)}
                </span>
              )}
              <span className="text-[10px] tabular-nums text-muted-foreground">{stamp}</span>
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <StatusIcon status={item.status} paused={pausedFailure} className="h-3 w-3" />
            <p
              className={cn(
                'min-w-0 truncate text-[11px]',
                tone === 'needs'
                  ? 'text-amber-700/90 dark:text-amber-400/90'
                  : tone === 'running'
                    ? 'text-blue-600/80 dark:text-blue-400/80'
                    : pausedFailure
                      ? 'text-amber-700 dark:text-amber-400'
                      : failed
                        ? 'text-destructive'
                        : 'text-muted-foreground',
              )}
            >
              <span className="font-medium">{who}</span> · {pausedFailure ? 'paused: AI usage limit' : itemLine(item)}
            </p>
          </div>
          {(seen || isAttempt(item) || outcome || workspaceName || nest?.partOf) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {seen && (
                <span data-work-row-seen="" className="flex h-5 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                  <Eye className="h-2.5 w-2.5 shrink-0" />
                  Seen
                </span>
              )}
              {nest?.partOf && (
                <span className="flex h-5 max-w-[16rem] items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                  <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">Part of {nest.partOf}</span>
                </span>
              )}
              {isAttempt(item) && <AttemptedChip />}
              {outcome && (
                <span className="flex h-5 items-center rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                  {OUTCOME_TEXT[outcome]}
                </span>
              )}
              {workspaceName && (
                <span className="flex h-5 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                  <Building2 className="h-2.5 w-2.5" />
                  {workspaceName}
                </span>
              )}
            </div>
          )}
        </div>
        {!onStop && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      </button>
      {onStop && (
        <div className="flex items-center pr-2">
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={stopping}
            onClick={onStop}
            aria-label={`Stop ${title}`}
          >
            {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-2.5 w-2.5 fill-current" />}
            {stopping ? 'Stopping' : 'Stop'}
          </Button>
        </div>
      )}
      </div>
      {nest?.handoffs && (
        <div className="-mt-1 pb-1.5 pl-[38px] pr-2.5">
          <button
            type="button"
            onClick={nest.handoffs.onToggle}
            aria-expanded={nest.handoffs.open}
            className="flex h-5 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {nest.handoffs.open ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
            {nest.handoffs.label}
          </button>
        </div>
      )}
      {chips.length > 0 && onOpenEntity && (
        <div className="-mt-1 flex flex-wrap items-center gap-1 pb-2 pl-[38px] pr-2.5" aria-label="Touched">
          {chips.map((c) => (
            <button
              key={`${c.entity_type}:${c.entity_id}`}
              type="button"
              onClick={() => onOpenEntity(c)}
              title={`${c.wrote ? 'Changed' : 'Looked at'} ${CHIP_TYPE_LABELS[c.entity_type]}: ${c.label}`}
              className={cn(
                'flex h-5 max-w-[14rem] items-center gap-1 rounded-full border px-1.5 text-[10px] transition-colors hover:bg-muted',
                c.wrote ? 'border-border text-foreground' : 'border-border/50 text-muted-foreground',
              )}
            >
              <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  )
}

// ── chips ────────────────────────────────────────────────────────────────────

/** A chip's kind, for its tooltip. */
const CHIP_TYPE_LABELS: Record<EntityChip['entity_type'], string> = {
  action: 'action',
  capture: 'capture',
  contact: 'contact',
  company: 'company',
  document: 'document',
  project: 'project',
  initiative: 'initiative',
}

/** What a chip opens: its record, as a card in the chat (lib/chat-cards/open-card.ts). */
export function chipTarget(chip: EntityChip): OpenTarget {
  return { type: chip.entity_type, id: chip.entity_id, title: chip.label ?? null }
}
