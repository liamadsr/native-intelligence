/**
 * Migration 311: deleting a team never takes the workspace's system teammates
 * (the Assistant among them) with it. The SQL was exercised on DEV inside a
 * rolled-back block: deleting the General team moved all five to the next
 * team; deleting the last team, or every team in one statement, was refused
 * (restrict_violation); a signed-in owner's delete through RLS moved them the
 * same way; deleting the whole workspace still cascaded through everything.
 * This pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const DIR = resolve(__dirname, '../../../../supabase/migrations')
/** Comments out, whitespace collapsed: the statements only. */
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const FILE = '311_team_delete_keeps_system_teammates.sql'
const BODY = statements(readFileSync(resolve(DIR, FILE), 'utf8'))
const fnHead = /create or replace function public\.team_keep_system_teammates\(\) returns trigger (.*?) as \$\$/.exec(BODY)?.[1] ?? ''
const FN = /create or replace function public\.team_keep_system_teammates\(\).*?\$\$(.*?)\$\$;/.exec(BODY)?.[1] ?? ''

/** The newest seed_system_teammates body across every migration (what the database runs). */
function latestSeedBody(): string {
  const files = migrationsInOrder()
  for (let i = files.length - 1; i >= 0; i--) {
    const m = /create or replace function public\.seed_system_teammates\(p_workspace_id uuid\).*?\$\$(.*?)\$\$;/.exec(statements(files[i].sql))
    if (m) return m[1]
  }
  return ''
}

describe('migration 311', () => {
  it('is the only 311', () => {
    expect(migrationsInOrder().filter((f) => f.num === 311).map((f) => f.file)).toEqual([FILE])
  })

  it('fires BEFORE each team row is deleted, so the move lands before the cascade', () => {
    expect(BODY).toContain('drop trigger if exists team_keep_system_teammates on public.team;')
    expect(BODY).toContain(
      'create trigger team_keep_system_teammates before delete on public.team for each row execute function public.team_keep_system_teammates();',
    )
  })

  it('runs as its owner (it must see teams and teammates RLS hides) with a fixed search_path, and no one may call it', () => {
    expect(fnHead).toContain('security definer')
    expect(fnHead).toContain('set search_path = public')
    expect(BODY).toContain('revoke execute on function public.team_keep_system_teammates() from public, anon, authenticated;')
  })

  it('lets a workspace delete through first: its row is gone when the cascade reaches its teams', () => {
    const wsGone = FN.indexOf('if not exists (select 1 from public.workspace w where w.id = old.workspace_id) then return old; end if;')
    expect(wsGone).toBeGreaterThan(-1)
    expect(wsGone).toBeLessThan(FN.indexOf('raise exception'))
    expect(wsGone).toBeLessThan(FN.indexOf('update public.ai_team_member'))
  })

  it('moves only the system teammates, to the oldest other team, the seed’s own "default team" order', () => {
    expect(FN).toContain(
      'select t.id into v_target from public.team t where t.workspace_id = old.workspace_id and t.id <> old.id order by t.created_at asc, t.id asc limit 1;',
    )
    expect(latestSeedBody()).toContain('order by t.created_at asc, t.id asc')
    expect(FN).toContain('update public.ai_team_member set team_id = v_target where team_id = old.id and is_system;')
    expect(FN).toMatch(/return old; end;\s*$/)
  })

  it('refuses the delete when no other team is left, with the code the team route answers 409 for', () => {
    expect(FN).toMatch(/if v_target is null then raise exception '[^']*', old\.id using errcode = 'restrict_violation'/)
    const route = readFileSync(resolve(__dirname, '../../../app/api/account/teams/[id]/route.ts'), 'utf8')
    expect(route).toContain("const RESTRICT_VIOLATION = '23001'")
  })

  it('back-fills: every workspace that lost its system teammates gets them back, before the trigger DDL takes its lock', () => {
    const backfill = BODY.indexOf('select public.seed_system_teammates(w.id) from public.workspace w;')
    expect(backfill).toBeGreaterThan(-1)
    expect(backfill).toBeLessThan(BODY.indexOf('drop trigger if exists team_keep_system_teammates'))
  })

  it('waits at most 5 s for a lock, set before any statement that takes one', () => {
    const timeout = BODY.indexOf("set local lock_timeout = '5s';")
    expect(timeout).toBeGreaterThan(-1)
    expect(timeout).toBeLessThan(BODY.indexOf('select public.seed_system_teammates(w.id)'))
    expect(timeout).toBeLessThan(BODY.indexOf('create or replace function public.team_keep_system_teammates'))
  })
})
