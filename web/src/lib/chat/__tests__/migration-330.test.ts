/**
 * Migration 330: the home thread (A3). Pins the file: a nullable is_home that
 * is only ever NULL or true and only on a plain main-chat row, the unique
 * (user_id, workspace_id, is_home) index ensureHomeThread upserts on, the
 * checkpoint columns with their length cap, a backfill from the onboarding
 * pointer that can't double a home thread, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { HOME_CHECKPOINT_MAX_CHARS } from '../home-thread'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/330_home_thread.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 330', () => {
  it('adds the three nullable columns idempotently, with no default', () => {
    expect(BODY).toContain('alter table public.chat_conversations add column if not exists is_home boolean null;')
    expect(BODY).toContain('alter table public.chat_conversations add column if not exists checkpoint_summary text null;')
    expect(BODY).toContain('alter table public.chat_conversations add column if not exists checkpoint_at timestamptz null;')
    expect(BODY).not.toMatch(/is_home boolean[^;]*default/)
  })

  it('keeps is_home NULL or true (NULLs distinct: the unique index binds only home rows)', () => {
    expect(BODY).toContain('check (is_home is null or is_home = true)')
  })

  it('allows a home thread only on a plain main-chat row in a workspace', () => {
    expect(BODY).toContain(
      'check ( is_home is null or ( workspace_id is not null and ai_team_member_id is null and agent_teammate_id is null and capture_id is null and focus_area is null ) )',
    )
  })

  it('caps the checkpoint text above what the app stores', () => {
    expect(BODY).toContain('check (checkpoint_summary is null or char_length(checkpoint_summary) <= 40000)')
    expect(HOME_CHECKPOINT_MAX_CHARS).toBeLessThanOrEqual(40000)
  })

  it('adds every constraint only when missing', () => {
    for (const name of ['chat_conversations_home_is_true', 'chat_conversations_home_is_plain', 'chat_conversations_checkpoint_summary_len']) {
      expect(BODY).toContain(`where conname = '${name}' and conrelid = 'public.chat_conversations'::regclass ) then alter table public.chat_conversations add constraint ${name}`)
    }
  })

  it('has the non-partial unique index the upsert targets', () => {
    expect(BODY).toContain('create unique index if not exists uidx_chat_conversations_home on public.chat_conversations (user_id, workspace_id, is_home);')
  })

  it('backfills from the onboarding pointer: same user and workspace, plain rows, one per person, never a second home', () => {
    expect(BODY).toContain("on cc.id::text = (m.onboarding_progress -> 'conversation' ->> 'homeConversationId')")
    expect(BODY).toContain('and cc.user_id = m.user_id and cc.workspace_id = m.workspace_id')
    expect(BODY).toContain('select distinct on (cc.user_id, cc.workspace_id) cc.id')
    expect(BODY).toContain('order by cc.user_id, cc.workspace_id, cc.updated_at desc')
    expect(BODY).toContain('and not exists ( select 1 from public.chat_conversations h where h.user_id = cc.user_id and h.workspace_id = cc.workspace_id and h.is_home = true )')
    for (const col of ['ai_team_member_id', 'agent_teammate_id', 'capture_id', 'focus_area']) {
      expect(BODY).toContain(`and cc.${col} is null`)
    }
  })

  it('carries the PROD pre-check and row read', () => {
    expect(SQL).toContain('the read-only pre-check')
    expect(SQL).toContain('duplicate_candidates')
    expect(SQL).toContain('the row read')
  })

  it('holds no backslash at all (a JSON transport decodes escapes, so the applied SQL would differ from the file)', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
  })
})
