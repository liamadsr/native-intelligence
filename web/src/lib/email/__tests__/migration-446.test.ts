/**
 * Migration 446: the morning tidy's batches (src/lib/email/auto-archive.ts)
 * and its log kind. Pins: no backslash; every statement safe to run twice;
 * the owner reads their own rows ONLY while a member, with no client write
 * and no grant to anon; ids and addresses only, no mail text; one batch per
 * (workspace, person, day), at most 100 threads; the log kind check is the
 * app's list.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'
import { AUTO_ARCHIVE_MAX } from '../auto-archive'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/446_email_auto_archive.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 446', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.email_auto_archive (')
    expect(BODY).toContain('drop policy if exists "email_auto_archive_select_own" on public.email_auto_archive;')
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    for (const [, table, name] of BODY.matchAll(/alter table public\.(\w+) add constraint (\w+)/g)) {
      expect(BODY).toContain(`alter table public.${table} drop constraint if exists ${name};`)
    }
  })

  it('RLS: the owner reads while a member; nobody but the service role writes', () => {
    expect(BODY).toContain('alter table public.email_auto_archive enable row level security;')
    expect(BODY.match(/create policy/g)).toHaveLength(1)
    expect(BODY).toContain(
      'create policy "email_auto_archive_select_own" on public.email_auto_archive for select to authenticated using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));',
    )
    expect(BODY).toContain('revoke all on table public.email_auto_archive from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.email_auto_archive to authenticated;')
    expect(BODY).toContain('grant all on table public.email_auto_archive to service_role;')
    expect(BODY).not.toMatch(/to anon/)
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('holds ids and addresses only, one batch per person, workspace and day, at most the pass’s cap', () => {
    const table = /create table if not exists public\.email_auto_archive \(([^;]*)\);/.exec(BODY)![1]
    const columns = table.split(/,(?![^(]*\))/).map((c) => c.trim().split(' ')[0])
    expect(columns).toEqual(['id', 'workspace_id', 'user_id', 'local_date', 'status', 'cutoff_at', 'thread_ids', 'archived_ids', 'senders', 'undone_at', 'created_at', 'updated_at'])
    expect(BODY).toContain('add constraint email_auto_archive_day_key unique (workspace_id, user_id, local_date);')
    expect(BODY).toContain("check (status in ('running', 'done'))")
    expect(BODY).toContain(
      `check (cardinality(thread_ids) <= ${AUTO_ARCHIVE_MAX} and cardinality(archived_ids) <= ${AUTO_ARCHIVE_MAX} and cardinality(senders) <= ${AUTO_ARCHIVE_MAX})`,
    )
  })

  it('the log kind check is the app’s list but 450’s and 452’s', () => {
    const kinds = /add constraint agent_log_kind_check check \(kind in \(([^)]*)\)\)/.exec(BODY)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))
    expect(kinds).toEqual(AGENT_LOG_KINDS.filter((k) => k !== 'action_done_from_mail' && k !== 'look_ahead' && k !== 'kept_up_to_date'))
  })
})
