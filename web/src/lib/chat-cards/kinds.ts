/**
 * Pages in the chat (docs/plans/one-agent-and-chat-pages.md, Part 1): the
 * description a card is drawn from.
 *
 * The agent's `show` tool writes one of these; the chat draws the real page
 * from it. It is the views system's own description of "a page filtered like
 * X" (src/lib/views/types.ts), so a card never holds data, only what to show:
 * after a reload it draws live rows again from the same few hundred bytes.
 *
 * ── Adding a kind ───────────────────────────────────────────────────────────
 * A kind is one entry in CARD_KINDS below (how it names itself), one server
 * entry in SHOW_KINDS (./server.ts: how `show` checks and runs it) and one
 * client entry in src/components/chat-cards/card-kinds.tsx (what it draws).
 * P1 has `list` and `record`, P2 `calendar` and `mail`. The whole pages
 * (P3) are one family with its own three halves: ./pages.ts,
 * ./page-server.ts and src/components/chat-cards/pages/.
 *
 * Client-safe: no server imports.
 */
import type { GroupConfig, SortConfig, ViewEntityType, FilterOperator, FilterValue } from '@/lib/views/types'
import type { EditionDefinition } from '@/lib/editions/manifest'
import { pageWords, termWords } from '@/lib/editions/words'
import { PAGE_KIND_NAMES, PAGE_KINDS, isPageCardSpec, isPageKind, type PageCardSpec, type PageKind } from './pages'

/**
 * The kinds `show` takes. `board` is a list drawn as a board; it normalizes to
 * `list`. The pages after them (P3) are each their own page (./pages.ts).
 */
export const CARD_KIND_NAMES = ['list', 'record', 'calendar', 'mail', ...PAGE_KIND_NAMES] as const
export type CardKind = (typeof CARD_KIND_NAMES)[number]

/**
 * The entity types a list card draws in P1: every list the generic page
 * (tabs/tab-content.tsx) serves through UnifiedViewLayout.
 */
export const CARD_LIST_ENTITIES = ['action', 'capture', 'document', 'initiative', 'project', 'contact', 'company'] as const
export type CardListEntity = (typeof CARD_LIST_ENTITIES)[number]

/** The records a record card opens: each has its own detail panel. */
export const CARD_RECORD_TYPES = CARD_LIST_ENTITIES
export type CardRecordType = CardListEntity

/** Entities whose rows the query engine can search by text (applySearch). */
export const CARD_SEARCHABLE_ENTITIES: ReadonlySet<ViewEntityType> = new Set(['action', 'capture', 'document', 'contact', 'company'])

/** One filter on a card: a views filter without the UI's chip id. */
export interface CardFilter {
  field: string
  operator: FilterOperator
  value: FilterValue
}

/** What a list card shows: the views system's query, minus anything the UI owns. */
export interface CardQuery {
  filters: CardFilter[]
  ordering?: SortConfig[]
  grouping?: GroupConfig | null
  layout?: 'list' | 'board'
  /** Display properties (DISPLAY_PROPERTIES keys), left to right. */
  columns?: string[]
  /** Only ever the person's own search box, never the agent's. */
  search?: string
  /** Actions: which completed ones show ('all', 'recent': the last two weeks, 'none'). Absent: all. */
  completed_filter?: 'all' | 'recent' | 'none'
  /** Actions: false hides completed ones (the page's "Show completed"). Absent: true. */
  show_completed?: boolean
}

export interface ListCardSpec extends CardQuery {
  kind: 'list'
  title: string
  entity_type: CardListEntity
}

export interface RecordCardSpec {
  kind: 'record'
  title: string
  /** `section`: an action's inner view to open on (its Cloud run, its agents); only the person's cards carry one. */
  record: { type: CardRecordType; id: string; section?: 'cloud' | 'agents' }
}

// ── Calendar (P2) ───────────────────────────────────────────────────────────

