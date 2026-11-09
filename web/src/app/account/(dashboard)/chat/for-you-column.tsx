'use client'

/**
 * The For you column, on the left of the main chat
 * (docs/plans/always-on-agent.md, decision 13; Liam, 2026-10-14: "lay them out
 * really nicely in a scrollable view on the left-hand side… keep them in both
 * places"). The cards the bots bring you (suggested actions, drafts to
 * review, questions) stay in the bots and also stand here, newest first, so
 * you can settle one without opening its bot. One store, so settling it in
 * either place clears it from both.
 *
 * The left half of one system with the right side panel
 * (side-panels/side-panels.tsx; Liam, 10-15: "so that they all fit nicely"):
 *
 *   Toggle   its "For you" button at the top bar's far left
 *            (side-panel-toggles.tsx), the one way to open and fold it (the
 *            column has no pill of its own). Folded is remembered per device.
 *   Motion   it slides in and out on a transform, as the right panel does.
 *   Room     the space plan (side-panels/space-plan.ts) puts it in the free
 *            space beside the chat's content where it fits (the chat does
 *            not move), or moves the content right by just the shortfall
 *            where the chat keeps 640px; narrower it floats over the chat's
 *            left edge, but only once opened by hand this session (never
 *            over the chat unasked).
 *   When     only with cards to show (with nothing waiting, nothing at all:
 *            no column, no toggle), and not while a live capture's notepad
 *            holds the left (live-capture-dock.tsx).
 *   What     forYouColumnEntries over the shell's shared source
 *            (AgentWorkProvider): no fetch or channel of its own. The cards
 *            draw from a module fetched the first time there are any
 *            (for-you-column-panel.tsx), and stay mounted while folded.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'
import { forYouColumnEntries, type ColumnEntry } from '@/lib/bots/for-you-column'
import { lazyComponent } from '@/lib/lazy-component'
import { cn } from '@/lib/utils'
import { useActiveLiveCapture } from './use-live-capture-dock'
import { setForYouContent } from '../side-panels/side-panel-store'
import { FOR_YOU_WIDTH_PX, PANEL_GUTTER_PX, type PanelMode } from '../side-panels/space-plan'
import { PANEL_TOP, SLIDE_CLASS, SLIDE_STYLE, useComposerReserve } from '../side-panels/side-panels'
import { topBarLeftInset } from '../top-bar/insets'
import { useHasTrafficLights } from '@/components/desktop-titlebar'
import { useAgentDrafts } from '@/hooks/use-agent-drafts'

export { FOR_YOU_COLLAPSED_KEY } from '../side-panels/side-panel-store'

const ForYouColumnPanel = lazyComponent(() => import('@/components/attention/for-you-column-panel').then((m) => m.ForYouColumnPanel))

const NO_ENTRIES: readonly ColumnEntry[] = []

/** The cards fill the column's box (its host places the box). */
const PANEL_STYLE: CSSProperties = { left: 0, top: 0, width: '100%', maxHeight: '100%' }

/** What the bots bring you now, newest first: the column's cards and its toggle's count. */
export function useForYouEntries(): readonly ColumnEntry[] {
  const shared = useOptionalAgentWorkShared()
  const work = shared?.work
  const cards = shared?.attention.items
  const counts = shared?.counts
  // The bots' open email drafts, one card each (one shared read: use-agent-drafts.ts).
  const drafts = useAgentDrafts(!!shared)
  return useMemo(
    () =>
      work && cards && counts
        ? forYouColumnEntries({ roster: work.roster, counts, rows: work.rows ?? [], cards, cardRows: work.cardRows, drafts })
        : NO_ENTRIES,
    [work, cards, counts, drafts],
  )
}

export function ForYouColumn({ mode }: { mode: PanelMode }) {
  const shared = useOptionalAgentWorkShared()
  const entries = useForYouEntries()
  // The left is the notepad's while a capture is live.
  const capturing = useActiveLiveCapture() !== null
  const has = entries.length > 0 && !capturing && shared !== null
  useEffect(() => {
    setForYouContent(has)
  }, [has])
  useEffect(() => () => setForYouContent(false), [])

  const open = mode !== 'off' && has
  // Mounted on its first showing, then kept (folded or not) while it has cards.
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  // Floating over the chat: clear of the composer. Beside the content, the
  // composer is clear of it (it is in the content's column).
  const floating = open && mode === 'float'
  const composer = useComposerReserve(floating)
  const bottom = Math.max(PANEL_GUTTER_PX, composer > 0 ? composer + PANEL_GUTTER_PX : 0)
  // Its left edge under its button's (Liam, 11-09: they didn't line up).
  const trafficLights = useHasTrafficLights()

  if (!shared || !mounted || entries.length === 0) return null
  return (
    <aside
      aria-label="For you"
      data-for-you-column-root={mode}
      // No box of its own: a click-through column whose cards, pills and
      // buttons take the pointer themselves (for-you-column-panel.tsx), so its gaps stay the chat's.
      inert={!open}
      aria-hidden={!open || undefined}
      // Over the shell's blur while a card waits as the chat's Reply chip: the card in hand shows where it came from (CARD_REPLY_FOCUS_ATTR).
      className={cn(
        'pointer-events-none absolute z-[25] [html[data-card-reply-focus]_&]:z-[46]',
        SLIDE_CLASS,
        open ? 'visible translate-x-0' : 'invisible -translate-x-[calc(100%+1rem)]',
      )}
      style={{
        ...SLIDE_STYLE,
        top: PANEL_TOP,
        left: topBarLeftInset(trafficLights),
        bottom,
        width: FOR_YOU_WIDTH_PX,
      }}
    >
      {/* Its top-bar toggle slides it out and back. */}
      <ForYouColumnPanel entries={entries} shared={shared} style={PANEL_STYLE} />
    </aside>
  )
}
