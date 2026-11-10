/**
 * THE CROSS-KIND FEED, as plain data: the one filter shape every list reads
 * (the Inbox, Recent, a record's History), what the feed answers, and how an
 * event reads. Client-safe and pure; the server half is ./feed.ts, the route
 * GET /api/account/feed.
 *
 * The feed reads the activity log (entity_activity, migration 488): one row
 * per thing that happened to a record of a kind the registry marks
 * `activity`. Grouped (the default), it is one entry per record, its newest
 * event first; ungrouped, every event.
 *
 * Filters (query params):
 *   kinds=action,document   only these kinds
 *   assigned_to=me          assigned to the viewer
 *   mentioned=me            the viewer @-mentioned
 *                           (both together: either — the Inbox; the viewer's
 *                           own doing is never in it)
 *   linked_to=type:id       records linked to that one
 *   actor=me|agent|<member> who did it (me: the viewer's own hand)
 *   entity=type:id          one record's events (its History)
 *   since=<iso>             no older than
 *   cursor=<iso>|<id>       the next page: older than this
 *   group=entity|none       per record (default) or every event
 *   limit=1..50
 */
import { isActivityEntityType, type ActivityEntityType } from '@/lib/knowledge/entity-registry'

export const FEED_ACTIONS = [
  'created',
  'renamed',
  'status_changed',
  'assigned',
  'archived',
  'restored',
  'mentioned',
  'commented',
  'linked',
] as const
export type FeedAction = (typeof FEED_ACTIONS)[number]

export const FEED_DEFAULT_LIMIT = 20
export const FEED_MAX_LIMIT = 50

export interface FeedRef {
  type: string
  id: string
}

export interface FeedCursor {
  at: string
  id: string
}

export interface FeedFilter {
  kinds: ActivityEntityType[] | null
  assignedToMe: boolean
  mentionedMe: boolean
  linkedTo: FeedRef | null
  /** 'me', 'agent', or a member id. */
  actor: string | null
  entity: FeedRef | null
  since: string | null
  cursor: FeedCursor | null
  group: 'entity' | 'none'
  limit: number
}

export const EMPTY_FEED_FILTER: FeedFilter = {
  kinds: null,
  assignedToMe: false,
  mentionedMe: false,
  linkedTo: null,
  actor: null,
  entity: null,
  since: null,
  cursor: null,
  group: 'entity',
  limit: FEED_DEFAULT_LIMIT,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** `type:id`, the id a uuid. */
function parseRef(raw: string | null): FeedRef | null | 'bad' {
  if (raw == null || raw === '') return null
  const at = raw.indexOf(':')
  if (at <= 0) return 'bad'
  const type = raw.slice(0, at)
  const id = raw.slice(at + 1)
  if (!/^[a-z_]+$/.test(type) || !isUuid(id)) return 'bad'
  return { type, id: id.toLowerCase() }
}

export function encodeFeedCursor(c: FeedCursor): string {
  return `${c.at}|${c.id}`
}

function parseCursor(raw: string | null): FeedCursor | null | 'bad' {
  if (!raw) return null
  const [at, id] = raw.split('|')
  if (!at || !isUuid(id) || Number.isNaN(Date.parse(at)) || at.length > 40) return 'bad'
  // The row's own time, as the database wrote it (microseconds kept: a Date would drop them).
  return { at, id: id.toLowerCase() }
}

/** The filter a query string asks for, or why it can't be read. */
export function parseFeedQuery(params: URLSearchParams): FeedFilter | { error: string } {
  const f: FeedFilter = { ...EMPTY_FEED_FILTER }

  const kinds = params.get('kinds')
  if (kinds) {
    const list = [...new Set(kinds.split(',').map((k) => k.trim()).filter(Boolean))]
    if (!list.length || !list.every(isActivityEntityType)) return { error: 'Unknown kind' }
    f.kinds = list as ActivityEntityType[]
  }

  for (const [key, set] of [
    ['assigned_to', (v: boolean) => (f.assignedToMe = v)],
    ['mentioned', (v: boolean) => (f.mentionedMe = v)],
  ] as const) {
    const v = params.get(key)
    if (v == null || v === '') continue
    if (v !== 'me') return { error: `${key} takes "me"` }
    set(true)
  }

  const linked = parseRef(params.get('linked_to'))
  if (linked === 'bad') return { error: 'linked_to takes type:id' }
  f.linkedTo = linked

  const entity = parseRef(params.get('entity'))
  if (entity === 'bad') return { error: 'entity takes type:id' }
  if (entity && !isActivityEntityType(entity.type)) return { error: 'Unknown kind' }
  f.entity = entity

  const actor = params.get('actor')
  if (actor) {
    if (actor !== 'me' && actor !== 'agent' && !isUuid(actor)) return { error: 'actor takes me, agent or a member id' }
    f.actor = isUuid(actor) ? actor.toLowerCase() : actor
  }

  const since = params.get('since')
  if (since) {
    if (Number.isNaN(Date.parse(since))) return { error: 'since takes a date' }
    f.since = new Date(since).toISOString()
  }

  const cursor = parseCursor(params.get('cursor'))
  if (cursor === 'bad') return { error: 'Invalid cursor' }
  f.cursor = cursor

  const group = params.get('group')
  if (group) {
    if (group !== 'entity' && group !== 'none') return { error: 'group takes entity or none' }
    f.group = group
  }

  const limit = params.get('limit')
  if (limit) {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1) return { error: 'limit takes a whole number' }
    f.limit = Math.min(n, FEED_MAX_LIMIT)
  }
  return f
}

