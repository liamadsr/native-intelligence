/**
 * WHAT CAN BE FOUND AND MENTIONED: one entry per kind the search finds
 * (docs/plans/mentions-everywhere.md, 3.1). The search route, the menu's tabs
 * and order, every `@` picker and the main chat's turn keys read this, so
 * adding a kind is one entry here, one query (the route's
 * `MENU_QUERIES`, a `Record` over these kinds: a kind with no query does not
 * compile) and, where the agent should read it, one reader
 * (src/lib/ai/mentioned-records.ts).
 *
 * A sibling of the entity registry (src/lib/knowledge/entity-registry.ts: the
 * graph's vocabulary) and the entity actions registry
 * (src/lib/entities/entity-actions-registry.ts: how a kind opens and is acted
 * on). This one is the search's and the pickers'.
 *
 * CLIENT-BUNDLE SAFE: plain data only.
 */
import type { EditionTerm } from '@/lib/editions/manifest'
import type { MentionableType } from '@/lib/entity-links/mentionable'
import type { EntityType } from '@/lib/knowledge/entity-registry'

/**
 * The search menu's tab GROUPS (docs/plans/mentions-everywhere.md, 3.2): with
 * two dozen kinds the strip would overflow, so each kind belongs to one group,
 * and the strip shows a tab per group (plus Pages and skills, which live at the
 * menu level, not here). A group tab lists all its kinds' sections at once.
 */
export const FINDABLE_GROUPS = [
  'people',
  'work',
  'docs',
  'meetings',
  'mail',
  'chats',
  'crm',
  'outreach',
  'files',
  'agents_skills',
  'studio',
] as const
export type FindableGroup = (typeof FINDABLE_GROUPS)[number]

export interface FindableDescriptor {
  /** The menu's section and tab for it ('actions', 'docs'…). */
  readonly section: string
  /** That tab's name. */
  readonly label: string
  /** The grouped tab it falls under in the search strip (3.2). */
  readonly group: FindableGroup
  /** The app term an edition may rename it by ("Jobs" for Actions). */
  readonly term?: EditionTerm
  /** The registered kind its rows are stored as (a deal is a pipeline's `data_row`); null for what is no entity. */
  readonly entity: EntityType | null
  /**
   * What an `@` of it stores (a `LabeledMentionRef`'s type), or null: found
   * and opened, never mentioned. Every `@` picker offers exactly the kinds
   * with one.
   */
  readonly mention: MentionableType | null
  /**
   * Its ids as a main-chat turn sends them (`context`, in the system context)
   * and as a run chat's `mentions` does (`run`). Absent: the main chat cannot
   * attach it yet (captures, people and companies have keys of their own).
   */
  readonly turnKeys?: { readonly context: string; readonly run: string }
  /** Its place among the menu's sections (`/`), lowest first. */
  readonly order: number
}

/**
 * The registry. Key order is the order the search answers in
 * (`MENU_SEARCH_KINDS`); `order` is the menu's.
 */
