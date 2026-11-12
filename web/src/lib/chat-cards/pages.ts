/**
 * Every other page as a card (docs/plans/one-agent-and-chat-pages.md, Part 1
 * "Every page as a card", phase P3): the team boards, sequences, prospecting,
 * flows, evals, campaigns, knowledge, agents & skills, teams and the
 * browser; and (P5) a bot's page and a work item with no bot's page to open
 * on, and (guest access) a guest's conversation, and (agent links) a linked
 * person's agent's conversation with theirs, which only the person opens.
 *
 * These pages are not one filtered list the way a `list` card is. Each is its
 * own page with places inside it: the sequences list and one sequence, the
 * prospect lists and one list's entries, an eval suite and its cases. So a
 * page card says only which page, where in it to open (`target`) and, for a
 * page with sub-views, which one (`tab`). The team board is the one that
 * takes filters too: it is a list of actions, scoped to one team.
 *
 * What the person does inside a page card (opening a sequence, switching a
 * suite's tab, filtering the list they are on) is kept with the card, and the
 * agent hears about it through the same cards note and read_card as a list
 * card (./context.ts, ./page-server.ts).
 *
 * One entry per kind in PAGE_KINDS below; the server half is
 * ./page-server.ts and the client half src/components/chat-cards/pages/.
 *
 * Client-safe: no server imports.
 */
import type { EditionView } from '@/lib/editions/manifest'
import type { ViewEntityType } from '@/lib/views/types'
import type { CardFilter, CardQuery } from './kinds'

export const PAGE_KIND_NAMES = [
  'team_board',
  'sequences',
  'prospecting',
  'flows',
  'evals',
  'campaigns',
  'tables',
  'pipelines',
  'knowledge',
  'library',
  'teams',
  'team_chat',
  'bot',
  'work_item',
  'guest',
  'agent_link',
] as const
export type PageKind = (typeof PAGE_KIND_NAMES)[number]

/** The places inside a page a card can open on, or the person can open. */
export const PAGE_PLACE_TYPES = [
  'team',
  'sequence',
  'prospect_list',
  'eval_suite',
  'eval_case',
  'eval_run',
  'package',
  'agent',
  'skill',
  'bot',
  'work_item',
  'guest',
  'guest_message',
  'agent_link',
  'agent_link_exchange',
  'team_chat_channel',
  'team_chat_message',
  'data_table',
  'data_row',
] as const
export type PagePlaceType = (typeof PAGE_PLACE_TYPES)[number]

/** One place inside a page: a team, a sequence, a prospect list… */
export interface PagePlace {
  type: PagePlaceType
  id: string
  /** Its name, for the card and the note. */
  label?: string
  /** The place it is inside, by id: a row's table. */
  in?: string
}

/** What a page card shows. */
export interface PageCardSpec {
  kind: PageKind
  title: string
  /** The one thing it opens on. Absent: the page's top level. */
  target?: PagePlace
  /** A sub-view of the page (see each kind's `tabs`). Absent: its default. */
  tab?: string
  /** team_board only: the board's actions, filtered (all must match). */
  filters?: CardFilter[]
}

export interface PageKindDef {
  /** The page's name, as the card's header and pill say it. */
  label: string
  /** What the card's rows are, plural, at the page's top level ("sequences"). */
  rows: string
  /**
   * The edition view whose gate the page shares (isViewAllowed). Absent: the
   * page is never gated (a bot's page is the person's own teammate's).
   */
  view?: EditionView
  /** What `target` may name, and whether the page needs one. */
  target?: { types: readonly PagePlaceType[]; required?: boolean }
  /** Its sub-views, the first being the default. */
  tabs?: readonly string[]
  /**
   * The views-system list the page draws at its top level, if any: what
   * read_card re-runs (with the person's filters) and the note diffs.
   */
  rootEntity?: ViewEntityType
  /** The list drawn inside a place, by `type:tab` first, then `type`. */
  placeEntity?: Partial<Record<string, ViewEntityType>>
  /** Only the desktop app can draw it. */
  desktopOnly?: boolean
  /**
   * Only the person opens it (a click on a bot, a work item): `show` doesn't
   * offer it (SHOW_PAGE_KIND_NAMES), and read_card says where to look instead.
   */
  personOnly?: boolean
}

