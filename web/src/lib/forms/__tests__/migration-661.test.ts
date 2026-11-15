/**
 * Migration 661: the hosted page's settings, the bot check's single use and
 * personal links. Pins the file to the app: the access values and limits it
 * keeps, checks added without a scan, the challenge's and the link's unique
 * indexes, the new table service-role only, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORM_ACCESS, FORM_LIMITS } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', '661_forms_hosted.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .map((l) => l.replace(/\s+--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 661', () => {
  it('holds no backslash (one MCP transport decodes escapes), and waits at most 5 s for a lock', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
  })

  it("adds the page's settings, the bot check off for every existing form", () => {
    expect(BODY).toContain('alter table public.data_form add column if not exists description text null;')
    expect(BODY).toContain('alter table public.data_form add column if not exists submit_label text null;')
    expect(BODY).toContain('alter table public.data_form add column if not exists bot_check boolean not null default false;')
    expect(BODY).toContain(`check (description is null or char_length(description) <= ${FORM_LIMITS.description}) not valid;`)
    expect(BODY).toContain(`check (submit_label is null or char_length(submit_label) between 1 and ${FORM_LIMITS.submitLabel}) not valid;`)
  })

  it('checks every access value the app writes, widening the check without a scan', () => {
    expect(BODY).toContain(`add constraint data_form_access_check check (access in (${list(FORM_ACCESS)})) not valid;`)
    expect(BODY).toContain('alter table public.data_form validate constraint data_form_access_check;')
  })

  it('every check on an existing table is added not valid and then validated', () => {
    for (const m of BODY.matchAll(/alter table public\.(data_form|data_form_attempt) add constraint (\w+)[^;]+;/g)) {
      expect(m[0], m[2]).toMatch(/not valid;$/)
      expect(BODY).toContain(`alter table public.${m[1]} validate constraint ${m[2]};`)
    }
  })

  it('one challenge stores one submission: unique per form, on the attempt ledger', () => {
    expect(BODY).toContain('alter table public.data_form_attempt add column if not exists challenge_id text null;')
    expect(BODY).toContain('create unique index if not exists data_form_attempt_challenge_key on public.data_form_attempt (form_id, challenge_id) where challenge_id is not null;')
  })

  it('a personal link: its form, its secret as a hash only (unique), its contact, its lapse, its use and its row', () => {
    for (const column of [
      'form_id uuid not null references public.data_form(id) on delete cascade',
      'token_hash text not null',
      'label text null',
      'contact_id uuid null references public.contact(id) on delete set null',
      'expires_at timestamptz not null',
      'used_at timestamptz null',
      'row_id uuid null',
    ]) {
      expect(BODY).toContain(column)
    }
    expect(BODY).toContain('create unique index if not exists data_form_invite_token_hash_key on public.data_form_invite (token_hash);')
    expect(BODY).toContain(`check (label is null or char_length(label) between 1 and ${FORM_LIMITS.inviteLabel})`)
  })

  it('keeps the new table to the service role: RLS on, nothing for anon or signed-in clients, no policy', () => {
    expect(BODY).toContain('alter table public.data_form_invite enable row level security;')
    expect(BODY).toContain('revoke all on table public.data_form_invite from anon, authenticated;')
    expect(BODY).toContain('grant all on table public.data_form_invite to service_role;')
    expect(BODY).not.toContain('create policy')
  })

  it('no unique index includes workspace_id (the workspace merge re-stamps it)', () => {
    for (const m of BODY.matchAll(/create unique index[^;]+;/g)) expect(m[0]).not.toContain('workspace_id')
  })

  it('is re-runnable', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).not.toContain('drop trigger')
    expect(BODY.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })
})
