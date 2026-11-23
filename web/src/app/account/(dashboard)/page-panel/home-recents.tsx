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
 *           Their Drive uploads and coding jobs too (GET
 *           /api/account/recents; docs/plans/recent-panel.md).
 *           In sections by time: Last few minutes, Last hour, This
 *           morning/afternoon/evening (the part of today it is now),
 *           Earlier today, Yesterday, then each day, newest first, an
 *           empty one not drawn (recents-model.ts recentGroupOf).
 *   Filter  its button at the top, or F while the panel has the focus:
 *           Status (All, Unread: the dot, Read), Type (one per kind the
 *           list has), Reset filters; kept per device (use-recents-filter.ts).
 *           A filter that leaves nothing says so, with Reset filters.
 *   Keys    while it has the focus: J/K and the arrows move between rows,
 *           Enter opens (Shift+Enter too: the app has no split view).
 *           Each section reads as its own block in the one card: a row's
 *           height of space before the next one's small muted heading,
 *           a little room under it. What came to them carries a dot until
 *           they open it. The For you cards stay in the right panel;
 *           nothing of theirs is here.
 *   A row   the kind's glyph alone, in the kind's colour, no tile behind it
 *           (Liam, 11-11: "the icons don't need a white background"; 11-22:
 *           each kind its own identity, <EntityIcon>, the palette's too) in
 *           a fixed-width slot so the titles line up, the
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
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Building2, ListFilter, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { RECENT_TYPES } from '@/lib/entities/recents-model'
import { openAttachmentById } from '@/components/files/global-file-viewer'
import { useScrollFades } from '@/components/attention/scroll-fades'
import { EntityIcon } from '@/components/entities/entity-icon'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSidePanelState } from '../side-panels/side-panels'
import { setCodeView } from '../side-panels/side-panel-store'
import { selectCodeChat } from '../chat/code-view-store'
import { CodeChatsPanel } from './code-chats'
import { PagePanelFrame } from './page-panel-frame'
import {
  DEFAULT_RECENT_FILTER,
  RECENTS_PAGE,
  filterRecents,
  frontRecentKey,
  groupRecents,
  isDefaultRecentFilter,
  recentTypesPresent,
  shortRecentTime,
  toggleRecentType,
  type RecentFilter,
  type RecentItem,
  type RecentStatus,
} from './recents-model'
import { useRecents } from './use-recents'
import { useRecentsFilter } from './use-recents-filter'
import type { PagePanelProps } from './page-panel-types'

/**
 * Open a recent row the way the palette opens a feed row. A Drive file opens
 * in the file viewer (it reads the file under the viewer's own policies
 * again), a coding job in the Code view on it. False when it names nothing
 * that opens.
 */
export function openRecent(item: Pick<RecentItem, 'type' | 'id' | 'title'>): boolean {
  if (item.type === 'attachment') {
    void openAttachmentById(item.id)
    return true
  }
  if (item.type === 'code_job') {
    setCodeView(true)
    selectCodeChat(item.id)
    return true
  }
  const target = entityOpenTarget(item.type, item.id, item.title)
  return target ? openTarget(target, { from: 'recents' }) : false
}

/** The rows' buttons in a list, in order (the keyboard's J/K walk them). */
const rowButtons = (root: HTMLElement | null): HTMLButtonElement[] => (root ? [...root.querySelectorAll<HTMLButtonElement>('button[data-recent-item]')] : [])

/** Is the key press typing into a field (never a panel key then)? */
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/**
 * Home's panel: the recents, or, while the main composer is on Code, the
 * person's coding chats in their place (code-chats.tsx; Liam, 11-16). One or
 * the other is mounted, so only the list on screen reads.
 */
export function HomeRecentsPanel(props: PagePanelProps) {
  const { codeView } = useSidePanelState()
  const { active, onContent } = props
  // Both lists stay mounted once shown, each holding what it read: a switch
  // between the agent's tab and Code shows the other at once, never an empty
  // slot while it reads again (page-panel.tsx's rule). Only the one on
  // screen reads, and only it says what home has to show.
  const [seenCode, setSeenCode] = useState(codeView)
  if (codeView && !seenCode) setSeenCode(true)
  const [content, setContent] = useState<{ recents: boolean | null; code: boolean | null }>({ recents: null, code: null })
  const onRecents = useCallback<PagePanelProps['onContent']>((_page, has) => setContent((c) => (c.recents === has ? c : { ...c, recents: has })), [])
  const onCode = useCallback<PagePanelProps['onContent']>((_page, has) => setContent((c) => (c.code === has ? c : { ...c, code: has })), [])
  const has = codeView ? content.code : content.recents
  useEffect(() => {
    onContent('home', has)
  }, [has, onContent])
  return (
    <>
      <RecentsPanel {...props} active={active && !codeView} shown={!codeView} onContent={onRecents} />
      {seenCode && <CodeChatsPanel {...props} active={active && codeView} shown={codeView} onContent={onCode} />}
    </>
  )
}

