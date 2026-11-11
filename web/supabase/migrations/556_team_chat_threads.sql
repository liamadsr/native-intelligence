-- ============================================================
-- 556: Team chat threads: people reply to a message in a thread beside the
-- channel, one level deep.
-- ============================================================
--   team_chat_thread         per thread (its root message): how many replies,
--                            the newest reply's time and the last few people
--                            who replied (newest first, at most 5), counting
--                            the replies not deleted (recomputed on every
--                            reply and every delete of one). Written by the
--                            trigger below only; read by anyone who may read
--                            the channel; live (Realtime).
--   team_chat_thread_member  who a thread is for, per member: the root's
--                            author (or, for an agent's root, its person),
--                            everyone who replied, the person whose agent
--                            replied, and everyone a reply mentions (when it
--                            is posted, or added by an edit); and when they
--                            last read it. Only members who may read the
--                            channel (team_chat_member_can_read). Written by
--                            the trigger and team_chat_mark_thread_read only;
--                            each member reads their own rows.
--   team_chat_member_can_read  team_chat_can_read for a given member rather
--                            than the caller (the trigger's question about
--                            the people a reply mentions). Not callable by
--                            clients.
--   team_chat_touch_channel  474's, but a thread's reply leaves the channel's
--                            last_message_at alone: a channel never jumps to
--                            the top of the list with nothing unread in it.
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

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

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

-- team_chat_can_read for a given member, not the caller: a member of the
-- channel's workspace and, for a team channel, of the team; for a DM, one of
-- its members. For the trigger below (who a reply's mention may bring into a
-- thread); no client calls it.
create or replace function public.team_chat_member_can_read(ch uuid, mem uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.team_chat_channel c
      join public.member m on m.id = mem and m.workspace_id = c.workspace_id
     where c.id = ch
       and (
         (c.kind = 'channel' and (c.team_id is null or exists (select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = mem)))
         or (c.kind = 'dm' and exists (select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = mem))
       )
  );
$$;

revoke all on function public.team_chat_member_can_read(uuid, uuid) from public, anon, authenticated;

-- A thread's summary from its replies as they are now (not deleted): how
-- many, the newest one's time, and the last five members who replied,
-- newest first. No reply left: a count of 0 (the bar draws nothing), kept as
-- an UPDATE, which Realtime filters by the policy, never a DELETE.
create or replace function public.team_chat_thread_refresh(root uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch uuid;
  ws uuid;
  n integer;
  newest timestamptz;
  people uuid[];
begin
  select m.channel_id, m.workspace_id into ch, ws from public.team_chat_message m where m.id = root;
  if ch is null then
    return;
  end if;
  select count(*)::integer, max(created_at) into n, newest
    from public.team_chat_message
   where thread_root_id = root and deleted_at is null;
  select coalesce(array_agg(a.author_member_id order by a.latest desc), '{}') into people
    from (
      select author_member_id, max(created_at) as latest
        from public.team_chat_message
       where thread_root_id = root and deleted_at is null and author_kind = 'member' and author_member_id is not null
       group by author_member_id
       order by latest desc
       limit 5
    ) a;
  insert into public.team_chat_thread (root_id, channel_id, workspace_id, reply_count, last_reply_at, participant_ids)
  values (root, ch, ws, n, newest, people)
  on conflict (root_id) do update
     set reply_count = excluded.reply_count,
         last_reply_at = excluded.last_reply_at,
         participant_ids = excluded.participant_ids;
end;
$$;

revoke all on function public.team_chat_thread_refresh(uuid) from public, anon, authenticated;

-- After a reply is posted, deleted, or edited to mention someone new: the
-- summary again, and who the thread is for.
create or replace function public.team_chat_thread_track()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  root public.team_chat_message%rowtype;
  replier uuid := case when new.author_kind = 'member' then new.author_member_id end;
  added uuid[];
begin
  if new.thread_root_id is null then
    return new;
  end if;
  select * into root from public.team_chat_message where id = new.thread_root_id;
  if not found then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- A reply deleted: the summary without it.
    if old.deleted_at is null and new.deleted_at is not null then
      perform public.team_chat_thread_refresh(root.id);
      return new;
    end if;
    -- An edit that mentions someone new brings them in, from this reply on.
    if new.deleted_at is null then
      select coalesce(array_agg(x), '{}') into added from unnest(new.mentions) x where not (x = any (old.mentions));
      if cardinality(added) > 0 then
        insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
        select root.id, m.id, root.channel_id, root.workspace_id, new.created_at - interval '1 millisecond'
          from public.member m
         where m.workspace_id = root.workspace_id
           and m.id = any (added)
           and public.team_chat_member_can_read(root.channel_id, m.id)
        on conflict (root_id, member_id) do nothing;
      end if;
    end if;
    return new;
  end if;

  perform public.team_chat_thread_refresh(root.id);

  -- The root's person: its author, or the person whose agent wrote it. Unread from the root on.
  insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
  select root.id, p, root.channel_id, root.workspace_id, root.created_at
    from (select coalesce(root.author_member_id, root.agent_for_member_id) as p) x
   where p is not null
     and public.team_chat_member_can_read(root.channel_id, p)
  on conflict (root_id, member_id) do nothing;

  -- Whoever replied has read it up to their reply.
  if replier is not null then
    insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
    values (root.id, replier, root.channel_id, root.workspace_id, new.created_at)
    on conflict (root_id, member_id) do update
       set last_read_at = greatest(team_chat_thread_member.last_read_at, excluded.last_read_at);
  end if;

  -- An agent's reply is for the person whose agent it is.
  if new.author_kind = 'agent' and new.agent_for_member_id is not null and public.team_chat_member_can_read(root.channel_id, new.agent_for_member_id) then
    insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
    values (root.id, new.agent_for_member_id, root.channel_id, root.workspace_id, root.created_at)
    on conflict (root_id, member_id) do nothing;
  end if;

  -- Everyone the reply mentions who may read the channel: unread from this reply on.
  insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at)
  select root.id, m.id, root.channel_id, root.workspace_id, new.created_at - interval '1 millisecond'
    from public.member m
   where m.workspace_id = root.workspace_id
     and m.id = any (new.mentions)
     and public.team_chat_member_can_read(root.channel_id, m.id)
  on conflict (root_id, member_id) do nothing;

  return new;
end;
$$;

revoke all on function public.team_chat_thread_track() from public, anon, authenticated;

drop trigger if exists team_chat_thread_track on public.team_chat_message;
create trigger team_chat_thread_track
  after insert on public.team_chat_message
  for each row execute function public.team_chat_thread_track();

drop trigger if exists team_chat_thread_track_update on public.team_chat_message;
create trigger team_chat_thread_track_update
  after update of deleted_at, mentions on public.team_chat_message
  for each row
  when (new.thread_root_id is not null)
  execute function public.team_chat_thread_track();

-- 474's, except a thread's reply: only the channel's own messages move it up the list.
create or replace function public.team_chat_touch_channel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.thread_root_id is not null then
    return new;
  end if;
  update public.team_chat_channel
     set last_message_at = new.created_at
   where id = new.channel_id
     and (last_message_at is null or last_message_at < new.created_at);
  return new;
end;
$$;

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

commit;
