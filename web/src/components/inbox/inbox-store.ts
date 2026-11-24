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
 *   filter    Status (All, Unread, Read, Held) and Type (each kind of
 *             notification, lib/inbox/items.ts INBOX_KINDS), All by default,
 *             as Recent's filter is (Liam, 11-24); remembered on this device.
 *             One filter, in one place on screen (the panel's, or the
 *             card's header).
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
import { DEFAULT_INBOX_FILTER, filterInbox, parseInboxFilter, type InboxItem, type InboxListFilter, type InboxMailRow } from '@/lib/inbox/items'
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
  /** Incoming's filter (Status and Type), remembered on this device (INBOX_FILTER_KEY). */
  filter: InboxListFilter
  cursor: number
  openKey: string | null
  record: InboxRecordAsk | null
  /** Bumped when live mail headers arrive. */
  headers: number
  /** Bumped by F (openInboxFilter): the filter button on screen opens its menu. */
  filterAsk: number
}

/** How often the list reads itself again while it is on screen. */
export const REFRESH_MS = 60_000

const INITIAL: InboxState = { data: null, failed: false, filter: DEFAULT_INBOX_FILTER, cursor: 0, openKey: null, record: null, headers: 0, filterAsk: 0 }

/** Incoming's filter, on this device: `{"status": "all"|"unread"|"read"|"held", "kinds": [...]}`. */
export const INBOX_FILTER_KEY = 'ni:inbox:filter'

function savedFilter(): InboxListFilter {
  try {
    return typeof window === 'undefined' ? DEFAULT_INBOX_FILTER : parseInboxFilter(window.localStorage.getItem(INBOX_FILTER_KEY))
  } catch {
    return DEFAULT_INBOX_FILTER
  }
}

let state: InboxState = INITIAL
let filterRead = false
const listeners = new Set<() => void>()
let readers = 0
let stopReading: (() => void) | null = null
let recordAsks = 0

function set(patch: Partial<InboxState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function inboxState(): InboxState {
  // The saved filter, read once (in the browser: never on the server's render).
  if (!filterRead && typeof window !== 'undefined') {
    filterRead = true
    const filter = savedFilter()
    if (filter !== DEFAULT_INBOX_FILTER) state = { ...state, filter }
  }
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // Nothing uses it any more: forgotten, read afresh next time.
    if (!listeners.size && !readers) {
      state = INITIAL
      filterRead = false
    }
  }
}

/**
 * What was marked done, by item key (Liam, 11-24: "I click the check box and
 * the emails or notification goes away then after a few second it reappears";
 * then "I just archived a bunch of calendar invite then I open another mail
 * and it all came back"). Once the server has said yes, a done item stays
 * gone whatever a later read says, until something genuinely new arrives in
 * it: a notification in the conversation that wasn't in it when it was done,
 * or a new message in the mail thread (more messages than then; by its time
 * when the index has no count). Nothing else brings it back:
 *
 *   - a read already on its way, or one that crossed the write;
 *   - a read that leaves it out for another reason (mail that couldn't be
 *     read this time, a page boundary) and a later one that lists it again;
 *   - the index lagging or rewritten behind the archive (a mailbox sync that
 *     read the thread just before it was archived and wrote it just after,
 *     the index still saying "inbox"), or the row's time moving with no new
 *     message in it;
 *   - a reload, a remount, the desktop app's window coming back: the record is
 *     kept on this device (DONE_STORAGE_KEY), DONE_KEEP_MS at most.
 *
 * Undo, or a Done the server refused, takes the record back out.
 */
interface DoneRecord {
  /** The item's newest moment when it was done. */
  at: string
  /** A notification item's rows then. */
  ids?: string[]
  /** A mail thread's message count then, when known. */
  messages?: number
  /** When it was done (ms). */
  since: number
}

/** On this device: `{ [item key]: DoneRecord }`. */
export const DONE_STORAGE_KEY = 'ni:inbox:done'
/** How long a done record is kept at most (the inbox lists a month of mail at most). */
export const DONE_KEEP_MS = 30 * 24 * 60 * 60_000
/** The most records kept (the oldest go first). */
const DONE_MAX = 500

