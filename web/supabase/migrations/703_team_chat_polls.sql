-- ============================================================
-- 703: Polls in a channel (docs/plans/channels-inbox.md, phase 3).
-- ============================================================
-- A poll is a message: its words are "Poll: <question>" (search, the thread
-- and its notifications read them), it carries the poll's id, and the poll's
-- own rows say the rest. Anyone who may post in the channel votes, one option
-- or several when it allows that; its author closes it, and a closing time
-- closes it by itself. Anonymous: no function returns who chose what, to
-- anyone, the author included.
--
--   team_chat_poll    one per poll message (message_id, unique): its
--                     question, one choice or several, anonymous or not, when
--                     it closes, when it was closed and by whom, who made it
--                     (created_by: the member, or whose agent posted it, with
--                     by_agent), and its tally (option id -> votes) and
--                     voters (people who voted), rewritten by every vote so
--                     Realtime carries each change. RLS: read by whoever may
--                     read the channel (team_chat_can_read, 474/572); someone
--                     who leaves the channel (its team, the workspace) stops
--                     reading it, and stops getting its Realtime changes.
--   team_chat_poll_option  2 to 10 per poll (position 0-9, unique per poll),
--                     each 1-120 characters. RLS: as its poll.
--   team_chat_poll_vote  one row per option a member chose, (poll, option,
--                     member) unique; the option must be the poll's own
--                     (a composite foreign key). RLS: a member reads only
--                     their OWN votes. team_chat_poll_vote_guard (every
--                     writer, the service role too): no vote on a closed
--                     poll or one past its closing time, and on a
--                     one-choice poll at most one option per member.
--   team_chat_message.poll_id  the poll the message is (null for any other
--                     message). A deferred foreign key, so a message and its
--                     poll are written in one go. team_chat_message_poll_guard
--                     (every writer): it never changes after the insert, a
--                     client never sets it, and a poll's words are never
--                     edited (it can be deleted). team_chat_message_poll_check
--                     (deferred, at commit): it names a poll of the SAME
--                     channel whose message is this one.
--                     team_chat_message_poll_close: deleting the message
--                     closes its poll (every read then refuses it).
--
-- Functions (security definer, search_path pinned, names schema-qualified):
--   team_chat_poll_create(ch, question, options, multiple, anonymous,
--                     closes_at, thread_root, client)  as the caller, who
--                     must be able to post there (team_chat_can_post): the
--                     message, the poll and its options at once; a replay of
--                     the same client id answers the first. Authenticated only.
--   team_chat_poll_create_for_agent(mem, agent, ch, ...)  the same, as the
--                     member's agent (the agent tool, after the person's
--                     card). The member is named explicitly and must be able
--                     to post there themselves (team_chat_member_can_read,
--                     572, and the channel not archived), so the agent never
--                     posts where its person could not. Service role only.
--   team_chat_poll_vote(poll, option_ids)  the caller's whole answer
--                     (none: their vote taken back), under the poll's lock;
--                     they must be able to post in the channel; the tally is
--                     rewritten. Returns the poll as team_chat_poll_read does.
--   team_chat_poll_close(poll)  its creator only (the member, or whose
--                     agent posted it); no admin override. Closing a closed
--                     poll answers it as it is.
--   team_chat_poll_read(poll)  as the caller, who must be able to read the
--                     channel: the counts, their own choices, whether they
--                     may close it, and who chose what only when it is not
--                     anonymous.
--
-- No notification type or target type is added or changed.
--
-- Additive. Idempotent. Safe on a live database. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.team_chat_poll (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  message_id uuid not null unique references public.team_chat_message(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 300),
  multiple boolean not null default false,
  anonymous boolean not null default false,
  closes_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.member(id) on delete set null,
  created_by uuid references public.member(id) on delete set null,
  by_agent boolean not null default false,
  created_at timestamptz not null default now(),
  tally jsonb not null default '{}'::jsonb,
  voters integer not null default 0 check (voters >= 0),
  constraint team_chat_poll_closes check (closes_at is null or (closes_at > created_at and closes_at <= created_at + interval '90 days'))
);

create index if not exists team_chat_poll_channel on public.team_chat_poll (channel_id);

