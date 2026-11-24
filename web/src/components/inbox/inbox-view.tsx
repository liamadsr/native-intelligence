'use client'

/**
 * One inbox (docs/plans/channels-inbox.md, phase 2): what needs the person,
 * in one list, built on what already says so (GET /api/account/inbox,
 * src/lib/inbox). The list, its filter and where the person is in it are one
 * store (./inbox-store.ts), drawn here and, from `md` up, by the Inbox panel
 * beside the rail (app/account/(dashboard)/page-panel/inbox-panel.tsx;
 * Liam, 11-23, Inbox "Like Home"; docs/plans/hub-panels.md).
 *
 *   Panel on screen  (`covered`, the Inbox card full screen with its panel
 *                    beside it): the panel holds the filter and the list, and
 *                    this draws only the item open, alone, or a quiet note
 *                    when none is. The card's header has no filter then: one
 *                    filter, in one place (the header's capsule, Liam, 11-23
 *                    "Into the header", is where the filter goes whenever the
 *                    panel is not there).
 *   Otherwise        the list on the left (its filter in the card's header,
 *                    or a row over it on its own), the item open on the
 *                    right. Below `md` the item takes the whole width.
 *
 * What opens, and how (inbox-store.ts inboxOpen): a team chat item is that
 * conversation alone (TeamChatView `single`), which reads it there (560's
 * mark-read); a mail thread is that thread alone (EmailLayout `single`),
 * never the Mail page; a record over the inbox, in its card (onOpenRecord:
 * the card's RecordOverlay); anything else its own card, as its banner opens
 * it (notification-open.ts).
 *
 * Verbs: Done (E), Hold (H), J / K move (with an item open, J / K open the
 * next one in its place), Enter or O opens, Esc closes the item. For you's
 * cards stay in For you: one row says how many wait there and opens it.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { AtSign, Bell, Check, Clock, Inbox as InboxIcon, Mail, MessagesSquare, Sparkles, Undo2, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/work/presentation'
import { TeamChatView } from '@/app/account/(dashboard)/views/team-chat-view'
import { EmailLayout, type MailCardOptions } from '@/components/email/email-layout'
import { setRightPanelOpen, setSidePanelView } from '@/app/account/(dashboard)/side-panels/side-panel-store'
import { HOLD_CHOICES, INBOX_FILTERS, holdChoiceLabel, holdUntil, type HoldChoice, type InboxFilter, type InboxItem } from '@/lib/inbox/items'
import type { CardRecordType } from '@/lib/chat-cards/kinds'
import { DETAIL_TAB_ROW, DetailTabs, PAGE_TAB_COUNT, pageTabClass } from '@/components/views/page-tabs'
import { keepFocusAfterFlip } from '@/app/account/(dashboard)/page-panel/hub-open'
import {
  closeInboxItem,
  inboxCounts,
  inboxDone,
  inboxHold,
  inboxMailById,
  inboxOpen,
  inboxOpened,
  inboxRows,
  inboxTitleOf,
  setInboxCursor,
  setInboxFilter,
  useInbox,
  type InboxState,
} from './inbox-store'

export const FILTER_LABELS: Record<InboxFilter, string> = {
  all: 'All',
  messages: 'Messages',
  mentions: 'Mentions & assignments',
  mail: 'Mail',
  held: 'Held',
}
/** In the panel, or the list beside an open item, where room is short: the long one shortened (its full name is the tooltip). */
const SHORT_LABELS: Partial<Record<InboxFilter, string>> = { mentions: 'Mentions' }

/** The keys' hint under the list. */
export const INBOX_KEYS_HINT = 'J / K to move · Enter to open · E done · H hold until tomorrow'

function typing(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"]')
}

