/**
 * Migration 424 (browser_site_memory), read as text: owner-read-only, and no
 * workspace_id (a workspace merge never re-stamps it).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/424_browser_site_memory.sql'), 'utf8')
const code = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')

describe('migration 424: browser_site_memory', () => {
  it('enables RLS with an owner-select policy and no write policy', () => {
    expect(code).toContain('alter table public.browser_site_memory enable row level security')
    expect(code).toMatch(/create policy browser_site_memory_own_select on public\.browser_site_memory\s+for select to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/)
    expect(code).not.toMatch(/for (insert|update|delete|all)/i)
  })

  it('is keyed per person and site, with no workspace column', () => {
    expect(code).toContain('primary key (user_id, site)')
    expect(code).not.toContain('workspace_id')
  })
})
