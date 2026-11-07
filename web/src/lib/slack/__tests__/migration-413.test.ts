/**
 * Migration 413: Slack DM turns on home_turn. Pins what the home-turn server
 * writes (reason 'slack', the text_message_ids and reply_sent_at columns 411
 * added for every channel) and that it keeps SMS's 'text' reason (migration
 * 411), so the two apply in either order.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/413_slack_dm_turns.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 413', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('waits at most 5 s for its locks (it rebuilds two checks on home_turn)', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('adds the columns idempotently', () => {
    expect(BODY).toContain("alter table public.home_turn add column if not exists text_message_ids text[] not null default '{}';")
    expect(BODY).toContain('alter table public.home_turn add column if not exists reply_sent_at timestamptz null;')
  })

  it('checks every reason the app writes, and keeps SMS’s', () => {
    const check = BODY.match(/add constraint home_turn_reason_check check \(reason in \(([^)]*)\)\)/)
    expect(check).not.toBeNull()
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    // 429 adds guest_ask and 435 the agent reasons (their own tests check them).
    // 443's 'check_in' and 445's 'approval' came later (their own tests pin them).
    for (const reason of HOME_TURN_REASONS.filter((r) => r !== 'guest_ask' && r !== 'agent_ask' && r !== 'agent_answer' && r !== 'check_in' && r !== 'approval' && r !== 'call')) expect(listed).toContain(reason)
    expect(listed).toContain('text')
    expect(BODY).toContain('alter table public.home_turn drop constraint if exists home_turn_reason_check;')
  })

  it('caps how many messages one turn carries', () => {
    expect(BODY).toContain('add constraint home_turn_texts_cap check (cardinality(text_message_ids) <= 20)')
    expect(BODY).not.toContain('channel_message_ids')
  })
})
