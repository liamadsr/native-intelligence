/**
 * The app rail's pages (./app-rail.tsx): the thin band down the window's left,
 * top to bottom after Home. Every `/` page the workspace has on (Liam, 11-09:
 * "how come we're not showing all available pages here?"), in three groups,
 * Liam's reference order first:
 *
 *   your work   Drive (Docs, Knowledge, Files, Tables), Mail, Team chat, My Actions,
 *               Calendar (+ Captures), Studio
 *   customers   Contacts (Companies, Contacts, Deals),
 *               Outreach (Prospecting, Sequences, Campaigns)
 *   agents      Agents (Agents & skills, Flows, Evals)
 *
 * Liam, 11-11: "Drive: Docs, Knowledge, and a new page that shows all
 * available files … Agents: Agents & Skills, Flows, Evals": two more groups,
 * Drive where Docs stood and Agents where Agents & skills stood. The plans
 * section (Knowledge, Flows) went with them; a section with nothing in it
 * draws nothing, no hairline (app-rail.tsx groups only the pages it has).
 *
 * Liam, 11-11: "Contacts: Companies, Contacts, Deals · Outreach: Prospecting,
 * Sequences, Campaigns · Calendar: Captures": page groups (./page-groups.ts),
 * one icon each where its first member stood, its member pages switched in
 * its sub-nav in the page panel. A member page's own card in front selects
 * the group (pageOfCard). A bar saved before the groups still loads
 * (currentPrefs): a group stands where its first member id stood, and is
 * hidden only when every member was.
 *
 * Liam, 11-11: Projects and Initiatives nest under Tasks ("Yes, nest them",
 * after "one todo icon on the main nav and when you click it the sub-nav
 * would show things like milestone and projects that way it's nested and
 * clean and not at the top level"): no icons of their own, not in Customize
 * bar; still `/` pages (`/`, Search and links find them), opened inside My
 * Actions' card on their place (NESTED_RAIL_PAGES, nestedPageOpen).
 * Liam, 11-11: "Teams should be under action items" ("yes thats what I meant
 * for teams"): Teams too, opened on All teams inside My Actions' card; a
 * saved bar that has `teams` still loads, the id dropped.
 *
 * Each is a `/` page (lib/chat-cards/page-menu.ts): picked, it opens as `/`
 * opens it, full screen in the main chat (openTarget `page`). Offered only as
 * `/` offers it (pagesFor: the edition's gate, the workspace's Features, in
 * the edition's words), so a page that is off in a workspace has no icon
 * either. A new `/` page needs its place here, or under a rail page in
 * NESTED_RAIL_PAGES (the tests say so).
 *
 * What is lit is the selected place (Liam, 11-11: "when you open differnet
 * artifacts you don't see the pages like cal and actions page get selected
 * because when you actually select the page itself we want to change our
 * menu to be specific for controls that would be on that page"), not
 * whatever card is in front: a page when its OWN card comes in front (as the
 * rail, `/` and Search open it: pageOfCard), and stays so while the person
 * moves about inside it; Home with nothing in front, and for anything opened
 * from home (the Recent panel, a chip, Search, a notification). See
 * nextSelectedPlace, and ./selected-place.ts for the store that follows it.
 * The page panel beside the rail follows the same place
 * (../page-panel/page-panel.tsx pageKeyOf).
 *
 * Client-safe and pure.
 */
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { CARD_PAGES, type OfferedPage } from '@/lib/chat-cards/page-menu'
import { TASKS_PLACE_OF_PAGE, type TasksPlace } from '@/lib/chat-cards/tasks-places'
import { DEFAULT_RAIL_PREFS, isDefaultRailPrefs, type RailPrefs } from '@/lib/rail-prefs'
import { GROUP_OF_PAGE, PAGE_GROUPS, isPageGroupId, type PageGroupId } from './page-groups'

/** A rail item's id: its `/` page's slug, or a page group's id (./page-groups.ts). */
export type RailPageId = string

/** The rail's groups, top to bottom (a hairline between two that show). */
export type RailGroup = 'work' | 'customers' | 'agents'