create table if not exists public.team_chat_poll_option (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.team_chat_poll(id) on delete cascade,
  position smallint not null check (position between 0 and 9),
  label text not null check (char_length(label) between 1 and 120),
  unique (poll_id, position),
  unique (id, poll_id)
);

create table if not exists public.team_chat_poll_vote (
  poll_id uuid not null references public.team_chat_poll(id) on delete cascade,
  option_id uuid not null,
  member_id uuid not null references public.member(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, option_id, member_id),
  constraint team_chat_poll_vote_option foreign key (option_id, poll_id) references public.team_chat_poll_option(id, poll_id) on delete cascade
);

create index if not exists team_chat_poll_vote_member on public.team_chat_poll_vote (member_id, poll_id);

comment on table public.team_chat_poll is
  'A poll in team chat (703): one per poll message. Read by whoever may read the channel; written only by 703''s functions.';
comment on table public.team_chat_poll_vote is
  'A member''s choice on a poll (703). Each member reads only their own; written only by team_chat_poll_vote.';

alter table public.team_chat_message
  add column if not exists poll_id uuid;

alter table public.team_chat_message drop constraint if exists team_chat_message_poll_id_fkey;
alter table public.team_chat_message
  add constraint team_chat_message_poll_id_fkey foreign key (poll_id) references public.team_chat_poll(id) deferrable initially deferred;

create unique index if not exists team_chat_message_poll on public.team_chat_message (poll_id) where poll_id is not null;

comment on column public.team_chat_message.poll_id is
  'The poll this message is (703): drawn as its card. Set only when the message is written by 703''s functions; never changes.';

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.team_chat_poll enable row level security;
alter table public.team_chat_poll_option enable row level security;
alter table public.team_chat_poll_vote enable row level security;

drop policy if exists team_chat_poll_select on public.team_chat_poll;
create policy team_chat_poll_select on public.team_chat_poll
  for select to authenticated
  using (public.team_chat_can_read(channel_id));

drop policy if exists team_chat_poll_option_select on public.team_chat_poll_option;
create policy team_chat_poll_option_select on public.team_chat_poll_option
  for select to authenticated
  using (exists (select 1 from public.team_chat_poll p where p.id = poll_id and public.team_chat_can_read(p.channel_id)));

drop policy if exists team_chat_poll_vote_select on public.team_chat_poll_vote;
create policy team_chat_poll_vote_select on public.team_chat_poll_vote
  for select to authenticated
  using (member_id = public.current_member_id(workspace_id));

-- Reads only for people; every write is a function's.
revoke all on table public.team_chat_poll, public.team_chat_poll_option, public.team_chat_poll_vote from public, anon, authenticated;
grant select on table public.team_chat_poll, public.team_chat_poll_option, public.team_chat_poll_vote to authenticated;
grant all on table public.team_chat_poll, public.team_chat_poll_option, public.team_chat_poll_vote to service_role;

-- ── Guards ──────────────────────────────────────────────────────────────────

-- A message's poll: set only by 703's functions, never changed, its words never edited.
create or replace function public.team_chat_message_poll_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.poll_id is not null and coalesce(current_setting('team_chat_polls.writing', true), '') <> 'on' then
      raise exception 'team chat: a poll is posted through its own function' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.poll_id is distinct from old.poll_id then
    raise exception 'team chat: a message''s poll never changes' using errcode = '42501';
  end if;
  if old.poll_id is not null and new.deleted_at is null and new.body is distinct from old.body then
    raise exception 'team chat: a poll''s words are not edited' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.team_chat_message_poll_guard() from public, anon, authenticated;

drop trigger if exists team_chat_message_poll_guard on public.team_chat_message;
create trigger team_chat_message_poll_guard
  before insert or update on public.team_chat_message
  for each row execute function public.team_chat_message_poll_guard();

-- At commit: the poll a message names is of its channel, and is this message's.
create or replace function public.team_chat_message_poll_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.poll_id is not null and not exists (
    select 1 from public.team_chat_poll p
     where p.id = new.poll_id
       and p.message_id = new.id
       and p.channel_id = new.channel_id
       and p.workspace_id = new.workspace_id
  ) then
    raise exception 'team chat: a message''s poll is its own, in its channel' using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function public.team_chat_message_poll_check() from public, anon, authenticated;

