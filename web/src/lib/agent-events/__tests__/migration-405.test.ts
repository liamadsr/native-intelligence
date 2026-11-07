/**
 * Migration 405: meeting changes from the calendar
 * (docs/plans/email-through-the-agent.md E4). Pins the kind check to the
 * app's vocabulary (types.ts), the watch table's columns to what
 * meeting-changes.ts reads and writes, server-only access, idempotence and
 * no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_EVENT_KINDS } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/405_meeting_changes.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 405', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('re-adds the kind check with exactly the app’s kinds, meeting.changed included', () => {
    expect(BODY).toContain('alter table public.agent_event drop constraint if exists agent_event_kind_check;')
    const kinds = /agent_event_kind_check check \(kind in \(([^)]*)\)\)/.exec(BODY)?.[1].split(',').map((v) => v.trim().replace(/'/g, '')) ?? []
    // 406 adds 'email.arrived' (migration-406.test.ts pins the current list): 405's is the rest.
    expect(kinds).toEqual(AGENT_EVENT_KINDS.filter((k) => k !== 'email.arrived' && k !== 'pr.changed' && k !== 'connection.needs_reconnect' && k !== 'quote.received' && k !== 'job.paid'))
    expect(kinds).toContain('meeting.changed')
  })

  it('creates the watch idempotently, keyed per person per workspace per meeting, with the columns the watch uses', () => {
    expect(BODY).toContain('create table if not exists public.agent_meeting_watch (')
    expect(BODY).toContain('primary key (pass_workspace_id, user_id, meeting_key)')
    for (const col of ['pass_workspace_id uuid', 'meeting_key text', 'account_id uuid', 'event_id text', 'title text', 'start_at timestamptz', 'attendee_count integer', 'mine boolean', 'last_seen_at timestamptz']) {
      expect(BODY).toContain(col)
    }
    // Gone with the workspace, the person or the account.
    expect(BODY).toContain('references public.workspace(id) on delete cascade')
    expect(BODY).toContain('references auth.users(id) on delete cascade')
    expect(BODY).toContain('references public.connected_account(id) on delete cascade')
    expect(BODY).toContain('create index if not exists agent_meeting_watch_start_idx')
  })

  it('has no workspace_id column, so a workspace merge (402) never re-stamps the cache: the source workspace\'s delete drops it', () => {
    const table = BODY.slice(BODY.indexOf('create table if not exists public.agent_meeting_watch'), BODY.indexOf(');', BODY.indexOf('create table if not exists public.agent_meeting_watch')))
    expect(table).not.toMatch(/(^|[ (,])workspace_id /)
    expect(table).toContain('pass_workspace_id uuid not null references public.workspace(id) on delete cascade')
  })

  it('is server only: RLS on, no policy, nothing for anon or authenticated', () => {
    expect(BODY).toContain('alter table public.agent_meeting_watch enable row level security;')
    expect(BODY).toContain('revoke all on table public.agent_meeting_watch from anon, authenticated;')
    expect(BODY).toContain('grant all on table public.agent_meeting_watch to service_role;')
    expect(BODY).not.toContain('create policy')
  })
})
