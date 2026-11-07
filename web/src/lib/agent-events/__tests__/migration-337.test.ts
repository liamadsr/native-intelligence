/**
 * Migration 337: a budget of their own for server-started helpers (A6 slice
 * 5). Pins: no backslash; every statement safe to run twice; the 12-argument
 * start_chat_helper from 332 dropped explicitly and the 13-argument form
 * created with 332's security definer, pinned search_path and service-role-only
 * grant; a person's helpers counted without server-started ones; a server kind
 * checked, never as a custom agent, with its own per-person live and daily
 * caps (a question holds no slot); the run row carries the kind; 332's other
 * checks still in their order.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/337_server_helper_budget.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
const FN = BODY.slice(BODY.indexOf('create or replace function public.start_chat_helper('), BODY.indexOf('$$;') + 3)
const OLD = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[])'
const NEW = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text)'

describe('migration 337', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent: if-not-exists, drop-then-add, drop-if-exists, create or replace', () => {
    expect(BODY).toContain('alter table public.agent_run add column if not exists server_helper text null;')
    expect(BODY).toContain('alter table public.agent_run drop constraint if exists agent_run_server_helper_shape;')
    expect(BODY).toContain('create index if not exists agent_run_server_helper_idx')
    expect(BODY).toContain(`drop function if exists ${OLD};`)
    expect(BODY.indexOf(`drop function if exists ${OLD};`)).toBeLessThan(BODY.indexOf('create or replace function public.start_chat_helper('))
    expect(BODY).not.toMatch(/create function /)
  })

  it('agent_run.server_helper: a known kind, only on chat work', () => {
    expect(BODY).toContain("check (server_helper is null or (server_helper in ('meeting_prep') and origin = 'chat'))")
  })

  it('the new form: one more argument defaulting to null, 332’s definer and search_path, service_role only', () => {
    expect(FN).toContain('p_chat_ceiling text[], p_areas text[], p_server_helper text default null ) returns jsonb')
    expect(FN).toContain('language plpgsql security definer set search_path = public')
    expect(BODY).toContain(`revoke all on function ${NEW} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${NEW} to service_role;`)
    expect(BODY).not.toMatch(/grant execute on function public\.start_chat_helper[^;]*(authenticated|anon)/)
  })

  it('a person’s live and daily counts leave server-started helpers out', () => {
    expect(FN).toContain("and origin = 'chat' and chat_conversation_id = p_conversation_id and server_helper is null and status in ('queued', 'running', 'needs_input')) >= v_live")
    expect(FN).toContain("and origin = 'chat' and server_helper is null and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_daily")
  })

  it('a server kind: checked, never as a custom agent, with its own per-person caps (a question holds no slot)', () => {
    expect(FN).toContain("if p_server_helper is not null and (p_server_helper not in ('meeting_prep') or p_teammate_id is not null) then return jsonb_build_object('code', 'INVALID_BRIEF');")
    expect(FN).toContain('v_server_live integer := 1;')
    expect(FN).toContain('v_server_daily integer := 6;')
    expect(FN).toContain("and triggered_by = p_user_id and server_helper = p_server_helper and status in ('queued', 'running')) >= v_server_live")
    expect(FN).toContain("return jsonb_build_object('code', 'SERVER_LIVE');")
    expect(FN).toContain("return jsonb_build_object('code', 'SERVER_DAY_BUDGET');")
  })

  it('the run row carries the kind', () => {
    expect(FN).toContain('ai_team_member_id, fire_key, expects, helper_areas, server_helper)')
    expect(FN).toContain('v_target, v_key, p_expects, p_areas, p_server_helper)')
  })

  it('keeps 332’s checks in their order', () => {
    const order = [
      'for no key update',
      "code', 'NOT_A_MEMBER'",
      "code', 'CONVERSATION_UNAVAILABLE'",
      "code', 'INVALID_BRIEF'",
      "code', 'AUTONOMY_OFF'",
      "code', 'CALL_ID_CONFLICT'",
      "code', 'LIVE_HELPERS'",
      "code', 'DAY_BUDGET'",
      "code', 'SERVER_LIVE'",
      "code', 'SERVER_DAY_BUDGET'",
      "code', 'AGENT_NOT_FOUND'",
      "code', 'USAGE_LIMIT'",
      'insert into public.agent_run',
    ].map((needle) => FN.indexOf(needle))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})
