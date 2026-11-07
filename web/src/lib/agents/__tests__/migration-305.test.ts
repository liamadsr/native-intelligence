/**
 * Migration 305 (bots-v4 B1, decisions 11 and 12) and the app agree: a bot's
 * limits are decision 12's two choices, only an owner, an admin or the server
 * sets them (or a work bot's agent), a teammate stays on its own workspace's
 * team, and a bot's skills are written whole by one locking database call, at
 * most as many as the editor pins, each its workspace's or a system one. The
 * SQL was exercised on DEV inside rolled-back blocks (a team lead's limits
 * change, work-bot re-point, move to a workspace they own and back,
 * cross-workspace insert, made-up system teammate, direct skill write and RPC
 * call each refused; a lead's rename, re-point and default insert, an owner's
 * limits change, the service role's move and RPC, and a workspace made by a
 * signed-in user, the service role or the sign-up path each passed); this pins
 * the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { BOUNDS_CLASSES, MAX_PINNED_SKILLS } from '../editable-fields'
import { SYSTEM_TEAMMATE_KEYS } from '@/lib/work/system-teammates'

const SQL = readFileSync(resolve(__dirname, '../../../../supabase/migrations/305_teammate_limits_and_skills_guard.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

/** The guard function's body, alone. */
const GUARD = /create or replace function public\.ai_team_member_guard_limits\(\).*?\$\$(.*?)\$\$;/.exec(BODY)?.[1] ?? ''
/** The RPC's body, alone. */
const RPC = /create or replace function public\.replace_ai_member_skills\(.*?\$\$(.*?)\$\$;/.exec(BODY)?.[1] ?? ''

/** Where each step sits in `body`, asserting it's there. */
function at(body: string, text: string): number {
  const index = body.indexOf(text)
  expect(index, text).toBeGreaterThan(-1)
  return index
}

describe('migration 305', () => {
  it('holds allowed_side_effects to the editor’s two choices, narrowing any row outside them first', () => {
    const allowed = [...new Set(Object.values(BOUNDS_CLASSES).flat())].sort()
    const check = /check \(allowed_side_effects <@ array\[([^\]]*)\]::text\[\]\)/.exec(BODY)?.[1]
    expect(check?.split(',').map((c) => c.trim().replace(/'/g, '')).sort()).toEqual(allowed)
    expect(at(BODY, 'update public.ai_team_member set allowed_side_effects')).toBeLessThan(
      at(BODY, 'add constraint ai_team_member_allowed_side_effects_check'),
    )
  })

  it('runs both functions with an empty search path', () => {
    expect(BODY).toContain("create or replace function public.ai_team_member_guard_limits() returns trigger language plpgsql security definer set search_path = ''")
    expect(BODY).toContain(
      "create or replace function public.replace_ai_member_skills(p_member_id uuid, p_skill_ids uuid[]) returns void language plpgsql security definer set search_path = ''",
    )
    expect(BODY).not.toContain('set search_path = public')
  })

  it('keeps every teammate on its own workspace’s team, the server included, before trusting anyone', () => {
    const team = at(GUARD, 'if not exists ( select 1 from public.team t where t.id = new.team_id and t.workspace_id = new.workspace_id ) then')
    const trusted = at(GUARD, "if coalesce(auth.role(), '') in ('', 'service_role') then return new; end if;")
    expect(team).toBeLessThan(trusted)
    expect(GUARD.slice(team, trusted)).toContain("errcode = 'check_violation'")
  })

  it('trusts only the service role and no request at all, never a request without a sign-in', () => {
    expect(GUARD).not.toContain('auth.uid() is null')
    expect(GUARD).not.toMatch(/'anon'/)
  })

  it('lets nobody signed in move a teammate to another workspace or make up a system teammate, owners included', () => {
    const trusted = at(GUARD, "if coalesce(auth.role(), '') in ('', 'service_role') then return new; end if;")
    const move = at(GUARD, "if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then")
    const system = at(GUARD, "if tg_op = 'INSERT' and new.is_system and not (")
    const owner = at(GUARD, "if public.get_member_role(new.workspace_id) in ('owner', 'admin') then return new; end if;")
    expect(trusted).toBeLessThan(move)
    expect(move).toBeLessThan(system)
    expect(system).toBeLessThan(owner)
    // A system teammate signed-in users may add is exactly what seeding makes: one of the built-in four, on its loop's recipe.
    // (Migration 310 extended the list with the Assistant and 318 swapped it for the area
    // faces; migration-318.test.ts holds the newest guard to the app's keys.)
    const keys = /new\.system_key in \(([^)]*)\)/.exec(GUARD)?.[1]
    expect(keys?.split(',').map((k) => k.trim().replace(/'/g, ''))).toEqual(['triage', 'extraction', 'email_drafts', 'reconciler'])
    expect(GUARD).toContain("r.slug = 'loop-' || replace(new.system_key, '_', '-') and r.workspace_id is null and r.category = 'agent'")
  })

  it('lets only an owner, an admin or the server set a bot’s limits', () => {
    const owner = at(GUARD, "if public.get_member_role(new.workspace_id) in ('owner', 'admin') then return new; end if;")
    // Anyone else adds a teammate with the defaults only.
    for (const rule of [
      "new.allowed_side_effects is distinct from '{read}'::text[]",
      "new.autonomy is distinct from 'propose'",
      'new.role is not null',
      'new.tool_allowlist is not null',
      "new.can_delegate_to is distinct from '{}'::text[]",
      'or new.fronts_only then',
    ]) {
      expect(at(GUARD, rule)).toBeGreaterThan(owner)
    }
    // ...and changes none of them, nor what a work bot speaks for.
    for (const column of ['allowed_side_effects', 'autonomy', 'role', 'tool_allowlist', 'can_delegate_to', 'fronts_only']) {
      expect(at(GUARD, `new.${column} is distinct from old.${column}`)).toBeGreaterThan(owner)
    }
    expect(GUARD).toContain('(old.fronts_only and new.agent_recipe_id is distinct from old.agent_recipe_id)')
    // The workspace move, the made-up system teammate, the insert defaults and the limits change.
    expect((GUARD.match(/errcode = 'insufficient_privilege'/g) ?? []).length).toBe(4)
    expect(BODY).toContain('before insert or update on public.ai_team_member for each row execute function public.ai_team_member_guard_limits()')
    expect(BODY).toContain('revoke execute on function public.ai_team_member_guard_limits() from public, anon, authenticated')
  })

  it('takes away the client write of a bot’s skills, keeping who may read them', () => {
    expect(BODY).toContain('drop policy if exists "Manage AI team member skills via parent" on public.ai_team_member_skill')
    expect(BODY).toContain('create policy "Managers can view AI team member skills" on public.ai_team_member_skill for select')
    expect(BODY).not.toMatch(/on public\.ai_team_member_skill for (all|insert|update|delete)/)
  })

  it('writes a bot’s skills whole, in order, at most as many as the editor pins, its workspace’s or system ones, under a lock on the bot', () => {
    // Each once, in its first place.
    expect(RPC).toContain('select x.id, min(x.ord) as first from unnest(coalesce(p_skill_ids')
    const limit = at(RPC, `if cardinality(v_ids) > ${MAX_PINNED_SKILLS} then`)
    expect(RPC).toContain("using errcode = 'check_violation'")
    // The lock reads the bot's workspace; the skills must be of it, or system ones.
    const lock = at(RPC, 'select atm.workspace_id into v_workspace from public.ai_team_member atm where atm.id = p_member_id for update;')
    const scope = at(RPC, "r.category = 'skill' and (r.is_system is true or r.workspace_id = v_workspace)")
    expect(RPC).toContain("using errcode = 'foreign_key_violation'")
    // The replace is delete-then-insert in one call, after every check.
    const del = at(RPC, 'delete from public.ai_team_member_skill where ai_team_member_id = p_member_id')
    const ins = at(RPC, 'insert into public.ai_team_member_skill (ai_team_member_id, skill_recipe_id, sort_order)')
    expect(limit).toBeLessThan(lock)
    expect(lock).toBeLessThan(scope)
    expect(scope).toBeLessThan(del)
    expect(del).toBeLessThan(ins)
    // The server's alone: the routes check the rule first.
    expect(BODY).toContain('revoke execute on function public.replace_ai_member_skills(uuid, uuid[]) from public, anon, authenticated')
    expect(BODY).toContain('grant execute on function public.replace_ai_member_skills(uuid, uuid[]) to service_role')
  })
})
