/**
 * Migration 644: joining a workspace. Pins the file: the two service-only
 * tables (RLS on, no policies, everything revoked from anon and
 * authenticated and nothing granted back), the lowercased unique domain
 * index, the token's shape, member.joined_via with its CHECK and its guard,
 * and the merge re-stamp restated from 473 with only the two deletes added.
 * Re-runnable, bounded, no backslash.
 *
 * The SQL was also applied twice on PGlite (a real Postgres engine, one
 * connection, stubbed roles and auth schema) with RLS, grants, the unique
 * index, the CHECKs, the guard and the re-stamp asserted there.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestDefinition } from '@/test/migration-sql'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILE = '644_workspace_join.sql'
const SQL = readFileSync(join(DIR, FILE), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\$\$[\s\S]*?\$\$/g, (body) => body.replace(/;/g, '<semi>'))
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const BODY = STATEMENTS.join(';\n')

describe('migration 644', () => {
  it('is the only 644, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 644)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('is re-runnable: every create guards itself', () => {
    for (const s of STATEMENTS) {
      if (/^create table /i.test(s)) expect(s, s).toMatch(/^create table if not exists /i)
      if (/^create (unique )?index /i.test(s)) expect(s, s).toMatch(/^create (unique )?index if not exists /i)
      if (/^create trigger /i.test(s)) expect(BODY).toContain('drop trigger if exists member_guard_joined_via on public.member')
      if (/^create (or replace )?function /i.test(s)) expect(s, s).toMatch(/^create or replace function /i)
      if (/^alter table public\.member add column /i.test(s)) expect(s).toMatch(/add column if not exists joined_via/)
    }
  })

  for (const table of ['workspace_join_settings', 'workspace_join_link']) {
    it(`${table}: RLS on, no policy, no client grant, the service role keeps all`, () => {
      expect(STATEMENTS).toContain(`alter table public.${table} enable row level security`)
      expect(STATEMENTS).toContain(`revoke all on table public.${table} from anon, authenticated`)
      expect(STATEMENTS).toContain(`grant all on table public.${table} to service_role`)
      expect(BODY).not.toMatch(new RegExp(`create policy [^;]* on public\\.${table}`, 'i'))
      expect(BODY).not.toMatch(new RegExp(`grant [^;]* on (table )?public\\.${table} to [^;]*(anon|authenticated)`, 'i'))
      expect(BODY).toMatch(new RegExp(`create table if not exists public\\.${table} \\( workspace_id uuid primary key references public\\.workspace \\(id\\) on delete cascade`))
    })
  }

  it('a domain is claimed once, stored lowercased, and switched off by null', () => {
    expect(STATEMENTS).toContain(
      'create unique index if not exists workspace_join_settings_domain_key on public.workspace_join_settings (auto_join_domain) where auto_join_domain is not null',
    )
    expect(BODY).toContain('auto_join_domain = lower(btrim(auto_join_domain))')
    expect(BODY).toContain('members_can_invite boolean not null default false')
  })

  it('the link: a unique url-safe token of at least 128 bits, off by default', () => {
    expect(BODY).toContain("constraint workspace_join_link_token_check check (token ~ '^[A-Za-z0-9_-]{22,128}$')")
    expect(STATEMENTS).toContain('create unique index if not exists workspace_join_link_token_key on public.workspace_join_link (token)')
    expect(BODY).toContain('enabled boolean not null default false')
  })

  it('member.joined_via: invite, link or domain, or null; only the server changes it', () => {
    expect(STATEMENTS).toContain(
      "alter table public.member add column if not exists joined_via text constraint member_joined_via_check check (joined_via is null or joined_via in ('invite', 'link', 'domain'))",
    )
    const guard = STATEMENTS.find((s) => s.startsWith('create or replace function public.member_guard_joined_via()'))!
    expect(guard).toContain("security definer set search_path = ''")
    expect(guard).toContain("if coalesce(auth.role(), '') in ('', 'service_role') then return new<semi> end if<semi>")
    expect(guard).toContain('if new.joined_via is distinct from old.joined_via then raise exception')
    expect(STATEMENTS).toContain(
      'create trigger member_guard_joined_via before update of joined_via on public.member for each row execute function public.member_guard_joined_via()',
    )
    expect(STATEMENTS).toContain('revoke execute on function public.member_guard_joined_via() from public, anon, authenticated')
  })

  it('a merge drops the source’s link and claim: the re-stamp is 473’s plus two deletes, first', () => {
    const newest = latestDefinition('_wsmerge_generic_restamp')
    expect(newest.file).toBe(FILE)
    const ours = newest.blocks.join('\n')
    const before = latestDefinition(
      '_wsmerge_generic_restamp',
      [{ file: '473_deals_pipelines_custom_fields.sql', num: 473, sql: readFileSync(join(DIR, '473_deals_pipelines_custom_fields.sql'), 'utf8') }],
    ).blocks.join('\n')
    expect(before).not.toBe('')
    const added = [
      '  -- Joining (644): the source\'s link and domain claim end with it. They are',
      '  -- never handed to the destination, which keeps its own switches.',
      '  DELETE FROM public.workspace_join_link WHERE workspace_id = p_source;',
      '  DELETE FROM public.workspace_join_settings WHERE workspace_id = p_source;',
    ]
    const stripped = ours.split('\n').filter((l) => !added.includes(l)).join('\n')
    expect(stripped.trim()).toBe(before.trim())
    expect(ours.indexOf('DELETE FROM public.workspace_join_link')).toBeLessThan(ours.indexOf('FOR r IN'))
    expect(STATEMENTS).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_generic_restamp(uuid, uuid) FROM PUBLIC, anon, authenticated')
  })

  it('changes nothing else that already exists', () => {
    const touched = STATEMENTS.filter((s) => /^(create or replace function|alter table|drop|create trigger)/i.test(s))
    expect(touched.map((s) => s.slice(0, 80))).toEqual([
      'alter table public.workspace_join_settings enable row level security',
      'alter table public.workspace_join_link enable row level security',
      'alter table public.member add column if not exists joined_via text constraint member_joined_via_check check (',
      "create or replace function public.member_guard_joined_via() returns trigger language plpgsql security definer s",
      'drop trigger if exists member_guard_joined_via on public.member',
      'create trigger member_guard_joined_via before update of joined_via on public.member for each row execute funct',
      'CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid) RETURNS jsonb LANGUAGE p',
    ].map((s) => s.slice(0, 80)))
  })
})
