/**
 * Migration 307 (chat_conversation_bot, bots-v4 Phase C) pins what a main-chat
 * conversation run as a bot is in the database: a nullable column naming the
 * bot, SET NULL when the bot is deleted (its conversations carry on with the
 * default assistant, never vanish), never on a bot's own thread, and a
 * partial index for a bot's page's "latest conversations with it". Applied
 * to DEV from this file and probed there (a row naming both a thread and a
 * bot is refused); this pins the file so a later edit can't drop a part
 * silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(resolve(__dirname, '../../../../supabase/migrations/307_chat_conversation_bot.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 307', () => {
  it('adds the bot column: nullable, no default, SET NULL when the bot is deleted', () => {
    expect(BODY).toContain(
      'alter table public.chat_conversations add column if not exists agent_teammate_id uuid null references public.ai_team_member(id) on delete set null;',
    )
    expect(BODY).not.toMatch(/agent_teammate_id[^;]*default/)
    expect(BODY).not.toMatch(/on delete cascade/)
  })

  it('never lets one row be both a bot’s thread and a bot conversation, added only once', () => {
    expect(BODY).toContain(
      "if not exists ( select 1 from pg_constraint where conname = 'chat_conversations_thread_or_bot_conversation' and conrelid = 'public.chat_conversations'::regclass ) then",
    )
    expect(BODY).toContain(
      'alter table public.chat_conversations add constraint chat_conversations_thread_or_bot_conversation check (ai_team_member_id is null or agent_teammate_id is null);',
    )
  })

  it('indexes a person’s conversations with a bot, newest first, only where a bot is named', () => {
    expect(BODY).toContain(
      'create index if not exists idx_chat_conversations_agent_teammate on public.chat_conversations (user_id, agent_teammate_id, updated_at desc) where agent_teammate_id is not null;',
    )
  })

  it('leaves RLS and every other column alone, and writes no rows', () => {
    expect(BODY).not.toMatch(/\bpolicy\b/i)
    expect(BODY).not.toMatch(/\b(update|insert into|delete from)\s+public\./i)
    expect(BODY).not.toMatch(/drop (column|index|constraint|table)/i)
  })

  it('carries the PROD pre-check and the post-apply read', () => {
    expect(SQL).toContain('Before applying it on PROD: the read-only pre-check')
    expect(SQL).toContain('(false, false, false, true)')
    expect(SQL).toContain('After applying it on PROD: the row read')
    expect(SQL).toContain("(true, 'n', true, true, 0)")
  })
})
