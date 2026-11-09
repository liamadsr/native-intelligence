/**
 * The instant path (docs/plans/one-agent-and-chat-pages.md, Part 2 "Two
 * things must exist before the nav can go", decision 7): typing `/` in the
 * composer lists the pages, and picking one puts its card in the chat at
 * once, with no model call.
 *
 * Each page here is a card kind (./kinds.ts) opened on a sensible default
 * view: My Actions is the actions assigned to you that are still open, Mail is
 * the inbox, the calendar is this week. A page is offered only where its card
 * can be drawn and its page is on in the workspace: the same view gate the nav
 * uses and `show` checks for the page kinds (isViewAllowed over the
 * workspace's composed edition; gatePage on the server), and the desktop for
 * the browser. Calendar and mail are the person's own data: like `show`'s
 * per-person gate (PERSONAL_CARD_TOOLS), they are offered only where the chat
 * may read them with get_calendar_events / list_emails, because the card's
 * rows reach the agent through the cards note.
 *
 * ── Every kind gets a page ──────────────────────────────────────────────────
 * The entries name kinds that arrive in later phases too (calendar and mail
 * from P2, the eleven page kinds from P3). A page's spec is checked with
 * isCardSpec when the menu is built, so a kind this build does not have yet
 * drops out on its own and appears the moment it lands. The tests hold every
 * kind in CARD_KIND_NAMES to an entry here (or a reason it has none in
 * NO_PAGE_KINDS), so a new kind can't be missed from `/`.
 *
 * Client-safe and pure.
 */
import { isViewAllowed, type EditionDefinition, type EditionView } from '@/lib/editions/manifest'
import { pageWords } from '@/lib/editions/words'
import { isCardSpec, type CardSpec } from './kinds'
import { calendarRange, localIsoDate } from './calendar'

export interface CardPage {
  /** What `/` matches and shows: `/actions`. */
  slug: string
  /** The page's plain name. */
  label: string
  /** One line on what the card opens on. */
  description: string
  /** The card kind it opens (CARD_KIND_NAMES). */
  kind: string
  /** The edition view whose gate the page shares with the nav. */
  view: EditionView
  /** Other words that find it ("crm" for Contacts). */
  keywords?: readonly string[]
  /** Only the desktop app can draw it. */
  desktopOnly?: boolean
  /**
   * The person's own data: offered only where the chat may call this tool
   * (show's PERSONAL_CARD_TOOLS; the tests hold the two to the same names).
   */
  personalTool?: 'get_calendar_events' | 'list_emails'
  /**
   * The card it opens, built at the moment it is picked (a calendar's "this
   * week" is the week it is opened in). Checked with isCardSpec before use.
   */
  spec: (now: Date) => unknown
}

/** The page as the menu offers it: its spec checked. */
export interface OfferedPage extends Omit<CardPage, 'spec'> {
  spec: (now: Date) => CardSpec
  /**
   * What the person sees and types after `/` in this workspace's words
   * (`jobs` for My Actions in a service business). Absent: `slug`, which
   * stays the page's id either way.
   */
  shownSlug?: string
}

/** This week as the calendar grid draws it (Sunday to Saturday), in the person's own days. */
export function thisWeek(now: Date): { from: string; to: string } {
  return calendarRange('week', localIsoDate(now))
}

const list = (title: string, entity_type: string, filters: unknown[] = []) => () => ({ kind: 'list', title, entity_type, filters })
const page = (kind: string, title: string) => () => ({ kind, title })

/**
 * The pages, in the nav's order. Kinds that need a record to open on (a
 * record card, one team's board) are not pages: see NO_PAGE_KINDS.
 */
