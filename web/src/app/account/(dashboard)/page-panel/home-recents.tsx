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
 *           Their Drive uploads, coding chats, team chat channels (one row
 *           each), body-edited docs, spreadsheets, canvases and agent
 *           chats too (GET /api/account/recents, migration 713;
 *           docs/plans/recent-panel.md).
 *           In sections by time: Last few minutes, Last hour, This
 *           morning/afternoon/evening (the part of today it is now),
 *           Earlier today, Yesterday, then each day, newest first, an
 *           empty one not drawn (recents-model.ts recentGroupOf).
 *   Pinned  the agent's own chat, first, above every heading and never
 *           filtered (Liam, 11-25: "a pinned chat, your main agent's chat,
 *           so you can easily go back"; docs/plans/one-home.md): one press
 *           is "back to my agent". A new coding chat, while it is the
 *           current chat, is a row under it.
 *   Coding  a coding chat is a row like any other, with the coding icon and
 *           its state (working, needs your answer, waits on your review,
 *           failed); opening it makes it Home's current chat
 *           (chat/current-chat-store.ts): the middle, the box and the right
 *           panel are its. Pressing Code never changes this panel.
 *   Filter  its button at the top, or F while the panel has the focus:
 *           Status (All, Unread: the dot, Read), Type (one per kind the
 *           list has), Reset filters; kept per device (use-recents-filter.ts).
 *           A filter that leaves nothing says so, with Reset filters.
 *   Keys    while it has the focus: J/K and the arrows move between rows,
 *           Enter opens (Shift+Enter too: the app has no split view). With
 *           one of its rows open in front, a step flips it in place: the
 *           next row's card takes its place (Liam, 11-23; openRecent's
 *           `flip`), so the cards never stack.
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
 *           of its own. Home stays selected, whatever opens (Liam, 11-23:
 *           "nothing from the home page should open the full page"; the
 *           frame wears rail/selected-place.ts HUB_PLACE_ATTR): a channel is
 *           that one conversation, a mail thread that thread alone.
 *           The panel persists beside the card (Liam, 11-11:
 *           "I want the panel to persist when you open something, it should
 *           just make room for both things to be open"): another row opens
 *           its card in front in that one's place, as any card opened over
 *           one does.
 *   Lit     the row of the record the card in front shows
 *           (recents-model.ts frontRecentKey): the rail's lit tint,
 *           `aria-current`. Its click does nothing more (it is open).
 *           With nothing in front, the current chat's row; under a card,
 *           that row keeps a thin mark.
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
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Building2, Code2, ListFilter, Plus, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { RECENT_TYPES } from '@/lib/entities/recents-model'
import { openAttachmentById } from '@/components/files/global-file-viewer'
import { openConversation } from '@/lib/chat/open-conversation'
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
import { agentHasUnseenReply, backToAgent, getCurrentChat, newCodingChat, openCodingChat, subscribeCurrentChat, type CurrentChat } from '../chat/current-chat-store'
import { PINNED_AGENT_SUFFIX } from '../chat/one-home-decisions'
import { useCodeView } from '../chat/use-code-view'
import { useCodeForYouEntries } from '../chat/for-you-column'
import { useChatFeed } from '../side-panels/chat-feed'
import { closeFrontCards } from '@/components/chat-cards/front-card'
import { AgentIcon } from '@/components/agents/agent-icon'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { PagePanelFrame } from './page-panel-frame'
import {
  CODE_ROW_STATE_WORDS,
  DEFAULT_RECENT_FILTER,
  RECENTS_PAGE,
  codeChatRowKey,
  filterRecents,
  frontRecentKey,
  groupRecents,
  isDefaultRecentFilter,
  recentTypesPresent,
  shortRecentTime,
  toggleRecentType,
  withLiveCodeChat,
  type RecentFilter,
  type RecentItem,
  type RecentStatus,
} from './recents-model'
import { useRecents } from './use-recents'
import { useRecentsFilter } from './use-recents-filter'
import { keepFocusAfterFlip, useOpenedRow } from './hub-open'
import { setHomeSide, useHomeSide } from './home-side'
import { PanelSwitch } from './panel-switch'
import { setCodingRowsWaiting, useCodingNeedsYou } from './coding-attention'
import { InboxPanel } from './inbox-panel'
import { useInbox } from '@/components/inbox/inbox-store'
import type { PagePanelProps } from './page-panel-types'

/**
 * Open a recent row the way the palette opens a feed row. A Drive file opens
 * in the file viewer (it reads the file under the viewer's own policies
 * again), a coding chat as Home's current chat. False when it names nothing
 * that opens.
 */
export function openRecent(item: Pick<RecentItem, 'type' | 'id' | 'title'>): boolean {
  if (item.type === 'attachment') {
    void openAttachmentById(item.id)
    return true
  }
  if (item.type === 'conversation') {
    // An agent chat of theirs: the one read-only viewer (the main chat is their home thread).
    openConversation(item.id, item.title)
    return true
  }
  if (item.type === 'code_job') {
    // The current chat's one way in: the composer's tab follows it (it stayed on the agent before).
    openCodingChat(item.id, { from: 'recents' })
    return true
  }
  const target = entityOpenTarget(item.type, item.id, item.title)
  // `flip`: it takes the place of the card Recent opened last, never stacking (Liam, 11-23).
  return target ? openTarget(target, { from: 'recents', flip: true }) : false
}

/** Kinds that open a card in front (not a viewer over the page, nor a chat in the middle): the ones J/K flip through. */
const flips = (item: Pick<RecentItem, 'type'>): boolean => item.type !== 'attachment' && item.type !== 'conversation' && item.type !== 'code_job'

/** The rows' buttons in a list, in order (the keyboard's J/K walk them): the pinned agent and a new coding chat's row first, then the records'. */
const rowButtons = (root: HTMLElement | null): HTMLButtonElement[] => (root ? [...root.querySelectorAll<HTMLButtonElement>('button[data-recent-item], button[data-recent-pinned], button[data-recent-provisional]')] : [])

/** Is the key press typing into a field (never a panel key then)? */
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/**
 * Home's panel: Recent | Incoming, whichever chat is current (docs/plans/
 * one-home.md; Liam, 11-25: "you only have one homepage view"). The coding
 * chats are Recent's own rows; pressing Code never changes what is here.
 */
export function HomeRecentsPanel(props: PagePanelProps) {
  const side = useHomeSide()
  const { active, onContent } = props
  // Both sides stay mounted once shown, each holding what it read: a switch
  // shows the other at once, never an empty slot while it reads again
  // (page-panel.tsx's rule). Only the one on screen reads, and only it says
  // what home has to show (home-side.ts; Liam, 11-24).
  const inbox = side === 'inbox'
  const [seenInbox, setSeenInbox] = useState(inbox)
  if (inbox && !seenInbox) setSeenInbox(true)
  const [recents, setRecents] = useState<boolean | null>(null)
  const onRecents = useCallback<PagePanelProps['onContent']>((_page, has) => setRecents(has), [])
  const noop = useCallback<PagePanelProps['onContent']>(() => {}, [])
  // Inbox always has something to show (its filter, its rows or "all caught up").
  const has = inbox ? true : recents
  useEffect(() => {
    onContent('home', has)
  }, [has, onContent])
  return (
    <>
      <RecentsPanel {...props} active={active && !inbox} shown={!inbox} onContent={onRecents} />
      {seenInbox && <InboxPanel {...props} active={active && inbox} shown={inbox} page="home" lead={<HomeSideSwitch />} onContent={noop} />}
    </>
  )
}

const AGENT_CHAT: CurrentChat = { kind: 'agent' }
const serverChat = () => AGENT_CHAT

/** Home's current chat (chat/current-chat-store.ts). */
export function useCurrentChat(): CurrentChat {
  return useSyncExternalStore(subscribeCurrentChat, getCurrentChat, serverChat)
}

/** The pinned row's key, and the provisional row's: never a record's `type:id`. */
export const PINNED_AGENT_KEY = 'agent'
export const NEW_CODING_CHAT_KEY = 'code-new'

const HOME_SIDES = [
  { id: 'recent', label: 'Recent' },
  // Liam, 11-24: he calls it "incoming" (the alternative, "Inbox", in docs/plans/hub-panels.md).
  { id: 'inbox', label: 'Incoming' },
] as const

/**
 * Home's Recent | Incoming (home-side.ts; Liam, 11-24: "the split between
 * recent and notification or incoming in the sub-navigation", as Team chat's
 * All | Recent). Incoming carries a dot while something in it is unread;
 * Recent an orange one while a coding chat needs the person (11-25).
 */
export function HomeSideSwitch() {
  const side = useHomeSide()
  const { data } = useInbox(false)
  const unread = !!data?.items.some((i) => i.unread)
  // A coding chat that needs the person: the orange dot of its row, on the way back to Recent while Incoming shows (coding-attention.ts).
  const coding = useCodingNeedsYou()
  const options = HOME_SIDES.map((o) =>
    o.id === 'inbox'
      ? { ...o, dot: unread && side !== 'inbox' }
      : { ...o, dot: coding && side !== 'recent', dotTone: 'orange' as const, dotWords: 'a coding chat needs you' },
  )
  return <PanelSwitch options={options} value={side} onChange={setHomeSide} label="Show" data="data-home-side" />
}

function RecentsPanel({ active, mode, front, onContent, shown }: PagePanelProps & { shown: boolean }) {
  // The coding chats that wait on the person's review, by their work item (the shell's shared source: no read here).
  const reviews = useCodeForYouEntries()
  const codeReview = useMemo(() => new Set(reviews.map((e) => e.id)), [reviews])
  const { items: read, readAt, markOpened } = useRecents(active, front?.id ?? null, codeReview)
  // The current coding chat's row says what its conversation's reader holds now: no read of the list for it.
  const chat = useCurrentChat()
  const { live } = useCodeView()
  const liveSession = chat.kind === 'code' && live && live.session.id === chat.sessionId ? live.session : null
  const liveKey = liveSession ? `${liveSession.id}|${liveSession.status}|${liveSession.lastSignal ?? ''}|${liveSession.queuedOnMac ? 1 : 0}` : ''
  const all = useMemo(
    () =>
      withLiveCodeChat(
        read,
        liveSession ? { sessionId: liveSession.id, status: liveSession.status, lastSignal: liveSession.lastSignal, queuedOnMac: !!liveSession.queuedOnMac } : null,
        codeReview,
      ) as RecentItem[],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveKey is what the row reads of the session
    [read, liveKey, codeReview],
  )
  const [filter, setFilter] = useRecentsFilter()
  const [filterOpen, setFilterOpen] = useState(false)
  // The record the card in front shows: its row is lit. A card that names no
  // record (team chat on a channel): the row opened for it (hub-open.ts).
  const [openedLit, noteOpened] = useOpenedRow(front?.id ?? null)
  // With nothing in front, the current chat's own row is the one lit: the pinned agent, a coding chat, or the new one.
  const currentKey = chat.kind === 'code' ? codeChatRowKey(chat.sessionId) : chat.kind === 'agent' ? PINNED_AGENT_KEY : NEW_CODING_CHAT_KEY
  const lit = front ? (frontRecentKey(front.spec) ?? openedLit) : currentKey
  // Under a card in front, the current chat's row keeps a thin mark: whose box the composer is.
  const marked = front ? currentKey : null
  // Whether there is anything at all (the filter aside).
  const has = all.length > 0 && readAt !== null
  // Before its first read: not known yet (null), so a page change home holds
  // the last page's panel on screen a moment rather than leave the slot empty
  // (page-panel.tsx; Liam, 11-11: "it goes away completely and reappears").
  // Once read, Home has its panel even with nothing recent: the switch to
  // Inbox is on it (Liam, 11-24).
  const known = readAt !== null
  useEffect(() => {
    onContent('home', known ? true : null)
  }, [known, onContent])

  const items = useMemo(() => filterRecents(all, filter), [all, filter])
  const present = useMemo(() => recentTypesPresent(all), [all])
  // How many coding chats wait on the person, for the way back to Recent while it is off screen (coding-attention.ts).
  const codingWaiting = useMemo(() => all.filter((i) => i.type === 'code_job' && i.needsYou).length, [all])
  useEffect(() => {
    if (readAt) setCodingRowsWaiting(codingWaiting)
  }, [readAt, codingWaiting])
  const [limit, setLimit] = useState(RECENTS_PAGE)
  const windowed = useMemo(() => items.slice(0, limit), [items, limit])
  const groups = useMemo(() => (readAt ? groupRecents(windowed, readAt) : []), [windowed, readAt])
  const fades = useScrollFades<HTMLDivElement>(windowed.length)
  const rest = items.length - windowed.length
  // The rows the keys walk: the list's own content.
  const listRef = fades.contentRef

  if (!shown || !readAt) return null
  const open = (item: RecentItem) => {
    // Already in front: it is open (a second card of it would only stack in the chat).
    if (item.key === lit) {
      markOpened(item)
      return
    }
    // The focus stays on the row (a card's editor would take it as it mounts), so J / K go on flipping.
    const row = typeof document !== 'undefined' ? document.activeElement : null
    if (flips(item) && row instanceof HTMLElement && row.dataset.recentItem === item.key) keepFocusAfterFlip(row)
    if (openRecent(item)) {
      markOpened(item)
      noteOpened(item.key)
    }
  }
  // The panel's keys, while it has the focus (decision 6): J/K and the arrows
  // move between rows, Enter opens (Shift+Enter too: the app has no split),
  // F opens the filter. Never while typing, never with a modifier but Shift.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
    const key = e.key.toLowerCase()
    // S: Home's other side, Inbox (home-side.ts).
    if (key === 's' && !e.shiftKey) {
      e.preventDefault()
      setHomeSide('inbox')
      return
    }
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
    // Something of the list's open in front: the step flips it in place (Liam,
    // 11-23: "so I can flip through the recent things I've looked at"), the
    // next card taking this one's place (openRecent's `flip`). A file or an
    // agent chat (a viewer over the page) is only moved to: Enter opens it.
    // Only with a card in front: with none, the lit row is the current chat's own, and a step only moves.
    if (front && lit !== null && next !== at) {
      const item = windowed.find((i) => i.key === rows[next].dataset.recentItem)
      if (item && flips(item)) open(item)
    }
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
            {/* The agent, pinned (Liam, 11-25: "a pinned chat, your main agent's chat, so you can easily go back"): above every heading, never filtered. */}
            <ul data-recents-pinned="" className="flex flex-col">
              <li>
                <PinnedAgentRow lit={lit === PINNED_AGENT_KEY} marked={marked === PINNED_AGENT_KEY} />
              </li>
              {chat.kind === 'code-new' && (
                <li>
                  <NewCodingChatRow lit={lit === NEW_CODING_CHAT_KEY} marked={marked === NEW_CODING_CHAT_KEY} />
                </li>
              )}
            </ul>
            {!has && (
              <p data-recents-empty="" className="px-2 py-4 text-center text-xs text-muted-foreground">
                What you open and work on shows here.
              </p>
            )}
            {has && groups.length === 0 && (
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
                        <RecentRow item={item} now={readAt} lit={item.key === lit} marked={item.key === marked} onOpen={open} />
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
    <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-2.5">
      {/* Home's Recent | Inbox where "Recent" was (Liam, 11-24), the filter beside it. */}
      <HomeSideSwitch />
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

/** The thin mark of the current chat's row while a card is in front of it. */
const ROW_MARKED = 'shadow-[inset_2px_0_0_0_hsl(var(--foreground)/0.35)]'
const ROW =
  'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none'

/**
 * The agent's own chat, pinned at the top of Recent (docs/plans/one-home.md):
 * one press from anywhere on Home is "back to my agent". Its name and icon
 * (one-home-decisions.ts PINNED_AGENT_SUFFIX). While the person is on another
 * chat: a quiet pulse while it replies, a dot once a reply finished unseen.
 */
function PinnedAgentRow({ lit, marked }: { lit: boolean; marked: boolean }) {
  const { name } = useAssistantName()
  const { busy } = useChatFeed()
  const unseen = useSyncExternalStore(subscribeCurrentChat, agentHasUnseenReply, () => false)
  return (
    <button
      type="button"
      data-recent-pinned={PINNED_AGENT_KEY}
      data-recent-current={marked ? '' : undefined}
      data-recent-working={busy && !lit ? '' : undefined}
      aria-current={lit ? 'true' : undefined}
      onClick={() => {
        // Its chat in front again, whatever page was open over it (as the toggle's agent side).
        closeFrontCards()
        backToAgent({ from: 'recents' })
      }}
      title={`${name}${PINNED_AGENT_SUFFIX}: your agent’s chat`}
      className={cn(ROW, lit ? ROW_LIT : 'hover:bg-muted/60', marked && ROW_MARKED)}
    >
      <span aria-hidden data-recent-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <AgentIcon className={cn('size-4', busy && !lit && 'motion-safe:animate-pulse')} />
      </span>
      <span data-recent-title="" className={cn('min-w-0 flex-1 truncate text-[13px] text-foreground', unseen && 'font-medium')}>
        {name}
        {PINNED_AGENT_SUFFIX}
      </span>
      {busy && !lit && <span className="sr-only">, replying</span>}
      {unseen && (
        <span data-recent-dot="" className="size-1.5 shrink-0 rounded-full bg-primary">
          <span className="sr-only">, replied</span>
        </span>
      )}
    </button>
  )
}

/** The new coding chat, while it is the current chat and nothing is sent: where the person is, in the list. Gone on a send or on leaving. */
function NewCodingChatRow({ lit, marked }: { lit: boolean; marked: boolean }) {
  return (
    <button
      type="button"
      data-recent-provisional={NEW_CODING_CHAT_KEY}
      data-recent-current={marked ? '' : undefined}
      aria-current={lit ? 'true' : undefined}
      onClick={() => newCodingChat({ from: 'recents' })}
      className={cn(ROW, lit ? ROW_LIT : 'hover:bg-muted/60', marked && ROW_MARKED)}
    >
      <span aria-hidden data-recent-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Plus className="size-4" strokeWidth={1.75} />
      </span>
      <span data-recent-title="" className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        New coding chat
      </span>
    </button>
  )
}

function RecentRow({ item, now, lit, marked = false, onOpen }: { item: RecentItem; now: Date; lit: boolean; marked?: boolean; onOpen: (item: RecentItem) => void }) {
  // A coding chat: the coding icon and its state (docs/plans/one-home.md).
  const code = item.type === 'code_job' ? (item.codeState ?? 'done') : null
  const words = code ? CODE_ROW_STATE_WORDS[code] : ''
  return (
    <button
      type="button"
      data-recent-item={item.key}
      data-recent-needs-you={item.needsYou ? '' : undefined}
      data-recent-code={code ?? undefined}
      data-recent-current={marked ? '' : undefined}
      aria-current={lit ? 'true' : undefined}
      onClick={() => onOpen(item)}
      // The whole title (and where it sits, a coding chat's state) for the pointer: the row cuts it to one line.
      title={[item.codeAction, item.title, item.context, words].filter(Boolean).join(' · ')}
      className={cn(ROW, lit ? ROW_LIT : 'hover:bg-muted/60', marked && ROW_MARKED)}
    >
      {/* The glyph alone, no tile (Liam, 11-11), in a fixed slot so the titles line up. */}
      <span aria-hidden data-recent-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {code ? (
          <span className="relative flex items-center justify-center">
            <Code2 data-recent-code-icon="" className={cn('size-4', code === 'working' && 'motion-safe:animate-pulse')} strokeWidth={1.75} />
            {code === 'failed' && <TriangleAlert data-recent-code-failed="" className="absolute -bottom-1 -right-1.5 size-2.5 text-amber-600 dark:text-amber-500" strokeWidth={2.25} />}
          </span>
        ) : (
          <EntityIcon kind={item.type} size="md" fallback={Building2} />
        )}
      </span>
      <span data-recent-title="" className={cn('min-w-0 flex-1 truncate text-[13px] text-foreground', item.needsYou && 'font-medium', code === 'failed' && 'text-muted-foreground')}>
        {/* The action it works, by its identifier: which actions are being worked on. */}
        {item.codeAction && (
          <span data-recent-code-action="" className="mr-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">
            {item.codeAction}
          </span>
        )}
        {item.title}
      </span>
      {code && words && !item.needsYou && <span className="sr-only">, {words}</span>}
      {code === 'queued' && (
        <span data-recent-code-queued="" className="shrink-0 text-[11px] text-muted-foreground">
          Queued
        </span>
      )}
      {item.needsYou && (
        // A coding chat's dot is orange (Liam, 11-20: the Code tab's dot, now on the chat's own row).
        <span data-recent-dot="" className={cn('size-1.5 shrink-0 rounded-full', code ? 'bg-orange-500' : 'bg-primary')}>
          <span className="sr-only">, {code ? words : 'needs you'}</span>
        </span>
      )}
      <time dateTime={item.at} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {shortRecentTime(item.at, now)}
      </time>
    </button>
  )
}