export interface RailPageDef {
  id: RailPageId
  /** The `/` page it opens (CARD_PAGES slug); a page group's: its default member. */
  slug: string
  group: RailGroup
  /** A page group's member pages' slugs, in its order (./page-groups.ts); absent for a page. */
  members?: readonly string[]
}

const def = (slug: string, group: RailGroup): RailPageDef => ({ id: slug, slug, group })
/** A page group's one icon (Liam, 11-11). */
const groupDef = (id: PageGroupId, group: RailGroup): RailPageDef => ({ id, slug: PAGE_GROUPS[id].defaultMember, group, members: PAGE_GROUPS[id].members })

/** The rail's pages, in its order. */
export const RAIL_PAGES: readonly RailPageDef[] = [
  // Drive: Docs, Knowledge, Files (Liam, 11-11).
  groupDef('drive', 'work'),
  def('mail', 'work'),
  def('team-chat', 'work'),
  def('actions', 'work'),
  // Calendar: Captures (Liam, 11-11).
  groupDef('calendar', 'work'),
  // Studio (migration 620): videos and ads. One page, no sub-nav: the editor
  // draws its own navigation inside the card.
  def('studio', 'work'),
  // Contacts: Companies, Contacts, Deals · Outreach: Prospecting, Sequences, Campaigns (Liam, 11-11).
  groupDef('contacts', 'customers'),
  groupDef('outreach', 'customers'),
  // SEO: Site audit, and its next sections as they land (./page-groups.ts).
  groupDef('seo', 'customers'),
  // Sparkles: the agents (Liam's reference has Home for the chat and sparkles
  // for the AI). Agents: Agents & skills, Flows, Evals (Liam, 11-11).
  groupDef('agents', 'agents'),
  // Teams nests under My Actions (Liam, 11-11: NESTED_RAIL_PAGES).
]

/** A `/` page nested under a rail page: no icon of its own (Liam, 11-11: Projects, Initiatives and Teams nest under Tasks). */
export type NestedRailPageId = 'projects' | 'initiatives' | 'teams'

/**
 * The `/` pages nested under a rail page, each to its parent (Liam, 11-11:
 * "Yes, nest them"). Not on the bar nor in Customize bar; opening one opens
 * its parent's card on the nested page's place inside it (nestedPageOpen),
 * so the parent is the page selected and lit.
 */
export const NESTED_RAIL_PAGES: Readonly<Record<NestedRailPageId, RailPageId>> = {
  projects: 'actions',
  initiatives: 'actions',
  // Liam, 11-11: "Teams should be under action items": on All teams.
  teams: 'actions',
}

/** A rail page (or page group) as this workspace offers it. */
export interface OfferedRailPage {
  def: RailPageDef
  /** The `/` page it opens (its label in the edition's words); a group's: its default member, else its first member on here. */
  page: OfferedPage
  /** What the rail calls it: the page's label; a group's own (in the workspace's words where it takes a member's name). */
  label: string
  /** A group's member pages this workspace has on (one or more), in its order; absent for a page. Two or more: its sub-nav. */
  members?: readonly OfferedPage[]
}

/**
 * The rail's pages this workspace offers (`offered`: pagesFor's), in the
 * rail's order. A group with none of its members on is left out; with one,
 * its icon opens that one (no sub-nav: nothing to switch between).
 */
export function railPagesFor(offered: readonly OfferedPage[]): OfferedRailPage[] {
  const bySlug = new Map(offered.map((p) => [p.slug, p]))
  const out: OfferedRailPage[] = []
  for (const def of RAIL_PAGES) {
    if (def.members) {
      const members = def.members.map((slug) => bySlug.get(slug)).filter((p): p is OfferedPage => !!p)
      if (!members.length) continue
      const group = PAGE_GROUPS[def.id as PageGroupId]
      const label = (group.labelFrom && bySlug.get(group.labelFrom)?.label) || group.label
      out.push({ def, page: bySlug.get(def.slug) ?? members[0], label, members })
      continue
    }
    const page = bySlug.get(def.slug)
    if (page) out.push({ def, page, label: page.label })
  }
  return out
}

/** The place selected: home (the chat, and what is opened from it) or a rail page. */
export type SelectedPlace = 'home' | RailPageId

