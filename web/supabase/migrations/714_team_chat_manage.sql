-- ============================================================
-- 714: Manage a conversation (docs/plans/team-chat-manage.md): edit a
-- channel's name and topic, rename a meeting chat, delete a channel or a
-- meeting chat completely. The owner's report, 2026-11-23: "there's no way to
-- edit a channel in team-chat or rename a group chat or completely delete a
-- meeting channel"; and, the same day, channels too ("they let you delete
-- it, we should too").
-- ============================================================
--   team_chat_can_manage(ch)   the caller may manage this conversation: they
--                     may read it (474/572's team_chat_can_read), it is a
--                     channel or a meeting chat (a DM has no name and no
--                     manager), it isn't archived, and they made it
--                     (created_by; a meeting's host_member_id too) or are an
--                     owner or admin of its workspace.
--   team_chat_update_channel(ch, new_name, new_topic)  as the caller, under
--                     team_chat_can_manage. A null keeps that field; an
--                     empty topic clears it. The name is tidied as the app
--                     tidies it (spaces run together, a leading # dropped)
--                     and must be 1 to 80 characters (474/572's shape); a
--                     topic 250 at most. A channel's name stays unique among
--                     the workspace's live channels, ignoring case (474's
--                     index): a clash is 23505 and the app says it in words.
--                     A meeting chat's rename renames its meeting too
--                     (meeting.title, what the Meetings list and the guest's
--                     page show). A channel's rename rewrites the words of
--                     the notifications its messages made (" in #old" ending
--                     their title, and metadata.place), so the Inbox says
--                     the new name. Returns the row as it now is.
--   team_chat_delete_contents(ch)  what a delete would take, counted for the
--                     confirmation: messages, files, polls, calls, members,
--                     the call notes that stay, whether a call is live, and
--                     (a meeting chat) whether its link still works and
--                     whether it is a booking's. Under team_chat_can_manage:
--                     a channel or a meeting chat, never a DM.
--   team_chat_delete_conversation(ch)  deletes a channel or a meeting chat
--                     and everything that hangs off it, as the caller, under
--                     team_chat_can_manage (a channel's creator, a meeting's
--                     host, or the workspace's owner or admin); never a DM
--                     (22023), never while its call is live (55000: end the
--                     call first).
--                     KEPT: the call notes (captures with notes_channel_id =
--                     ch, 566/567): each becomes its owner's own private
--                     capture (notes_channel_id cleared, notes_owner_out
--                     false), so it is no longer read through the chat by
--                     anyone else. Without this they would be read by no one
--                     at all (566's fence reads a deleted channel as no
--                     one's). Anything made from the chat (a task, a
--                     document, a record) is a record of its own and stays.
--                     GONE, by 474-713's own cascades from the channel: its
--                     members and their read marks, snoozes and levels;
--                     messages, threads, reactions, polls and votes, file
--                     text, email shares; calls, rings, egress rows, the
--                     calls' capture links and live agent rows; the meeting
--                     itself, for a meeting chat (its link stops working),
--                     its guests, keys and rates; labels; records shared with the chat (their
--                     grants to it). GONE, here, because nothing cascades to
--                     them: notifications about it or its messages, the
--                     Inbox holds on those notifications, entity links and
--                     activity naming it or its messages, Drive's
--                     opened-file rows for its files, and each person's
--                     agent conversation for it (474's team_chat_agent_thread
--                     rows' chat_conversations, which hold the chat's words
--                     as the agent's context). Recent and search read the
--                     messages, so they drop it with them.
--                     FILES: storage objects cannot be removed from SQL
--                     (Storage's own API removes the bytes), so the function
--                     returns the object names under the chat's folder in
--                     team-chat-files (558) and team-call-recordings (566),
--                     and the app removes them with the service role right
--                     after (src/lib/team-chat/manage.ts). Until it has, no
--                     one can read them: both buckets' read policy asks
--                     team_chat_can_read of the first folder, a channel now
--                     gone. A channel's name is free again once it is gone
--                     (474's unique index holds live rows only).
--
-- New functions only: no table, column, policy or existing function changes.
-- Each is SECURITY DEFINER with search_path = public, pg_temp, revoked from
-- public and anon, granted to authenticated and service_role.
--
-- Apply: its own transaction (begin/commit below), so apply it WITHOUT
-- --single-transaction, with ON_ERROR_STOP=1:
--   psql -v ON_ERROR_STOP=1 -f 714_team_chat_manage.sql
-- It reloads the data API's schema itself (the last line, after the commit).
-- Re-runnable (create or replace). No backslashes anywhere in this file.
-- ------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ── Who may manage a conversation ───────────────────────────────────────────

create or replace function public.team_chat_can_manage(ch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.team_chat_channel c
      join public.member m on m.workspace_id = c.workspace_id and m.user_id = auth.uid()
     where c.id = ch
       and c.kind in ('channel', 'meeting')
       and c.archived_at is null
       and public.team_chat_can_read(c.id)
       and (
         c.created_by = m.id
         or m.role in ('owner', 'admin')
         or (c.kind = 'meeting' and exists (
               select 1 from public.meeting x where x.channel_id = c.id and x.host_member_id = m.id
             ))
       )
  );
$$;

revoke all on function public.team_chat_can_manage(uuid) from public, anon;
grant execute on function public.team_chat_can_manage(uuid) to authenticated, service_role;

-- ── Edit: a channel's name and topic, a meeting chat's name ─────────────────

create or replace function public.team_chat_update_channel(ch uuid, new_name text, new_topic text)
returns table (id uuid, kind text, name text, topic text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_chat_channel%rowtype;
  name_now text;
  topic_now text;
  old_suffix text;
  new_suffix text;
begin
  select * into c from public.team_chat_channel x where x.id = ch for update;
  if not found or not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such conversation' using errcode = 'P0002';
  end if;
  if c.kind = 'dm' then
    raise exception 'team chat: a direct message has no name to change' using errcode = '22023';
  end if;
  if not public.team_chat_can_manage(ch) then
    raise exception 'team chat: only its creator or a workspace admin can change it' using errcode = '42501';
  end if;

  if new_name is null then
    name_now := c.name;
  else
    name_now := trim(regexp_replace(regexp_replace(trim(new_name), '^#+', ''), '[[:space:]]+', ' ', 'g'));
    if char_length(name_now) not between 1 and 80 then
      raise exception 'team chat: a name is 1 to 80 characters' using errcode = '22023';
    end if;
  end if;
  if new_topic is null then
    topic_now := c.topic;
  else
    topic_now := nullif(trim(new_topic), '');
    if topic_now is not null and char_length(topic_now) > 250 then
      raise exception 'team chat: a topic is 250 characters at most' using errcode = '22023';
    end if;
  end if;

  if name_now is not distinct from c.name and topic_now is not distinct from c.topic then
    return query select c.id, c.kind, c.name, c.topic;
    return;
  end if;

  begin
    update public.team_chat_channel x set name = name_now, topic = topic_now where x.id = ch;
  exception when unique_violation then
    raise exception 'team chat: a channel with that name already exists' using errcode = '23505';
  end;

  if name_now is distinct from c.name then
    if c.kind = 'meeting' then
      update public.meeting x set title = name_now where x.channel_id = ch and x.title is distinct from name_now;
    else
      -- 560's words: "<who> in #<name>" or "<who> in a thread in #<name>", and metadata.place '#<name>'.
      old_suffix := ' in #' || c.name;
      new_suffix := ' in #' || name_now;
      update public.notification n
         set title = left(n.title, char_length(n.title) - char_length(old_suffix)) || new_suffix,
             metadata = case when n.metadata ? 'place' then jsonb_set(n.metadata, '{place}', to_jsonb('#' || name_now)) else n.metadata end
       where n.workspace_id = c.workspace_id
         and n.context_type = 'team_chat_channel'
         and n.context_id = ch
         and right(n.title, char_length(old_suffix)) = old_suffix;
    end if;
  end if;

  return query select x.id, x.kind, x.name, x.topic from public.team_chat_channel x where x.id = ch;
end;
$$;

revoke all on function public.team_chat_update_channel(uuid, text, text) from public, anon;
grant execute on function public.team_chat_update_channel(uuid, text, text) to authenticated, service_role;

-- ── Delete a channel or meeting chat: what it would take ─────────────────────

create or replace function public.team_chat_delete_contents(ch uuid)
returns table (
  messages integer,
  files integer,
  polls integer,
  calls integer,
  members integer,
  notes_kept integer,
  live_call boolean,
  link_current boolean,
  booked boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_chat_channel%rowtype;
begin
  select * into c from public.team_chat_channel x where x.id = ch;
  if not found or not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such conversation' using errcode = 'P0002';
  end if;
  if c.kind = 'dm' then
    raise exception 'team chat: a direct message cannot be deleted' using errcode = '22023';
  end if;
  if not public.team_chat_can_manage(ch) then
    raise exception 'team chat: only its creator or a workspace admin can delete it' using errcode = '42501';
  end if;
  return query
  select
    (select count(*)::integer from public.team_chat_message m where m.channel_id = ch and m.deleted_at is null and m.poll_id is null),
    (select count(*)::integer from storage.objects o where o.bucket_id = 'team-chat-files' and o.name like ch::text || '/%'),
    (select count(*)::integer from public.team_chat_poll p where p.channel_id = ch),
    (select count(*)::integer from public.team_call k where k.channel_id = ch),
    (select count(*)::integer from public.team_chat_member tm where tm.channel_id = ch),
    (select count(*)::integer from public.captures cap where cap.notes_channel_id = ch),
    exists (select 1 from public.team_call k where k.channel_id = ch and k.status = 'live'),
    exists (select 1 from public.meeting x where x.channel_id = ch and x.revoked_at is null and x.closes_at > now()),
    exists (select 1 from public.meeting x where x.channel_id = ch and x.booking_id is not null);
end;
$$;

revoke all on function public.team_chat_delete_contents(uuid) from public, anon;
grant execute on function public.team_chat_delete_contents(uuid) to authenticated, service_role;

-- ── Delete a channel or meeting chat ────────────────────────────────────────

create or replace function public.team_chat_delete_conversation(ch uuid)
returns table (bucket text, object_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_chat_channel%rowtype;
  msg_ids uuid[];
  objects record;
begin
  select * into c from public.team_chat_channel x where x.id = ch for update;
  if not found or not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such conversation' using errcode = 'P0002';
  end if;
  if c.kind = 'dm' then
    raise exception 'team chat: a direct message cannot be deleted' using errcode = '22023';
  end if;
  if not public.team_chat_can_manage(ch) then
    raise exception 'team chat: only its creator or a workspace admin can delete it' using errcode = '42501';
  end if;
  if exists (select 1 from public.team_call k where k.channel_id = ch and k.status = 'live') then
    raise exception 'team chat: end the call before deleting the conversation' using errcode = '55000';
  end if;

  select coalesce(array_agg(m.id), '{}') into msg_ids from public.team_chat_message m where m.channel_id = ch;

  -- The call notes stay, as their owner's own private capture (566's guard lets this write through).
  perform set_config('team_call_notes.refresh', 'on', true);
  update public.captures cap
     set notes_channel_id = null,
         notes_owner_out = false
   where cap.notes_channel_id = ch;
  perform set_config('team_call_notes.refresh', 'off', true);

  -- Its notifications, and the Inbox holds on them.
  delete from public.inbox_hold h
   using public.notification n
   where n.workspace_id = c.workspace_id
     and h.workspace_id = c.workspace_id
     and h.item_key in ('n:' || n.id::text, 'n:' || coalesce(nullif(n.group_key, ''), n.id::text))
     and (
       (n.context_type = 'team_chat_channel' and n.context_id = ch)
       or (n.target_type = 'team_chat_channel' and n.target_id = ch)
       or (n.target_type = 'team_chat_message' and n.target_id = any (msg_ids))
     );
  delete from public.notification n
   where n.workspace_id = c.workspace_id
     and (
       (n.context_type = 'team_chat_channel' and n.context_id = ch)
       or (n.target_type = 'team_chat_channel' and n.target_id = ch)
       or (n.target_type = 'team_chat_message' and n.target_id = any (msg_ids))
     );

  -- The graph's links and the activity naming it or its messages.
  delete from public.entity_link l
   where l.workspace_id = c.workspace_id
     and (
       (l.source_type = 'team_chat_channel' and l.source_id = ch)
       or (l.target_type = 'team_chat_channel' and l.target_id = ch)
       or (l.source_type = 'team_chat_message' and l.source_id = any (msg_ids))
       or (l.target_type = 'team_chat_message' and l.target_id = any (msg_ids))
     );
  delete from public.entity_activity a
   where a.workspace_id = c.workspace_id
     and (
       (a.entity_type = 'team_chat_channel' and a.entity_id = ch)
       or (a.entity_type = 'team_chat_message' and a.entity_id = any (msg_ids))
     );

  -- Drive's "opened" rows for its files (709: 'team_chat:<object path>').
  delete from public.drive_file_open d
   where d.workspace_id = c.workspace_id
     and d.file_key like 'team_chat:' || ch::text || '/%';

  -- Each person's agent conversation for it (the chat's words, as context).
  delete from public.chat_conversations cc
   where cc.id in (select t.conversation_id from public.team_chat_agent_thread t where t.channel_id = ch);

  -- The files, for the app to remove from storage once this has committed.
  for objects in
    select o.bucket_id, o.name
      from storage.objects o
     where o.bucket_id in ('team-chat-files', 'team-call-recordings')
       and o.name like ch::text || '/%'
  loop
    bucket := objects.bucket_id;
    object_name := objects.name;
    return next;
  end loop;

  -- The rest goes with the conversation (474-713's on delete cascade).
  delete from public.team_chat_channel x where x.id = ch;
  return;
end;
$$;

revoke all on function public.team_chat_delete_conversation(uuid) from public, anon;
grant execute on function public.team_chat_delete_conversation(uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
