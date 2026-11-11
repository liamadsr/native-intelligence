-- ============================================================
-- 574: Meeting links, the functions that write 573's tables. The app calls
-- the first five as the person (their JWT, so auth.uid() is theirs); the
-- public meeting routes (after checking a guest's signed cookie), LiveKit's
-- webhooks and the sweeper call the rest as the service role
-- (src/lib/meeting-links/store.ts).
-- ============================================================
--   meeting_create(meeting_ref, ws, meeting_title, token_digest, token_nonce,
--                     starts, minutes)  as the person, a member of the workspace:
--                     the meeting's conversation (kind 'meeting', its
--                     host its first member) and the meeting, with its link's
--                     window: from 15 minutes before `starts` until 2 hours
--                     after its end (`minutes` long, 30 when not given, 5 to
--                     480), or from now for 30 days when it has no time. The
--                     server makes the token and hands its sha256
--                     (token_digest), the meeting's id and the random nonce
--                     the token is keyed with (the server can show the host
--                     the link again; the token is never stored). At most 50
--                     a day per member.
--   meeting_new_link(target_meeting, token_digest, token_nonce)  as the
--                     person, its host only: a new link (a new nonce, a new
--                     token); the old one stops working, a revoked meeting's
--                     link works again, guests waiting on the old one are
--                     let go. The meeting and its conversation stay.
--   meeting_create_for(host_member, ...)  service role: the same, for a
--                     member the server already knows (the agent's calendar
--                     tool, a booked meeting's location); both go through
--                     meeting_make, which no client may call.
--   meeting_join(token_digest)  as the person: a member of the meeting's
--                     workspace who opened its link (they hold the token;
--                     its hash is all this takes) while it works joins its
--                     conversation. Returns where it is.
--   meeting_revoke(target_meeting)  as the person, its host only: the link
--                     stops working. Guests waiting are let go, guests in
--                     the call are taken out (565's team_call_eject outbox,
--                     identity 'guest-<id>'). The conversation stays.
--   meeting_guest_decide(target_guest, admit)  as the person, someone in the
--                     meeting's live call: a waiting guest admitted into
--                     that call, or declined. Once: a guest settled already
--                     answers with their state.
--   meeting_guest_remove(target_guest)  as the person, a member of the
--                     conversation: the guest is removed for good (their
--                     guest row and cookie never get in again; a new knock
--                     from anyone waits for a member's admit as always), out
--                     of the room if in it.
--   meeting_guest_request(target_meeting, guest_name, key, max_waiting)
--                     service role: a guest asks to join. Refused while the
--                     link does not work ('early', 'inactive'), or when
--                     max_waiting guests already wait, or five from this key
--                     (one office behind one address; 'full'); otherwise
--                     they wait. Says how many members are in its live call
--                     (none: the app tells the host).
--   meeting_guest_poll(target_guest, token_digest)  service role: the
--                     lobby's answer for a guest (and that they are still
--                     there: last_seen_at, written at most every 15 s). A
--                     waiting guest of a link that stopped working has left.
--                     Says whether they must see the notice before they may
--                     publish (needs_notice), and how many members are in
--                     the call (none: the host has left).
--   meeting_guest_ack(target_guest, token_digest)  service role: an
--                     admitted guest said go to the notice (the guest page's
--                     "Join with microphone", POST notice): what is on now,
--                     the notes round and the recording, is theirs to be in.
--   meeting_guest_only_calls(grace_seconds)  service role (the sweeper): a
--                     meeting's live calls with guests in them and no member
--                     for grace_seconds (a host's reconnect doesn't end it):
--                     for the app to end and close.
--   meeting_guest_leave(target_guest, token_digest)  service role: the
--                     guest went (the lobby's Cancel, the call's Leave, the
--                     tab closed): left, out of the count, and out of the
--                     room (a guest who says they left and stays connected
--                     is taken out). Removal and revoke eject every guest
--                     let into the live call the same way, connected or not.
--   meeting_guest_event(room_name, guest_ref, session_ref, is_join, event_at,
--                     session_joined_at)  service role: LiveKit's
--                     participant_joined or _left for a guest identity
--                     ('guest-<id>'), sessions ordered as 565 orders a
--                     member's. A join by a guest not admitted into this
--                     call (removed, declined, a link revoked, an old token)
--                     is refused and ejected.
--   meeting_guest_egress_claim(target_call, guest_ref, track_ref)  service
--                     role: 567's team_call_egress_claim for an admitted
--                     guest's microphone (the notes name them), only once
--                     they said go to this round of notes (notes_ack_round).
--   meeting_guest_fence()  service role (the sweeper): every guest
--                     connected who may no longer be (not admitted, the
--                     call ended, the link revoked or closed) marked out and
--                     put on the eject outbox.
--   meeting_rate_hit(bucket_name, key, max_hits, window_seconds)  service
--                     role: one hit of a public route's limit; false once
--                     the window holds more than max_hits.
--   team_call_people_now(call)  who is in a call now: its members joined
--                     and its guests in it (575's recounts use it).
--   meeting_guests_on_call_end  a trigger on team_call: a call that ends
--                     lets its admitted guests go (a later call of the
--                     meeting starts from its lobby again).
--
-- Lock order, as 565's: a call's row first, then its guests (and a
-- meeting's row before its guests), so no two of these wait on each other.
--
-- Additive. Idempotent. New functions and one trigger; no earlier function
-- is redefined here (575 redefines three of 565's counts). No backslashes
-- anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── Who is in a call ────────────────────────────────────────────────────────

create or replace function public.team_call_people_now(target_call uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select count(*)::integer from public.team_call_participant x where x.call_id = target_call and x.state = 'joined')
       + (select count(*)::integer from public.meeting_guest g where g.call_id = target_call and g.in_call);
$$;

-- A link works now: not revoked, within its window, its conversation not archived.
create or replace function public.meeting_is_open(m public.meeting)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.revoked_at is null
     and now() >= m.opens_at
     and now() < m.closes_at
     and exists (select 1 from public.team_chat_channel c where c.id = m.channel_id and c.archived_at is null);
$$;

-- ── As the person ───────────────────────────────────────────────────────────

-- The one maker of a meeting, for a host already known to be the workspace's
-- member (its two callers below say who). No client calls it.
create or replace function public.meeting_make(me uuid, meeting_ref uuid, ws uuid, meeting_title text, token_digest text, token_nonce text, starts timestamptz, minutes integer)
returns table (meeting_id uuid, channel_id uuid, opens_at timestamptz, closes_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  title_now text := left(regexp_replace(trim(coalesce(meeting_title, '')), '[[:space:]]+', ' ', 'g'), 80);
  length_min integer := coalesce(minutes, 30);
  ends timestamptz;
  opens timestamptz;
  closes timestamptz;
  ch uuid;
  made integer;
begin
  if me is null or not exists (select 1 from public.member m where m.id = me and m.workspace_id = ws) then
    raise exception 'meetings: not a member of this workspace' using errcode = '42501';
  end if;
  if meeting_ref is null or token_digest is null or char_length(token_digest) not between 40 and 128
     or token_nonce is null or char_length(token_nonce) not between 16 and 64 then
    raise exception 'meetings: no such link' using errcode = '22023';
  end if;
  if title_now = '' then
    raise exception 'meetings: a meeting needs a title' using errcode = '22023';
  end if;
  if length_min not between 5 and 480 then
    raise exception 'meetings: a meeting is 5 minutes to 8 hours' using errcode = '22023';
  end if;
  select count(*)::integer into made from public.meeting x where x.host_member_id = me and x.created_at > now() - interval '1 day';
  if made >= 50 then
    raise exception 'meetings: too many links today' using errcode = '22023';
  end if;
  if starts is null then
    opens := now();
    closes := now() + interval '30 days';
  else
    if starts > now() + interval '400 days' then
      raise exception 'meetings: that is too far ahead' using errcode = '22023';
    end if;
    ends := starts + make_interval(mins => length_min);
    opens := starts - interval '15 minutes';
    closes := ends + interval '2 hours';
    if closes <= now() then
      raise exception 'meetings: that time has passed' using errcode = '22023';
    end if;
  end if;

  insert into public.team_chat_channel (workspace_id, kind, name, created_by)
  values (ws, 'meeting', title_now, me)
  returning id into ch;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch, me, ws);
  insert into public.meeting (id, workspace_id, channel_id, host_member_id, title, token_hash, token_nonce, starts_at, ends_at, opens_at, closes_at)
  values (meeting_ref, ws, ch, me, title_now, token_digest, token_nonce, starts, ends, opens, closes);
  return query select meeting_ref, ch, opens, closes;
end;
$$;

-- As the person: they are the host.
create or replace function public.meeting_create(meeting_ref uuid, ws uuid, meeting_title text, token_digest text, token_nonce text, starts timestamptz, minutes integer)
returns table (meeting_id uuid, channel_id uuid, opens_at timestamptz, closes_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from public.meeting_make(public.current_member_id(ws), meeting_ref, ws, meeting_title, token_digest, token_nonce, starts, minutes);
$$;

-- As the service role, for a member the server already knows (the agent's
-- calendar tool, a booked meeting): that member is the host.
create or replace function public.meeting_create_for(host_member uuid, meeting_ref uuid, ws uuid, meeting_title text, token_digest text, token_nonce text, starts timestamptz, minutes integer)
returns table (meeting_id uuid, channel_id uuid, opens_at timestamptz, closes_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from public.meeting_make(host_member, meeting_ref, ws, meeting_title, token_digest, token_nonce, starts, minutes);
$$;

-- The host replaces the link: a new token (its hash and nonce); the old one stops working.
create or replace function public.meeting_new_link(target_meeting uuid, token_digest text, token_nonce text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.meeting%rowtype;
  me uuid;
begin
  select * into m from public.meeting x where x.id = target_meeting;
  if not found or not public.team_chat_can_read(m.channel_id) then
    raise exception 'meetings: no such meeting' using errcode = '42501';
  end if;
  me := public.current_member_id(m.workspace_id);
  if me is null or me is distinct from m.host_member_id then
    raise exception 'meetings: only the host can make a new link' using errcode = '42501';
  end if;
  if token_digest is null or char_length(token_digest) not between 40 and 128 or token_nonce is null or char_length(token_nonce) not between 16 and 64 then
    raise exception 'meetings: no such link' using errcode = '22023';
  end if;
  if now() >= m.closes_at then
    raise exception 'meetings: this meeting is over' using errcode = '22023';
  end if;
  perform 1 from public.meeting x where x.id = m.id for update;
  update public.meeting x
     set token_hash = token_digest, token_nonce = meeting_new_link.token_nonce, revoked_at = null, revoked_by = null
   where x.id = m.id;
  -- Guests waiting on the old link: its lobby is gone.
  update public.meeting_guest g set state = 'left' where g.meeting_id = m.id and g.state = 'waiting';
  return true;
end;
$$;

create or replace function public.meeting_join(token_digest text)
returns table (meeting_id uuid, channel_id uuid, workspace_id uuid, title text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  m public.meeting%rowtype;
  me uuid;
begin
  select * into m from public.meeting x where x.token_hash = token_digest;
  if not found then
    raise exception 'meetings: no such link' using errcode = '42501';
  end if;
  me := public.current_member_id(m.workspace_id);
  if me is null then
    raise exception 'meetings: no such link' using errcode = '42501';
  end if;
  -- Members come in whenever the link has not been revoked or run out (its start is for guests).
  if m.revoked_at is not null or now() >= m.closes_at
     or not exists (select 1 from public.team_chat_channel c where c.id = m.channel_id and c.archived_at is null) then
    raise exception 'meetings: this link is no longer active' using errcode = '22023';
  end if;
  insert into public.team_chat_member (channel_id, member_id, workspace_id)
  values (m.channel_id, me, m.workspace_id)
  on conflict (channel_id, member_id) do nothing;
  return query select m.id, m.channel_id, m.workspace_id, m.title;
end;
$$;

create or replace function public.meeting_revoke(target_meeting uuid)
returns table (revoked boolean, call_id uuid, room text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  m public.meeting%rowtype;
  live public.team_call%rowtype;
  me uuid;
begin
  select * into m from public.meeting x where x.id = target_meeting;
  if not found or not public.team_chat_can_read(m.channel_id) then
    raise exception 'meetings: no such meeting' using errcode = '42501';
  end if;
  me := public.current_member_id(m.workspace_id);
  if me is null or me is distinct from m.host_member_id then
    raise exception 'meetings: only the host can revoke the link' using errcode = '42501';
  end if;
  -- The lock order: the live call's row, then the meeting's, then its guests.
  select * into live from public.team_call t where t.channel_id = m.channel_id and t.status = 'live' for update;
  perform 1 from public.meeting x where x.id = m.id for update;
  if m.revoked_at is not null then
    return query select false, live.id, live.room;
    return;
  end if;
  update public.meeting x set revoked_at = now(), revoked_by = me where x.id = m.id;
  -- Every guest let into a live call: out of the room, whatever the count says (a join on its way, or
  -- a guest who said they left and stayed connected). A guest's identity is never let in again.
  insert into public.team_call_eject (call_id, room, identity, reason)
  select t.id, t.room, 'guest-' || g.id::text, 'access'
    from public.meeting_guest g
    join public.team_call t on t.id = g.call_id and t.status = 'live'
   where g.meeting_id = m.id and (g.in_call or g.state = 'admitted')
  on conflict do nothing;
  update public.meeting_guest g
     set state = 'left', in_call = false, left_at = case when g.in_call then now() else g.left_at end
   where g.meeting_id = m.id and g.state in ('waiting', 'admitted');
  if live.id is not null then
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id), updated_at = now()
     where t.id = live.id;
  end if;
  return query select true, live.id, live.room;
end;
$$;

create or replace function public.meeting_guest_decide(target_guest uuid, admit boolean)
returns table (state text, call_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  live public.team_call%rowtype;
  me uuid;
begin
  select * into g from public.meeting_guest x where x.id = target_guest;
  if not found or not public.team_chat_can_read(g.channel_id) then
    raise exception 'meetings: no such guest' using errcode = '42501';
  end if;
  me := public.current_member_id(g.workspace_id);
  select * into live from public.team_call t where t.channel_id = g.channel_id and t.status = 'live' for update;
  if not found then
    raise exception 'meetings: there is no call to let them into' using errcode = '22023';
  end if;
  if me is null or not exists (
    select 1 from public.team_call_participant p where p.call_id = live.id and p.member_id = me and p.state = 'joined'
  ) then
    raise exception 'meetings: only someone in the call can let a guest in' using errcode = '42501';
  end if;
  select * into g from public.meeting_guest x where x.id = target_guest for update;
  if g.state <> 'waiting' then
    -- Settled already (someone else answered, or they went).
    return query select g.state, g.call_id;
    return;
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  if not public.meeting_is_open(m) then
    update public.meeting_guest x set state = 'left' where x.id = g.id;
    return query select 'left'::text, null::uuid;
    return;
  end if;
  update public.meeting_guest x
     set state = case when coalesce(admit, false) then 'admitted' else 'declined' end,
         call_id = case when coalesce(admit, false) then live.id else null end,
         decided_at = now(), decided_by = me
   where x.id = g.id;
  return query select case when coalesce(admit, false) then 'admitted' else 'declined' end::text,
                      case when coalesce(admit, false) then live.id else null::uuid end;
end;
$$;

create or replace function public.meeting_guest_remove(target_guest uuid)
returns table (state text, ejected boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  g public.meeting_guest%rowtype;
  c public.team_call%rowtype;
  me uuid;
begin
  select * into g from public.meeting_guest x where x.id = target_guest;
  if not found or not public.team_chat_can_read(g.channel_id) then
    raise exception 'meetings: no such guest' using errcode = '42501';
  end if;
  me := public.current_member_id(g.workspace_id);
  if me is null then
    raise exception 'meetings: no such guest' using errcode = '42501';
  end if;
  -- The lock order: the meeting's live call first (the one a guest can be let into), then the guest.
  select * into c from public.team_call t where t.channel_id = g.channel_id and t.status = 'live' for update;
  select * into g from public.meeting_guest x where x.id = target_guest for update;
  if g.state = 'removed' then
    return query select 'removed'::text, false;
    return;
  end if;
  update public.meeting_guest x
     set state = 'removed', in_call = false, left_at = case when x.in_call then now() else x.left_at end,
         decided_at = now(), decided_by = me
   where x.id = g.id;
  -- Out of the room whenever they were let into the live call, connected or not (a join on its way,
  -- or a guest who said they left and stayed): a guest's identity is never let in again.
  if c.id is not null and g.call_id = c.id and (g.in_call or g.state = 'admitted') then
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (c.id, c.room, 'guest-' || g.id::text, 'access')
    on conflict do nothing;
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id), updated_at = now()
     where t.id = c.id;
  end if;
  return query select 'removed'::text, coalesce(c.id is not null and g.call_id = c.id and (g.in_call or g.state = 'admitted'), false);
end;
$$;

-- ── As the service role ─────────────────────────────────────────────────────

create or replace function public.meeting_guest_request(target_meeting uuid, guest_name text, key text, max_waiting integer)
returns table (outcome text, guest_id uuid, host_member_id uuid, members_in_call integer, call_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  m public.meeting%rowtype;
  name_now text := left(regexp_replace(trim(coalesce(guest_name, '')), '[[:space:]]+', ' ', 'g'), 60);
  waiting integer;
  made uuid;
  live uuid;
  inside integer := 0;
begin
  if name_now = '' or key is null or char_length(key) not between 16 and 128 then
    raise exception 'meetings: a guest needs a name' using errcode = '22023';
  end if;
  -- The meeting's row orders every request of one link (the cap below is then the truth).
  select * into m from public.meeting x where x.id = target_meeting for update;
  if not found then
    return query select 'inactive'::text, null::uuid, null::uuid, 0, null::uuid;
    return;
  end if;
  if m.revoked_at is null and now() < m.opens_at then
    return query select 'early'::text, null::uuid, m.host_member_id, 0, null::uuid;
    return;
  end if;
  if not public.meeting_is_open(m) then
    return query select 'inactive'::text, null::uuid, null::uuid, 0, null::uuid;
    return;
  end if;
  select count(*)::integer into waiting
    from public.meeting_guest g
   where g.meeting_id = m.id and g.state = 'waiting' and g.last_seen_at > now() - interval '2 minutes';
  -- At most five waiting from one address (a few colleagues behind one office's address), so one
  -- address can't fill the lobby for everyone.
  if waiting >= greatest(coalesce(max_waiting, 10), 1) or (
    select count(*) from public.meeting_guest g
      join public.meeting_guest_key k on k.guest_id = g.id
     where g.meeting_id = m.id and k.rate_key = key and g.state = 'waiting' and g.last_seen_at > now() - interval '2 minutes'
  ) >= 5 then
    return query select 'full'::text, null::uuid, null::uuid, 0, null::uuid;
    return;
  end if;
  insert into public.meeting_guest (meeting_id, workspace_id, channel_id, name, state)
  values (m.id, m.workspace_id, m.channel_id, name_now, 'waiting')
  returning id into made;
  insert into public.meeting_guest_key (guest_id, meeting_id, rate_key) values (made, m.id, key);
  select t.id into live from public.team_call t where t.channel_id = m.channel_id and t.status = 'live';
  if live is not null then
    select count(*)::integer into inside from public.team_call_participant p where p.call_id = live and p.state = 'joined';
  end if;
  return query select 'waiting'::text, made, m.host_member_id, inside, live;
end;
$$;

create or replace function public.meeting_guest_poll(target_guest uuid, token_digest text)
returns table (state text, call_id uuid, room text, notes boolean, recording text, open boolean, needs_notice boolean, members_in_call integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  live public.team_call%rowtype;
  is_open boolean;
begin
  select x.* into g from public.meeting_guest x join public.meeting y on y.id = x.meeting_id where x.id = target_guest and y.token_hash = token_digest;
  if not found then
    return;
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  is_open := public.meeting_is_open(m);
  if g.state = 'waiting' and not is_open then
    update public.meeting_guest x set state = 'left' where x.id = g.id and x.state = 'waiting';
    g.state := 'left';
  elsif g.state = 'waiting' and g.last_seen_at < now() - interval '15 seconds' then
    update public.meeting_guest x set last_seen_at = now() where x.id = g.id and x.state = 'waiting';
  end if;
  select * into live from public.team_call t where t.channel_id = g.channel_id and t.status = 'live';
  return query select g.state,
                      case when g.state = 'admitted' then g.call_id else null::uuid end,
                      case when g.state = 'admitted' and live.id = g.call_id then live.room else null::text end,
                      coalesce(live.notes, false),
                      coalesce(live.recording, 'off'),
                      is_open,
                      public.meeting_guest_needs_notice(g, live),
                      case when live.id is null then 0
                           else (select count(*)::integer from public.team_call_participant p where p.call_id = live.id and p.state = 'joined') end;
end;
$$;

-- Must this guest see the notice (and say go) before they may publish? While the call has notes on in a
-- round they haven't said go to, or a recording running they haven't said go to since it started.
create or replace function public.meeting_guest_needs_notice(g public.meeting_guest, c public.team_call)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id is not null and (
    (c.notes and g.notes_ack_round < c.notes_round)
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
  update public.meeting_guest x
     set notes_ack_round = greatest(x.notes_ack_round, c.notes_round),
         recording_ack_at = case when c.recording in ('starting', 'on') then now() else x.recording_ack_at end
   where x.id = g.id and x.state = 'admitted';
  return query select c.id, c.room;
end;
$$;

-- A meeting's live calls with guests in them and no member for grace_seconds: ended by the app.
create or replace function public.meeting_guest_only_calls(grace_seconds integer)
returns table (call_id uuid, room text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.room
    from public.team_call t
    join public.team_chat_channel ch on ch.id = t.channel_id and ch.kind = 'meeting'
   where t.status = 'live'
     and exists (select 1 from public.meeting_guest g where g.call_id = t.id and g.in_call)
     and not exists (select 1 from public.team_call_participant p where p.call_id = t.id and p.state = 'joined')
     and coalesce((select max(p.left_at) from public.team_call_participant p where p.call_id = t.id), t.started_at)
         < now() - make_interval(secs => greatest(coalesce(grace_seconds, 180), 0));
$$;

create or replace function public.meeting_guest_leave(target_guest uuid, token_digest text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.meeting_guest%rowtype;
  c public.team_call%rowtype;
begin
  select x.* into g from public.meeting_guest x join public.meeting y on y.id = x.meeting_id where x.id = target_guest and y.token_hash = token_digest;
  if not found then
    return 'unknown';
  end if;
  select * into c from public.team_call t where t.channel_id = g.channel_id and t.status = 'live' for update;
  select * into g from public.meeting_guest x where x.id = target_guest for update;
  if g.state not in ('waiting', 'admitted') then
    return g.state;
  end if;
  update public.meeting_guest x
     set state = 'left', in_call = false, left_at = case when x.in_call then now() else x.left_at end
   where x.id = g.id;
  -- Left means out: a guest who says so and stays connected is taken out of the room.
  if c.id is not null and g.call_id = c.id then
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (c.id, c.room, 'guest-' || g.id::text, 'access')
    on conflict do nothing;
  end if;
  if g.in_call and c.id is not null then
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id), updated_at = now()
     where t.id = c.id;
  end if;
  return 'left';
end;
$$;

create or replace function public.meeting_guest_event(room_name text, guest_ref uuid, session_ref text, is_join boolean, event_at timestamptz, session_joined_at timestamptz)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  joined_time timestamptz := coalesce(session_joined_at, event_at);
  outcome text;
  in_now integer;
begin
  -- The call's row lock orders every event of one call, a member's or a guest's.
  select * into c from public.team_call t where t.room = room_name for update;
  if not found then
    return 'unknown';
  end if;
  if c.status <> 'live' then
    return 'ended';
  end if;
  select * into g from public.meeting_guest x where x.id = guest_ref and x.channel_id = c.channel_id for update;
  if not found then
    if is_join then
      insert into public.team_call_eject (call_id, room, identity, reason)
      values (c.id, c.room, 'guest-' || guest_ref::text, 'access')
      on conflict do nothing;
      return 'ejected';
    end if;
    return 'unknown';
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  -- Not let into this call (removed, declined, left, a revoked link, an old token): out again.
  if is_join and (g.state <> 'admitted' or g.call_id is distinct from c.id or not public.meeting_is_open(m)) then
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (c.id, c.room, 'guest-' || g.id::text, 'access')
    on conflict do nothing;
    if g.in_call then
      update public.meeting_guest x set in_call = false, left_at = now(), last_event_at = greatest(coalesce(x.last_event_at, event_at), event_at) where x.id = g.id;
    end if;
    outcome := 'ejected';
  elsif is_join then
    if g.session_sid is not distinct from session_ref then
      outcome := case when g.in_call then 'same' else 'stale' end;
    elsif g.joined_at is not null and joined_time < g.joined_at then
      outcome := 'stale';
    else
      update public.meeting_guest x
         set in_call = true, session_sid = session_ref, joined_at = joined_time,
             first_joined_at = coalesce(x.first_joined_at, joined_time), left_at = null,
             last_event_at = greatest(coalesce(x.last_event_at, event_at), event_at)
       where x.id = g.id;
      outcome := 'joined';
    end if;
  else
    if g.session_sid is null then
      -- The leave came first: remember the session, so its late join is stale.
      update public.meeting_guest x
         set session_sid = session_ref, joined_at = joined_time, left_at = greatest(event_at, joined_time), last_event_at = event_at
       where x.id = g.id;
      outcome := 'left';
    elsif g.session_sid is not distinct from session_ref then
      if not g.in_call then
        outcome := 'same';
      else
        update public.meeting_guest x
           set in_call = false, left_at = greatest(event_at, x.joined_at), last_event_at = greatest(coalesce(x.last_event_at, event_at), event_at)
         where x.id = g.id;
        outcome := 'left';
      end if;
    elsif g.joined_at is not null and joined_time <= g.joined_at then
      -- An older session's leave, after a newer one joined (a reconnect).
      outcome := 'stale';
    else
      update public.meeting_guest x
         set in_call = false, session_sid = session_ref, joined_at = joined_time, left_at = greatest(event_at, joined_time),
             last_event_at = greatest(coalesce(x.last_event_at, event_at), event_at)
       where x.id = g.id;
      outcome := 'left';
    end if;
  end if;
  in_now := public.team_call_people_now(c.id);
  update public.team_call t
     set participant_count = in_now,
         peak_participants = greatest(t.peak_participants, in_now),
         updated_at = now()
   where t.id = c.id;
  return outcome;
end;
$$;

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
       and g.notes_ack_round >= c.notes_round
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

create or replace function public.meeting_guest_fence()
returns table (call_id uuid, room text, guest_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
begin
  for r in
    select g.call_id as cid, t.room as rm, g.id as gid
      from public.meeting_guest g
      join public.team_call t on t.id = g.call_id
      join public.meeting m on m.id = g.meeting_id
     where g.in_call
       and (t.status <> 'live' or g.state <> 'admitted' or not public.meeting_is_open(m))
     order by g.call_id
  loop
    perform 1 from public.team_call t where t.id = r.cid for update;
    update public.meeting_guest x
       set in_call = false, left_at = now(),
           state = case when x.state = 'admitted' then 'left' else x.state end
     where x.id = r.gid and x.in_call;
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (r.cid, r.rm, 'guest-' || r.gid::text, 'access')
    on conflict do nothing;
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id), updated_at = now()
     where t.id = r.cid and t.status = 'live';
    return query select r.cid, r.rm, r.gid;
  end loop;
end;
$$;

create or replace function public.meeting_rate_hit(bucket_name text, key text, max_hits integer, window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
  span interval := make_interval(secs => greatest(coalesce(window_seconds, 60), 1));
begin
  insert into public.meeting_rate as r (bucket, rate_key, window_start, hits)
  values (left(bucket_name, 80), left(key, 128), now(), 1)
  on conflict (bucket, rate_key) do update
     set hits = case when r.window_start <= now() - span then 1 else least(r.hits + 1, greatest(coalesce(max_hits, 0), 0) + 1) end,
         window_start = case when r.window_start <= now() - span then now() else r.window_start end
  returning r.hits into n;
  return n <= greatest(coalesce(max_hits, 0), 0);
end;
$$;

-- A call that ends lets its admitted guests go (565's team_call_end, unchanged).
create or replace function public.meeting_guests_on_call_end()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.meeting_guest g
     set state = 'left', in_call = false, left_at = case when g.in_call then coalesce(new.ended_at, now()) else g.left_at end
   where g.call_id = new.id and g.state = 'admitted';
  return null;
end;
$$;

drop trigger if exists meeting_guests_on_call_end on public.team_call;
create trigger meeting_guests_on_call_end
  after update of status on public.team_call
  for each row
  when (old.status = 'live' and new.status = 'ended')
  execute function public.meeting_guests_on_call_end();

revoke all on function public.team_call_people_now(uuid) from public, anon, authenticated;
revoke all on function public.meeting_is_open(public.meeting) from public, anon, authenticated;
revoke all on function public.meeting_make(uuid, uuid, uuid, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.meeting_create(uuid, uuid, text, text, text, timestamptz, integer) from public, anon;
revoke all on function public.meeting_create_for(uuid, uuid, uuid, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.meeting_new_link(uuid, text, text) from public, anon;
revoke all on function public.meeting_guest_needs_notice(public.meeting_guest, public.team_call) from public, anon, authenticated;
revoke all on function public.meeting_guest_ack(uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_only_calls(integer) from public, anon, authenticated;
revoke all on function public.meeting_join(text) from public, anon;
revoke all on function public.meeting_revoke(uuid) from public, anon;
revoke all on function public.meeting_guest_decide(uuid, boolean) from public, anon;
revoke all on function public.meeting_guest_remove(uuid) from public, anon;
revoke all on function public.meeting_guest_request(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.meeting_guest_poll(uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_leave(uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_event(text, uuid, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.meeting_guest_egress_claim(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_fence() from public, anon, authenticated;
revoke all on function public.meeting_rate_hit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.meeting_guests_on_call_end() from public, anon, authenticated;
grant execute on function public.team_call_people_now(uuid) to service_role;
grant execute on function public.meeting_create(uuid, uuid, text, text, text, timestamptz, integer) to authenticated;
grant execute on function public.meeting_create_for(uuid, uuid, uuid, text, text, text, timestamptz, integer) to service_role;
grant execute on function public.meeting_new_link(uuid, text, text) to authenticated;
grant execute on function public.meeting_guest_ack(uuid, text) to service_role;
grant execute on function public.meeting_guest_only_calls(integer) to service_role;
grant execute on function public.meeting_join(text) to authenticated;
grant execute on function public.meeting_revoke(uuid) to authenticated;
grant execute on function public.meeting_guest_decide(uuid, boolean) to authenticated;
grant execute on function public.meeting_guest_remove(uuid) to authenticated;
grant execute on function public.meeting_guest_request(uuid, text, text, integer) to service_role;
grant execute on function public.meeting_guest_poll(uuid, text) to service_role;
grant execute on function public.meeting_guest_leave(uuid, text) to service_role;
grant execute on function public.meeting_guest_event(text, uuid, text, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.meeting_guest_egress_claim(uuid, uuid, text) to service_role;
grant execute on function public.meeting_guest_fence() to service_role;
grant execute on function public.meeting_rate_hit(text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