/** A JSON text with its keys in order: two specs built in different orders compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * What makes a card a page's own, its title aside (the edition renames a
 * list's): the kind and what it is on. A calendar's range is the week it
 * was opened in, so the page's is its week view titled as the page titles it
 * ("This week"); an event opened on its day is not the page.
 */
function ownCardKey(spec: CardSpec): string {
  if (spec.kind === 'calendar') return stableJson({ kind: 'calendar', view: spec.calendar.view, title: spec.title })
  const { title: _title, ...rest } = spec
  void _title
  return stableJson(rest)
}

/**
 * The rail item and `/` page whose OWN card `spec` is (the card the rail, `/`
 * and Search open it as: its CARD_PAGES spec), or null: a record, a list or
 * calendar the agent showed narrower, a place inside a page (a sequence, a
 * thread, an event on its day). A page's own card reused for a place inside
 * it (Team chat on a message, Flows on a flow: one card each, open-card.ts
 * sameCardPlace) is still that page's. A group member's (Deals, Captures…):
 * its group's id, and the member's slug (Liam, 11-11: page groups).
 */
export function ownPageOfCard(spec: CardSpec, now: Date = new Date()): { id: RailPageId; slug: string } | null {
  const key = ownCardKey(spec)
  for (const def of RAIL_PAGES) {
    for (const slug of def.members ?? [def.slug]) {
      const own = CARD_PAGES.find((p) => p.slug === slug)?.spec(now) as CardSpec | undefined
      if (own && own.kind === spec.kind && ownCardKey(own) === key) return { id: def.id, slug }
    }
  }
  return null
}

/** The rail item whose page's OWN card `spec` is (a group member's: the group), or null (ownPageOfCard). */
export function pageOfCard(spec: CardSpec, now: Date = new Date()): RailPageId | null {
  return ownPageOfCard(spec, now)?.id ?? null
}

/**
 * Where a card opened from anywhere (`/`, Search, a link: chat-panel
 * openCardHere) really opens when it is a nested page's own card (Liam,
 * 11-11: Projects and Initiatives nest under Tasks): its parent's card, as
 * this workspace offers it (`offered`: pagesFor's), on the nested page's
 * place inside it (lib/chat-cards/tasks-places.ts, the step the Tasks
 * sub-nav's rows make). Null: open `spec` as it is (not a nested page's own
 * card, or the parent or the page itself is off here: then the page opens on
 * its own, with no rail icon to light).
 */
export function nestedPageOpen(
  spec: CardSpec,
  offered: readonly OfferedPage[],
  now: Date = new Date(),
): { spec: CardSpec; place: TasksPlace } | null {
  // Projects and Initiatives are list cards; Teams is a page card.
  if (spec.kind !== 'list' && spec.kind !== 'teams') return null
  const key = ownCardKey(spec)
  for (const [slug, parent] of Object.entries(NESTED_RAIL_PAGES)) {
    const own = CARD_PAGES.find((p) => p.slug === slug)?.spec(now) as CardSpec | undefined
    if (!own || own.kind !== spec.kind || ownCardKey(own) !== key) continue
    const place = TASKS_PLACE_OF_PAGE[slug]
    const home = offered.find((p) => p.slug === parent)
    if (!place || !home || !offered.some((p) => p.slug === slug)) return null
    return { spec: home.spec(now), place }
  }
  return null
}

/**
 * The place selected once the card in front is `front` (null: none), from
 * where it was (`was`: the place, and the card in front then).
 *
 *   nothing in front              home
 *   the same card as before       unchanged (it remounted, moved inside)
 *   a page's own card             that page (a group member's: its group)
 *   another card, opened from     unchanged: a record opened from inside the
 *   inside the place on screen    page keeps it (`fromInside`: the person's
 *                                 last press was in the card in front, or a
 *                                 page's own panel; ./selected-place.ts)
 *   another card, from elsewhere  home (the Recent panel, a chip in the
 *                                 chat, Search, a notification)
 *
 * Moving inside a page's card (a row opened in it, a folder, Back) never
 * changes the card in front at all: the card's own history holds it
 * (components/chat-cards/card-history.tsx).
 */
