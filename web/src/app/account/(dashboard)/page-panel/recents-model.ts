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
 * Liam, 11-11: sections by day, "so you see today, yesterday…": today by
 * part of the day (This morning, This afternoon, This evening), then
 * Yesterday, Last 7 days, Last 30 days, Older (recentGroupOf).
 */
import type { ActivityEntityType } from '@/lib/knowledge/entity-registry'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { FeedEntry } from '@/lib/entities/feed-model'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'

/** How many rows show at first, and how many each "Show more" adds. */
export const RECENTS_PAGE = 30

export interface RecentItem {
  /** `type:id`, the record's one key. */
  key: string
  type: ActivityEntityType
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

const keyOf = (e: Pick<FeedEntry, 'type' | 'id'>) => `${e.type}:${e.id}`
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
  seen = {},
  canOpen = (e) => entityOpenTarget(e.type, e.id, e.label) !== null,
}: {
  inbox: readonly FeedEntry[] | null
  recent: readonly FeedEntry[] | null
  seen?: SeenMap
  canOpen?: (e: FeedEntry) => boolean
}): RecentItem[] {
  const byKey = new Map<string, { entry: FeedEntry; mine: string | null; inboxAt: string | null }>()
  for (const e of recent ?? []) {
    if (!e?.id || !e.type || !canOpen(e)) continue
    const key = keyOf(e)
    if (!byKey.has(key)) byKey.set(key, { entry: e, mine: e.last?.at ?? null, inboxAt: null })
  }
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

export type RecentGroupKey = 'evening' | 'afternoon' | 'morning' | 'yesterday' | 'week' | 'month' | 'older'

export const RECENT_GROUP_LABEL: Record<RecentGroupKey, string> = {
  evening: 'This evening',
  afternoon: 'This afternoon',
  morning: 'This morning',
  yesterday: 'Yesterday',
  week: 'Last 7 days',
  month: 'Last 30 days',
  older: 'Older',
}

/** Newest first: today's parts of the day latest first, then back in time. */
const GROUP_ORDER: readonly RecentGroupKey[] = ['evening', 'afternoon', 'morning', 'yesterday', 'week', 'month', 'older']

const HOUR_MS = 3_600_000
/** Where the afternoon and the evening start, local hours. */
const AFTERNOON_HOUR = 12
const EVENING_HOUR = 18

/** The local midnight `days` days before `now`'s. */
function dayStart(now: Date, days = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime()
}

/** The part of the day a local time falls in: before noon, before 6pm, then the evening. */
function partOfDay(d: Date): RecentGroupKey {
  const h = d.getHours()
  return h < AFTERNOON_HOUR ? 'morning' : h < EVENING_HOUR ? 'afternoon' : 'evening'
}

/**
 * Which section a time falls in, by the viewer's calendar (local time):
 * today by its part of the day (This morning before 12:00, This afternoon
 * to 17:59, This evening from 18:00); Yesterday, the calendar day before
 * (not 24 hours ago); Last 7 days, the five days before that (today and the
 * six before it make the 7); Last 30 days, today and the 29 before it; then
 * Older. A time a little ahead of the clock (a skewed clock) is the part of
 * the day it is now.
 */
export function recentGroupOf(at: string, now: Date): RecentGroupKey {
  const t = ms(at)
  if (t > now.getTime()) return partOfDay(now)
  if (t >= dayStart(now)) return partOfDay(new Date(t))
  if (t >= dayStart(now, 1)) return 'yesterday'
  if (t >= dayStart(now, 6)) return 'week'
  if (t >= dayStart(now, 29)) return 'month'
  return 'older'
}

export interface RecentGroup {
  key: RecentGroupKey
  label: string
  items: RecentItem[]
}

/** The list under its section headings, newest section first, empty ones left out (the items' own order kept). */
export function groupRecents(items: readonly RecentItem[], now: Date): RecentGroup[] {
  const by = new Map<RecentGroupKey, RecentItem[]>()
  for (const item of items) {
    const key = recentGroupOf(item.at, now)
    const list = by.get(key)
    if (list) list.push(item)
    else by.set(key, [item])
  }
  return GROUP_ORDER.flatMap((key) => {
    const list = by.get(key)
    return list?.length ? [{ key, label: RECENT_GROUP_LABEL[key], items: list }] : []
  })
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
