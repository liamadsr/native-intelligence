'use client'

/**
 * Inbox's panel (Liam, 11-23: "the inbox page doesn't have a sub-menu
 * panel"; asked how Inbox should work, "Like Home"; docs/plans/hub-panels.md),
 * since 11-24 Home's Inbox side (Liam: "the combined homepage has what we
 * have in team-chat where we have the split between recent and notification
 * or incoming"): home-recents.tsx draws it under Home's Recent | Inbox
 * switch, as it was in every other way. S goes back to Recent.
 *
 *   What    the inbox's filter (All, Messages, Mentions & assignments,
 *           Mail, Held, with their counts) and its list: the same store and
 *           the same rows as the Inbox card (components/inbox/inbox-store.ts,
 *           inbox-view.tsx InboxList), never a copy. One filter in one place:
 *           while this is on screen the card's header has none
 *           (inbox-card.tsx `covered`).
 *   Open    a click, or Enter, opens just that item beside the panel: a
 *           conversation or a mail thread alone in the Inbox card (brought
 *           in front for it), a record over that card, anything else its
 *           own card (inbox-store.ts inboxOpen). Never the Mail or Team chat
 *           page. Inbox stays selected and lit (the frame wears
 *           rail/selected-place.ts HUB_PLACE_ATTR), the item's row is lit.
 *   Keys    while it has the focus: J / K and the arrows move, and with an
 *           item open flip it in place; Enter or O opens; E done; H hold
 *           until tomorrow (Held: brings it back); Esc closes the item.
 *   Where   only from `md` up, as every page panel (page-panel.tsx); below
 *           it the Inbox card is as it was, its list and filter its own.
 *
 * Flat cost: the store reads the inbox while this is on screen (once a
 * minute and on focus, shared with the card: one read for both).
 */
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { openTarget } from '@/lib/chat-cards/open-card'
import { useForYouEntries } from '../chat/for-you-column'
import { InboxFilters, InboxList, INBOX_KEYS_HINT, inboxKeyDown } from '@/components/inbox/inbox-view'
import { inboxRows, useInbox } from '@/components/inbox/inbox-store'
import { PagePanelFrame } from './page-panel-frame'
import { type PageKey, type PagePanelProps } from './page-panel-types'
import { setHomeSide } from './home-side'

export function InboxPanel({
  active,
  mode,
  front,
  onContent,
  page = 'home',
  shown = true,
  lead,
}: PagePanelProps & {
  /** Whose panel it is: Home's Inbox side (home-recents.tsx; Liam, 11-24). */
  page?: PageKey
  /** On screen (Home is on its Inbox side). */
  shown?: boolean
  /** Over the filter: Home's Recent | Inbox switch. */
  lead?: ReactNode
}) {
  const s = useInbox(active)
  const forYou = useForYouEntries()
  // Its filter and list are always there (loading, rows, or all caught up): something to show from its first commit.
  useLayoutEffect(() => {
    onContent(page, true)
  }, [onContent, page])
  const frontRef = useRef(front)
  frontRef.current = front
  // An item for the Inbox card's pane: that card in front, if another card is (an event the inbox opened).
  const opts = useMemo(
    () => ({
      beside: () => {
        const now = frontRef.current
        if (now && now.spec.kind === 'inbox') return
        openTarget({ type: 'page', slug: 'inbox' }, { from: 'inbox', reuse: true, flip: true })
      },
    }),
    [],
  )
  // Off its side: nothing (the switch swaps the two at once, never a slide).
  if (!shown) return null
  return (
    <PagePanelFrame mode={mode} active={active} label="Inbox" page={page}>
      <div
        data-inbox-panel=""
        className="flex min-h-0 flex-col"
        onKeyDown={(e) => {
          // S: Home's other side, Recent (home-side.ts).
          if (e.key.toLowerCase() === 's' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as Element).closest?.('input, textarea, [contenteditable]')) {
            e.preventDefault()
            setHomeSide('recent')
            return
          }
          inboxKeyDown(e, s, opts)
        }}
      >
        {lead && <div className="flex items-center px-2.5 pt-2.5">{lead}</div>}
        <div className="px-2.5 pb-1.5 pt-2.5">
          <InboxFilters s={s} variant="panel" />
        </div>
        <div
          role="listbox"
          aria-label="Inbox"
          tabIndex={0}
          data-inbox-list="panel"
          className="ph-no-capture min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1 scrollbar-hide-deep focus-visible:outline-none"
        >
          <InboxList s={s} forYouCount={forYou.length} opts={opts} dense />
        </div>
        {/* The keys, while there is something for them. */}
        {inboxRows(s).length > 0 && <p className="shrink-0 px-3.5 pb-2.5 pt-1 text-[10.5px] leading-snug text-muted-foreground">{INBOX_KEYS_HINT}</p>}
      </div>
    </PagePanelFrame>
  )
}
