-- ============================================================
-- 587: The capture feed (one recorder per call, phase 1), the tables. A
-- producer on the server (the call recorder today: it joins a call's room,
-- hears each microphone and transcribes it as it is spoken) delivers a call's
-- speech to the app as it happens; the app writes it into ONE capture that
-- fills in live, in the capture system every other meeting uses. 588 is the
-- functions that write these tables; src/lib/capture-feed/ is the app's side.
-- ============================================================
--   capture_feed_session  one producer's feed of one source, for one round:
--                      source_kind 'team_call' (source_ref a team_call id,
--                      round its notes_round; one session per round of notes,
--                      every round into the call's one capture). A producer
--                      that joins a Meet, Teams or Zoom call for someone (a
--                      later phase) is another source_kind. started_at is the
--                      feed's clock: a segment's times are milliseconds from
--                      it, whichever process sends them. producer_kind and
--                      producer_id say who holds it; heartbeat_at is when it
--                      last said it was running. status: 'live', 'lost' (no
--                      heartbeat for a while: the sweeper's word; it may come
--                      back, and gaps records each stretch it was gone) or
--                      'ended' (the source no longer wants it, or the
--                      producer said so: end_reason). A segment said at or
--                      after ended_at never reaches the capture.
--                      delivered_at: the producer said it has delivered
--                      everything it heard (its `end`); a call's finish waits
--                      for it before it locks the capture.
--   capture_feed_segment  one final stretch of one speaker's speech, as the
--                      producer sent it: its key (the producer's idempotency
--                      key: a repeat is answered and skipped), the speaker's
--                      key, its times in the feed's clock and as a time
--                      (said_at), and its words. The capture's transcript is
--                      written from these: live in the order they arrive, and
--                      once more in the order they were said when it ends.
--   capture_feed_speaker  per capture and speaker key (the producer's own
--                      name for a voice: a call recorder's is the LiveKit
--                      identity, which is a member id or a guest's): its
--                      label in the transcript (kept here, so lines keep it
--                      if the person's row is deleted), the
--                      capture_participant row the voice is (one per person,
--                      whatever round; null once that row is deleted, and
--                      then the voice attests no one), the member or meeting
--                      guest it is, and whether they are in the call now
--                      (roster events, applied in the order they happened).
--   team_call_eject.feed_session  564's outbox of people to take out of a
--                      call's room, now also of a producer whose feed ended:
--                      the session the entry is for. The drain re-checks a
--                      producer's entry before it acts (588's
--                      capture_feed_settle_ejects): one that has a live
--                      session in the call's current round again (notes off,
--                      then on) is left in the room.
--   team_call_notes_shape  566's, but a call's capture exists while its
--                      notes are captured and finished, not only once they
--                      are ready: capture_id with 'capturing', 'transcribing'
--                      (finishing) or 'ready'.
--   capture_participant.source  082's ('calendar_event', 'manual',
--                      'voice_id'), plus 'call_roster': a row the server
--                      wrote from a call's roster, whose speaker_label is
--                      exactly that person's voice (one track is one known
--                      person). Its member_id, speaker_label, self_binding,
--                      is_self and source are the server's: no signed-in
--                      person writes them (capture_participant_roster_guard),
--                      so the auto-apply gate can trust them for any member,
--                      not only the capture's owner. One label per capture
--                      among these rows. 082 is added here too where a
--                      database lacks it.
--
-- RLS on every new table; no client has a grant on any (the server's
-- alone). Nothing here is published to Realtime: the capture's own row is.
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: the new tables are empty; team_call's check is replaced by a
-- wider one (validated in the same transaction: a scan of a small table);
-- capture_participant gains a check value, a partial unique index (built
-- inside the transaction; nothing has the new source yet, so it holds) and a
-- trigger that refuses only what no deployed code does; team_call_eject
-- gains a nullable column (no rewrite) the deployed app never reads. The
-- deployed app never reads the new tables. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A call's capture exists while its notes are captured ────────────────────

alter table public.team_call drop constraint if exists team_call_notes_shape;
alter table public.team_call
  add constraint team_call_notes_shape check (
    notes_state in ('none', 'capturing', 'transcribing', 'ready', 'silent', 'failed')
    and notes_seconds >= 0
    and notes_round >= 0
    and ((notes and status = 'live' and notes_on_since is not null) or (not notes and notes_on_since is null))
    and (not notes or notes_state = 'capturing')
    and (capture_id is null or notes_state in ('capturing', 'transcribing', 'ready'))
  ) not valid;
alter table public.team_call validate constraint team_call_notes_shape;

-- ── Sessions ────────────────────────────────────────────────────────────────

