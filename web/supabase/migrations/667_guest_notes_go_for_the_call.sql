-- ============================================================
-- 667: A meeting guest's go to notes holds for the whole call. Until now a
-- guest said go to each ROUND of a call's notes (574's notes_ack_round
-- against the call's notes_round): when a member turned the notes off and on
-- again, a new round started, the server took every guest's publishing away
-- and each had to press "Join with microphone" again. Now a guest who has
-- said go to the notes once in a call is never held again in that call, and
-- the recorder keeps hearing them through every later round.
--
-- A guest row is one guest's one stay: it is let into one call (574's
-- meeting_guest_decide sets its call_id once), and a later call of the same
-- meeting starts from its lobby with a new row (574's
-- meeting_guests_on_call_end lets the admitted go). So "said go in this
-- call" is the row's own notes_ack_round above 0, and a new call on the same
-- link asks again.
--
-- notes_ack_round, from here on: 0 while the guest has never said go to the
-- notes; above 0 once they have, for the call their row is let into. It is
-- written by meeting_guest_ack (below: only while the call's notes are on,
-- so a go to a recording alone never counts as a go to notes) and by the
-- app when the guest's entry page itself said the notes are on and they
-- asked to join (POST /m/<token>/join, src/lib/meeting-links/consent.ts).
-- The recording keeps its own rule: recording_ack_at against the
-- recording's start, each recording asked for on its own.
--
--   meeting_guest_needs_notice(g, c)  notes on and the guest never said go
--                     in this call (was: a round they haven't), or a
--                     recording running they haven't said go to since it
--                     started (unchanged).
--   meeting_guest_ack(target_guest, token_digest)  as 574's, but the notes
--                     are counted only while they are on.
--   meeting_guest_egress_claim(target_call, guest_ref, track_ref)  as 574's:
--                     a notes file for a guest who said go in this call.
--   capture_feed_hearable_guests(s)  as 588's: the guests let into the
--                     session's call who said go in it.
--   capture_feed_append(p_session, p_producer_id, p_segments)  as 588's,
--                     word for word, but a guest's words are kept once they
--                     said go in the call, whatever the round.
--
-- Same signatures, same owners: each stays SECURITY DEFINER with its
-- search_path pinned, the service role's alone (its revoke and grant are
-- said again). No table or column changes, no data rewritten.
--
-- Either order with the app is safe. This file before the app's code (the
-- way production applies them): the old code's own check still holds a
-- guest at a new round (as today) until they press the button again, while
-- the database would already hear them. The code before this file: the app
-- no longer holds an agreed guest at a new round, but the database still
-- refuses their words in it (574's and 588's rules), so for that window they
-- are heard by the others and missing from the notes, never captured without
-- their go.
--
-- Additive. Idempotent (create or replace only). No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── The notice ──────────────────────────────────────────────────────────────

-- Must this guest see the notice (and say go) before they may publish? While the call has notes on and
-- they never said go to its notes, or a recording running they haven't said go to since it started.
create or replace function public.meeting_guest_needs_notice(g public.meeting_guest, c public.team_call)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id is not null and (
    (c.notes and g.notes_ack_round < 1)
    or (c.recording in ('starting', 'on') and (g.recording_ack_at is null or g.recording_ack_at < c.recording_started_at))
  );
$$;

