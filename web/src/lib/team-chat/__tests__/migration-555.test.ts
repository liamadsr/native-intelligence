/**
 * Migrations 555-559 (team chat, complete): threads, reactions, files,
 * retry-safe sends, link previews and typing. Who may reply, react and read a
 * file is the channel's own fence (team_chat_can_read / team_chat_can_post),
 * every new table is RLS on with no client writes, every write goes through a
 * definer function with a pinned search_path, and 474/480's guard refusals are
 * all kept. Run on DEV by supabase/tests/555_team_chat_complete.sql (inside a
 * rolled-back block); this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

const FILES = {
  columns: read('555_team_chat_message_columns.sql'),
  threads: read('556_team_chat_threads.sql'),
  reactions: read('557_team_chat_reactions.sql'),
  files: read('558_team_chat_files.sql'),
  typing: read('559_team_chat_typing.sql'),
}
const BODY = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, bodyOf(v)])) as Record<keyof typeof FILES, string>
const OLD_GUARD = read('480_team_chat_record_mentions.sql')
const PROBES = readFileSync(join(process.cwd(), 'supabase/tests/555_team_chat_complete.sql'), 'utf8')

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}

describe('migrations 555-559', () => {
  it('each is safe for a live database and the hand-applying transport, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries(FILES)) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).not.toMatch(/drop table|delete from|truncate|drop column/i)
      expect(body, name).toContain("SET LOCAL lock_timeout = '5s';")
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';"), name).toBe(true)
      expect((body.match(/create table if not exists/g) ?? []).length, name).toBe((body.match(/create table/g) ?? []).length)
      expect(body, name).not.toMatch(/to anon/)
    }
    // New checks on the live table are added NOT VALID, then validated (no long lock).
    for (const check of ['team_chat_message_attachments', 'team_chat_message_link_preview', 'team_chat_message_body']) {
      expect(BODY.columns).toMatch(new RegExp(`add constraint ${check} check \\([\\s\\S]*?\\) not valid;`))
      expect(BODY.columns).toContain(`validate constraint ${check};`)
    }
  })

  it('555: the guard keeps every one of 480’s refusals, adds the new columns, and a delete clears files and preview', () => {
    const guard = fn(BODY.columns, 'team_chat_message_guard')
    for (const line of fn(OLD_GUARD, 'team_chat_message_guard').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('or new.') || l.startsWith('raise exception'))) {
      expect(guard, line).toContain(line.replace(/ then$/, ''))
    }
    for (const col of ['thread_root_id', 'client_id', 'attachments', 'link_preview']) {
      expect(guard).toContain(`or new.${col} is distinct from old.${col}`)
    }
    expect(guard).toContain("new.attachments := '[]'::jsonb;")
    expect(guard).toContain('new.link_preview := null;')
    expect(BODY.columns).toMatch(/create unique index if not exists team_chat_message_client_key\s+on public\.team_chat_message \(author_member_id, client_id\)\s+where client_id is not null;/)
  })

  it('555: a client’s insert never carries a preview, and its files must be in the channel’s folder, its own sub-folder', () => {
    const guard = fn(BODY.columns, 'team_chat_message_insert_guard')
    expect(guard).toContain('new.created_at := now();')
    expect(guard).toContain('new.link_preview := null;')
    expect(guard).toContain("'^' || new.channel_id::text || '/' || auth.uid()::text || '/[0-9a-f-]{36}[.][a-z0-9]{1,8}$'")
  })

  it('556: members may reply in a thread of the same channel; in_reply_to stays the agent’s; a reply to a reply goes to the root', () => {
    const policy = BODY.threads.slice(BODY.threads.indexOf('create policy team_chat_message_insert'), BODY.threads.indexOf('-- ── The thread'))
    for (const clause of [
      "author_kind = 'member'",
      'author_member_id = public.current_member_id(workspace_id)',
      'agent_for_member_id is null',
      'in_reply_to is null',
      'public.team_chat_can_post(channel_id)',
      'r.channel_id = team_chat_message.channel_id',
      'r.thread_root_id is null',
    ]) {
      expect(policy, clause).toContain(clause)
    }
    const root = fn(BODY.threads, 'team_chat_message_thread_root')
    expect(root).toContain('new.thread_root_id := parent_root;')
    expect(root).toMatch(/if not found then\s+raise exception/)
    expect(BODY.threads).toMatch(/create trigger team_chat_message_thread_root\s+before insert on public\.team_chat_message/)
  })

  it('556: thread tables are read-only to clients, read through the channel fence; the tracker is a definer', () => {
    for (const table of ['team_chat_thread', 'team_chat_thread_member']) {
      expect(BODY.threads).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY.threads).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY.threads).toContain(`grant select on table public.${table} to authenticated;`)
      expect(BODY.threads).not.toMatch(new RegExp(`grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\\.${table} to`))
    }
    expect(BODY.threads).toMatch(/policy team_chat_thread_select on public\.team_chat_thread\s+for select to authenticated using \(public\.team_chat_can_read\(channel_id\)\)/)
    expect(BODY.threads).toMatch(/policy team_chat_thread_member_select on public\.team_chat_thread_member\s+for select to authenticated using \(member_id = public\.current_member_id\(workspace_id\)\)/)
    for (const name of ['team_chat_thread_track', 'team_chat_unread', 'team_chat_thread_unread', 'team_chat_mark_thread_read']) {
      expect(fn(BODY.threads, name), name).toContain('security definer')
      expect(fn(BODY.threads, name), name).toContain('set search_path = public, pg_temp')
    }
    expect(BODY.threads).toContain('alter publication supabase_realtime add table public.team_chat_thread;')
  })

  it('556: the unread maths — the channel counts its own messages only; a thread counts for those in it', () => {
    const unread = fn(BODY.threads, 'team_chat_unread')
    expect(unread).toContain('and msg.thread_root_id is null')
    expect(unread).toContain('public.team_chat_can_read(c.id)')
    const threads = fn(BODY.threads, 'team_chat_thread_unread')
    expect(threads).toContain('tm.member_id = (select id from me)')
    expect(threads).toContain('msg.created_at > tm.last_read_at')
    expect(threads).toContain("not (msg.author_kind = 'member' and msg.author_member_id = tm.member_id)")
    expect(threads).toContain('public.team_chat_can_read(tm.channel_id)')
    const track = fn(BODY.threads, 'team_chat_thread_track')
    // The root's person, the repliers, the agent's person and the mentioned are in the thread.
    expect(track).toContain('coalesce(root.author_member_id, root.agent_for_member_id)')
    expect(track).toContain('values (root.id, replier, root.channel_id, root.workspace_id, new.created_at)')
    expect(track).toContain('new.agent_for_member_id')
    expect(track).toContain('m.id = any (new.mentions)')
    expect(fn(BODY.threads, 'team_chat_mark_thread_read')).toMatch(/if ch is null or not public\.team_chat_can_read\(ch\) then\s+raise exception/)
  })

  it('556: only people who may read the channel are brought into a thread; the summary counts live replies; a reply never moves its channel', () => {
    const canRead = fn(BODY.threads, 'team_chat_member_can_read')
    expect(canRead).toContain('security definer')
    expect(canRead).toContain('c.team_id is null or exists (select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = mem)')
    expect(canRead).toContain("c.kind = 'dm' and exists (select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = mem)")
    expect(BODY.threads).toContain('revoke all on function public.team_chat_member_can_read(uuid, uuid) from public, anon, authenticated;')
    const track = fn(BODY.threads, 'team_chat_thread_track')
    // Every way into a thread but the replier's own (they posted, so they may) goes through the fence.
    expect(track.match(/public\.team_chat_member_can_read\(root\.channel_id, /g)?.length).toBe(4)
    // A delete recomputes; an edit's new mentions come in.
    expect(track).toMatch(/if old\.deleted_at is null and new\.deleted_at is not null then\s+perform public\.team_chat_thread_refresh\(root\.id\);/)
    expect(track).toContain('where not (x = any (old.mentions))')
    expect(BODY.threads).toMatch(/create trigger team_chat_thread_track_update\s+after update of deleted_at, mentions on public\.team_chat_message/)
    const refresh = fn(BODY.threads, 'team_chat_thread_refresh')
    expect(refresh).toContain('where thread_root_id = root and deleted_at is null')
    // A thread emptied keeps its row at 0 (an UPDATE, which Realtime filters), never a DELETE.
    expect(refresh).not.toMatch(/delete from/i)
    const touch = fn(BODY.threads, 'team_chat_touch_channel')
    expect(touch).toMatch(/if new\.thread_root_id is not null then\s+return new;/)
  })

  it('555: a file’s name, size and type are bounded in the database (the cap holds for a direct insert)', () => {
    const guard = fn(BODY.columns, 'team_chat_message_insert_guard')
    expect(guard).toContain("char_length(a ->> 'name') between 1 and 200")
    expect(guard).toContain("(a ->> 'size')::numeric between 1 and 10485760")
    expect(guard).toContain("coalesce(a ->> 'type', '') in (")
    expect(guard).not.toContain("'text/html'")
    expect(guard).not.toContain("'image/svg+xml'")
  })

  it('557: reactions — one row per trio, written only by the function, which needs a channel the caller may post in', () => {
    expect(BODY.reactions).toContain('primary key (message_id, member_id, emoji)')
    expect(BODY.reactions).toContain('revoke all on table public.team_chat_reaction from anon, authenticated;')
    expect(BODY.reactions).toContain('grant select on table public.team_chat_reaction to authenticated;')
    expect(BODY.reactions).not.toMatch(/grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.team_chat_reaction to/)
    expect(BODY.reactions).toMatch(/policy team_chat_reaction_select on public\.team_chat_reaction\s+for select to authenticated using \(public\.team_chat_can_read\(channel_id\)\)/)
    const react = fn(BODY.reactions, 'team_chat_react')
    expect(react).toContain('security definer')
    expect(react).toContain('set search_path = public, pg_temp')
    expect(react).toMatch(/if ch is null or not public\.team_chat_can_post\(ch\) then\s+raise exception/)
    // Taken back = turned off (an UPDATE Realtime filters), never a DELETE it would send everyone.
    expect(react).not.toMatch(/delete from/i)
    expect(BODY.reactions).toContain('alter publication supabase_realtime add table public.team_chat_reaction;')
    expect(BODY.reactions).toContain('revoke all on function public.team_chat_react(uuid, text, boolean) from public, anon;')
  })

  it('558: a private bucket of its own, read through the channel fence, uploads only into the caller’s sub-folder', () => {
    expect(BODY.files).toMatch(/'team-chat-files',\s+'team-chat-files',\s+false,\s+10485760/)
    expect(BODY.files).not.toMatch(/'text\/html'|'image\/svg\+xml'/)
    const read = BODY.files.slice(BODY.files.indexOf('create policy "team chat files read"'), BODY.files.indexOf('drop policy if exists "team chat files upload"'))
    expect(read).toContain("bucket_id = 'team-chat-files'")
    expect(read).toContain('public.team_chat_can_read(public.team_chat_file_channel(name))')
    const upload = BODY.files.slice(BODY.files.indexOf('create policy "team chat files upload"'), BODY.files.indexOf('drop policy if exists "team chat files delete"'))
    expect(upload).toContain("split_part(name, '/', 2) = (select auth.uid())::text")
    expect(upload).toContain('public.team_chat_can_post(public.team_chat_file_channel(name))')
    expect(BODY.files).not.toMatch(/for update/)
    // The `attachments` bucket is left as it is.
    expect(BODY.files).not.toMatch(/bucket_id = 'attachments'/)
  })

  it('559: typing topics are private: hear = may read the channel, say = may post in it', () => {
    expect(BODY.typing).toMatch(/for select to authenticated\s+using \(\s+realtime\.topic\(\) like 'team-chat-typing:%'\s+and realtime\.messages\.extension = 'broadcast'\s+and public\.team_chat_can_read\(public\.team_chat_typing_channel\(realtime\.topic\(\)\)\)/)
    expect(BODY.typing).toMatch(/for insert to authenticated\s+with check \(\s+realtime\.topic\(\) like 'team-chat-typing:%'\s+and realtime\.messages\.extension = 'broadcast'\s+and public\.team_chat_can_post\(public\.team_chat_typing_channel\(realtime\.topic\(\)\)\)/)
  })

  it('the DB-level probes cover who may reply, react and read a file, the thread unread maths and idempotent sends', () => {
    for (const label of [
      "'member outside the team cannot reply in its thread', 'refused'",
      "'a thread reply is never the channel''s unread (Ana: none)', 'rows=1'",
      "'someone the reply mentions has it unread, as a mention', 'rows=1'",
      "'someone not in the thread has nothing unread in it', 'rows=0'",
      "'member outside the DM cannot react in it', 'refused'",
      "'member outside the team cannot read its file', 'rows=0'",
      "'member outside the DM cannot read its file', 'rows=0'",
      "'a message cannot carry another channel''s file', 'refused'",
      "'a retried send (same client id) is refused as a duplicate', 'refused'",
      "'a client''s link preview is dropped on insert', 'rows=1'",
      "'a mention never brings in someone who can''t read the channel', 'rows=0'",
      "'a deleted reply leaves the summary (count, last reply and repliers recomputed)', 'rows=1'",
      "'a thread reply never moves its channel up the list', 'rows=1'",
      "'an edit that mentions someone new brings them into the thread', 'rows=1'",
      "'a file over 10 MB is refused even inserted directly', 'refused'",
    ]) {
      expect(PROBES, label).toContain(label)
    }
    expect(PROBES.trimEnd().endsWith('rollback;')).toBe(true)
  })
})
