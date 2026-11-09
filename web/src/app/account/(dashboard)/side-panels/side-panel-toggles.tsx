'use client'

/**
 * The top bar's two panel toggles, one per side (side-panels.tsx): the right
 * side panel's at the bar's right end, over the panel, and For you's at its
 * left end, over its column (the column has no toggle of its own). Disclosure buttons (aria-expanded +
 * aria-controls), drawn like the bar's other pills.
 *
 *   right    always there. Its badges: how many agents run now (the Agents
 *            section's count), and an amber dot while a connection needs
 *            the person (a reconnect, missing access, a sync error). ⌘\.
 *   For you  there whenever the bots have brought something (with nothing,
 *            no toggle: Liam's "hide empty widgets"), with how many, the
 *            column beside the chat or not (Liam, 11-09: "always visible like
 *            the button we have on the right side"): it folds the column
 *            away and brings it back, floating it over the chat where the
 *            row has no room.
 */
import { Home, createLucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModKeyLabel } from '@/lib/hotkeys'
import { TOP_BAR_PILL, TOP_BAR_TIP } from '../top-bar/pill-style'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentsSummary } from '../chat/chat-widgets'
import { useForYouEntries } from '../chat/for-you-column'
import { useActiveLiveCapture } from '../chat/use-live-capture-dock'
import { toggleForYou, toggleRightPanel } from './side-panel-store'
import { RIGHT_PANEL_ID, useSidePanelState } from './side-panels'

/**
 * The side panel's icon (Liam, 10-19, from a reference: a landscape rounded
 * rectangle with two rows, a dot and a line each, the panel's sections). Not
 * in lucide, so drawn in its grid and stroke (createLucideIcon: 24px box,
 * 2px round strokes), sized and styled like the bar's other icons.
 */
const SidePanelIcon = createLucideIcon('side-panel', [
  // As wide as lucide's Inbox beside Create (20 × 16 of the 24 grid), so it
  // reads the same size as the bar's other icons (Liam, 10-19).
  ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '3', key: 'frame' }],
  ['path', { d: 'M7 10h.01', key: 'dot-1' }],
  ['path', { d: 'M11 10h6', key: 'line-1' }],
  ['path', { d: 'M7 14h.01', key: 'dot-2' }],
  ['path', { d: 'M11 14h6', key: 'line-2' }],
])

export function SidePanelToggle() {
  const state = useSidePanelState()
  const { running } = useAgentsSummary()
  const open = state.rightOpen
  const shortcut = useModKeyLabel('\\')
  const label = ['Side panel', running > 0 ? `${running} running` : null, state.connectionsAttention ? 'a connection needs you' : null].filter(Boolean).join(', ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-side-panel-toggle=""
          aria-expanded={open}
          aria-controls={RIGHT_PANEL_ID}
          aria-label={label}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggleRightPanel()}
          // Plain (white, raised) while the panel is open, shaded while it's
          // closed, as For you's (Liam, 11-09: it looked selected while closed).
          data-lit={open ? undefined : ''}
          className={cn(TOP_BAR_PILL, !open && 'bg-muted text-sidebar-foreground')}
        >
          <SidePanelIcon data-side-panel-icon="" className="h-4 w-4" />
          {running > 0 && (
            <span data-side-panel-running="" className="text-[11px] font-medium tabular-nums">
              {running}
            </span>
          )}
          {state.connectionsAttention && (
            <span data-side-panel-attention="" aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-black" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} collisionPadding={8} avoidCollisions={false} className={TOP_BAR_TIP}>
        <span>Side panel</span>
        <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground">{shortcut}</kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function ForYouToggle() {
  // On screen now (the row's space plan): what the toggle shows and flips.
  const shown = useSidePanelState().leftShown
  const entries = useForYouEntries()
  const capturing = useActiveLiveCapture() !== null
  if (entries.length === 0 || capturing) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-for-you-panel-toggle=""
          aria-expanded={shown}
          aria-label={`For you, ${entries.length}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggleForYou(shown)}
          // Lit while the column is folded away, plain while it shows (Liam,
          // 11-09: "the logic for the button state is backwards, flip it").
          data-lit={shown ? undefined : ''}
          className={cn(TOP_BAR_PILL, !shown && 'bg-muted text-sidebar-foreground')}
        >
          <Home className="h-4 w-4" />
          <span className="text-[11px] font-medium tabular-nums">{entries.length}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} collisionPadding={8} avoidCollisions={false} className={TOP_BAR_TIP}>
        For you
      </TooltipContent>
    </Tooltip>
  )
}
