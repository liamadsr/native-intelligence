/**
 * Migration 374: agent_run.outside_reads and its atomic append (the signal
 * that holds a teammate memory entry). Pins: the column defaults to empty,
 * the append is once per tool, capped, fenced to the run's workspace, has a
 * pinned search_path, runs for the service role only, every statement is safe
 * to run twice, and no backslash anywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/374_agent_run_outside_reads.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 374', () => {
  it('adds the column idempotently, empty by default', () => {
    expect(BODY).toContain("alter table public.agent_run add column if not exists outside_reads text[] not null default '{}';")
  })

  it('appends one tool once, at most 20, fenced to the workspace', () => {
    expect(BODY).toContain('create or replace function public.agent_run_note_outside_read(p_run_id uuid, p_workspace_id uuid, p_tool text)')
    expect(BODY).toContain('set outside_reads = outside_reads || p_tool')
    expect(BODY).toContain('and workspace_id = p_workspace_id')
    expect(BODY).toContain('and not (p_tool = any (outside_reads))')
    expect(BODY).toContain('and cardinality(outside_reads) < 20')
    expect(BODY).toContain("set search_path = ''")
  })

  it('runs for the service role only', () => {
    expect(BODY).toContain('revoke all on function public.agent_run_note_outside_read(uuid, uuid, text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.agent_run_note_outside_read(uuid, uuid, text) to service_role;')
  })

  it('has no backslash (the MCP apply decodes escapes)', () => {
    expect(SQL.includes('\\')).toBe(false)
  })
})
