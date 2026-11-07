/**
 * What scripts/backfill-work-area.ts needs from the database before it may
 * write anything: migrations 316 (recipe.area), 317 (area_memory, which the
 * packs read alongside) and 318 (tracked_job.area, chat_conversations.focus_area,
 * and the area faces seeded). Checked first, so a run against a database that
 * lacks any of them stops with nothing written, never halfway through an
 * --execute.
 *
 * Each check is a zero-row read of the column or row it needs: PostgREST
 * refuses a select naming a column that doesn't exist, so an error is a
 * missing migration.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PreflightCheck {
  /** What is missing, and the migration that adds it. */
  missing: string
}

const COLUMN_CHECKS: ReadonlyArray<{ table: string; column: string; migration: string }> = [
  { table: 'recipe', column: 'area', migration: '316_skill_area_and_playbooks.sql' },
  { table: 'area_memory', column: 'area', migration: '317_area_memory.sql' },
  { table: 'tracked_job', column: 'area', migration: '318_area_faces.sql' },
  { table: 'chat_conversations', column: 'focus_area', migration: '318_area_faces.sql' },
]

/** Everything the back-fill needs that the database lacks; empty when it may run. Never throws. */
export async function areaBackfillPreflight(supabase: SupabaseClient): Promise<PreflightCheck[]> {
  const missing: PreflightCheck[] = []
  for (const check of COLUMN_CHECKS) {
    try {
      const { error } = await supabase.from(check.table).select(check.column).limit(0)
      if (error) missing.push({ missing: `${check.table}.${check.column} (apply ${check.migration}): ${error.message}` })
    } catch (err) {
      missing.push({ missing: `${check.table}.${check.column} (apply ${check.migration}): ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  // 318's fold seeds an area face in every workspace with a team: one Captures row shows it ran.
  try {
    const { data, error } = await supabase.from('ai_team_member').select('id').eq('system_key', 'captures').limit(1)
    if (error || !data || data.length === 0) {
      missing.push({ missing: `the area faces (apply 318_area_faces.sql: no Captures teammate found${error ? `: ${error.message}` : ''})` })
    }
  } catch (err) {
    missing.push({ missing: `the area faces (apply 318_area_faces.sql): ${err instanceof Error ? err.message : String(err)}` })
  }
  return missing
}
