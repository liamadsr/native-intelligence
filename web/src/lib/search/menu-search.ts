/**
 * The composer menu's search (docs/plans/slash-search.md): the kinds it finds,
 * the rows it returns, and how a row's text is scored against what's typed.
 *
 * One request (`GET /api/account/search`) answers every kind the menu asks
 * for, each kind's rows ranked by `score` (0–1, comparable across kinds), so
 * the menu can put the best match first whatever its kind.
 *
 * Client-safe and pure: the route builds the rows, the menu draws them.
 */
import type { CaptureListItem } from '@/app/account/(dashboard)/views/capture-utils'
import type { OpenTarget } from '@/lib/chat-cards/open-card'
import type { MentionableType } from '@/lib/entity-links/mentionable'
import type { EntityType } from '@/lib/knowledge/entity-registry'
import { FINDABLE, FINDABLE_KINDS, MENTION_FINDABLE_KINDS, TURN_FINDABLE_KINDS, type FindableKind, type MentionFindableKind, type TurnFindableKind } from './findable-registry'

/**
 * The kinds the search finds, in the order the menu lists them by default:
 * registered entity kinds, plus 'agent' (a recipe offered as someone to @).
 * 'team_chat_message' (migration 561): a message in a channel or DM the
 * person may read, found by its words; opened in team chat, scrolled to it.
 * 'attachment': an uploaded file the person may read (its uploader's, or on a
 * record they can see: src/lib/attachments/visibility.ts). 'calendar_event':
 * one of the person's own calendar events (each is its owner's alone).
 * 'studio_video' and 'studio_project' (migration 620): the Studio's videos and
 * Studio projects by title, for a member who may use the Studio where it is
 * on; opened as the Studio page's card on them.
 *
 * The list itself is the findable registry's (./findable-registry.ts): a kind
 * is added there.
 */
export const MENU_SEARCH_KINDS = FINDABLE_KINDS satisfies readonly (EntityType | 'agent' | 'deal' | 'package')[]
export type MenuSearchKind = FindableKind

export function isMenuSearchKind(v: unknown): v is MenuSearchKind {
  return typeof v === 'string' && (MENU_SEARCH_KINDS as readonly string[]).includes(v)
}

/** Rows per kind when the caller names no limit, and the most it may ask for. */
export const MENU_SEARCH_DEFAULT_LIMIT = 8
export const MENU_SEARCH_MAX_LIMIT = 25

/** A person (a subset of the CRM contact row). */
export interface MentionContact {
  id: string
  full_name: string | null
  email: string | null
  job_title: string | null
  company_name: string | null
  /** True when the contact is bridged to a workspace member (a teammate). */
  is_member: boolean
}

/** A company (a subset of the CRM company row). */
export interface MentionCompany {
  id: string
  name: string
  domain: string | null
  industry: string | null
  logo_url: string | null
  contact_count?: number
}

/** A `contact` row as the list route and the search read it. */
export interface ContactApiRow {
  id: string
  full_name: string | null
  email: string | null
  job_title: string | null
  member_id: string | null
  company: { id: string; name: string | null } | null
}

export function toMentionContact(row: ContactApiRow): MentionContact {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    job_title: row.job_title,
    company_name: row.company?.name ?? null,
    is_member: Boolean(row.member_id),
  }
}

/** A `list_companies_with_stats` row as far as the menu cares. */
export interface CompanyApiRow {
  id: string
  name: string | null
  domain: string | null
  logo_url: string | null
  industry: string | null
  contact_count: number | string | null
}

export function toMentionCompany(row: CompanyApiRow): MentionCompany {
  const count = row.contact_count == null ? undefined : Number(row.contact_count)
  return {
    id: row.id,
    name: row.name || row.domain || 'Unnamed company',
    domain: row.domain ?? null,
    industry: row.industry ?? null,
    logo_url: row.logo_url ?? null,
    ...(count != null && Number.isFinite(count) ? { contact_count: count } : {}),
  }
}

// ── The rows ─────────────────────────────────────────────────────────────────

interface Scored {
  /** 0–1: how well it matches what's typed (0 with nothing typed). */
  score: number
}

export interface MenuActionRow extends Scored {
  kind: 'action'
  id: string
  title: string
  identifier: string | null
  /** Its board column's name ("In progress"). */
  status: string | null
}

export interface MenuDocumentRow extends Scored {
  kind: 'document'
  id: string
  title: string
  updatedAt: string | null
}

export interface MenuProjectRow extends Scored {
  kind: 'project'
  id: string
  title: string
  status: string | null
}

export interface MenuInitiativeRow extends Scored {
  kind: 'initiative'
  id: string
  title: string
  status: string | null
}

