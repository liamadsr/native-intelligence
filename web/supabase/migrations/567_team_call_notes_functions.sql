-- ============================================================
-- 567: Team call notes and recordings, the functions that write 566's
-- columns and table. The app calls the first as the person (their JWT);
-- LiveKit's webhooks, the notes and recording routes, the notes' Inngest
-- functions and the sweeper call the rest as the service role
-- (src/lib/team-calls/notes-store.ts).
-- ============================================================
--   team_call_set_notes(target_call, turn_on)  as the person: turn the
--                     call's notes on or off. Only someone in the call now,
--                     or the one who started it before LiveKit has said
--                     they joined (who starts it with notes on when their
--                     "Auto-record meetings" setting is on), never after
--                     they left. Off keeps what
--                     was written so far. A call's notes stop for good at
--                     3 hours (10800 seconds) of notes: turning them on past
--                     that is refused. Returns the state and whether it
--                     changed (a second press changes nothing).
--   team_call_notes_stop(target_call)  service role: notes off, by the
--                     server (the 3-hour bound).
--   team_call_egress_claim(target_call, member_ref, track_ref)  service
--                     role: a microphone track was published while notes
--                     are on: its file's row and name, once per track and
--                     round of notes (a repeated webhook gets nothing).
--   team_call_recording_begin(target_call, member_ref, max_live)  service
--                     role: someone in the call asked to record it. At most
--                     max_live recordings run at once across the server (a
--                     transaction lock orders every claim); one at a time
--                     per call; once one is saved, that is the call's.
--   team_call_egress_event(row_ref, egress_ref, new_status, at_ns,
--                     file_started, file_ended, file_duration_ms, file_size,
--                     failure)  service role: an egress's state, as LiveKit
--                     reported it at at_ns (its updatedAt, in nanoseconds;
--                     the app's own word that one failed carries the time it
--                     said so, so only a newer finish from LiveKit, a real
--                     file after all, can follow it).
--                     Applied in that order: an older or repeated event
--                     changes nothing, a finished egress only ever takes a
--                     newer finish. A recording's state follows onto its
--                     call (on, saved, failed).
--   team_call_notes_on_end  a trigger on team_call: a call that ends (by
--                     565's team_call_end, unchanged) has its notes off with
--                     their time counted, and 'transcribing' when they were
--                     ever on.
--   team_call_attach_notes(target_call, owner_user, capture_title,
--                     transcript_text, notes_text, people, meta)  service
--                     role: the call's notes are written. One capture, once
--                     (a second call returns the first): private to its
--                     owner, its conversation written on it
--                     (notes_channel_id, 566's fences), shared with that
--                     conversation by one
--                     entity_access grant (492; source 'team_call'), with a
--                     participant row for each person who was in the call.
--   team_call_notes_settle(target_call, final_state)  service role: notes
--                     that end with no capture: 'silent' (nothing was said)
--                     or 'failed'.
--
-- Lock order, as 565's: a call's row first, then its egresses, so no two of
-- these wait on each other.
--
-- Additive. Idempotent. New functions and one trigger; no function of 565
-- is redefined. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── As the person ───────────────────────────────────────────────────────────

create or replace function public.team_call_set_notes(target_call uuid, turn_on boolean)
returns table (notes boolean, notes_round integer, changed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  me uuid;
  spent integer;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or not public.team_chat_can_read(c.channel_id) then
    raise exception 'team calls: no such call' using errcode = '42501';
  end if;
  if c.status <> 'live' then
    raise exception 'team calls: the call has ended' using errcode = '22023';
  end if;
  me := public.current_member_id(c.workspace_id);
  -- In the call now; or its starter before LiveKit has said they joined (never after they left).
  if me is null or not (
    exists (
      select 1 from public.team_call_participant p
       where p.call_id = c.id and p.member_id = me and p.state = 'joined'
    )
    or (
      me is not distinct from c.started_by
      and not exists (select 1 from public.team_call_participant p where p.call_id = c.id and p.member_id = me)
    )
  ) then
    raise exception 'team calls: only someone in the call can change its notes' using errcode = '42501';
  end if;
  if coalesce(turn_on, false) = c.notes then
    return query select c.notes, c.notes_round, false;
    return;
  end if;
  if turn_on then
    if c.notes_seconds >= 10800 then
      raise exception 'team calls: this call has 3 hours of notes already' using errcode = '22023';
    end if;
    update public.team_call t
       set notes = true, notes_on_since = now(), notes_round = t.notes_round + 1, notes_state = 'capturing',
           notes_by = me, notes_changed_at = now(), updated_at = now()
     where t.id = c.id;
    return query select true, c.notes_round + 1, true;
  else
    spent := greatest(0, floor(extract(epoch from (now() - c.notes_on_since)))::integer);
    update public.team_call t
       set notes = false, notes_on_since = null, notes_seconds = t.notes_seconds + spent,
           notes_by = me, notes_changed_at = now(), updated_at = now()
     where t.id = c.id;
    return query select false, c.notes_round, true;
  end if;
end;
$$;

-- ── As the service role ─────────────────────────────────────────────────────

create or replace function public.team_call_notes_stop(target_call uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or not c.notes then
    return false;
  end if;
  update public.team_call t
     set notes = false, notes_on_since = null,
         notes_seconds = t.notes_seconds + greatest(0, floor(extract(epoch from (now() - c.notes_on_since)))::integer),
         notes_by = null, notes_changed_at = now(), updated_at = now()
   where t.id = c.id;
  return true;
end;
$$;

create or replace function public.team_call_egress_claim(target_call uuid, member_ref uuid, track_ref text)
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
  if not exists (select 1 from public.member m where m.id = member_ref and m.workspace_id = c.workspace_id) then
    return;
  end if;
  path := c.channel_id::text || '/' || c.id::text || '/notes/' || row_id::text || '.ogg';
  insert into public.team_call_egress (id, call_id, workspace_id, channel_id, kind, member_id, track_sid, round, file_path)
  values (row_id, c.id, c.workspace_id, c.channel_id, 'notes', member_ref, track_ref, c.notes_round, path)
  on conflict (call_id, track_sid, round) where kind = 'notes' do nothing
  returning id into made;
  if made is null then
    return;
  end if;
  return query select made, path;
end;
$$;

create or replace function public.team_call_recording_begin(target_call uuid, member_ref uuid, max_live integer)
returns table (outcome text, egress_row uuid, file_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  row_id uuid := gen_random_uuid();
  path text;
  running integer;
begin
  -- Every claim in turn: the count below is then the truth.
  perform pg_advisory_xact_lock(566001);
  select * into c from public.team_call t where t.id = target_call for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::text;
    return;
  end if;
  if c.status <> 'live' then
    return query select 'ended'::text, null::uuid, null::text;
    return;
  end if;
  if not exists (
    select 1 from public.team_call_participant p
     where p.call_id = c.id and p.member_id = member_ref and p.state = 'joined'
  ) then
    return query select 'not_in_call'::text, null::uuid, null::text;
    return;
  end if;
  if c.recording in ('starting', 'on') then
    return query select 'already'::text, null::uuid, null::text;
    return;
  end if;
  if c.recording = 'saved' then
    return query select 'saved'::text, null::uuid, null::text;
    return;
  end if;
  select count(*)::integer into running from public.team_call t where t.recording in ('starting', 'on');
  if running >= greatest(coalesce(max_live, 1), 0) then
    return query select 'busy'::text, null::uuid, null::text;
    return;
  end if;
  path := c.channel_id::text || '/' || c.id::text || '/recording/' || row_id::text || '.mp4';
  insert into public.team_call_egress (id, call_id, workspace_id, channel_id, kind, member_id, file_path, transcript_status)
  values (row_id, c.id, c.workspace_id, c.channel_id, 'recording', member_ref, path, 'none');
  update public.team_call t
     set recording = 'starting', recording_by = member_ref, recording_started_at = now(), recording_ended_at = null, updated_at = now()
   where t.id = c.id;
  return query select 'claimed'::text, row_id, path;
end;
$$;

create or replace function public.team_call_egress_event(
  row_ref uuid, egress_ref text, new_status text, at_ns bigint,
  file_started timestamptz, file_ended timestamptz, file_duration_ms bigint, file_size bigint, failure text
)
returns table (outcome text, egress_row uuid, call_id uuid, kind text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  the_call uuid;
  e public.team_call_egress%rowtype;
  finished constant text[] := array['complete', 'failed', 'aborted', 'limit'];
  stamp bigint := greatest(coalesce(at_ns, 0), 0);
  has_file boolean;
begin
  if new_status is null or new_status not in ('starting', 'active', 'ending', 'complete', 'failed', 'aborted', 'limit') then
    raise exception 'team calls: no such egress status' using errcode = '22023';
  end if;
  select x.call_id into the_call from public.team_call_egress x
   where (row_ref is not null and x.id = row_ref) or (row_ref is null and egress_ref is not null and x.egress_id = egress_ref);
  if the_call is null then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- The lock order: the call's row, then its egress.
  perform 1 from public.team_call t where t.id = the_call for update;
  select * into e from public.team_call_egress x
   where (row_ref is not null and x.id = row_ref) or (row_ref is null and x.egress_id = egress_ref)
     for update;
  if e.egress_id is not null and egress_ref is not null and e.egress_id <> egress_ref then
    -- A file name that is this row's, from an egress that is not its own.
    return query select 'unknown'::text, e.id, e.call_id, e.kind, e.status;
    return;
  end if;
  if e.egress_id is null and egress_ref is not null then
    update public.team_call_egress x set egress_id = left(egress_ref, 128), updated_at = now() where x.id = e.id;
  end if;
  if stamp < e.status_at_ns
     or (e.status = any (finished) and (not (new_status = any (finished)) or stamp <= e.status_at_ns))
     or (stamp = e.status_at_ns and new_status = e.status) then
    return query select 'stale'::text, e.id, e.call_id, e.kind, e.status;
    return;
  end if;
  has_file := new_status in ('complete', 'limit') and coalesce(file_size, 0) > 0;
  update public.team_call_egress x
     set status = new_status,
         status_at_ns = stamp,
         started_at = coalesce(file_started, x.started_at),
         ended_at = coalesce(file_ended, x.ended_at, case when new_status = any (finished) then now() end),
         duration_ms = coalesce(file_duration_ms, x.duration_ms),
         size_bytes = coalesce(file_size, x.size_bytes),
         error = coalesce(left(nullif(failure, ''), 500), x.error),
         transcript_status = case
           when x.kind <> 'notes' then 'none'
           when not (new_status = any (finished)) then x.transcript_status
           -- A file after all (LiveKit's newer finish after the app's own failure): its words are wanted.
           when has_file then case when x.transcript_status = 'none' then 'pending' else x.transcript_status end
           when new_status in ('complete', 'limit') then 'empty'
           else 'none'
         end,
         updated_at = now()
   where x.id = e.id;
  if e.kind = 'recording' then
    update public.team_call t
       set recording = case
             when new_status = 'active' and t.recording = 'starting' then 'on'
             when has_file then 'saved'
             when new_status = any (finished) and t.recording in ('starting', 'on') then 'failed'
             else t.recording
           end,
           recording_ended_at = case when new_status = any (finished) then coalesce(file_ended, now()) else t.recording_ended_at end,
           updated_at = now()
     where t.id = e.call_id;
  end if;
  return query select 'applied'::text, e.id, e.call_id, e.kind, new_status;
end;
$$;

-- A call that ends (565's team_call_end, whatever its reason): its notes go
-- off with their time counted, and notes that were ever on are
-- 'transcribing' (the files are turned into notes next). A trigger, so 565's
-- function stays exactly as 565 has it.
create or replace function public.team_call_notes_on_end()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.notes and old.notes_on_since is not null then
    new.notes_seconds := old.notes_seconds + greatest(0, floor(extract(epoch from (
      greatest(coalesce(new.ended_at, now()), old.notes_on_since) - old.notes_on_since
    )))::integer);
  end if;
  new.notes := false;
  new.notes_on_since := null;
  if new.notes_state = 'capturing' then
    new.notes_state := 'transcribing';
  end if;
  return new;
end;
$$;

revoke all on function public.team_call_notes_on_end() from public, anon, authenticated;

drop trigger if exists team_call_notes_on_end on public.team_call;
create trigger team_call_notes_on_end
  before update of status on public.team_call
  for each row
  when (old.status = 'live' and new.status = 'ended')
  execute function public.team_call_notes_on_end();

create or replace function public.team_call_attach_notes(
  target_call uuid, owner_user uuid, capture_title text, transcript_text text, notes_text text, people jsonb, meta jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
  owner_member uuid;
  made uuid;
  person jsonb;
  person_member uuid;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found then
    raise exception 'team calls: no such call' using errcode = '22023';
  end if;
  if c.capture_id is not null then
    return c.capture_id;
  end if;
  if c.status <> 'ended' or c.notes_state <> 'transcribing' then
    raise exception 'team calls: these notes are not being written' using errcode = '22023';
  end if;
  select m.id into owner_member from public.member m where m.user_id = owner_user and m.workspace_id = c.workspace_id;
  if owner_member is null then
    raise exception 'team calls: the notes'' owner is not in the workspace' using errcode = '22023';
  end if;

  insert into public.captures (
    user_id, workspace_id, title, transcript, user_notes, status, recorded_at, started_at, ended_at,
    duration_seconds, visibility, live_mode, is_transcript_locked, metadata, notes_channel_id
  )
  values (
    owner_user, c.workspace_id, left(coalesce(nullif(trim(capture_title), ''), 'Call'), 200), transcript_text, nullif(notes_text, ''),
    'active', c.started_at, c.started_at, c.ended_at, c.duration_seconds, 'private', false, true,
    coalesce(meta, '{}'::jsonb) || jsonb_build_object(
      'source', 'team_call', 'team_call_id', c.id, 'channel_id', c.channel_id, 'message_id', c.message_id
    ),
    c.channel_id
  )
  returning id into made;

  for person in select x from jsonb_array_elements(coalesce(people, '[]'::jsonb)) as x loop
    person_member := nullif(person ->> 'member_id', '')::uuid;
    continue when person_member is null;
    continue when not exists (select 1 from public.member m where m.id = person_member and m.workspace_id = c.workspace_id);
    insert into public.capture_participant (
      capture_id, member_id, contact_id, external_name, speaker_label, role, joined_at, left_at, is_self, self_binding, source
    )
    values (
      made, person_member,
      (select ct.id from public.contact ct where ct.workspace_id = c.workspace_id and ct.member_id = person_member limit 1),
      left(nullif(person ->> 'name', ''), 120),
      left(nullif(person ->> 'label', ''), 40),
      case when person_member is not distinct from c.started_by then 'organizer' else 'attendee' end,
      nullif(person ->> 'joined_at', '')::timestamptz,
      nullif(person ->> 'left_at', '')::timestamptz,
      person_member = owner_member,
      case when person_member = owner_member then 'confirmed' else 'none' end,
      'manual'
    );
  end loop;

  update public.team_call t set capture_id = made, notes_state = 'ready', updated_at = now() where t.id = c.id;
  -- Shared with the call's conversation, and no one else (566's fence).
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_channel_id, level, granted_by, source)
  values (c.workspace_id, 'capture', made, 'channel', c.channel_id, 'view', owner_member, 'team_call')
  on conflict do nothing;
  return made;
end;
$$;

create or replace function public.team_call_notes_settle(target_call uuid, final_state text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  done uuid;
begin
  if final_state is null or final_state not in ('silent', 'failed') then
    raise exception 'team calls: no such notes state' using errcode = '22023';
  end if;
  update public.team_call t
     set notes_state = final_state, updated_at = now()
   where t.id = target_call and t.notes_state = 'transcribing'
  returning t.id into done;
  return done is not null;
end;
$$;

revoke all on function public.team_call_set_notes(uuid, boolean) from public, anon;
revoke all on function public.team_call_notes_stop(uuid) from public, anon, authenticated;
revoke all on function public.team_call_egress_claim(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.team_call_recording_begin(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.team_call_egress_event(uuid, text, text, bigint, timestamptz, timestamptz, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.team_call_attach_notes(uuid, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.team_call_notes_settle(uuid, text) from public, anon, authenticated;
grant execute on function public.team_call_set_notes(uuid, boolean) to authenticated;
grant execute on function public.team_call_notes_stop(uuid) to service_role;
grant execute on function public.team_call_egress_claim(uuid, uuid, text) to service_role;
grant execute on function public.team_call_recording_begin(uuid, uuid, integer) to service_role;
grant execute on function public.team_call_egress_event(uuid, text, text, bigint, timestamptz, timestamptz, bigint, bigint, text) to service_role;
grant execute on function public.team_call_attach_notes(uuid, uuid, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.team_call_notes_settle(uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
