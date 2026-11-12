'use client'

/**
 * The page panel's button, to the right of Search in the app rail's header
 * (Liam, 11-11: "we also need a button for opening and closing the new panel
 * lets put it to the right of the search button"). A disclosure button
 * (aria-expanded: the panel on screen now; aria-controls: the panel,
 * PAGE_PANEL_ID), drawn like the header's other buttons: a flat 32px circle,
 * tinted while the panel shows (as side-panel-toggles.tsx's header variant).
 *
 *   There   only while the panel has something to show (its page has rows,
 *           and the capture's notepad doesn't hold the left): with nothing,
 *           no button (Liam's "hide empty widgets").
 *   Press   closes the panel while it is on screen; otherwise opens it by
 *           hand, so it shows even where the row has no room for it,
 *           floating over the chat's left edge (side-panel-store.ts
 *           setPagePanelOpen). Remembered per device; open by default.
 *   No key  no shortcut for now.
 *   Named   by the panel it opens (PAGE_PANEL_LABELS): Recent on home, the
 *           page's own on a page (Liam, 11-11: the Tasks sub-nav on My
 *           Actions); a page group's label on its sub-nav (Liam, 11-11:
 *           Contacts, Outreach, Calendar), in the workspace's words.
 */
import { PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOP_BAR_TIP } from '../top-bar/pill-style'
import { togglePagePanel } from '../side-panels/side-panel-store'
import { useSidePanelState } from '../side-panels/side-panels'
import { useSelectedPlace } from '../rail/selected-place'
import { isPageGroupId } from '../rail/page-groups'
import { useRailEntry } from './page-group-panel'
import { PAGE_PANEL_ID, PAGE_PANEL_LABELS } from './page-panel-types'

/** What home's panel and its button are called (the tooltip, the label). */
export const PAGE_PANEL_LABEL = PAGE_PANEL_LABELS.home

export function PagePanelToggle() {
  const { pagePanel, pagePanelShown } = useSidePanelState()
  const place = useSelectedPlace()
  const group = useRailEntry(isPageGroupId(place) ? place : null)
  if (!pagePanel) return null
  const label: string = group?.label ?? (PAGE_PANEL_LABELS as Record<string, string>)[place] ?? PAGE_PANEL_LABEL
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-page-panel-toggle=""
          data-app-rail-item="page-panel"
          aria-expanded={pagePanelShown}
          aria-controls={PAGE_PANEL_ID}
          aria-label={label}
          onClick={() => togglePagePanel()}
          data-lit={pagePanelShown ? '' : undefined}
          className={cn(
            'relative flex size-8 shrink-0 items-center justify-center rounded-full text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            // Tinted while the panel is on screen, as the rail's lit page.
            pagePanelShown && 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]',
          )}
        >
          <PanelLeft data-page-panel-icon="" className="size-[18px]" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} collisionPadding={8} avoidCollisions={false} className={TOP_BAR_TIP}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
