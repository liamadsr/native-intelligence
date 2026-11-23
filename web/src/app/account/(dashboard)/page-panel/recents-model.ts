/**
 * The home page's recents, as plain data (Liam, 11-11: "a floating panel
 * next to the navigation that's going to show you all the recent pages,
 * docs, chats, or anything else that needs your attention"): one list,
 * newest first, each record once, grouped by time.
 *
 * Two of the activity feed's lists make it (use-recents.ts reads them, the
 * palette's own reads, longer):
 *   inbox   what was assigned to, @-mentions or was shared with the person,
 *           the last two weeks: it needs them, so it carries a dot until
 *           they open it (or act on it themselves after it came);
 *   recent  the records they touched last, themselves (actor=me).
 * A record in both is one row, at the later of its two times. The feed's
 * kinds are the records (docs, actions, projects, captures, contacts…) and
 * team chat's messages; a kind the app can't open (entityOpenTarget) is left
 * out, so every row opens.
 *
 * Pure: the clock is passed in (`now`), the times read in the viewer's own
 * time zone (a calendar day is theirs).
 *
 * Liam, 11-11: the panel persists when you open something, so the record a
 * full-screen card shows has its row lit (frontRecentKey).
 *
 * Sections by time (docs/plans/recent-panel.md, as Macro's Home groups its
 * feed): Last few minutes, Last hour, the part of today it is now (This
 * morning, This afternoon, This evening), Earlier today, Yesterday, then
 * each day (recentGroupOf).
 *
 * Besides the feed, what the person did to records the log doesn't hold
 * (their Drive uploads, their coding jobs: GET /api/account/recents) joins
 * the list as their own (`sources`). The filter (Status on the dot, Type per
 * kind: filterRecents) narrows what shows.
 */
import { recentTypeOf, type RecentKind, type RecentSourceEntry, type RecentTypeKey } from '@/lib/entities/recents-model'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { FeedEntry } from '@/lib/entities/feed-model'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'

/** How many rows show at first, and how many each "Show more" adds. */
export const RECENTS_PAGE = 30

export interface RecentItem {
  /** `type:id`, the record's one key. */
  key: string
  type: RecentKind
  id: string
  title: string
  /** Where it sits, when that helps (a message's channel). */
  context: string | null
  /** Its newest time in either list (ISO): where it sorts and what its time says. */
  at: string
  /** It came to the person (the inbox) and they haven't opened it or acted on it since: the dot. */
  needsYou: boolean
  /** The inbox event's time (ISO), what opening it marks seen; null for a record only in recent. */
  inboxAt: string | null
}

/** What the person opened from the panel: `type:id` → the inbox time they saw. */
export type SeenMap = Readonly<Record<string, string>>

/** How many records the seen map keeps (the newest seen). */
export const SEEN_MAX = 200

/** A record as either list holds it: a feed entry or a direct read's. */
type RecentEntry = Pick<FeedEntry, 'id' | 'label' | 'context'> & { type: RecentKind }

const keyOf = (e: Pick<RecentEntry, 'type' | 'id'>) => `${e.type}:${e.id}`

/** Whether a row of this kind opens: a record's card, or one of the kinds read from their own tables. */
export function canOpenRecent(type: string, id: string, label?: string | null): boolean {
  if (type === 'attachment' || type === 'code_job') return !!id
  return entityOpenTarget(type, id, label) !== null
}
const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

/**
 * The one list: each record once, newest first (ties by key, so the order
 * never shuffles between two reads), the inbox's carrying a dot until seen.
 */
