'use client'

/**
 * One inbox (docs/plans/channels-inbox.md, phase 2): what needs the person,
 * in one list, built on what already says so (GET /api/account/inbox,
 * src/lib/inbox). On the left the list, newest first, with its filters; on
 * the right the item opened in place:
 *
 *   a team chat item   the channel or thread on the message (TeamChatView),
 *                      which reads it there (560's mark-read);
 *   a record           over the inbox, in its card (onOpenRecord: the card's
 *                      RecordOverlay), as a page card opens one;
 *   anything else      its own card, as its banner opens it
 *                      (notification-open.ts), mail on its thread.
 *
 * Verbs: Done (E) archives the item's notifications, or the mail thread as
 * Mail's E does, with Undo; Hold (H) puts it off until a time (it comes back
 * then, or sooner when something new arrives in it); J / K move; Enter or O
 * opens; Esc closes the item. For you's cards stay in For you: one row says
 * how many wait there and opens it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AtSign, Bell, Check, Clock, Inbox as InboxIcon, Mail, MessagesSquare, Sparkles, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/work/presentation'
import { fillHeaders, withCachedHeaders } from '@/lib/email/header-cache'
import { openTarget } from '@/lib/chat-cards/open-card'
import { notificationCardTarget } from '@/app/account/notification-open'
import { resolveNotificationDetailPanel } from '@/app/account/notification-panel'
import { TeamChatView } from '@/app/account/(dashboard)/views/team-chat-view'
import { setRightPanelOpen, setSidePanelView } from '@/app/account/(dashboard)/side-panels/side-panel-store'
import {
  HOLD_CHOICES,
  INBOX_FILTERS,
  filterItems,
  holdChoiceLabel,
  holdUntil,
  type HoldChoice,
  type InboxFilter,
  type InboxItem,
  type InboxMailRow,
} from '@/lib/inbox/items'
import { CARD_RECORD_TYPES, type CardRecordType } from '@/lib/chat-cards/kinds'
import { CardHeaderSlot, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'

type MailRow = InboxMailRow & { provider: string | null; provider_message_id: string | null; folder: string | null; subject?: string | null; snippet?: string | null; from_name?: string | null }

interface InboxData {
  items: InboxItem[]
  held: InboxItem[]
  mail: MailRow[]
}

const FILTER_LABELS: Record<InboxFilter, string> = {
  all: 'All',
  messages: 'Messages',
  mentions: 'Mentions & assignments',
  mail: 'Mail',
  held: 'Held',
}
/** In a card's header, where room is short: the long one shortened until the header is wide (its full name is the tooltip). */
const HEADER_SHORT_LABELS: Partial<Record<InboxFilter, string>> = { mentions: 'Mentions' }

/** How often the list reads itself again while it is on screen. */
const REFRESH_MS = 60_000

function isRecordType(type: string): type is CardRecordType {
  return (CARD_RECORD_TYPES as readonly string[]).includes(type)
}

function typing(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"]')
}

