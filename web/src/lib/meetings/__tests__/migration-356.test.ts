/**
 * Migration 356: meeting_goal. Pins: no backslash; safe to run twice; the
 * columns and checks the app relies on (the goal's 1–500 characters, the three
 * sources, capture set null); one goal per person per meeting (the unique key
 * the upsert's onConflict names); the capture index; owner-only RLS on every
 * command (the person's own rows, in a workspace they belong to), no anon
 * access; the header says why and how it is applied.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/356_meeting_goal.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
const OWNER = '(user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))'

describe('migration 356', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent: create if not exists, every policy and trigger dropped before it is made', () => {
    expect(BODY).toContain('create table if not exists public.meeting_goal (')
    expect(BODY).toContain('create index if not exists meeting_goal_capture_idx')
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(BODY).toContain(`drop policy if exists "meeting_goal_${cmd}" on public.meeting_goal;`)
    }
    expect(BODY).toContain('drop trigger if exists meeting_goal_updated_at on public.meeting_goal;')
    expect(BODY).not.toMatch(/drop table/)
  })

  it('keys a goal by the meeting, one per person', () => {
    expect(BODY).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).toContain('calendar_event_id text not null')
    expect(BODY).toContain('starts_at timestamptz not null')
    expect(BODY).toContain('capture_id uuid references public.captures(id) on delete set null')
    expect(BODY).toContain('constraint meeting_goal_meeting_key unique (workspace_id, user_id, calendar_event_id, starts_at)')
    expect(BODY).toContain('on public.meeting_goal (workspace_id, capture_id) where capture_id is not null;')
  })

  it('checks the goal and where it was set', () => {
    expect(BODY).toContain('constraint meeting_goal_goal_check check (char_length(btrim(goal)) between 1 and 500)')
    expect(BODY).toContain("constraint meeting_goal_source_check check (source in ('prep_card', 'chat', 'hud'))")
    expect(BODY).toContain('for each row execute function public.update_updated_at();')
  })

  it('is owner-only: RLS on, every command fenced on the person and their membership', () => {
    expect(BODY).toContain('alter table public.meeting_goal enable row level security;')
    expect(BODY).toContain(`for select to authenticated using ${OWNER};`)
    expect(BODY).toContain(`for insert to authenticated with check ${OWNER};`)
    expect(BODY).toContain(`for update to authenticated using ${OWNER} with check ${OWNER};`)
    expect(BODY).toContain(`for delete to authenticated using ${OWNER};`)
    expect(BODY.match(/create policy/g)).toHaveLength(4)
    expect(BODY).toContain('revoke all on table public.meeting_goal from anon, authenticated;')
    expect(BODY).toContain('grant select, insert, update, delete on table public.meeting_goal to authenticated;')
    expect(BODY).not.toMatch(/grant [^;]* to anon/)
  })

  it('the header says why, what changes, and how it is applied', () => {
    expect(SQL).toContain("Applied by hand, from this file: to DEV, then to PROD on the owner's word.")
    expect(SQL).toContain('What changes:')
    expect(SQL).toContain('Idempotent')
    expect(SQL).toContain('private to the person who set it')
  })
})
