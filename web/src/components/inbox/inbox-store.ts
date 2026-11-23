'use client'

/**
 * The inbox's one list and where the person is in it (docs/plans/hub-panels.md;
 * Liam, 11-23, Inbox "Like Home"): shared by the Inbox card
 * (./inbox-view.tsx, the page's card) and the Inbox panel beside the rail
 * (app/account/(dashboard)/page-panel/inbox-panel.tsx), so the filter, the
 * row the keys are on and the item open are one, whichever draws the list.
 *
 *   data      GET /api/account/inbox, read while something on screen uses
 *             it (`useInbox(true)`): at once, every REFRESH_MS, and on the
 *             window's focus. Mail subjects are read live (fillHeaders), as
 *             Mail reads them; nothing is stored.
 *   filter    All, Messages, Mentions & assignments, Mail, Held: one filter,
 *             in one place on screen (the panel's, or the card's header).
 *   cursor    the row J / K are on.
 *   openKey   the item open beside the list (a conversation, a mail thread),
 *             drawn by the Inbox card.
 *   record    a record to open over the Inbox card (its RecordOverlay),
 *             asked by whichever list opened it, taken by the card.
 *
 * Verbs: Done (E) archives the item's notifications, or the mail thread as
 * Mail's E does, with Undo; Hold (H) puts it off until a time.
 *
 * With nothing subscribed at all, it is forgotten (a test, a sign-out): the
 * next one reads afresh. Flat cost: one read a minute while on screen.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { fillHeaders, withCachedHeaders } from '@/lib/email/header-cache'
import { openTarget } from '@/lib/chat-cards/open-card'
import { notificationCardTarget } from '@/app/account/notification-open'
import { resolveNotificationDetailPanel } from '@/app/account/notification-panel'
import { filterItems, type InboxFilter, type InboxItem, type InboxMailRow } from '@/lib/inbox/items'
import { CARD_RECORD_TYPES, type CardRecordType } from '@/lib/chat-cards/kinds'

export type InboxMail = InboxMailRow & {
  provider: string | null
  provider_message_id: string | null
  folder: string | null
  subject?: string | null
  snippet?: string | null
  from_name?: string | null
}

export interface InboxData {
  items: InboxItem[]
  held: InboxItem[]
  mail: InboxMail[]
}

export interface InboxRecordAsk {
  type: CardRecordType
  id: string
  label?: string
  /** Bumped per ask: the same record asked twice opens twice. */
  n: number
}

export interface InboxState {
  data: InboxData | null
  failed: boolean
  filter: InboxFilter
  cursor: number
  openKey: string | null
  record: InboxRecordAsk | null
  /** Bumped when live mail headers arrive. */
  headers: number
}

/** How often the list reads itself again while it is on screen. */
export const REFRESH_MS = 60_000

const INITIAL: InboxState = { data: null, failed: false, filter: 'all', cursor: 0, openKey: null, record: null, headers: 0 }

let state: InboxState = INITIAL
const listeners = new Set<() => void>()
let readers = 0
let stopReading: (() => void) | null = null
let recordAsks = 0

function set(patch: Partial<InboxState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function inboxState(): InboxState {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // Nothing uses it any more: forgotten, read afresh next time.
    if (!listeners.size && !readers) state = INITIAL
  }
}

export async function loadInbox(): Promise<void> {
  const res = await fetch('/api/account/inbox').catch(() => null)
  if (!res?.ok) return set({ failed: true })
  const json = (await res.json().catch(() => null)) as InboxData | null
  if (!json) return set({ failed: true })
  set({ failed: false, data: json })
  if (json.mail.length > 0) void fillHeaders(json.mail).then(() => set({ headers: state.headers + 1 }))
}

function startReading(): () => void {
  void loadInbox()
  const timer = setInterval(() => void loadInbox(), REFRESH_MS)
  const onFocus = () => void loadInbox()
  window.addEventListener('focus', onFocus)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', onFocus)
  }
}

/** The inbox's state; `reading`: it is on screen here, so keep it read. */
export function useInbox(reading: boolean): InboxState {
  useEffect(() => {
    if (!reading) return
    readers += 1
    if (readers === 1) stopReading = startReading()
    return () => {
      readers -= 1
      if (readers === 0) {
        stopReading?.()
        stopReading = null
      }
    }
  }, [reading])
  return useSyncExternalStore(subscribe, inboxState, () => INITIAL)
}

// ── What the list shows ──────────────────────────────────────────────────

/** The rows under the filter. */
export function inboxRows(s: Pick<InboxState, 'data' | 'filter'>): InboxItem[] {
  return s.filter === 'held' ? (s.data?.held ?? []) : filterItems(s.data?.items ?? [], s.filter)
}

/** How many rows each filter has. */
export function inboxCounts(data: InboxData | null): Record<InboxFilter, number> {
  const items = data?.items ?? []
  return { all: items.length, messages: filterItems(items, 'messages').length, mentions: filterItems(items, 'mentions').length, mail: filterItems(items, 'mail').length, held: data?.held.length ?? 0 }
}

/** Mail rows with their live headers, by index id. */
export function inboxMailById(data: InboxData | null): Map<string, InboxMail> {
  return new Map(withCachedHeaders(data?.mail ?? []).map((m) => [m.id, m]))
}

