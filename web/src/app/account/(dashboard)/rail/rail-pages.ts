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
