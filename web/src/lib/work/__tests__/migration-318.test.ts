/**
 * Migration 318 (one-agent plan S3) and the app agree: the system keys are the
 * area faces and the Assistant everywhere a key list lives (the CHECK, 305's
 * guard as 310 left it, the seed, the faces, the loop check, the role seed),
 * the fold moves every reference before the folded rows go, and the guard 283
 * keeps is off for the fold alone. The SQL was applied to DEV and verified
 * there (counts in the PR); this pins the file so a later edit can't drop a
 * rule silently.
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { AREA_KEYS } from '@/lib/packs/registry'

/** The 16 page areas this migration knew; 384 adds content and marketing to the CHECKs, 621 studio. */
const PAGE_AREAS = AREA_KEYS.filter((a) => a !== 'content' && a !== 'marketing' && a !== 'studio')
import { SYSTEM_TEAMMATE_KEYS } from '../system-teammates'
import { SYSTEM_TEAMMATE_FACES } from '@/lib/bots/teammate-faces'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '318_area_faces.sql')!
const SQL = FILE.sql
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** The newest migration defining `public.<fn>`, and that definition's body. */
function newest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    const at = sql.search(needle)
    if (at === -1) continue
    const open = sql.indexOf('$$', at)
    return { file, body: sql.slice(at, sql.indexOf('$$', open + 2) + 2) }
  }
  return { file: '(none)', body: '' }
}

const keyList = (text: string, re: RegExp) => (re.exec(text)?.[1] ?? '').split(',').map((k) => k.trim().replace(/'/g, ''))

describe('migration 318: the key lists', () => {
  it('is the newest definition of every function that names system keys', () => {
    // 402 (merge workspaces) redefines the loop check once more, adding only the
    // merge exemption; its key list is 318's (migration-302.test.ts checks it).
    const redefinedLater: Record<string, string> = { flow_check_ai_team_member: '402_merge_workspaces.sql' }
    for (const fn of [
      'ai_team_member_guard_limits',
      'seed_system_teammates',
      'default_bot_character',
      'free_bot_character',
      'ai_team_member_default_bot_character',
      'flow_check_ai_team_member',
      'seed_role_teammates',
    ]) {
      expect(newest(fn).file, fn).toBe(redefinedLater[fn] ?? '318_area_faces.sql')
    }
  })

  it('the CHECK and the guard admit exactly the app’s keys: the area faces and the Assistant', () => {
    expect([...SYSTEM_TEAMMATE_KEYS]).toEqual(['captures', 'mail', 'prospecting', 'evals', 'crm', 'assistant'])
    expect(keyList(BODY, /add constraint ai_team_member_system_key_check[\s\S]*?system_key in \(([^)]*)\)/i)).toEqual([...SYSTEM_TEAMMATE_KEYS])
    const guard = newest('ai_team_member_guard_limits').body
    expect(keyList(guard, /new\.system_key in \(([^)]*)\)/i)).toEqual([...SYSTEM_TEAMMATE_KEYS])
    // Everything else in 310's guard is kept: the team rule, the trusted callers, the owner gate.
    expect(guard).toContain("coalesce(auth.role(), '') in ('', 'service_role')")
    expect(guard).toContain("public.get_member_role(new.workspace_id) in ('owner', 'admin')")
    expect(guard).toContain("r.slug = 'loop-' || replace(new.system_key, '_', '-')")
  })

  it('no function left names a folded key', () => {
    for (const fn of ['ai_team_member_guard_limits', 'seed_system_teammates', 'default_bot_character', 'ai_team_member_default_bot_character', 'flow_check_ai_team_member', 'seed_role_teammates']) {
      // As a key (a CASE arm, an equality, an IN list); Captures still WEARS the `triage` face.
      expect(newest(fn).body, fn).not.toMatch(/(when |system_key = |system_key in \([^)]*)'(triage|extraction|reconciler|email_drafts)'/)
    }
  })

  it('seeds every key, each on its own anchor recipe, and every face starts where the app says', () => {
    const seed = newest('seed_system_teammates').body
    for (const key of SYSTEM_TEAMMATE_KEYS) expect(seed).toContain(`'${key}', `)
    for (const key of SYSTEM_TEAMMATE_KEYS.filter((k) => k !== 'assistant')) expect(BODY).toContain(`'loop-${key}'`)
    const defaults = newest('default_bot_character').body
    for (const [key, face] of Object.entries(SYSTEM_TEAMMATE_FACES)) expect(defaults).toContain(`when '${key}' then '${face}'`)
    // A face already worn gives way to the next free one.
    expect(seed).toMatch(/a\.bot_character = public\.default_bot_character\(s\.system_key, null\)\s*\) then public\.free_bot_character\(p_workspace_id\)/)
  })

  it('only Captures fronts loops, and both seeded loops are its', () => {
    const check = newest('flow_check_ai_team_member').body
    expect(keyList(check, /system_key not in \(([^)]*)\)/)).toEqual(['captures'])
    expect(check).toContain("when 'seed:triage' then 'captures'")
    expect(check).toContain("when 'seed:reconcile' then 'captures'")
  })

  it('the area columns allow exactly the 16 areas, and a focus is never a thread’s or a bot’s', () => {
    expect(keyList(BODY, /tracked_job_area_check check \([\s\S]*?area in \(([^)]*)\)/i)).toEqual([...PAGE_AREAS])
    expect(keyList(BODY, /chat_conversations_focus_area_check check \([\s\S]*?focus_area in \(([^)]*)\)/i)).toEqual([...PAGE_AREAS])
    expect(BODY).toMatch(/and ai_team_member_id is null\s+and agent_teammate_id is null/)
  })
})

