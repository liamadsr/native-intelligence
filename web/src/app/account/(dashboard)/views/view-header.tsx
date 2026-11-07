'use client'

import { PageTitle } from '@/components/views/page-title'
import { cn } from '@/lib/utils'

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
export function ViewHeader({ title, actions, navigation, children, className }: ViewHeaderProps) {
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