function ItemIcon({ item }: { item: InboxItem }) {
  const Icon = item.source === 'mail' ? Mail : item.category === 'messages' ? MessagesSquare : item.category === 'mentions' ? AtSign : Bell
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

type OpenOpts = Parameters<typeof inboxOpen>[1]

/**
 * The list's keys (src/lib/shortcuts.ts, scope inbox), for whichever draws
 * the list: J / K move (with an item open, the next one opens in its place),
 * Enter or O opens, E done, H hold until tomorrow (Held: brings it back),
 * Esc closes the item. Never from a field, a menu, a dialog, or the item's
 * own pane (`[data-inbox-pane]`: the conversation's and the thread's keys
 * are their own), nor the filter (`[data-inbox-filters]`: its Enter presses
 * it, and e or h would settle a row), nor a control portalled out of
 * `e.currentTarget` (the card header's: the conversation's Copy invite link,
 * call, bell).
 */
export function inboxKeyDown(e: KeyboardEvent<HTMLElement>, s: InboxState, opts: OpenOpts = {}): void {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
  const inHeader = !e.currentTarget.contains(e.target as Node)
  if (inHeader || (e.target as Element).closest?.('[data-inbox-pane], [data-inbox-filters]')) {
    if (e.key === 'Escape' && s.openKey) {
      e.preventDefault()
      closeInboxItem()
    }
    return
  }
  const rows = inboxRows(s)
  const cursor = Math.min(s.cursor, Math.max(0, rows.length - 1))
  const current = rows[cursor] ?? null
  const key = e.key.toLowerCase()
  if (key === 'j' || e.key === 'ArrowDown' || key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = Math.max(0, Math.min(rows.length - 1, cursor + (key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))
    setInboxCursor(next)
    // An item open: the next one opens in its place (flipping, Liam, 11-23),
    // the focus kept in the list (the conversation's composer would take it).
    if (s.openKey && next !== cursor && rows[next]) {
      if (e.target instanceof HTMLElement) keepFocusAfterFlip(e.target)
      void inboxOpen(rows[next], opts)
    }
  } else if ((e.key === 'Enter' || key === 'o') && current) {
    e.preventDefault()
    void inboxOpen(current, opts)
  } else if (key === 'e' && current && s.filter !== 'held') {
    e.preventDefault()
    void inboxDone(current)
  } else if (key === 'h' && current) {
    e.preventDefault()
    void inboxHold(current, s.filter === 'held' ? null : holdUntil('tomorrow'))
  } else if (e.key === 'Escape' && s.openKey) {
    e.preventDefault()
    closeInboxItem()
  }
}

/**
 * The filter, in the pill every page's tabs wear (components/views/page-tabs.tsx; Liam, 11-23: "can you make
 * sure it's updated everywhere? and everything looks the same as the projects page"): the page's first row,
 * from the card's corner (`row`), or in the panel beside the rail, where room is short, pills that wrap with
 * the long one shortened (`panel`, its full name the tooltip). Never in the card's header.
 */
export function InboxFilters({ s, variant, narrow = false }: { s: InboxState; variant: 'panel' | 'row'; narrow?: boolean }) {
  const counts = useMemo(() => inboxCounts(s.data), [s.data])
  if (variant === 'row') {
    // Narrow (the list beside an open item, 22rem): the long one shortened and the pills onto a second line, so
    // Mail and Held stay in reach (a review, 11-23: scrolled sideways, they sat out of sight).
    return (
      <div className={cn(DETAIL_TAB_ROW, narrow && 'h-auto min-h-12 py-2.5')}>
        <DetailTabs
          label="Show"
          data-inbox-filters="page"
          inline
          wrap={narrow}
          tabs={INBOX_FILTERS.map((f) => ({
            id: f,
            label: narrow ? (SHORT_LABELS[f] ?? FILTER_LABELS[f]) : FILTER_LABELS[f],
            title: FILTER_LABELS[f],
            count: counts[f],
            data: { 'data-inbox-filter': f },
          }))}
          value={s.filter}
          onChange={setInboxFilter}
        />
      </div>
    )
  }
  return (
    <div role="tablist" aria-label="Show" data-inbox-filters="panel" className="flex flex-wrap gap-1">
      {INBOX_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          aria-selected={s.filter === f}
          data-inbox-filter={f}
          title={FILTER_LABELS[f]}
          onClick={() => setInboxFilter(f)}
          className={pageTabClass(s.filter === f)}
        >
          {SHORT_LABELS[f] ?? FILTER_LABELS[f]}
          {counts[f] > 0 && <span className={PAGE_TAB_COUNT}>{counts[f]}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * The rows (the card's list and the panel's: one list, Liam, 11-23), with
 * For you's row, the loading and empty notes. `lit`: the row whose item is
 * open beside the list.
 */
export function InboxList({ s, forYouCount = 0, opts = {}, dense = false }: { s: InboxState; forYouCount?: number; opts?: OpenOpts; dense?: boolean }) {
  const rows = useMemo(() => inboxRows(s), [s])
  const mailById = useMemo(() => inboxMailById(s.data), [s.data, s.headers]) // eslint-disable-line react-hooks/exhaustive-deps -- headers: the live subjects arrived
  const cursor = Math.min(s.cursor, Math.max(0, rows.length - 1))
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (s.cursor > 0 && s.cursor >= rows.length) setInboxCursor(Math.max(0, rows.length - 1))
  }, [rows.length, s.cursor])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-inbox-row-index="${cursor}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor])
  return (
    <>
      {forYouCount > 0 && s.filter === 'all' && (
        <button
          type="button"
          data-inbox-for-you=""
          onClick={() => {
            setSidePanelView('forYou')
            setRightPanelOpen(true)
          }}
          className={cn('mb-1 flex w-full items-center gap-2.5 rounded-xl text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground', dense ? 'px-2 py-1.5 text-[13px]' : 'px-3 py-2 text-sm')}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {forYouCount} {forYouCount === 1 ? 'thing' : 'things'} from your agent, in For you
          </span>
        </button>
      )}
      {s.data === null ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{s.failed ? 'The inbox could not be read. It tries again in a minute.' : 'Loading…'}</p>
      ) : rows.length === 0 ? (
        <div className={cn('flex flex-col items-center gap-2 text-center', dense ? 'py-8' : 'py-16')} data-inbox-empty="">
          <InboxIcon className="h-7 w-7 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">{s.filter === 'held' ? 'Nothing held for later.' : 'Nothing needs you. You’re all caught up.'}</p>
        </div>
      ) : (
        <ul ref={listRef}>
          {rows.map((item, i) => {
            const { title, body } = inboxTitleOf(item, mailById)
            const active = i === cursor
            const lit = s.openKey === item.key
            return (
              <li key={item.key}>
                <div
                  role="option"
                  aria-selected={active}
                  aria-current={lit ? 'true' : undefined}
                  data-inbox-row={item.key}
                  data-inbox-row-index={i}
                  data-unread={item.unread ? '' : undefined}
                  onClick={(e) => {
                    setInboxCursor(i)
                    // The keys stay with the list (the conversation's composer would take them), so J / K flip on.
                    const list = e.currentTarget.closest<HTMLElement>('[data-inbox-list]')
                    if (list) {
                      list.focus({ preventScroll: true })
                      keepFocusAfterFlip(list)
                    }
                    void inboxOpen(item, opts)
                  }}
                  className={cn(
                    'group flex cursor-pointer items-start rounded-xl',
                    dense ? 'gap-2 px-2 py-1.5' : 'gap-2.5 px-3 py-2',
                    lit ? 'bg-foreground/[0.08]' : active ? 'bg-accent' : 'hover:bg-accent/50',
                    lit && active && 'ring-1 ring-inset ring-foreground/15',
                  )}
                >
                  <span className="mt-1 w-1.5 shrink-0" aria-hidden>
                    {item.unread && <span className="block size-1.5 rounded-full bg-primary" />}
                  </span>
                  <ItemIcon item={item} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('flex items-baseline gap-1.5', dense ? 'text-[13px]' : 'text-sm', item.unread ? 'font-semibold text-foreground' : 'text-foreground/90')}>
                      <span className="min-w-0 truncate">{title}</span>
                      {item.count > 1 && <span className="shrink-0 text-xs font-normal text-muted-foreground">{item.count}</span>}
                    </span>
                    {body && <span className="block truncate text-xs text-muted-foreground">{body}</span>}
                    {item.heldUntil && (
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" /> Back {new Date(item.heldUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground group-hover:hidden">{relativeTime(item.at)}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                    {s.filter === 'held' ? (
                      <button type="button" data-inbox-unhold="" title="Bring back now" aria-label="Bring back now" onClick={() => void inboxHold(item, null)} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground">
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <>
                        <HoldMenu onPick={(choice) => void inboxHold(item, holdUntil(choice))} />
                        <button type="button" data-inbox-done="" title="Done (E)" aria-label="Done" onClick={() => void inboxDone(item)} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground">
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/** A mail thread alone, in the pane (EmailLayout's `single`): never the Mail page's list and reader. */
function InboxMailThread({ threadId }: { threadId: string }) {
  const card = useMemo<MailCardOptions>(() => ({ initial: { folder: 'inbox', search: '', accounts: null, threadId }, fullScreen: true, single: true }), [threadId])
  return <EmailLayout card={card} />
}

/** The item open: just that item (a conversation, a mail thread), with Close. */
function InboxPane({ item, children }: { item: InboxItem; children?: ReactNode }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-inbox-pane="" data-inbox-pane-kind={item.open.kind}>
      <button
        type="button"
        onClick={closeInboxItem}
        aria-label="Close"
        title="Close (Esc)"
        className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      {item.open.kind === 'team_chat' ? (
        <TeamChatView key={item.key} compact single focus={{ type: 'message', id: item.open.messageId }} />
      ) : item.open.kind === 'mail' ? (
        <InboxMailThread key={item.key} threadId={item.open.providerThreadId} />
      ) : null}
      {children}
    </div>
  )
}

export function InboxView({
  forYouCount = 0,
  onOpenRecord,
  covered = false,
  onBeside,
}: {
  /** How many of For you's cards wait (its own list, opened from one row here). */
  forYouCount?: number
  /** Open a record over the inbox, in its card (the page card's RecordOverlay). Absent: its own card. */
  onOpenRecord?: (record: { type: CardRecordType; id: string; label?: string }) => void
  /** The Inbox panel beside the rail holds the filter and the list: only the item open here (docs/plans/hub-panels.md). */
  covered?: boolean
  /** Bring this card in front (an item opened from the panel while another card is). */
  onBeside?: () => void
}) {
  const s = useInbox(true)
  const opts = useMemo(() => ({ onOpenRecord, beside: onBeside }), [onOpenRecord, onBeside])
  const opened = inboxOpened(s)
  const pane = opened && (opened.open.kind === 'team_chat' || opened.open.kind === 'mail') ? opened : null

  if (covered) {
    const waiting = s.data?.items.length ?? 0
    return (
      <div className="flex h-full min-h-0" data-inbox-view="" data-inbox-covered="" onKeyDown={(e) => inboxKeyDown(e, s, opts)} tabIndex={-1}>
        {pane ? (
          <InboxPane item={pane} />
        ) : (
          // Nothing open: a quiet note, the list being the panel's (docs/plans/hub-panels.md, decision 2).
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-inbox-none-open="">
            <InboxIcon className="h-7 w-7 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {s.data === null ? 'Loading…' : waiting === 0 ? 'Nothing needs you. You’re all caught up.' : 'Open something from the list to see it here.'}
            </p>
            {waiting > 0 && <p className="text-[11px] text-muted-foreground">{INBOX_KEYS_HINT}</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-inbox-view="" onKeyDown={(e) => inboxKeyDown(e, s, opts)} tabIndex={-1}>
      <div className={cn('flex min-h-0 flex-col', pane ? 'hidden w-[22rem] shrink-0 md:flex' : 'flex-1')}>
        {/* The page's first row, from the card's corner; narrowed beside an open conversation, the pills scroll. */}
        <InboxFilters s={s} variant="row" narrow={!!pane} />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" role="listbox" aria-label="Inbox" tabIndex={0} data-inbox-list="">
          <InboxList s={s} forYouCount={forYouCount} opts={opts} />
        </div>
        <p className="hidden shrink-0 px-4 pb-2 text-[11px] text-muted-foreground md:block">{INBOX_KEYS_HINT}</p>
      </div>
      {pane && <InboxPane item={pane} />}
    </div>
  )
}

function HoldMenu({ onPick }: { onPick: (choice: HoldChoice) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-inbox-hold="" title="Hold for later (H)" aria-label="Hold for later" className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground">
          <Clock className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Hold until</p>
        {HOLD_CHOICES.map((choice) => (
          <DropdownMenuItem key={choice} data-inbox-hold-option={choice} onSelect={() => onPick(choice)}>
            {holdChoiceLabel(choice)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
