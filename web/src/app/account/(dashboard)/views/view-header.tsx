'use client'

import * as React from 'react'
import { PageTitle } from '@/components/views/page-title'
import { CardHeaderSlot, CardHeaderTrail, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { cn } from '@/lib/utils'

/** Where the page is inside itself (a suite, a tracker, a table): in a card, the header's breadcrumb. */
export interface ViewHeaderPlace {
  /** The place's name (and what stands with it: an id, a private mark). */
  label: React.ReactNode
  /** Back to the page; the card's title becomes this press. */
  onBack: () => void
  /** What that press says (Back to tables). */
  backLabel: string
}

interface ViewHeaderProps {
  /** The view title, shown at the left of the header. Most views pass a
   *  string; pass a node for bespoke title rows (segmented toggles, team
   *  dropdowns, breadcrumbs). */
  title?: React.ReactNode
  /** Kept for callers that lay their own title out; Back and Forward are the card header's now. */
  history?: 'auto' | 'custom'
  /** Controls pinned to the far right of the header (search, create, etc.). */
  actions?: React.ReactNode
  /** Previous/next controls, after the actions. */
  navigation?: React.ReactNode
  /** Escape hatch for fully bespoke header content. When provided it replaces
   *  the title/actions layout. */
  children?: React.ReactNode
  /** Extra classes for the header row. */
  className?: string
  /**
   * In a card: the place inside the page, as the header's breadcrumb after
   * the card's title (which becomes the way back). Outside a card, `title`
   * says it, as before.
   */
  place?: ViewHeaderPlace
}

/**
 * Shared shell for every per-view content header (pages render in cards in
 * the chat; the card's own header carries Back and Forward, the Properties
 * popover, full screen and collapse).
 *
 * Layout contract — identical across every view:
 *
 *   [page label] ······· [actions] [navigation]
 *
 * The title sits left-anchored (never floated to the center) and any action
 * controls are pushed to the far right. The shell is normalized — `px-5`,
 * height 48px, no divider.
 */
export function ViewHeader({ title, actions, navigation, children, className, place }: ViewHeaderProps) {
  const inCard = useCardHeaderSlots() !== null
  if (inCard) {
    // In a card its header is the page's (Liam, 11-21 and 11-22: one title,
    // every control in the header island): the page's name is already there,
    // so a plain title is not drawn again; the actions and navigation go to
    // the header's right; a place becomes its breadcrumb. Only a bespoke
    // title (a toggle, a picker) or `children` keep a row in the page.
    const keptTitle = title != null && !place && !isPageName(title) ? title : null
    return (
      <>
        {place && (
          <CardHeaderTrail onBack={place.onBack} backLabel={place.backLabel}>
            {place.label}
          </CardHeaderTrail>
        )}
        {(actions || navigation) && (
          <CardHeaderSlot side="right">
            <div data-view-header-actions="" className="flex items-center gap-1.5">
              {actions}
              {navigation}
            </div>
          </CardHeaderSlot>
        )}
        {(children || keptTitle) && (
          <div className={cn('relative flex h-12 shrink-0 items-center gap-2 pl-[18px] pr-5', className)}>{children ?? keptTitle}</div>
        )}
      </>
    )
  }
  return (
    <div className={cn('relative flex h-12 shrink-0 items-center gap-2 px-5', className)}>
      {children ?? (
        <>
          {title != null && (typeof title === 'string' ? <PageTitle label={title} as="h1" /> : title)}
          {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
        </>
      )}
      {navigation && <div className={cn('flex items-center', !actions && 'ml-auto')}>{navigation}</div>}
    </div>
  )
}

/** A title that only names the page: a string, or a PageTitle that is not a way back. */
function isPageName(title: React.ReactNode): boolean {
  if (typeof title === 'string') return true
  if (!React.isValidElement(title)) return false
  if (title.type === PageTitle) return !(title.props as { onClick?: unknown }).onClick
  // A fragment holding just that.
  if (title.type === React.Fragment) {
    const kids = React.Children.toArray((title.props as { children?: React.ReactNode }).children)
    return kids.length === 1 && isPageName(kids[0] as React.ReactNode)
  }
  return false
}