export interface MenuCaptureRow extends Scored {
  kind: 'capture'
  capture: CaptureListItem
}

export interface MenuContactRow extends Scored {
  kind: 'contact'
  contact: MentionContact
}

export interface MenuCompanyRow extends Scored {
  kind: 'company'
  company: MentionCompany
}

export interface MenuDealRow extends Scored {
  kind: 'deal'
  /** The row's id (a deal is a pipeline's row). */
  id: string
  /** Its pipeline (the table it is a row of). */
  pipelineId: string
  title: string
  /** Its pipeline stage's name ("Proposal sent"). */
  status: string | null
}

export interface MenuFlowRow extends Scored {
  kind: 'flow'
  id: string
  title: string
  /** 'On' or 'Off'. */
  status: string | null
}

export interface MenuFileRow extends Scored {
  kind: 'attachment'
  id: string
  /** Its file name. */
  title: string
  /** 'image' or 'document'. */
  category: string | null
  /** The record it hangs off (what opening it opens): a capture, a task or a project. */
  parent: { type: 'capture' | 'action' | 'project'; id: string } | null
  createdAt: string | null
}

export interface MenuCalendarEventRow extends Scored {
  kind: 'calendar_event'
  id: string
  title: string
  /** ISO times. */
  start: string
  end: string | null
  allDay: boolean
}

export interface MenuAgentRow extends Scored {
  kind: 'agent'
  id: string
  title: string
  description: string | null
  icon: string | null
}

export interface MenuTeamChatMessageRow extends Scored {
  kind: 'team_chat_message'
  id: string
  /** The words that matched (a passage of the message). */
  title: string
  /** Where it was said: "#general", or the DM's other person. */
  place: string
  /** Who wrote it (a member, or an agent by its name). */
  author: string
  channelId: string
  /** The thread it is a reply in (its root), or null. */
  threadRootId: string | null
  createdAt: string
}

/** A Studio video or Studio project (titles only: the Studio's tables are read on the server, for members but guests). */
export interface MenuStudioRow extends Scored {
  kind: 'studio_video' | 'studio_project'
  id: string
  title: string
  /** A video's status (draft, review, approved); a Studio project's video count ("3 videos"). */
  status: string | null
}

/** The kinds found by a name and listed alike: no fields of their own beyond a status and where they live. */
export type MenuNamedKind =
  | 'campaign'
  | 'sequence'
  | 'prospect_list'
  | 'data_table'
  | 'data_row'
  | 'team_chat_channel'
  | 'decision'
  | 'team'
  | 'package'
  | 'conversation'
  | 'email_thread'

/**
 * A campaign, sequence, prospect list, table, table row, channel, decision,
 * team, knowledge package, the caller's own agent chat (`conversation`) or
 * their own mail thread (`email_thread`): its name (a decision's words, a
 * chat's title, a thread's subject or sender), a quiet word about it, and
 * what opening it needs beyond its own id (a row's table, a thread's provider
 * id to open the mail card).
 */
export interface MenuNamedRow extends Scored {
  kind: MenuNamedKind
  id: string
  title: string
  /** A quiet word after the name: a status ("Active"), a row's table, a decision's capture. */
  status: string | null
  /** What it opens in: a row's table, a decision's capture. Null for the rest. */
  parentId: string | null
}

export type MenuSearchRow =
  | MenuNamedRow
  | MenuTeamChatMessageRow
  | MenuStudioRow
  | MenuActionRow
  | MenuDocumentRow
  | MenuProjectRow
  | MenuInitiativeRow
  | MenuCaptureRow
  | MenuContactRow
  | MenuCompanyRow
  | MenuDealRow
  | MenuFlowRow
  | MenuFileRow
  | MenuCalendarEventRow
  | MenuAgentRow

/** What the route answers: each kind asked for, its rows best first. */
export interface MenuSearchResponse {
  query: string
  results: Partial<Record<MenuSearchKind, MenuSearchRow[]>>
}

/** A row's id, whatever its kind. */
export function menuRowId(row: MenuSearchRow): string {
  switch (row.kind) {
    case 'capture':
      return row.capture.id
    case 'contact':
      return row.contact.id
    case 'company':
      return row.company.id
    default:
      return row.id
  }
}

