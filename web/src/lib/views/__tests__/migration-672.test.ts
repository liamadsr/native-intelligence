/**
 * Migration 672 (actions.completed_at kept by a trigger; the views' completed
 * windows). Its SQL is run by supabase/tests/672_action_completed_at.sql
 * against a database; this pins the file's text where CI can see it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPLETED_FILTERS } from '@/lib/views/completed-window'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/672_action_completed_at.sql'), 'utf8')
const BODY = SQL
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase()

describe('migration 672', () => {
  it('has no backslash', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('keeps completed_at on every insert and every move of status_id (or a write of completed_at)', () => {
    expect(BODY).toContain('create trigger action_completed_at before insert or update of status_id, completed_at on public.actions for each row execute function public.action_completed_at();')
  })

  it('reads finished by category, the views’ vocabulary', () => {
    expect(BODY).toContain("ws.category in ('completed', 'canceled')")
  })

  it('an open state always clears it, whatever the writer sent', () => {
    expect(BODY).toMatch(/if not new_done then new\.completed_at := null; return new;/)
  })

  it('the trigger function runs as its owner and no role may call it', () => {
    expect(BODY).toContain('security definer set search_path = public, pg_temp')
    expect(BODY).toContain('revoke all on function public.action_completed_at() from public, anon, authenticated;')
  })

  it('the backfill leaves updated_at alone and turns its triggers back on', () => {
    const off = BODY.indexOf('alter table public.actions disable trigger update_actions_updated_at;')
    const on = BODY.indexOf('alter table public.actions enable trigger update_actions_updated_at;')
    const firstUpdate = BODY.indexOf('update public.actions')
    expect(off).toBeGreaterThan(-1)
    expect(on).toBeGreaterThan(off)
    expect(firstUpdate).toBeGreaterThan(off)
    expect(BODY.lastIndexOf('update public.actions')).toBeLessThan(on)
    expect(BODY).toContain('alter table public.actions enable trigger action_completed_at;')
  })

  it('backfills from the activity log’s live moves into a finished state, never from a 516 backfilled row', () => {
    expect(BODY).toContain("ea.action = 'status_changed'")
    expect(BODY).toContain('and not ea.backfilled')
    expect(BODY).toContain("ws_from.category not in ('completed', 'canceled')")
    expect(BODY).toContain('set completed_at = coalesce(a.updated_at, a.created_at, now())')
  })

  it('indexes finished actions by workspace and time', () => {
    expect(BODY).toContain('create index if not exists actions_workspace_completed_at_idx on public.actions (workspace_id, completed_at desc) where completed_at is not null;')
  })

  it('the views’ check takes exactly the values the code reads', () => {
    const m = BODY.match(/check \(completed_filter in \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const values = m![1].split(',').map((v) => v.trim().replace(/'/g, '')).sort()
    expect(values).toEqual([...COMPLETED_FILTERS].sort())
  })

  it('moves a window saved in metadata into the column', () => {
    expect(BODY).toContain("set completed_filter = metadata ->> 'completed_window', metadata = metadata - 'completed_window' where completed_filter = 'recent'")
  })
})