export function nextSelectedPlace(
  was: { place: SelectedPlace; frontId: string | null },
  front: { id: string; spec: CardSpec } | null,
  fromInside: boolean,
  now: Date = new Date(),
): SelectedPlace {
  if (!front) return 'home'
  if (front.id === was.frontId) return was.place
  const own = pageOfCard(front.spec, now)
  if (own) return own
  return fromInside ? was.place : 'home'
}

/**
 * The rail item lit for the selected place: `home`, the page selected, or
 * null (a page the workspace has off).
 */
export function activeRailItem(selected: SelectedPlace, pages: readonly OfferedRailPage[]): RailPageId | 'home' | null {
  if (selected === 'home') return 'home'
  return pages.some((p) => p.def.id === selected) ? selected : null
}

/*
 * The person's bar (Liam, 11-09: move them up and down, pin and unpin them,
 * a switch per page in "Customize bar"): their order and the pages they
 * unpinned, kept on the account (lib/rail-prefs.ts). Unpinning hides the
 * icon only: the page stays on, and opens from `/`, Search and links.
 */

/** Every page this workspace offers, in the person's order (the settings list), and the pinned ones (the bar). */
export interface RailLayout {
  all: OfferedRailPage[]
  shown: OfferedRailPage[]
  /** The person's order isn't the default: the bar is one list, no hairlines between groups. */
  custom: boolean
}

const RAIL_INDEX = new Map(RAIL_PAGES.map((d, i) => [d.id, i]))

/** The rail id a saved id stands for now: a group member's, its group (Liam, 11-11); any other, itself. */
const railIdOf = (id: string): RailPageId => GROUP_OF_PAGE.get(id) ?? id

/**
 * Saved prefs as the bar reads them now, in rail ids (Liam, 11-11: page
 * groups). A bar saved before the groups still loads:
 *
 *   order   each member id stands for its group, at the first one found
 *           (Deals saved before Contacts: Contacts stands where Deals was);
 *           the group's other members' ids are dropped.
 *   hidden  a group is hidden only when EVERY one of its members' ids is
 *           (the bar saves a hidden group so: storedHidden), so a person
 *           who hid Deals alone still has the Contacts icon. Other ids as
 *           they are.
 */
function currentPrefs(prefs: RailPrefs): RailPrefs {
  const order = [...new Set(prefs.order.map(railIdOf))]
  const saved = new Set(prefs.hidden)
  const hidden = new Set(prefs.hidden.filter((id) => !GROUP_OF_PAGE.has(id)))
  for (const group of Object.values(PAGE_GROUPS)) if (group.members.every((slug) => saved.has(slug))) hidden.add(group.id)
  return { order, hidden: [...hidden] }
}

/** Hidden rail ids as the bar saves them: a group as every one of its members' ids (currentPrefs reads it back). */
const storedHidden = (hidden: readonly RailPageId[]): string[] => hidden.flatMap((id) => (isPageGroupId(id) ? PAGE_GROUPS[id].members : [id]))

/**
 * `placed` with each of `missing` put in after the nearest id before it in
 * `reference` that is placed (at the start when none is): a page the saved
 * order doesn't mention lands where the default has it.
 */
function placeMissing(placed: readonly RailPageId[], missing: ReadonlySet<RailPageId>, reference: readonly RailPageId[]): RailPageId[] {
  const out = [...placed]
  let anchor = -1
  for (const id of reference) {
    if (missing.has(id) && !out.includes(id)) out.splice(++anchor, 0, id)
    else {
      const at = out.indexOf(id)
      if (at >= 0) anchor = at
    }
  }
  return out
}

/** `offered` (ids, in the rail's order) in the person's order. */
function resolveOrder(offered: readonly RailPageId[], prefs: RailPrefs | null): RailPageId[] {
  const offeredSet = new Set(offered)
  const saved = (prefs?.order ?? []).filter((id) => offeredSet.has(id))
  const savedSet = new Set(saved)
  return placeMissing(saved, new Set(offered.filter((id) => !savedSet.has(id))), offered)
}

/**
 * The bar for `pages` (railPagesFor's, in the rail's order) and the person's
 * prefs (null: the default). A page the prefs don't mention (new, or just
 * turned on in Features) stands in its default place, pinned; a saved id the
 * workspace doesn't offer is skipped.
 */