/** The query string for a filter (only what differs from the default). */
export function feedQuery(filter: Partial<FeedFilter>): string {
  const p = new URLSearchParams()
  if (filter.kinds?.length) p.set('kinds', filter.kinds.join(','))
  if (filter.assignedToMe) p.set('assigned_to', 'me')
  if (filter.mentionedMe) p.set('mentioned', 'me')
  if (filter.linkedTo) p.set('linked_to', `${filter.linkedTo.type}:${filter.linkedTo.id}`)
  if (filter.actor) p.set('actor', filter.actor)
  if (filter.entity) p.set('entity', `${filter.entity.type}:${filter.entity.id}`)
  if (filter.since) p.set('since', filter.since)
  if (filter.cursor) p.set('cursor', encodeFeedCursor(filter.cursor))
  if (filter.group && filter.group !== 'entity') p.set('group', filter.group)
  if (filter.limit && filter.limit !== FEED_DEFAULT_LIMIT) p.set('limit', String(filter.limit))
  return p.toString()
}

export const FEED_URL = '/api/account/feed'

export function feedUrl(filter: Partial<FeedFilter>): string {
  const q = feedQuery(filter)
  return q ? `${FEED_URL}?${q}` : FEED_URL
}

// ── What the feed answers ───────────────────────────────────────────────────

export interface FeedActor {
  kind: 'member' | 'agent' | 'system'
  member_id: string | null
  /** The member's display name; null for the system, or a member gone. */
  name: string | null
  /** The viewer did it. */
  me: boolean
}

export interface FeedEvent {
  id: string
  action: FeedAction
  at: string
  actor: FeedActor
  /** The member it is about (who was assigned or @-mentioned). */
  subject: { member_id: string; name: string | null; me: boolean } | null
  /** The words around a change: a state's or person's name. */
  from: string | null
  to: string | null
  /** For a link: the relation ('related_to', 'depends_on', …). */
  relation: string | null
  /** The record that mentions, or the one linked: labelled through the viewer's RLS. */
  other: { type: string; id: string; label: string; context: string | null } | null
}

/** One record and its newest event (the grouped feed). */
export interface FeedEntry {
  type: ActivityEntityType
  id: string
  label: string
  /** Where it sits, when that helps: a message's channel ("#launch", "Direct message"). */
  context: string | null
  last: FeedEvent
  /** Its events in the window read. */
  count: number
}

/** One event on one record (the ungrouped feed). */
export interface FeedRecordEvent extends FeedEvent {
  type: ActivityEntityType
  entity_id: string
  label: string
  context: string | null
}

export interface FeedResponse {
  entries?: FeedEntry[]
  events?: FeedRecordEvent[]
  next_cursor: string | null
}

// ── How an event reads ──────────────────────────────────────────────────────

/** What happened, in a few words: "Assigned to you", "Moved to In progress". */
export function describeFeedEvent(e: FeedEvent): string {
  switch (e.action) {
    case 'created':
      return 'Created'
    case 'renamed':
      return 'Renamed'
    case 'status_changed':
      if (e.to === 'on') return 'Turned on'
      if (e.to === 'off') return 'Turned off'
      return e.to ? `Moved to ${e.to}` : 'Status changed'
    case 'assigned':
      if (e.subject?.me) return 'Assigned to you'
      if (e.subject) return `Assigned to ${e.subject.name ?? 'someone'}`
      return 'Unassigned'
    case 'archived':
      return 'Archived'
    case 'restored':
      return 'Restored'
    case 'mentioned':
      // A member's mention is on the record that mentions them (the entry itself).
      if (e.subject?.me) return 'Mentioned you'
      if (e.subject) return `Mentioned ${e.subject.name ?? 'someone'}`
      // A message says where it was ("Mentioned in #sales"), not its words.
      if (e.other?.type === 'team_chat_message') return `Mentioned in ${e.other.context ?? 'a message'}`
      return e.other ? `Mentioned in ${e.other.label}` : 'Mentioned'
    case 'commented':
      return 'Commented'
    case 'linked':
      return e.other ? `Linked to ${e.other.label}` : 'Linked'
  }
}

/** Who did it: "You", a name, "An agent"; null for the system (said by the event alone). */
export function feedActorLabel(a: FeedActor): string | null {
  if (a.me && a.kind === 'member') return 'You'
  if (a.kind === 'agent') return a.name ? `${a.name}'s agent` : 'An agent'
  if (a.kind === 'member') return a.name ?? 'Someone'
  return null
}

/** Merge a later page into what's listed: a record already shown keeps its place. */
export function mergeFeedEntries(shown: readonly FeedEntry[], more: readonly FeedEntry[]): FeedEntry[] {
  const seen = new Set(shown.map((e) => `${e.type}:${e.id}`))
  return [...shown, ...more.filter((e) => !seen.has(`${e.type}:${e.id}`))]
}
