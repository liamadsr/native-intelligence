-- ============================================================
-- 573: Meeting links (calls plan, phase 7), the tables. A member makes a
-- meeting: a title, maybe a start and a length, and a link on the app's own
-- domain. Members who open it join its conversation (572's kind 'meeting')
-- and its call; anyone else is a guest, who waits in a lobby until someone
-- in the call lets them in. 574 is the functions that write these tables.
-- ============================================================
--   meeting            one link and its conversation (channel_id, one each).
--                      token_hash: the sha256 of the link's token (at least
--                      128 bits, made by the server, never stored). The link
--                      works from opens_at until closes_at (a scheduled one
--                      from 15 minutes before its start until 2 hours after
--                      its planned end; one with no time for 30 days), and
--                      not once revoked_at is set (by its host). host_member_id
--                      made it. Written by 574's functions only. A client
--                      may read a meeting it may read the conversation of,
--                      never its token_hash (column grants).
--   meeting_guest      one person without an account who asked to join: the
--                      name they typed (1 to 60 characters) and timestamps,
--                      nothing else. state: 'waiting' in the lobby,
--                      'admitted' (by a member in the call, into that call:
--                      call_id), 'declined', 'removed' (by a member: for good,
--                      for this link) or 'left' (they went, their call ended,
--                      or the link stopped working). in_call, session_sid,
--                      first_joined_at, joined_at, left_at, last_event_at:
--                      what LiveKit's webhooks say of them, ordered as 565
--                      orders a member's sessions. last_seen_at: their lobby's
--                      last poll (a tab closed stops it; 574's sweep lets go
--                      of a waiting guest not seen for two minutes). Members
--                      who may read the conversation read it (the lobby, over
--                      Realtime); the guest never reads the database: every
--                      step of theirs is a server route that checks their
--                      signed cookie, then the service role.
--   meeting_guest_key  per guest, the key their requests were limited by: an
--                      HMAC of their IP address made by the server (never the
--                      address). A guest removed from a link keeps the link
--                      shut to that key. Service role only.
--   meeting_rate       the public routes' rate limits: hits per bucket and
--                      key within a window (574's meeting_rate_hit). Service
--                      role only; 574's sweep prunes it.
--   team_call_egress.guest_id  566's notes file of a guest's microphone
--                      (member_id null), so the notes name them as the name
--                      they typed, "(guest)". Never both a member and a guest.
--
-- RLS on every table; anon has no grant on any. Realtime publishes
-- meeting_guest, filtered by its policy; nothing here is deleted by the app
-- (a row goes only with its meeting's conversation).
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: new tables, empty; team_call_egress gains a nullable column (no
-- rewrite) and a check that holds for every row (no row has a guest). The
-- deployed app never reads them. No backslashes anywhere in this file (one
-- MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.meeting (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null unique references public.team_chat_channel(id) on delete cascade,
  host_member_id uuid references public.member(id) on delete set null,
  title text not null check (char_length(title) between 1 and 80),
  token_hash text not null unique check (char_length(token_hash) between 40 and 128),
  starts_at timestamptz,
  ends_at timestamptz,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint meeting_window check (
    closes_at > opens_at
    and (starts_at is null) = (ends_at is null)
    and (ends_at is null or ends_at > starts_at)
  )
);
create index if not exists meeting_workspace_idx on public.meeting (workspace_id, created_at desc);
-- 574's cap on links a member makes in a day.
create index if not exists meeting_host_idx on public.meeting (host_member_id, created_at desc);

create table if not exists public.meeting_guest (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meeting(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  state text not null check (state in ('waiting', 'admitted', 'declined', 'removed', 'left')),
  call_id uuid references public.team_call(id) on delete set null,
  in_call boolean not null default false,
  session_sid text check (session_sid is null or char_length(session_sid) <= 64),
  first_joined_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  last_event_at timestamptz,
  requested_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.member(id) on delete set null,
  constraint meeting_guest_shape check (
    (state <> 'admitted' or call_id is not null)
    and (not in_call or state = 'admitted')
  )
);
-- The lobby: a meeting's guests waiting (the cap counts them), and who is in a call now.
create index if not exists meeting_guest_meeting_idx on public.meeting_guest (meeting_id, state, requested_at);
create index if not exists meeting_guest_channel_idx on public.meeting_guest (channel_id, requested_at desc);
create index if not exists meeting_guest_in_call_idx on public.meeting_guest (call_id) where in_call;
create index if not exists meeting_guest_admitted_idx on public.meeting_guest (call_id) where state = 'admitted';
-- 574's sweep: guests waiting, oldest seen first.
create index if not exists meeting_guest_waiting_idx on public.meeting_guest (last_seen_at) where state = 'waiting';

create table if not exists public.meeting_guest_key (
  guest_id uuid primary key references public.meeting_guest(id) on delete cascade,
  meeting_id uuid not null references public.meeting(id) on delete cascade,
  rate_key text not null check (char_length(rate_key) between 16 and 128),
  created_at timestamptz not null default now()
);
create index if not exists meeting_guest_key_idx on public.meeting_guest_key (meeting_id, rate_key);

create table if not exists public.meeting_rate (
  bucket text not null check (char_length(bucket) between 1 and 80),
  rate_key text not null check (char_length(rate_key) between 1 and 128),
  window_start timestamptz not null default now(),
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket, rate_key)
);
create index if not exists meeting_rate_window_idx on public.meeting_rate (window_start);

-- ── A guest's notes file ────────────────────────────────────────────────────

alter table public.team_call_egress
  add column if not exists guest_id uuid references public.meeting_guest(id) on delete set null;

alter table public.team_call_egress drop constraint if exists team_call_egress_one_speaker;
alter table public.team_call_egress
  add constraint team_call_egress_one_speaker check (member_id is null or guest_id is null) not valid;
alter table public.team_call_egress validate constraint team_call_egress_one_speaker;

comment on column public.team_call_egress.guest_id is
  'A notes file of a meeting guest''s microphone (573): the notes name them as the name they typed, (guest). Null for a member''s.';

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.meeting enable row level security;
alter table public.meeting_guest enable row level security;
alter table public.meeting_guest_key enable row level security;
alter table public.meeting_rate enable row level security;

drop policy if exists meeting_select on public.meeting;
create policy meeting_select on public.meeting
  for select to authenticated using (public.team_chat_can_read(channel_id));

drop policy if exists meeting_guest_select on public.meeting_guest;
create policy meeting_guest_select on public.meeting_guest
  for select to authenticated using (public.team_chat_can_read(channel_id));

revoke all on table public.meeting from anon, authenticated;
revoke all on table public.meeting_guest from anon, authenticated;
revoke all on table public.meeting_guest_key from anon, authenticated;
revoke all on table public.meeting_rate from anon, authenticated;
-- Every column but the token's hash.
grant select (id, workspace_id, channel_id, host_member_id, title, starts_at, ends_at, opens_at, closes_at, revoked_at, revoked_by, created_at)
  on table public.meeting to authenticated;
grant select on table public.meeting_guest to authenticated;
grant select, insert, update on table public.meeting to service_role;
grant select, insert, update on table public.meeting_guest to service_role;
grant select, insert on table public.meeting_guest_key to service_role;
grant select, insert, update, delete on table public.meeting_rate to service_role;

-- ── Realtime ────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meeting_guest') then
      alter publication supabase_realtime add table public.meeting_guest;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
