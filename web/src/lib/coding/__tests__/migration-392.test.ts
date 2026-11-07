/**
 * Migration 392: a coding run's pre-check record and its acceptance criteria
 * (P10 F5). Pins: both columns are added idempotently, the criteria default
 * to empty (an old run reads as "none"), the lock timeout is set, and no
 * backslash (the MCP apply decodes escapes).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/392_coding_run_precheck.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 392', () => {
  it('adds the pre-check record and the criteria, idempotently', () => {
    expect(BODY).toContain('alter table public.agent_run add column if not exists precheck jsonb;')
    expect(BODY).toContain("alter table public.agent_run add column if not exists acceptance_criteria text[] not null default '{}';")
  })

  it('sets a lock timeout and deletes or rewrites nothing', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).not.toMatch(/\b(drop|delete|truncate|update)\b/i)
  })

  it('claims a proactive coding slot atomically: one lock per workspace, the cap counted, the row inserted under it', () => {
    expect(BODY).toContain('create or replace function public.agent_run_claim_proactive_coding( p_workspace_id uuid, p_user_id uuid, p_flow_id uuid, p_fire_key text, p_max integer, p_since timestamptz )')
    expect(BODY).toContain("perform pg_advisory_xact_lock(hashtextextended('proactive_coding:' || p_workspace_id::text, 0));")
    expect(BODY).toContain("and kind = 'coding' and origin = 'attempt' and ci_fix_of_run_id is null and created_at >= p_since;")
    expect(BODY).toContain('if v_count >= p_max then return null;')
    expect(BODY).toContain("values (p_workspace_id, 'coding', 'queued', 'attempt', 1, p_flow_id, p_fire_key, p_user_id)")
    expect(BODY).toContain("set search_path = ''")
    expect(BODY).toContain('grant execute on function public.agent_run_claim_proactive_coding(uuid, uuid, uuid, text, integer, timestamptz) to service_role;')
  })

  it('has no backslash (the MCP apply decodes escapes)', () => {
    expect(SQL.includes('\\')).toBe(false)
  })
})
