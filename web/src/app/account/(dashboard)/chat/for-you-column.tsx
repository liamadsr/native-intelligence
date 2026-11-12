'use client'

/**
 * For you: the cards the bots bring you (docs/plans/always-on-agent.md,
 * decision 13; Liam, 2026-10-14: "lay them out really nicely in a scrollable
 * view… keep them in both places"). The suggested actions, drafts to review
 * and questions stay in the bots and also stand here, newest first, so you
 * can settle one without opening its bot. One store, so settling it in
 * either place clears it from both.
 *
 * One of the right side panel's two views (side-panels/side-panels.tsx;
 * Liam, 11-11: "move the for you cards to the right hand side panel then you
 * should be able to switch between the agent browser and context cards and
 * the for you cards but you can't see both at the same time"):
 *
 *   Button   "For you" (an inbox and the count) in the top bar's right
 *            header, beside the side panel's own (side-panel-toggles.tsx):
 *            it opens the panel on these cards, or closes it while they show.
 *   Where    the panel's 360px, under the top bar; it slides in and out as
 *            the panel does, and swaps in place with the sections, no motion.
 *   When     only with cards to show: with nothing waiting, no button and
 *            no view (the panel saved on For you waits off screen and comes
 *            back with the next card).
 *   What     forYouColumnEntries over the shell's shared source
 *            (AgentWorkProvider): no fetch or channel of its own. The cards
 *            draw from a module fetched the first time they show
 *            (for-you-column-panel.tsx), and stay mounted while the panel is
 *            closed or on its sections.
 */
import { useMemo, type CSSProperties } from 'react'
import { useOptionalAgentWorkShared, type AgentWorkShared } from '@/components/work/agent-work-provider'
import { forYouColumnEntries, type ColumnEntry } from '@/lib/bots/for-you-column'
import { lazyComponent } from '@/lib/lazy-component'
import { useAgentDrafts } from '@/hooks/use-agent-drafts'

const ForYouColumnPanel = lazyComponent(() => import('@/components/attention/for-you-column-panel').then((m) => m.ForYouColumnPanel))

const NO_ENTRIES: readonly ColumnEntry[] = []

/** The cards fill the view's box: the panel's width, down to its bottom (then they scroll). */
const PANEL_STYLE: CSSProperties = { left: 0, top: 0, width: '100%', maxHeight: '100%' }

/** What the bots bring you now, newest first: For you's cards and its button's count. */
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

/**
 * The panel's For you view: the cards, filling the box the panel gives it
 * (side-panels.tsx places, shows and hides it). Nothing while there is
 * nothing to show.
 */
export function ForYouView({ entries, shared }: { entries: readonly ColumnEntry[]; shared: AgentWorkShared }) {
  if (entries.length === 0) return null
  return <ForYouColumnPanel entries={entries} shared={shared} style={PANEL_STYLE} />
}
