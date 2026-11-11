-- ============================================================
-- 566: Team call notes and recordings (calls plan, phase 6): the tables, the
-- storage bucket and the fences. 567 is the functions that write them.
-- ============================================================
--   team_call (564), plus:
--     notes            the call's notes are on now: LiveKit Egress writes each
--                      microphone in the call to a file of its own, and the
--                      files become the call's transcript when it ends.
--                      Anyone in the call turns it on or off (567's
--                      team_call_set_notes); everyone in it sees it.
--     notes_by, notes_changed_at  who changed it last (null: the server, at
--                      the bound), and when.
--     notes_on_since   when this stretch of notes began (null while off).
--     notes_seconds    the time notes were on in the stretches that ended:
--                      a call's notes stop at 3 hours of audio (567).
--     notes_round      counts the times notes were turned on: one file per
--                      microphone track per round, so a repeat webhook never
--                      starts a second one.
--     notes_state      'none' (never on), 'capturing' (on at least once,
--                      the call live), 'transcribing' (the call ended, its
--                      files are being turned into notes), then 'ready' (a
--                      capture is made: capture_id), 'silent' (nothing was
--                      said, no capture) or 'failed'.
--     capture_id       the call's notes: a capture like a recorded meeting's.
--     recording        'off', 'starting', 'on' (one video recording of the
--                      whole call is being written), 'saved' (its file is
--                      kept) or 'failed' (it could not be written; another
--                      may be started while the call is live).
--     recording_by, recording_started_at, recording_ended_at.
--   team_call_egress   one LiveKit egress of a call: kind 'notes' (one
--                      member's microphone track, audio only, to
--                      <channel>/<call>/notes/<id>.ogg) or 'recording' (the
--                      whole call, video and audio, to
--                      <channel>/<call>/recording/<id>.mp4). Its state comes
--                      from LiveKit's egress webhooks in the order LiveKit
--                      made them (status_at_ns, its updatedAt in
--                      nanoseconds): a late or repeated event never undoes a
--                      newer one, and a finished egress never starts again.
--                      started_at is when its file began (a notes file's
--                      place in the call: its words are placed by it).
--                      transcript_status / transcript: a notes file's words,
--                      once transcribed. audio_deleted_at: its file was
--                      removed after the notes were made. Service role only.
--   storage bucket team-call-recordings  private. Objects are named
--                      <channel id>/<call id>/...: whoever may read the
--                      channel may read them (558's team_chat_file_channel
--                      reads the first folder). Clients never write here and
--                      only ever read through a signed link the server makes
--                      as them after its own check; LiveKit Egress writes
--                      with the storage's own S3 keys, the app's server
--                      deletes with the service role.
--   entity_access.source  492's, plus 'team_call': the grant that shares a
--                      call's notes with its conversation.
--   fences (triggers, for every writer that is a signed-in person):
--     a call's notes capture stays private (never the whole workspace's: a
--     DM's notes are its two people's), and it is shared only with its own
--     conversation (no grant to another member, team or channel). Its owner
--     may still remove the conversation's grant (narrower, never wider).
--   captures_team_call_notes_fence  a restrictive read policy: a call's
--     notes are read only by someone who may read its conversation now, the
--     owner included (access ends with the conversation's).
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: team_call gains columns with constant defaults or nullable ones
-- (no rewrite), the new table is empty, entity_access's check only gains a
-- value, and the triggers refuse only what no deployed code does. The
-- deployed app never reads the new columns. The file runs as one
-- transaction; lock_timeout (5 s) makes it fail and roll back behind a long
-- reader rather than queue every write behind it. No backslashes anywhere
-- in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A call's notes and recording ────────────────────────────────────────────

alter table public.team_call
  add column if not exists notes boolean not null default false,
  add column if not exists notes_by uuid references public.member(id) on delete set null,
  add column if not exists notes_changed_at timestamptz,
  add column if not exists notes_on_since timestamptz,
  add column if not exists notes_seconds integer not null default 0,
  add column if not exists notes_round integer not null default 0,
  add column if not exists notes_state text not null default 'none',
  add column if not exists capture_id uuid references public.captures(id) on delete set null,
  add column if not exists recording text not null default 'off',
  add column if not exists recording_by uuid references public.member(id) on delete set null,
  add column if not exists recording_started_at timestamptz,
  add column if not exists recording_ended_at timestamptz;

alter table public.team_call drop constraint if exists team_call_notes_shape;
alter table public.team_call
  add constraint team_call_notes_shape check (
    notes_state in ('none', 'capturing', 'transcribing', 'ready', 'silent', 'failed')
    and notes_seconds >= 0
    and notes_round >= 0
    and ((notes and status = 'live' and notes_on_since is not null) or (not notes and notes_on_since is null))
    and (not notes or notes_state = 'capturing')
    and (capture_id is null or notes_state = 'ready')
  ) not valid;
alter table public.team_call validate constraint team_call_notes_shape;

alter table public.team_call drop constraint if exists team_call_recording_shape;
alter table public.team_call
  add constraint team_call_recording_shape check (
    recording in ('off', 'starting', 'on', 'saved', 'failed')
    and (recording = 'off' or recording_started_at is not null)
  ) not valid;
alter table public.team_call validate constraint team_call_recording_shape;

-- The cap on recordings across the server counts these.
create index if not exists team_call_recording_live_idx on public.team_call (recording_started_at) where recording in ('starting', 'on');
-- The notes the sweeper finishes when their end was lost.
create index if not exists team_call_notes_transcribing_idx on public.team_call (ended_at) where notes_state = 'transcribing';
create index if not exists team_call_notes_on_idx on public.team_call (notes_on_since) where notes;

comment on column public.team_call.notes is
  'The call''s notes are on now (566): each microphone is written to a file by LiveKit Egress, transcribed when the call ends into a capture (capture_id).';

-- ── Each egress of a call ───────────────────────────────────────────────────

create table if not exists public.team_call_egress (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.team_call(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  kind text not null check (kind in ('notes', 'recording')),
  member_id uuid references public.member(id) on delete set null,
  track_sid text check (track_sid is null or char_length(track_sid) between 1 and 64),
  round integer not null default 0 check (round >= 0),
  egress_id text unique check (egress_id is null or char_length(egress_id) between 1 and 128),
  file_path text not null check (char_length(file_path) between 1 and 512),
  status text not null default 'starting' check (status in ('starting', 'active', 'ending', 'complete', 'failed', 'aborted', 'limit')),
  status_at_ns bigint not null default 0 check (status_at_ns >= 0),
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  error text check (error is null or char_length(error) <= 500),
  transcript_status text not null default 'pending' check (transcript_status in ('pending', 'done', 'empty', 'failed', 'none')),
  transcript jsonb,
  transcribed_at timestamptz,
  audio_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_call_egress_shape check (
    (kind = 'notes' and track_sid is not null)
    or (kind = 'recording' and track_sid is null and transcript_status = 'none')
  )
);

-- One notes file per microphone track per round of notes (a repeated track_published starts nothing).
create unique index if not exists team_call_egress_one_per_track on public.team_call_egress (call_id, track_sid, round) where kind = 'notes';
-- One recording per call at a time (one that failed leaves room for another).
create unique index if not exists team_call_egress_one_recording on public.team_call_egress (call_id) where kind = 'recording' and status not in ('failed', 'aborted');
create index if not exists team_call_egress_call_idx on public.team_call_egress (call_id, created_at);
-- The sweeper's read: egresses not finished.
create index if not exists team_call_egress_open_idx on public.team_call_egress (created_at) where status in ('starting', 'active', 'ending');

alter table public.team_call_egress enable row level security;
revoke all on table public.team_call_egress from anon, authenticated;
grant select, insert, update on table public.team_call_egress to service_role;

-- ── The recordings' bucket ──────────────────────────────────────────────────

-- 2 GB a file: a recording is bounded at 2 hours at about 1.6 Mbit/s (1.4 GB),
-- a microphone's notes file at 3 hours of Opus (under 100 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-call-recordings',
  'team-call-recordings',
  false,
  2147483648,
  array['audio/ogg', 'audio/opus', 'video/mp4', 'audio/mp4', 'application/octet-stream']
)
on conflict (id) do update
   set public = false,
       file_size_limit = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Read: whoever may read the channel the object's first folder names. No
-- insert, update or delete policy: no client ever writes here.
drop policy if exists "team call recordings read" on storage.objects;
create policy "team call recordings read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-call-recordings'
    and public.team_chat_can_read(public.team_chat_file_channel(name))
  );

