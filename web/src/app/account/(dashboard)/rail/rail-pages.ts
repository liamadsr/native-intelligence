/**
 * The app rail's pages (./app-rail.tsx, Liam 11-09): the thin band down the
 * window's left, from his reference, top to bottom after New, Search and Home:
 *
 *   folder     Docs          envelope   Mail
 *   bubbles    Team chat     checklist  My Actions
 *   calendar   Calendar      sparkles   Agents & skills
 *   building   Companies (the CRM)
 *
 * Each is a `/` page (lib/chat-cards/page-menu.ts): picked, it opens as `/`
 * opens it, full screen in the main chat (openTarget `page`). Offered only as
 * `/` offers it (pagesFor: the edition's gate, in the edition's words), so a
 * page that is off in a workspace has no icon either.
 *
 * What lights an icon is the card full screen now (components/chat-cards/
 * front-card.ts): the page's own kind, or a list or a record of what the page
 * lists (an action's card lights My Actions, a deal's the CRM). Nothing full
 * screen lights Home: the chat.
 *
 * Client-safe and pure.
 */
import type { CardRecordType, CardSpec } from '@/lib/chat-cards/kinds'
import type { OfferedPage } from '@/lib/chat-cards/page-menu'

export type RailPageId = 'docs' | 'mail' | 'team-chat' | 'actions' | 'calendar' | 'agents' | 'crm'

export interface RailPageDef {
  id: RailPageId
  /** The `/` page it opens (CARD_PAGES slug). */
  slug: string
  /** Card kinds that are this page (`mail`, `team_chat`). */
  kinds?: readonly string[]
  /** What the page lists: a list or a record card of one of these lights it too. */
  entities?: readonly CardRecordType[]
}

/** The rail's pages, in its order. */
export const RAIL_PAGES: readonly RailPageDef[] = [
  { id: 'docs', slug: 'docs', entities: ['document'] },
  { id: 'mail', slug: 'mail', kinds: ['mail'] },
  { id: 'team-chat', slug: 'team-chat', kinds: ['team_chat'] },
  { id: 'actions', slug: 'actions', kinds: ['team_board'], entities: ['action'] },
  { id: 'calendar', slug: 'calendar', kinds: ['calendar'] },
  // Sparkles: the agents (Liam's reference has Home for the chat and sparkles
  // for the AI): the Library's Agents & skills, and an agent's own page.
  { id: 'agents', slug: 'agents', kinds: ['library', 'bot'] },
  // The building: the CRM, opening on Companies (the app's building icon);
  // its contacts and deals light it too.
  { id: 'crm', slug: 'companies', entities: ['company', 'contact', 'deal'] },
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
 * page it is one of, or null (a card no rail page shows: a capture, a flow).
 */
export function activeRailItem(front: CardSpec | null, pages: readonly OfferedRailPage[]): RailPageId | 'home' | null {
  if (!front) return 'home'
  return pages.find((p) => railPageShows(p.def, front))?.def.id ?? null
}