export const FINDABLE = {
  action: {
    section: 'actions',
    label: 'Actions',
    term: 'action',
    entity: 'action',
    mention: 'action',
    turnKeys: { context: 'attachedActionIds', run: 'actionIds' },
    group: 'work',
    order: 20,
  },
  document: {
    section: 'docs',
    label: 'Docs',
    term: 'document',
    entity: 'document',
    mention: 'document',
    turnKeys: { context: 'attachedDocumentIds', run: 'documentIds' },
    group: 'docs',
    order: 30,
  },
  project: {
    section: 'projects',
    label: 'Projects',
    term: 'project',
    entity: 'project',
    mention: 'project',
    turnKeys: { context: 'attachedProjectIds', run: 'projectIds' },
    group: 'work',
    order: 40,
  },
  initiative: {
    section: 'initiatives',
    label: 'Initiatives',
    term: 'initiative',
    entity: 'initiative',
    mention: 'initiative',
    turnKeys: { context: 'attachedInitiativeIds', run: 'initiativeIds' },
    group: 'work',
    order: 50,
  },
  capture: { section: 'captures', label: 'Captures', term: 'capture', entity: 'capture', mention: 'capture', group: 'meetings', order: 60 },
  contact: { section: 'people', label: 'People', term: 'contact', entity: 'contact', mention: 'contact', group: 'people', order: 10 },
  company: { section: 'companies', label: 'Companies', term: 'company', entity: 'company', mention: 'company', group: 'crm', order: 70 },
  // A pipeline's row (Tables, phase 7), found and listed as a deal, mentioned as the row it is.
  deal: {
    section: 'deals',
    label: 'Deals',
    term: 'deal',
    entity: 'data_row',
    mention: 'data_row',
    turnKeys: { context: 'attachedDealIds', run: 'dealIds' },
    group: 'crm',
    order: 80,
  },
  flow: {
    section: 'flows',
    label: 'Flows',
    entity: 'flow',
    mention: 'flow',
    turnKeys: { context: 'attachedFlowIds', run: 'flowIds' },
    group: 'agents_skills',
    order: 90,
  },
  attachment: {
    section: 'files',
    label: 'Files',
    entity: 'attachment',
    mention: 'attachment',
    turnKeys: { context: 'attachedFileIds', run: 'fileIds' },
    group: 'files',
    order: 100,
  },
  calendar_event: {
    section: 'events',
    label: 'Events',
    entity: 'calendar_event',
    mention: 'calendar_event',
    turnKeys: { context: 'attachedCalendarEventIds', run: 'calendarEventIds' },
    group: 'meetings',
    order: 110,
  },
  // A recipe offered as someone to @: opened, never mentioned as a record.
  agent: { section: 'agents', label: 'Agents', entity: 'recipe', mention: null, group: 'agents_skills', order: 220 },
  // A message is opened where it was said; not offered by the pickers yet.
  team_chat_message: { section: 'messages', label: 'Messages', entity: 'team_chat_message', mention: null, group: 'chats', order: 230 },
  // The Studio's (624): found only for a member who may use the Studio.
  studio_video: {
    section: 'videos',
    label: 'Videos',
    entity: 'studio_video',
    mention: 'studio_video',
    turnKeys: { context: 'attachedStudioVideoIds', run: 'studioVideoIds' },
    group: 'studio',
    order: 120,
  },
  studio_project: { section: 'studio_projects', label: 'Studio projects', entity: 'studio_project', mention: 'studio_project', group: 'studio', order: 130 },
  // ── Found since "mentions everywhere" ─────────────────────────────────────
  campaign: { section: 'campaigns', label: 'Campaigns', entity: 'campaign', mention: 'campaign', group: 'outreach', order: 140 },
  // Sequences, prospect lists and teams became graph endpoints (`linkable`) with "mentions everywhere", so a mention of one can be stored.
  sequence: { section: 'sequences', label: 'Sequences', entity: 'sequence', mention: 'sequence', group: 'outreach', order: 150 },
  prospect_list: { section: 'prospect_lists', label: 'Prospect lists', entity: 'prospect_list', mention: 'prospect_list', group: 'outreach', order: 160 },
  data_table: { section: 'tables', label: 'Tables', entity: 'data_table', mention: 'data_table', group: 'crm', order: 170 },
  // A row of a table that is not a pipeline (a pipeline's rows are deals).
  data_row: { section: 'rows', label: 'Rows', entity: 'data_row', mention: 'data_row', group: 'crm', order: 180 },
  team_chat_channel: { section: 'channels', label: 'Channels', entity: 'team_chat_channel', mention: 'team_chat_channel', group: 'chats', order: 190 },
  decision: { section: 'decisions', label: 'Decisions', entity: 'decision', mention: 'decision', group: 'meetings', order: 200 },
  // A private team is found, and mentioned, only by its members (673).
  team: { section: 'teams', label: 'Teams', entity: 'team', mention: 'team', group: 'agents_skills', order: 210 },
  // A knowledge package (673): found as RLS lets the person read it, mentioned as the `knowledge_package` it is.
  package: { section: 'packages', label: 'Packages', entity: 'knowledge_package', mention: 'knowledge_package', group: 'agents_skills', order: 215 },
  // Mail (email_thread) and agent chats (conversation): found and mentionable by their OWNER only (decisions 1); each is its person's alone (fenced on user_id).
  email_thread: { section: 'mail', label: 'Mail', entity: 'email_thread', mention: 'email_thread', group: 'mail', order: 216 },
  conversation: { section: 'chats', label: 'Chats', entity: 'conversation', mention: 'conversation', group: 'chats', order: 217 },
} as const satisfies Record<string, FindableDescriptor>

/** A kind the search finds. */
export type FindableKind = keyof typeof FINDABLE
/** The menu's section for a found kind ('actions', 'docs'…). */
export type FindableSection = (typeof FINDABLE)[FindableKind]['section']

/** Every found kind, in the order the search answers. */
export const FINDABLE_KINDS = Object.keys(FINDABLE) as FindableKind[]

export function isFindableKind(v: unknown): v is FindableKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FINDABLE, v)
}

export function findable(kind: FindableKind): FindableDescriptor {
  return FINDABLE[kind]
}

/** The found kinds in the menu's order. */
export const FINDABLE_BY_ORDER: readonly FindableKind[] = [...FINDABLE_KINDS].sort((a, b) => FINDABLE[a].order - FINDABLE[b].order)

/** The kinds an `@` picker offers: the ones a mention can store. */
export type MentionFindableKind = { [K in FindableKind]: (typeof FINDABLE)[K]['mention'] extends null ? never : K }[FindableKind]
export const MENTION_FINDABLE_KINDS = FINDABLE_BY_ORDER.filter((k) => FINDABLE[k].mention !== null) as MentionFindableKind[]

/** The kinds a main-chat turn carries by id. */
export type TurnFindableKind = { [K in FindableKind]: (typeof FINDABLE)[K] extends { turnKeys: unknown } ? K : never }[FindableKind]
export const TURN_FINDABLE_KINDS = FINDABLE_KINDS.filter((k) => 'turnKeys' in FINDABLE[k]) as TurnFindableKind[]

/** Section ⇄ kind, both ways. */
export const FINDABLE_SECTION: Record<FindableKind, FindableSection> = Object.fromEntries(
  FINDABLE_KINDS.map((k) => [k, FINDABLE[k].section]),
) as Record<FindableKind, FindableSection>
export const SECTION_FINDABLE: Record<FindableSection, FindableKind> = Object.fromEntries(
  FINDABLE_KINDS.map((k) => [FINDABLE[k].section, k]),
) as Record<FindableSection, FindableKind>

/** Each kind's grouped tab, and each section's (3.2). */
export const FINDABLE_GROUP: Record<FindableKind, FindableGroup> = Object.fromEntries(
  FINDABLE_KINDS.map((k) => [k, FINDABLE[k].group]),
) as Record<FindableKind, FindableGroup>
export const SECTION_GROUP: Record<FindableSection, FindableGroup> = Object.fromEntries(
  FINDABLE_KINDS.map((k) => [FINDABLE[k].section, FINDABLE[k].group]),
) as Record<FindableSection, FindableGroup>
