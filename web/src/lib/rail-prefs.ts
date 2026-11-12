/**
 * The person's own app rail bar (Liam, 11-09: "customise the navigation like
 * move them up and down, right click and pin and unpin them … a switch on if
 * I should see the page or not … this isn't to disable the feature it's to
 * hide and show the icon for its page"): the order of the bar's pages and the
 * ones unpinned from it, kept on the ACCOUNT like the agent's name and look
 * (lib/account-setting.ts, ./rail-prefs-store.ts), `user_metadata.rail_pages`.
 *
 *   order   the pages' ids in the person's order; empty: the default order
 *           (app/account/(dashboard)/rail/rail-pages.ts RAIL_PAGES).
 *   hidden  the ids unpinned from the bar. Their pages stay on: they still
 *           open from `/`, Search and links.
 *
 * What the bar makes of them (a page neither mentions, one no longer
 * offered) is rail-pages.ts railLayout. This file is the shape and its check,
 * on the server (api/account/profile) and the device alike: pure.
 */

/** Its key in `user_metadata` and in the profile GET/PATCH (api/account/profile). */
export const RAIL_PAGES_PROFILE_FIELD = 'rail_pages'

/** Where this device keeps its copy (wiped at sign-out: main-chat/state-wipe.ts). */
export const RAIL_PAGES_STORAGE_KEY = 'ni:rail-pages'

/** At most this many ids in each list (the rail has 12 items, its groups' member pages 8 more). */
// Small on purpose: user_metadata rides in the access token and the auth
// cookie on every request (room to grow). An id the rail no longer has
// (Projects and Initiatives nest under Tasks since Liam, 11-11) still
// parses: the bar skips it, and the next save drops it (rail-pages.ts
// railLayout, tidyOrder). A page group's member's id (Liam, 11-11: Contacts,
// Outreach, Calendar) stands for its group (rail-pages.ts currentPrefs); a
// hidden group is saved as all its members' ids.
export const RAIL_PREFS_MAX_IDS = 32

/** A page id: a `/` page's slug, short. */
const PAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PAGE_ID_MAX = 24

export interface RailPrefs {
  order: string[]
  hidden: string[]
}

/** The default bar: every page, in the rail's order. */
export const DEFAULT_RAIL_PREFS: Readonly<RailPrefs> = Object.freeze({ order: [], hidden: [] })

function idList(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > RAIL_PREFS_MAX_IDS) return null
  const out: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length > PAGE_ID_MAX || !PAGE_ID.test(id)) return null
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** A stored, served or sent value, checked: two lists of short page ids (each at most RAIL_PREFS_MAX_IDS), or null. */
export function parseRailPrefs(raw: unknown): RailPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { order, hidden } = raw as Record<string, unknown>
  const o = idList(order)
  const h = idList(hidden)
  if (!o || !h) return null
  return { order: o, hidden: h }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** Two prefs that make the same bar. */
export function sameRailPrefs(a: RailPrefs, b: RailPrefs): boolean {
  return sameList(a.order, b.order) && sameList(a.hidden, b.hidden)
}

/** The default bar: no order of the person's, nothing hidden. */
export function isDefaultRailPrefs(prefs: RailPrefs | null): boolean {
  return !prefs || (prefs.order.length === 0 && prefs.hidden.length === 0)
}
