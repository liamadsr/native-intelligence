/**
 * Migration 414: Slack channel threads. Pins the conversation marker (never
 * on the home thread) and slack_thread's shape: one conversation per thread
 * per person, owner-only reads, no client writes, no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/414_slack_channel_threads.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 414', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('marks a Slack-thread conversation, never the home thread', () => {
    expect(BODY).toContain('alter table public.chat_conversations add column if not exists outside_channel text null;')
    expect(BODY).toContain("check (outside_channel is null or (outside_channel in ('slack') and is_home is null))")
  })

  it('maps one thread to one conversation per person, read only by them, written only by the server', () => {
    expect(BODY).toContain('create table if not exists public.slack_thread (')
    expect(BODY).toContain('constraint slack_thread_person_uq unique (slack_team_id, channel_id, thread_ts, user_id)')
    expect(BODY).toContain('constraint slack_thread_conversation_uq unique (conversation_id)')
    expect(BODY).toContain('conversation_id uuid not null references public.chat_conversations(id) on delete cascade')
    expect(BODY).toContain('alter table public.slack_thread enable row level security')
    expect(BODY).toContain('create policy slack_thread_own_select on public.slack_thread for select to authenticated using ((select auth.uid()) = user_id)')
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to (authenticated|anon)/)
  })
})
