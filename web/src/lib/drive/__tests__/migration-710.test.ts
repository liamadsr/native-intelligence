/**
 * Migration 710: the text inside team chat files, read by the channel's
 * readers (docs/plans/drive-files.md, phase 3). Pins the file: its passages
 * are read as their message is (the message, under the reader's own row
 * security), never written by a client, gone with their message (cascade)
 * and with any file the message no longer carries (the after-update
 * trigger); the search decides the person's channels inside itself and
 * answers no one with no person; its own transaction, bounded, no backslash.
 *
 * TEXT CHECKS here. By hand, outside this suite, the file was applied twice on
 * a local Postgres 16 with stand-ins (474's team_chat_can_read and 556's
 * team_chat_member_can_read as written) and asked 17 questions; among them, a
 * reader taken off the channel's team stops finding its files' text, through
 * the search and the table both, at once.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/710_team_chat_file_text.sql'), 'utf8')

describe('migration 710', () => {
  it('goes with its message and its channel', () => {
    expect(SQL).toContain('channel_id uuid not null references public.team_chat_channel(id) on delete cascade')
    expect(SQL).toContain('message_id uuid not null references public.team_chat_message(id) on delete cascade')
  })

  it('is read as its message is, and written by the service role only', () => {
    expect(SQL).toMatch(/create policy team_chat_file_chunk_select on public\.team_chat_file_chunk\s+for select to authenticated/)
    expect(SQL).toContain('select 1 from public.team_chat_message m')
    expect(SQL).not.toMatch(/create policy team_chat_file_chunk_(insert|update|delete)/)
    expect(SQL).toContain('revoke all on public.team_chat_file_chunk from anon, authenticated;')
    expect(SQL).toContain('grant select on public.team_chat_file_chunk to authenticated;')
  })

  it('leaves no stale text: a deleted message, or a file a message no longer carries', () => {
    expect(SQL).toContain('after update of deleted_at, attachments on public.team_chat_message')
    expect(SQL).toContain('if new.deleted_at is not null then\n    delete from public.team_chat_file_chunk where message_id = new.id;')
    expect(SQL).toContain("where f ->> 'path' = c.file_path")
  })

  it('searches only the channels the person may read, and no one’s with no person', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.team_chat_file_search'))
    expect(fn).toContain('public._resolve_visibility_requester(p_requesting_user_id)')
    expect(fn).toContain('if v_user is null then\n    return;')
    expect(fn).toContain('public.team_chat_member_can_read(c.id, v_member)')
    expect(fn).toContain('msg.deleted_at is null')
    expect(fn).toContain('security definer')
  })

  it('is its own transaction, bounded, re-runnable, and has no backslash', () => {
    expect(SQL).toMatch(/\nbegin;\n/)
    expect(SQL.trimEnd().endsWith('commit;')).toBe(true)
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';")
    expect(SQL.includes('\\')).toBe(false)
    expect(SQL).not.toMatch(/create table public\./)
    expect(SQL).not.toMatch(/create index (?!if not exists)/)
  })
})