function RecentsPanel({ active, mode, front, onContent, shown }: PagePanelProps & { shown: boolean }) {
  const { items: all, readAt, markOpened } = useRecents(active, front?.id ?? null)
  const [filter, setFilter] = useRecentsFilter()
  const [filterOpen, setFilterOpen] = useState(false)
  // The record the card in front shows: its row is lit.
  const lit = frontRecentKey(front?.spec)
  // Whether there is anything at all (the filter aside): no panel when there isn't.
  const has = all.length > 0 && readAt !== null
  // Before its first read: not known yet (null), so a page change home holds
  // the last page's panel on screen a moment rather than leave the slot empty
  // (page-panel.tsx; Liam, 11-11: "it goes away completely and reappears").
  const known = readAt !== null
  useEffect(() => {
    onContent('home', known ? has : null)
  }, [known, has, onContent])

  const items = useMemo(() => filterRecents(all, filter), [all, filter])
  const present = useMemo(() => recentTypesPresent(all), [all])
  const [limit, setLimit] = useState(RECENTS_PAGE)
  const windowed = useMemo(() => items.slice(0, limit), [items, limit])
  const groups = useMemo(() => (readAt ? groupRecents(windowed, readAt) : []), [windowed, readAt])
  const fades = useScrollFades<HTMLDivElement>(windowed.length)
  const rest = items.length - windowed.length
  // The rows the keys walk: the list's own content.
  const listRef = fades.contentRef

  if (!shown || !has || !readAt) return null
  const open = (item: RecentItem) => {
    // Already in front: it is open (a second card of it would only stack in the chat).
    if (item.key === lit) {
      markOpened(item)
      return
    }
    if (openRecent(item)) markOpened(item)
  }
  // The panel's keys, while it has the focus (decision 6): J/K and the arrows
  // move between rows, Enter opens (Shift+Enter too: the app has no split),
  // F opens the filter. Never while typing, never with a modifier but Shift.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
    const key = e.key.toLowerCase()
    if (key === 'f' && !e.shiftKey) {
      e.preventDefault()
      setFilterOpen(true)
      return
    }
    const down = key === 'j' || key === 'arrowdown'
    const up = key === 'k' || key === 'arrowup'
    if (!down && !up) {
      if (key === 'enter' && e.shiftKey && e.target instanceof HTMLButtonElement && e.target.dataset.recentItem !== undefined) {
        e.preventDefault()
        e.target.click()
      }
      return
    }
    if (e.shiftKey) return
    const rows = rowButtons(listRef.current)
    if (!rows.length) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = at < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (down ? 1 : -1)))
    rows[next].focus()
    rows[next].scrollIntoView?.({ block: 'nearest' })
  }
  return (
    <PagePanelFrame mode={mode} active={active} label="Recent" page="home">
      <div onKeyDown={onKeyDown} data-recents-keys="" className="flex min-h-0 flex-col">
        <RecentsFilterBar filter={filter} onFilter={setFilter} present={present} open={filterOpen} onOpenChange={setFilterOpen} />
        <div
          ref={fades.scrollerRef}
          onScroll={fades.onScroll}
          data-recents-scroller=""
          data-recents-fades={fades.which}
          className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-2.5 pt-1 scrollbar-hide-deep [overflow-anchor:none]"
          style={fades.style}
        >
          {/* Sections as blocks (Liam, 11-11): 12px between one's last row and the next heading, plus the heading's own 4px. */}
          <div
            ref={fades.contentRef}
            data-recents=""
            className="ph-no-capture flex flex-col gap-3"
          >
            {groups.length === 0 && (
              <div data-recents-none="" className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs text-muted-foreground">
                <span>Nothing matches these filters.</span>
                <button
                  type="button"
                  onClick={() => setFilter(DEFAULT_RECENT_FILTER)}
                  className="rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Reset filters
                </button>
              </div>
            )}
            {groups.map((group) => {
              const id = `recents-${group.key.replace(/[^a-z0-9-]/gi, '-')}`
              return (
                <section key={group.key} data-recents-group={group.key} aria-labelledby={id}>
                  <h3 id={id} className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
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
              )
            })}
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
      </div>
    </PagePanelFrame>
  )
}

const STATUSES: ReadonlyArray<{ key: RecentStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'read', label: 'Read' },
]

/**
 * The filter's button and menu (F, or a click): Status (the dot: All, Unread,
 * Read), Type (one per kind the list has rows of, and any already chosen),
 * Reset filters. A filter on: the button says how many.
 */
function RecentsFilterBar({
  filter,
  onFilter,
  present,
  open,
  onOpenChange,
}: {
  filter: RecentFilter
  onFilter: (next: RecentFilter) => void
  present: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const on = (filter.status === 'all' ? 0 : 1) + filter.types.length
  const types = RECENT_TYPES.filter((t) => present.includes(t.key) || filter.types.includes(t.key))
  return (
    <div className="flex items-center justify-between px-3.5 pb-0.5 pt-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">Recent</span>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-recents-filter=""
            data-recents-filter-on={on ? String(on) : undefined}
            aria-label={on ? `Filter (${on} on)` : 'Filter'}
            title="Filter (F)"
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              on > 0 && 'text-foreground',
            )}
          >
            <ListFilter aria-hidden className="size-3.5" />
            {on > 0 && <span className="tabular-nums">{on}</span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[min(70vh,28rem)] w-52 overflow-y-auto">
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">Status</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter.status} onValueChange={(v) => onFilter({ ...filter, status: v as RecentStatus })}>
            {STATUSES.map((s) => (
              <DropdownMenuRadioItem key={s.key} value={s.key} data-recents-status={s.key}>
                {s.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {types.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">Type</DropdownMenuLabel>
              {types.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t.key}
                  data-recents-type={t.key}
                  checked={filter.types.includes(t.key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => onFilter(toggleRecentType(filter, t.key))}
                >
                  {t.label}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-recents-reset="" disabled={isDefaultRecentFilter(filter)} onSelect={() => onFilter(DEFAULT_RECENT_FILTER)}>
            Reset filters
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), for the row whose card is in front. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

function RecentRow({ item, now, lit, onOpen }: { item: RecentItem; now: Date; lit: boolean; onOpen: (item: RecentItem) => void }) {
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
        <EntityIcon kind={item.type} size="md" fallback={item.type === 'code_job' ? SquareTerminal : Building2} />
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