/** The views a calendar card opens in: what the Calendar page's grid can show of one range. */
export const CALENDAR_CARD_VIEWS = ['day', 'week', 'month'] as const
export type CalendarCardView = (typeof CALENDAR_CARD_VIEWS)[number]

/**
 * What a calendar card shows: one day, week (Sunday to Saturday, as the grid
 * draws it) or month, as local dates (YYYY-MM-DD, both ends included), and
 * optionally only some connected calendar accounts (their ids). The range is
 * always exactly what the view draws (./calendar.ts calendarRange), so the
 * agent's count is the card's.
 */
export interface CalendarQuery {
  from: string
  to: string
  view: CalendarCardView
  accounts?: string[]
}

export interface CalendarCardSpec {
  kind: 'calendar'
  title: string
  calendar: CalendarQuery
}

// ── Mail (P2) ───────────────────────────────────────────────────────────────

/** The Mail page's folders (email-layout.tsx), in its order. */
export const MAIL_FOLDERS = ['inbox', 'starred', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const
export type MailFolder = (typeof MAIL_FOLDERS)[number]

/**
 * What a mail card shows: a folder's threads, maybe searched, maybe only some
 * mailboxes (connected account ids), or one thread (its provider thread id,
 * as list_emails and read_email name it).
 */
export interface MailQuery {
  folder: MailFolder
  search?: string
  /** Only unread threads. */
  unread?: boolean
  thread_id?: string
  /** A draft in that thread to open on (its mailbox message id): a For you draft card, a work item's "Review draft". */
  draft_id?: string
  accounts?: string[]
}

export interface MailCardSpec {
  kind: 'mail'
  title: string
  mail: MailQuery
}

export type CardSpec = ListCardSpec | RecordCardSpec | CalendarCardSpec | MailCardSpec | PageCardSpec

/** True for a kind that is a whole page (./pages.ts), not a list, record, calendar or mail. */
export function isPageCard(spec: CardSpec): spec is PageCardSpec {
  return isPageKind(spec.kind)
}

/**
 * What can be open inside a card: a record (its detail panel), an event on a
 * calendar card, a thread on a mail card.
 */
export type CardOpenType = CardRecordType | 'event' | 'thread'
export const CARD_OPEN_TYPES: readonly CardOpenType[] = [...CARD_RECORD_TYPES, 'event', 'thread']
export const OPEN_NOUN: Record<CardOpenType, string> = {
  ...(Object.fromEntries(CARD_RECORD_TYPES.map((t) => [t, t === 'document' ? 'doc' : t])) as Record<CardRecordType, string>),
  event: 'event',
  thread: 'thread',
}

export const ENTITY_NOUN: Record<CardListEntity, { singular: string; plural: string }> = {
  action: { singular: 'action', plural: 'actions' },
  capture: { singular: 'capture', plural: 'captures' },
  document: { singular: 'doc', plural: 'docs' },
  initiative: { singular: 'initiative', plural: 'initiatives' },
  project: { singular: 'project', plural: 'projects' },
  contact: { singular: 'contact', plural: 'contacts' },
  company: { singular: 'company', plural: 'companies' },
}

/** How each kind names what it shows, in the pill and in the agent's note. */
export const CARD_KINDS: Record<CardKind, { noun: (spec: CardSpec) => string; counted: (count: number) => string }> = {
  list: {
    noun: (spec) => (spec.kind === 'list' ? ENTITY_NOUN[spec.entity_type].plural : 'list'),
    counted: (count) => String(count),
  },
  record: {
    noun: (spec) => (spec.kind === 'record' ? ENTITY_NOUN[spec.record.type].singular : 'record'),
    counted: (count) => String(count),
  },
  calendar: { noun: () => 'events', counted: (count) => `${count} ${count === 1 ? 'event' : 'events'}` },
  mail: {
    noun: (spec) => (spec.kind === 'mail' && spec.mail.thread_id ? 'thread' : 'mail'),
    counted: (count) => `${count} ${count === 1 ? 'thread' : 'threads'}`,
  },
  // A whole page: its name, and how many rows it shows where it is.
  ...(Object.fromEntries(
    PAGE_KIND_NAMES.map((kind) => [
      kind,
      { noun: () => PAGE_KINDS[kind].label.toLowerCase(), counted: (count: number) => `${PAGE_KINDS[kind].label} · ${count}` },
    ]),
  ) as unknown as Record<PageKind, { noun: (spec: CardSpec) => string; counted: (count: number) => string }>),
}

/**
 * "12 actions", "3 events", "1 thread"; the plain noun while the count is
 * unknown. In the workspace's edition's words when it is given ("12 jobs",
 * src/lib/editions/words.ts): the person's pill only, never the agent's cards
 * note, which keeps the app's own words like every tool result.
 */
export function countLabel(spec: CardSpec, count: number | null, edition?: Pick<EditionDefinition, 'words'>): string {
  if (isPageCard(spec)) {
    const def = PAGE_KINDS[spec.kind]
    const label = pageWords(edition, def.view, { label: def.label }).label
    return count === null ? label : `${label} · ${count}`
  }
  if (spec.kind === 'list') {
    const { one, many } = termWords(edition, spec.entity_type)
    return count === null ? many : `${count} ${count === 1 ? one : many}`
  }
  if (spec.kind === 'record') return termWords(edition, spec.record.type).one
  if (spec.kind === 'mail' && spec.mail.thread_id) return CARD_KINDS[spec.kind].noun(spec)
  return count === null ? CARD_KINDS[spec.kind].noun(spec) : CARD_KINDS[spec.kind].counted(count)
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function isStringList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
}

/** The tool name the chat draws a card for. */
export const SHOW_TOOL_NAME = 'show'

/** True for a card spec the client can draw (the `card` field of a show result). */
export function isCardSpec(value: unknown): value is CardSpec {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.title !== 'string') return false
  if (v.kind === 'list') {
    return (CARD_LIST_ENTITIES as readonly string[]).includes(v.entity_type as string) && Array.isArray(v.filters)
  }
  if (v.kind === 'record') {
    const r = v.record as Record<string, unknown> | undefined
    return !!r && (CARD_RECORD_TYPES as readonly string[]).includes(r.type as string) && typeof r.id === 'string'
  }
  if (v.kind === 'calendar') {
    const c = v.calendar as Record<string, unknown> | undefined
    return (
      !!c &&
      typeof c.from === 'string' && ISO_DATE_RE.test(c.from) &&
      typeof c.to === 'string' && ISO_DATE_RE.test(c.to) &&
      (CALENDAR_CARD_VIEWS as readonly string[]).includes(c.view as string) &&
      isStringList(c.accounts)
    )
  }
  if (v.kind === 'mail') {
    const m = v.mail as Record<string, unknown> | undefined
    return (
      !!m &&
      (MAIL_FOLDERS as readonly string[]).includes(m.folder as string) &&
      (m.search === undefined || typeof m.search === 'string') &&
      (m.unread === undefined || typeof m.unread === 'boolean') &&
      (m.thread_id === undefined || typeof m.thread_id === 'string') &&
      (m.draft_id === undefined || typeof m.draft_id === 'string') &&
      isStringList(m.accounts)
    )
  }
  return isPageCardSpec(value)
}

/**
 * The card a `show` result describes, or null when it failed or is not one.
 * `number` is the card's number in the conversation ("card 3"), stamped by the
 * chat-agent's show proxy and stable for the conversation; null when the result
 * carries none.
 */
export function cardFromShowOutput(output: unknown): { spec: CardSpec; count: number | null; number: number | null } | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (o.success !== true || !isCardSpec(o.card)) return null
  const n = o.card_number
  return {
    spec: o.card,
    count: typeof o.count === 'number' ? o.count : null,
    number: typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null,
  }
}
