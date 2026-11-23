-- ============================================================
-- 697: the text inside team chat files, searchable by the channel's readers.
-- ============================================================
-- Why: Drive files (docs/plans/drive-files.md, phase 3): search and agents
-- find a file by what it says. An uploaded file's text is already extracted
-- and indexed (attachment_chunks, 087). A file sent in team chat (555, 558)
-- had none: this adds it, for the same people who read the message.
--
-- What lands, all of it new:
--   team_chat_file_chunk       one row a passage of a file on a message: the
--                              message, its channel and workspace, the file's
--                              object path and name, the passage, and its
--                              words (a generated tsvector, the file's name
--                              with them). Written only by the service role
--                              (the indexing job, src/lib/inngest/
--                              team-chat-file-index.ts): no client policy
--                              writes it.
--   who reads it               exactly who reads its message: the select
--                              policy asks for the message under the reader's
--                              own row security (474's team_chat_message_select
--                              and whatever later narrows it), so a reader
--                              removed from a channel stops finding its files'
--                              text at once: nothing is copied per person.
--   never stale                the rows go with their message (on delete
--                              cascade) and their channel. A message deleted
--                              in the app (555 clears its files and sets
--                              deleted_at) or whose files change loses the
--                              rows of every file it no longer carries, in the
--                              same statement (an after-update trigger,
--                              definer: no client may delete them itself). A
--                              message's words are not indexed here, only its
--                              files', so editing its words changes nothing.
--   team_chat_file_search      the search: passages whose words match every
--                              word typed, in the channels the person may read
--                              (team_chat_member_can_read, 556, for the
--                              person: the caller, or the person an agent's
--                              service-role call names, as 275's
--                              _resolve_visibility_requester allows; a signed-
--                              in caller may not name someone else), best
--                              match first, one row a file. No person, no
--                              rows: chat is no unattended run's to read.
--
-- Full text only, no vectors, as 561's message search: a chat file is
-- usually short, and the words are what people type.
--
-- After 474, 555, 556, 558 and 275. Re-runnable. Its own transaction (begin
-- ... commit), so it is all or nothing however it is applied. No backslashes
-- anywhere in this file. Each statement waits at most 5 s for a lock; one that
-- waits longer rolls the file back, to be applied again.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.team_chat_file_chunk (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  message_id uuid not null references public.team_chat_message(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  chunk_index integer not null,
  chunk_text text not null,
  fts tsvector generated always as (
    to_tsvector('english', left(file_name, 200) || ' ' || left(chunk_text, 20000))
  ) stored,
  created_at timestamptz not null default now(),
  constraint team_chat_file_chunk_index_check check (chunk_index between 0 and 199),
  constraint team_chat_file_chunk_text_check check (char_length(chunk_text) between 1 and 20000),
  constraint team_chat_file_chunk_path_check check (char_length(file_path) between 1 and 400),
  unique (message_id, file_path, chunk_index)
);

create index if not exists team_chat_file_chunk_fts_idx
  on public.team_chat_file_chunk using gin (fts);
create index if not exists team_chat_file_chunk_workspace_idx
  on public.team_chat_file_chunk (workspace_id, channel_id);

alter table public.team_chat_file_chunk enable row level security;

-- Read as its message is read: the message, under the reader's own row security.
drop policy if exists team_chat_file_chunk_select on public.team_chat_file_chunk;
create policy team_chat_file_chunk_select on public.team_chat_file_chunk
  for select to authenticated
  using (
    exists (
      select 1 from public.team_chat_message m
       where m.id = team_chat_file_chunk.message_id
         and m.channel_id = team_chat_file_chunk.channel_id
         and m.deleted_at is null
    )
  );

revoke all on public.team_chat_file_chunk from anon, authenticated;
grant select on public.team_chat_file_chunk to authenticated;
grant select, insert, update, delete on public.team_chat_file_chunk to service_role;

-- A message that no longer carries a file loses that file's passages.
create or replace function public.team_chat_file_chunk_follow_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null then
    delete from public.team_chat_file_chunk where message_id = new.id;
  elsif new.attachments is distinct from old.attachments then
    delete from public.team_chat_file_chunk c
     where c.message_id = new.id
       and not exists (
         select 1 from jsonb_array_elements(coalesce(new.attachments, '[]'::jsonb)) f
          where f ->> 'path' = c.file_path
       );
  end if;
  return null;
end;
$$;

revoke all on function public.team_chat_file_chunk_follow_message() from public, anon, authenticated;

drop trigger if exists team_chat_file_chunk_follow_message on public.team_chat_message;
create trigger team_chat_file_chunk_follow_message
  after update of deleted_at, attachments on public.team_chat_message
  for each row execute function public.team_chat_file_chunk_follow_message();

-- The search (see the header). Definer, with the person's channels decided inside it.
create or replace function public.team_chat_file_search(ws uuid, q text, lim integer default 8, p_requesting_user_id uuid default null)
returns table (
  message_id uuid,
  channel_id uuid,
  channel_kind text,
  channel_name text,
  file_path text,
  file_name text,
  snippet text,
  created_at timestamptz,
  rank real
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_user uuid := public._resolve_visibility_requester(p_requesting_user_id);
  v_member uuid;
  words text[];
  tsq tsquery;
begin
  if v_user is null then
    return;
  end if;
  select m.id into v_member from public.member m where m.workspace_id = ws and m.user_id = v_user limit 1;
  if v_member is null then
    return;
  end if;
  -- The words typed (letters and digits only, so nothing reaches the query's own grammar), each a prefix.
  words := array(
    select w
      from regexp_split_to_table(lower(coalesce(left(q, 200), '')), '[^[:alnum:]]+') w
     where char_length(w) between 1 and 40
     limit 6
  );
  if coalesce(array_length(words, 1), 0) = 0 then
    return;
  end if;
  tsq := to_tsquery('english', array_to_string(array(select w || ':*' from unnest(words) w), ' & '));
  if tsq is null or numnode(tsq) = 0 then
    return;
  end if;
  return query
  with readable as (
    select c.id, c.kind, c.name
      from public.team_chat_channel c
     where c.workspace_id = ws
       and public.team_chat_member_can_read(c.id, v_member)
  ),
  hits as (
    select distinct on (k.message_id, k.file_path)
           k.message_id, k.channel_id, k.file_path, k.file_name, k.chunk_text,
           ts_rank(k.fts, tsq) as r
      from public.team_chat_file_chunk k
      join readable rc on rc.id = k.channel_id
      join public.team_chat_message msg on msg.id = k.message_id and msg.channel_id = k.channel_id and msg.deleted_at is null
     where k.workspace_id = ws
       and k.fts @@ tsq
     order by k.message_id, k.file_path, r desc
  )
  select h.message_id,
         h.channel_id,
         rc.kind,
         rc.name,
         h.file_path,
         h.file_name,
         ts_headline('english', h.chunk_text, tsq, 'MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=1, StartSel="", StopSel=""'),
         msg.created_at,
         h.r
    from hits h
    join readable rc on rc.id = h.channel_id
    join public.team_chat_message msg on msg.id = h.message_id
   order by h.r desc, msg.created_at desc
   limit greatest(1, least(coalesce(lim, 8), 25));
end;
$$;

comment on function public.team_chat_file_search(uuid, text, integer, uuid) is
  'Team chat files whose text matches every word typed, in the channels the person may read (697). The caller, or the person a service-role call names.';

revoke all on function public.team_chat_file_search(uuid, text, integer, uuid) from public, anon;
grant execute on function public.team_chat_file_search(uuid, text, integer, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