let doneKeys: Map<string, DoneRecord> | null = null

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

function isRecord(v: unknown): v is DoneRecord {
  const r = v as DoneRecord | null
  return !!r && typeof r === 'object' && typeof r.at === 'string' && typeof r.since === 'number' && (r.ids === undefined || (Array.isArray(r.ids) && r.ids.every((id) => typeof id === 'string'))) && (r.messages === undefined || typeof r.messages === 'number')
}

function done(): Map<string, DoneRecord> {
  if (doneKeys) return doneKeys
  doneKeys = new Map()
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(DONE_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    const now = Date.now()
    if (parsed && typeof parsed === 'object') for (const [key, rec] of Object.entries(parsed)) if (isRecord(rec) && now - rec.since < DONE_KEEP_MS) doneKeys.set(key, rec)
  } catch {
    // Unreadable or blocked: this page's memory only.
  }
  return doneKeys
}

function saveDone(): void {
  const map = done()
  const now = Date.now()
  for (const [key, rec] of map) if (now - rec.since >= DONE_KEEP_MS) map.delete(key)
  if (map.size > DONE_MAX) for (const key of [...map.keys()].slice(0, map.size - DONE_MAX)) map.delete(key)
  try {
    if (map.size) window.localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)))
    else window.localStorage.removeItem(DONE_STORAGE_KEY)
  } catch {
    // Storage blocked or full: it holds in memory.
  }
}

function markDone(item: InboxItem): void {
  const map = done()
  map.delete(item.key)
  map.set(item.key, {
    at: item.at,
    since: Date.now(),
    ...(item.source === 'mail' ? (typeof item.messages === 'number' ? { messages: item.messages } : {}) : { ids: [...item.notificationIds] }),
  })
  saveDone()
}

function unmarkDone(key: string): void {
  if (done().delete(key)) saveDone()
}

/** Something genuinely new in it since it was done. */
function newSinceDone(item: InboxItem, rec: DoneRecord): boolean {
  if (item.source === 'mail') {
    if (typeof item.messages === 'number' && typeof rec.messages === 'number') return item.messages > rec.messages
    return ms(item.at) > ms(rec.at)
  }
  // A notification item: a row it didn't have then (its time can move without one: a row read, regrouped).
  if (!rec.ids) return ms(item.at) > ms(rec.at)
  const had = new Set(rec.ids)
  return item.notificationIds.some((id) => !had.has(id))
}

/** The items a read lists that weren't done here, or have news since; a done item with news is done no more. */
function withoutDone(items: readonly InboxItem[]): InboxItem[] {
  const map = done()
  if (!map.size) return [...items]
  let changed = false
  const out = items.filter((item) => {
    const rec = map.get(item.key)
    if (!rec) return true
    if (Date.now() - rec.since >= DONE_KEEP_MS || newSinceDone(item, rec)) {
      map.delete(item.key)
      changed = true
      return true
    }
    return false
  })
  if (changed) saveDone()
  return out
}

