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
import type { EntityType } from '@/lib/knowledge/entity-registry'

/**
 * The kinds the search finds, in the order the menu lists them by default:
 * registered entity kinds, plus 'agent' (a recipe offered as someone to @).
 * 'team_chat_message' (migration 561): a message in a channel or DM the
 * person may read, found by its words; opened in team chat, scrolled to it.
 */
export const MENU_SEARCH_KINDS = [
  'action',
  'document',
  'project',
  'initiative',
  'capture',
  'contact',
  'company',
  'deal',
  'flow',
  'agent',
  'team_chat_message',
] as const satisfies readonly (EntityType | 'agent')[]
export type MenuSearchKind = (typeof MENU_SEARCH_KINDS)[number]

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
  id: string
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

export type MenuSearchRow =
  | MenuTeamChatMessageRow
  | MenuActionRow
  | MenuDocumentRow
  | MenuProjectRow
  | MenuInitiativeRow
  | MenuCaptureRow
  | MenuContactRow
  | MenuCompanyRow
  | MenuDealRow
  | MenuFlowRow
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

/** The record kinds a message mentions by id (captures, people and companies have their own). */
export const MENTION_RECORD_KINDS = ['action', 'document', 'project', 'initiative'] as const
export type MentionRecordKind = (typeof MENTION_RECORD_KINDS)[number]

/** An action, doc, project or initiative mentioned in the message being written. */
export interface MentionRecord {
  kind: MentionRecordKind
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
  switch (row.kind) {
    case 'action':
      return { kind: 'action', id: row.id, title: row.title, identifier: row.identifier }
    case 'document':
    case 'project':
    case 'initiative':
      return { kind: row.kind, id: row.id, title: row.title }
    default:
      return null
  }
}

/**
 * A search row as a record mention in a message's words (team chat): its kind
 * and id, and the words its `@…` shows (an action by its identifier, a capture
 * by its title, a company by its name, the rest by title). Null for what is
 * not a record (an agent).
 */
export function menuRowMention(row: MenuSearchRow): { type: Exclude<MenuSearchKind, 'agent' | 'team_chat_message'>; id: string; label: string } | null {
  switch (row.kind) {
    case 'agent':
    case 'team_chat_message':
      // Not a record a message mentions: a message is opened, never attached.
      return null
    case 'capture':
      return { type: 'capture', id: row.capture.id, label: row.capture.title || 'Untitled capture' }
    case 'contact':
      return { type: 'contact', id: row.contact.id, label: row.contact.full_name || row.contact.email || 'Unnamed contact' }
    case 'company':
      return { type: 'company', id: row.company.id, label: row.company.name }
    case 'action':
      return { type: 'action', id: row.id, label: row.identifier || row.title }
    default:
      return { type: row.kind, id: row.id, label: row.title }
  }
}
