/**
 * Migration 474 (team chat): only members of the workspace read a channel or
 * its messages (and only the team's members a team channel, only its two
 * members a DM); members write only as themselves; the agent's replies and its
 * threads are the service role's; the turn's reason and conversation channel
 * are allowed. Run on DEV by supabase/tests/474_team_chat.sql (non-members
 * refused, inside a rolled-back block); this pins the file's text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'
import { CHANNEL_SURFACES } from '@/lib/chat/chat-run-token'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/474_team_chat.sql'), 'utf8')
const BODY = SQL.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const PROBES = readFileSync(join(process.cwd(), 'supabase/tests/474_team_chat.sql'), 'utf8')

const TABLES = ['team_chat_channel', 'team_chat_member', 'team_chat_message', 'team_chat_agent_thread']

function fn(name: string): string {
  const start = BODY.indexOf(`create or replace function public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return BODY.slice(start, BODY.indexOf('$$;', start))
}

describe('migration 474', () => {
  it('RLS on every table, nothing for anon, and no table a client may write but messages', () => {
    for (const table of TABLES) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
    }
    expect(BODY).toContain('grant select on table public.team_chat_channel to authenticated;')
    expect(BODY).toContain('grant select on table public.team_chat_member to authenticated;')
    expect(BODY).toContain('grant select, insert, update on table public.team_chat_message to authenticated;')
    expect(BODY).not.toMatch(/grant [a-z, ]*on table public\.team_chat_agent_thread to/)
    expect(BODY).not.toMatch(/grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.team_chat_(channel|member) to/)
    expect(BODY).not.toMatch(/grant [a-z, ]*delete[a-z, ]* on table public\.team_chat_message to/)
    expect(BODY).not.toMatch(/to anon/)
  })

  it('a non-member reads nothing: every read goes through team_chat_can_read, which starts at workspace membership', () => {
    expect(BODY).toMatch(/policy team_chat_channel_select on public\.team_chat_channel\s+for select to authenticated using \(public\.team_chat_can_read\(id\)\)/)
    expect(BODY).toMatch(/policy team_chat_message_select on public\.team_chat_message\s+for select to authenticated using \(public\.team_chat_can_read\(channel_id\)\)/)
    // Read marks: only their own.
    expect(BODY).toMatch(/policy team_chat_member_select on public\.team_chat_member\s+for select to authenticated using \(member_id = public\.current_member_id\(workspace_id\)\)/)
    // The agent's threads: no client policy at all.
    expect(BODY).not.toMatch(/policy \w+ on public\.team_chat_agent_thread/)
    const canRead = fn('team_chat_can_read')
    expect(canRead).toContain('public.is_workspace_member(c.workspace_id)')
    // A team channel: its team's members only. A DM: its members only.
    expect(canRead).toContain("(c.kind = 'channel' and (c.team_id is null or public.is_team_member(c.team_id)))")
    expect(canRead).toMatch(/c\.kind = 'dm'\s+and exists \(\s+select 1 from public\.team_chat_member tm\s+where tm\.channel_id = c\.id\s+and tm\.member_id = public\.current_member_id\(c\.workspace_id\)/)
  })

  it('members post only as themselves, never as an agent, in a channel they may post in', () => {
    const insert = BODY.slice(BODY.indexOf('create policy team_chat_message_insert'), BODY.indexOf('drop policy if exists team_chat_message_update'))
    expect(insert).toContain("author_kind = 'member'")
    expect(insert).toContain('author_member_id = public.current_member_id(workspace_id)')
    expect(insert).toContain('agent_for_member_id is null')
    expect(insert).toContain('public.team_chat_can_post(channel_id)')
    expect(insert).toContain('c.workspace_id = team_chat_message.workspace_id')
  })

  it('edit and delete are the author’s own (and delete, not edit, their agent’s reply); the guard keeps everything but the words', () => {
    const update = BODY.slice(BODY.indexOf('create policy team_chat_message_update'), BODY.indexOf('revoke all on table public.team_chat_channel'))
    expect(update).toContain('deleted_at is null')
    expect(update).toContain("(author_kind = 'member' and author_member_id = public.current_member_id(workspace_id))")
    expect(update).toContain("(author_kind = 'agent' and agent_for_member_id = public.current_member_id(workspace_id))")
    const guard = fn('team_chat_message_guard')
    expect(guard).toMatch(/if old\.author_kind = 'agent' and new\.deleted_at is null then\s+raise exception/)
    for (const col of ['id', 'channel_id', 'workspace_id', 'author_kind', 'author_member_id', 'agent_for_member_id', 'agent_name', 'in_reply_to', 'created_at']) {
      expect(guard).toContain(`new.${col} is distinct from old.${col}`)
    }
    // A delete clears the words; an edit never sets the agent off again.
    expect(guard).toContain("new.body := '';")
    expect(guard).toContain('new.mentions_agent := old.mentions_agent;')
  })

  it('a member’s insert gets the server’s clock and is never born edited or deleted', () => {
    const guard = fn('team_chat_message_insert_guard')
    expect(guard).toContain('new.created_at := now();')
    expect(guard).toContain('new.edited_at := null;')
    expect(guard).toContain('new.deleted_at := null;')
    expect(BODY).toMatch(/create trigger team_chat_message_insert_guard\s+before insert on public\.team_chat_message/)
  })

  it('the functions a client calls check membership first and run only for the signed-in', () => {
    for (const name of ['team_chat_create_channel', 'team_chat_open_dm']) {
      expect(fn(name)).toContain('me uuid := public.current_member_id(ws);')
      expect(fn(name)).toMatch(/if me is null then\s+raise exception/)
    }
    expect(fn('team_chat_create_channel')).toContain('public.is_team_member(channel_team)')
    expect(fn('team_chat_open_dm')).toContain('m.id = other_member and m.workspace_id = ws')
    expect(fn('team_chat_mark_read')).toMatch(/if not public\.team_chat_can_read\(ch\) then\s+raise exception/)
    expect(fn('team_chat_unread')).toContain('public.team_chat_can_read(c.id)')
    for (const sig of ['team_chat_create_channel(uuid, text, uuid, text)', 'team_chat_open_dm(uuid, uuid)', 'team_chat_mark_read(uuid)', 'team_chat_unread(uuid)', 'team_chat_can_read(uuid)', 'team_chat_can_post(uuid)']) {
      expect(BODY).toContain(`revoke all on function public.${sig} from public, anon;`)
    }
    for (const name of ['team_chat_can_read', 'team_chat_can_post', 'team_chat_create_channel', 'team_chat_open_dm', 'team_chat_mark_read', 'team_chat_unread']) {
      expect(fn(name)).toContain('security definer')
      expect(fn(name)).toContain('set search_path = public, pg_temp')
    }
  })

  it('messages and channels are live (Realtime filters them by the same policies)', () => {
    expect(BODY).toContain('alter publication supabase_realtime add table public.team_chat_message;')
    expect(BODY).toContain('alter publication supabase_realtime add table public.team_chat_channel;')
  })

  it('the agent’s turn: reason team_chat and a team_chat conversation are allowed, the earlier ones kept', () => {
    const reasons = /home_turn_reason_check check \(reason in \(([^)]*)\)\)/.exec(BODY)?.[1].split(',').map((v) => v.trim().replace(/'/g, ''))
    expect(reasons).toEqual([...HOME_TURN_REASONS])
    expect(CHANNEL_SURFACES.has('team_chat')).toBe(true)
    expect(BODY).toContain("or (outside_channel = 'team_chat' and agent_guest_id is null)")
    expect(BODY).toContain("outside_channel = 'slack'")
    expect(BODY).toContain("or (outside_channel in ('sms', 'dial8') and agent_guest_id is not null)")
  })

  it('is re-runnable and safe for the hand-applying transport', () => {
    expect(BODY).not.toMatch(/drop table|delete from|truncate/i)
    expect(SQL).not.toContain('\\')
    expect((BODY.match(/create table if not exists/g) ?? []).length).toBe((BODY.match(/create table/g) ?? []).length)
  })

  it('the DB-level probes cover a non-member, a non-team member and a non-DM member', () => {
    expect(PROBES).toContain("'NON-MEMBER cannot read its messages', 'rows=0'")
    expect(PROBES).toContain("'NON-MEMBER cannot post', 'refused'")
    expect(PROBES).toContain("'member outside the team cannot read the team channel', 'rows=0'")
    expect(PROBES).toContain("'member outside the DM cannot read it', 'rows=0'")
    expect(PROBES).toContain("'a member''s post gets the server''s clock, never a future one', 'rows=1'")
    expect(PROBES).toContain("'member cannot edit their agent''s reply', 'refused'")
    expect(PROBES.trimEnd().endsWith('rollback;')).toBe(true)
  })
})
