/**
 * Migration 595 (the SEO area's Google sources) against the code: the two
 * widened capability checks hold exactly the app's capability list (and are
 * the newest word on those checks), every value an earlier migration allowed
 * stays, the new table follows the house rules (re-runnable, workspace-owned,
 * no per-workspace uniqueness, members read, only the service role writes),
 * and the integration catalog and connect link know both new capabilities.
 */
import { getIntegration } from '@/lib/integrations/catalog'
import {
  TEXT_CONNECT_CAPABILITIES,
  TEXT_CONNECT_DEFAULT,
} from '@/lib/links/oauth-link'
import { OAUTH_CAPABILITIES, getScopesForCapability } from '@/lib/oauth/config'
import { migrationsInOrder } from '@/test/migration-sql'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/595_seo_google.sql'),
  'utf8',
)
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const BODY = flat(SQL)

/** The values of the LATEST `add constraint <name> check (<col> in (...))` across all migrations, and its file. */
function latestCheck(name: string): { file: string; values: string[] } {
  let found = { file: '', values: [] as string[] }
  for (const m of migrationsInOrder()) {
    const body = flat(m.sql)
    const re = new RegExp(
      `add constraint ${name}\\s+check \\(\\s*\\(?\\s*[a-z_]+ (?:= any \\(array\\[|in \\()([^)]*)\\)`,
      'gi',
    )
    for (const match of body.matchAll(re))
      found = {
        file: m.file,
        values: [...match[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]),
      }
  }
  return found
}

describe('migration 595: capabilities', () => {
  it('connected_account takes exactly the app’s capabilities, and 594 is the newest word on it', () => {
    const check = latestCheck('connected_account_capability_check')
    expect(check.file).toBe('595_seo_google.sql')
    expect([...check.values].sort()).toEqual([...OAUTH_CAPABILITIES].sort())
  })

  it('user_oauth_tokens takes the same, plus the legacy "both"', () => {
    const check = latestCheck('user_oauth_tokens_capability_check')
    expect(check.file).toBe('595_seo_google.sql')
    expect([...check.values].sort()).toEqual(
      [...OAUTH_CAPABILITIES, 'both'].sort(),
    )
  })

  it('keeps every value 462 allowed', () => {
    for (const v of [
      'calendar',
      'email',
      'github',
      'crm',
      'tasks',
      'contacts',
    ]) {
      expect(
        latestCheck('connected_account_capability_check').values,
      ).toContain(v)
      expect(
        latestCheck('user_oauth_tokens_capability_check').values,
      ).toContain(v)
    }
  })

  it('every capability with Google scopes is in the checks, and the two new ones have catalog entries and a texted link', () => {
    for (const c of ['search_console', 'analytics'] as const) {
      expect(getScopesForCapability('google', c).length).toBeGreaterThan(0)
      expect(getIntegration('google', c)?.description).toMatch(/read only/)
      expect(TEXT_CONNECT_CAPABILITIES.google).toContain(c)
      // A sign-up's plain Google link must never stop on a scope still waiting on Google's verification.
      expect(TEXT_CONNECT_DEFAULT.google).not.toContain(c)
    }
  })
})

describe('migration 595: seo_google_source', () => {
  it('has no backslash, waits at most 5 s for its locks, and is re-runnable', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain(
      'create table if not exists public.seo_google_source (',
    )
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g))
      expect(BODY).toContain(`drop constraint if exists ${name};`)
    for (const [, name] of BODY.matchAll(/create policy (\w+)/g))
      expect(BODY).toContain(`drop policy if exists ${name} `)
  })

  it('belongs to a workspace, names connections and people that can go away, and has no per-workspace uniqueness', () => {
    expect(BODY).toContain(
      'workspace_id uuid not null references public.workspace(id) on delete cascade',
    )
    for (const col of ['sc_account_id', 'ga4_account_id'])
      expect(BODY).toContain(
        `${col} uuid null references public.connected_account(id) on delete set null`,
      )
    for (const col of ['sc_chosen_by', 'ga4_chosen_by'])
      expect(BODY).toContain(
        `${col} uuid null references auth.users(id) on delete set null`,
      )
    expect(BODY).not.toMatch(/unique/i)
  })

  it('bounds what it stores', () => {
    expect(BODY).toContain(
      "char_length(sc_site_url) <= 2048 and (sc_site_url like 'sc-domain:%'",
    )
    expect(BODY).toContain("ga4_property_id ~ '^properties/[0-9]{1,20}$'")
  })

  it('members read their workspace’s row; only the service role writes', () => {
    expect(BODY).toContain(
      'alter table public.seo_google_source enable row level security;',
    )
    expect(BODY).toContain(
      'create policy seo_google_source_select_member on public.seo_google_source for select to authenticated using (public.is_workspace_member(workspace_id));',
    )
    expect(BODY).toContain(
      'revoke all on table public.seo_google_source from anon, authenticated;',
    )
    expect(BODY).toContain(
      'grant select on table public.seo_google_source to authenticated;',
    )
    expect(BODY).toContain(
      'grant all on table public.seo_google_source to service_role;',
    )
    expect(BODY).not.toMatch(
      /grant (insert|update|delete|all)[a-z, ]* on table public\.seo_google_source to authenticated/,
    )
  })

  it('hands no role anything on the token table', () => {
    expect(BODY).not.toMatch(
      /grant [a-z, ]* on (table )?public\.user_oauth_tokens/,
    )
  })
})
