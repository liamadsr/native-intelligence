/**
 * Migration 355: meeting preps have no daily cap. Pins: no backslash; safe to
 * run twice; start_chat_helper is 340's function with only the server daily
 * check skipping the kind 'meeting_prep' (same 13-argument signature, no
 * overload, the same definer, search_path, one-working rule, kind list and
 * service-role-only grant), so 'home_turn' keeps its 6 a day.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const SQL = read('355_preps_uncapped.sql')
const BODY = flat(SQL)
const fnOf = (body: string) => body.slice(body.indexOf('create or replace function public.start_chat_helper('), body.indexOf('$$;') + 3)
const FN = fnOf(BODY)
const FN_340 = fnOf(flat(read('340_always_on_events.sql')))
const SIG = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text)'
const DAILY_340 =
  "if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_server_daily then return jsonb_build_object('code', 'SERVER_DAY_BUDGET');"
const DAILY_355 =
  "if p_server_helper <> 'meeting_prep' and (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_server_daily then return jsonb_build_object('code', 'SERVER_DAY_BUDGET');"

describe('migration 355', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent: create or replace on the same signature, nothing dropped, no overload', () => {
    expect(BODY).toContain(`create or replace function ${SIG.replace(/\(.*\)$/, '(')}`)
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).not.toMatch(/drop function/)
    expect(BODY).toContain(`revoke all on function ${SIG} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${SIG} to service_role;`)
  })

  it("start_chat_helper is 340's, with only the daily check skipping meeting_prep", () => {
    expect(FN_340).toContain(DAILY_340)
    expect(FN).toContain(DAILY_355)
    expect(FN).toBe(FN_340.replace(DAILY_340, DAILY_355))
  })

  it('keeps the one-working rule, the 6-a-day budget for home turns, the kind list and the definer', () => {
    expect(FN).toContain('v_server_live integer := 1;')
    expect(FN).toContain('v_server_daily integer := 6;')
    expect(FN).toContain(
      "if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper and status in ('queued', 'running')) >= v_server_live then return jsonb_build_object('code', 'SERVER_LIVE');",
    )
    expect(FN).toContain("p_server_helper not in ('meeting_prep', 'home_turn')")
    expect(FN).toContain('language plpgsql security definer set search_path = public')
  })

  it('the header says why, what changes, and how it is applied', () => {
    expect(SQL).toContain('Applied by hand, from this file: to DEV, then to PROD on the owner\'s word.')
    expect(SQL).toContain('Idempotent')
  })
})
