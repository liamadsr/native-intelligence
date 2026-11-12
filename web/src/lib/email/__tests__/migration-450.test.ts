/**
 * Migration 450: a to-do arriving mail marked done
 * (src/lib/email/action-done-from-mail.ts) and its log kind. Pins: no
 * backslash; every statement safe to run twice; the owner reads their own rows
 * ONLY while a member, with no client write and no grant to anon; ids and a
 * domain only, no mail text; one row per to-do, ever; the log kind check is
 * 446's list plus this one, the app's list.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const SQL = read('450_action_mail_done.sql')
const BODY = flat(SQL)
const kindsIn = (body: string) =>
  /add constraint agent_log_kind_check check \(kind in \(([^)]*)\)\)/.exec(body)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))

describe('migration 450', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.action_mail_done (')
    expect(BODY).toContain('drop policy if exists "action_mail_done_select_own" on public.action_mail_done;')
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    for (const [, table, name] of BODY.matchAll(/alter table public\.(\w+) add constraint (\w+)/g)) {
      expect(BODY).toContain(`alter table public.${table} drop constraint if exists ${name};`)
    }
  })

  it('RLS: the owner reads while a member; nobody but the service role writes', () => {
    expect(BODY).toContain('alter table public.action_mail_done enable row level security;')
    expect(BODY.match(/create policy/g)).toHaveLength(1)
    expect(BODY).toContain(
      'create policy "action_mail_done_select_own" on public.action_mail_done for select to authenticated using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));',
    )
    expect(BODY).toContain('revoke all on table public.action_mail_done from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.action_mail_done to authenticated;')
    expect(BODY).toContain('grant all on table public.action_mail_done to service_role;')
    expect(BODY).not.toMatch(/to anon/)
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('holds ids and a domain only, one row per to-do ever, gone with the to-do', () => {
    const table = /create table if not exists public\.action_mail_done \(([^;]*)\);/.exec(BODY)![1]
    const columns = table.split(/,(?![^(]*\))/).map((c) => c.trim().split(' ')[0])
    expect(columns).toEqual(['id', 'workspace_id', 'user_id', 'action_id', 'prior_status_id', 'done_status_id', 'account_id', 'thread_id', 'message_id', 'sender_domain', 'undone_at', 'created_at'])
    expect(BODY).toContain('action_id uuid not null references public.actions (id) on delete cascade')
    expect(BODY).toContain('add constraint action_mail_done_action_key unique (action_id);')
  })

  it('the log kind check is 446’s list plus action_done_from_mail: the app’s list but 452’s look_ahead', () => {
    const kinds = kindsIn(BODY)
    expect(kinds).toEqual([...kindsIn(flat(read('446_email_auto_archive.sql')))!, 'action_done_from_mail'])
    expect(kinds).toEqual(AGENT_LOG_KINDS.filter((k) => k !== 'look_ahead' && k !== 'kept_up_to_date'))
  })
})
