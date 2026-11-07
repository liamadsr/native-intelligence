/**
 * Migration 302 (bots-v3 Phase 3) and the app agree: the work-bot anchor's
 * slug, the system teammates that may front loops, and the trigger's refusals
 * (another workspace's teammate, a system teammate with another job, a private
 * team the editor or the run-as member is not on). The SQL was also exercised
 * on DEV (each refusal raised, each allowed case passed, inside rolled-back
 * blocks); this pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { LOOP_FRONTING_SYSTEM_KEYS, WORK_BOT_ANCHOR_SLUG } from '../flow-bot'
import { migrationsInOrder } from '@/test/migration-sql'

const SQL = readFileSync(resolve(__dirname, '../../../../supabase/migrations/302_every_loop_has_a_bot.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 302', () => {
  it('adds flow.ai_team_member_id as a nullable FK that a deleted bot nulls, indexed', () => {
    expect(BODY).toContain('add column if not exists ai_team_member_id uuid null references public.ai_team_member(id) on delete set null')
    expect(BODY).toMatch(/create index if not exists idx_flow_ai_team_member on public\.flow \(ai_team_member_id\)/)
  })

  it('adds fronts_only with a CHECK that keeps a work bot unroutable and not a system teammate', () => {
    expect(BODY).toContain('add column if not exists fronts_only boolean not null default false')
    expect(BODY).toContain('check (not fronts_only or (role is null and not is_system))')
  })

  it('seeds one global anchor recipe, invisible to persona lists', () => {
    expect(BODY).toContain(`'${WORK_BOT_ANCHOR_SLUG}'`)
    expect(BODY).toMatch(/'agent', false, 'personal', 904, null, null\)/)
  })

  it('refuses another workspace, a system teammate with another job, and unreachable private teams', () => {
    expect(BODY).toContain('v_mate.workspace_id is distinct from new.workspace_id')
    // The key list follows the function forward (migration 318: Captures alone fronts
    // loops; 402 redefines the function once more, adding only the merge exemption).
    const latest = [...migrationsInOrder()].reverse().find((m) => /create or replace function public\.flow_check_ai_team_member\(/i.test(m.sql))!
    expect(latest.file).toBe('402_merge_workspaces.sql')
    const keys = /system_key not in \(([^)]*)\)/.exec(latest.sql)?.[1]
    expect(keys?.split(',').map((k) => k.trim().replace(/'/g, ''))).toEqual([...LOOP_FRONTING_SYSTEM_KEYS])
    // The editor (auth.uid()) and the run-as member (creator, else owner) must both be on a private team.
    expect(BODY).toContain('v_editor uuid := auth.uid()')
    expect(BODY).toContain('m.user_id = v_editor')
    expect(BODY).toContain('and m.user_id = new.created_by')
    expect(BODY).toContain("and m.role = 'owner'")
    expect(BODY).toContain('tm.member_id = v_run_as')
    expect((BODY.match(/errcode = 'check_violation'/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('fires before insert or update on flow, re-checking when the bot, the workspace or the seed key changes', () => {
    expect(BODY).toContain('before insert or update on public.flow')
    // Skips only when none of what it checks changed.
    expect(BODY).toContain(
      'if new.ai_team_member_id is not distinct from old.ai_team_member_id and new.seed_key is not distinct from old.seed_key then return new',
    )
    // A loop moved to another workspace drops its bot rather than point across workspaces.
    expect(BODY).toContain(
      'if new.workspace_id is distinct from old.workspace_id and new.ai_team_member_id is not distinct from old.ai_team_member_id then new.ai_team_member_id := null; return new',
    )
  })
})