export function mergeRecents({
  inbox,
  recent,
  sources = null,
  seen = {},
  canOpen = (e) => canOpenRecent(e.type, e.id, e.label),
}: {
  inbox: readonly FeedEntry[] | null
  recent: readonly FeedEntry[] | null
  /** What the person did to records the log doesn't hold, from their own tables (GET /api/account/recents). */
  sources?: readonly RecentSourceEntry[] | null
  seen?: SeenMap
  canOpen?: (e: Pick<RecentEntry, 'type' | 'id' | 'label'>) => boolean
}): RecentItem[] {
  const byKey = new Map<string, { entry: RecentEntry; mine: string | null; inboxAt: string | null }>()
  const addMine = (e: RecentEntry, at: string | null) => {
    if (!e?.id || !e.type || !canOpen(e)) return
    const key = keyOf(e)
    const had = byKey.get(key)
    if (!had) byKey.set(key, { entry: e, mine: at, inboxAt: null })
    else if (ms(at) > ms(had.mine)) byKey.set(key, { ...had, entry: e, mine: at })
  }
  for (const e of recent ?? []) addMine(e, e?.last?.at ?? null)
  for (const e of sources ?? []) addMine(e, e?.at ?? null)
  for (const e of inbox ?? []) {
    if (!e?.id || !e.type || !canOpen(e)) continue
    const key = keyOf(e)
    const had = byKey.get(key)
    const at = e.last?.at ?? null
    if (!had) byKey.set(key, { entry: e, mine: null, inboxAt: at })
    else if (ms(at) > ms(had.inboxAt)) byKey.set(key, { ...had, inboxAt: at, entry: ms(at) > ms(had.mine) ? e : had.entry })
  }
  const out: RecentItem[] = []
  for (const [key, { entry, mine, inboxAt }] of byKey) {
    const at = ms(inboxAt) > ms(mine) ? inboxAt! : (mine ?? inboxAt ?? '')
    // It came after the person's own last touch, and after they last opened it here.
    const needsYou = inboxAt !== null && ms(inboxAt) > ms(mine) && ms(inboxAt) > ms(seen[key])
    out.push({
      key,
      type: entry.type,
      id: entry.id,
      title: (entry.label ?? '').replace(/\s+/g, ' ').trim() || 'Untitled',
      context: entry.context ?? null,
      at,
      needsYou,
      inboxAt,
    })
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * The recents key (`type:id`) of the record a card in front shows, or null:
 * a record's card, or a page's card on one place (a sequence, a prospect
 * list, a suite). A card on no one record (a calendar, the mail, team chat)
 * lights no row.
 */
export function frontRecentKey(spec: CardSpec | null | undefined): string | null {
  if (!spec) return null
  if (spec.kind === 'record') return `${spec.record.type}:${spec.record.id}`
  const target = (spec as { target?: { type?: string; id?: string } }).target
  return target?.type && target.id ? `${target.type}:${target.id}` : null
}

/** The seen map with `key` seen at `at`, the oldest dropped past SEEN_MAX. */
export function markSeen(seen: SeenMap, key: string, at: string, max: number = SEEN_MAX): SeenMap {
  if (ms(seen[key]) >= ms(at)) return seen
  const next = { ...seen, [key]: at }
  const keys = Object.keys(next)
  if (keys.length <= max) return next
  const kept = keys.sort((a, b) => ms(next[b]) - ms(next[a])).slice(0, max)
  return Object.fromEntries(kept.map((k) => [k, next[k]]))
}

/** A saved seen map read back: only string times; anything else is an empty map. */
export function parseSeen(raw: string | null): SeenMap {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((kv): kv is [string, string] => typeof kv[1] === 'string'))
  } catch {
    return {}
  }
}

/**
 * A section: the last few minutes, the last hour, the part of today it is
 * now, earlier today, yesterday, then one per calendar day (`date:YYYY-MM-DD`,
 * the viewer's own calendar).
 */
export type RecentGroupKey = 'minutes' | 'hour' | 'morning' | 'afternoon' | 'evening' | 'today' | 'yesterday' | `date:${string}`

const FIXED_GROUP_LABEL = {
  minutes: 'Last few minutes',
  hour: 'Last hour',
  morning: 'This morning',
  afternoon: 'This afternoon',
  evening: 'This evening',
  today: 'Earlier today',
  yesterday: 'Yesterday',
} as const

const HOUR_MS = 3_600_000
/** "The last few minutes": this many. */
export const FEW_MINUTES_MS = 10 * 60_000
/** Where the afternoon and the evening start, local hours. */
const AFTERNOON_HOUR = 12
const EVENING_HOUR = 18

/** The local midnight `days` days before `now`'s. */
function dayStart(now: Date, days = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime()
}

