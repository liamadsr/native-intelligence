/**
 * Migration 343: the holding pattern. Pins: no backslash; every statement
 * safe to run twice; the hold is readable, updatable and deletable by its
 * mailbox owner ONLY (auth.uid() = user_id), with no insert policy (only the
 * service role writes) and no grant to anon; not in the realtime publication;
 * one hold per (owner, mailbox, thread); email_draft.hold_id cascades.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/343_email_hold.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 343', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.email_hold (')
    expect(BODY).toContain('add column if not exists hold_id uuid references public.email_hold (id) on delete cascade;')
    expect(BODY).toContain('add column if not exists stale boolean not null default false;')
    for (const policy of ['email_hold_select_own', 'email_hold_update_own', 'email_hold_delete_own']) {
      // select is dropped and re-created; update/delete only dropped (343 makes no client write).
      expect(BODY).toContain(`drop policy if exists "${policy}" on public.email_hold;`)
    }
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) {
      expect(BODY).toContain(`drop constraint if exists ${name};`)
    }
  })

  it('RLS: the owner reads; nobody but the service role writes', () => {
    expect(BODY).toContain('alter table public.email_hold enable row level security;')
    const policies = BODY.match(/create policy "[^"]+" on public\.email_hold for \w+ to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/g) ?? []
    expect(policies).toHaveLength(1)
    expect(policies[0]).toContain('for select')
    // No insert, update or delete policy (dropped if an earlier draft made them); no member rule.
    expect(BODY).not.toMatch(/create policy "[^"]+" on public\.email_hold for (insert|update|delete|all)/)
    expect(BODY).toContain('drop policy if exists "email_hold_update_own" on public.email_hold;')
    expect(BODY).not.toMatch(/is_workspace_member/)
    expect(BODY).toContain('revoke all on table public.email_hold from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.email_hold to authenticated;')
    expect(BODY).not.toMatch(/grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.email_hold to authenticated/)
  })

  it('adds the durable send/dismiss signal dormancy reads, service-only (never member)', () => {
    expect(BODY).toContain('create table if not exists public.mail_review_activity (')
    expect(BODY).toContain('alter table public.mail_review_activity enable row level security;')
    expect(BODY).toContain('revoke all on table public.mail_review_activity from anon, authenticated;')
    expect(BODY).not.toMatch(/on public\.mail_review_activity for /)
    expect(BODY).not.toMatch(/alter table public\.member/)
  })

  it('the hold never joins the realtime publication', () => {
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('one hold per owner, mailbox and thread; capped chain; known statuses', () => {
    expect(BODY).toContain('unique nulls not distinct (user_id, account_id, provider_thread_id)')
    expect(BODY).toContain("check (status in ('held', 'sending'))")
    expect(BODY).toContain("check (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) <= 30)")
    expect(BODY).toContain("expires_at timestamptz not null default (now() + interval '14 days')")
  })
})
