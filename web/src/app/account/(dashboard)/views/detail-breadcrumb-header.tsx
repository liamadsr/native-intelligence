'use client'

import { PageTitle } from '@/components/views/page-title'
import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ReminderHeaderPill } from '@/components/reminders/reminder-pill'
import type { ReminderEntityType } from '@/lib/reminders/types'
import { ViewHeader } from './view-header'

/** Words kept before the breadcrumb elides the rest. */
const BREADCRUMB_MAX_WORDS = 4
/**
 * Character ceiling applied alongside the word cap. Four words can still be
 * very wide ("Infrastructure modernization implementation retrospective"), and
 * the breadcrumb sits in fixed header chrome — the word cap alone doesn't bound
 * the width.
 */
const BREADCRUMB_MAX_CHARS = 32

/**
 * Shortens a detail title for the breadcrumb.
 *
 * The breadcrumb is a positional marker, not a place to read the title — the
 * full text is already the panel heading directly below it. Long titles here
 * pushed the header wide and drowned out the parent-view crumb, so keep the
 * first few words and elide the rest.
 *
 * Titles already short enough are returned untouched, so no ellipsis appears
 * where nothing was actually cut.
 */
export function truncateBreadcrumbTitle(
  title: string,
  maxWords = BREADCRUMB_MAX_WORDS,
  maxChars = BREADCRUMB_MAX_CHARS,
): string {
  const trimmed = title.trim()
  if (!trimmed) return trimmed

  const words = trimmed.split(/\s+/)
  let result = words.slice(0, maxWords).join(' ')
  let elided = words.length > maxWords

  if (result.length > maxChars) {
    // Drop whole words while over budget rather than cutting mid-word, but keep
    // at least one word so a single long word still shows something.
    const kept: string[] = []
    for (const word of result.split(' ')) {
      if (kept.length && [...kept, word].join(' ').length > maxChars) break
      kept.push(word)
    }
    result = kept.join(' ')
    elided = true

    // A single word longer than the budget has to be cut mid-word. Leave room
    // for the ellipsis so the rendered string still fits the budget.
    if (result.length > maxChars) result = result.slice(0, maxChars - 1).trimEnd()
  }

  return elided ? `${result}…` : result
}

interface DetailBreadcrumbHeaderProps {
  viewTitle: string
  /**
   * The entity's title. Shortened to a few words for display — the full text
   * is the panel heading directly below, so the crumb only needs to identify
   * which entity is open, and a long one pushes the header wide.
   */
  detailTitle: string
  /**
   * Ticket ID (GEN-39), shown before the title. Actions are the only entity
   * with one; everything else shows the title alone.
   *
   * This is also why the panel body no longer prints the identifier above its
   * heading — the breadcrumb is now where it lives.
   */
  detailIdentifier?: string
  onBack: () => void
  onPrev?: () => void
  onNext?: () => void
  /**
   * Whether this entity supports prev/next stepping at all — a property of the
   * entity type, NOT of whether neighbours happen to be resolved yet.
   *
   * The arrows used to be rendered only when a handler existed, so they blinked
   * out of existence at the ends of a list and again during every fallback
   * lookup, shifting the header's contents as the user stepped. The disabled
   * styling below is the correct expression of "no neighbour that way"; this
   * flag is what makes it reachable.
   */
  showNav?: boolean
  /**
   * The open entity, when it's a kind that supports reminders — turns on the
   * pending-reminder pill beside the nav arrows.
   *
   * Optional because the header is also used for entities with no reminder
   * surface (and by the live-recording capture header, which has no id to hand
   * over yet). The pill renders nothing when there's no pending reminder, so
   * passing this is never itself a visual change.
   */
  reminderEntity?: { type: ReminderEntityType; id: string }
}

export function DetailBreadcrumbHeader({
  viewTitle,
  detailTitle,
  detailIdentifier,
  onBack,
  onPrev,
  onNext,
  showNav,
  reminderEntity,
}: DetailBreadcrumbHeaderProps) {
  const navigation = (showNav || onPrev !== undefined || onNext !== undefined) && (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onPrev}
              disabled={!onPrev}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Previous</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onNext}
              disabled={!onNext}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Next</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )

  return (
    <ViewHeader navigation={navigation}>
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm min-w-0">
        <PageTitle label={viewTitle} onClick={onBack} />
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {/* Styled identically to the title so the two read as one crumb, not as
            a label plus a value. shrink-0 so a narrow window eats into the
            title instead of clipping the ID — a half-rendered "GEN-3" would be
            worse than useless, while a shortened title still reads fine. */}
        {detailIdentifier && (
          <span className="font-medium shrink-0">{detailIdentifier}</span>
        )}
        {/* truncate stays as a width-based backstop: the word cap bounds a long
            title, but a narrow window can still overflow a short one. */}
        <span className="font-medium truncate" title={detailTitle}>
          {truncateBreadcrumbTitle(detailTitle)}
        </span>
      </div>

      <div className="flex-1" />

      {/* Pending reminder — sits just left of the nav arrows, and draws nothing
          at all when this entity has none, so the header is unchanged for the
          overwhelming majority of opens. Keyed on the entity so switching
          entities in one panel refetches instead of showing the old label. */}
      {reminderEntity && (
        <div className="mr-2 flex items-center">
          <ReminderHeaderPill
            key={`${reminderEntity.type}:${reminderEntity.id}`}
            entityType={reminderEntity.type}
            entityId={reminderEntity.id}
          />
        </div>
      )}
    </ViewHeader>
  )
}
