/**
 * Migration 333: server-written home turns (A4 slice 5). Pins the file: the
 * claim table with its unique (conversation_id, dedupe_key) index, the status
 * and reason vocabularies the app writes, owner-only reads with no API-role
 * writes, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { HOME_TURN_REASONS, HOME_TURN_STATUSES } from '../home-turn'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/333_home_turn.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 333', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('creates the table idempotently, cascading from the conversation', () => {
    expect(BODY).toContain('create table if not exists public.home_turn (')
    expect(BODY).toContain('conversation_id uuid not null references public.chat_conversations(id) on delete cascade')
    for (const col of [
      'user_id uuid not null',
      'workspace_id uuid not null',
      'reason text not null',
      "work_item_ids uuid[] not null default '{}'",
      "report_message_ids text[] not null default '{}'",
      'dedupe_key text not null',
      "status text not null default 'claimed'",
      'eve_session_id text null',
      'eve_turn_id text null',
      'stream_position integer null',
      'message_written boolean not null default false',
      'created_at timestamptz not null default now()',
      'updated_at timestamptz not null default now()',
    ]) {
      expect(BODY).toContain(col)
    }
  })

  it('is unique per conversation and dedupe key (a retry never sends twice)', () => {
    expect(BODY).toContain('create unique index if not exists home_turn_dedupe_key_key on public.home_turn (conversation_id, dedupe_key);')
  })

  it('checks exactly the statuses and reasons the app wrote then (413 and 429 widen the reasons)', () => {
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ')
    expect(BODY).toContain(`check (status in (${list(HOME_TURN_STATUSES)}))`)
    // 411 (texts), 413 (Slack), 429, 435, 443, 445 and 456 widened the check; this file keeps the reasons 333 shipped.
    const later = new Set(['slack', 'text', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval', 'call'])
    expect(BODY).toContain(`check (reason in (${list(HOME_TURN_REASONS.filter((r) => !later.has(r)))}))`)
  })

  it('re-adds every constraint (drop if exists, then add)', () => {
    for (const name of [
      'home_turn_conversation_id_fkey',
      'home_turn_reason_check',
      'home_turn_status_check',
      'home_turn_dedupe_key_length',
      'home_turn_work_items_cap',
      'home_turn_reports_cap',
      'home_turn_stream_position_check',
      'home_turn_error_length',
    ]) {
      expect(BODY).toContain(`alter table public.home_turn drop constraint if exists ${name};`)
      expect(BODY).toContain(`add constraint ${name}`)
    }
  })

  it('lets the owner read their rows, and only the service role write', () => {
    expect(BODY).toContain('alter table public.home_turn enable row level security;')
    expect(BODY).toContain('drop policy if exists home_turn_select_own on public.home_turn;')
    expect(BODY).toContain('create policy home_turn_select_own on public.home_turn for select to authenticated using (user_id = (select auth.uid()));')
    expect(BODY).toContain('revoke all on table public.home_turn from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.home_turn to authenticated;')
    expect(BODY).toContain('grant all on table public.home_turn to service_role;')
    // No insert/update/delete policy: an API role can never write.
    expect(BODY).not.toMatch(/create policy [a-z_]+ on public\.home_turn for (insert|update|delete|all)/)
    expect(BODY).not.toMatch(/grant (insert|update|delete|all)[^;]*to (anon|authenticated)/)
  })

  it('keeps the table out of realtime', () => {
    expect(BODY).toContain('alter publication supabase_realtime drop table public.home_turn;')
    expect(BODY).not.toContain('alter publication supabase_realtime add table public.home_turn')
  })
})