/** What opening a row opens: its record's card (an agent's, the library on it). */
export function menuRowTarget(row: MenuSearchRow): OpenTarget {
  switch (row.kind) {
    case 'capture':
      return { type: 'capture', id: row.capture.id, title: row.capture.title }
    case 'contact':
      return { type: 'contact', id: row.contact.id, title: row.contact.full_name || row.contact.email }
    case 'company':
      return { type: 'company', id: row.company.id, title: row.company.name }
    case 'agent':
      return { type: 'agent', id: row.id, title: row.title }
    case 'team_chat_message':
      return { type: 'team_chat', messageId: row.id, channelId: row.channelId }
    case 'deal':
      return { type: 'deal', id: row.id, title: row.title, pipelineId: row.pipelineId }
    case 'attachment':
      // A file lives on its record: opening it opens that record's card.
      return row.parent ? { type: row.parent.type, id: row.parent.id, title: null } : { type: 'page', slug: 'captures' }
    case 'calendar_event':
      return { type: 'calendar-event', id: row.id, title: row.title, start: row.start }
    case 'studio_video':
    case 'studio_project':
      // The Studio page's card, on it (open-card.ts).
      return { type: row.kind, id: row.id, title: row.title }
    case 'campaign':
      // No card draws one campaign: its page lists them.
      return { type: 'page', slug: 'campaigns' }
    case 'data_table':
      return { type: 'page', slug: 'tables' }
    case 'data_row':
      return { type: 'data_row', id: row.id, title: row.title, tableId: row.parentId }
    case 'team_chat_channel':
      return { type: 'team_chat', channelId: row.id }
    case 'decision':
      // A decision lives on its capture.
      return row.parentId ? { type: 'capture', id: row.parentId, title: null } : { type: 'page', slug: 'captures' }
    case 'email_thread':
      // Mail opens the mail card on its provider thread (held in parentId);
      // stored nowhere, read live from the owner's mailbox.
      return row.parentId ? { type: 'mail', threadId: row.parentId, title: row.title } : { type: 'page', slug: 'mail' }
    case 'conversation':
      // No card draws a past agent chat, and the menu has no chats-list page,
      // so opening a chat row is a no-op today (cardForTarget returns null for
      // an unknown slug). Resuming a past chat is chat-panel's loadConversation;
      // wiring the composer's onOpenRecord to it is the composer's to do.
      return { type: 'page', slug: 'chats' }
    case 'sequence':
    case 'prospect_list':
    case 'team':
    case 'package':
      return { type: row.kind, id: row.id, title: row.title }
    default:
      return { type: row.kind, id: row.id, title: row.title }
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** A match found only in a record's body (a transcript, a doc's text): under any title match. */
export const BODY_MATCH_SCORE = 0.3

/** What's typed, as the search reads it: trimmed, lower case, single spaces. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** An action's identifier being typed: `GEN-42`, or `GEN-` on the way there. */
export const IDENTIFIER_QUERY = /^[a-z]+-\d*$/i

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * How well `text` matches the query, 0–1: the whole of it (1), its start
 * (0.85), the start of a word in it (0.7: "page" in "Pricing page copy"),
 * anywhere in it (0.5), or every word of a several-word query somewhere in it
 * (0.45: "pricing acme" in "Send pricing to Acme").
 */
export function scoreText(text: string | null | undefined, query: string): number {
  const s = normalizeQuery(text ?? '')
  const q = normalizeQuery(query)
  if (!s || !q) return 0
  if (s === q) return 1
  if (s.startsWith(q)) return 0.85
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, 'u').test(s)) return 0.7
  if (s.includes(q)) return 0.5
  const words = q.split(' ')
  if (words.length > 1 && words.every((w) => s.includes(w))) return 0.45
  return 0
}

/** An action's identifier against the query: exact above everything, a prefix just under an exact title. */
export function scoreIdentifier(identifier: string | null | undefined, query: string): number {
  const id = (identifier ?? '').toLowerCase()
  const q = normalizeQuery(query)
  if (!id || !q || !IDENTIFIER_QUERY.test(q)) return 0
  if (id === q) return 1.1
  if (id.startsWith(q)) return 0.9
  return 0
}

/** The best of several scores (a contact's name or email, a company's name or domain). */
export function bestScore(...scores: number[]): number {
  return Math.max(0, ...scores)
}

// ── Records mentioned in a message ───────────────────────────────────────────

/**
 * What every `@` picker finds, in one list: the main chat's, team chat's and a
 * document's. People are contacts (every teammate has one, linked to their
 * member row); team chat lists its teammates from its own members and leaves
 * their contacts out. The kinds are the findable registry's with a `mention`
 * (./findable-registry.ts). Not mail yet (its owner's alone until the share a
 * mention makes is built: docs/plans/mentions-everywhere.md, decision 1), not
 * agents or messages (opened, never mentioned).
 */
export const MENTION_PICKER_KINDS: readonly MentionFindableKind[] = MENTION_FINDABLE_KINDS
export type MentionPickerKind = MentionFindableKind

