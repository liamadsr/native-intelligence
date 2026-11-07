/**
 * Migration 394: the CI fix loop's columns and its atomic claim (P10 F7).
 * Pins: the columns are added idempotently with an empty trail; the claim
 * locks the row, is fenced to the workspace, answers duplicate for a commit
 * already handled, busy while a fix run is live, caps fixes at p_max and
 * reports once; pinned search_path; service role only; no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/394_coding_run_ci_fix.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 394', () => {
  it('adds the fix columns idempotently, the trail empty by default', () => {
    expect(BODY).toContain('alter table public.agent_run add column if not exists ci_fix_of_run_id uuid null references public.agent_run(id) on delete set null;')
    expect(BODY).toContain('alter table public.agent_run add column if not exists ci_failure jsonb;')
    expect(BODY).toContain("alter table public.agent_run add column if not exists ci_fix_trail jsonb not null default '[]'::jsonb;")
    expect(BODY).toContain('create index if not exists agent_run_coding_branch_idx on public.agent_run (repo_full_name, branch) where kind = \'coding\' and ci_fix_of_run_id is null;')
  })

  it('claims one commit atomically, in the run’s workspace', () => {
    expect(BODY).toContain('create or replace function public.agent_run_claim_ci_fix( p_run_id uuid, p_workspace_id uuid, p_head_sha text, p_fix_run_id uuid, p_max integer )')
    expect(BODY).toMatch(/where id = p_run_id and workspace_id = p_workspace_id for update;/)
    expect(BODY).toContain("e ->> 'head_sha' = p_head_sha) then return 'duplicate';")
    // Busy: a fix entry whose run is missing or not settled.
    expect(BODY).toContain("where e ->> 'kind' = 'fix' and not exists ( select 1 from public.agent_run f where f.id::text = e ->> 'fix_run_id' and f.status in ('pr_open', 'completed', 'failed', 'canceled') ) ) then return 'busy';")
    expect(BODY).toContain("if v_fixes >= p_max then")
    expect(BODY).toContain("return 'reported';")
    expect(BODY).toContain("return 'exhausted';")
    expect(BODY).toContain("return 'start';")
    expect(BODY).toContain("set search_path = ''")
  })

  it('runs for the service role only', () => {
    expect(BODY).toContain('revoke all on function public.agent_run_claim_ci_fix(uuid, uuid, text, uuid, integer) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.agent_run_claim_ci_fix(uuid, uuid, text, uuid, integer) to service_role;')
  })

  it('has no backslash (the MCP apply decodes escapes)', () => {
    expect(SQL.includes('\\')).toBe(false)
  })
})
