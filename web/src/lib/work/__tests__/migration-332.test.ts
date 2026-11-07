/**
 * Migration 332: background helpers (A4 slice 4). Pins: no backslash (the
 * PROD apply path mangles them); every statement safe to run twice; the
 * admission RPC is service-role only and checks membership, conversation
 * ownership, autonomy, the LIVE helper cap (not lifetime), the daily cap, the
 * usage limit and (only when one is named) the custom agent; the member insert
 * policy still keeps chat work, a chat bound and helper areas out of members'
 * hands; bot_relay gains mode and applied_at.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/332_helpers.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
const FN = BODY.slice(BODY.indexOf('create or replace function public.start_chat_helper('), BODY.indexOf('$$;') + 3)
const SIGNATURE = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[])'

describe('migration 332', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('adds agent_run.helper_areas, nullable, bounded to two and only on chat work', () => {
    expect(BODY).toContain('alter table public.agent_run add column if not exists helper_areas text[] null;')
    expect(BODY).toContain("check (helper_areas is null or (cardinality(helper_areas) between 1 and 2 and origin = 'chat'))")
  })

  it('restates the member insert policy: no chat work, chat bound, helper areas or helper key from a member', () => {
    const policy = BODY.slice(BODY.indexOf('create policy agent_run_insert'), BODY.indexOf(';', BODY.indexOf('create policy agent_run_insert')))
    expect(BODY.indexOf('drop policy if exists agent_run_insert')).toBeGreaterThan(-1)
    for (const part of ["origin <> 'chat'", 'chat_conversation_id is null', 'chat_ceiling is null', 'helper_areas is null', "not like 'chat-delegate:%'", "not like 'chat-helper:%'"]) {
      expect(policy, part).toContain(part)
    }
  })

  it('bot_relay gains mode (turn | steer, default turn) and applied_at, steer-only', () => {
    expect(BODY).toContain("alter table public.bot_relay add column if not exists mode text not null default 'turn';")
    expect(BODY).toContain('alter table public.bot_relay add column if not exists applied_at timestamptz null;')
    expect(BODY).toContain("check (mode in ('turn', 'steer'))")
    expect(BODY).toContain("check (applied_at is null or mode = 'steer')")
    expect(BODY).toContain("where mode = 'steer' and applied_at is null")
  })

  it('start_chat_helper is a security definer callable by service_role only', () => {
    expect(FN).toContain('language plpgsql security definer set search_path = public')
    expect(BODY).toContain(`revoke all on function ${SIGNATURE} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${SIGNATURE} to service_role;`)
    expect(BODY).not.toMatch(/grant execute on function public\.start_chat_helper[^;]*(authenticated|anon)/)
  })

  it('checks the workspace lock, membership, conversation ownership and autonomy before anything else', () => {
    const order = [
      'for no key update',
      "code', 'NOT_A_MEMBER'",
      "code', 'CONVERSATION_UNAVAILABLE'",
      "code', 'INVALID_BRIEF'",
      "code', 'AUTONOMY_OFF'",
      "code', 'CALL_ID_CONFLICT'",
      "code', 'LIVE_HELPERS'",
      "code', 'DAY_BUDGET'",
      "code', 'AGENT_NOT_FOUND'",
      "code', 'USAGE_LIMIT'",
      'insert into public.agent_run',
    ].map((needle) => FN.indexOf(needle))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('caps LIVE helpers in the conversation, not every helper it ever had', () => {
    expect(FN).toContain("and status in ('queued', 'running', 'needs_input')) >= v_live")
    expect(FN).toContain('v_live integer := 3;')
    expect(FN).toContain('v_daily integer := 10;')
  })

  it('the teammate is optional: none named inserts a NULL ai_team_member_id; a named one must be visible, enabled, not system, and may draft', () => {
    expect(FN).toContain('if p_teammate_id is not null then')
    expect(FN).toContain("a.autonomy <> 'off' and not a.is_system")
    expect(FN).toContain('not t.is_private or exists (select 1 from public.team_member tm')
    expect(FN).toContain("allowed_side_effects @> array['internal-write']::text[]")
    expect(FN).toContain("code', 'AGENT_CANNOT_DRAFT'")
    // No role is required any more (299's DELEGATION_ROLE_UNSUPPORTED is gone).
    expect(FN).not.toContain('p_role')
    expect(FN).toContain('v_target, v_key, p_expects, p_areas')
  })

  it("keys on eve's session, turn and call ids under the helper prefix", () => {
    expect(FN).toContain("v_key := 'chat-helper:' || p_conversation_id::text")
    expect(FN).toContain("p_turn_id ~ '^[^:]{1,200}:[^:]{1,200}$'")
  })

  it('every statement is idempotent (if not exists / drop if exists / create or replace / restated grants)', () => {
    const outside = BODY.replace(FN, '')
    const statements = outside.split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) {
      expect(
        /if not exists|if exists|^comment on|add constraint|^create policy|^revoke all|^grant execute/.test(s),
        s,
      ).toBe(true)
    }
  })
})