function ItemIcon({ item }: { item: InboxItem }) {
  const Icon = item.source === 'mail' ? Mail : item.category === 'messages' ? MessagesSquare : item.category === 'mentions' ? AtSign : Bell
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

export function InboxView({
  forYouCount = 0,
  onOpenRecord,
}: {
  /** How many of For you's cards wait (its own list, opened from one row here). */
  forYouCount?: number
  /** Open a record over the inbox, in its card (the page card's RecordOverlay). Absent: its own card. */
  onOpenRecord?: (record: { type: CardRecordType; id: string; label?: string }) => void
}) {
  const [data, setData] = useState<InboxData | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<InboxFilter>('all')
  // In a card its filters go up into the card's header (CardHeaderSlot); on their own, a row over the list.
  const inCard = useCardHeaderSlots() !== null
  const [cursor, setCursor] = useState(0)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [, setHeadersTick] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/account/inbox').catch(() => null)
    if (!res?.ok) return setFailed(true)
    const json = (await res.json().catch(() => null)) as InboxData | null
    if (!json) return setFailed(true)
    setFailed(false)
    setData(json)
    // Mail subjects are read live, as Mail reads them (nothing stored).
    if (json.mail.length > 0) void fillHeaders(json.mail).then(() => setHeadersTick((n) => n + 1))
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  // Mail rows with their live headers, by index id.
  const mailById = useMemo(() => new Map(withCachedHeaders(data?.mail ?? []).map((m) => [m.id, m])), [data])
  const rows = useMemo(() => (filter === 'held' ? (data?.held ?? []) : filterItems(data?.items ?? [], filter)), [data, filter])
  const current = rows[Math.min(cursor, Math.max(0, rows.length - 1))] ?? null
  const opened = openKey ? (rows.find((r) => r.key === openKey) ?? data?.items.find((r) => r.key === openKey) ?? null) : null

  useEffect(() => {
    if (cursor > 0 && cursor >= rows.length) setCursor(Math.max(0, rows.length - 1))
  }, [rows.length, cursor])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-inbox-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const titleOf = (item: InboxItem) => {
    if (item.source !== 'mail') return { title: item.title, body: item.body }
    const m = item.open.kind === 'mail' ? mailById.get(item.open.threadIndexId) : undefined
    return { title: m?.from_name?.trim() || item.title, body: m?.subject?.trim() || m?.snippet?.trim() || item.body || 'Mail' }
  }

  // ── The verbs ───────────────────────────────────────────────────────────

  const removeLocally = (key: string) => setData((d) => (d ? { ...d, items: d.items.filter((i) => i.key !== key), held: d.held.filter((i) => i.key !== key) } : d))

  const markRead = (item: InboxItem) => {
    const unread = item.notificationIds
    if (!item.unread || unread.length === 0) return
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.key === item.key ? { ...i, unread: false } : i)) } : d))
    void fetch('/api/account/inbox/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'read', ids: unread.slice(0, 200) }) }).catch(() => null)
  }

  const done = async (item: InboxItem) => {
    removeLocally(item.key)
    if (openKey === item.key) setOpenKey(null)
    let ok = false
    let undo: (() => Promise<unknown>) | null = null
    if (item.source === 'mail' && item.open.kind === 'mail') {
      const threadIds = [item.open.providerThreadId]
      const res = await fetch('/api/account/email/threads/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread_ids: threadIds, change: { archive: true } }) }).catch(() => null)
      ok = !!res?.ok
      undo = () => fetch('/api/account/email/threads/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread_ids: threadIds, change: { archive: false } }) })
    } else {
      const ids = item.notificationIds.slice(0, 200)
      const res = await fetch('/api/account/inbox/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'done', ids }) }).catch(() => null)
      ok = !!res?.ok
      undo = () => fetch('/api/account/inbox/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'undone', ids }) })
    }
    if (!ok) {
      toast.error('That could not be marked done')
      return void load()
    }
    toast.success(item.source === 'mail' ? 'Archived' : 'Done', {
      action: undo ? { label: 'Undo', onClick: () => void undo!().then(() => load()) } : undefined,
    })
  }

  const hold = async (item: InboxItem, until: Date | null) => {
    if (until) removeLocally(item.key)
    const res = await fetch('/api/account/inbox/hold', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item_key: item.key, until: until ? until.toISOString() : null }) }).catch(() => null)
    if (!res?.ok) toast.error(until ? 'That could not be held' : 'That could not be brought back')
    else if (until) toast.success(`Held until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, { action: { label: 'Undo', onClick: () => void hold(item, null) } })
    void load()
  }

  const open = async (item: InboxItem) => {
    markRead(item)
    if (item.open.kind === 'team_chat') return setOpenKey(item.key)
    setOpenKey(null)
    if (item.open.kind === 'mail') {
      return void openTarget({ type: 'mail', folder: 'inbox', threadId: item.open.providerThreadId, title: titleOf(item).body }, { from: 'inbox' })
    }
    if (item.row) {
      const target = await resolveNotificationDetailPanel({ ...item.row, title: item.row.title ?? '', metadata: item.row.metadata ?? undefined })
      if (!target) return
      if (onOpenRecord && isRecordType(target.type)) return onOpenRecord({ type: target.type, id: target.id, label: target.title })
      const card = notificationCardTarget(target)
      if (card) openTarget(card, { from: 'inbox', ...(card.type === 'team_chat' ? { reuse: true } : {}) })
    }
  }

  // ── Keys (src/lib/shortcuts.ts, scope inbox) ────────────────────────────

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
    // Inside the opened conversation, its own keys are its own.
    if ((e.target as Element).closest?.('[data-inbox-pane]')) {
      if (e.key === 'Escape' && openKey) {
        e.preventDefault()
        setOpenKey(null)
      }
      return
    }
    const key = e.key.toLowerCase()
    if (key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(rows.length - 1, c + 1))
      if (openKey && rows[cursor + 1]) void open(rows[cursor + 1])
    } else if (key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      if (openKey && cursor > 0 && rows[cursor - 1]) void open(rows[cursor - 1])
    } else if ((e.key === 'Enter' || key === 'o') && current) {
      e.preventDefault()
      void open(current)
    } else if (key === 'e' && current && filter !== 'held') {
      e.preventDefault()
      void done(current)
    } else if (key === 'h' && current) {
      e.preventDefault()
      void hold(current, filter === 'held' ? null : holdUntil('tomorrow'))
    } else if (e.key === 'Escape' && openKey) {
      e.preventDefault()
      setOpenKey(null)
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const items = data?.items ?? []
    return { all: items.length, messages: filterItems(items, 'messages').length, mentions: filterItems(items, 'mentions').length, mail: filterItems(items, 'mail').length, held: data?.held.length ?? 0 }
  }, [data])

  const choose = (f: InboxFilter) => {
    setFilter(f)
    setCursor(0)
  }

  return (
    <div className="flex h-full min-h-0" data-inbox-view="" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* In a card: the filters in its header, a capsule of segments as Calendar's views are (Liam, 11-23: "Into the header"); the page starts with the list. */}
      {inCard && (
        <CardHeaderSlot side="right">
          <div role="tablist" aria-label="Show" data-inbox-filters="header" className="flex h-6 shrink-0 items-center overflow-hidden rounded-full bg-foreground/[0.05]">
            {INBOX_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                data-inbox-filter={f}
                title={FILTER_LABELS[f]}
                onClick={() => choose(f)}
                className="flex h-full items-center whitespace-nowrap px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-foreground/[0.1] aria-selected:font-medium aria-selected:text-foreground motion-reduce:transition-none"
              >
                {HEADER_SHORT_LABELS[f] ? (
                  <>
                    <span className="@[52rem]:hidden">{HEADER_SHORT_LABELS[f]}</span>
                    <span className="hidden @[52rem]:inline">{FILTER_LABELS[f]}</span>
                  </>
                ) : (
                  FILTER_LABELS[f]
                )}
                {counts[f] > 0 && <span className="ml-1 tabular-nums opacity-60">{counts[f]}</span>}
              </button>
            ))}
          </div>
        </CardHeaderSlot>
      )}
      <div className={cn('flex min-h-0 flex-col', opened ? 'hidden w-[22rem] shrink-0 md:flex' : 'flex-1')}>
        {!inCard && (
          <div className="flex shrink-0 flex-wrap gap-1 px-4 pb-2 pt-3" role="tablist" aria-label="Show">
            {INBOX_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                data-inbox-filter={f}
                onClick={() => choose(f)}
                // As every page's pills (Reviews, Drive): the chosen one tinted, the rest clear (Liam, 11-20: unselected pills are transparent).
                className={cn('h-7 rounded-full px-3 text-xs transition-colors', filter === f ? 'bg-foreground/[0.08] font-medium text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground')}
              >
                {FILTER_LABELS[f]}
                {counts[f] > 0 && <span className="ml-1 tabular-nums opacity-70">{counts[f]}</span>}
              </button>
            ))}
          </div>
        )}
        <div ref={listRef} className={cn('min-h-0 flex-1 overflow-y-auto px-2 pb-4', inCard && 'pt-2')} role="listbox" aria-label="Inbox" tabIndex={0} data-inbox-list="">
          {forYouCount > 0 && filter === 'all' && (
            <button
              type="button"
              data-inbox-for-you=""
              onClick={() => {
                setSidePanelView('forYou')
                setRightPanelOpen(true)
              }}
              className="mb-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                {forYouCount} {forYouCount === 1 ? 'thing' : 'things'} from your agent, in For you
              </span>
            </button>
          )}
          {data === null ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{failed ? 'The inbox could not be read. It tries again in a minute.' : 'Loading…'}</p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center" data-inbox-empty="">
              <InboxIcon className="h-7 w-7 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">{filter === 'held' ? 'Nothing held for later.' : 'Nothing needs you. You’re all caught up.'}</p>
            </div>
          ) : (
            <ul>
              {rows.map((item, i) => {
                const { title, body } = titleOf(item)
                const active = i === cursor
                return (
                  <li key={item.key}>
                    <div
                      role="option"
                      aria-selected={active}
                      data-inbox-row={item.key}
                      data-inbox-row-index={i}
                      data-unread={item.unread ? '' : undefined}
                      onClick={() => {
                        setCursor(i)
                        void open(item)
                      }}
                      className={cn(
                        'group flex cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2',
                        active ? 'bg-accent' : 'hover:bg-accent/50',
                        openKey === item.key && 'ring-1 ring-primary/40',
                      )}
                    >
                      <span className="mt-1 w-1.5 shrink-0" aria-hidden>
                        {item.unread && <span className="block size-1.5 rounded-full bg-primary" />}
                      </span>
                      <ItemIcon item={item} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('flex items-baseline gap-1.5 text-sm', item.unread ? 'font-semibold text-foreground' : 'text-foreground/90')}>
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
                        {filter === 'held' ? (
                          <button type="button" data-inbox-unhold="" title="Bring back now" aria-label="Bring back now" onClick={() => void hold(item, null)} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground">
                            <Undo2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <>
                            <HoldMenu onPick={(choice) => void hold(item, holdUntil(choice))} />
                            <button type="button" data-inbox-done="" title="Done (E)" aria-label="Done" onClick={() => void done(item)} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground">
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
        </div>
        <p className="hidden shrink-0 px-4 pb-2 text-[11px] text-muted-foreground md:block">J / K to move · Enter to open · E done · H hold until tomorrow</p>
      </div>
      {opened && opened.open.kind === 'team_chat' && (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-inbox-pane="">
          <button
            type="button"
            onClick={() => setOpenKey(null)}
            aria-label="Close"
            title="Close (Esc)"
            className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
          <TeamChatView key={opened.key} compact focus={{ type: 'message', id: opened.open.messageId }} />
        </div>
      )}
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