/**
 * The kinds. Each `view` is the nav's own gate for that page (the rail's
 * visibleNavItems reads the same composed edition surface), so a page that is
 * off in a workspace is off as a card too.
 */
export const PAGE_KINDS: Record<PageKind, PageKindDef> = {
  team_board: {
    label: 'Team board',
    rows: 'actions',
    view: 'team-actions',
    target: { types: ['team'], required: true },
    placeEntity: { team: 'action' },
  },
  sequences: {
    label: 'Sequences',
    rows: 'sequences',
    view: 'sequences',
    target: { types: ['sequence'] },
    rootEntity: 'sequence',
  },
  prospecting: {
    label: 'Prospecting',
    rows: 'prospect lists',
    view: 'prospecting',
    target: { types: ['prospect_list'] },
    rootEntity: 'prospect_list',
    placeEntity: { prospect_list: 'prospect_list_entry' },
  },
  flows: {
    label: 'Flows',
    rows: 'flows',
    view: 'flows',
    rootEntity: 'flow',
  },
  evals: {
    label: 'Evals',
    rows: 'eval suites',
    view: 'evals',
    target: { types: ['eval_suite'] },
    tabs: ['overview', 'cases', 'runs'],
    rootEntity: 'eval_suite',
    placeEntity: { 'eval_suite:cases': 'eval_case', 'eval_suite:runs': 'eval_run' },
  },
  campaigns: {
    label: 'Campaigns',
    rows: 'campaigns',
    view: 'campaigns',
  },
  // Tables (phase 1, migration 520): the workspace's own databases. Gated with
  // Docs, where a workspace keeps what it writes down. `show` opens it on a
  // table (phase 5), in a layout (`tab`), or on one row: a row's record card
  // (`in` names its table).
  tables: {
    label: 'Tables',
    rows: 'tables',
    view: 'docs',
    target: { types: ['data_table', 'data_row'] },
    tabs: ['grid', 'board', 'calendar', 'gallery'],
  },
  // Deals (Tables, phase 7): the pipelines, each a table whose rows are
  // deals. It opens on the default pipeline's board; `target` is a pipeline,
  // or one deal (`in` names its pipeline). It shares the Companies page's
  // gate, as the deals list did.
  pipelines: {
    label: 'Deals',
    rows: 'pipelines',
    view: 'companies',
    target: { types: ['data_table', 'data_row'] },
    tabs: ['board', 'grid', 'calendar', 'gallery'],
  },
  knowledge: {
    label: 'Knowledge',
    rows: 'claims',
    view: 'knowledge',
    target: { types: ['package'] },
    tabs: ['claims', 'library'],
    rootEntity: 'claim',
  },
  library: {
    label: 'Agents & skills',
    rows: 'agents',
    view: 'agents',
    target: { types: ['agent', 'skill'] },
    tabs: ['agents', 'skills'],
  },
  teams: {
    label: 'Teams',
    rows: 'teams',
    view: 'teams',
    target: { types: ['team'] },
  },
  // Team chat (roadmap #7, migration 474): the workspace's channels and DMs.
  // Gated with Teams (always allowed): it is the team talking. The person
  // opens it (from `/`); `show` doesn't offer it, so the agent's tools don't change.
  // `at` (never `target`, so there is one team chat card): a channel, or one
  // message to open on (a notification, a search hit), in its channel or thread.
  team_chat: {
    label: 'Team chat',
    rows: 'channels',
    view: 'teams',
    personOnly: true,
  },
  // One AI teammate's page (bots-v4.md "A bot's page"): its chat and its work.
  // `target` is the teammate; `at` a work item of its open on the page.
  bot: {
    label: 'Agent page',
    rows: 'work items',
    target: { types: ['bot'], required: true },
    personOnly: true,
  },
  // A work item with no bot's page to open on (a sequence send, a workspace
  // with no Assistant known): its panel, on its own. It used to open over the
  // inbox card, which went with the notifications page
  // (docs/plans/retire-notifications-page.md). `target` is the item.
  work_item: {
    label: 'Work item',
    rows: 'work items',
    target: { types: ['work_item'], required: true },
    personOnly: true,
  },
  // One guest's conversation with the agent the owner made for them (guest
  // access): read-only, opened from their request or activity card in the
  // chat. `target` is the guest; `at` a message of theirs to open on.
  guest: {
    label: 'Conversation',
    rows: 'messages',
    target: { types: ['guest'], required: true },
    personOnly: true,
  },
  // The conversation between the person's agent and one linked person's
  // agent (agent links): every exchange, read-only, opened from the line over
  // a held card or an exchange's log line in the chat. `target` is the link;
  // `at` an exchange to open on.
  agent_link: {
    label: 'Agents',
    rows: 'messages',
    target: { types: ['agent_link'], required: true },
    personOnly: true,
  },
}

