/**
 * Migration 711: comments on a file, pinned to a place on a page
 * (docs/plans/drive-files.md, phase 4). Pins the file: a comment is read and
 * written by whoever reads its file, under the caller's own row security (so
 * 709's Drive upload rule and team chat's rule decide, restated nowhere);
 * only its author changes its words (681's rule) and 692's via_agent guard
 * holds; never a mail attachment's; the notification list is 688's with
 * 'attachment' added; its own transaction, bounded, no backslash.
 *
 * TEXT CHECKS here. By hand, outside this suite, the file was applied twice on
 * a local Postgres 16 after 709 and 710 (stand-ins as theirs, 692's guard as
 * written) and asked 25 questions as an uploader, a member, a guest and a
 * member off the channel's team: the plan lists them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const SQL = read('711_file_comments.sql')

describe('migration 711', () => {
  it('reads a comment exactly as its file is read, under the caller’s own row security', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.file_comment_file_readable'), SQL.indexOf('revoke all on function public.file_comment_file_readable'))
    expect(fn).not.toContain('security definer')
    expect(fn).toContain('select 1 from public.attachments a where a.id = p_attachment')
    expect(fn).toContain('select 1 from public.team_chat_message m')
    for (const op of ['select', 'insert', 'update', 'delete']) expect(SQL).toMatch(new RegExp(`create policy file_comment_${op} on public\\.file_comment`))
    expect(SQL.match(/public\.file_comment_file_readable\(attachment_id, chat_message_id, chat_file_path, workspace_id\)/g)?.length).toBe(5)
  })

  it('is on an uploaded file or a chat file, never mail', () => {
    expect(SQL).toContain('attachment_id uuid references public.attachments(id) on delete cascade')
    expect(SQL).toContain('chat_message_id uuid references public.team_chat_message(id) on delete cascade')
    const table = SQL.slice(SQL.indexOf('create table if not exists public.file_comment ('), SQL.indexOf('comment on table public.file_comment'))
    expect(table).not.toMatch(/email|mail/)
  })

  it('keeps a comment’s words its author’s (681) and its assistant mark as made (692)', () => {
    expect(SQL).toContain("raise exception 'Only its author changes a comment.'")
    expect(SQL).toContain("raise exception 'A comment keeps its file, its author, its thread, its place and its time.'")
    expect(SQL).toContain('for each row execute function public.record_comment_agent_mark_guard();')
    expect(SQL).toMatch(/and not via_agent\s+and resolved_at is null/)
  })

  it('widens 688’s notification list by attachment only', () => {
    const list = (sql: string) => {
      const i = sql.indexOf('add constraint notification_target_type_check check (target_type in (')
      return sql.slice(i, sql.indexOf(')) not valid;', i))
    }
    expect(list(SQL).replace(",\n  'attachment'", '')).toBe(list(read('688_record_sharing.sql')))
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
