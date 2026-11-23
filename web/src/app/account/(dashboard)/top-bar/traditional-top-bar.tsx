'use client'

/**
 * What Traditional adds to the top bar (docs/plans/traditional-layout.md),
 * from `md` up: at its start, the button that brings a folded sidebar back
 * (shown only while it is folded, rail/sidebar-size.ts) and Back and Forward
 * for the page in front (the rail header's, rail/app-rail.tsx
 * FrontPageHistory). No search field (the owner, 11-23: "we don't need the
 * visual search bar"): search is the sidebar's icon, `/` and ⌘K.
 */
import { PanelLeftOpen } from 'lucide-react'
import { FrontPageHistory } from '../rail/app-rail'
import { setSidebarCollapsed } from '../rail/sidebar-size'

export function TraditionalTopBarLead() {
  return (
    <div data-traditional-top-lead="" className="relative z-10 hidden items-center gap-1 md:flex">
      <button
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar"
        data-sidebar-expand=""
        onClick={() => setSidebarCollapsed(false)}
        className="hidden size-7 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [html[data-sidebar-collapsed]_&]:flex"
      >
        <PanelLeftOpen className="size-4" strokeWidth={1.75} />
      </button>
      <FrontPageHistory />
    </div>
  )
}