drop trigger if exists team_chat_message_poll_check on public.team_chat_message;
create constraint trigger team_chat_message_poll_check
  after insert or update of poll_id on public.team_chat_message
  deferrable initially deferred
  for each row execute function public.team_chat_message_poll_check();

-- Deleting a poll's message closes the poll.
create or replace function public.team_chat_message_poll_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.poll_id is not null and new.deleted_at is not null and old.deleted_at is null then
    update public.team_chat_poll set closed_at = coalesce(closed_at, now()) where id = new.poll_id;
  end if;
  return null;
end;
$$;

revoke all on function public.team_chat_message_poll_close() from public, anon, authenticated;

drop trigger if exists team_chat_message_poll_close on public.team_chat_message;
create trigger team_chat_message_poll_close
  after update of deleted_at on public.team_chat_message
  for each row execute function public.team_chat_message_poll_close();

-- Every vote, whoever writes it: the poll is open, and one option per member when it is one choice.
create or replace function public.team_chat_poll_vote_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.team_chat_poll;
begin
  select * into p from public.team_chat_poll where id = new.poll_id;
  if not found then
    raise exception 'team chat: no such poll' using errcode = '23503';
  end if;
  if p.closed_at is not null or (p.closes_at is not null and p.closes_at <= now()) then
    raise exception 'team chat: this poll is closed' using errcode = '22023';
  end if;
  if new.workspace_id is distinct from p.workspace_id then
    raise exception 'team chat: a vote is in its poll''s workspace' using errcode = '23514';
  end if;
  if not p.multiple and exists (
    select 1 from public.team_chat_poll_vote v
     where v.poll_id = new.poll_id and v.member_id = new.member_id and v.option_id <> new.option_id
  ) then
    raise exception 'team chat: this poll takes one choice' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.team_chat_poll_vote_guard() from public, anon, authenticated;

drop trigger if exists team_chat_poll_vote_guard on public.team_chat_poll_vote;
create trigger team_chat_poll_vote_guard
  before insert or update on public.team_chat_poll_vote
  for each row execute function public.team_chat_poll_vote_guard();

-- ── Writing a poll (internal: only the two functions below call it) ────────

create or replace function public.team_chat_poll_write(
  mem uuid, as_agent boolean, agent text, ch uuid, question text, options text[],
  multiple boolean, anonymous boolean, closes_at timestamptz, thread_root uuid, client uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  q text := btrim(coalesce(question, ''));
  opts text[];
  n integer;
  pid uuid := gen_random_uuid();
  mid uuid;
  done record;
begin
  select c.workspace_id into ws from public.team_chat_channel c where c.id = ch;
  if ws is null then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  if char_length(q) < 1 or char_length(q) > 300 then
    raise exception 'team chat: a poll asks a question of up to 300 characters' using errcode = '22023';
  end if;
  select array_agg(btrim(o) order by i) into opts
    from unnest(coalesce(options, '{}'::text[])) with ordinality as t(o, i)
   where btrim(o) <> '';
  n := coalesce(array_length(opts, 1), 0);
  if n < 2 or n > 10 then
    raise exception 'team chat: a poll has 2 to 10 options' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(opts) o where char_length(o) > 120) then
    raise exception 'team chat: an option is at most 120 characters' using errcode = '22023';
  end if;
  if (select count(distinct lower(o)) from unnest(opts) o) <> n then
    raise exception 'team chat: an option is in the list twice' using errcode = '22023';
  end if;
  if closes_at is not null and (closes_at <= now() or closes_at > now() + interval '90 days') then
    raise exception 'team chat: a poll closes within 90 days' using errcode = '22023';
  end if;
  if as_agent and (agent is null or btrim(agent) = '') then
    raise exception 'team chat: an agent''s poll has its name' using errcode = '22023';
  end if;
  -- A retried send of the person's own poll answers the first.
  if not as_agent and client is not null then
    select x.id, x.poll_id into done
      from public.team_chat_message x
     where x.author_member_id = mem and x.client_id = client;
    if found then
      if done.poll_id is null then
        raise exception 'team chat: that send id was used for another message' using errcode = '22023';
      end if;
      return jsonb_build_object('message_id', done.id, 'poll_id', done.poll_id);
    end if;
  end if;

  perform set_config('team_chat_polls.writing', 'on', true);
  insert into public.team_chat_message (
    channel_id, workspace_id, author_kind, author_member_id, agent_for_member_id, agent_name,
    thread_root_id, client_id, body, mentions, mentions_agent, poll_id
  ) values (
    ch, ws,
    case when as_agent then 'agent' else 'member' end,
    case when as_agent then null else mem end,
    case when as_agent then mem else null end,
    case when as_agent then left(btrim(agent), 60) else null end,
    thread_root,
    case when as_agent then null else client end,
    'Poll: ' || q, '{}', false, pid
  )
  returning id into mid;
  perform set_config('team_chat_polls.writing', '', true);

  insert into public.team_chat_poll (id, workspace_id, channel_id, message_id, question, multiple, anonymous, closes_at, created_by, by_agent)
  values (pid, ws, ch, mid, q, coalesce(multiple, false), coalesce(anonymous, false), closes_at, mem, as_agent);
  insert into public.team_chat_poll_option (poll_id, position, label)
  select pid, (i - 1)::smallint, o from unnest(opts) with ordinality as t(o, i);

  return jsonb_build_object('message_id', mid, 'poll_id', pid);
