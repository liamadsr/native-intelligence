/**
 * The rail's page groups (Liam, 11-11: "Contacts: Companies, Contacts, Deals
 * · Outreach: Prospecting, Sequences, Campaigns · Calendar: Captures";
 * "Drive: Docs, Knowledge, and a new page that shows all available files …
 * Agents: Agents & Skills, Flows, Evals"): a few
 * `/` pages that share one icon on the app rail, switched between in the
 * group's own sub-nav in the page panel (../page-panel/page-group-panel.tsx),
 * as Projects and Initiatives nest under My Actions (its own mechanism,
 * ./rail-pages.ts NESTED_RAIL_PAGES; this one is separate and generic).
 *
 *   Declared   once, here: a group's id (its rail id: its icon, its place on
 *              the bar, the selected place while any member page is), its
 *              label, its member pages in Liam's order, and the member it
 *              opens on by default.
 *   The rail   one icon per group, where its first member stood
 *              (rail-pages.ts RAIL_PAGES); the member pages have none of
 *              their own, and Customize bar lists the group.
 *   A click    opens the member last used on this device (lastGroupPage,
 *              localStorage), else the default, as the rail opens a page.
 *   Selected   any member page's own card in front selects the group
 *              (rail-pages.ts pageOfCard): `/`, Search and links opening
 *              Deals light Contacts, no redirect.
 *
 * Client-safe: the last-used member is read and written in try/catch (a
 * private window, blocked storage), with a copy in memory.
 */

/** A page group's id: its rail id (the same as a member's slug where the group is named after it). */
export type PageGroupId = 'contacts' | 'outreach' | 'seo' | 'calendar' | 'drive' | 'agents'

export interface PageGroupDef {
  id: PageGroupId
  /** What the rail calls it. */
  label: string
  /** A member whose name in the workspace's words the group wears instead (Contacts is "Customers" in a service business). */
  labelFrom?: string
  /** Its member pages' slugs (CARD_PAGES), in Liam's order: the sub-nav's rows. */
  members: readonly string[]
  /** The member it opens on before one was used on this device. */
  defaultMember: string
}

/** The groups (Liam, 11-11). */
export const PAGE_GROUPS: Readonly<Record<PageGroupId, PageGroupDef>> = {
  contacts: { id: 'contacts', label: 'Contacts', labelFrom: 'contacts', members: ['companies', 'contacts', 'deals'], defaultMember: 'contacts' },
  outreach: { id: 'outreach', label: 'Outreach', members: ['prospecting', 'sequences', 'campaigns'], defaultMember: 'prospecting' },
  // SEO: one page per section (the `seo` feature's `seo` view). Site audit
  // today; each new section is one more slug here. With one member the rail
  // shows just the icon, and the sub-nav appears once there are two.
  seo: { id: 'seo', label: 'SEO', members: ['seo-audit', 'seo-keywords', 'seo-rankings', 'seo-search', 'seo-competitors', 'seo-backlinks', 'seo-ai-visibility', 'seo-local'], defaultMember: 'seo-audit' },
  // Liam, 11-11: "Calendar: Calendar, Availability (… its own page under Calendar), Captures".
  calendar: { id: 'calendar', label: 'Calendar', labelFrom: 'calendar', members: ['calendar', 'availability', 'captures'], defaultMember: 'calendar' },
  // Liam, 11-11: "Drive: Docs, Knowledge, and a new page that shows all
  // available files … · Agents: Agents & Skills, Flows, Evals".
  drive: { id: 'drive', label: 'Drive', members: ['docs', 'knowledge', 'files'], defaultMember: 'docs' },
  agents: { id: 'agents', label: 'Agents', members: ['agents', 'flows', 'evals'], defaultMember: 'agents' },
}

/** Each member page's group, by its slug. */
export const GROUP_OF_PAGE: ReadonlyMap<string, PageGroupId> = new Map(
  Object.values(PAGE_GROUPS).flatMap((g) => g.members.map((slug) => [slug, g.id] as const)),
)

export function isPageGroupId(id: string | null | undefined): id is PageGroupId {
  return !!id && Object.hasOwn(PAGE_GROUPS, id)
}

/*
 * The member last used in each group, on this device: `{ contacts: 'deals' }`.
 * Under the rail bar's own key prefix, so sign-out wipes it with the bar
 * (main-chat/state-wipe.ts `ni:rail-pages`).
 */
export const GROUP_LAST_PAGE_KEY = 'ni:rail-pages:last-in-group'

let memory: Partial<Record<PageGroupId, string>> = {}

function readStored(): Partial<Record<PageGroupId, string>> {
  try {
    if (typeof window === 'undefined') return memory
    const raw = window.localStorage.getItem(GROUP_LAST_PAGE_KEY)
    if (!raw) return memory
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...memory, ...(parsed as Record<string, string>) } : memory
  } catch {
    return memory
  }
}

/** The member of `group` last used on this device, or null (none yet, or not one of its members). */
export function lastGroupPage(group: PageGroupId): string | null {
  const slug = readStored()[group]
  return typeof slug === 'string' && GROUP_OF_PAGE.get(slug) === group ? slug : null
}

/** Note `slug` as its group's last used member (nothing for a page in no group). */
export function rememberGroupPage(slug: string): void {
  const group = GROUP_OF_PAGE.get(slug)
  if (!group) return
  const stored = readStored()
  if (stored[group] === slug && memory[group] === slug) return
  memory = { ...memory, [group]: slug }
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(GROUP_LAST_PAGE_KEY, JSON.stringify({ ...stored, [group]: slug }))
  } catch {
    // Kept in memory for this tab.
  }
}

/**
 * The member a group's icon opens: the last used here when this workspace
 * has it on, else the default when it is on, else its first member on.
 * `members`: the slugs this workspace has on, in the group's order.
 */
export function groupOpenSlug(group: PageGroupId, members: readonly string[]): string | null {
  const last = lastGroupPage(group)
  if (last && members.includes(last)) return last
  const fallback = PAGE_GROUPS[group].defaultMember
  return members.includes(fallback) ? fallback : (members[0] ?? null)
}

/** Tests: nothing remembered in memory (storage is the test's to clear). */
export function __resetPageGroupsForTests(): void {
  memory = {}
}
