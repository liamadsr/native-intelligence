/**
 * Migration 411: texting the agent (docs/plans/text-and-calling.md, Phase 1).
 * Pins the file: user_phone (owner reads and deletes, a verified number is one
 * person's), phone_verification and sms_message with NO client access,
 * home_turn widened with the 'text' reason and its two columns, idempotence,
 * and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/411_text_the_agent.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 411', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('user_phone: one per person, a verified number belongs to one person, owner reads and deletes only', () => {
    expect(BODY).toContain('create table if not exists public.user_phone (')
    expect(BODY).toContain('create unique index if not exists user_phone_user_key on public.user_phone (user_id);')
    expect(BODY).toContain('create unique index if not exists user_phone_verified_phone_key on public.user_phone (phone_e164) where verified_at is not null;')
    expect(BODY).toContain('create policy user_phone_select_own on public.user_phone for select to authenticated using (user_id = (select auth.uid()));')
    expect(BODY).toContain('create policy user_phone_delete_own on public.user_phone for delete to authenticated using (user_id = (select auth.uid()));')
    expect(BODY).toContain('grant select, delete on table public.user_phone to authenticated;')
    expect(BODY).not.toMatch(/create policy [a-z_]+ on public\.user_phone for (insert|update|all)/)
  })

  it('stores the SMS consent (when, and which words) on the verification row and the linked phone', () => {
    for (const table of ['user_phone', 'phone_verification']) {
      const create = BODY.slice(BODY.indexOf(`create table if not exists public.${table} (`))
      const columns = create.slice(0, create.indexOf(');'))
      expect([table, columns.includes('consented_at timestamptz not null')]).toEqual([table, true])
      expect([table, columns.includes('consent_version text not null')]).toEqual([table, true])
    }
  })

  it('phone_verification and sms_message: RLS on, no client policy, no client grant', () => {
    for (const table of ['phone_verification', 'sms_message']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
      expect(BODY).not.toMatch(new RegExp(`create policy [a-z_]+ on public\\.${table}`))
      expect(BODY).not.toMatch(new RegExp(`grant [a-z, ]+ on table public\\.${table} to (anon|authenticated)`))
    }
    // A retried webhook (same MessageSid) is one row.
    expect(BODY).toContain("create unique index if not exists sms_message_inbound_sid_key on public.sms_message (twilio_sid) where direction = 'in' and twilio_sid is not null;")
  })

  it("widens home_turn's reasons to what the app writes plus Slack's (its 413 lists 'text' too), and adds the text turn's columns", () => {
    // 'slack' until the Slack channel's own reason lands in HOME_TURN_REASONS: either migration may run last.
    // 429's 'guest_ask', 435's agent reasons, 443's 'check_in' and 445's 'approval' came later (their own tests pin them).
    const reasons = HOME_TURN_REASONS.filter((r) => r !== 'guest_ask' && r !== 'agent_ask' && r !== 'agent_answer' && r !== 'check_in' && r !== 'approval' && r !== 'call')
    const list = [...reasons, ...(reasons as readonly string[]).includes('slack') ? [] : ['slack']].map((x) => `'${x}'`).join(', ')
    expect(BODY).toContain('alter table public.home_turn drop constraint if exists home_turn_reason_check;')
    expect(BODY).toContain(`check (reason in (${list}))`)
    expect(BODY).toContain("alter table public.home_turn add column if not exists text_message_ids text[] not null default '{}';")
    expect(BODY).toContain('alter table public.home_turn add column if not exists reply_sent_at timestamptz null;')
  })
})