/**
 * The record kinds a message mentions by id (captures, people and companies have their own). A Studio video comes
 * back from the search only for a member who may use the Studio, and its line is read again on the server for them.
 */
export const MENTION_RECORD_KINDS: readonly TurnFindableKind[] = TURN_FINDABLE_KINDS
export type MentionRecordKind = TurnFindableKind

/**
 * Each record kind's ids as a turn sends them: in the main chat's system
 * context (`attachedActionIds`…) and in a run chat's `mentions`
 * (`actionIds`…). One table, read by the composer and both servers.
 */
export const MENTION_RECORD_KEYS: Record<MentionRecordKind, { context: string; run: string }> = Object.fromEntries(
  TURN_FINDABLE_KINDS.map((kind) => [kind, FINDABLE[kind].turnKeys]),
) as Record<MentionRecordKind, { context: string; run: string }>

/**
 * Every record kind a composer attaches as a chip: the pickers' kinds, less
 * the three with chips of their own (captures, people, companies).
 */
export type ComposerRecordKind = Exclude<MentionPickerKind, 'capture' | 'contact' | 'company'>
export const COMPOSER_RECORD_KINDS = MENTION_PICKER_KINDS.filter(
  (k): k is ComposerRecordKind => k !== 'capture' && k !== 'contact' && k !== 'company',
)

/**
 * The system-context key for the mentioned records that have no id key of
 * their own (MENTION_RECORD_KEYS): `[{ type, id, label }]`, the one mention
 * format (src/lib/entity-links/mentionable.ts LabeledMentionRef). A campaign,
 * a table, a row, a channel, a decision, a Studio project.
 */
export const MENTIONED_RECORDS_CONTEXT_KEY = 'mentionedRecords'

/** The stored kinds that travel under MENTIONED_RECORDS_CONTEXT_KEY (the pickers' kinds with no id key). */
export const UNKEYED_MENTION_TYPES: readonly MentionableType[] = [
  ...new Set(COMPOSER_RECORD_KINDS.filter((k) => !('turnKeys' in FINDABLE[k])).map((k) => FINDABLE[k].mention as MentionableType)),
]

/**
 * A record mentioned in the message being written: a task, doc, project,
 * initiative, deal, flow, file, event, Studio video or Studio project, a
 * campaign, a table or its row, a channel, a decision. A deal's id is its
 * pipeline row's (Tables, phase 7).
 */
export interface MentionRecord {
  kind: ComposerRecordKind
  id: string
  title: string
  identifier?: string | null
}

/** What the message says for it: an action by its identifier (`@GEN-42`), the rest by name. */
export function mentionRecordLabel(record: MentionRecord): string {
  return record.kind === 'action' && record.identifier ? record.identifier : record.title
}

/** The mention a search row makes, or null for a kind mentioned another way. */
export function toMentionRecord(row: MenuSearchRow): MentionRecord | null {
  if (row.kind === 'capture' || row.kind === 'contact' || row.kind === 'company') return null
  if (!(COMPOSER_RECORD_KINDS as readonly string[]).includes(row.kind)) return null
  const kind = row.kind as ComposerRecordKind
  return row.kind === 'action' ? { kind, id: row.id, title: row.title, identifier: row.identifier } : { kind, id: row.id, title: row.title }
}

/** A row's record as a mention: its kind and id, and the words its `@…` shows. */
export interface MenuRowMention {
  /** A deal is mentioned as what it is: its pipeline's row (Tables, phase 7). */
  type: MentionableType
  id: string
  label: string
}

/**
 * A search row as a record mention in a message's or document's words (team
 * chat, the doc editor): its kind and id, and the words its `@…` shows (an
 * action by its identifier, a capture by its title, a company by its name, the
 * rest by title). Null for what is not a record (an agent, a message).
 */
export function menuRowMention(row: MenuSearchRow): MenuRowMention | null {
  switch (row.kind) {
    case 'capture':
      return { type: 'capture', id: row.capture.id, label: row.capture.title || 'Untitled capture' }
    case 'contact':
      return { type: 'contact', id: row.contact.id, label: row.contact.full_name || row.contact.email || 'Unnamed contact' }
    case 'company':
      return { type: 'company', id: row.company.id, label: row.company.name }
    case 'action':
      return { type: 'action', id: row.id, label: row.identifier || row.title }
    default: {
      // The kind a mention of it stores (a deal: its pipeline's row), or null
      // for what is found and opened, never mentioned (an agent, a message).
      const type = FINDABLE[row.kind].mention
      return type ? { type, id: row.id, label: row.title } : null
    }
  }
}
