/**
 * Migration 673, section C: email_thread_share (a mail thread shared with a
 * PERSON by an @-mention). Pins that the table holds no mail (ids, ids arrays
 * and timestamps only, no subject/body/snippet/name/address), that it is the
 * service role's alone (RLS on, no policy on it, nothing granted to clients),
 * the partial unique index, the frozen-ids bound (same as 646), and no
 * backslash. The 673 file as a whole is checked by its own section's tests.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE = '673_mentions_shares.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
const TABLE = BODY.slice(
  BODY.indexOf('create table if not exists public.email_thread_share ('),
  BODY.indexOf('create unique index if not exists email_thread_share_live_key'),
)

describe('migration 673: email_thread_share', () => {
  it('is the only 673, holds no backslash, runs as one transaction with a lock timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 673)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('stores no mail: exactly these columns, none a subject, body, snippet, name or address', () => {
    const columns = [...TABLE.matchAll(/[(,] ([a-z_]+) (?:uuid|text\[\]|text|timestamptz)(?=[ ,])/g)].map((m) => m[1])
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'owner_user_id',
      'account_id',
      'provider',
      'provider_thread_id',
      'thread_index_id',
      'message_ids',
      'grantee_member_id',
      'source',
      'source_type',
      'source_id',
      'created_at',
      'revoked_at',
    ])
    expect(TABLE).not.toMatch(/subject|snippet|body|from_|_email|_name|address|html|preview/)
    expect(TABLE).toContain('message_ids text[] not null check (cardinality(message_ids) between 1 and 100')
    expect(TABLE).toContain('array_position(message_ids, null) is null')
    expect(TABLE).toContain("provider text not null check (provider in ('google', 'microsoft'))")
    expect(TABLE).toContain("source text not null default 'mention' check (source in ('mention'))")
  })

  it('is re-runnable: the table and every index are guarded', () => {
    expect(BODY).toContain('create table if not exists public.email_thread_share (')
    expect(BODY).toContain('create unique index if not exists email_thread_share_live_key')
    expect(BODY).toContain('create index if not exists email_thread_share_grantee_idx')
  })

  it('one live share per owner, thread and grantee: a partial unique index', () => {
    expect(BODY).toContain(
      'create unique index if not exists email_thread_share_live_key on public.email_thread_share (owner_user_id, provider_thread_id, grantee_member_id) where revoked_at is null',
    )
  })

  it('is the service role’s only: RLS on, no policy on it, every privilege revoked from clients', () => {
    expect(BODY).toContain('alter table public.email_thread_share enable row level security;')
    expect(BODY).toContain('revoke all on table public.email_thread_share from public, anon, authenticated;')
    expect(BODY).toContain('grant select, insert, update, delete on table public.email_thread_share to service_role;')
    expect(BODY).not.toMatch(/grant [a-z, ]+ on table public\.email_thread_share to (anon|authenticated)/)
    // No row-level policy on the share table itself (service role bypasses RLS).
    expect(BODY).not.toMatch(/create policy [a-z_]+ on public\.email_thread_share/)
  })

  it('cascades a deleted grantee and workspace, and keeps the owner’s grant (owner → auth.users)', () => {
    expect(TABLE).toContain('grantee_member_id uuid not null references public.member(id) on delete cascade')
    expect(TABLE).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(TABLE).toContain('owner_user_id uuid not null references auth.users(id) on delete cascade')
    expect(TABLE).toContain('account_id uuid references public.connected_account(id) on delete set null')
    expect(TABLE).toContain('thread_index_id uuid references public.email_thread_index(id) on delete set null')
  })
})
