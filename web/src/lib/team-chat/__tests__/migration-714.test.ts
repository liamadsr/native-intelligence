/**
 * Migration 714: managing a conversation (docs/plans/team-chat-manage.md).
 * TEXT CHECKS here.
 *
 * By hand, outside this suite, the file was applied twice on a local
 * Postgres 16 (without --single-transaction: it has its own begin/commit)
 * over stand-ins for the tables it reads and deletes, with their real
 * foreign keys and cascades (474, 555-558, 564, 566, 573, 587, 646, 655,
 * 700, 702, 703's deferred poll key, 709, 710), 566's capture guard, 568's
 * owner sync triggers and 572's two read functions as written there. Asked
 * as five members of one workspace: a channel's creator managed it, another
 * member didn't, the owner did; a meeting's host and an admin in it managed
 * it, a member in it didn't, the owner outside it didn't (it can't read it);
 * nobody managed a DM. A rename tidied "  #Team   room " to "Team room",
 * rewrote "… in #general" and "… in a thread in #general" notifications and
 * their place; a clash ignoring case was 23505, a DM 22023, 81 characters
 * 22023, a 251-character topic 22023, an empty topic cleared it; a meeting
 * chat's rename renamed its meeting. The contents counted 2 messages, 1
 * file, 1 poll, 1 call, 1 note. A delete by a non-host was 42501, of a
 * channel 22023, during a live call 55000; by the host it returned the two
 * objects under the chat's own folder (never `<id>0/…`), left nothing of the
 * conversation (members, messages, threads, reactions, polls, votes, file
 * text, calls, rings, egress, the meeting, guests, capture links, grants,
 * email shares, labels, the agent conversation and its messages, its
 * notifications, Inbox holds, links, activity, Drive opens), kept the notes
 * as the host's private capture, and touched nothing of another
 * conversation's. anon was refused every function.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const F = readFileSync(join(process.cwd(), 'supabase/migrations/714_team_chat_manage.sql'), 'utf8')
/** The SQL without its comments. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '')
const body = code(F)
const FUNCTIONS = [
  ['team_chat_can_manage', 'uuid'],
  ['team_chat_update_channel', 'uuid, text, text'],
  ['team_chat_meeting_chat_contents', 'uuid'],
  ['team_chat_delete_meeting_chat', 'uuid'],
] as const

/** One function's text, from its create to the end of its body. */
function fn(name: string): string {
  const start = body.indexOf(`create or replace function public.${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = body.indexOf('$$;', body.indexOf('as $$', start))
  return body.slice(start, end)
}

describe('714: four new functions, no other change', () => {
  it('each is SECURITY DEFINER with a pinned search_path, refused to anon, granted to authenticated and service_role', () => {
    for (const [name, args] of FUNCTIONS) {
      const f = fn(name)
      expect(f).toMatch(/security definer/)
      expect(f).toMatch(/set search_path = public, pg_temp/)
      expect(body).toContain(`revoke all on function public.${name}(${args}) from public, anon;`)
      expect(body).toContain(`grant execute on function public.${name}(${args}) to authenticated, service_role;`)
    }
    expect(body.match(/create or replace function/g)).toHaveLength(FUNCTIONS.length)
    expect(body).not.toMatch(/create table|alter table|create policy|drop policy|create trigger|create index/i)
  })

  it('names functions no earlier migration defines (nothing restated)', () => {
    for (const { file, sql } of migrationsInOrder()) {
      if (file.startsWith('714_')) continue
      for (const [f] of FUNCTIONS) expect(code(sql)).not.toMatch(new RegExp(`function\\s+public\\.${f}\\s*\\(`, 'i'))
    }
  })

  it('its own transaction, a bounded lock wait, and the schema reload after the commit', () => {
    expect(body).toMatch(/^\s*begin;/m)
    expect(body).toMatch(/set local lock_timeout = '5s';/)
    expect(body).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
    expect(F).toMatch(/WITHOUT\s+(-- )?--single-transaction/)
    expect(F).not.toContain('\\')
  })
})

describe('who may manage', () => {
  const f = () => fn('team_chat_can_manage')
  it('someone who may read it, a channel or meeting chat not archived, its creator or a meeting’s host, or an owner or admin', () => {
    expect(f()).toMatch(/m\.user_id = auth\.uid\(\)/)
    expect(f()).toMatch(/c\.kind in \('channel', 'meeting'\)/)
    expect(f()).toMatch(/c\.archived_at is null/)
    expect(f()).toMatch(/public\.team_chat_can_read\(c\.id\)/)
    expect(f()).toMatch(/c\.created_by = m\.id\s+or m\.role in \('owner', 'admin'\)/)
    expect(f()).toMatch(/x\.host_member_id = m\.id/)
  })

  it('every change asks it, after reading is checked', () => {
    for (const name of ['team_chat_update_channel', 'team_chat_meeting_chat_contents', 'team_chat_delete_meeting_chat']) {
      const g = fn(name)
      expect(g).toMatch(/not public\.team_chat_can_read\(ch\)/)
      expect(g).toMatch(/if not public\.team_chat_can_manage\(ch\) then\s+raise exception[^;]*errcode = '42501'/)
    }
  })
})

describe('the edit', () => {
  const f = () => fn('team_chat_update_channel')
  it('refuses a DM, tidies the name as the app does, and holds 474/572’s lengths', () => {
    expect(f()).toMatch(/c\.kind = 'dm' then\s+raise exception[^;]*'22023'/)
    expect(f()).toMatch(/regexp_replace\(regexp_replace\(trim\(new_name\), '\^#\+', ''\), '\[\[:space:\]\]\+', ' ', 'g'\)/)
    expect(f()).toMatch(/char_length\(name_now\) not between 1 and 80/)
    expect(f()).toMatch(/char_length\(topic_now\) > 250/)
  })

  it('a name taken is 23505; a meeting chat’s rename renames its meeting; a channel’s rewrites its notifications’ place', () => {
    expect(f()).toMatch(/exception when unique_violation then\s+raise exception[^;]*'23505'/)
    expect(f()).toMatch(/update public\.meeting x set title = name_now where x\.channel_id = ch/)
    expect(f()).toMatch(/n\.context_type = 'team_chat_channel'\s+and n\.context_id = ch\s+and right\(n\.title, char_length\(old_suffix\)\) = old_suffix/)
    expect(f()).toMatch(/old_suffix := ' in #' \|\| c\.name/)
  })
})

describe('the delete', () => {
  const f = () => fn('team_chat_delete_meeting_chat')
  it('meeting chats only, never while a call is live', () => {
    expect(f()).toMatch(/c\.kind <> 'meeting' then\s+raise exception[^;]*'22023'/)
    expect(f()).toMatch(/k\.status = 'live'\) then\s+raise exception[^;]*'55000'/)
  })

  it('keeps the call notes as their owner’s own private capture, through 566’s guard', () => {
    expect(f()).toMatch(/set_config\('team_call_notes\.refresh', 'on', true\);\s+update public\.captures cap\s+set notes_channel_id = null,\s+notes_owner_out = false\s+where cap\.notes_channel_id = ch;\s+perform set_config\('team_call_notes\.refresh', 'off', true\)/)
    expect(f()).not.toMatch(/delete from public\.captures/)
  })

  it('takes what nothing cascades to: notifications and their holds, links, activity, Drive opens, the agent conversations', () => {
    expect(f()).toMatch(/delete from public\.inbox_hold h/)
    expect(f()).toMatch(/delete from public\.notification n/)
    expect(f()).toMatch(/delete from public\.entity_link l/)
    expect(f()).toMatch(/delete from public\.entity_activity a/)
    expect(f()).toMatch(/d\.file_key like 'team_chat:' \|\| ch::text \|\| '\/%'/)
    expect(f()).toMatch(/delete from public\.chat_conversations cc\s+where cc\.id in \(select t\.conversation_id from public\.team_chat_agent_thread t where t\.channel_id = ch\)/)
    // Each scoped to the conversation's workspace.
    for (const t of ['h', 'n', 'l', 'a', 'd']) expect(f()).toMatch(new RegExp(`${t}\\.workspace_id = c\\.workspace_id`))
  })

  it('returns the objects under its own folder in the two buckets, then deletes the conversation (the rest cascades)', () => {
    expect(f()).toMatch(/o\.bucket_id in \('team-chat-files', 'team-call-recordings'\)\s+and o\.name like ch::text \|\| '\/%'/)
    expect(f()).toMatch(/delete from public\.team_chat_channel x where x\.id = ch;\s+return;/)
    expect(f()).not.toMatch(/delete from storage\./)
  })
})
