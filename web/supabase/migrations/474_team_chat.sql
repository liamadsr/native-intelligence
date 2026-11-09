-- ============================================================
-- 474: Team chat (roadmap #7, first slice): channels and direct messages
-- inside a workspace, with the agent as a member of the team.
-- ============================================================
--   team_chat_channel        a channel (open to the whole workspace, or to one
--                            team's members when team_id is set) or a DM
--                            (between the members in team_chat_member; its
--                            dm_key is their sorted member ids, so a pair has
--                            one DM).
--   team_chat_member         per member and channel: when they last read it
--                            (unread counts). For a DM it is also who may
--                            read it. Never written by a client: the
--                            functions below write it (channels and DMs are
--                            created through them too).
--   team_chat_message        a message: a member's (author_member_id) or a
--                            member's agent's (author_kind 'agent',
--                            agent_for_member_id, written by the service
--                            role only). mentions holds member ids;
--                            mentions_agent says the author called on their
--                            own agent. Edit and delete are the author's own
--                            (a delete is soft: the words are cleared); a
--                            member may also delete their agent's reply.
--                            created_at is always the server's.
--   team_chat_agent_thread   per channel and person: the person's own
--                            conversation (outside_channel 'team_chat') the
--                            agent's turns for that channel run in. Service
--                            role only.
--   home_turn.reason         may now be 'team_chat' (456's list plus it).
--   chat_conversations.outside_channel may now be 'team_chat' (437's rule
--                            plus it: never the home thread, never a guest's).
--
-- Reads are RLS: only a member of the workspace (and, for a team channel, of
-- the team; for a DM, one of its two members) reads a channel or its
-- messages. Realtime publishes team_chat_message and team_chat_channel,
-- filtered by the same policies.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.team_chat_channel (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  team_id uuid references public.team(id) on delete cascade,
  kind text not null check (kind in ('channel', 'dm')),
  name text,
  topic text check (topic is null or char_length(topic) <= 250),
  dm_key text,
  created_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at timestamptz,
  constraint team_chat_channel_shape check (
    (kind = 'channel' and name is not null and char_length(name) between 1 and 80 and dm_key is null)
    or (kind = 'dm' and dm_key is not null and name is null and team_id is null)
  )
);

create unique index if not exists team_chat_channel_name_key
  on public.team_chat_channel (workspace_id, lower(name))
  where kind = 'channel' and archived_at is null;
create unique index if not exists team_chat_channel_dm_key
  on public.team_chat_channel (workspace_id, dm_key)
  where kind = 'dm';
create index if not exists team_chat_channel_workspace_idx
  on public.team_chat_channel (workspace_id, last_message_at desc nulls last);

create table if not exists public.team_chat_member (
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (channel_id, member_id)
);
create index if not exists team_chat_member_member_idx on public.team_chat_member (member_id);

create table if not exists public.team_chat_message (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  author_kind text not null default 'member' check (author_kind in ('member', 'agent')),
  author_member_id uuid references public.member(id) on delete set null,
  agent_for_member_id uuid references public.member(id) on delete set null,
  agent_name text check (agent_name is null or char_length(agent_name) <= 60),
  in_reply_to uuid references public.team_chat_message(id) on delete set null,
  body text not null,
  mentions uuid[] not null default '{}',
  mentions_agent boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint team_chat_message_body check (deleted_at is not null or char_length(body) between 1 and 8000),
  constraint team_chat_message_mentions check (cardinality(mentions) <= 50),
  constraint team_chat_message_author check (
    (author_kind = 'member' and agent_name is null)
    or (author_kind = 'agent' and author_member_id is null and agent_name is not null)
  )
);
create index if not exists team_chat_message_channel_idx on public.team_chat_message (channel_id, created_at desc);
create index if not exists team_chat_message_mentions_idx on public.team_chat_message using gin (mentions);

create table if not exists public.team_chat_agent_thread (
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  conversation_id uuid not null unique references public.chat_conversations(id) on delete cascade,
  last_mention_message_id uuid references public.team_chat_message(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

-- ── Who may read a channel ──────────────────────────────────────────────────

-- True when the caller may read this channel: a member of its workspace and,
-- for a team channel, of the team; for a DM, one of its members. Archived
-- channels stay readable.
create or replace function public.team_chat_can_read(ch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.team_chat_channel c
     where c.id = ch
       and public.is_workspace_member(c.workspace_id)
       and (
         (c.kind = 'channel' and (c.team_id is null or public.is_team_member(c.team_id)))
         or (
           c.kind = 'dm'
           and exists (
             select 1 from public.team_chat_member tm
              where tm.channel_id = c.id
                and tm.member_id = public.current_member_id(c.workspace_id)
           )
         )
       )
  );
$$;

-- True when the caller may post: may read, and it is not archived.
create or replace function public.team_chat_can_post(ch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.team_chat_can_read(ch)
     and exists (select 1 from public.team_chat_channel c where c.id = ch and c.archived_at is null);
$$;

revoke all on function public.team_chat_can_read(uuid) from public, anon;
revoke all on function public.team_chat_can_post(uuid) from public, anon;
grant execute on function public.team_chat_can_read(uuid) to authenticated, service_role;
grant execute on function public.team_chat_can_post(uuid) to authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.team_chat_channel enable row level security;
alter table public.team_chat_member enable row level security;
alter table public.team_chat_message enable row level security;
alter table public.team_chat_agent_thread enable row level security;

drop policy if exists team_chat_channel_select on public.team_chat_channel;
create policy team_chat_channel_select on public.team_chat_channel
  for select to authenticated using (public.team_chat_can_read(id));

-- Their own read marks only (written by team_chat_mark_read / team_chat_open_dm).
drop policy if exists team_chat_member_select on public.team_chat_member;
create policy team_chat_member_select on public.team_chat_member
  for select to authenticated using (member_id = public.current_member_id(workspace_id));

drop policy if exists team_chat_message_select on public.team_chat_message;
create policy team_chat_message_select on public.team_chat_message
  for select to authenticated using (public.team_chat_can_read(channel_id));

-- A member posts as themselves, in a channel they may post in. The agent's
-- replies are the service role's.
drop policy if exists team_chat_message_insert on public.team_chat_message;
create policy team_chat_message_insert on public.team_chat_message
  for insert to authenticated with check (
    author_kind = 'member'
    and author_member_id = public.current_member_id(workspace_id)
    and agent_for_member_id is null
    and in_reply_to is null
    and edited_at is null
    and deleted_at is null
    and public.team_chat_can_post(channel_id)
    and exists (select 1 from public.team_chat_channel c where c.id = channel_id and c.workspace_id = team_chat_message.workspace_id)
  );

-- Edit and delete: the author's own messages only, and delete (never edit)
-- their own agent's replies (the guard below keeps everything else as it
-- was).
drop policy if exists team_chat_message_update on public.team_chat_message;
create policy team_chat_message_update on public.team_chat_message
  for update to authenticated
  using (
    deleted_at is null
    and (
      (author_kind = 'member' and author_member_id = public.current_member_id(workspace_id))
      or (author_kind = 'agent' and agent_for_member_id = public.current_member_id(workspace_id))
    )
  )
  with check (
    (author_kind = 'member' and author_member_id = public.current_member_id(workspace_id))
    or (author_kind = 'agent' and agent_for_member_id = public.current_member_id(workspace_id))
  );

revoke all on table public.team_chat_channel from anon, authenticated;
revoke all on table public.team_chat_member from anon, authenticated;
revoke all on table public.team_chat_message from anon, authenticated;
revoke all on table public.team_chat_agent_thread from anon, authenticated;
grant select on table public.team_chat_channel to authenticated;
grant select on table public.team_chat_member to authenticated;
grant select, insert, update on table public.team_chat_message to authenticated;

-- ── Guards ──────────────────────────────────────────────────────────────────

-- A member's update changes only the words (and their mentions) or deletes
-- the message; a delete clears the words. edited_at is stamped here. Their
-- agent's reply can only be deleted.
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
     or new.created_at is distinct from old.created_at then
    raise exception 'team chat: only the words of a message can change' using errcode = '42501';
  end if;
  if old.author_kind = 'agent' and new.deleted_at is null then
    raise exception 'team chat: an agent''s reply can only be deleted' using errcode = '42501';
  end if;
  if new.deleted_at is not null then
    new.body := '';
    new.mentions := '{}';
    new.mentions_agent := false;
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body or new.mentions is distinct from old.mentions then
    new.edited_at := now();
    new.mentions_agent := old.mentions_agent;
  else
    new.edited_at := old.edited_at;
    new.mentions_agent := old.mentions_agent;
  end if;
  return new;
end;
$$;

drop trigger if exists team_chat_message_guard on public.team_chat_message;
create trigger team_chat_message_guard
  before update on public.team_chat_message
  for each row execute function public.team_chat_message_guard();

-- A member's insert: the server's clock, never the client's (a future
-- created_at would stay unread for everyone, top the list and steer which
-- messages the agent reads), and never already edited or deleted.
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
  return new;
end;
$$;

drop trigger if exists team_chat_message_insert_guard on public.team_chat_message;
create trigger team_chat_message_insert_guard
  before insert on public.team_chat_message
  for each row execute function public.team_chat_message_insert_guard();

-- A channel's newest message time (the list's order).
create or replace function public.team_chat_touch_channel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.team_chat_channel
     set last_message_at = new.created_at
   where id = new.channel_id
     and (last_message_at is null or last_message_at < new.created_at);
  return new;
end;
$$;

drop trigger if exists team_chat_touch_channel on public.team_chat_message;
create trigger team_chat_touch_channel
  after insert on public.team_chat_message
  for each row execute function public.team_chat_touch_channel();

-- ── Functions the app calls as the person ───────────────────────────────────

-- Create a channel as the caller: for the whole workspace, or for a team they
-- are in. Returns its id. A name already taken (ignoring case) is 23505.
create or replace function public.team_chat_create_channel(ws uuid, channel_name text, channel_team uuid, channel_topic text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := public.current_member_id(ws);
  ch uuid;
begin
  if me is null then
    raise exception 'team chat: not a member of this workspace' using errcode = '42501';
  end if;
  if channel_team is not null and not (
    public.is_team_member(channel_team)
    and exists (select 1 from public.team t where t.id = channel_team and t.workspace_id = ws)
  ) then
    raise exception 'team chat: not a member of that team' using errcode = '42501';
  end if;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, topic, created_by)
  values (ws, channel_team, 'channel', channel_name, nullif(channel_topic, ''), me)
  returning id into ch;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch, me, ws);
  return ch;
end;
$$;

-- Open (or find) the DM between the caller and another member of the
-- workspace (themselves: a note to self). Returns its id.
create or replace function public.team_chat_open_dm(ws uuid, other_member uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := public.current_member_id(ws);
  key text;
  ch uuid;
begin
  if me is null then
    raise exception 'team chat: not a member of this workspace' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member m where m.id = other_member and m.workspace_id = ws) then
    raise exception 'team chat: that person is not in this workspace' using errcode = '22023';
  end if;
  key := case when me = other_member then me::text
              when me::text < other_member::text then me::text || ':' || other_member::text
              else other_member::text || ':' || me::text end;
  select id into ch from public.team_chat_channel where workspace_id = ws and kind = 'dm' and dm_key = key;
  if ch is null then
    insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
    values (ws, 'dm', key, me)
    on conflict (workspace_id, dm_key) where kind = 'dm' do nothing
    returning id into ch;
    if ch is null then
      select id into ch from public.team_chat_channel where workspace_id = ws and kind = 'dm' and dm_key = key;
    end if;
  end if;
  insert into public.team_chat_member (channel_id, member_id, workspace_id)
  values (ch, me, ws), (ch, other_member, ws)
  on conflict (channel_id, member_id) do nothing;
  return ch;
end;
$$;

-- Mark a channel read up to now for the caller.
create or replace function public.team_chat_mark_read(ch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  me uuid;
begin
  if not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  select workspace_id into ws from public.team_chat_channel where id = ch;
  me := public.current_member_id(ws);
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at)
  values (ch, me, ws, now())
  on conflict (channel_id, member_id) do update set last_read_at = excluded.last_read_at;
end;
$$;

-- Per channel the caller may read: messages from others since they last read
-- it (never read: since they joined the workspace), and how many of those
-- mention them.
create or replace function public.team_chat_unread(ws uuid)
returns table (channel_id uuid, unread integer, mentions integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.created_at from public.member m where m.workspace_id = ws and m.user_id = auth.uid() limit 1
  )
  select c.id,
         count(msg.id)::integer,
         count(msg.id) filter (where (select id from me) = any (msg.mentions))::integer
    from public.team_chat_channel c
    left join public.team_chat_member r on r.channel_id = c.id and r.member_id = (select id from me)
    left join public.team_chat_message msg
      on msg.channel_id = c.id
     and msg.deleted_at is null
     and msg.created_at > coalesce(r.last_read_at, (select created_at from me))
     and not (msg.author_kind = 'member' and msg.author_member_id = (select id from me))
   where c.workspace_id = ws
     and exists (select 1 from me)
     and public.team_chat_can_read(c.id)
   group by c.id;
$$;

revoke all on function public.team_chat_create_channel(uuid, text, uuid, text) from public, anon;
revoke all on function public.team_chat_open_dm(uuid, uuid) from public, anon;
revoke all on function public.team_chat_mark_read(uuid) from public, anon;
revoke all on function public.team_chat_unread(uuid) from public, anon;
grant execute on function public.team_chat_create_channel(uuid, text, uuid, text) to authenticated;
grant execute on function public.team_chat_open_dm(uuid, uuid) to authenticated;
grant execute on function public.team_chat_mark_read(uuid) to authenticated;
grant execute on function public.team_chat_unread(uuid) to authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_message') then
      alter publication supabase_realtime add table public.team_chat_message;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_channel') then
      alter publication supabase_realtime add table public.team_chat_channel;
    end if;
  end if;
end $$;

-- ── The agent's turns ───────────────────────────────────────────────────────

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval', 'call', 'team_chat'));

alter table public.chat_conversations drop constraint if exists chat_conversations_outside_channel_check;
alter table public.chat_conversations
  add constraint chat_conversations_outside_channel_check
  check (
    outside_channel is null
    or (
      is_home is null
      and (
        outside_channel = 'slack'
        or (outside_channel = 'team_chat' and agent_guest_id is null)
        or (outside_channel in ('sms', 'dial8') and agent_guest_id is not null)
      )
    )
  );

comment on column public.chat_conversations.outside_channel is
  'Slack (414): set on a person''s conversation for one Slack channel thread (slack_thread). SMS (428) and dial8 (437, another Dial8 user''s agent): set on a guest''s own thread. Team chat (474): a person''s conversation for one team chat channel (team_chat_agent_thread). Never on the home thread. A channel turn may send into it.';
