/**
 * Migration 465: a person's agent's own number. Pins the file to the app:
 * one number per person and one person per number, the shapes the app
 * writes, RLS with the person's own row only, the resend claim, idempotence,
 * and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/465_agent_phone_number.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 465', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('one number per person, one person per number: the claim’s two unique keys', () => {
    expect(BODY).toContain('create unique index if not exists agent_phone_number_user_key on public.agent_phone_number (user_id);')
    expect(BODY).toContain('create unique index if not exists agent_phone_number_phone_key on public.agent_phone_number (phone_e164);')
  })

  it('a row goes with its person, and the shapes the app writes', () => {
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).toContain("check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$')")
    expect(BODY).toContain("check (twilio_sid ~ '^PN[0-9a-fA-F]{32}$')")
    expect(BODY).toContain('dial8_until timestamptz null')
  })

  it('RLS on; a person reads their own row; only the service role writes', () => {
    expect(BODY).toContain('alter table public.agent_phone_number enable row level security;')
    expect(BODY).toContain('for select to authenticated using (user_id = (select auth.uid()));')
    expect(BODY).toContain('revoke all on table public.agent_phone_number from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.agent_phone_number to authenticated;')
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.agent_phone_number to authenticated/)
  })

  it('one resend per refused text: the unique claim on sms_message.resend_of', () => {
    expect(BODY).toContain('alter table public.sms_message add column if not exists resend_of text null;')
    expect(BODY).toContain('create unique index if not exists sms_message_resend_of_key on public.sms_message (resend_of) where resend_of is not null;')
  })

  it('re-runnable: every create guarded, every constraint and policy dropped first', () => {
    expect(BODY).toContain('create table if not exists public.agent_phone_number')
    expect(BODY.match(/add constraint (\w+)/g)!.length).toBe(BODY.match(/drop constraint if exists (\w+)/g)!.length)
    expect(BODY.match(/create policy (\w+)/g)!.length).toBe(BODY.match(/drop policy if exists (\w+)/g)!.length)
  })
})