export async function loadInbox(): Promise<void> {
  let res: Response | null = null
  try {
    res = await fetch('/api/account/inbox')
  } catch {
    res = null
  }
  if (!res?.ok) return set({ failed: true })
  let raw: Partial<InboxData> | null = null
  try {
    raw = (await res.json()) as Partial<InboxData> | null
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object') return set({ failed: true })
  // Each list an array, whatever came back.
  const items = Array.isArray(raw.items) ? raw.items : []
  const held = Array.isArray(raw.held) ? raw.held : []
  // What was marked done stays gone, whatever a later read says, until there is news in it (DoneRecord).
  const json: InboxData = { items: withoutDone(items), held: withoutDone(held), mail: Array.isArray(raw.mail) ? raw.mail : [] }
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

/**
 * Whether anything in the inbox is unread, for Home's rail icon (Liam, 11-24:
 * Inbox lives in Home, so Home carries its dot). Read once here, on the
 * window's focus, and whenever `poke` changes (a notification arriving
 * realtime): no timer of its own. Null until known.
 */
export function useInboxUnread(poke: unknown): boolean | null {
  const s = useSyncExternalStore(subscribe, inboxState, () => INITIAL)
  useEffect(() => {
    void loadInbox()
  }, [poke])
  useEffect(() => {
    const onFocus = () => void loadInbox()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return s.data ? s.data.items.some((i) => i.unread) : null
}

// ── What the list shows ──────────────────────────────────────────────────

/** The rows under the filter. */
export function inboxRows(s: Pick<InboxState, 'data' | 'filter'>): InboxItem[] {
  return filterInbox(s.data, s.filter)
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

export function setInboxFilter(filter: InboxListFilter): void {
  set({ filter, cursor: 0 })
  try {
    window.localStorage.setItem(INBOX_FILTER_KEY, JSON.stringify({ status: filter.status, kinds: filter.kinds }))
  } catch {
    // Storage blocked or full: it holds in memory.
  }
}

/** F: open the filter's menu (the button on screen, InboxFilterButton). */
export function openInboxFilter(): void {
  set({ filterAsk: state.filterAsk + 1 })
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
  markDone(item)
  removeLocally(item.key)
  if (state.openKey === item.key) set({ openKey: null })
  let ok = false
  /** The server's reason for a failure, in plain words (thread-triage.ts failureOf). */
  let why: string | null = null
  let undo: (() => Promise<unknown>) | null = null
  if (item.source === 'mail' && item.open.kind === 'mail') {
    const threadIds = [item.open.providerThreadId]
    const res = await post('/api/account/email/threads/triage', { thread_ids: threadIds, change: { archive: true } }).catch(() => null)
    // A 200 is not a yes: the thread's own outcome is (a mailbox that refused,
    // or holds no such thread, answers 200 with that thread's status).
    const body = res?.ok ? ((await res.json().catch(() => null)) as { threads?: Array<{ status?: string; out_of_inbox?: string; error?: string }> } | null) : null
    const thread = body?.threads?.[0]
    // Archived; or out of the inbox already (deleted at the mailbox, in Trash
    // or Spam: out_of_inbox, the index following it): what Done asked.
    ok = thread?.status === 'changed' || thread?.status === 'unchanged' || !!thread?.out_of_inbox
    why = !ok && typeof thread?.error === 'string' && thread.error.trim() ? thread.error.trim().slice(0, 240) : null
    // Nothing to put back for a thread that wasn't in the inbox at all.
    undo = thread?.out_of_inbox ? null : () => post('/api/account/email/threads/triage', { thread_ids: threadIds, change: { archive: false } })
  } else {
    const ids = item.notificationIds.slice(0, 200)
    const res = await post('/api/account/inbox/notifications', { action: 'done', ids }).catch(() => null)
    // As many notifications archived as asked for none: nothing was written.
    const body = res?.ok ? ((await res.json().catch(() => null)) as { updated?: number } | null) : null
    ok = typeof body?.updated === 'number' && body.updated > 0
    undo = () => post('/api/account/inbox/notifications', { action: 'undone', ids })
  }
  if (!ok) {
    // Never silently: the row comes back, and says why.
    unmarkDone(item.key)
    toast.error(
      item.source === 'mail'
        ? why
          ? `That email could not be archived: ${why} It’s back in the list.`
          : 'That email could not be archived. It’s back in the list.'
        : 'That could not be marked done. It’s back in the list.',
    )
    return void loadInbox()
  }
  toast.success(item.source === 'mail' ? 'Archived' : 'Done', {
    action: undo
      ? {
          label: 'Undo',
          onClick: () => {
            unmarkDone(item.key)
            void undo!().then(() => loadInbox())
          },
        }
      : undefined,
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
export function __resetInboxStoreForTests(opts: { keepDevice?: boolean } = {}): void {
  // keepDevice: as a reload does (what this device kept stays).
  doneKeys = null
  if (!opts.keepDevice) {
    try {
      window.localStorage.removeItem(DONE_STORAGE_KEY)
    } catch {
      // No storage here.
    }
  }
  state = INITIAL
  filterRead = false
  listeners.clear()
  readers = 0
  stopReading?.()
  stopReading = null
}