export const CARD_PAGES: readonly CardPage[] = [
  {
    slug: 'calendar',
    label: 'Calendar',
    description: 'This week',
    kind: 'calendar',
    view: 'calendar',
    keywords: ['events', 'meetings', 'schedule'],
    personalTool: 'get_calendar_events',
    spec: (now) => ({ kind: 'calendar', title: 'This week', calendar: { ...thisWeek(now), view: 'week' } }),
  },
  {
    slug: 'actions',
    label: 'My Actions',
    description: 'Assigned to you and still open',
    kind: 'list',
    view: 'todo',
    keywords: ['tasks', 'todo', 'to do'],
    spec: list('My actions', 'action', [
      { field: 'assignee_id', operator: 'is', value: '@me' },
      { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
    ]),
  },
  { slug: 'captures', label: 'Captures', description: 'Your meetings and notes', kind: 'list', view: 'captures', keywords: ['meetings', 'notes', 'recordings'], spec: list('Captures', 'capture') },
  { slug: 'docs', label: 'Docs', description: 'Every doc', kind: 'list', view: 'docs', keywords: ['documents'], spec: list('Docs', 'document') },
  { slug: 'knowledge', label: 'Knowledge', description: 'What Dial8 knows', kind: 'knowledge', view: 'knowledge', keywords: ['claims', 'graph'], spec: page('knowledge', 'Knowledge') },
  { slug: 'initiatives', label: 'Initiatives', description: 'Every initiative', kind: 'list', view: 'initiatives', spec: list('Initiatives', 'initiative') },
  { slug: 'projects', label: 'Projects', description: 'Every project', kind: 'list', view: 'projects', spec: list('Projects', 'project') },
  { slug: 'flows', label: 'Flows', description: 'Your automations', kind: 'flows', view: 'flows', keywords: ['automations', 'loops'], spec: page('flows', 'Flows') },
  {
    slug: 'mail',
    label: 'Mail',
    description: 'Your inbox',
    kind: 'mail',
    view: 'mail',
    keywords: ['email', 'inbox'],
    personalTool: 'list_emails',
    spec: () => ({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }),
  },
  { slug: 'contacts', label: 'Contacts', description: 'Your CRM contacts', kind: 'list', view: 'contacts', keywords: ['crm', 'people'], spec: list('Contacts', 'contact') },
  // The pipeline board (roadmap #8). It shares the Companies page's gate: deals
  // are the CRM's accounts at work, on wherever companies are.
  {
    slug: 'deals',
    label: 'Deals',
    description: 'Your pipeline, by stage',
    kind: 'list',
    view: 'companies',
    keywords: ['crm', 'pipeline', 'opportunities', 'sales'],
    spec: () => ({ kind: 'list', title: 'Deals', entity_type: 'deal', filters: [], layout: 'board', grouping: { field: 'stage_id', direction: 'asc' } }),
  },
  { slug: 'companies', label: 'Companies', description: 'Your CRM companies', kind: 'list', view: 'companies', keywords: ['crm', 'accounts'], spec: list('Companies', 'company') },
  { slug: 'prospecting', label: 'Prospecting', description: 'Your prospect lists', kind: 'prospecting', view: 'prospecting', keywords: ['prospects', 'leads'], spec: page('prospecting', 'Prospecting') },
  { slug: 'sequences', label: 'Sequences', description: 'Your outreach sequences', kind: 'sequences', view: 'sequences', keywords: ['outreach'], spec: page('sequences', 'Sequences') },
  { slug: 'campaigns', label: 'Campaigns', description: 'Your campaigns', kind: 'campaigns', view: 'campaigns', spec: page('campaigns', 'Campaigns') },
  { slug: 'evals', label: 'Evals', description: 'Your eval suites', kind: 'evals', view: 'evals', spec: page('evals', 'Evals') },
  { slug: 'agents', label: 'Agents & skills', description: 'Your agents and skills', kind: 'library', view: 'agents', keywords: ['skills', 'library', 'bots'], spec: page('library', 'Agents & skills') },
  { slug: 'teams', label: 'Teams', description: 'Your teams', kind: 'teams', view: 'teams', spec: page('teams', 'Teams') },
]

/** Kinds with no page of their own, and why. */
export const NO_PAGE_KINDS: Readonly<Record<string, string>> = {
  record: 'opens one record, so it needs that record',
  team_board: 'opens one team’s board, so it needs that team',
  bot: 'opens one agent’s page, so it needs that agent (the Library’s Agents & skills, For you, a notice)',
  work_item: 'opens one work item with no agent’s page to open on, so it needs that item (For you, a review, a banner)',
  guest: 'opens one guest’s conversation, so it needs that guest (their request or activity card in the chat)',
  agent_link: 'opens one link’s conversation between two agents, so it needs that link (the line over a held card, or an exchange’s card in the chat)',
}

/**
 * The pages this workspace may open from `/`: each one's page is on (the
 * edition's view gate), its kind is in this build, the device can draw it, and a
 * page of the person's own data only where the chat may read it
 * (`personalTools`: absent, every tool may).
 *
 * Each in the edition's words (src/lib/editions/words.ts): a page it renames
 * ("My jobs" for My Actions) is offered, and its card titled, by that name,
 * and the app's own name stays a keyword, so `/actions` still finds it.
 */
export function pagesFor(
  edition: EditionDefinition,
  opts: { desktop: boolean; now?: Date; from?: readonly CardPage[]; personalTools?: (tool: string) => boolean },
): OfferedPage[] {
  const now = opts.now ?? new Date()
  return (opts.from ?? CARD_PAGES).filter(
    (p) =>
      isViewAllowed(edition, p.view) &&
      (!p.desktopOnly || opts.desktop) &&
      (!p.personalTool || (opts.personalTools?.(p.personalTool) ?? true)) &&
      isCardSpec(p.spec(now)),
  ).map((p) => inEditionWords(edition, { ...p, spec: (at: Date) => p.spec(at) as CardSpec }))
}

/** A page under the edition's name for it, if it has one; else the page as it is. */
function inEditionWords(edition: EditionDefinition, page: OfferedPage): OfferedPage {
  const named = pageWords(edition, page.view, page)
  if (named.label === page.label) return page
  return {
    ...page,
    label: named.label,
    description: named.description ?? page.description,
    ...(named.slug && named.slug !== page.slug ? { shownSlug: named.slug } : {}),
    keywords: [...new Set([...(page.keywords ?? []), ...page.label.toLowerCase().split(/[\s&]+/).filter((w) => w.length > 2)])],
    // A list card is titled by its page (`My actions`); a page card keeps its own title.
    spec: (at: Date) => {
      const spec = page.spec(at)
      return spec.kind === 'list' ? { ...spec, title: named.label } : spec
    },
  }
}

/**
 * May a chat read the person's calendar or mail, as `show`'s per-person gate
 * asks? Not in a bot's conversation (the bot's own limits rule there), and
 * under a persona only when its tool list keeps the tool: the conservative
 * reading of a persona's allowlist, since the card's rows reach its agent.
 */
export function personalToolsFor(chat: {
  bot: boolean
  agent: { enabled_tools?: string[]; disabled_tools?: string[] } | null
}): (tool: string) => boolean {
  return (tool) => {
    if (chat.bot) return false
    if (!chat.agent) return true
    if (chat.agent.disabled_tools?.includes(tool)) return false
    return chat.agent.enabled_tools === undefined || chat.agent.enabled_tools.includes(tool)
  }
}

/** The pages a `/` query finds: by slug (the shown one too), name or keyword, slug matches first. */
export function filterPages<T extends Pick<CardPage, 'slug' | 'label' | 'keywords'> & { shownSlug?: string }>(pages: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...pages]
  const bySlug = pages.filter((p) => p.slug.startsWith(q) || !!p.shownSlug?.startsWith(q))
  const rest = pages.filter(
    (p) =>
      !bySlug.includes(p) &&
      // A keyword from a word's start ("tasks", "crm"), never inside one ("tom" is no "automations").
      (p.slug.includes(q) || p.label.toLowerCase().includes(q) || (p.keywords ?? []).some((k) => k.split(/\s+/).some((w) => w.startsWith(q)))),
  )
  return [...bySlug, ...rest]
}