create or replace function public.meeting_guest_ack(target_guest uuid, token_digest text)
returns table (call_id uuid, room text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  g public.meeting_guest%rowtype;
  c public.team_call%rowtype;
begin
  select x.* into g from public.meeting_guest x join public.meeting y on y.id = x.meeting_id where x.id = target_guest and y.token_hash = token_digest;
  if not found or g.state <> 'admitted' or g.call_id is null then
    return;
  end if;
  select * into c from public.team_call t where t.id = g.call_id and t.status = 'live' for update;
  if not found then
    return;
  end if;
  -- The notes count only while they are on (a go to a recording alone is not a go to notes); once
  -- counted, every later round of this call is theirs too.
  update public.meeting_guest x
     set notes_ack_round = case when c.notes then greatest(x.notes_ack_round, c.notes_round, 1) else x.notes_ack_round end,
         recording_ack_at = case when c.recording in ('starting', 'on') then now() else x.recording_ack_at end
   where x.id = g.id and x.state = 'admitted';
  return query select c.id, c.room;
end;
$$;

-- ── What of a guest is captured ─────────────────────────────────────────────

create or replace function public.meeting_guest_egress_claim(target_call uuid, guest_ref uuid, track_ref text)
returns table (egress_row uuid, file_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  row_id uuid := gen_random_uuid();
  path text;
  made uuid;
begin
  if track_ref is null or char_length(track_ref) not between 1 and 64 then
    return;
  end if;
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or c.status <> 'live' or not c.notes then
    return;
  end if;
  if not exists (
    select 1 from public.meeting_guest g
     where g.id = guest_ref and g.channel_id = c.channel_id and g.state = 'admitted' and g.call_id = c.id
       and g.notes_ack_round > 0
  ) then
    return;
  end if;
  path := c.channel_id::text || '/' || c.id::text || '/notes/' || row_id::text || '.ogg';
  insert into public.team_call_egress (id, call_id, workspace_id, channel_id, kind, member_id, guest_id, track_sid, round, file_path)
  values (row_id, c.id, c.workspace_id, c.channel_id, 'notes', null, guest_ref, track_ref, c.notes_round, path)
  on conflict (call_id, track_sid, round) where kind = 'notes' do nothing
  returning id into made;
  if made is null then
    return;
  end if;
  return query select made, path;
end;
$$;

-- The meeting guests who may be heard in a session: let into its call and said go to its notes, in any
-- round of it. A producer opens no transcription for any other guest.
create or replace function public.capture_feed_hearable_guests(s public.capture_feed_session)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(g.id order by g.id), '{}'::uuid[])
    from public.meeting_guest g
   where s.source_kind = 'team_call'
     and g.call_id = s.source_ref
     and g.state = 'admitted'
     and g.notes_ack_round > 0;
$$;

-- A guest's words: kept once they said go to the call's notes (588's, but for every round of the call).
create or replace function public.capture_feed_append(p_session uuid, p_producer_id text, p_segments jsonb)
returns table (outcome text, accepted integer, duplicate integer, dropped integer, transcript_length integer, capture_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  s public.capture_feed_session%rowtype;
  cap public.captures%rowtype;
  list jsonb := case when jsonb_typeof(p_segments) = 'array' then p_segments else '[]'::jsonb end;
  total integer;
  seg jsonb;
  seg_key text;
  speaker text;
  words text;
  start_at numeric;
  end_at numeric;
  said timestamptz;
  sp public.capture_feed_speaker%rowtype;
  n_accepted integer := 0;
  n_duplicate integer := 0;
  n_dropped integer := 0;
  lines text;
  stored_length integer;
  appended record;
  added text[] := '{}';
begin
  total := jsonb_array_length(list);
  select * into s from public.capture_feed_session x where x.id = p_session for update;
  if not found then
    return query select 'unknown'::text, 0, 0, total, null::integer, null::uuid;
    return;
  end if;
  if s.producer_id is distinct from p_producer_id then
    return query select 'taken'::text, 0, 0, total, null::integer, null::uuid;
    return;
  end if;
  select * into cap from public.captures x where x.id = s.capture_id for update;
  if cap.ended_at is not null or cap.is_transcript_locked then
    return query select 'locked'::text, 0, 0, total, coalesce(char_length(cap.transcript), 0), cap.id;
    return;
  end if;

  for seg in
    select e from jsonb_array_elements(list) as e
     order by case when jsonb_typeof(e -> 'start_ms') = 'number' then (e ->> 'start_ms')::numeric end nulls last
     limit 500
  loop
    seg_key := seg ->> 'key';
    speaker := seg ->> 'speaker';
    words := trim(regexp_replace(coalesce(seg ->> 'text', ''), '[[:space:]]+', ' ', 'g'));
    if seg_key is null or char_length(seg_key) not between 1 and 128 or speaker is null or char_length(speaker) not between 1 and 128
       or words = '' or jsonb_typeof(seg -> 'start_ms') is distinct from 'number' or jsonb_typeof(seg -> 'end_ms') is distinct from 'number' then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    start_at := (seg ->> 'start_ms')::numeric;
    end_at := (seg ->> 'end_ms')::numeric;
    if start_at < 0 or end_at < start_at then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    said := s.started_at + make_interval(secs => start_at / 1000);
    -- Said after the notes went off (or the call ended): never in the notes.
    if s.ended_at is not null and said >= s.ended_at then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    select * into sp from public.capture_feed_speaker x where x.capture_id = s.capture_id and x.speaker_key = speaker;
    if not found then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    -- A meeting's guest is in the notes only once they said go to this call's notes (any round of it).
    if sp.guest_id is not null and not exists (
      select 1 from public.meeting_guest g where g.id = sp.guest_id and g.notes_ack_round > 0
    ) then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    insert into public.capture_feed_segment (session_id, capture_id, key, speaker_key, start_ms, end_ms, said_at, text)
    values (s.id, s.capture_id, seg_key, speaker, floor(start_at)::bigint, floor(end_at)::bigint, said, left(words, 4000))
    on conflict (session_id, key) do nothing;
    if found then
      n_accepted := n_accepted + 1;
      added := added || seg_key;
    else
      n_duplicate := n_duplicate + 1;
    end if;
  end loop;

  stored_length := coalesce(char_length(cap.transcript), 0);
  if n_accepted > 0 then
    select string_agg('[' || x.label || '] ' || g.text, chr(10) order by g.said_at, g.key) into lines
      from public.capture_feed_segment g
      join public.capture_feed_speaker x on x.capture_id = g.capture_id and x.speaker_key = g.speaker_key
     where g.session_id = s.id and g.key = any (added);
    -- 192's compare-and-swap append (the capture's row is locked here, so it applies).
    select * into appended from public.append_capture_transcript(
      cap.id, cap.workspace_id, case when stored_length > 0 then chr(10) else '' end || lines, stored_length
    );
    if appended.status is distinct from 'applied' then
      raise exception 'capture feed: the transcript did not take the append (%)', appended.status using errcode = '40001';
    end if;
    stored_length := appended.server_length;
    update public.capture_feed_session x set segments = x.segments + n_accepted, updated_at = now() where x.id = s.id;
  end if;
  return query select 'applied'::text, n_accepted, n_duplicate, n_dropped, stored_length, cap.id;
end;
$$;

-- ── The sweeper and the recorder's work ─────────────────────────────────────


revoke all on function public.meeting_guest_needs_notice(public.meeting_guest, public.team_call) from public, anon, authenticated;
revoke all on function public.meeting_guest_ack(uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_egress_claim(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.capture_feed_hearable_guests(public.capture_feed_session) from public, anon, authenticated;
revoke all on function public.capture_feed_append(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.meeting_guest_ack(uuid, text) to service_role;
grant execute on function public.meeting_guest_egress_claim(uuid, uuid, text) to service_role;
grant execute on function public.capture_feed_append(uuid, text, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