/** The page kinds `show` offers: every one the person alone doesn't open. */
export const SHOW_PAGE_KIND_NAMES = PAGE_KIND_NAMES.filter((k) => !PAGE_KINDS[k].personOnly) as Exclude<PageKind, 'bot' | 'work_item' | 'guest' | 'agent_link' | 'team_chat'>[]

/** What each place is called, in the note and in refusals. */
export const PLACE_NOUN: Record<PagePlaceType, string> = {
  team: 'team',
  sequence: 'sequence',
  prospect_list: 'prospect list',
  eval_suite: 'eval suite',
  eval_case: 'eval case',
  eval_run: 'eval run',
  package: 'knowledge package',
  agent: 'agent',
  skill: 'skill',
  bot: 'bot',
  work_item: 'work item',
  guest: 'person',
  guest_message: 'message',
  agent_link: 'link',
  agent_link_exchange: 'conversation',
  team_chat_channel: 'channel',
  team_chat_message: 'message',
  data_table: 'table',
  data_row: 'row',
}

export function isPageKind(value: unknown): value is PageKind {
  return typeof value === 'string' && (PAGE_KIND_NAMES as readonly string[]).includes(value)
}

export function isPagePlace(value: unknown): value is PagePlace {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    (PAGE_PLACE_TYPES as readonly string[]).includes(v.type as string) &&
    typeof v.id === 'string' &&
    !!v.id &&
    (v.in === undefined || typeof v.in === 'string')
  )
}

/** The tab a page card is on: the one asked for, else the kind's default. */
export function pageTab(kind: PageKind, tab: string | undefined): string | undefined {
  const tabs = PAGE_KINDS[kind].tabs
  if (!tabs) return undefined
  return tab && tabs.includes(tab) ? tab : tabs[0]
}

/**
 * The views-system list a page shows at a place (null: its top level), on a
 * tab, if it shows one there. Knowledge's library tab is not a list of
 * claims, so it has none; neither has one sequence or one team.
 */
export function pageListEntity(kind: PageKind, place: PagePlace | null, tab: string | undefined): ViewEntityType | null {
  const def = PAGE_KINDS[kind]
  if (!place) {
    if (kind === 'knowledge' && pageTab(kind, tab) === 'library') return null
    return def.rootEntity ?? null
  }
  const entities = def.placeEntity ?? {}
  return entities[`${place.type}:${tab ?? ''}`] ?? entities[place.type] ?? null
}

/** Every views-system list a page kind shows, at its top level or inside a place. */
export function pageEntities(kind: PageKind): Set<ViewEntityType> {
  const def = PAGE_KINDS[kind]
  const out = new Set<ViewEntityType>(Object.values(def.placeEntity ?? {}).filter((x): x is ViewEntityType => !!x))
  if (def.rootEntity) out.add(def.rootEntity)
  return out
}

/** The query the agent asked for on a page card: a team board's filters, drawn as a board. */
export function pageBaseQuery(spec: PageCardSpec): CardQuery {
  return { filters: spec.filters ?? [], ...(spec.kind === 'team_board' ? { layout: 'board' as const } : {}) }
}

/** True for a page card spec the client can draw. */
export function isPageCardSpec(value: unknown): value is PageCardSpec {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!isPageKind(v.kind) || typeof v.title !== 'string') return false
  const def = PAGE_KINDS[v.kind]
  if (v.target !== undefined && (!isPagePlace(v.target) || !def.target?.types.includes(v.target.type))) return false
  if (def.target?.required && v.target === undefined) return false
  if (v.tab !== undefined && (typeof v.tab !== 'string' || !def.tabs?.includes(v.tab))) return false
  if (v.filters !== undefined && !Array.isArray(v.filters)) return false
  return true
}
