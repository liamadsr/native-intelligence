'use client'

/**
 * The home page's panel: recents (Liam, 11-11: "a floating panel next to the
 * navigation that's going to show you all the recent pages, docs, chats, or
 * anything else that needs your attention"), in the app's own look (Liam:
 * "We want to keep our layout and styles… I like our app more").
 *
 *   What    one list, newest first, each record once (recents-model.ts):
 *           what came to the person (assigned, @-mentioned, shared with
 *           them) and what they touched themselves, docs, actions,
 *           projects, captures, contacts, deals, team chat's messages.
 *           In sections by day (Liam, 11-11: "break it by sections so you
 *           see today, yesterday.."): This evening, This afternoon, This
 *           morning, Yesterday, Last 7 days, Last 30 days, Older, newest
 *           first, an empty one not drawn (recents-model.ts recentGroupOf).
 *           Each section reads as its own block in the one card: a row's
 *           height of space before the next one's small muted heading,
 *           a little room under it. What came to them carries a dot until
 *           they open it. The For you cards stay in the right panel;
 *           nothing of theirs is here.
 *   A row   the kind's glyph alone, muted, no tile behind it (Liam, 11-11:
 *           "the icons don't need a white background"; chat/feed-icons.ts,
 *           the palette's) in a fixed-width slot so the titles line up, the
 *           title on one line, and a short time at the right ("2d", "Nov 9").
 *   Open    a click (or Enter on a focused row) opens it exactly as the
 *           palette's Inbox and Recent rows do (entityOpenTarget +
 *           openTarget): a record's card, full screen in the chat as it
 *           opens today; a team chat message, team chat on it. No viewer
 *           of its own. The panel persists beside the card (Liam, 11-11:
 *           "I want the panel to persist when you open something, it should
 *           just make room for both things to be open"): another row opens
 *           its card in front in that one's place, as any card opened over
 *           one does.
 *   Lit     the row of the record the card in front shows
 *           (recents-model.ts frontRecentKey): the rail's lit tint,
 *           `aria-current`. Its click does nothing more (it is open).
 *   Empty   nothing at all: no panel, no empty state (Liam's "hide empty
 *           widgets"), and no button for it in the rail's header.
 *   Corners the card's are 24px (page-panel-frame.tsx; Liam, 11-11: they
 *           didn't match the other panels'), and what it holds follows the
 *           curve: 10px of room above the first heading and under the last
 *           row (or Show more), rows rounded 12px, so no row's tint or
 *           corner meets the card's edge.
 *
 * Flat cost: read as use-recents.ts says (the panel coming on screen, focus
 * while it shows, a card in front closing; no timer), plain rows, at most RECENTS_PAGE mounted until "Show
 * more", no animation. `ph-no-capture`: titles can be private.
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { useScrollFades } from '@/components/attention/scroll-fades'
import { FALLBACK_FEED_ICON, FEED_ICONS } from '../chat/feed-icons'
import { PagePanelFrame } from './page-panel-frame'
import { RECENTS_PAGE, frontRecentKey, groupRecents, shortRecentTime, type RecentItem } from './recents-model'
import { useRecents } from './use-recents'
import type { PagePanelProps } from './page-panel-types'

/** Open a recent row the way the palette opens a feed row. False when it names nothing that opens. */
export function openRecent(item: Pick<RecentItem, 'type' | 'id' | 'title'>): boolean {
  const target = entityOpenTarget(item.type, item.id, item.title)
  return target ? openTarget(target, { from: 'recents' }) : false
}

export function HomeRecentsPanel({ active, mode, front, onContent }: PagePanelProps) {
  const { items, readAt, markOpened } = useRecents(active, front?.id ?? null)
  // The record the card in front shows: its row is lit.
  const lit = frontRecentKey(front?.spec)
  const has = items.length > 0 && readAt !== null
  // Before its first read: not known yet (null), so a page change home holds
  // the last page's panel on screen a moment rather than leave the slot empty
  // (page-panel.tsx; Liam, 11-11: "it goes away completely and reappears").
  const known = readAt !== null
  useEffect(() => {
    onContent('home', known ? has : null)
  }, [known, has, onContent])

  const [limit, setLimit] = useState(RECENTS_PAGE)
  const windowed = useMemo(() => items.slice(0, limit), [items, limit])
  const groups = useMemo(() => (readAt ? groupRecents(windowed, readAt) : []), [windowed, readAt])
  const fades = useScrollFades<HTMLDivElement>(windowed.length)
  const rest = items.length - windowed.length

  if (!has || !readAt) return null
  const open = (item: RecentItem) => {
    // Already in front: it is open (a second card of it would only stack in the chat).
    if (item.key === lit) {
      markOpened(item)
      return
    }
    if (openRecent(item)) markOpened(item)
  }
  return (
    <PagePanelFrame mode={mode} active={active} label="Recent" page="home">
      <div
        ref={fades.scrollerRef}
        onScroll={fades.onScroll}
        data-recents-scroller=""
        data-recents-fades={fades.which}
        className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep [overflow-anchor:none]"
        style={fades.style}
      >
        {/* Sections as blocks (Liam, 11-11): 12px between one's last row and the next heading, plus the heading's own 4px. */}
        <div ref={fades.contentRef} data-recents="" className="ph-no-capture flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.key} data-recents-group={group.key} aria-labelledby={`recents-${group.key}`}>
              <h3 id={`recents-${group.key}`} className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <RecentRow item={item} now={readAt} lit={item.key === lit} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {rest > 0 && (
            <button
              type="button"
              data-recents-more=""
              onClick={() => setLimit((n) => n + RECENTS_PAGE)}
              className="mx-0.5 mb-0.5 inline-flex h-7 items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10"
            >
              Show {Math.min(RECENTS_PAGE, rest)} more
            </button>
          )}
        </div>
      </div>
    </PagePanelFrame>
  )
}

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), for the row whose card is in front. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

function RecentRow({ item, now, lit, onOpen }: { item: RecentItem; now: Date; lit: boolean; onOpen: (item: RecentItem) => void }) {
  const Icon = FEED_ICONS[item.type] ?? FALLBACK_FEED_ICON
  return (
    <button
      type="button"
      data-recent-item={item.key}
      data-recent-needs-you={item.needsYou ? '' : undefined}
      aria-current={lit ? 'true' : undefined}
      onClick={() => onOpen(item)}
      // The whole title (and where it sits) for the pointer: the row cuts it to one line.
      title={item.context ? `${item.title} · ${item.context}` : item.title}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
        lit ? ROW_LIT : 'hover:bg-muted/60',
      )}
    >
      {/* The glyph alone, no tile (Liam, 11-11), in a fixed slot so the titles line up. */}
      <span aria-hidden data-recent-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span data-recent-title="" className={cn('min-w-0 flex-1 truncate text-[13px] text-foreground', item.needsYou && 'font-medium')}>
        {item.title}
      </span>
      {item.needsYou && (
        <span data-recent-dot="" className="size-1.5 shrink-0 rounded-full bg-primary">
          <span className="sr-only">, needs you</span>
        </span>
      )}
      <time dateTime={item.at} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {shortRecentTime(item.at, now)}
      </time>
    </button>
  )
}
