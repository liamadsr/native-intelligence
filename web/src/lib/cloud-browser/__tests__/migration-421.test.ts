/**
 * Migration 421 (cloud_browser). Postgres-only properties, read from the
 * migrations as text (src/test/migration-sql.ts): the table is owner-read-only,
 * and a workspace merge never re-stamps it (its key and sandbox name come from
 * the source workspace; the reconcile cron removes the orphan instead).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { latestDefinition } from '@/test/migration-sql'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/421_cloud_browser.sql'), 'utf8')

describe('migration 421: cloud_browser', () => {
  it('enables RLS with an owner-select policy and no write policy', () => {
    expect(sql).toContain('alter table public.cloud_browser enable row level security')
    expect(sql).toMatch(/create policy cloud_browser_own_select on public\.cloud_browser\s+for select to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/)
    expect(sql).not.toMatch(/for (insert|update|delete|all)/i)
  })

  it('keeps cloud_browser out of the workspace merge re-stamp (in the latest definition)', () => {
    const { file, blocks } = latestDefinition('_wsmerge_generic_restamp')
    // 473 (deals) redefines it to fold deals first, and 645 (joining) to drop
    // the source's join link and domain claim, both keeping this list as is.
    expect(['421_cloud_browser.sql', '473_deals_pipelines_custom_fields.sql', '645_workspace_join.sql']).toContain(file)
    expect(blocks.join('\n')).toContain("NOT IN ('workspace', 'workspace_move_log', 'workspace_merge', 'cloud_browser')")
  })
})
