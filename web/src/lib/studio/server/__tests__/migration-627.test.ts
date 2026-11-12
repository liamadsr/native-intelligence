/**
 * Migration 627: the open-job caps counted and the job inserted in one transaction, one queue per workspace at a
 * time. It can't be run here, so the file is pinned as text: the house style, additive and Studio-only, the lock,
 * the count the app's caps make (jobs.ts), and the grants. The in-memory fake (fake.ts) answers the same way, and
 * fences.test.ts runs requests at once against it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/627_studio_limits.sql'), 'utf8')
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('migration 627', () => {
  it('is one transaction in the house style, additive and Studio-only', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(sql).toMatch(/\nbegin;\n\nSET LOCAL lock_timeout = '5s';\n/)
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(sql).not.toMatch(/drop (table|function|index)|create table|alter table/i)
    expect(sql).toMatch(/^-- 627: /m)
    for (const name of sql.match(/create or replace function public\.(\w+)/g) ?? []) expect(name).toMatch(/public\.studio_/)
  })

  it('locks the workspace’s queue, counts its open jobs as the app does, and inserts only under the caps', () => {
    const fn = squash(sql.slice(sql.indexOf('create or replace function public.studio_queue_job('), sql.indexOf('\n$$;')))
    expect(fn).toContain("perform pg_advisory_xact_lock(hashtextextended('studio_queue_job:' || p_workspace::text, 0));")
    expect(fn).toContain("where j.workspace_id = p_workspace and j.status in ('queued', 'running') and j.cancel_requested = false;")
    expect(fn).toContain("if open_jobs >= p_max_open or (p_kind = 'export' and open_exports >= p_max_exports) then return; end if;")
    expect(fn).toContain('insert into public.studio_job (workspace_id, video_id, kind, input, created_by)')
    expect(fn).toContain('returns setof public.studio_job language plpgsql security definer set search_path = public, pg_temp')
    expect(fn.indexOf('pg_advisory_xact_lock')).toBeLessThan(fn.indexOf('select count(*)'))
    expect(sql).toContain('revoke execute on function public.studio_queue_job(uuid, text, jsonb, uuid, uuid, integer, integer) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.studio_queue_job(uuid, text, jsonb, uuid, uuid, integer, integer) to service_role;')
  })
})
