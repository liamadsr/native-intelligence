/**
 * Migration 340: always-on events (A6 follow-up). Pins: no backslash; every
 * statement safe to run twice; agent_run.server_helper gains 'home_turn'
 * (away helpers, Liam 2026-10-15); start_chat_helper is 337's function with
 * only the kind list widened (same 13-argument signature, no overload, the
 * same definer, search_path, per-kind budget and service-role-only grant);
 * the undelivered index covers the turn outcome.
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
const SQL = read('340_always_on_events.sql')
const BODY = flat(SQL)
const fnOf = (body: string) => body.slice(body.indexOf('create or replace function public.start_chat_helper('), body.indexOf('$$;') + 3)
const FN = fnOf(BODY)
const FN_337 = fnOf(flat(read('337_server_helper_budget.sql')))
const SIG = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text)'

describe('migration 340', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent: drop-then-add, create or replace, drop index if exists then create if not exists', () => {
    expect(BODY).toContain('alter table public.agent_run drop constraint if exists agent_run_server_helper_shape;')
    expect(BODY).toContain('drop index if exists public.agent_event_undelivered_idx;')
    expect(BODY).toContain('create index if not exists agent_event_undelivered_idx')
    expect(BODY).not.toMatch(/create function /)
    // No overload: the same signature as 337, nothing dropped.
    expect(BODY).not.toMatch(/drop function/)
  })

  it('the home_turn kind, only on chat work', () => {
    expect(BODY).toContain("check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn') and origin = 'chat'))")
  })

  it('start_chat_helper is 337\'s, with only the kind list widened', () => {
    expect(FN).toContain("if p_server_helper is not null and (p_server_helper not in ('meeting_prep', 'home_turn') or p_teammate_id is not null) then return jsonb_build_object('code', 'INVALID_BRIEF');")
    const widened = FN_337.replace("p_server_helper not in ('meeting_prep')", "p_server_helper not in ('meeting_prep', 'home_turn')")
    expect(FN).toBe(widened)
    expect(FN).toContain('language plpgsql security definer set search_path = public')
    expect(FN).toContain('v_server_live integer := 1;')
    expect(FN).toContain('v_server_daily integer := 6;')
    expect(BODY).toContain(`revoke all on function ${SIG} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${SIG} to service_role;`)
  })

  it('the calendar back-off stamp on connected_account', () => {
    expect(BODY).toContain('alter table public.connected_account add column if not exists agent_read_failed_at timestamptz null;')
  })

  it('the undelivered index covers turn rows beside quiet and notify', () => {
    expect(BODY).toContain("where delivered_at is null and outcome in ('quiet', 'notify', 'turn');")
  })
})