/** A row's title and line: a mail row's sender and subject (live), else the notification's. */
export function inboxTitleOf(item: InboxItem, mailById: ReadonlyMap<string, InboxMail>): { title: string; body: string | null } {
  if (item.source !== 'mail') return { title: item.title, body: item.body }
  const m = item.open.kind === 'mail' ? mailById.get(item.open.threadIndexId) : undefined
  return { title: m?.from_name?.trim() || item.title, body: m?.subject?.trim() || m?.snippet?.trim() || item.body || 'Mail' }
}

/** The item open beside the list, if it is still in it. */
export function inboxOpened(s: Pick<InboxState, 'data' | 'filter' | 'openKey'>): InboxItem | null {
  if (!s.openKey) return null
  return inboxRows(s).find((r) => r.key === s.openKey) ?? s.data?.items.find((r) => r.key === s.openKey) ?? null
}

// ── Moves ────────────────────────────────────────────────────────────────

export function setInboxFilter(filter: InboxFilter): void {
  set({ filter, cursor: 0 })
}

export function setInboxCursor(cursor: number): void {
  if (cursor !== state.cursor) set({ cursor })
}

export function closeInboxItem(): void {
  if (state.openKey !== null) set({ openKey: null })
}

/** The card took the record it was asked to open. */
export function takeInboxRecord(): void {
  if (state.record) set({ record: null })
}

function isRecordType(type: string): type is CardRecordType {
  return (CARD_RECORD_TYPES as readonly string[]).includes(type)
}

// ── The verbs ────────────────────────────────────────────────────────────

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function removeLocally(key: string): void {
  const d = state.data
  if (d) set({ data: { ...d, items: d.items.filter((i) => i.key !== key), held: d.held.filter((i) => i.key !== key) } })
}

function markRead(item: InboxItem): void {
  const unread = item.notificationIds
  if (!item.unread || unread.length === 0) return
  const d = state.data
  if (d) set({ data: { ...d, items: d.items.map((i) => (i.key === item.key ? { ...i, unread: false } : i)) } })
  void post('/api/account/inbox/notifications', { action: 'read', ids: unread.slice(0, 200) }).catch(() => null)
}

export async function inboxDone(item: InboxItem): Promise<void> {
  removeLocally(item.key)
  if (state.openKey === item.key) set({ openKey: null })
  let ok = false
  let undo: (() => Promise<unknown>) | null = null
  if (item.source === 'mail' && item.open.kind === 'mail') {
    const threadIds = [item.open.providerThreadId]
    const res = await post('/api/account/email/threads/triage', { thread_ids: threadIds, change: { archive: true } }).catch(() => null)
    ok = !!res?.ok
    undo = () => post('/api/account/email/threads/triage', { thread_ids: threadIds, change: { archive: false } })
  } else {
    const ids = item.notificationIds.slice(0, 200)
    const res = await post('/api/account/inbox/notifications', { action: 'done', ids }).catch(() => null)
    ok = !!res?.ok
    undo = () => post('/api/account/inbox/notifications', { action: 'undone', ids })
  }
  if (!ok) {
    toast.error('That could not be marked done')
    return void loadInbox()
  }
  toast.success(item.source === 'mail' ? 'Archived' : 'Done', {
    action: undo ? { label: 'Undo', onClick: () => void undo!().then(() => loadInbox()) } : undefined,
  })
}

export async function inboxHold(item: InboxItem, until: Date | null): Promise<void> {
  if (until) removeLocally(item.key)
  const res = await post('/api/account/inbox/hold', { item_key: item.key, until: until ? until.toISOString() : null }).catch(() => null)
  if (!res?.ok) toast.error(until ? 'That could not be held' : 'That could not be brought back')
  else if (until) toast.success(`Held until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, { action: { label: 'Undo', onClick: () => void inboxHold(item, null) } })
  void loadInbox()
}

/**
 * Open an item: just that item, beside the list (Liam, 11-23: "Clicking a
 * notification opens just that item beside the list"). A conversation or a
 * mail thread opens in the Inbox card's pane (`openKey`), never the Team
 * chat or Mail page; a record over the Inbox card (`record`); anything else
 * (an event, a flow…) its own card in front, which takes the place of one
 * the inbox opened before (`flip`). `beside`: the list is the panel's, so
 * the Inbox card is brought in front for the pane.
 */
export async function inboxOpen(item: InboxItem, opts: { beside?: () => void; onOpenRecord?: (record: { type: CardRecordType; id: string; label?: string }) => void } = {}): Promise<void> {
  markRead(item)
  if (item.open.kind === 'team_chat' || item.open.kind === 'mail') {
    set({ openKey: item.key })
    opts.beside?.()
    return
  }
  set({ openKey: null })
  if (!item.row) return
  const target = await resolveNotificationDetailPanel({ ...item.row, title: item.row.title ?? '', metadata: item.row.metadata ?? undefined })
  if (!target) return
  if (isRecordType(target.type)) {
    const record = { type: target.type, id: target.id, label: target.title }
    if (opts.onOpenRecord) return opts.onOpenRecord(record)
    set({ record: { ...record, n: ++recordAsks } })
    opts.beside?.()
    return
  }
  const card = notificationCardTarget(target)
  if (card) openTarget(card, { from: 'inbox', flip: true, ...(card.type === 'team_chat' ? { reuse: true } : {}) })
}

/** Tests: nothing read, nothing chosen. */
export function __resetInboxStoreForTests(): void {
  state = INITIAL
  listeners.clear()
  readers = 0
  stopReading?.()
  stopReading = null
}
