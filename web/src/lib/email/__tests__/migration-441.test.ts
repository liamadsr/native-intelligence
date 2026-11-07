/**
 * Migration 441: muted mail threads (GEN-1166). Pins: no backslash; every
 * statement safe to run twice; the owner reads their own rows ONLY, with no
 * client write (the service role mutes and unmutes) and no grant to anon;
 * thread ids only, no mail text; one mute per (owner, mailbox, thread).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/441_email_thread_mute.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 441', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.email_thread_mute (')
    expect(BODY).toContain('drop policy if exists "email_thread_mute_select_own" on public.email_thread_mute;')
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) {
      expect(BODY).toContain(`drop constraint if exists ${name};`)
    }
  })

  it('RLS: the owner reads; nobody but the service role writes', () => {
    expect(BODY).toContain('alter table public.email_thread_mute enable row level security;')
    const policies = BODY.match(/create policy "[^"]+" on public\.email_thread_mute for \w+ to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/g) ?? []
    expect(policies).toEqual(['create policy "email_thread_mute_select_own" on public.email_thread_mute for select to authenticated using ((select auth.uid()) = user_id)'])
    expect(BODY.match(/create policy/g)).toHaveLength(1)
    expect(BODY).toContain('revoke all on table public.email_thread_mute from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.email_thread_mute to authenticated;')
    expect(BODY).toContain('grant all on table public.email_thread_mute to service_role;')
    expect(BODY).not.toMatch(/to anon/)
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('holds thread ids only, one mute per owner, mailbox and thread', () => {
    const table = /create table if not exists public\.email_thread_mute \(([^;]*)\);/.exec(BODY)![1]
    const columns = table.split(',').map((c) => c.trim().split(' ')[0])
    expect(columns).toEqual(['id', 'user_id', 'account_id', 'provider', 'provider_thread_id', 'created_at'])
    expect(BODY).toContain('add constraint email_thread_mute_thread_key unique nulls not distinct (user_id, account_id, provider_thread_id);')
    expect(BODY).toContain("check (provider in ('google', 'microsoft'))")
  })
})
