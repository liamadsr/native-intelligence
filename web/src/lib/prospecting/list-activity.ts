'use client'

/**
 * What is happening on the open prospect list RIGHT NOW — published by the
 * list page, read by the rows.
 *
 * The row renderer lives in the shared views system
 * (`src/components/views/list/entity-row.tsx`), which may not import from the
 * prospecting page folder, yet three of its states depend on page-level facts
 * only the run poll knows:
 *
 *   * "Scoring…" — an unscored company while the profile run that will score
 *     it is live. Without this the row would have to choose between a dash
 *     (reads as "nothing is happening" during the one minute something is)
 *     and a permanent spinner (lies after a failed or cancelled run).
 *   * the searching orb in the Find people slot — a company the live PEOPLE
 *     run is searching right now. Liam (2026-09-06): "the find people turns
 *     into that search globe icon… it would show that icon on each of the
 *     lines until it resolves. So we don't need that top header thing." The
 *     page draws no run rail for a people run; the rows are the rail.
 *   * whether to offer a per-row Find people button at all — one run per list
 *     is live at a time, and a button that 409s is worse than none.
 *
 * A React context in `src/lib/prospecting/` is the one place both sides may
 * reach. The page provides it around `<UnifiedViewLayout>`; a row rendered
 * anywhere else (a board, a widget, a test) gets the idle default.
 */

import { createContext, useContext } from 'react'

export interface ProspectListActivity {
  /** Any run — discover, profile, people — is live on this list. */
  runLive: boolean
  /** The live run is the profile run: unscored rows are about to be scored. */
  profiling: boolean
  /**
   * The live PEOPLE run, or null: the company entry ids it is searching and
   * when it started. A targeted row shows the orb in place of Find people
   * until one of three things resolves it — people land beneath it, its
   * `candidate.people_searched_at` stamp is newer than `since` (searched,
   * nobody found), or the run settles and this goes back to null.
   *
   * `since` is the run's own clock (`started_at`, else `created_at`) so a
   * stamp left by an EARLIER people search on the same company cannot resolve
   * the orb before this search has reached it.
   */
  findingPeople: { ids: ReadonlySet<string>; since: string } | null
}

export const IDLE_ACTIVITY: ProspectListActivity = {
  runLive: false,
  profiling: false,
  findingPeople: null,
}

export const ProspectListActivityContext = createContext<ProspectListActivity>(IDLE_ACTIVITY)

export function useProspectListActivity(): ProspectListActivity {
  return useContext(ProspectListActivityContext)
}
