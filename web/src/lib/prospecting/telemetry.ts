/**
 * Per-angle telemetry (spec §14) — "which of the four angles actually worked?"
 *
 * A discovery round fires {@link DISCOVERY_ANGLES_PER_ROUND} differently-shaped
 * searches and stamps the one that produced each candidate onto
 * `prospect_run_candidate.discovery_angle` and `prospect_list_entry
 * .discovery_angle`. Without a read that groups by it, every angle looks
 * equally good from the run summary, and the tuning question the ICP editor
 * exists to answer — "the hiring-signal angle returns nothing for this list,
 * stop paying for it" — has no evidence behind it.
 *
 * THREE NUMBERS, THREE MEANINGS, TWO TABLES. They are deliberately not read
 * from one place, because they answer different questions and the tables
 * disagree on purpose:
 *
 *   * `found`  — every candidate the angle SAW, from `prospect_run_candidate`:
 *                the ledger of the whole search, suppressed and invalid rows
 *                included. This is what the angle cost.
 *   * `new`    — entries that exist and carry the angle, from
 *                `prospect_list_entry`. Lower than `found` by everything the
 *                exclusion set caught.
 *   * `saved`  — of those entries, the ones at `stage='saved'`: the angle's
 *                only unambiguous success signal, since a human pressed Save.
 *
 * Reading `new` from the ledger's `outcome='new'` instead would drift the
 * moment a user DELETES an entry or a merge repoints one, and the entry table
 * is the one the board renders. Reading `found` from entries is impossible —
 * a suppressed candidate never becomes an entry, which is the whole point.
 *
 * An angle with rows in either table appears, so an angle that found 12 and
 * kept 0 is visible as exactly that rather than missing.
 *
 * No network, no LLM. Every query carries an explicit `workspace_id` filter.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readAll } from './exclusions'
import type { ProspectEntryStage } from './types'

/** One row of the "By angle" table under the run-history popover. */
export interface AngleTelemetryRow {
  /** The `discovery_angle` key, e.g. 'lookalike' / 'use_case'. Rows with a
   *  NULL angle — hand-added entries, and anything written before the stamp
   *  existed — are omitted rather than bucketed under a fake name. */
  angle: string
  /** Candidates this angle produced, across every run of the list. */
  found: number
  /** Entries currently in the list that this angle discovered. */
  new: number
  /** Of those entries, how many a human has saved to the CRM. */
  saved: number
}

export interface AngleTelemetryError {
  ok: false
  code: 'DB_ERROR'
  error: string
}

export type AngleTelemetryResult =
  | { ok: true; angles: AngleTelemetryRow[] }
  | AngleTelemetryError

/**
 * Aggregate per-angle counts for one list.
 *
 * Aggregation happens in JS over two paged reads rather than in SQL, matching
 * how `listEntries` and `listLists` already count stages. PostgREST cannot
 * GROUP BY without a database function, and a function here would be a
 * migration whose only job is a count over two small, list-scoped tables.
 *
 * Ordered by `found` descending — the tuning question is "which angle is
 * spending the most for the least", so the expensive angles lead.
 */
export async function listAngleTelemetry(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string },
): Promise<AngleTelemetryResult> {
  let candidates: Array<{ discovery_angle: string | null }>
  let entries: Array<{ discovery_angle: string | null; stage: ProspectEntryStage }>

  try {
    // Both PAGED. `prospect_run_candidate` is the ledger of EVERY candidate a
    // run saw including the suppressed ones, so it is the largest table in the
    // feature and passes 1000 rows well before the entry list does — an
    // unpaginated read would silently under-report `found` for exactly the
    // busy lists this table is for.
    ;[candidates, entries] = await Promise.all([
      readAll<{ discovery_angle: string | null }>('angle candidates', (from, to) =>
        supabase
          .from('prospect_run_candidate')
          .select('discovery_angle')
          .eq('workspace_id', args.workspaceId)
          .eq('list_id', args.listId)
          .order('id')
          .range(from, to),
      ),
      readAll<{ discovery_angle: string | null; stage: ProspectEntryStage }>(
        'angle entries',
        (from, to) =>
          supabase
            .from('prospect_list_entry')
            .select('discovery_angle, stage')
            .eq('workspace_id', args.workspaceId)
            .eq('list_id', args.listId)
            .order('id')
            .range(from, to),
      ),
    ])
  } catch (err) {
    console.error('[prospecting] angle telemetry failed:', err)
    return { ok: false, code: 'DB_ERROR', error: 'Failed to load angle telemetry' }
  }

  const rows = new Map<string, AngleTelemetryRow>()
  const bucket = (angle: string | null): AngleTelemetryRow | null => {
    // A NULL angle is a hand-added entry or a pre-stamp row. It is not an
    // angle, and inventing an 'unknown' bucket would put a number nobody can
    // act on next to four the user is meant to compare.
    if (!angle) return null
    let row = rows.get(angle)
    if (!row) {
      row = { angle, found: 0, new: 0, saved: 0 }
      rows.set(angle, row)
    }
    return row
  }

  for (const c of candidates) {
    const row = bucket(c.discovery_angle)
    if (row) row.found++
  }
  for (const e of entries) {
    const row = bucket(e.discovery_angle)
    if (!row) continue
    row.new++
    if (e.stage === 'saved') row.saved++
  }

  const angles = [...rows.values()].sort(
    // `found` desc, then the angle key, so the order is stable across polls
    // for two angles that happened to see the same number of candidates.
    (a, b) => b.found - a.found || a.angle.localeCompare(b.angle),
  )
  return { ok: true, angles }
}