create table if not exists public.capture_feed_session (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade,
  source_kind text not null,
  source_ref uuid not null,
  round integer not null check (round >= 0),
  producer_kind text not null check (producer_kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  producer_id text not null check (producer_id ~ '^[A-Za-z0-9._-]{1,40}$'),
  status text not null default 'live' check (status in ('live', 'lost', 'ended')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason is null or char_length(end_reason) <= 40),
  delivered_at timestamptz,
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),
  segments integer not null default 0 check (segments >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_feed_session_shape check ((status = 'ended') = (ended_at is not null))
);

-- The kinds of source (named, so the next kind is one drop and add).
alter table public.capture_feed_session drop constraint if exists capture_feed_session_source_kind;
alter table public.capture_feed_session
  add constraint capture_feed_session_source_kind check (source_kind in ('team_call')) not valid;
alter table public.capture_feed_session validate constraint capture_feed_session_source_kind;

-- One session per source and round: a second start finds it.
create unique index if not exists capture_feed_session_one_per_round on public.capture_feed_session (source_kind, source_ref, round);
create index if not exists capture_feed_session_capture_idx on public.capture_feed_session (capture_id);
-- The sweeper's read: sessions that should be heartbeating.
create index if not exists capture_feed_session_open_idx on public.capture_feed_session (heartbeat_at) where status in ('live', 'lost');

-- ── Segments ────────────────────────────────────────────────────────────────

create table if not exists public.capture_feed_segment (
  session_id uuid not null references public.capture_feed_session(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 128),
  speaker_key text not null check (char_length(speaker_key) between 1 and 128),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null,
  said_at timestamptz not null,
  text text not null check (char_length(text) between 1 and 4000),
  received_at timestamptz not null default now(),
  primary key (session_id, key),
  constraint capture_feed_segment_times check (end_ms >= start_ms)
);
-- The transcript, in the order things were said.
create index if not exists capture_feed_segment_said_idx on public.capture_feed_segment (capture_id, said_at);

-- ── Speakers ────────────────────────────────────────────────────────────────

create table if not exists public.capture_feed_speaker (
  capture_id uuid not null references public.captures(id) on delete cascade,
  speaker_key text not null check (char_length(speaker_key) between 1 and 128),
  participant_id uuid references public.capture_participant(id) on delete set null,
  label text not null check (char_length(label) between 1 and 60),
  member_id uuid references public.member(id) on delete set null,
  guest_id uuid references public.meeting_guest(id) on delete set null,
  present boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (capture_id, speaker_key),
  constraint capture_feed_speaker_one_person check (member_id is null or guest_id is null)
);
create index if not exists capture_feed_speaker_participant_idx on public.capture_feed_speaker (participant_id);

alter table public.capture_feed_session enable row level security;
alter table public.capture_feed_segment enable row level security;
alter table public.capture_feed_speaker enable row level security;
revoke all on table public.capture_feed_session from anon, authenticated;
revoke all on table public.capture_feed_segment from anon, authenticated;
revoke all on table public.capture_feed_speaker from anon, authenticated;
grant select, insert, update, delete on table public.capture_feed_session to service_role;
grant select, insert, update, delete on table public.capture_feed_segment to service_role;
grant select, insert, update, delete on table public.capture_feed_speaker to service_role;

comment on table public.capture_feed_session is
  'A producer''s live feed of one source''s speech into one capture (587): a team call''s recorder today. Server only.';

-- ── A producer on the eject outbox: the session it is for ───────────────────

alter table public.team_call_eject add column if not exists feed_session uuid references public.capture_feed_session(id) on delete set null;
comment on column public.team_call_eject.feed_session is
  'For a producer''s entry (587): the feed session it ended or lost. The drain leaves the producer in the room when it has a live session in the call''s current round.';

-- ── A participant row the server attests ────────────────────────────────────

-- 082, where a database never had it.
alter table public.capture_participant add column if not exists source text default 'calendar_event';
create index if not exists capture_participant_source_idx on public.capture_participant (capture_id, source);

alter table public.capture_participant drop constraint if exists capture_participant_source_check;
alter table public.capture_participant
  add constraint capture_participant_source_check check (source in ('calendar_event', 'manual', 'voice_id', 'call_roster')) not valid;
alter table public.capture_participant validate constraint capture_participant_source_check;

-- One label per capture among the rows a roster wrote (a label is one person's voice).
create unique index if not exists capture_participant_roster_label on public.capture_participant (capture_id, lower(speaker_label))
  where source = 'call_roster' and speaker_label is not null;

comment on column public.capture_participant.source is
  'How the row came to be: calendar_event, manual, voice_id (082), or call_roster (587: written by the server from a call''s roster; its label is exactly that person''s voice, and no client may write it).';

-- A roster's row is the server's: no signed-in person makes one, or changes who it is,
-- what its voice is or what that is worth. Deleting one only takes evidence away.
create or replace function public.capture_participant_roster_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- A workspace merge (402) re-stamps rows table by table.
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.source = 'call_roster' then
      raise exception 'capture participants: only the server writes a call''s roster' using errcode = '42501';
    end if;
    return new;
  end if;
  if (old.source = 'call_roster' or new.source = 'call_roster')
     and (new.source is distinct from old.source
          or new.member_id is distinct from old.member_id
          or new.speaker_label is distinct from old.speaker_label
          or new.self_binding is distinct from old.self_binding
          or new.is_self is distinct from old.is_self
          or new.capture_id is distinct from old.capture_id) then
    raise exception 'capture participants: only the server writes a call''s roster' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.capture_participant_roster_guard() from public, anon, authenticated;

drop trigger if exists capture_participant_roster_guard on public.capture_participant;
create trigger capture_participant_roster_guard
  before insert or update on public.capture_participant
  for each row execute function public.capture_participant_roster_guard();

notify pgrst, 'reload schema';

commit;
