-- ============================================================
-- 564: Team calls (calls plan, phase 5): audio and video calls between the
-- people of a team chat channel or DM, over the self-hosted LiveKit server.
-- This file is the tables and the fence; 565 is the functions that write
-- them. Not the phone line to a person's own agent (src/lib/calls): that
-- is another feature, with no table here.
-- ============================================================
--   team_call          one call in one channel or DM. At most one is live
--                      per channel (team_call_one_live): a second start
--                      joins it. `room` is its LiveKit room ('tc-<id>').
--                      LiveKit's webhooks are the truth about who is in it
--                      (participant_count, peak_participants) and when it
--                      ended (ended_at, duration_seconds, ended_reason:
--                      'finished' the room closed, 'left' a DM's person
--                      hung up, 'swept' its room was gone, 'failed' the
--                      room could not be made, 'archived' its channel was
--                      archived). `ringing` and `declined` are the members
--                      being rung now and those who said no, for the
--                      caller's panel: never capped by a check (a decline
--                      always lands), bounded by 565's cap of 20 rings per
--                      call. Written by 565's functions only.
--   team_call_participant  per call and member: in it now ('joined') or
--                      not ('left'), the LiveKit session (session_sid) the
--                      state is for, and the time of the newest event
--                      applied (last_event_at), so a webhook that repeats or
--                      arrives late never undoes a newer one. Written by
--                      565's team_call_participant_event only (the service
--                      role, from the webhook route).
--   team_call_ring     one ring of one member for one call: 'ringing' (at
--                      most one per call and member), 'busy' (they were in
--                      another call: a quiet notice, never a ring),
--                      'accepted', 'declined', 'missed' (nobody answered
--                      within expires_at, or the call ended first) or
--                      'cancelled'. Carries what the incoming-call surface
--                      shows (the caller's name, the place), so a ring draws
--                      from its own row. user_id is the member's account:
--                      a person reads their own rings and nobody else's.
--                      notified_at: when a missed ring's person was told
--                      (the notice is sent once per ring, and a notice that
--                      failed is found again by the sweeper).
--   team_call_webhook_event  the ids of LiveKit webhook events already
--                      applied (a repeat is answered and skipped). Service
--                      role only; the sweeper prunes it.
--   team_call_eject    the outbox of people to take out of a LiveKit room
--                      (identity: their member id) or rooms to close
--                      (identity null): written by 565's triggers the moment
--                      someone's access to a conversation with a live call
--                      ends (removed from the team, the DM or the workspace,
--                      the channel archived or deleted), by the webhook when
--                      someone without access joins, and by the sweeper's
--                      check; drained by the app (src/lib/team-calls/
--                      eject.ts), which calls LiveKit. A connected person is
--                      never cut off by a token running out, so this is what
--                      takes them out. No foreign key to team_call: a room
--                      still has to close when its call is deleted with its
--                      workspace. Service role only.
--   team_chat_message.kind  'message' (as ever) or 'call': the message a
--                      call shows as in its conversation (call_id). Its
--                      words say what happened ('Started a call', then
--                      'Call ended · 12 min · 3 people'), written by the
--                      call's functions, so search, the agent and an email
--                      read it as any message. Never a client's to insert,
--                      edit or delete.
--   team_chat_message_insert  556's policy, plus: a member's own insert is
--                      a plain message (kind 'message', no call).
--   team_chat_message_guard  555's, plus: a client never changes kind or
--                      call_id, and never edits or deletes a call's
--                      message (565's functions write its words, also when
--                      a person's action ends the call, e.g. archiving its
--                      channel: they say so with the transaction-local
--                      setting team_calls.writing, which no client can set).
--
-- Reads are RLS: a call and who is in it, for the people who may read its
-- channel (team_chat_can_read); a ring, for its own person (user_id =
-- auth.uid()). Realtime publishes team_call, team_call_participant and
-- team_call_ring, filtered by the same policies; nothing here is ever
-- deleted (a published delete reaches subscribers without the policy).
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: the new tables are empty; team_chat_message gains a column with
-- a constant default and a nullable one (no rewrite). Its new check's
-- validation and the new unique index's build run inside the same
-- transaction as ADD COLUMN, so team_chat_message is locked for their scans
-- too (milliseconds at its size; lock_timeout below bounds the wait to get
-- the lock, and NOT VALID buys nothing more here). The policy and guard keep
-- every rule they had. The deployed app never reads the new columns, and a call's message
-- reads as plain words to it. The file runs as one transaction;
-- lock_timeout (5 s) makes it fail and roll back behind a long reader
-- rather than queue every write behind it. No backslashes anywhere in this
-- file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.team_call (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  message_id uuid,
  started_by uuid references public.member(id) on delete set null,
  room text not null unique check (char_length(room) between 4 and 64),
  status text not null default 'live' check (status in ('live', 'ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  participant_count integer not null default 0 check (participant_count >= 0),
  peak_participants integer not null default 0 check (peak_participants >= 0),
  ringing uuid[] not null default '{}',
  declined uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint team_call_shape check (
    (status = 'live' and ended_at is null and ended_reason is null)
    or (status = 'ended' and ended_at is not null and ended_reason is not null)
  )
);

-- How a call ended (named, so a reason added later is one drop and add).
alter table public.team_call drop constraint if exists team_call_ended_reason_check;
alter table public.team_call
  add constraint team_call_ended_reason_check check (
    ended_reason is null or ended_reason in ('finished', 'left', 'swept', 'failed', 'archived')
  ) not valid;
alter table public.team_call validate constraint team_call_ended_reason_check;
-- An early draft capped ringing and declined at 50, which could refuse a decline: gone.
alter table public.team_call drop constraint if exists team_call_rings_bounded;

-- One live call per channel or DM: a second start finds it.
create unique index if not exists team_call_one_live on public.team_call (channel_id) where status = 'live';
-- The sweeper's read: the live calls, oldest first.
create index if not exists team_call_live_idx on public.team_call (started_at) where status = 'live';
create index if not exists team_call_channel_idx on public.team_call (channel_id, started_at desc);

create table if not exists public.team_call_participant (
  call_id uuid not null references public.team_call(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  state text not null check (state in ('joined', 'left')),
  session_sid text check (session_sid is null or char_length(session_sid) <= 64),
  first_joined_at timestamptz not null,
  joined_at timestamptz not null,
  left_at timestamptz,
  last_event_at timestamptz not null,
  primary key (call_id, member_id)
);
-- "Is this person in a call right now?" (a ring to someone in another call is a quiet notice).
create index if not exists team_call_participant_in_call_idx on public.team_call_participant (member_id) where state = 'joined';

create table if not exists public.team_call_ring (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.team_call(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  caller_member_id uuid references public.member(id) on delete set null,
  caller_name text not null check (char_length(caller_name) between 1 and 120),
  channel_kind text not null check (channel_kind in ('channel', 'dm')),
  channel_name text check (channel_name is null or char_length(channel_name) <= 80),
  state text not null check (state in ('ringing', 'busy', 'accepted', 'declined', 'missed', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz,
  notified_at timestamptz,
  constraint team_call_ring_expiry check (expires_at > created_at)
);
alter table public.team_call_ring add column if not exists notified_at timestamptz;
-- One ring at a time per call and person.
create unique index if not exists team_call_ring_one_open on public.team_call_ring (call_id, member_id) where state in ('ringing', 'busy');
create index if not exists team_call_ring_user_idx on public.team_call_ring (user_id, created_at desc);
-- The sweeper's read: rings left open past their time.
create index if not exists team_call_ring_open_idx on public.team_call_ring (expires_at) where state in ('ringing', 'busy');
-- The sweeper's read: missed rings whose person was never told.
create index if not exists team_call_ring_untold_idx on public.team_call_ring (created_at) where state = 'missed' and notified_at is null;
-- 565's ring limits: a caller's recent rings of a person.
create index if not exists team_call_ring_caller_idx on public.team_call_ring (caller_member_id, member_id, created_at desc);

create table if not exists public.team_call_webhook_event (
  id text primary key check (char_length(id) between 1 and 128),
  received_at timestamptz not null default now()
);
create index if not exists team_call_webhook_event_received_idx on public.team_call_webhook_event (received_at);

create table if not exists public.team_call_eject (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null,
  room text not null check (char_length(room) between 4 and 64),
  identity text check (identity is null or char_length(identity) <= 64),
  reason text not null check (reason in ('access', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0)
);
-- One pending entry per room and person (or room close).
create unique index if not exists team_call_eject_pending_key on public.team_call_eject (room, coalesce(identity, '')) where done_at is null;
create index if not exists team_call_eject_pending_idx on public.team_call_eject (created_at) where done_at is null;

-- ── A call's message ────────────────────────────────────────────────────────

alter table public.team_chat_message
  add column if not exists kind text not null default 'message',
  add column if not exists call_id uuid references public.team_call(id) on delete set null;

alter table public.team_chat_message drop constraint if exists team_chat_message_kind;
alter table public.team_chat_message
  add constraint team_chat_message_kind check (
    (kind = 'message' and call_id is null) or kind = 'call'
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_kind;

-- One message per call.
create unique index if not exists team_chat_message_call_key on public.team_chat_message (call_id) where call_id is not null;

alter table public.team_call drop constraint if exists team_call_message_fk;
alter table public.team_call
  add constraint team_call_message_fk foreign key (message_id) references public.team_chat_message(id) on delete set null not valid;
alter table public.team_call validate constraint team_call_message_fk;

comment on column public.team_chat_message.kind is
  'What the message is (564): message, or call (the row a team call shows as in its conversation, call_id; its words written by the call''s functions only).';

-- 556's policy, plus: what a member inserts is a plain message.
drop policy if exists team_chat_message_insert on public.team_chat_message;
create policy team_chat_message_insert on public.team_chat_message
  for insert to authenticated with check (
    author_kind = 'member'
    and kind = 'message'
    and call_id is null
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

-- 555's guard, plus: kind and call_id never change, and a call's message is
-- the call's (its words follow the call; a client never edits or deletes it).
create or replace function public.team_chat_message_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The service role, or one of 565's functions writing a call's words.
  if auth.uid() is null or coalesce(current_setting('team_calls.writing', true), '') = 'on' then
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
     or new.link_preview is distinct from old.link_preview
     or new.kind is distinct from old.kind
     or new.call_id is distinct from old.call_id then
    raise exception 'team chat: only the words of a message can change' using errcode = '42501';
  end if;
  if old.kind = 'call' then
    raise exception 'team chat: a call''s message changes with the call' using errcode = '42501';
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

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.team_call enable row level security;
alter table public.team_call_participant enable row level security;
alter table public.team_call_ring enable row level security;
alter table public.team_call_webhook_event enable row level security;
alter table public.team_call_eject enable row level security;

drop policy if exists team_call_select on public.team_call;
create policy team_call_select on public.team_call
  for select to authenticated using (public.team_chat_can_read(channel_id));

drop policy if exists team_call_participant_select on public.team_call_participant;
create policy team_call_participant_select on public.team_call_participant
  for select to authenticated using (public.team_chat_can_read(channel_id));

-- A person's own rings, and nobody else's.
drop policy if exists team_call_ring_select on public.team_call_ring;
create policy team_call_ring_select on public.team_call_ring
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.team_call from anon, authenticated;
revoke all on table public.team_call_participant from anon, authenticated;
revoke all on table public.team_call_ring from anon, authenticated;
revoke all on table public.team_call_webhook_event from anon, authenticated;
revoke all on table public.team_call_eject from anon, authenticated;
grant select on table public.team_call to authenticated;
grant select on table public.team_call_participant to authenticated;
grant select on table public.team_call_ring to authenticated;
grant select, insert, update on table public.team_call to service_role;
grant select, insert, update on table public.team_call_participant to service_role;
grant select, insert, update on table public.team_call_ring to service_role;
grant select, insert, delete on table public.team_call_webhook_event to service_role;
grant select, insert, update, delete on table public.team_call_eject to service_role;

-- ── Realtime ────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_call') then
      alter publication supabase_realtime add table public.team_call;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_call_participant') then
      alter publication supabase_realtime add table public.team_call_participant;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_call_ring') then
      alter publication supabase_realtime add table public.team_call_ring;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
