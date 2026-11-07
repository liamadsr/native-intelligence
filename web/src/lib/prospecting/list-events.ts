/**
 * "A prospect list changed" — the window event a rename (or any other edit to
 * the list row) fires, so every surface that CACHES the list's name repaints.
 *
 * Everything else keys on the list ID: CRM rows carry `prospect_list_ids`,
 * saved views filter on the id, the Scout chips carry the id. So a rename
 * needs no data migration — only the places that spelled the name out and
 * loaded it once (the CRM's "From list" chips, above all) have to read it
 * again. Liam, 2026-09-06: "make sure if you rename the list it updates it in
 * the CRM and anywhere else it's shown or used as a filtered view."
 *
 * Same shape as the other window-event pairs (`dial8:prospecting-start`,
 * `dial8:prospect-entry-action`): one module owns the name and the payload so
 * the two sides cannot drift.
 */

export const PROSPECT_LIST_CHANGED_EVENT = 'dial8:prospect-list-changed'

export interface ProspectListChangedDetail {
  id: string
  name: string
}

/** Fire the change. Safe to call during SSR (no-ops without a window). */
export function announceProspectListChanged(detail: ProspectListChangedDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ProspectListChangedDetail>(PROSPECT_LIST_CHANGED_EVENT, { detail }),
  )
}
