-- ============================================================
-- 556: Team chat threads: people reply to a message in a thread beside the
-- channel, one level deep.
-- ============================================================
--   team_chat_thread         per thread (its root message): how many replies,
--                            the newest reply's time and the last few people
--                            who replied (newest first, at most 5). Written
--                            by the trigger below only; read by anyone who
--                            may read the channel; live (Realtime).
--   team_chat_thread_member  who a thread is for, per member: the root's
--                            author (or, for an agent's root, its person),
--                            everyone who replied, the person whose agent
--                            replied, and everyone a reply mentions; and when
--                            they last read it. Written by the trigger and
--                            team_chat_mark_thread_read only; each member
--                            reads their own rows.
--   team_chat_message_thread_root  a reply's thread_root_id is always a root:
--                            a reply to a reply goes to the same root, and a
--                            root in another channel is refused.
--   team_chat_message_insert  474's policy, plus: a member may reply in a
--                            thread (thread_root_id, a root of the same
--                            channel). in_reply_to stays the agent's.
--   team_chat_unread         474's, counting the channel's own messages only:
--                            a thread's replies never raise the channel's
--                            count for everyone.
--   team_chat_thread_unread  per thread the caller is in: replies from
--                            others since they last read it, and how many of
--                            those mention them.
--   team_chat_mark_thread_read  a thread read up to now for the caller.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.team_chat_thread (
  root_id uuid primary key references public.team_chat_message(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  reply_count integer not null default 0 check (reply_count >= 0),
  last_reply_at timestamptz,
  participant_ids uuid[] not null default '{}' check (cardinality(participant_ids) <= 5),
  created_at timestamptz not null default now()
);
create index if not exists team_chat_thread_channel_idx on public.team_chat_thread (channel_id);
create index if not exists team_chat_thread_workspace_idx on public.team_chat_thread (workspace_id);

create table if not exists public.team_chat_thread_member (
  root_id uuid not null references public.team_chat_message(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  last_read_at timestamptz not null,
  joined_at timestamptz not null default now(),
  primary key (root_id, member_id)
);
create index if not exists team_chat_thread_member_member_idx on public.team_chat_thread_member (member_id, workspace_id);

alter table public.team_chat_thread enable row level security;
alter table public.team_chat_thread_member enable row level security;

drop policy if exists team_chat_thread_select on public.team_chat_thread;
create policy team_chat_thread_select on public.team_chat_thread
  for select to authenticated using (public.team_chat_can_read(channel_id));

-- Their own read marks only.
drop policy if exists team_chat_thread_member_select on public.team_chat_thread_member;
create policy team_chat_thread_member_select on public.team_chat_thread_member
  for select to authenticated using (member_id = public.current_member_id(workspace_id));

revoke all on table public.team_chat_thread from anon, authenticated;
revoke all on table public.team_chat_thread_member from anon, authenticated;
grant select on table public.team_chat_thread to authenticated;
grant select on table public.team_chat_thread_member to authenticated;

-- ── A reply's root ──────────────────────────────────────────────────────────

-- A reply to a reply attaches to the same root; a root the inserter can't
-- see in this channel (another channel's, or none) is refused. Runs as the
-- inserter (a member's RLS, or the service role for the agent's reply).
create or replace function public.team_chat_message_thread_root()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  parent_root uuid;
begin
  if new.thread_root_id is null then
    return new;
  end if;
  select r.thread_root_id into parent_root
    from public.team_chat_message r
   where r.id = new.thread_root_id
     and r.channel_id = new.channel_id;
  if not found then
    raise exception 'team chat: a thread reply belongs in its root''s channel' using errcode = '23514';
  end if;
  if parent_root is not null then
    new.thread_root_id := parent_root;
  end if;
  return new;
end;
$$;

drop trigger if exists team_chat_message_thread_root on public.team_chat_message;
create trigger team_chat_message_thread_root
  before insert on public.team_chat_message
  for each row execute function public.team_chat_message_thread_root();

-- 474's policy, plus: a reply in a thread whose root is in the same channel
-- (the trigger above has moved it onto the root already).
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
    and (
      thread_root_id is null
      or exists (
        select 1 from public.team_chat_message r
         where r.id = team_chat_message.thread_root_id
           and r.channel_id = team_chat_message.channel_id
           and r.thread_root_id is null
      )
    )
  );

-- ── The thread's summary and who it is for ──────────────────────────────────

create or replace function public.team_chat_thread_track()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  root public.team_chat_message%rowtype;
  replier uuid := case when new.author_kind = 'member' then new.author_member_id end;
begin
  if new.thread_root_id is null then
    return new;
  end if;
  select * into root from public.team_chat_message where id = new.thread_root_id;
  if not found then
    return new;
  end if;

  insert into public.team_chat_thread (root_id, channel_id, workspace_id, reply_count, last_reply_at, participant_ids)
  values (root.id, root.channel_id, root.workspace_id, 1, new.created_at, case when replier is null then '{}'::uuid[] else array[replier] end)
  on conflict (root_id) do update
     set reply_count = team_chat_thread.reply_count + 1,
         last_reply_at = greatest(team_chat_thread.last_reply_at, excluded.last_reply_at),
         participant_ids = case
           when replier is null then team_chat_thread.participant_ids
           else (array[replier] || array_remove(team_chat_thread.participant_ids, replier))[1:5]
         end;

  -- The root's person: its author, or the person whose agent wrote it. Unread from the root on.
  insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
  select root.id, p, root.channel_id, root.workspace_id, root.created_at
    from (select coalesce(root.author_member_id, root.agent_for_member_id) as p) x
   where p is not null
  on conflict (root_id, member_id) do nothing;

  -- Whoever replied has read it up to their reply.
  if replier is not null then
    insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
    values (root.id, replier, root.channel_id, root.workspace_id, new.created_at)
    on conflict (root_id, member_id) do update
       set last_read_at = greatest(team_chat_thread_member.last_read_at, excluded.last_read_at);
  end if;

  -- An agent's reply is for the person whose agent it is.
  if new.author_kind = 'agent' and new.agent_for_member_id is not null then
    insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
    values (root.id, new.agent_for_member_id, root.channel_id, root.workspace_id, root.created_at)
    on conflict (root_id, member_id) do nothing;
  end if;

  -- Everyone the reply mentions (members of the workspace): unread from this reply on.
  insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
  select root.id, m.id, root.channel_id, root.workspace_id, new.created_at - interval '1 millisecond'
    from public.member m
   where m.workspace_id = root.workspace_id
     and m.id = any (new.mentions)
  on conflict (root_id, member_id) do nothing;

  return new;
end;
$$;

revoke all on function public.team_chat_thread_track() from public, anon, authenticated;

drop trigger if exists team_chat_thread_track on public.team_chat_message;
create trigger team_chat_thread_track
  after insert on public.team_chat_message
  for each row execute function public.team_chat_thread_track();

-- ── Unread ──────────────────────────────────────────────────────────────────

-- 474's, counting the channel's own messages only (thread_root_id is null):
-- a thread's replies are unread only for the people in it
-- (team_chat_thread_unread).
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
     and msg.thread_root_id is null
     and msg.deleted_at is null
     and msg.created_at > coalesce(r.last_read_at, (select created_at from me))
     and not (msg.author_kind = 'member' and msg.author_member_id = (select id from me))
   where c.workspace_id = ws
     and exists (select 1 from me)
     and public.team_chat_can_read(c.id)
   group by c.id;
$$;

-- Per thread the caller is in (only those with something unread): replies
-- from others since they last read it, and how many of those mention them.
create or replace function public.team_chat_thread_unread(ws uuid)
returns table (root_id uuid, channel_id uuid, unread integer, mentions integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id from public.member m where m.workspace_id = ws and m.user_id = auth.uid() limit 1
  )
  select tm.root_id,
         tm.channel_id,
         count(msg.id)::integer,
         count(msg.id) filter (where tm.member_id = any (msg.mentions))::integer
    from public.team_chat_thread_member tm
    join public.team_chat_message msg
      on msg.thread_root_id = tm.root_id
     and msg.deleted_at is null
     and msg.created_at > tm.last_read_at
     and not (msg.author_kind = 'member' and msg.author_member_id = tm.member_id)
   where tm.workspace_id = ws
     and tm.member_id = (select id from me)
     and public.team_chat_can_read(tm.channel_id)
   group by tm.root_id, tm.channel_id;
$$;

-- A thread read up to now for the caller (nothing, when they aren't in it:
-- reading a thread never joins it).
create or replace function public.team_chat_mark_thread_read(root uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch uuid;
  ws uuid;
begin
  select m.channel_id, m.workspace_id into ch, ws
    from public.team_chat_message m
   where m.id = root
     and m.thread_root_id is null;
  if ch is null or not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such thread' using errcode = '42501';
  end if;
  update public.team_chat_thread_member
     set last_read_at = now()
   where root_id = root
     and member_id = public.current_member_id(ws);
end;
$$;

revoke all on function public.team_chat_unread(uuid) from public, anon;
revoke all on function public.team_chat_thread_unread(uuid) from public, anon;
revoke all on function public.team_chat_mark_thread_read(uuid) from public, anon;
grant execute on function public.team_chat_unread(uuid) to authenticated;
grant execute on function public.team_chat_thread_unread(uuid) to authenticated;
grant execute on function public.team_chat_mark_thread_read(uuid) to authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_thread') then
      alter publication supabase_realtime add table public.team_chat_thread;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
