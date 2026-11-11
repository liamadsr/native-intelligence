-- 583: availability (phase 5): polls, an offer of a handful of times to
-- several outside guests, booked when everyone has answered.
--
-- An offer (554) went to one guest who picked one time ('pick'). A poll
-- ('poll') goes to two to eight outside guests at once, optionally with some
-- of the host's teammates as co-hosts: every guest gets their own link
-- (/t/<token>), marks EVERY time that works for them (or none, with a note)
-- and can change it until it is booked. When the last guest has answered,
-- the earliest time that works for everyone is booked through the one
-- booking path (581 write_meeting_booking): one meeting_booking (source
-- 'poll'), a claim on every host's time, one calendar event with every guest
-- who has an email invited by the provider (src/lib/time-offers/polls.ts).
-- A single offer is unchanged: a pick is a poll of one guest that books on
-- the first pick, its guest kept on time_offer itself.
--
--   1. time_offer             mode ('pick' or 'poll') and co_host_ids (our
--                             own people who attend; their time is held with
--                             the host's). A poll has no token of its own:
--                             each of its guests has one.
--   2. time_offer_recipient   a poll's guests, each with their own link's
--                             token hash (null until the poll is sent), their
--                             answer's time, how it came (their page, the
--                             host's agent reading a reply, the business's
--                             assistant reading a text, or their own
--                             calendar: a linked guest whose free/busy the
--                             host's agent may read), their note, a daily cap
--                             on saves, nudges, and once booked whether they
--                             attend and their own manage link's hash
--                             (/b/<token>: they can say they can't make it).
--   3. time_offer_response    one row per guest and time: works or not.
--   4. answer_time_offer      a guest's whole answer, under the offer's lock
--                             (the lock the pick takes): replaced, never
--                             merged; how many guests are still to answer.
--   5. book_time_offer_poll   the booking, under the same lock: the offer
--                             still open, the time still open, everyone's
--                             answer still saying it works (unless the host
--                             books it anyway, with whoever they name), then
--                             the holds go and the booking and a claim per
--                             host are written in one block. Two last answers
--                             at once make one booking: the second reads it.
--
-- RLS on, and only the service role reads or writes (as 554's tables: every
-- reader is on the server, and a guest's answers are nobody's in the
-- workspace to read from their own client). Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: every offer
-- read selects mode and co_host_ids.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. time_offer: polls and co-hosts
-- ------------------------------------------------------------

alter table public.time_offer add column if not exists mode text not null default 'pick';
alter table public.time_offer add column if not exists co_host_ids uuid[] not null default '{}';

comment on column public.time_offer.mode is
  'pick: one guest picks one time (554; the guest is recipient_*, the link token_hash). poll: several guests each mark every time that works (time_offer_recipient, each with their own link); booked when all have answered (583).';
comment on column public.time_offer.co_host_ids is
  'The host''s teammates who attend a poll''s meeting (583): their time is held with the host''s, and the booking claims it.';

alter table public.time_offer drop constraint if exists time_offer_mode_check;
alter table public.time_offer
  add constraint time_offer_mode_check check (mode in ('pick', 'poll'));
alter table public.time_offer drop constraint if exists time_offer_open_has_token;
alter table public.time_offer
  add constraint time_offer_open_has_token check (mode = 'poll' or state not in ('open', 'booked') or token_hash is not null);
alter table public.time_offer drop constraint if exists time_offer_co_hosts_count;
alter table public.time_offer
  add constraint time_offer_co_hosts_count check (coalesce(array_length(co_host_ids, 1), 0) <= 10);

-- ------------------------------------------------------------
-- 2. time_offer_recipient
-- ------------------------------------------------------------

create table if not exists public.time_offer_recipient (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.time_offer(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  position integer not null default 0,
  name text not null,
  email text null,
  phone text null,
  contact_id uuid null references public.contact(id) on delete set null,
  peer_user_id uuid null references auth.users(id) on delete set null,
  token_hash text null,
  manage_token_hash text null,
  answered_at timestamptz null,
  answered_via text null,
  note text null,
  saves integer not null default 0,
  saves_since timestamptz null,
  nudges integer not null default 0,
  nudged_at timestamptz null,
  attending boolean null,
  declined_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.time_offer_recipient is
  'One guest of a poll (583). token_hash: sha256 of their /t/<token> link, null until sent. answered_at null: still to answer. attending: null until booked, then whether they are on the meeting; manage_token_hash their /b/<token> link''s.';
comment on column public.time_offer_recipient.answered_via is
  'link (their page), host (the host''s agent reading their reply), text (the business''s assistant reading their text) or calendar (a linked guest''s free/busy, read with their grant).';
comment on column public.time_offer_recipient.peer_user_id is
  'A linked guest: the Native Intelligence user whose agent is linked with the host''s and lets it read their free/busy.';

alter table public.time_offer_recipient drop constraint if exists time_offer_recipient_via_check;
alter table public.time_offer_recipient
  add constraint time_offer_recipient_via_check check (answered_via is null or answered_via in ('link', 'host', 'text', 'calendar'));
alter table public.time_offer_recipient drop constraint if exists time_offer_recipient_phone_shape;
alter table public.time_offer_recipient
  add constraint time_offer_recipient_phone_shape check (phone is null or phone ~ '^[+][1-9][0-9]{7,14}$');
alter table public.time_offer_recipient drop constraint if exists time_offer_recipient_counts;
alter table public.time_offer_recipient
  add constraint time_offer_recipient_counts check (position between 0 and 19 and saves >= 0 and nudges between 0 and 10);
alter table public.time_offer_recipient drop constraint if exists time_offer_recipient_text_lengths;
alter table public.time_offer_recipient
  add constraint time_offer_recipient_text_lengths check (
    char_length(btrim(name)) between 1 and 120
    and (email is null or char_length(email) <= 200)
    and (note is null or char_length(note) <= 500)
  );

create unique index if not exists time_offer_recipient_position_key on public.time_offer_recipient (offer_id, position);
create unique index if not exists time_offer_recipient_token_hash_key on public.time_offer_recipient (token_hash) where token_hash is not null;
create unique index if not exists time_offer_recipient_manage_hash_key on public.time_offer_recipient (manage_token_hash) where manage_token_hash is not null;
create index if not exists time_offer_recipient_workspace_idx on public.time_offer_recipient (workspace_id);
create index if not exists time_offer_recipient_phone_idx on public.time_offer_recipient (workspace_id, phone) where phone is not null;
create index if not exists time_offer_recipient_contact_idx on public.time_offer_recipient (contact_id) where contact_id is not null;
create index if not exists time_offer_recipient_peer_idx on public.time_offer_recipient (peer_user_id) where peer_user_id is not null;

-- ------------------------------------------------------------
-- 3. time_offer_response
-- ------------------------------------------------------------

create table if not exists public.time_offer_response (
  recipient_id uuid not null references public.time_offer_recipient(id) on delete cascade,
  slot_id uuid not null references public.time_offer_slot(id) on delete cascade,
  offer_id uuid not null references public.time_offer(id) on delete cascade,
  works boolean not null,
  answered_at timestamptz not null default now(),
  primary key (recipient_id, slot_id)
);

comment on table public.time_offer_response is
  'One poll guest''s answer for one time (583): it works for them or not. A guest''s answer is replaced whole when they change it.';

create index if not exists time_offer_response_slot_idx on public.time_offer_response (slot_id);
create index if not exists time_offer_response_offer_idx on public.time_offer_response (offer_id);

-- ------------------------------------------------------------
-- 4. answer_time_offer: one guest's whole answer, under the offer's lock
-- ------------------------------------------------------------

create or replace function public.answer_time_offer(
  p_offer_id uuid,
  p_recipient_id uuid,
  p_works uuid[],
  p_note text,
  p_via text,
  p_save_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.time_offer%rowtype;
  v_rec public.time_offer_recipient%rowtype;
  v_waiting integer;
begin
  -- The pick's lock: an answer and a booking of one poll never interleave.
  select * into v_offer from public.time_offer where id = p_offer_id for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  select * into v_rec from public.time_offer_recipient where id = p_recipient_id and offer_id = p_offer_id;
  if not found or v_offer.mode <> 'poll' then
    return jsonb_build_object('status', 'missing');
  end if;
  if v_offer.state = 'booked' then
    return jsonb_build_object('status', 'booked', 'booking_id', v_offer.booking_id);
  end if;
  if v_offer.state <> 'open' or v_offer.expires_at <= now() then
    return jsonb_build_object('status', 'closed', 'state', v_offer.state);
  end if;
  if p_via is null or p_via not in ('link', 'host', 'text', 'calendar') then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Only the poll's own times.
  if exists (
    select 1 from unnest(coalesce(p_works, '{}'::uuid[])) as w(id)
    where not exists (select 1 from public.time_offer_slot s where s.id = w.id and s.offer_id = p_offer_id and s.state = 'open')
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- A page's saves are capped a day; the agents' never are.
  if p_save_cap is not null and v_rec.saves_since is not null and v_rec.saves_since > now() - interval '1 day' and v_rec.saves >= p_save_cap then
    return jsonb_build_object('status', 'limited');
  end if;

  delete from public.time_offer_response where recipient_id = p_recipient_id;
  insert into public.time_offer_response (recipient_id, slot_id, offer_id, works, answered_at)
  select p_recipient_id, s.id, p_offer_id, s.id = any(coalesce(p_works, '{}'::uuid[])), now()
  from public.time_offer_slot s
  where s.offer_id = p_offer_id and s.state = 'open';

  update public.time_offer_recipient
    set answered_at = now(),
        answered_via = p_via,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        saves = case when saves_since is not null and saves_since > now() - interval '1 day' then saves + 1 else 1 end,
        saves_since = case when saves_since is not null and saves_since > now() - interval '1 day' then saves_since else now() end,
        updated_at = now()
    where id = p_recipient_id;

  select count(*) into v_waiting from public.time_offer_recipient where offer_id = p_offer_id and answered_at is null;
  return jsonb_build_object('status', 'recorded', 'waiting', v_waiting);
end;
$$;

comment on function public.answer_time_offer(uuid, uuid, uuid[], text, text, integer) is
  'Records one poll guest''s whole answer (583) under the offer''s lock: the times that work (only the poll''s open ones), the rest not; their note; how it came. Returns status recorded (with waiting: guests still to answer), booked, closed, limited (p_save_cap saves in a day), invalid or missing. Service role only.';

revoke execute on function public.answer_time_offer(uuid, uuid, uuid[], text, text, integer) from public, anon, authenticated;
grant execute on function public.answer_time_offer(uuid, uuid, uuid[], text, text, integer) to service_role;

-- ------------------------------------------------------------
-- 5. book_time_offer_poll: the booking, under the same lock
-- ------------------------------------------------------------

create or replace function public.book_time_offer_poll(
  p_offer_id uuid,
  p_slot_id uuid,
  p_booking_id uuid,
  p_manage_token_hash text,
  p_calendar_account_id uuid,
  p_guest_name text,
  p_attendees uuid[],
  p_manage_hashes jsonb,
  p_everyone boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.time_offer%rowtype;
  v_slot public.time_offer_slot%rowtype;
  v_hosts uuid[];
begin
  select * into v_offer from public.time_offer where id = p_offer_id for update;
  if not found or v_offer.mode <> 'poll' then
    return jsonb_build_object('status', 'missing');
  end if;
  if v_offer.state = 'booked' then
    return jsonb_build_object(
      'status', 'already',
      'booking_id', v_offer.booking_id,
      'slot_id', (select s.id from public.time_offer_slot s where s.offer_id = p_offer_id and s.state = 'booked' limit 1)
    );
  end if;
  if v_offer.state <> 'open' or v_offer.expires_at <= now() then
    return jsonb_build_object('status', 'closed', 'state', v_offer.state);
  end if;

  select * into v_slot from public.time_offer_slot where id = p_slot_id and offer_id = p_offer_id;
  if not found or v_slot.state <> 'open' or v_slot.starts_at <= now() then
    return jsonb_build_object('status', 'taken');
  end if;

  -- Who attends: some of the poll's own guests, never anyone else.
  if coalesce(array_length(p_attendees, 1), 0) = 0 or exists (
    select 1 from unnest(p_attendees) as a(id)
    where not exists (select 1 from public.time_offer_recipient r where r.id = a.id and r.offer_id = p_offer_id)
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Booked because everyone answered: every answer, read under the lock, still says this time works.
  if p_everyone and exists (
    select 1 from public.time_offer_recipient r
    where r.offer_id = p_offer_id
      and not exists (select 1 from public.time_offer_response x where x.recipient_id = r.id and x.slot_id = p_slot_id and x.works)
  ) then
    return jsonb_build_object('status', 'changed');
  end if;

  v_hosts := array_prepend(v_offer.host_user_id, array(select h from unnest(v_offer.co_host_ids) as h where h <> v_offer.host_user_id));

  -- A lapsed claim that holds nothing up goes (as book_meeting clears them).
  delete from public.host_time_claim c
  where c.host_user_id = any(v_hosts) and c.expires_at is not null and c.expires_at <= now()
    and (c.kind = 'hold' or not exists (
      select 1 from public.meeting_booking b where b.id = c.booking_id and b.state in ('requested', 'booking', 'confirmed')
    ));

  begin
    -- The poll's holds go, and the time becomes the booking's claim on every host.
    delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold';

    perform public.write_meeting_booking(
      jsonb_build_object(
        'id', p_booking_id,
        'workspace_id', v_offer.workspace_id,
        'host_user_id', v_offer.host_user_id,
        'host_name', v_offer.host_name,
        'source', 'poll',
        'offer_id', p_offer_id,
        'guest_name', p_guest_name,
        'contact_id', v_offer.contact_id,
        'title', v_offer.title,
        'starts_at', v_slot.starts_at,
        'ends_at', v_slot.ends_at,
        'state', 'booking',
        'video', v_offer.video,
        'location', v_offer.location,
        'calendar_account_id', p_calendar_account_id,
        'manage_token_hash', p_manage_token_hash,
        'other_host_ids', to_jsonb(v_hosts[2:]),
        'host_time_zone', v_offer.time_zone
      ),
      v_hosts,
      null
    );

    update public.time_offer_slot
      set state = case when id = p_slot_id then 'booked' else 'released' end
      where offer_id = p_offer_id and state = 'open';

    update public.time_offer
      set state = 'booked', booking_id = p_booking_id, updated_at = now()
      where id = p_offer_id;

    update public.time_offer_recipient
      set attending = (id = any(p_attendees)),
          manage_token_hash = case when id = any(p_attendees) then nullif(p_manage_hashes->>(id::text), '') end,
          updated_at = now()
      where offer_id = p_offer_id;
  exception when exclusion_violation then
    -- Someone else's claim took a host's time once the holds were gone: nothing of this booking stays.
    return jsonb_build_object('status', 'taken');
  end;

  return jsonb_build_object('status', 'booked', 'booking_id', p_booking_id);
end;
$$;

comment on function public.book_time_offer_poll(uuid, uuid, uuid, text, uuid, text, uuid[], jsonb, boolean) is
  'Books one time of an open poll (583) under the offer''s lock: with p_everyone, only while every guest''s answer says it works; the attendees only the poll''s own guests. The holds go, write_meeting_booking (581) writes the booking (source poll) and a claim per host (the host and the co-hosts), the guests'' attendance and manage hashes are set. Returns status booked, already (with the booking), closed, taken, changed, invalid or missing. Service role only.';

revoke execute on function public.book_time_offer_poll(uuid, uuid, uuid, text, uuid, text, uuid[], jsonb, boolean) from public, anon, authenticated;
grant execute on function public.book_time_offer_poll(uuid, uuid, uuid, text, uuid, text, uuid[], jsonb, boolean) to service_role;

comment on column public.meeting_booking.source is
  'offer (a time_offer pick), link (a booking link), customer (a business''s customer job: by text, its booking page, a call or the owner, see channel), poll (a poll every guest answered, or the host booked: its guests are the offer''s time_offer_recipient rows that attend, 583).';

-- ------------------------------------------------------------
-- 6. RLS and grants
-- ------------------------------------------------------------

alter table public.time_offer_recipient enable row level security;
alter table public.time_offer_response enable row level security;

-- No policy: nothing but the service role reads these (see the header).
revoke all on table public.time_offer_recipient from anon, authenticated;
revoke all on table public.time_offer_response from anon, authenticated;
grant all on table public.time_offer_recipient to service_role;
grant all on table public.time_offer_response to service_role;
