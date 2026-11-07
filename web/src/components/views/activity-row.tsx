'use client'

import * as React from 'react'
import { ChevronDown, ChevronRight, History, Pencil, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Created/updated activity as a collapsible property row.
 *
 * Previously a standalone "Activity" card at the bottom of the capture and
 * document sidebars, always showing both timeline entries. Those two panels
 * rendered byte-identical copies of it; extracted here so they share one
 * definition and stay consistent.
 *
 * The row follows the Participants/Attachments shape — a summary line that
 * expands to the detail — so the sidebar reads as a uniform list of properties
 * rather than a stack of differently-shaped cards.
 */
export function ActivityRow({
  createdAt,
  updatedAt,
  formatRelativeTime,
  padding = 'px-2',
}: {
  createdAt: string
  updatedAt: string
  /** The panel's own relative-time formatter, so wording matches its siblings. */
  formatRelativeTime: (dateStr: string) => string
  /**
   * Horizontal padding of the row, so it lines up with the sibling rows of
   * whichever panel mounts it. The panels use two conventions: `px-3` (capture,
   * document) and `px-2` (action, initiative, contact).
   */
  padding?: 'px-2' | 'px-3'
}) {
  const [expanded, setExpanded] = React.useState(false)
  // A capture saved and never touched again has one event, not two.
  const wasUpdated = updatedAt !== createdAt

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted/50',
          padding,
        )}
      >
        <History className="h-4 w-4 shrink-0" />
        {/* The summary carries the most recent event, so the collapsed row is
            still informative — not just a label hiding its own content. */}
        <span className="min-w-0 truncate">
          {wasUpdated
            ? `Updated · ${formatRelativeTime(updatedAt)}`
            : `Created · ${formatRelativeTime(createdAt)}`}
        </span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className={cn('relative space-y-0 pb-2 pt-1', padding)}>
          {/* Vertical connector through the dot centres: padding + half of the
              18px dot. Tied to `padding` so it doesn't drift off the dots. */}
          <div
            className={cn(
              'absolute top-2 bottom-3 w-px bg-border',
              padding === 'px-3' ? 'left-[21px]' : 'left-[17px]',
            )}
          />
          {wasUpdated && (
            <div className="relative flex items-start gap-3 py-1.5">
              <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                <Pencil className="h-2.5 w-2.5 text-blue-500" />
              </div>
              <p className="text-xs text-muted-foreground">
                Updated · {formatRelativeTime(updatedAt)}
              </p>
            </div>
          )}
          <div className="relative flex items-start gap-3 py-1.5">
            <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
              <Plus className="h-2.5 w-2.5 text-green-500" />
            </div>
            <p className="text-xs text-muted-foreground">
              Created · {formatRelativeTime(createdAt)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