-- ── A grant's source: a call's notes, shared with its conversation ─────────

alter table public.entity_access drop constraint if exists entity_access_source;
alter table public.entity_access
  add constraint entity_access_source check (source in ('manual', 'mention', 'channel_share', 'team_call')) not valid;
alter table public.entity_access validate constraint entity_access_source;

-- ── Fences: a call's notes are no wider than its conversation ───────────────

create or replace function public.team_call_notes_capture_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.visibility is distinct from old.visibility
     and new.visibility <> 'private'
     and exists (select 1 from public.team_call t where t.capture_id = new.id) then
    raise exception 'captures: a call''s notes are shared with its conversation only' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.team_call_notes_capture_guard() from public, anon, authenticated;

drop trigger if exists team_call_notes_capture_guard on public.captures;
create trigger team_call_notes_capture_guard
  before update of visibility on public.captures
  for each row execute function public.team_call_notes_capture_guard();

create or replace function public.team_call_notes_grant_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  call_channel uuid;
begin
  -- A workspace merge (402) re-stamps rows table by table (492's guard skips it too).
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  if new.entity_type <> 'capture' then
    return new;
  end if;
  select t.channel_id into call_channel from public.team_call t where t.capture_id = new.entity_id;
  if found and (new.grantee_kind <> 'channel' or new.grantee_channel_id is distinct from call_channel) then
    raise exception 'entity_access: a call''s notes are shared with its conversation only' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.team_call_notes_grant_guard() from public, anon, authenticated;

drop trigger if exists team_call_notes_grant_guard on public.entity_access;
create trigger team_call_notes_grant_guard
  before insert or update of entity_type, entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id
  on public.entity_access
  for each row execute function public.team_call_notes_grant_guard();

-- Reading follows the conversation, its owner included: a call's notes are
-- readable only by someone who may read the call's conversation now. A
-- restrictive policy (it narrows every other select policy on captures and
-- widens none): someone taken off the channel's team, out of the DM, or a
-- channel deleted, loses the notes with the conversation. Flat cost: the
-- notes the caller may not read are listed once per query (an initplan over
-- the calls with notes in the caller's workspaces), and each row is compared
-- against that list, as 493's grant pre-check does.
create index if not exists team_call_capture_idx on public.team_call (workspace_id) where capture_id is not null;

create or replace function public.team_call_notes_hidden()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(t.capture_id), '{}'::uuid[])
    from public.member me
    join public.team_call t on t.workspace_id = me.workspace_id
   where me.user_id = auth.uid()
     and t.capture_id is not null
     and not public.team_chat_can_read(t.channel_id);
$$;

revoke all on function public.team_call_notes_hidden() from public, anon;
grant execute on function public.team_call_notes_hidden() to authenticated, service_role;

drop policy if exists captures_team_call_notes_fence on public.captures;
create policy captures_team_call_notes_fence on public.captures
  as restrictive
  for select to authenticated
  using (id <> all ((select public.team_call_notes_hidden())));

notify pgrst, 'reload schema';

commit;