/** The part of the day a local time falls in: before noon, before 6pm, then the evening. */
function partOfDay(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  return h < AFTERNOON_HOUR ? 'morning' : h < EVENING_HOUR ? 'afternoon' : 'evening'
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date): RecentGroupKey => `date:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Which section a time falls in, by the viewer's own clock and calendar:
 * the last 10 minutes; the last hour; today, older than that, in the part of
 * the day it is now (This morning before 12:00, This afternoon to 17:59, This
 * evening from 18:00); today, in an earlier part (Earlier today); Yesterday,
 * the calendar day before (not 24 hours ago); then the day itself. A time a
 * little ahead of the clock (a skewed clock) is the last few minutes'.
 */
export function recentGroupOf(at: string, now: Date): RecentGroupKey {
  const t = ms(at)
  if (!Number.isFinite(t)) return 'date:unknown'
  const ago = now.getTime() - t
  if (ago < FEW_MINUTES_MS) return 'minutes'
  if (ago < HOUR_MS) return 'hour'
  if (t >= dayStart(now)) {
    const part = partOfDay(new Date(t))
    return part === partOfDay(now) ? part : 'today'
  }
  if (t >= dayStart(now, 1)) return 'yesterday'
  return dateKey(new Date(t))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A section's heading: its words, or a day's date ("Mon, Nov 9"; a past year's with its year). */
export function recentGroupLabel(key: RecentGroupKey, now: Date): string {
  if (key in FIXED_GROUP_LABEL) return FIXED_GROUP_LABEL[key as keyof typeof FIXED_GROUP_LABEL]
  const m = /^date:(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return 'Earlier'
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const day = `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`
}

export interface RecentGroup<T extends { at: string } = RecentItem> {
  key: RecentGroupKey
  label: string
  items: T[]
}

/**
 * The list under its section headings, in the list's own order (newest
 * first), each section where its first row falls; empty ones aren't there.
 */
export function groupRecents<T extends { at: string }>(items: readonly T[], now: Date): RecentGroup<T>[] {
  const out: RecentGroup<T>[] = []
  const by = new Map<RecentGroupKey, RecentGroup<T>>()
  for (const item of items) {
    const key = recentGroupOf(item.at, now)
    const group = by.get(key)
    if (group) group.items.push(item)
    else {
      const next = { key, label: recentGroupLabel(key, now), items: [item] }
      by.set(key, next)
      out.push(next)
    }
  }
  return out
}

// ── The filter ─────────────────────────────────────────────

/** Status: the dot (Unread: it needs the person, unopened; Read: everything else), or all. */
export type RecentStatus = 'all' | 'unread' | 'read'

export interface RecentFilter {
  status: RecentStatus
  /** The Types shown; empty is every type. */
  types: readonly RecentTypeKey[]
}

export const DEFAULT_RECENT_FILTER: RecentFilter = Object.freeze({ status: 'all', types: Object.freeze([]) as readonly RecentTypeKey[] })

/** Is it the default (nothing filtered)? */
export const isDefaultRecentFilter = (f: RecentFilter): boolean => f.status === 'all' && f.types.length === 0

/** The rows the filter keeps, their order kept. */
export function filterRecents(items: readonly RecentItem[], filter: RecentFilter): RecentItem[] {
  const types = new Set(filter.types)
  return items.filter((item) => {
    if (filter.status === 'unread' && !item.needsYou) return false
    if (filter.status === 'read' && item.needsYou) return false
    if (types.size) {
      const t = recentTypeOf(item.type)
      if (!t || !types.has(t)) return false
    }
    return true
  })
}

/** The Types the list has rows of, in the filter's order (what the filter offers). */
export function recentTypesPresent(items: readonly RecentItem[]): RecentTypeKey[] {
  const have = new Set<RecentTypeKey>()
  for (const item of items) {
    const t = recentTypeOf(item.type)
    if (t) have.add(t)
  }
  return [...have]
}

/** A saved filter read back: only known values; anything else is the default. */
export function parseRecentFilter(raw: string | null, known: readonly RecentTypeKey[]): RecentFilter {
  if (!raw) return DEFAULT_RECENT_FILTER
  try {
    const v = JSON.parse(raw) as { status?: unknown; types?: unknown }
    const status: RecentStatus = v?.status === 'unread' || v?.status === 'read' ? v.status : 'all'
    const types = Array.isArray(v?.types) ? [...new Set(v.types.filter((t): t is RecentTypeKey => typeof t === 'string' && known.includes(t as RecentTypeKey)))] : []
    return { status, types }
  } catch {
    return DEFAULT_RECENT_FILTER
  }
}

/** One Type on or off. */
export function toggleRecentType(filter: RecentFilter, type: RecentTypeKey): RecentFilter {
  const on = filter.types.includes(type)
  return { ...filter, types: on ? filter.types.filter((t) => t !== type) : [...filter.types, type] }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A short time at a row's right: "now", "12m", "3h", "2d" within the week,
 * then the day ("Nov 9"), and a past year's month ("Nov 2025").
 */
export function shortRecentTime(at: string, now: Date): string {
  const t = ms(at)
  if (!Number.isFinite(t)) return ''
  const ago = now.getTime() - t
  if (ago < 60_000) return 'now'
  if (ago < HOUR_MS) return `${Math.floor(ago / 60_000)}m`
  if (ago < 24 * HOUR_MS) return `${Math.floor(ago / HOUR_MS)}h`
  if (ago < 7 * 24 * HOUR_MS) return `${Math.floor(ago / (24 * HOUR_MS))}d`
  const d = new Date(t)
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
