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

export interface FindableDescriptor {
  /** The menu's section and tab for it ('actions', 'docs'…). */
  readonly section: string
  /** That tab's name. */
  readonly label: string
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
    order: 20,
  },
  document: {
    section: 'docs',
    label: 'Docs',
    term: 'document',
    entity: 'document',
    mention: 'document',
    turnKeys: { context: 'attachedDocumentIds', run: 'documentIds' },
    order: 30,
  },
  project: {
    section: 'projects',
    label: 'Projects',
    term: 'project',
    entity: 'project',
    mention: 'project',
    turnKeys: { context: 'attachedProjectIds', run: 'projectIds' },
    order: 40,
  },
  initiative: {
    section: 'initiatives',
    label: 'Initiatives',
    term: 'initiative',
    entity: 'initiative',
    mention: 'initiative',
    turnKeys: { context: 'attachedInitiativeIds', run: 'initiativeIds' },
    order: 50,
  },
  capture: { section: 'captures', label: 'Captures', term: 'capture', entity: 'capture', mention: 'capture', order: 60 },
  contact: { section: 'people', label: 'People', term: 'contact', entity: 'contact', mention: 'contact', order: 10 },
  company: { section: 'companies', label: 'Companies', term: 'company', entity: 'company', mention: 'company', order: 70 },
  // A pipeline's row (Tables, phase 7), found and listed as a deal, mentioned as the row it is.
  deal: {
    section: 'deals',
    label: 'Deals',
    term: 'deal',
    entity: 'data_row',
    mention: 'data_row',
    turnKeys: { context: 'attachedDealIds', run: 'dealIds' },
    order: 80,
  },
  flow: {
    section: 'flows',
    label: 'Flows',
    entity: 'flow',
    mention: 'flow',
    turnKeys: { context: 'attachedFlowIds', run: 'flowIds' },
    order: 90,
  },
  attachment: {
    section: 'files',
    label: 'Files',
    entity: 'attachment',
    mention: 'attachment',
    turnKeys: { context: 'attachedFileIds', run: 'fileIds' },
    order: 100,
  },
  calendar_event: {
    section: 'events',
    label: 'Events',
    entity: 'calendar_event',
    mention: 'calendar_event',
    turnKeys: { context: 'attachedCalendarEventIds', run: 'calendarEventIds' },
    order: 110,
  },
  // A recipe offered as someone to @: opened, never mentioned as a record.
  agent: { section: 'agents', label: 'Agents', entity: 'recipe', mention: null, order: 220 },
  // A message is opened where it was said; not offered by the pickers yet.
  team_chat_message: { section: 'messages', label: 'Messages', entity: 'team_chat_message', mention: null, order: 230 },
  // The Studio's (624): found only for a member who may use the Studio.
  studio_video: {
    section: 'videos',
    label: 'Videos',
    entity: 'studio_video',
    mention: 'studio_video',
    turnKeys: { context: 'attachedStudioVideoIds', run: 'studioVideoIds' },
    order: 120,
  },
  studio_project: { section: 'studio_projects', label: 'Studio projects', entity: 'studio_project', mention: 'studio_project', order: 130 },
  // ── Found since "mentions everywhere" ─────────────────────────────────────
  campaign: { section: 'campaigns', label: 'Campaigns', entity: 'campaign', mention: 'campaign', order: 140 },
  // Sequences and prospect lists are not graph endpoints (not `linkable`), so nothing can store a mention of one yet.
  sequence: { section: 'sequences', label: 'Sequences', entity: 'sequence', mention: null, order: 150 },
  prospect_list: { section: 'prospect_lists', label: 'Prospect lists', entity: 'prospect_list', mention: null, order: 160 },
  data_table: { section: 'tables', label: 'Tables', entity: 'data_table', mention: 'data_table', order: 170 },
  // A row of a table that is not a pipeline (a pipeline's rows are deals).
  data_row: { section: 'rows', label: 'Rows', entity: 'data_row', mention: 'data_row', order: 180 },
  team_chat_channel: { section: 'channels', label: 'Channels', entity: 'team_chat_channel', mention: 'team_chat_channel', order: 190 },
  decision: { section: 'decisions', label: 'Decisions', entity: 'decision', mention: 'decision', order: 200 },
  team: { section: 'teams', label: 'Teams', entity: 'team', mention: null, order: 210 },
  // A knowledge package: not a registered entity kind.
  package: { section: 'packages', label: 'Packages', entity: null, mention: null, order: 215 },
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
