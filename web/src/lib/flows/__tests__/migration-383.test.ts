/**
 * Migration 383 (flows F4, connector steps) and the app agree. The SQL is
 * applied nowhere yet; this pins the file so a later edit can't drop a rule
 * silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(resolve(__dirname, '../../../../supabase/migrations', f), 'utf8')
const body = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const sql = body(read('383_flow_connector_steps.sql'))
const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8')

describe('migration 383: connector steps', () => {
  it("tool_approval's door admits 'flow_step' (and keeps every door 335 had)", () => {
    expect(sql).toContain('alter table public.tool_approval drop constraint if exists tool_approval_door_check')
    expect(sql).toContain("check (door in ('chat', 'skill_run', 'mcp', 'flow_step'))")
  })

  it('tool_approval.flow_run_id with no foreign key (the run row is written after the hold), indexed for the per-run cap', () => {
    expect(sql).toContain('add column if not exists flow_run_id uuid;')
    expect(sql).not.toMatch(/flow_run_id uuid references/)
    expect(sql).toContain('on public.tool_approval (flow_run_id) where status = \'pending\' and flow_run_id is not null')
    expect(readFileSync(resolve(__dirname, '../../safety/approvals.ts'), 'utf8')).toContain("select('id, tool, input_hash, conversation_id, card_id, flow_run_id, door, context')")
  })

  it('flow_run_state: server-only (RLS on, no policy, no grants), cascades with its run, its loop and its workspace', () => {
    expect(sql).toContain('flow_run_id uuid primary key references public.flow_run(id) on delete cascade')
    expect(sql).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(sql).toContain('flow_id uuid not null references public.flow(id) on delete cascade')
    expect(sql).toContain('alter table public.flow_run_state enable row level security')
    expect(sql).toContain('revoke all on public.flow_run_state from anon, authenticated')
    expect(sql).not.toMatch(/create policy/)
  })

  it('the states the resume moves through; a parked row always has its approval, step and context; approval_id has no foreign key', () => {
    expect(sql).toContain("check (status in ('done', 'parked', 'resuming'))")
    expect(sql).toContain("check (status <> 'parked' or (approval_id is not null and parked_action_id is not null and resume is not null))")
    expect(sql).toContain('approval_id uuid,')
    const resume = src('flow-step-resume.ts')
    for (const s of ["status: outcome.parked ? 'parked' : 'done'", "update({ status: 'resuming'", ".eq('status', 'parked')"]) expect(resume).toContain(s)
    expect(resume).toContain("onConflict: 'flow_run_id'")
  })

  it("a parked run is flow_run's 'pending' (an enum value since 107), not a new one", () => {
    expect(read('107_flows.sql')).toMatch(/flow_run_status as enum \(\s*'pending'/)
    expect(sql).not.toMatch(/alter type public.flow_run_status/)
  })
})

describe('migration 383: the review and verification additions', () => {
  it('skill_run_read: one row per run, server-only, cascades with its workspace', () => {
    expect(sql).toContain('create table if not exists public.skill_run_read')
    expect(sql).toContain('run_id uuid primary key')
    expect(sql).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(sql).toContain('alter table public.skill_run_read enable row level security')
    expect(sql).toContain('revoke all on public.skill_run_read from anon, authenticated')
    expect(readFileSync(resolve(__dirname, '../skill-run-reads.ts'), 'utf8')).toContain("onConflict: 'run_id'")
  })

  it('the sweep\'s indexes', () => {
    expect(sql).toContain('create index if not exists flow_run_state_sweep_idx on public.flow_run_state (status, updated_at)')
    expect(sql).toContain("create index if not exists tool_approval_flow_step_settled_idx on public.tool_approval (decided_at) where door = 'flow_step' and status <> 'pending'")
    expect(sql).toContain('create index if not exists skill_run_read_created_idx on public.skill_run_read (created_at)')
  })
})