describe('migration 318: the fold', () => {
  it('turns the protect guard off only around the fold, and back on before the new CHECK', () => {
    const off = BODY.indexOf('disable trigger ai_team_member_protect_system')
    const on = BODY.indexOf('enable trigger ai_team_member_protect_system')
    const check = BODY.indexOf('add constraint ai_team_member_system_key_check')
    expect(off).toBeGreaterThan(-1)
    expect(on).toBeGreaterThan(off)
    expect(check).toBeGreaterThan(on)
    expect(BODY.match(/disable trigger/g)).toHaveLength(1)
  })

  it('renames Triage and Email drafts in place, keeping a name someone chose', () => {
    expect(BODY).toContain("when a.system_key = 'triage' and a.name = 'Triage' then 'Captures'")
    expect(BODY).toContain("when a.system_key = 'email_drafts' and a.name = 'Email drafts' then 'Mail'")
    expect(BODY).toContain("case a.system_key when 'triage' then 'captures' else 'mail' end as to_key")
    expect(BODY).toMatch(/update public\.ai_team_member a\s+set system_key = m\.to_key,\s+agent_recipe_id = r\.id,\s+name = m\.new_name/)
  })

  it('moves every reference to a folded row before deleting it: nothing orphaned', () => {
    const del = BODY.indexOf('delete from public.ai_team_member a using area_fold')
    expect(del).toBeGreaterThan(-1)
    for (const move of [
      'update public.tracked_job t set ai_team_member_id = m.to_id',
      'update public.agent_run t set ai_team_member_id = m.to_id',
      'update public.flow t set ai_team_member_id = m.to_id',
      'update public.actions t set assignee_ai_member_id = m.to_id',
      'update public.agent_memory t set ai_team_member_id = m.to_id',
      'update public.bot_relay t set teammate_id = m.to_id',
      'update public.chat_conversations t set agent_teammate_id = m.to_id',
      'insert into public.ai_team_member_skill',
      "jsonb_build_object('teammate_id', m.to_id::text)",
      "jsonb_build_object('raised_by_ai_member_id', m.to_id::text)",
      "jsonb_build_object('fallback_owner_ai_member_id', m.to_id::text)",
      "jsonb_build_object('assignee_ai_member_id', m.to_id::text)",
    ]) {
      const at = BODY.indexOf(move)
      expect(at, move).toBeGreaterThan(-1)
      expect(at, move).toBeLessThan(del)
    }
    // Threads: one per person per bot; a collision becomes a focused conversation, out of its old eve session.
    expect(BODY).toMatch(/row_number\(\) over \(partition by cc\.user_id, m\.to_id/)
    expect(BODY).toContain('focus_area = case when r.rn = 1 and not r.has_own then null else r.to_key end')
    expect(BODY).toContain('eve_session_id = case when r.rn = 1 and not r.has_own then cc.eve_session_id else null end')
  })

  it('folds Extraction and Reconciler into Captures, and any Email drafts left into Mail', () => {
    expect(BODY).toContain("c.system_key = case when f.system_key = 'email_drafts' then 'mail' else 'captures' end")
    expect(BODY).toContain("where f.system_key in ('triage', 'extraction', 'reconciler', 'email_drafts')")
  })

  it('waits at most 5 s for a lock', () => {
    expect(BODY).toMatch(/set local lock_timeout = '5s'/i)
  })

  it('is ONE transaction: BEGIN before its first statement, COMMIT after its last, nothing between that ends it', () => {
    // Statement by statement, `set local` is a no-op, the `on commit drop`
    // temp tables vanish, and a failure would leave 283's guard off and the
    // key CHECK dropped. The whole file runs as one apply.
    const statements = BODY.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements[0]).toBe('begin')
    expect(statements.at(-1)).toBe('commit')
    expect(BODY.match(/^\s*(begin|commit|rollback)\s*;/gim)?.map((s) => s.trim())).toEqual(['begin;', 'commit;'])
    expect(BODY.indexOf('begin;')).toBeLessThan(BODY.indexOf("set local lock_timeout = '5s'"))
    expect(BODY.indexOf('enable trigger ai_team_member_protect_system')).toBeLessThan(BODY.indexOf('commit;'))
    expect(SQL).toContain('one `apply_migration` of the entire file')
  })

  it('the renamed rows’ notices take the new name and the area (7a)', () => {
    const rename = BODY.indexOf('create temp table area_rename on commit drop')
    const notices = BODY.indexOf("from area_rename m\nwhere n.metadata->>'teammate_id' = m.id::text")
    expect(rename).toBeGreaterThan(-1)
    expect(notices).toBeGreaterThan(rename)
    expect(BODY).toContain("|| case when n.metadata ? 'teammate_name' then jsonb_build_object('teammate_name', m.new_name) else '{}'::jsonb end")
    expect(BODY).toContain('title = case when n.title = m.old_name then m.new_name else n.title end')
  })

  it('deletes a folded thread nobody said anything in, and converts the rest under the default title', () => {
    const del = BODY.indexOf('delete from public.chat_conversations cc\nusing area_fold m')
    const convert = BODY.indexOf('with ranked as (')
    expect(del).toBeGreaterThan(-1)
    expect(del).toBeLessThan(convert)
    for (const kept of ['public.chat_messages x', 'public.proposed_change x', 'public.bot_relay x']) {
      expect(BODY.slice(del, convert)).toContain(`not exists (select 1 from ${kept}`)
    }
    expect(BODY).toContain("title = case when r.rn = 1 and not r.has_own then cc.title else 'New conversation' end")
  })

  it('the DEV probe runs section 7 verbatim, from its heading up to the COMMIT', async () => {
    const { foldSection } = await import('../../../../scripts/probe-318-fold')
    const section = foldSection(SQL)
    expect(section).toContain('-- 7. The fold')
    expect(section).toContain('delete from public.ai_team_member a using area_fold m')
    expect(section).not.toContain('commit;')
    expect(section).not.toContain('-- 6b.')
  })
})
