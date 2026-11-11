-- ============================================================
-- 555: Team chat, complete (phase 1): the message's new columns, and 474's
-- guards re-made for them. 556 (threads), 557 (reactions), 558 (files) and
-- 559 (typing) build on these.
-- ============================================================
--   team_chat_message.thread_root_id  the thread a reply belongs to: its
--                     ROOT message, one level deep (556 moves a reply to a
--                     reply onto the same root, and lets members post one).
--                     Null for a message in the channel itself.
--   team_chat_message.client_id   the id the sender's page minted for this
--                     send. Unique per author: a retried send finds the row
--                     it already made instead of making a second, and the
--                     page reconciles its optimistic bubble with the row by
--                     it.
--   team_chat_message.attachments  the files and images on a message:
--                     [{ "path", "name", "size", "type", "width"?, "height"? }],
--                     at most 10. Each path is in the channel's own folder of
--                     the team-chat-files bucket (558), in the author's own
--                     sub-folder: `<channel id>/<user id>/<uuid>.<ext>` (the
--                     insert guard checks it).
--   team_chat_message.link_preview  the first link's title, description and
--                     image, fetched once, out of the request path
--                     (src/lib/inngest/team-chat-link-preview.ts), and
--                     written by the service role only.
--   team_chat_message_body  a message may be files alone, with no words.
--   team_chat_message_guard  480's, plus: a client never changes
--                     thread_root_id, client_id, attachments or link_preview;
--                     a delete clears attachments and link_preview with the
--                     words.
--   team_chat_message_insert_guard  474's, plus: no link preview from a
--                     client, and every attachment in the channel's folder,
--                     the author's own sub-folder, with a name of 1 to 200
--                     characters, a size of 1 byte to 10 MB and one of the
--                     media types a message may carry (the same as
--                     src/lib/team-chat/files.ts): the cap holds for a
--                     direct insert too, not only through the route.
--
-- Additive. Idempotent. Safe on a live database: the new columns are
-- nullable or have constant defaults (no table rewrite). The file runs as
-- one transaction, so the ACCESS EXCLUSIVE lock ADD COLUMN takes is held to
-- commit, and the NOT VALID / VALIDATE pair below does not shorten it; what
-- keeps this safe is that team_chat_message is small (the validating scans
-- take milliseconds) and lock_timeout (5 s): behind a long-running reader
-- the migration fails and rolls back rather than queueing every write
-- behind it. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

alter table public.team_chat_message
  add column if not exists thread_root_id uuid references public.team_chat_message(id) on delete cascade,
  add column if not exists client_id uuid,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists link_preview jsonb;

-- A thread's replies, oldest first.
create index if not exists team_chat_message_thread_idx
  on public.team_chat_message (thread_root_id, created_at)
  where thread_root_id is not null;

-- One row per author and send: the retry finds it.
create unique index if not exists team_chat_message_client_key
  on public.team_chat_message (author_member_id, client_id)
  where client_id is not null;

alter table public.team_chat_message drop constraint if exists team_chat_message_attachments;
alter table public.team_chat_message
  add constraint team_chat_message_attachments check (
    jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_attachments;

alter table public.team_chat_message drop constraint if exists team_chat_message_link_preview;
alter table public.team_chat_message
  add constraint team_chat_message_link_preview check (
    link_preview is null or jsonb_typeof(link_preview) = 'object'
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_link_preview;

-- 474's, and a message of files alone (no words) is one too.
alter table public.team_chat_message drop constraint if exists team_chat_message_body;
alter table public.team_chat_message
  add constraint team_chat_message_body check (
    deleted_at is not null
    or char_length(body) between 1 and 8000
    or (body = '' and jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) > 0)
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_body;

-- 480's guard, with this migration's columns kept as they were.
create or replace function public.team_chat_message_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.channel_id is distinct from old.channel_id
     or new.workspace_id is distinct from old.workspace_id
     or new.author_kind is distinct from old.author_kind
     or new.author_member_id is distinct from old.author_member_id
     or new.agent_for_member_id is distinct from old.agent_for_member_id
     or new.agent_name is distinct from old.agent_name
     or new.in_reply_to is distinct from old.in_reply_to
     or new.created_at is distinct from old.created_at
     or new.thread_root_id is distinct from old.thread_root_id
     or new.client_id is distinct from old.client_id
     or new.attachments is distinct from old.attachments
     or new.link_preview is distinct from old.link_preview then
    raise exception 'team chat: only the words of a message can change' using errcode = '42501';
  end if;
  if old.author_kind = 'agent' and new.deleted_at is null then
    raise exception 'team chat: an agent''s reply can only be deleted' using errcode = '42501';
  end if;
  if new.deleted_at is not null then
    new.body := '';
    new.mentions := '{}';
    new.record_mentions := '[]'::jsonb;
    new.attachments := '[]'::jsonb;
    new.link_preview := null;
    new.mentions_agent := false;
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body
     or new.mentions is distinct from old.mentions
     or new.record_mentions is distinct from old.record_mentions then
    new.edited_at := now();
    new.mentions_agent := old.mentions_agent;
  else
    new.edited_at := old.edited_at;
    new.mentions_agent := old.mentions_agent;
  end if;
  return new;
end;
$$;

-- 474's insert guard, plus: no link preview from a client (the service
-- role's to write), and every attachment in the channel's own folder, the
-- author's sub-folder, named by a uuid (558's bucket fences reads by the
-- folder, so a path outside it would be a file of another channel), its name,
-- size and type bounded (each CASE checks a value's JSON type before it is
-- cast, since OR does not promise to stop early).
create or replace function public.team_chat_message_insert_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  new.created_at := now();
  new.edited_at := null;
  new.deleted_at := null;
  new.link_preview := null;
  if jsonb_typeof(new.attachments) = 'array' and exists (
    select 1
      from jsonb_array_elements(new.attachments) a
     where jsonb_typeof(a) <> 'object'
        or coalesce(a ->> 'path', '') !~ ('^' || new.channel_id::text || '/' || auth.uid()::text || '/[0-9a-f-]{36}[.][a-z0-9]{1,8}$')
  ) then
    raise exception 'team chat: a file must be in the channel''s own folder' using errcode = '42501';
  end if;
  if jsonb_typeof(new.attachments) = 'array' and exists (
    select 1
      from jsonb_array_elements(new.attachments) a
     where not (
       case when jsonb_typeof(a -> 'name') = 'string' then char_length(a ->> 'name') between 1 and 200 else false end
       and case when jsonb_typeof(a -> 'size') = 'number' then (a ->> 'size')::numeric between 1 and 10485760 else false end
       and coalesce(a ->> 'type', '') in (
         'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
         'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
         'application/zip'
       )
       and case when not a ? 'width' then true when jsonb_typeof(a -> 'width') <> 'number' then false else (a ->> 'width')::numeric between 1 and 20000 end
       and case when not a ? 'height' then true when jsonb_typeof(a -> 'height') <> 'number' then false else (a ->> 'height')::numeric between 1 and 20000 end
     )
  ) then
    raise exception 'team chat: a file''s name, size or type is out of bounds' using errcode = '23514';
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