export function railLayout(pages: readonly OfferedRailPage[], saved: RailPrefs | null): RailLayout {
  const prefs = saved && currentPrefs(saved)
  const byId = new Map(pages.map((p) => [p.def.id, p]))
  const ids = pages.map((p) => p.def.id)
  const order = resolveOrder(ids, prefs)
  const hidden = new Set(prefs?.hidden ?? [])
  const all = order.map((id) => byId.get(id)!)
  return {
    all,
    shown: all.filter((p) => !hidden.has(p.def.id)),
    custom: order.some((id, i) => id !== ids[i]),
  }
}

/** The ids worth keeping: rail pages, once each, in a list (empty when it is the rail's own order). */
function tidyOrder(order: readonly RailPageId[]): RailPageId[] {
  const out = [...new Set(order)].filter((id) => RAIL_INDEX.has(id))
  return out.every((id, i) => i === 0 || RAIL_INDEX.get(out[i - 1])! < RAIL_INDEX.get(id)!) ? [] : out
}

/** Hidden rail ids as saved: rail pages and group members' ids (a hidden group: storedHidden), once each. */
const tidyHidden = (hidden: readonly RailPageId[]) => [...new Set(storedHidden(hidden))].filter((id) => RAIL_INDEX.has(id) || GROUP_OF_PAGE.has(id))

/**
 * Move `id` to slot `to` of the bar (among the pinned pages `offered` makes,
 * clamped), its unpinned pages keeping their places. Null when nothing moves.
 * A saved id this workspace doesn't offer keeps its place after the one it
 * followed, for the workspace that does.
 */
export function moveRailPage(prefs: RailPrefs | null, offered: readonly RailPageId[], id: RailPageId, to: number): RailPrefs | null {
  const p = currentPrefs(prefs ?? DEFAULT_RAIL_PREFS)
  const hidden = new Set(p.hidden)
  const full = resolveOrder(offered, p)
  const shown = full.filter((x) => !hidden.has(x))
  const from = shown.indexOf(id)
  if (from < 0 || shown.length < 2) return null
  const target = Math.max(0, Math.min(shown.length - 1, to))
  if (target === from) return null
  const rest = full.filter((x) => x !== id)
  rest.splice(rest.indexOf(shown[target]) + (target > from ? 1 : 0), 0, id)
  const offeredSet = new Set(offered)
  const elsewhere = new Set(p.order.filter((x) => !offeredSet.has(x)))
  return { order: tidyOrder(placeMissing(rest, elsewhere, p.order)), hidden: tidyHidden(p.hidden) }
}

/** Move `id` up (-1) or down (+1) the bar. Null when it can't go further. */
export function moveRailPageBy(prefs: RailPrefs | null, offered: readonly RailPageId[], id: RailPageId, delta: number): RailPrefs | null {
  const p = prefs && currentPrefs(prefs)
  const hidden = new Set(p?.hidden ?? [])
  const from = resolveOrder(offered, p).filter((x) => !hidden.has(x)).indexOf(id)
  return from < 0 ? null : moveRailPage(prefs, offered, id, from + delta)
}

/** Pin `id` to the bar (true) or unpin it (false): its icon shows or hides, the page stays on. Null when it already is. */
export function setRailPagePinned(prefs: RailPrefs | null, id: RailPageId, pinned: boolean): RailPrefs | null {
  const p = currentPrefs(prefs ?? DEFAULT_RAIL_PREFS)
  if (p.hidden.includes(id) !== pinned) return null
  // Tidied as a move is: an id the rail no longer has (a page nested since,
  // a group's member: its group's id) goes; a hidden group is saved as its members' ids.
  return { order: tidyOrder(p.order), hidden: tidyHidden(pinned ? p.hidden.filter((x) => x !== id) : [...p.hidden, id]) }
}

/** The default bar again (every page, the rail's order). Null when it already is. */
export function resetRailPrefs(prefs: RailPrefs | null): RailPrefs | null {
  return isDefaultRailPrefs(prefs) ? null : { order: [], hidden: [] }
}
