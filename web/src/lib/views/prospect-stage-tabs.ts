/**
 * The prospect list's STAGE TABS: All · Saved · Needs review · Dismissed.
 *
 * They sit in the views tab row beside the list's own saved views — the same
 * shape the Actions list gives "All issues / Assigned to me / Created by me"
 * and the CRM gives Contacts / Companies: BASELINE NAVIGATION, not saved
 * views. Nothing is written to the views table for them, so nobody can
 * delete or rename them, and they are mutually exclusive with a custom view:
 * picking a tab clears the view, picking a view drops the tab (Liam,
 * 2026-09-06: "those could just be the default views").
 *
 * THE LIST IS SOMETHING THE USER WORKS. Discovery hands them twenty or thirty
 * companies with no score; they prune — a dismissed row LEAVES "All" and lands
 * under Dismissed — then enrich what is left and get a score, then prune
 * again, then find people. So "All" is not "every row ever found", it is
 * "everything still on the list", and Dismissed is where the rest went. The
 * Saved tab IS the list: only saved rows publish into the CRM
 * (`isListMember` in @/lib/prospecting/lists), never a view.
 *
 * WHERE "STILL ON THE LIST" IS ENFORCED: on the server. The views query hides
 * dismissed entries unless a filter names `stage` (`applyEntityDefaults` in
 * @/lib/views/query-engine), so the All tab sends NO stage filter, a custom
 * view with no opinion about stage inherits the same rule, and a custom view
 * built as "Stage is dismissed" is honoured because it said so.
 *
 * Client-safe on purpose: view-tabs imports this, and it must not pull the
 * server-shaped prospecting module in with it.
 */

import type { ViewFilter } from './types'

export const PROSPECT_STAGE_TABS = ['all', 'saved', 'needs_review', 'dismissed'] as const
export type ProspectStageTab = (typeof PROSPECT_STAGE_TABS)[number]

/** One count per tab — what the tab shows beside its label. */
export type ProspectStageCounts = Record<ProspectStageTab, number>

export const PROSPECT_STAGE_TAB_LABELS: Record<ProspectStageTab, string> = {
  all: 'All',
  saved: 'Saved',
  needs_review: 'Needs review',
  dismissed: 'Dismissed',
}

/** Why each tab exists, on hover. */
export const PROSPECT_STAGE_TAB_TITLES: Record<ProspectStageTab, string> = {
  all: 'Everything still on this list',
  saved: 'The list itself — what Publish writes to your CRM',
  needs_review: 'Held back at Save — their employer could not be verified',
  dismissed: 'Rejected — these will not be found again',
}

/**
 * Tabs that hide themselves at zero.
 *
 * **Needs review** is a tab about an EXCEPTION — people the save route held
 * back because their employer could not be verified. On a healthy list that
 * number is zero for its whole life, and a permanent "Needs review 0" teaches a
 * user to read the row as decoration. So it appears only when it has
 * something to say, or when it is the tab currently selected (a filter that
 * vanished out from under the rows it is filtering would be a dead end: the
 * list would narrow to nothing with no highlighted tab explaining why).
 *
 * The other three are always shown: "Dismissed 0" is a fact about a list that
 * the user asked a question about by looking at the row.
 */
export function isConditionalProspectStageTab(tab: ProspectStageTab): boolean {
  return tab === 'needs_review'
}

/**
 * What a tab narrows the query by, as fixed scope filters.
 *
 * `stage` and `identity_state` are real filterable columns
 * (FILTERABLE_FIELDS.prospect_list_entry), so these ride the generic `eq`
 * path with no engine seam — the count on the tab and the rows on screen
 * come from one query and cannot disagree, and pagination keeps working.
 *
 * "All" narrows by NOTHING: the server's default already hides dismissed rows
 * when no filter names `stage`, and sending `stage is_not dismissed` here
 * would also shadow a custom view's own stage filter.
 */
export function prospectStageTabFilters(tab: ProspectStageTab): ViewFilter[] {
  switch (tab) {
    case 'saved':
      return [{ id: '__tab_stage', field: 'stage', operator: 'is', value: 'saved' }]
    case 'dismissed':
      return [{ id: '__tab_stage', field: 'stage', operator: 'is', value: 'dismissed' }]
    case 'needs_review':
      return [
        { id: '__tab_identity', field: 'identity_state', operator: 'is', value: 'needs_review' },
      ]
    default:
      return []
  }
}

/**
 * The tab a list OPENS on.
 *
 * Saved once the list has anything saved — that is the list, and the rows the
 * user is building toward — and All before that, when there is nothing to show
 * under Saved but an empty state (Liam, 2026-09-06: "the default view should
 * be saved and not all, but only after at least one is saved"). Decided ONCE
 * when the list loads: it must not yank a user pruning on All over to Saved
 * the moment they save their first row.
 *
 * A persisted custom view outranks this — that is the user's explicit pick,
 * restored the way every other list restores it.
 */
export function defaultProspectStageTab(
  counts: { saved: number } | null | undefined,
): ProspectStageTab {
  return counts && counts.saved > 0 ? 'saved' : 'all'
}

/**
 * The filters a NEW custom view starts with when it is created from a tab.
 *
 * A view made from Saved should stay saved — but the tab's own narrowing is
 * an invisible scope filter that a saved view would silently drop. So the
 * "+" seeds the draft with a VISIBLE, editable "Stage is saved" chip instead:
 * the user sees what the view means and can remove it. Needs review seeds
 * nothing — it is a people-flat exception view a custom view cannot rebuild,
 * since custom views query companies.
 */
export function seedFiltersForProspectStageTab(tab: ProspectStageTab | null | undefined): ViewFilter[] {
  if (tab !== 'saved' && tab !== 'dismissed') return []
  return [{ id: crypto.randomUUID(), field: 'stage', operator: 'is', value: tab }]
}
