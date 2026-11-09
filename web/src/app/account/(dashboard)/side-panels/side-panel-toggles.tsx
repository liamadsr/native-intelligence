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
import { Inbox, createLucideIcon } from 'lucide-react'
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

/**
 * `pill` (a phone's top bar): the bar's round pill. `header` (the top bar's
 * right header from `md` up, Liam 11-09: Capture and this, as the rail's
 * header on the left): flat and round like that header's buttons, tinted
 * while the panel is open.
 */
export function SidePanelToggle({ variant = 'pill' }: { variant?: 'pill' | 'header' } = {}) {
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
          // The phone's pill: shaded while closed (#36). The header's: tinted while open.
          data-lit={(variant === 'header' ? open : !open) ? '' : undefined}
          data-variant={variant}
          className={
            variant === 'header'
              ? cn(
                  // A 32px circle, as the header's other icon buttons (a pill once it counts agents running).
                  running > 0 ? 'px-2' : 'w-8',
                  'relative flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                  // Tinted while the panel is open, as the rail's lit page (Liam, 11-09: "do the same for this button").
                  open && 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]',
                )
              : cn(TOP_BAR_PILL, !open && 'bg-muted text-sidebar-foreground')
          }
        >
          <SidePanelIcon data-side-panel-icon="" className={variant === 'header' ? 'size-[18px]' : 'h-4 w-4'} strokeWidth={variant === 'header' ? 1.75 : 2} />
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

/**
 * `pill` (a phone's top bar): the bar's round pill. `header` (the app rail's
 * header from `md` up, Liam 11-09: the workspace's thumbnail, then For you,
 * then Search): flat like the header's other buttons, tinted while lit.
 */
export function ForYouToggle({ variant = 'pill' }: { variant?: 'pill' | 'header' } = {}) {
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
          // The top bar's pill (a phone): lit while the column is folded away,
          // plain (its white, raised look) while it shows (Liam, 11-09: "flip
          // it"). The header's: tinted while the column shows, as the bar's
          // lit page is, plain while it's folded (Liam, 11-09: "it's closed
          // but it's highlighted").
          data-lit={(variant === 'header' ? shown : !shown) ? '' : undefined}
          data-variant={variant}
          className={
            variant === 'header'
              ? cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                  shown && 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]',
                )
              : cn(TOP_BAR_PILL, !shown && 'bg-muted text-sidebar-foreground')
          }
        >
          {/* An inbox tray, not a house: Home is the app rail's (Liam, 11-09: "why do I see two home icons?"). */}
          <Inbox data-for-you-icon="" className={variant === 'header' ? 'size-[18px]' : 'h-4 w-4'} strokeWidth={variant === 'header' ? 1.75 : 2} />
          <span className="text-[11px] font-medium tabular-nums">{entries.length}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} collisionPadding={8} avoidCollisions={false} className={TOP_BAR_TIP}>
        For you
      </TooltipContent>
    </Tooltip>
  )
}
