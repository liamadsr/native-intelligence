-- ============================================================
-- 410: Local agents (L1–L3): the cloud Dial8 agent manages eve agents that
-- run on the person's Mac, fenced by the Mac's own folder grants.
--
-- docs/plans/local-agents.md §1 (the six invariants), §6 (data), "The full
-- build". This migration only ADDS tables, one realtime.messages policy and
-- two publication entries. Nothing here touches an existing row.
--
--   user_device              one per signed-in desktop (presence: last_seen_at
--                            from the 60 s heartbeat).
--   device_folder            the server's READ-ONLY mirror of the Mac's grants.
--                            The Mac is the source of truth (invariant 3): the
--                            heartbeat route upserts the list it sends and
--                            revokes any grant it no longer sends. These are
--                            the person's environment: every chat sees them.
--   local_agent_session      one local job; its id is also Rust's job id.
--   local_agent_message      messages TO a local agent (steer | queue).
--   local_agent_event        the transcript: device events (deduped per
--                            session, run, seq) and server `inbound` events.
--   local_agent_relay_slot   in-flight model relay calls (a per-person cap).
--
-- Security (every table): the person SELECTs their own rows
-- (user_id = auth.uid()). There are NO client INSERT/UPDATE/DELETE policies:
-- every write goes through an authenticated route that runs as the service
-- role (src/app/api/local-agent/**, src/lib/local-agent/store.ts). A page can
-- therefore never forge a grant, a claim or a transcript line.
--
-- Workspace merge (402): only local_agent_session carries workspace_id, so the
-- generic re-stamp moves it. No uniqueness here includes workspace_id, so the
-- re-stamp can never collide (P0008).
--
-- Not applied by the builder: the orchestrator applies it to DEV after review.
-- ============================================================

-- ── user_device ─────────────────────────────────────────────────────────────
create table if not exists public.user_device (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Rust's stable device id (a uuid made once, kept in state.json).
  id uuid not null,
  name text not null default '' check (char_length(name) <= 200),
  platform text not null default '' check (char_length(platform) <= 40),
  app_version text not null default '' check (char_length(app_version) <= 40),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

comment on table public.user_device is
  'Local agents (410): one row per signed-in Dial8 desktop. last_seen_at is the 60 s heartbeat (online = seen within 120 s). The person reads their own rows; only the service role writes.';

drop trigger if exists user_device_updated_at on public.user_device;
create trigger user_device_updated_at
  before update on public.user_device
  for each row execute function public.update_updated_at();

alter table public.user_device enable row level security;

drop policy if exists user_device_own_select on public.user_device;
create policy user_device_own_select on public.user_device
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── device_folder ───────────────────────────────────────────────────────────
create table if not exists public.device_folder (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid not null,
  -- Rust's grant id. Jobs name this, never a path (invariant 3).
  grant_id text not null check (char_length(grant_id) between 1 and 200),
  label text not null check (char_length(label) between 1 and 255),
  path text not null check (char_length(path) between 1 and 4096),
  mode text not null default 'read' check (mode in ('read', 'edit')),
  is_git boolean not null default false,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_folder_grant_uq unique (user_id, device_id, grant_id),
  constraint device_folder_device_fk foreign key (user_id, device_id)
    references public.user_device (user_id, id) on delete cascade
);

comment on table public.device_folder is
  'Local agents (410): the server''s read-only mirror of a Mac''s folder grants. Written only by the heartbeat route from what the Mac sends; a grant the Mac no longer sends gets revoked_at. The fence itself lives on the Mac.';

-- The unique (user_id, device_id, grant_id) covers "this person's folders" and
-- "this device's folders" (and the composite FK's cascade).

drop trigger if exists device_folder_updated_at on public.device_folder;
create trigger device_folder_updated_at
  before update on public.device_folder
  for each row execute function public.update_updated_at();

alter table public.device_folder enable row level security;

drop policy if exists device_folder_own_select on public.device_folder;
create policy device_folder_own_select on public.device_folder
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── local_agent_session ─────────────────────────────────────────────────────
create table if not exists public.local_agent_session (
  -- The same id is Rust's job id.
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- Copied from the folder at creation, so the device's pending query is one
  -- index scan (no join through device_folder).
  device_id uuid not null,
  folder_id uuid not null references public.device_folder(id) on delete cascade,
  conversation_id uuid references public.chat_conversations(id) on delete set null,
  -- The ledger (tracked_job), ONE ROW PER TURN (run key
  -- local_agent:<session>:<turn>): tracked_job_id is the first turn's row,
  -- current_tracked_job_id the latest. Plain uuids, no FK: a pruned ledger row
  -- must never block or cascade into the session.
  tracked_job_id uuid,
  current_turn integer not null default 1 check (current_turn >= 1),
  current_tracked_job_id uuid,
  started_by text not null check (started_by in ('agent', 'person')),
  mode text not null default 'read' check (mode in ('read', 'edit')),
  request text not null check (char_length(request) between 1 and 20000),
  status text not null default 'queued'
    check (status in (
      'queued',       -- waiting for the Mac to claim it
      'starting',     -- claimed; the launcher is starting
      'running',      -- a turn is running on the Mac (lease renewed by event uploads)
      'waiting',      -- the turn ended; idle until a message
      'cancelled',    -- stopped
      'failed',       -- the Mac reported a failure
      'interrupted',  -- the lease lapsed (the Mac app closed mid-turn); a message resumes it
      'expired'       -- queued past expires_at; no Mac claimed it
    )),
  -- The eve session on the Mac, for resume.
  eve_session_id text check (char_length(eve_session_id) <= 200),
  stream_index integer,
  -- The device's current launcher run (a uuid per launcher process).
  run_id text check (char_length(run_id) <= 200),
  -- The highest device seq stored for the CURRENT run, and that run. Rust's
  -- seq is monotonic per job within one app run and restarts per run (an app
  -- relaunch starts the ring again), so the mark is only meaningful with its
  -- run: the relay's gap-fill starts after it when the run matches.
  last_seq integer check (last_seq >= 0),
  last_seq_run_id text check (char_length(last_seq_run_id) <= 200),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- Queued TTL: created (or re-queued) + 6 h.
  expires_at timestamptz not null default (now() + interval '6 hours'),
  stop_requested_at timestamptz,
  last_signal text check (last_signal in ('ask', 'finish')),
  last_signal_text text check (char_length(last_signal_text) <= 20000),
  -- Edit mode (L3): the branch the Mac committed on. Never pushed.
  branch text check (char_length(branch) <= 300),
  commit_sha text check (char_length(commit_sha) <= 64),
  error text check (char_length(error) <= 4000),
  ended_at timestamptz,
  -- A 'queue' message that arrived while a turn was running: the turn after
  -- this one. The turn end opens it (one ledger row per turn), unless the
  -- turn ended on a question, which the queued message then answers.
  pending_turn_text text check (char_length(pending_turn_text) <= 20000),
  -- A chat tool start: local-agent:<conv>:session:<s>:turn:<t>:call:<c>
  -- (the start_chat_helper scheme, migration 332). A retried call finds its
  -- row; unique per person.
  idempotency_key text check (char_length(idempotency_key) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_agent_session_device_fk foreign key (user_id, device_id)
    references public.user_device (user_id, id) on delete cascade,
  constraint local_agent_session_idempotency_uq unique (user_id, idempotency_key)
);

comment on table public.local_agent_session is
  'Local agents (410): one job on a person''s Mac, in one granted folder. Status is written only by service-role routes (claim CAS, event uploads, lazy reaping). The ledger mirror is one tracked_job row per turn (kind local_agent, run key local_agent:<id>:<turn>).';

-- The device's pending query: its live sessions (start, stops, messages).
create index if not exists local_agent_session_device_live_idx
  on public.local_agent_session (user_id, device_id, status)
  where status in ('queued', 'starting', 'running', 'waiting', 'interrupted');
-- A person's sessions, newest first (and the RLS predicate).
create index if not exists local_agent_session_user_idx
  on public.local_agent_session (user_id, created_at desc);
-- A conversation's sessions (the chat's tools and the Agents panel).
create index if not exists local_agent_session_conversation_idx
  on public.local_agent_session (conversation_id, created_at desc)
  where conversation_id is not null;
-- FK cascades from device_folder / workspace.
create index if not exists local_agent_session_folder_idx
  on public.local_agent_session (folder_id);
create index if not exists local_agent_session_workspace_idx
  on public.local_agent_session (workspace_id);

drop trigger if exists local_agent_session_updated_at on public.local_agent_session;
create trigger local_agent_session_updated_at
  before update on public.local_agent_session
  for each row execute function public.update_updated_at();

alter table public.local_agent_session enable row level security;

drop policy if exists local_agent_session_own_select on public.local_agent_session;
create policy local_agent_session_own_select on public.local_agent_session
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── local_agent_message ─────────────────────────────────────────────────────
create table if not exists public.local_agent_message (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.local_agent_session(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'agent' = the cloud Dial8 agent; 'person' = the person, from the panel.
  author text not null check (author in ('agent', 'person')),
  text text not null check (char_length(text) between 1 and 20000),
  policy text not null default 'queue' check (policy in ('steer', 'queue')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  error text check (char_length(error) <= 4000),
  delivered_at timestamptz,
  -- A retried send (the panel's requestId, a chat tool call's key) finds its row.
  idempotency_key text check (char_length(idempotency_key) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_agent_message_idempotency_uq unique (session_id, idempotency_key)
);

comment on table public.local_agent_message is
  'Local agents (410): a message to a local agent, delivered by the Mac (pending → delivered | failed via the ack route). The person reads their own rows; only the service role writes.';

-- The device's pending query: this person's undelivered messages.
create index if not exists local_agent_message_pending_idx
  on public.local_agent_message (user_id, created_at)
  where status = 'pending';
-- A session's messages (and the FK cascade).
create index if not exists local_agent_message_session_idx
  on public.local_agent_message (session_id, created_at);

drop trigger if exists local_agent_message_updated_at on public.local_agent_message;
create trigger local_agent_message_updated_at
  before update on public.local_agent_message
  for each row execute function public.update_updated_at();

alter table public.local_agent_message enable row level security;

drop policy if exists local_agent_message_own_select on public.local_agent_message;
create policy local_agent_message_own_select on public.local_agent_message
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── local_agent_event ───────────────────────────────────────────────────────
create table if not exists public.local_agent_event (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.local_agent_session(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('device', 'server')),
  -- Device events only: the launcher run and its monotonic seq.
  run_id text check (char_length(run_id) <= 200),
  seq integer check (seq >= 0),
  kind text not null check (char_length(kind) between 1 and 40),
  payload jsonb not null default '{}'::jsonb
    check (octet_length(payload::text) <= 65536),
  -- Append-only: no updated_at.
  created_at timestamptz not null default now(),
  -- A device event carries its run and seq; a server event (inbound) neither.
  constraint local_agent_event_source_shape check (
    (source = 'device' and run_id is not null and seq is not null)
    or (source = 'server' and run_id is null and seq is null)
  ),
  -- Upload dedupe. A FULL unique constraint rather than a partial index on
  -- source = 'device': server rows have NULL run_id/seq, and NULLs are
  -- distinct, so this is the same rule, and a full constraint is what
  -- ON CONFLICT (session_id, run_id, seq) DO NOTHING can infer (PostgREST
  -- upsert sends no index predicate, so a partial index would not match).
  constraint local_agent_event_device_seq_uq unique (session_id, run_id, seq)
);

comment on table public.local_agent_event is
  'Local agents (410): a local agent''s transcript, in id order. Device events are deduped on (session_id, run_id, seq); the server writes `inbound` events when a message is created. Append-only; the person reads their own rows; only the service role writes.';

-- Transcript reads: a session's events after an id. The unique constraint
-- above leads with session_id too, but (session_id, id) serves the ordered
-- "after id" page directly.
create index if not exists local_agent_event_session_idx
  on public.local_agent_event (session_id, id);
create index if not exists local_agent_event_user_idx
  on public.local_agent_event (user_id);

alter table public.local_agent_event enable row level security;

drop policy if exists local_agent_event_own_select on public.local_agent_event;
create policy local_agent_event_own_select on public.local_agent_event
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── local_agent_relay_slot: in-flight model relay calls ─────────────────────
-- The model relay (/api/local-agent/model/language-model) holds one slot per
-- call so a person has at most a few calls in flight across every server
-- instance. A slot expires on its own (a crashed instance never leaks one).
-- Service role only: RLS on, no policies, and the acquire function is not
-- executable by the API roles.
create table if not exists public.local_agent_relay_slot (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.local_agent_session(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.local_agent_relay_slot is
  'Local agents (410): in-flight model relay calls, at most a few per person (local_agent_relay_acquire). Service role only.';

create index if not exists local_agent_relay_slot_user_idx
  on public.local_agent_relay_slot (user_id, expires_at);
create index if not exists local_agent_relay_slot_session_idx
  on public.local_agent_relay_slot (session_id);

alter table public.local_agent_relay_slot enable row level security;

-- Take a slot for a person, or NULL when they already hold p_max live ones.
-- A per-person advisory lock makes count-then-insert atomic.
create or replace function public.local_agent_relay_acquire(
  p_user_id uuid,
  p_session_id uuid,
  p_max integer,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_live integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('local_agent_relay:' || p_user_id::text, 0));
  delete from public.local_agent_relay_slot where user_id = p_user_id and expires_at < now();
  select count(*) into v_live from public.local_agent_relay_slot where user_id = p_user_id;
  if v_live >= p_max then
    return null;
  end if;
  insert into public.local_agent_relay_slot (user_id, session_id, expires_at)
  values (p_user_id, p_session_id, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.local_agent_relay_acquire(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.local_agent_relay_acquire(uuid, uuid, integer, integer) to service_role;

-- ── Realtime ────────────────────────────────────────────────────────────────
-- The Agents panel follows a session's row and its new events. Mirrors 272:
-- UPDATE payloads carry the full session row. local_agent_event is insert-only
-- (an INSERT payload always carries the whole row), so it keeps the default
-- replica identity.
alter table public.local_agent_session replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.local_agent_session;
exception
  when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.local_agent_event;
exception
  when duplicate_object then null;
end $$;

-- ── Private broadcast doorbell: device:<userId> ─────────────────────────────
-- The server rings `device:<userId>` (service role) when a session starts, a
-- message lands or a stop is asked, so the person's online Mac drains its
-- pending work at once; a 5 s poll is the correctness backstop. SELECT only
-- (no INSERT to authenticated), so a page can never ring a fake doorbell, and
-- prefix-guarded so it never widens another private channel. Same shape as
-- browser-cmd: (migration 292), except the topic's id is compared as TEXT
-- rather than cast to uuid, so a malformed topic on any private channel can
-- never raise a cast error inside this policy.
drop policy if exists "local_agent_device_owner_can_subscribe" on realtime.messages;
create policy "local_agent_device_owner_can_subscribe"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'device:%'
  and split_part(realtime.topic(), ':', 2) = (select auth.uid())::text
);
