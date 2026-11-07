/**
 * Migration 310 (bots-v4 Phase 5, decisions 2 and 7) and the app agree: the
 * Assistant is a fifth system teammate on its own identity anchor, seeded once
 * per workspace (and back-filled) on the reserved `chat` face, which no free
 * pick hands out; 305's guard lets a signed-in creator seed it and nothing
 * else changes in that guard. The SQL was exercised on DEV inside rolled-back
 * blocks (an Assistant insert in seed shape passes for a signed-in creator, a
 * forged system teammate is still refused, a second seed is a no-op, its
 * delete and its re-keying are refused); this pins the file so a later edit
 * can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SYSTEM_TEAMMATE_KEYS } from '@/lib/work/system-teammates'
import { BOT_CHARACTER_ORDER, FREE_BOT_CHARACTER_ORDER, SYSTEM_TEAMMATE_FACES } from '@/lib/bots/teammate-faces'
import { migrationsInOrder } from '@/test/migration-sql'

const DIR = resolve(__dirname, '../../../../supabase/migrations')
/** Comments out, whitespace collapsed: the statements only. */
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = statements(readFileSync(resolve(DIR, '310_assistant_system_teammate.sql'), 'utf8'))
const BODY_305 = statements(readFileSync(resolve(DIR, '305_teammate_limits_and_skills_guard.sql'), 'utf8'))

const fn = (body: string, name: string) => new RegExp(`create or replace function public\\.${name}\\(.*?\\$\\$(.*?)\\$\\$;`).exec(body)?.[1] ?? ''

describe('migration 310', () => {
  it('fails fast on a busy table instead of queueing behind it: a lock timeout before its first statement', () => {
    expect(BODY.indexOf("set local lock_timeout = '5s';")).toBeGreaterThan(-1)
    expect(BODY.indexOf("set local lock_timeout = '5s';")).toBeLessThan(BODY.indexOf('insert into public.recipe'))
  })

  it('adds the Assistant’s identity anchor the way 283 and 302 add theirs: no workspace, personal, no author, not a system recipe', () => {
    expect(BODY).toMatch(
      /insert into public\.recipe \( name, slug, icon, color, description, system_prompt, category, is_system, visibility, sort_order, workspace_id, created_by \) values \( ?'Assistant', 'loop-assistant', '[^']+', '#[0-9a-f]{6}', '[^']+', 'Identity anchor for the Assistant system teammate\.[^']*', 'agent', false, 'personal', 905, null, null\) on conflict do nothing;/,
    )
  })

  it('lets the system key be the five of its day, the Assistant among them (318 swapped them for the area faces)', () => {
    const list = /add constraint ai_team_member_system_key_check check \( system_key is null or \(is_system and system_key in \(([^)]*)\)\) \)/.exec(BODY)?.[1]
    expect(list?.split(',').map((k) => k.trim().replace(/'/g, ''))).toEqual(['triage', 'extraction', 'email_drafts', 'reconciler', 'assistant'])
    expect(SYSTEM_TEAMMATE_KEYS).toContain('assistant')
    expect(BODY.indexOf('drop constraint if exists ai_team_member_system_key_check')).toBeLessThan(BODY.indexOf('add constraint ai_team_member_system_key_check'))
  })

  it('starts the Assistant on `chat`, and takes `chat` out of the free order', () => {
    expect(fn(BODY, 'default_bot_character')).toContain(`when 'assistant' then '${SYSTEM_TEAMMATE_FACES.assistant}'`)
    const free = fn(BODY, 'free_bot_character')
    // 310's free order: the crew's past `chat` alone (318 reserves the area faces' too).
    expect([...free.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual(BOT_CHARACTER_ORDER.filter((c) => c !== 'chat'))
    expect(FREE_BOT_CHARACTER_ORDER).not.toContain('chat')
    expect(free).not.toContain("'chat'")
  })

  it('extends 305’s guard by the Assistant alone: every other word of it is unchanged', () => {
    const guard = fn(BODY, 'ai_team_member_guard_limits')
    const before = fn(BODY_305, 'ai_team_member_guard_limits')
    expect(guard).toContain("new.system_key in ('triage', 'extraction', 'email_drafts', 'reconciler', 'assistant')")
    expect(guard).toContain("r.slug = 'loop-' || replace(new.system_key, '_', '-') and r.workspace_id is null and r.category = 'agent'")
    // The same function once the key list and the refusal's wording are set back to 305's.
    const asBefore = guard
      .replace("'reconciler', 'assistant')", "'reconciler')")
      .replace('a system teammate is one of the built-in five, on its own anchor recipe', "a system teammate is one of the built-in four, on its loop''s recipe")
    expect(asBefore).toBe(before)
    expect(BODY).toContain("create or replace function public.ai_team_member_guard_limits() returns trigger language plpgsql security definer set search_path = ''")
    expect(BODY).toContain('revoke execute on function public.ai_team_member_guard_limits() from public, anon, authenticated')
    // The trigger itself is 305's: the function is replaced under it.
    expect(BODY).not.toContain('create trigger ai_team_member_guard_limits')
  })

  it('seeds the Assistant fifth on the default team, once per workspace, through default_bot_character, service role only', () => {
    const seed = fn(BODY, 'seed_system_teammates')
    expect(seed).toContain("('assistant', 'Assistant', 'loop-assistant', 5)")
    expect(seed).toContain("('reconciler', 'Reconciler', 'loop-reconciler', 4)")
    expect(seed).toContain('else public.default_bot_character(s.system_key, null)')
    expect(seed).toContain('on conflict (workspace_id, system_key) do nothing;')
    expect(seed).toContain('order by t.created_at asc, t.id asc limit 1;')
    // Never a role, autonomy or limits of its own: the columns' defaults (role NULL, 283's CHECK).
    expect(seed).toContain('insert into public.ai_team_member (workspace_id, team_id, name, agent_recipe_id, is_system, system_key, bot_character)')
    expect(BODY).toContain('revoke execute on function public.seed_system_teammates(uuid) from public, anon, authenticated')
    expect(BODY).toContain('grant execute on function public.seed_system_teammates(uuid) to service_role')
  })

  it('back-fills every existing workspace with the same seed, after the seed is replaced', () => {
    const backfill = BODY.indexOf('select public.seed_system_teammates(w.id) from public.workspace w;')
    expect(backfill).toBeGreaterThan(BODY.indexOf('create or replace function public.seed_system_teammates('))
  })

  it('was the newest word on each function it replaces until 318, and leaves the system-row guard (no delete, fixed key) as 283 has it, until 402 adds the merge exemption', () => {
    const migrations = migrationsInOrder()
    const newest = (name: string) =>
      [...migrations].reverse().find((m) => new RegExp(`create or replace function public\\.${name}\\(`, 'i').test(m.sql))?.file
    for (const name of ['default_bot_character', 'free_bot_character', 'ai_team_member_guard_limits', 'seed_system_teammates']) {
      expect(newest(name), name).toBe('318_area_faces.sql')
    }
    // 402 (merge workspaces) redefines the guard with one addition: it steps aside
    // inside a merge, which folds the source's system teammates onto the
    // destination's twins first. migration-402.test.ts pins that the rest is 283's.
    expect(newest('ai_team_member_protect_system')).toBe('402_merge_workspaces.sql')
    // The unique (workspace_id, system_key) index the seed's ON CONFLICT names.
    expect(migrations.some((m) => /create unique index if not exists ai_team_member_workspace_system_key_uidx\s+on public\.ai_team_member \(workspace_id, system_key\)/.test(m.sql))).toBe(true)
  })
})
