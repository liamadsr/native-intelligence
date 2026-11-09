/**
 * The app rail's pages (./app-rail.tsx): the thin band down the window's left,
 * top to bottom after New, Search and Home. Every `/` page the workspace has
 * on (Liam, 11-09: "how come we're not showing all available pages here?"),
 * in four groups, Liam's reference order first:
 *
 *   your work   Docs, Mail, Team chat, My Actions, Calendar, Captures
 *   plans       Projects, Initiatives, Knowledge, Flows
 *   customers   Companies, Contacts, Deals, Prospecting, Sequences, Campaigns
 *   agents      Agents & skills, Evals, Teams
 *
 * Each is a `/` page (lib/chat-cards/page-menu.ts): picked, it opens as `/`
 * opens it, full screen in the main chat (openTarget `page`). Offered only as
 * `/` offers it (pagesFor: the edition's gate, the workspace's Features, in
 * the edition's words), so a page that is off in a workspace has no icon
 * either. A new `/` page needs its place here (the tests say so).
 *
 * What lights an icon is the card full screen now (components/chat-cards/
 * front-card.ts): the page's own kind, or a list or a record of what the page
 * lists (an action's card lights My Actions, a deal's Deals). Nothing full
 * screen lights Home: the chat.
 *
 * Client-safe and pure.
 */
import type { CardRecordType, CardSpec } from '@/lib/chat-cards/kinds'
import type { OfferedPage } from '@/lib/chat-cards/page-menu'
import { DEFAULT_RAIL_PREFS, isDefaultRailPrefs, type RailPrefs } from '@/lib/rail-prefs'

/** A rail page's id: its `/` page's slug. */
export type RailPageId = string

/** The rail's groups, top to bottom (a hairline between two that show). */
export type RailGroup = 'work' | 'plans' | 'customers' | 'agents'

export interface RailPageDef {
  id: RailPageId
  /** The `/` page it opens (CARD_PAGES slug). */
  slug: string
  group: RailGroup
  /** Card kinds that are this page (`mail`, `team_chat`). */
  kinds?: readonly string[]
  /** What the page lists: a list or a record card of one of these lights it too. */
  entities?: readonly CardRecordType[]
}

const def = (slug: string, group: RailGroup, lights: Pick<RailPageDef, 'kinds' | 'entities'> = {}): RailPageDef => ({ id: slug, slug, group, ...lights })

/** The rail's pages, in its order. */
export const RAIL_PAGES: readonly RailPageDef[] = [
  def('docs', 'work', { entities: ['document'] }),
  def('mail', 'work', { kinds: ['mail'] }),
  def('team-chat', 'work', { kinds: ['team_chat'] }),
  def('actions', 'work', { kinds: ['team_board'], entities: ['action'] }),
  def('calendar', 'work', { kinds: ['calendar'] }),
  def('captures', 'work', { entities: ['capture'] }),
  def('projects', 'plans', { entities: ['project'] }),
  def('initiatives', 'plans', { entities: ['initiative'] }),
  def('knowledge', 'plans', { kinds: ['knowledge'] }),
  def('flows', 'plans', { kinds: ['flows'] }),
  def('companies', 'customers', { entities: ['company'] }),
  def('contacts', 'customers', { entities: ['contact'] }),
  def('deals', 'customers', { entities: ['deal'] }),
  def('prospecting', 'customers', { kinds: ['prospecting'] }),
  def('sequences', 'customers', { kinds: ['sequences'] }),
  def('campaigns', 'customers', { kinds: ['campaigns'] }),
  // Sparkles: the agents (Liam's reference has Home for the chat and sparkles
  // for the AI): the Library's Agents & skills, and an agent's own page.
  def('agents', 'agents', { kinds: ['library', 'bot'] }),
  def('evals', 'agents', { kinds: ['evals'] }),
  def('teams', 'agents', { kinds: ['teams'] }),
]

/** A rail page as this workspace offers it: its `/` page (the label in the edition's words). */
export interface OfferedRailPage {
  def: RailPageDef
  page: OfferedPage
}

/** The rail's pages this workspace offers (`offered`: pagesFor's), in the rail's order. */
export function railPagesFor(offered: readonly OfferedPage[]): OfferedRailPage[] {
  const bySlug = new Map(offered.map((p) => [p.slug, p]))
  const out: OfferedRailPage[] = []
  for (const def of RAIL_PAGES) {
    const page = bySlug.get(def.slug)
    if (page) out.push({ def, page })
  }
  return out
}

/** Is `spec` (a card full screen) one of `def`'s? */
export function railPageShows(def: RailPageDef, spec: CardSpec): boolean {
  if (def.kinds?.includes(spec.kind)) return true
  if (!def.entities) return false
  if (spec.kind === 'list') return (def.entities as readonly string[]).includes(spec.entity_type)
  if (spec.kind === 'record') return def.entities.includes(spec.record.type)
  return false
}

/**
 * The rail item lit for the card in front: `home` with none (the chat), the
 * page it is one of, or null (a card no rail page shows: a guest's
 * conversation, a page the workspace has off).
 */
export function activeRailItem(front: CardSpec | null, pages: readonly OfferedRailPage[]): RailPageId | 'home' | null {
  if (!front) return 'home'
  return pages.find((p) => railPageShows(p.def, front))?.def.id ?? null
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
export function railLayout(pages: readonly OfferedRailPage[], prefs: RailPrefs | null): RailLayout {
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

const tidyHidden = (hidden: readonly RailPageId[]) => [...new Set(hidden)].filter((id) => RAIL_INDEX.has(id))

/**
 * Move `id` to slot `to` of the bar (among the pinned pages `offered` makes,
 * clamped), its unpinned pages keeping their places. Null when nothing moves.
 * A saved id this workspace doesn't offer keeps its place after the one it
 * followed, for the workspace that does.
 */
export function moveRailPage(prefs: RailPrefs | null, offered: readonly RailPageId[], id: RailPageId, to: number): RailPrefs | null {
  const p = prefs ?? DEFAULT_RAIL_PREFS
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
  const hidden = new Set(prefs?.hidden ?? [])
  const from = resolveOrder(offered, prefs).filter((x) => !hidden.has(x)).indexOf(id)
  return from < 0 ? null : moveRailPage(prefs, offered, id, from + delta)
}

/** Pin `id` to the bar (true) or unpin it (false): its icon shows or hides, the page stays on. Null when it already is. */
export function setRailPagePinned(prefs: RailPrefs | null, id: RailPageId, pinned: boolean): RailPrefs | null {
  const p = prefs ?? DEFAULT_RAIL_PREFS
  if (p.hidden.includes(id) !== pinned) return null
  return { order: [...p.order], hidden: tidyHidden(pinned ? p.hidden.filter((x) => x !== id) : [...p.hidden, id]) }
}

/** The default bar again (every page, the rail's order). Null when it already is. */
export function resetRailPrefs(prefs: RailPrefs | null): RailPrefs | null {
  return isDefaultRailPrefs(prefs) ? null : { order: [], hidden: [] }
}