end;
$$;

revoke all on function public.team_chat_poll_write(uuid, boolean, text, uuid, text, text[], boolean, boolean, timestamptz, uuid, uuid) from public, anon, authenticated, service_role;

-- As the caller, who must be able to post in the channel.
create or replace function public.team_chat_poll_create(
  ch uuid, question text, options text[], multiple boolean, anonymous boolean,
  closes_at timestamptz, thread_root uuid default null, client uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  me uuid;
begin
  if not public.team_chat_can_post(ch) then
    raise exception 'team chat: no posting here' using errcode = '42501';
  end if;
  select c.workspace_id into ws from public.team_chat_channel c where c.id = ch;
  me := public.current_member_id(ws);
  if me is null then
    raise exception 'team chat: no posting here' using errcode = '42501';
  end if;
  return public.team_chat_poll_write(me, false, null, ch, question, options, multiple, anonymous, closes_at, thread_root, client);
end;
$$;

revoke all on function public.team_chat_poll_create(uuid, text, text[], boolean, boolean, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.team_chat_poll_create(uuid, text, text[], boolean, boolean, timestamptz, uuid, uuid) to authenticated;

-- As the member's agent (the service role, after the person's card): only where the member may post.
create or replace function public.team_chat_poll_create_for_agent(
  mem uuid, agent text, ch uuid, question text, options text[], multiple boolean, anonymous boolean,
  closes_at timestamptz, thread_root uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if mem is null
     or not exists (
       select 1 from public.team_chat_channel c
         join public.member m on m.id = mem and m.workspace_id = c.workspace_id
        where c.id = ch and c.archived_at is null
     )
     or not public.team_chat_member_can_read(ch, mem) then
    raise exception 'team chat: no posting here' using errcode = '42501';
  end if;
  return public.team_chat_poll_write(mem, true, agent, ch, question, options, multiple, anonymous, closes_at, thread_root, null);
end;
$$;

revoke all on function public.team_chat_poll_create_for_agent(uuid, text, uuid, text, text[], boolean, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.team_chat_poll_create_for_agent(uuid, text, uuid, text, text[], boolean, boolean, timestamptz, uuid) to service_role;

-- ── Reading, voting, closing ────────────────────────────────────────────────

-- The poll as the caller sees it; null when it isn't there (or its message is deleted).
create or replace function public.team_chat_poll_read(poll uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p public.team_chat_poll;
  me uuid;
begin
  select * into p from public.team_chat_poll where id = poll;
  if not found or exists (select 1 from public.team_chat_message x where x.id = p.message_id and x.deleted_at is not null) then
    return null;
  end if;
  if not public.team_chat_can_read(p.channel_id) then
    raise exception 'team chat: no such poll' using errcode = '42501';
  end if;
  me := public.current_member_id(p.workspace_id);
  return jsonb_build_object(
    'id', p.id,
    'channel_id', p.channel_id,
    'message_id', p.message_id,
    'question', p.question,
    'multiple', p.multiple,
    'anonymous', p.anonymous,
    'closes_at', p.closes_at,
    'closed_at', p.closed_at,
    'created_by', p.created_by,
    'created_at', p.created_at,
    'voters', p.voters,
    'can_close', (me is not null and p.created_by = me),
    'mine', coalesce((select jsonb_agg(v.option_id) from public.team_chat_poll_vote v where v.poll_id = p.id and v.member_id = me), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id,
               'label', o.label,
               'position', o.position,
               'votes', coalesce((p.tally ->> o.id::text)::integer, 0),
               -- Anonymous: nobody's name, to anyone.
               'voter_ids', case when p.anonymous then '[]'::jsonb
                                 else coalesce((select jsonb_agg(v.member_id order by v.created_at) from public.team_chat_poll_vote v where v.option_id = o.id), '[]'::jsonb) end
             ) order by o.position)
        from public.team_chat_poll_option o
       where o.poll_id = p.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.team_chat_poll_read(uuid) from public, anon;
grant execute on function public.team_chat_poll_read(uuid) to authenticated;

-- The caller's whole answer (empty: their vote taken back), under the poll's lock.
create or replace function public.team_chat_poll_vote(poll uuid, option_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.team_chat_poll;
  me uuid;
  picks uuid[] := array(select distinct x from unnest(coalesce(option_ids, '{}'::uuid[])) x);
begin
  select * into p from public.team_chat_poll where id = poll for update;
  if not found or exists (select 1 from public.team_chat_message x where x.id = p.message_id and x.deleted_at is not null) then
    raise exception 'team chat: no such poll' using errcode = '42501';
  end if;
  if not public.team_chat_can_post(p.channel_id) then
    raise exception 'team chat: no such poll' using errcode = '42501';
  end if;
  me := public.current_member_id(p.workspace_id);
  if me is null then
    raise exception 'team chat: no such poll' using errcode = '42501';
  end if;
  if p.closed_at is not null or (p.closes_at is not null and p.closes_at <= now()) then
    raise exception 'team chat: this poll is closed' using errcode = '22023';
  end if;
  if not p.multiple and coalesce(array_length(picks, 1), 0) > 1 then
    raise exception 'team chat: this poll takes one choice' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(picks) x where not exists (select 1 from public.team_chat_poll_option o where o.id = x and o.poll_id = p.id)) then
    raise exception 'team chat: that is not one of this poll''s options' using errcode = '22023';
  end if;
  delete from public.team_chat_poll_vote v where v.poll_id = p.id and v.member_id = me;
  insert into public.team_chat_poll_vote (poll_id, option_id, member_id, workspace_id)
  select p.id, x, me, p.workspace_id from unnest(picks) x;
  update public.team_chat_poll t
     set tally = coalesce((select jsonb_object_agg(v.option_id::text, v.n) from (select option_id, count(*)::integer as n from public.team_chat_poll_vote where poll_id = p.id group by option_id) v), '{}'::jsonb),
         voters = (select count(distinct member_id)::integer from public.team_chat_poll_vote where poll_id = p.id)
   where t.id = p.id;
  return public.team_chat_poll_read(p.id);
end;
$$;

revoke all on function public.team_chat_poll_vote(uuid, uuid[]) from public, anon;
grant execute on function public.team_chat_poll_vote(uuid, uuid[]) to authenticated;

-- Closed now, by its creator only (the member, or whose agent posted it).
create or replace function public.team_chat_poll_close(poll uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.team_chat_poll;
  me uuid;
begin
  select * into p from public.team_chat_poll where id = poll for update;
  if not found or not public.team_chat_can_read(p.channel_id) then
    raise exception 'team chat: no such poll' using errcode = '42501';
  end if;
  me := public.current_member_id(p.workspace_id);
  if me is null or p.created_by is distinct from me then
    raise exception 'team chat: only the poll''s author closes it' using errcode = '42501';
  end if;
  if p.closed_at is null then
    update public.team_chat_poll set closed_at = now(), closed_by = me where id = p.id;
  end if;
  return public.team_chat_poll_read(p.id);
end;
$$;

revoke all on function public.team_chat_poll_close(uuid) from public, anon;
grant execute on function public.team_chat_poll_close(uuid) to authenticated;

-- ── Realtime: the poll row, under its policy ───────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_poll') then
      alter publication supabase_realtime add table public.team_chat_poll;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
