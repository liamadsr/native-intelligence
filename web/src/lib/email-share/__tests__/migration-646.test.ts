/**
 * Migration 646: email shares. Pins that the table holds no mail (its columns
 * are ids, timestamps and the frozen message ids, nothing else), that it is
 * the service role's alone (RLS on, no policy, nothing granted to clients),
 * that a client can never set or change a message's share, that deleting the
 * message un-shares, the columns the code reads and writes, re-runnability,
 * the lock timeout, and no backslash. Applied twice on PGlite too (see the
 * report of the change).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAM_CHAT_MESSAGE_COLUMNS } from '@/lib/team-chat/types'

const FILE = '646_email_share.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
const TABLE = BODY.slice(BODY.indexOf('create table if not exists public.email_share ('), BODY.indexOf('create index if not exists email_share_owner_thread_idx'))
const SERVICE = readFileSync(join(process.cwd(), 'src/lib/email-share/service.ts'), 'utf8')

describe('migration 646', () => {
  it('is the only 646, holds no backslash, runs as one transaction and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 646)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY).toMatch(/^ ?begin; SET LOCAL lock_timeout = '5s';/)
    expect(BODY.trim().endsWith('commit;')).toBe(true)
  })

  it('stores no mail: exactly these columns, none of them a subject, body, snippet, name or address', () => {
    const columns = [...TABLE.matchAll(/[(,] ([a-z_]+) (uuid|text|text\[\]|timestamptz) /g)].map((m) => m[1])
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'owner_user_id',
      'account_id',
      'provider',
      'provider_thread_id',
      'thread_index_id',
      'message_ids',
      'channel_id',
      'team_chat_message_id',
      'shared_by_member_id',
      'created_at',
      'revoked_at',
    ])
    expect(TABLE).not.toMatch(/subject|snippet|body|from_|_email|_name|address|html|preview/)
    expect(TABLE).toContain('message_ids text[] not null check (cardinality(message_ids) between 1 and 100')
  })

  it('is re-runnable', () => {
    expect(BODY).toContain('create table if not exists public.email_share (')
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).toContain('add column if not exists email_share_id uuid references public.email_share(id) on delete set null;')
    expect(BODY).toContain('drop trigger if exists team_chat_message_email_share_guard on public.team_chat_message;')
    expect(BODY).toContain('drop trigger if exists team_chat_message_email_share_revoke on public.team_chat_message;')
    expect(BODY).not.toMatch(/create policy/)
  })

  it('is the service role’s only: RLS on, no policy, every privilege revoked from clients', () => {
    expect(BODY).toContain('alter table public.email_share enable row level security;')
    expect(BODY).toContain('revoke all on table public.email_share from public, anon, authenticated;')
    expect(BODY).toContain('grant select, insert, update, delete on table public.email_share to service_role;')
    expect(BODY).not.toMatch(/grant [a-z, ]+ on table public\.email_share to (anon|authenticated)/)
  })

  it('a client never sets or changes a message’s share; deleting the message un-shares', () => {
    const guard = BODY.slice(BODY.indexOf('create or replace function public.team_chat_message_email_share_guard()'), BODY.indexOf('drop trigger if exists team_chat_message_email_share_guard'))
    expect(guard).toContain('if auth.uid() is null then return new; end if;')
    expect(guard).toContain("if tg_op = 'INSERT' and new.email_share_id is not null then raise exception")
    expect(guard).toContain("if tg_op = 'UPDATE' and new.email_share_id is distinct from old.email_share_id then raise exception")
    expect(BODY).toContain('before insert or update on public.team_chat_message for each row execute function public.team_chat_message_email_share_guard();')
    const revoke = BODY.slice(BODY.indexOf('create or replace function public.team_chat_message_email_share_revoke()'), BODY.indexOf('revoke all on function public.team_chat_message_email_share_revoke()'))
    expect(revoke).toContain('security definer set search_path = public, pg_temp')
    expect(revoke).toContain('update public.email_share set revoked_at = now() where id = new.email_share_id and revoked_at is null;')
    expect(BODY).toContain('after update of deleted_at on public.team_chat_message for each row execute function public.team_chat_message_email_share_revoke();')
    // Trigger functions only: no client may call either directly.
    for (const fn of ['team_chat_message_email_share_guard', 'team_chat_message_email_share_revoke']) {
      expect(BODY).toContain(`revoke all on function public.${fn}() from public, anon, authenticated;`)
    }
  })

  it('has every column the service reads and writes, and team chat reads the message’s share', () => {
    const read = /const SHARE_COLUMNS =\s*'([^']+)'/.exec(SERVICE)![1].split(',').map((c) => c.trim())
    for (const c of [...read, 'shared_by_member_id']) expect(TABLE, c).toMatch(new RegExp(`[( ,]${c} `))
    expect(TEAM_CHAT_MESSAGE_COLUMNS.split(',').map((c) => c.trim())).toContain('email_share_id')
  })
})
