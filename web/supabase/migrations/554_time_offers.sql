-- 554: availability (phase 3a): offering an outside person a few times.
--
-- A person (or their agent) offers someone outside the workspace two or
-- three specific times; the times are held; the guest picks one on a public
-- page (/t/<token>) or by replying; it is booked on the person's calendar
-- and the calendar provider sends the guest the invitation
-- (src/lib/time-offers/).
--
--   1. time_offer         one offer: who it is for, what, how long, the
--                         host's zone for its words, its state and expiry.
--                         token_hash is the sha256 of the link's token (the
--                         token itself is never stored); null until the
--                         offer is sent (an offer waiting on the person's
--                         approval card has none). recipients_shown: the
--                         person saw who it went to (its approval card, or
--                         their own turn made it), which is what lets their
--                         agent book a time of it for its guests without a
--                         second card.
--   2. time_offer_slot    the two or three times offered.
--   3. meeting_booking    a meeting booked with an outside guest. General:
--                         source 'offer' today; 'link', 'customer' and
--                         'poll' are kept for the booking links and the
--                         customer bookings that move onto it later. Written
--                         in state 'booking' with its claim BEFORE the
--                         calendar provider is written, then 'confirmed'
--                         with the provider's event (a sweep finishes or
--                         fails one left in 'booking'). manage_token_hash is
--                         the sha256 of the guest's manage link (/b/<token>).
--   4. host_time_claim    the host's time a hold (an offered time) or a
--                         booking takes. Its exclusion constraint is the
--                         one rule that makes double booking impossible:
--                         two claims for one host whose times overlap can
--                         never both exist, unless they are the same
--                         booking's (claim_key: a move holds the new time
--                         before the old one is let go). An expired hold is
--                         deleted before anything is inserted, and by the
--                         sweep. The availability engine reads a host's
--                         live claims as busy time (src/lib/availability/
--                         busy.ts), so nothing held or booked is offered
--                         again.
--   5. time_offer_failure one row per failed pick on an offer's public
--                         page, counted to rate-limit it.
--   6. book_time_offer_slot(...)  the pick, atomically: the offer locked,
--                         the slot's hold turned into the booking's claim,
--                         the offer's other holds released, the booking
--                         row written. Two picks at once make exactly one
--                         booking.
--
-- RLS on, and only the service role reads or writes: every reader is on the
-- server (the agent's tools, the account API, the public routes), and a
-- member's own client has no business reading another member's guests or
-- held times (a workspace guest is a member row too, 512). Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: every
-- availability read (find_times, booking slots, copy availability) reads
-- host_time_claim.

SET LOCAL lock_timeout = '5s';

create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- 1. time_offer
-- ------------------------------------------------------------

create table if not exists public.time_offer (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  host_name text not null,
  recipient_name text not null,
  recipient_email text null,
  recipient_phone text null,
  contact_id uuid null references public.contact(id) on delete set null,
  title text not null,
  duration_minutes integer not null,
  video boolean not null default true,
  location text null,
  message text null,
  time_zone text not null,
  token_hash text null,
  state text not null default 'open',
  sent_via text null,
  card_hash text null,
  recipients_shown boolean not null default false,
  approval_id uuid null,
  booking_id uuid null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.time_offer is
  'Two or three times offered to one outside person (554). token_hash: sha256 of the /t/<token> link, null until sent. The host''s time for each is held in host_time_claim.';
comment on column public.time_offer.state is
  'pending_send (waiting on the person''s approval card), open, booked, expired, withdrawn, declined (the card was declined or lapsed).';
comment on column public.time_offer.card_hash is
  'An email or text offer: the hash of its approval card''s words; the send happens only when the card it replays hashes the same.';
comment on column public.time_offer.recipients_shown is
  'The person saw who the offer went to: it went out on their approved card (email or text), or their own attended turn made it. Only then may their agent book one of its times for its guests without a card (accept_time_offer, record_time_offer_answer, book_poll_time).';

alter table public.time_offer drop constraint if exists time_offer_state_check;
alter table public.time_offer
  add constraint time_offer_state_check check (state in ('pending_send', 'open', 'booked', 'expired', 'withdrawn', 'declined'));
alter table public.time_offer drop constraint if exists time_offer_sent_via_check;
alter table public.time_offer
  add constraint time_offer_sent_via_check check (sent_via is null or sent_via in ('link', 'email', 'text'));
alter table public.time_offer drop constraint if exists time_offer_duration_check;
alter table public.time_offer
  add constraint time_offer_duration_check check (duration_minutes between 5 and 480);
alter table public.time_offer drop constraint if exists time_offer_phone_shape;
alter table public.time_offer
  add constraint time_offer_phone_shape check (recipient_phone is null or recipient_phone ~ '^[+][1-9][0-9]{7,14}$');
alter table public.time_offer drop constraint if exists time_offer_zone_shape;
alter table public.time_offer
  add constraint time_offer_zone_shape check (time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');
alter table public.time_offer drop constraint if exists time_offer_text_lengths;
alter table public.time_offer
  add constraint time_offer_text_lengths check (
    char_length(btrim(recipient_name)) between 1 and 120
    and char_length(btrim(title)) between 1 and 120
    and char_length(host_name) <= 120
    and (recipient_email is null or char_length(recipient_email) <= 200)
    and (location is null or char_length(location) <= 200)
    and (message is null or char_length(message) <= 300)
  );
alter table public.time_offer drop constraint if exists time_offer_open_has_token;
alter table public.time_offer
  add constraint time_offer_open_has_token check (state not in ('open', 'booked') or token_hash is not null);

create unique index if not exists time_offer_token_hash_key on public.time_offer (token_hash) where token_hash is not null;
create index if not exists time_offer_host_idx on public.time_offer (host_user_id, state, expires_at);
create index if not exists time_offer_workspace_idx on public.time_offer (workspace_id, created_at desc);
create index if not exists time_offer_recipient_phone_idx on public.time_offer (workspace_id, recipient_phone) where recipient_phone is not null and state = 'open';
create index if not exists time_offer_live_expiry_idx on public.time_offer (expires_at) where state in ('pending_send', 'open');

-- ------------------------------------------------------------
-- 2. time_offer_slot
-- ------------------------------------------------------------

create table if not exists public.time_offer_slot (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.time_offer(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'open',
  created_at timestamptz not null default now()
);

comment on table public.time_offer_slot is
  'One time a time_offer offers (554): open, booked (the one picked) or released.';

alter table public.time_offer_slot drop constraint if exists time_offer_slot_state_check;
alter table public.time_offer_slot
  add constraint time_offer_slot_state_check check (state in ('open', 'booked', 'released'));
alter table public.time_offer_slot drop constraint if exists time_offer_slot_times;
alter table public.time_offer_slot
  add constraint time_offer_slot_times check (ends_at > starts_at and ends_at - starts_at <= interval '8 hours');

create unique index if not exists time_offer_slot_offer_start_key on public.time_offer_slot (offer_id, starts_at);

-- ------------------------------------------------------------
-- 3. meeting_booking
-- ------------------------------------------------------------

create table if not exists public.meeting_booking (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  host_name text not null,
  source text not null default 'offer',
  offer_id uuid null references public.time_offer(id) on delete set null,
  guest_name text not null,
  guest_email text null,
  guest_phone text null,
  guest_time_zone text null,
  guest_note text null,
  contact_id uuid null references public.contact(id) on delete set null,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'booking',
  video boolean not null default false,
  location text null,
  calendar_account_id uuid null references public.connected_account(id) on delete set null,
  calendar_id text null,
  calendar_event_id text null,
  conference_url text null,
  manage_token_hash text not null,
  attempts integer not null default 0,
  reschedule_count integer not null default 0,
  last_error text null,
  cancelled_by text null,
  confirmed_at timestamptz null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.meeting_booking is
  'A meeting booked with an outside guest (554). state booking (claimed, the provider not yet written), confirmed (the provider event is calendar_event_id), cancelled or failed. manage_token_hash: sha256 of the guest''s /b/<token> link.';
comment on column public.meeting_booking.source is
  'offer (a time_offer pick). link, customer and poll are kept for the booking links and customer bookings that move onto this table.';

alter table public.meeting_booking drop constraint if exists meeting_booking_source_check;
alter table public.meeting_booking
  add constraint meeting_booking_source_check check (source in ('offer', 'link', 'customer', 'poll'));
alter table public.meeting_booking drop constraint if exists meeting_booking_state_check;
alter table public.meeting_booking
  add constraint meeting_booking_state_check check (state in ('booking', 'confirmed', 'cancelled', 'failed'));
alter table public.meeting_booking drop constraint if exists meeting_booking_cancelled_by_check;
alter table public.meeting_booking
  add constraint meeting_booking_cancelled_by_check check (cancelled_by is null or cancelled_by in ('guest', 'host'));
alter table public.meeting_booking drop constraint if exists meeting_booking_times;
alter table public.meeting_booking
  add constraint meeting_booking_times check (ends_at > starts_at and ends_at - starts_at <= interval '8 hours');
alter table public.meeting_booking drop constraint if exists meeting_booking_phone_shape;
alter table public.meeting_booking
  add constraint meeting_booking_phone_shape check (guest_phone is null or guest_phone ~ '^[+][1-9][0-9]{7,14}$');
alter table public.meeting_booking drop constraint if exists meeting_booking_counts;
alter table public.meeting_booking
  add constraint meeting_booking_counts check (attempts >= 0 and reschedule_count between 0 and 3);
alter table public.meeting_booking drop constraint if exists meeting_booking_text_lengths;
alter table public.meeting_booking
  add constraint meeting_booking_text_lengths check (
    char_length(btrim(guest_name)) between 1 and 120
    and char_length(btrim(title)) between 1 and 120
    and (guest_email is null or char_length(guest_email) <= 200)
    and (guest_note is null or char_length(guest_note) <= 500)
    and (location is null or char_length(location) <= 200)
    and (last_error is null or char_length(last_error) <= 500)
  );

create unique index if not exists meeting_booking_manage_token_key on public.meeting_booking (manage_token_hash);
create index if not exists meeting_booking_workspace_idx on public.meeting_booking (workspace_id, starts_at);
create index if not exists meeting_booking_host_idx on public.meeting_booking (host_user_id, starts_at);
create index if not exists meeting_booking_stuck_idx on public.meeting_booking (updated_at) where state = 'booking';
create index if not exists meeting_booking_offer_idx on public.meeting_booking (offer_id) where offer_id is not null;

-- The offer's booking, once picked (after meeting_booking exists).
alter table public.time_offer drop constraint if exists time_offer_booking_id_fkey;
alter table public.time_offer
  add constraint time_offer_booking_id_fkey foreign key (booking_id) references public.meeting_booking(id) on delete set null;

-- ------------------------------------------------------------
-- 4. host_time_claim
-- ------------------------------------------------------------

create table if not exists public.host_time_claim (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  during tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  kind text not null,
  claim_key uuid not null,
  offer_id uuid null references public.time_offer(id) on delete cascade,
  slot_id uuid null references public.time_offer_slot(id) on delete cascade,
  booking_id uuid null references public.meeting_booking(id) on delete cascade,
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.host_time_claim is
  'The host''s time a hold (an offered time, until expires_at) or a booking takes (554). No two claims of one host overlap unless they are the same booking''s (claim_key), so nothing is ever double booked. Read as busy time by the availability engine.';
comment on column public.host_time_claim.claim_key is
  'Whose claim: the offer for a hold, the booking for a booking. A booking''s move holds its new time beside the old one under the same key.';

alter table public.host_time_claim drop constraint if exists host_time_claim_kind_check;
alter table public.host_time_claim
  add constraint host_time_claim_kind_check check (
    (kind = 'hold' and offer_id is not null and slot_id is not null and expires_at is not null and claim_key = offer_id)
    or (kind = 'booking' and booking_id is not null and claim_key = booking_id)
  );
alter table public.host_time_claim drop constraint if exists host_time_claim_times;
alter table public.host_time_claim
  add constraint host_time_claim_times check (ends_at > starts_at);
alter table public.host_time_claim drop constraint if exists host_time_claim_no_overlap;
alter table public.host_time_claim
  add constraint host_time_claim_no_overlap exclude using gist (host_user_id with =, during with &&, claim_key with <>);

create index if not exists host_time_claim_host_idx on public.host_time_claim (host_user_id, starts_at);
create index if not exists host_time_claim_offer_idx on public.host_time_claim (offer_id) where offer_id is not null;
create index if not exists host_time_claim_booking_idx on public.host_time_claim (booking_id) where booking_id is not null;
create index if not exists host_time_claim_hold_expiry_idx on public.host_time_claim (expires_at) where kind = 'hold';

-- ------------------------------------------------------------
-- 5. time_offer_failure
-- ------------------------------------------------------------

create table if not exists public.time_offer_failure (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.time_offer(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

comment on table public.time_offer_failure is
  'A failed pick on an offer''s public page (554), counted to rate-limit the page.';

alter table public.time_offer_failure drop constraint if exists time_offer_failure_reason_length;
alter table public.time_offer_failure
  add constraint time_offer_failure_reason_length check (char_length(reason) between 1 and 40);

create index if not exists time_offer_failure_offer_idx on public.time_offer_failure (offer_id, created_at);

-- ------------------------------------------------------------
-- 6. book_time_offer_slot: the pick, in one transaction
-- ------------------------------------------------------------

create or replace function public.book_time_offer_slot(
  p_offer_id uuid,
  p_slot_id uuid,
  p_booking_id uuid,
  p_guest jsonb,
  p_manage_token_hash text,
  p_calendar_account_id uuid,
  p_contact_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.time_offer%rowtype;
  v_slot public.time_offer_slot%rowtype;
begin
  -- One pick per offer at a time: a second waits here, then reads the first's booking.
  select * into v_offer from public.time_offer where id = p_offer_id for update;
  if not found then
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

  -- An expired hold never blocks.
  delete from public.host_time_claim where host_user_id = v_offer.host_user_id and kind = 'hold' and expires_at <= now();

  begin
    -- The offer's holds go, and the picked time becomes the booking's claim.
    delete from public.host_time_claim where offer_id = p_offer_id and kind = 'hold';

    insert into public.meeting_booking (
      id, workspace_id, host_user_id, host_name, source, offer_id,
      guest_name, guest_email, guest_phone, guest_time_zone, guest_note, contact_id,
      title, starts_at, ends_at, state, video, location, calendar_account_id, manage_token_hash
    ) values (
      p_booking_id, v_offer.workspace_id, v_offer.host_user_id, v_offer.host_name, 'offer', p_offer_id,
      p_guest->>'name', nullif(p_guest->>'email', ''), nullif(p_guest->>'phone', ''), nullif(p_guest->>'time_zone', ''), nullif(p_guest->>'note', ''),
      coalesce(p_contact_id, v_offer.contact_id),
      v_offer.title, v_slot.starts_at, v_slot.ends_at, 'booking', v_offer.video, v_offer.location, p_calendar_account_id, p_manage_token_hash
    );

    insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id)
    values (v_offer.workspace_id, v_offer.host_user_id, v_slot.starts_at, v_slot.ends_at, 'booking', p_booking_id, p_booking_id);

    update public.time_offer_slot
      set state = case when id = p_slot_id then 'booked' else 'released' end
      where offer_id = p_offer_id and state = 'open';

    update public.time_offer
      set state = 'booked', booking_id = p_booking_id, updated_at = now()
      where id = p_offer_id;
  exception when exclusion_violation then
    -- Someone else's claim took the time once its hold was gone: nothing of this pick stays.
    return jsonb_build_object('status', 'taken');
  end;

  return jsonb_build_object('status', 'booked', 'booking_id', p_booking_id);
end;
$$;

comment on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) is
  'Books one slot of an open time_offer (554): locks the offer, turns the slot''s hold into the booking''s claim, releases the other holds and writes meeting_booking in state booking. Returns status booked, already (with the booking), closed, taken or missing. Service role only.';

revoke execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 7. RLS and grants
-- ------------------------------------------------------------

alter table public.time_offer enable row level security;
alter table public.time_offer_slot enable row level security;
alter table public.meeting_booking enable row level security;
alter table public.host_time_claim enable row level security;
alter table public.time_offer_failure enable row level security;

-- No policy: nothing but the service role reads these (see the header).
revoke all on table public.time_offer from anon, authenticated;
revoke all on table public.time_offer_slot from anon, authenticated;
revoke all on table public.meeting_booking from anon, authenticated;
revoke all on table public.host_time_claim from anon, authenticated;
revoke all on table public.time_offer_failure from anon, authenticated;
grant all on table public.time_offer to service_role;
grant all on table public.time_offer_slot to service_role;
grant all on table public.meeting_booking to service_role;
grant all on table public.host_time_claim to service_role;
grant all on table public.time_offer_failure to service_role;
