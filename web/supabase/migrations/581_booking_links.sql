-- 581: availability (phase 4a): booking links, and customer bookings on the
-- one booking model.
--
-- A person (or a team) keeps several booking links: standing public pages
-- (/book/<profile>/<slug>) anyone can book a time from
-- (src/lib/booking-links/). A booking from one is a meeting_booking (554)
-- with its claims on every attending host's time, written through the same
-- one transaction as an offer's pick, so the exclusion constraint on
-- host_time_claim keeps every host from being double booked across offers,
-- links and customers' jobs alike.
--
--   1. booking_profile      the public handle a link's address starts with:
--                           a workspace's own (user_id null: its team links
--                           and the business's job link) or one person's in
--                           it. Unique across Native Intelligence. A
--                           business's booking_slug (458) becomes its
--                           workspace handle, so /book/<slug> still finds it.
--   2. booking_link         one link: what (title, description, length,
--                           video or place, questions), when (buffers,
--                           notice, how far ahead it opens, the grid's step,
--                           a daily cap; the hosts' own working hours unless
--                           it keeps its own), who (host_mode: one host, all
--                           of them attending, or any one of them), and
--                           ask_first (the host's yes books each request).
--                           purpose 'job' is a business's customer booking
--                           page (the rules 458 kept on business_profile
--                           move here): one per workspace.
--   3. booking_link_host    a link's hosts, in their stable order.
--   4. booking_link_attempt one row per booking a link's public page tried,
--                           counted to rate-limit the page.
--   5. meeting_booking      widened for links and customers' jobs: the link,
--                           the customer's way in (channel), their quote,
--                           guest row, job kind, address and answers, the
--                           owner's approval, the customer's own yes, the
--                           other attending hosts and the host's zone; states
--                           requested (waiting on the host's yes, its claim
--                           held until expires_at), declined and expired.
--   6. write_meeting_booking / book_meeting  the one atomic path: a booking
--                           row and a claim for each attending host, in one
--                           transaction, after the hosts' lapsed claims are
--                           cleared; a collision is 'taken' and leaves
--                           nothing. book_time_offer_slot (554) now writes
--                           through write_meeting_booking too.
--   7. move_meeting_booking a confirmed booking and all its claims move
--                           together, fenced on where it was.
--   8. The fold             customer_booking's rows become meeting_booking
--                           rows (source 'customer', the same ids, so their
--                           approvals, reminders and payment links still
--                           name them), live ones with their claims; each
--                           business_profile's booking rules become its job
--                           link. customer_booking and those columns stay,
--                           no longer written: the undo.
--
-- RLS on; members of a workspace read its profiles, links and hosts; only
-- the service role writes. Re-runnable: run it again right after the deploy
-- to carry over any customer_booking row the old code wrote in between.
--
-- Must run on PROD before the app code that reads it deploys: every booking
-- read and write (customers' included) reads the new columns and tables.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. booking_profile
-- ------------------------------------------------------------

create table if not exists public.booking_profile (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete cascade,
  handle text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.booking_profile is
  'The handle a booking link''s address starts with, /book/<handle>/<slug> (581): a workspace''s own (user_id null) or one person''s in it.';

alter table public.booking_profile drop constraint if exists booking_profile_handle_shape;
alter table public.booking_profile
  add constraint booking_profile_handle_shape check (handle ~ '^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$');

create unique index if not exists booking_profile_handle_key on public.booking_profile (handle);
create unique index if not exists booking_profile_workspace_key on public.booking_profile (workspace_id) where user_id is null;
create unique index if not exists booking_profile_person_key on public.booking_profile (workspace_id, user_id) where user_id is not null;
create index if not exists booking_profile_user_idx on public.booking_profile (user_id) where user_id is not null;

-- ------------------------------------------------------------
-- 2. booking_link
-- ------------------------------------------------------------

create table if not exists public.booking_link (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid null references public.booking_profile(id) on delete set null,
  slug text not null,
  purpose text not null default 'meeting',
  title text not null,
  description text null,
  duration_minutes integer not null default 30,
  buffer_before_minutes integer not null default 0,
  buffer_after_minutes integer not null default 0,
  notice_minutes integer not null default 240,
  window_days integer not null default 30,
  step_minutes integer null,
  daily_cap integer null,
  questions jsonb not null default '[]'::jsonb,
  video boolean not null default true,
  location text null,
  ask_first boolean not null default false,
  host_mode text not null default 'one',
  weekly_hours jsonb null,
  time_zone text null,
  job_kind text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.booking_link is
  'A standing public booking page (581): /book/<profile handle>/<slug>. Its times are the hosts'' working hours (or weekly_hours) minus everything busy; a booking is a meeting_booking (source link, or customer for a job link).';
comment on column public.booking_link.purpose is
  'meeting (a booking link), or job: a business''s customer booking page, its rules once business_profile''s (458). One job link per workspace.';
comment on column public.booking_link.host_mode is
  'one (a single host), all (everyone free, everyone attends) or any (any one host: the least booked in the coming window, ties by the hosts'' order).';
comment on column public.booking_link.ask_first is
  'Each request holds its time and waits for the host''s yes (an approval, like a customer''s booking); a no or no answer lets the time go.';
comment on column public.booking_link.weekly_hours is
  'The link''s own hours (seven days, Sunday first, HH:MM ranges) in time_zone; null: each host''s own working hours.';
comment on column public.booking_link.step_minutes is
  'The grid its times start on; null: the length.';
comment on column public.booking_link.questions is
  'What the page asks, beyond name and email or mobile: [{id, label, required, kind text|long}].';

alter table public.booking_link drop constraint if exists booking_link_slug_shape;
alter table public.booking_link
  add constraint booking_link_slug_shape check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$');
alter table public.booking_link drop constraint if exists booking_link_purpose_check;
alter table public.booking_link
  add constraint booking_link_purpose_check check (purpose in ('meeting', 'job'));
alter table public.booking_link drop constraint if exists booking_link_host_mode_check;
alter table public.booking_link
  add constraint booking_link_host_mode_check check (host_mode in ('one', 'all', 'any'));
alter table public.booking_link drop constraint if exists booking_link_ranges;
alter table public.booking_link
  add constraint booking_link_ranges check (
    duration_minutes between 5 and 480
    and buffer_before_minutes between 0 and 240
    and buffer_after_minutes between 0 and 240
    and notice_minutes between 0 and 20160
    and window_days between 1 and 180
    and (step_minutes is null or step_minutes between 5 and 480)
    and (daily_cap is null or daily_cap between 1 and 100)
  );
alter table public.booking_link drop constraint if exists booking_link_text_lengths;
alter table public.booking_link
  add constraint booking_link_text_lengths check (
    char_length(btrim(title)) between 1 and 120
    and (description is null or char_length(description) <= 1000)
    and (location is null or char_length(location) <= 200)
    and (job_kind is null or char_length(btrim(job_kind)) between 1 and 40)
  );
alter table public.booking_link drop constraint if exists booking_link_questions_shape;
alter table public.booking_link
  add constraint booking_link_questions_shape check (case when jsonb_typeof(questions) = 'array' then jsonb_array_length(questions) <= 10 else false end);
alter table public.booking_link drop constraint if exists booking_link_hours_shape;
alter table public.booking_link
  add constraint booking_link_hours_shape check (weekly_hours is null or (case when jsonb_typeof(weekly_hours) = 'array' then jsonb_array_length(weekly_hours) = 7 else false end));
alter table public.booking_link drop constraint if exists booking_link_zone_shape;
alter table public.booking_link
  add constraint booking_link_zone_shape check (time_zone is null or time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');

create unique index if not exists booking_link_profile_slug_key on public.booking_link (profile_id, slug) where profile_id is not null;
create unique index if not exists booking_link_job_key on public.booking_link (workspace_id) where purpose = 'job';
create index if not exists booking_link_workspace_idx on public.booking_link (workspace_id, created_at);
create index if not exists booking_link_owner_idx on public.booking_link (owner_user_id);
create index if not exists booking_link_profile_idx on public.booking_link (profile_id) where profile_id is not null;

-- ------------------------------------------------------------
-- 3. booking_link_host
-- ------------------------------------------------------------

create table if not exists public.booking_link_host (
  link_id uuid not null references public.booking_link(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (link_id, user_id)
);

comment on table public.booking_link_host is
  'A booking link''s hosts (581), in their stable order (position): the tie-break when host_mode any picks one.';

alter table public.booking_link_host drop constraint if exists booking_link_host_position_range;
alter table public.booking_link_host
  add constraint booking_link_host_position_range check (position between 0 and 99);

create index if not exists booking_link_host_user_idx on public.booking_link_host (user_id);
create index if not exists booking_link_host_workspace_idx on public.booking_link_host (workspace_id);

-- ------------------------------------------------------------
-- 4. booking_link_attempt
-- ------------------------------------------------------------

create table if not exists public.booking_link_attempt (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.booking_link(id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.booking_link_attempt is
  'A booking a link''s public page tried (581), counted to rate-limit the page. Service role only.';

create index if not exists booking_link_attempt_link_idx on public.booking_link_attempt (link_id, created_at);

-- ------------------------------------------------------------
-- 5. meeting_booking: links, and customers' jobs
-- ------------------------------------------------------------

alter table public.meeting_booking add column if not exists link_id uuid null references public.booking_link(id) on delete set null;
alter table public.meeting_booking add column if not exists channel text null;
alter table public.meeting_booking add column if not exists quote_id uuid null references public.customer_quote(id) on delete set null;
alter table public.meeting_booking add column if not exists guest_id uuid null references public.agent_guest(id) on delete set null;
alter table public.meeting_booking add column if not exists kind text null;
alter table public.meeting_booking add column if not exists address text null;
alter table public.meeting_booking add column if not exists answers jsonb not null default '[]'::jsonb;
alter table public.meeting_booking add column if not exists approval_id uuid null references public.tool_approval(id) on delete set null;
alter table public.meeting_booking add column if not exists customer_confirmed_at timestamptz null;
alter table public.meeting_booking add column if not exists decided_at timestamptz null;
alter table public.meeting_booking add column if not exists other_host_ids uuid[] not null default '{}';
alter table public.meeting_booking add column if not exists host_time_zone text null;

comment on column public.meeting_booking.source is
  'offer (a time_offer pick), link (a booking link), customer (a business''s customer job: by text, its booking page, a call or the owner, see channel). poll is kept for later.';
comment on column public.meeting_booking.state is
  'requested (waiting on the host''s yes, its claim held until it expires), booking (claimed, the provider not yet written), confirmed, declined, expired, cancelled or failed.';
comment on column public.meeting_booking.channel is
  'A customer job''s way in (458''s customer_booking.source): sms, link (the booking page), phone or owner.';
comment on column public.meeting_booking.answers is
  'The guest''s answers to the link''s questions: [{id, label, answer}]. The guest''s words, never instructions.';
comment on column public.meeting_booking.other_host_ids is
  'The other hosts who attend (a link''s host_mode all): each has a claim of the booking''s; host_user_id is the organizer.';
comment on column public.meeting_booking.host_time_zone is
  'The zone the host''s words about it use (an offer''s, the link''s hours'', the business''s).';
comment on column public.meeting_booking.customer_confirmed_at is
  'The customer confirmed the booking (a yes to its reminder, or the time they moved it to): 472''s customer_booking column, moved here.';

alter table public.meeting_booking drop constraint if exists meeting_booking_state_check;
alter table public.meeting_booking
  add constraint meeting_booking_state_check check (state in ('requested', 'booking', 'confirmed', 'declined', 'expired', 'cancelled', 'failed'));
alter table public.meeting_booking drop constraint if exists meeting_booking_channel_check;
alter table public.meeting_booking
  add constraint meeting_booking_channel_check check (channel is null or channel in ('sms', 'link', 'phone', 'owner'));
alter table public.meeting_booking drop constraint if exists meeting_booking_text_lengths;
alter table public.meeting_booking
  add constraint meeting_booking_text_lengths check (
    char_length(btrim(guest_name)) between 1 and 120
    and char_length(btrim(title)) between 1 and 120
    and (guest_email is null or char_length(guest_email) <= 200)
    and (guest_note is null or char_length(guest_note) <= 1000)
    and (location is null or char_length(location) <= 200)
    and (last_error is null or char_length(last_error) <= 500)
    and (kind is null or char_length(kind) <= 40)
    and (address is null or char_length(address) <= 300)
  );
alter table public.meeting_booking drop constraint if exists meeting_booking_answers_shape;
alter table public.meeting_booking
  add constraint meeting_booking_answers_shape check (case when jsonb_typeof(answers) = 'array' then jsonb_array_length(answers) <= 10 else false end);
alter table public.meeting_booking drop constraint if exists meeting_booking_zone_shape;
alter table public.meeting_booking
  add constraint meeting_booking_zone_shape check (host_time_zone is null or host_time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');

create index if not exists meeting_booking_link_idx on public.meeting_booking (link_id, starts_at) where link_id is not null;
create index if not exists meeting_booking_quote_idx on public.meeting_booking (quote_id) where quote_id is not null;
create index if not exists meeting_booking_guest_idx on public.meeting_booking (guest_id) where guest_id is not null;
create index if not exists meeting_booking_approval_idx on public.meeting_booking (approval_id) where approval_id is not null;
create index if not exists meeting_booking_contact_idx on public.meeting_booking (contact_id) where contact_id is not null;
create index if not exists meeting_booking_guest_phone_idx on public.meeting_booking (workspace_id, guest_phone) where guest_phone is not null;
create index if not exists meeting_booking_requested_idx on public.meeting_booking (workspace_id, created_at) where state = 'requested';

-- ------------------------------------------------------------
-- 6. The one atomic path: a booking and its hosts' claims
-- ------------------------------------------------------------

-- Raises on a collision (exclusion_violation): its caller's block undoes it all.
create or replace function public.write_meeting_booking(p_booking jsonb, p_hosts uuid[], p_claim_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := (p_booking->>'id')::uuid;
  v_starts timestamptz := (p_booking->>'starts_at')::timestamptz;
  v_ends timestamptz := (p_booking->>'ends_at')::timestamptz;
begin
  insert into public.meeting_booking (
    id, workspace_id, host_user_id, host_name, source, offer_id, link_id, channel,
    guest_name, guest_email, guest_phone, guest_time_zone, guest_note, contact_id, quote_id, guest_id,
    kind, address, answers, title, starts_at, ends_at, state, video, location,
    calendar_account_id, manage_token_hash, other_host_ids, host_time_zone
  ) values (
    v_id,
    (p_booking->>'workspace_id')::uuid,
    (p_booking->>'host_user_id')::uuid,
    p_booking->>'host_name',
    p_booking->>'source',
    nullif(p_booking->>'offer_id', '')::uuid,
    nullif(p_booking->>'link_id', '')::uuid,
    nullif(p_booking->>'channel', ''),
    p_booking->>'guest_name',
    nullif(p_booking->>'guest_email', ''),
    nullif(p_booking->>'guest_phone', ''),
    nullif(p_booking->>'guest_time_zone', ''),
    nullif(p_booking->>'guest_note', ''),
    nullif(p_booking->>'contact_id', '')::uuid,
    nullif(p_booking->>'quote_id', '')::uuid,
    nullif(p_booking->>'guest_id', '')::uuid,
    nullif(p_booking->>'kind', ''),
    nullif(p_booking->>'address', ''),
    coalesce(p_booking->'answers', '[]'::jsonb),
    p_booking->>'title',
    v_starts,
    v_ends,
    coalesce(nullif(p_booking->>'state', ''), 'booking'),
    coalesce((p_booking->>'video')::boolean, false),
    nullif(p_booking->>'location', ''),
    nullif(p_booking->>'calendar_account_id', '')::uuid,
    p_booking->>'manage_token_hash',
    array(select x::uuid from jsonb_array_elements_text(coalesce(p_booking->'other_host_ids', '[]'::jsonb)) as x),
    nullif(p_booking->>'host_time_zone', '')
  );

  insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id, expires_at)
  select (p_booking->>'workspace_id')::uuid, h, v_starts, v_ends, 'booking', v_id, v_id, p_claim_expires_at
  from unnest(p_hosts) as h;
end;
$$;

comment on function public.write_meeting_booking(jsonb, uuid[], timestamptz) is
  'Writes one meeting_booking and a booking claim for each host (581), raising on a collision so the caller''s block undoes both. Service role (and the definer functions) only.';

revoke execute on function public.write_meeting_booking(jsonb, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.write_meeting_booking(jsonb, uuid[], timestamptz) to service_role;

create or replace function public.book_meeting(p_booking jsonb, p_hosts uuid[], p_claim_expires_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(array_length(p_hosts, 1), 0) = 0 or not ((p_booking->>'host_user_id')::uuid = any(p_hosts)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- A lapsed claim never blocks: an expired hold goes, and a request whose
  -- hold ran out (the host never answered) expires with it.
  with gone as (
    delete from public.host_time_claim
    where host_user_id = any(p_hosts) and expires_at is not null and expires_at <= now()
    returning booking_id
  )
  update public.meeting_booking
    set state = 'expired', decided_at = now(), updated_at = now()
    where id in (select booking_id from gone where booking_id is not null) and state = 'requested';

  begin
    perform public.write_meeting_booking(p_booking, p_hosts, p_claim_expires_at);
  exception
    when exclusion_violation then
      -- Another claim holds one host's time: nothing of this booking stays.
      return jsonb_build_object('status', 'taken');
    when unique_violation then
      return jsonb_build_object('status', 'exists', 'booking_id', p_booking->>'id');
  end;

  return jsonb_build_object('status', 'booked', 'booking_id', p_booking->>'id');
end;
$$;

comment on function public.book_meeting(jsonb, uuid[], timestamptz) is
  'Books a meeting (581): the hosts'' lapsed claims cleared, then the booking and a claim for each host in one block. Returns status booked, taken (a host''s time is claimed), exists (that id) or invalid. Service role only.';

revoke execute on function public.book_meeting(jsonb, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.book_meeting(jsonb, uuid[], timestamptz) to service_role;

-- The offer's pick (554), its booking written through the same path.
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

    perform public.write_meeting_booking(
      jsonb_build_object(
        'id', p_booking_id,
        'workspace_id', v_offer.workspace_id,
        'host_user_id', v_offer.host_user_id,
        'host_name', v_offer.host_name,
        'source', 'offer',
        'offer_id', p_offer_id,
        'guest_name', p_guest->>'name',
        'guest_email', p_guest->>'email',
        'guest_phone', p_guest->>'phone',
        'guest_time_zone', p_guest->>'time_zone',
        'guest_note', p_guest->>'note',
        'contact_id', coalesce(p_contact_id, v_offer.contact_id),
        'title', v_offer.title,
        'starts_at', v_slot.starts_at,
        'ends_at', v_slot.ends_at,
        'state', 'booking',
        'video', v_offer.video,
        'location', v_offer.location,
        'calendar_account_id', p_calendar_account_id,
        'manage_token_hash', p_manage_token_hash,
        'host_time_zone', v_offer.time_zone
      ),
      array[v_offer.host_user_id],
      null
    );

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
  'Books one slot of an open time_offer (554, 581): locks the offer, turns the slot''s hold into the booking''s claim (write_meeting_booking), releases the other holds. Returns status booked, already (with the booking), closed, taken or missing. Service role only.';

revoke execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.book_time_offer_slot(uuid, uuid, uuid, jsonb, text, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 7. move_meeting_booking: a confirmed booking and its claims, together
-- ------------------------------------------------------------

create or replace function public.move_meeting_booking(
  p_booking_id uuid,
  p_from_start timestamptz,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_customer_confirmed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.meeting_booking%rowtype;
  v_hosts uuid[];
  v_moved integer;
begin
  select * into v_booking from public.meeting_booking where id = p_booking_id for update;
  if not found or v_booking.state <> 'confirmed' or v_booking.starts_at <> p_from_start then
    return jsonb_build_object('status', 'changed');
  end if;
  v_hosts := array_prepend(v_booking.host_user_id, v_booking.other_host_ids);

  with gone as (
    delete from public.host_time_claim
    where host_user_id = any(v_hosts) and expires_at is not null and expires_at <= now()
    returning booking_id
  )
  update public.meeting_booking
    set state = 'expired', decided_at = now(), updated_at = now()
    where id in (select booking_id from gone where booking_id is not null) and state = 'requested';

  begin
    update public.host_time_claim set starts_at = p_starts_at, ends_at = p_ends_at where booking_id = p_booking_id;
    get diagnostics v_moved = row_count;
    if v_moved = 0 then
      -- A booking carried over without its claim takes one now.
      insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id)
      select v_booking.workspace_id, h, p_starts_at, p_ends_at, 'booking', p_booking_id, p_booking_id from unnest(v_hosts) as h;
    end if;
    update public.meeting_booking
      set starts_at = p_starts_at, ends_at = p_ends_at, customer_confirmed_at = p_customer_confirmed_at, updated_at = now()
      where id = p_booking_id;
  exception when exclusion_violation then
    return jsonb_build_object('status', 'taken');
  end;

  return jsonb_build_object('status', 'moved');
end;
$$;

comment on function public.move_meeting_booking(uuid, timestamptz, timestamptz, timestamptz, timestamptz) is
  'Moves a confirmed meeting_booking and every claim of its (581), fenced on its start: status moved, changed (it was not where it was said to be) or taken (a host''s new time is claimed). Service role only.';

revoke execute on function public.move_meeting_booking(uuid, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.move_meeting_booking(uuid, timestamptz, timestamptz, timestamptz, timestamptz) to service_role;

-- ------------------------------------------------------------
-- 8. The fold: business profiles' booking rules and customer bookings
-- ------------------------------------------------------------

-- A business's booking slug is its workspace handle (a handle someone else has keeps theirs).
insert into public.booking_profile (workspace_id, user_id, handle)
select bp.workspace_id, null, bp.booking_slug
from public.business_profile bp
where bp.booking_slug is not null
on conflict do nothing;

-- Each business's booking rules, as its job link: the owner its one host, every request on their yes.
insert into public.booking_link (
  workspace_id, owner_user_id, profile_id, slug, purpose, title, duration_minutes, notice_minutes,
  window_days, step_minutes, questions, video, ask_first, host_mode, weekly_hours, time_zone, job_kind, active
)
select
  bp.workspace_id,
  bp.owner_user_id,
  prof.id,
  'book',
  'job',
  left(upper(left(btrim(coalesce(bp.booking_kind, 'pickup')), 1)) || substr(btrim(coalesce(bp.booking_kind, 'pickup')), 2), 120),
  bp.slot_minutes,
  least(bp.lead_hours * 60, 20160),
  least(greatest(bp.horizon_days, 1), 180),
  bp.slot_minutes,
  '[{"id": "address", "label": "Address", "required": false, "kind": "text"}]'::jsonb,
  false,
  true,
  'one',
  (
    select jsonb_agg(
      case when d = any(coalesce(bp.booking_days, '{}'::smallint[]))
        then jsonb_build_array(jsonb_build_object('start', bp.booking_start, 'end', bp.booking_end))
        else '[]'::jsonb
      end
      order by d
    )
    from generate_series(0, 6) as d
  ),
  null,
  btrim(coalesce(bp.booking_kind, 'pickup')),
  bp.booking_slug is not null
from public.business_profile bp
left join public.booking_profile prof on prof.workspace_id = bp.workspace_id and prof.user_id is null
where not exists (select 1 from public.booking_link l where l.workspace_id = bp.workspace_id and l.purpose = 'job');

insert into public.booking_link_host (link_id, user_id, workspace_id, position)
select l.id, l.owner_user_id, l.workspace_id, 0
from public.booking_link l
where l.purpose = 'job'
on conflict do nothing;

-- Every customer booking, as a meeting_booking of the same id. Its manage
-- hash is 'none:<id>': never the sha256 of any token, so it has no manage page.
insert into public.meeting_booking (
  id, workspace_id, host_user_id, host_name, source, channel, link_id,
  guest_name, guest_phone, guest_note, contact_id, quote_id, guest_id, kind, address,
  title, starts_at, ends_at, state, video, calendar_event_id, manage_token_hash,
  approval_id, customer_confirmed_at, decided_at, confirmed_at, cancelled_at, host_time_zone, created_at, updated_at
)
select
  cb.id,
  cb.workspace_id,
  cb.owner_user_id,
  left(coalesce(nullif(btrim(bp.business_name), ''), nullif(btrim(w.name), ''), 'The business'), 120),
  'customer',
  cb.source,
  case when cb.source = 'link' then jl.id end,
  cb.customer_name,
  cb.customer_phone,
  cb.note,
  cb.contact_id,
  cb.quote_id,
  cb.guest_id,
  left(cb.kind, 40),
  cb.address,
  left(upper(left(cb.kind, 1)) || substr(cb.kind, 2) || ': ' || btrim(cb.customer_name), 120),
  cb.starts_at,
  cb.ends_at,
  cb.state,
  false,
  cb.calendar_event_id,
  'none:' || cb.id::text,
  cb.approval_id,
  cb.customer_confirmed_at,
  cb.decided_at,
  case when cb.state = 'confirmed' then coalesce(cb.decided_at, cb.updated_at) end,
  case when cb.state = 'cancelled' then coalesce(cb.decided_at, cb.updated_at) end,
  case when bp.time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$' then bp.time_zone end,
  cb.created_at,
  cb.updated_at
from public.customer_booking cb
left join public.business_profile bp on bp.workspace_id = cb.workspace_id
left join public.workspace w on w.id = cb.workspace_id
left join public.booking_link jl on jl.workspace_id = cb.workspace_id and jl.purpose = 'job'
where cb.ends_at - cb.starts_at <= interval '8 hours'
on conflict (id) do nothing;

-- The live ones claim the owner's time: a confirmed job, and a request still
-- within its day (its hold ending with it). One that overlaps a claim
-- already there is carried over without one, and said so.
do $$
declare
  r record;
begin
  for r in
    select mb.id, mb.workspace_id, mb.host_user_id, mb.starts_at, mb.ends_at, mb.state, mb.created_at
    from public.meeting_booking mb
    where mb.source = 'customer'
      and mb.ends_at > now()
      and (mb.state = 'confirmed' or (mb.state = 'requested' and mb.created_at > now() - interval '24 hours'))
      and not exists (select 1 from public.host_time_claim c where c.booking_id = mb.id)
  loop
    begin
      insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id, expires_at)
      values (
        r.workspace_id, r.host_user_id, r.starts_at, r.ends_at, 'booking', r.id, r.id,
        case when r.state = 'requested' then r.created_at + interval '24 hours 15 minutes' end
      );
    exception when exclusion_violation then
      raise notice 'customer booking % overlaps another claim: carried over without one', r.id;
    end;
  end loop;
end;
$$;

comment on table public.customer_booking is
  'A job slot a customer asked for (458). Moved onto meeting_booking (source customer, the same ids) by 581, and no longer written: kept as the undo.';
comment on column public.business_profile.booking_slug is
  'The public booking link: /book/<slug>. Since 581 the workspace''s booking_profile handle (its job link''s page) is the truth; this column is no longer written, kept as the undo.';
comment on column public.business_profile.booking_days is
  'Weekdays jobs could be booked (0 Sunday .. 6 Saturday). Since 581 the job link''s weekly_hours are the truth (with booking_start, booking_end, slot_minutes, lead_hours, horizon_days, booking_kind); these are no longer written, kept as the undo.';

-- ------------------------------------------------------------
-- 9. RLS and grants
-- ------------------------------------------------------------

alter table public.booking_profile enable row level security;
alter table public.booking_link enable row level security;
alter table public.booking_link_host enable row level security;
alter table public.booking_link_attempt enable row level security;

drop policy if exists booking_profile_select_member on public.booking_profile;
create policy booking_profile_select_member on public.booking_profile
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists booking_link_select_member on public.booking_link;
create policy booking_link_select_member on public.booking_link
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists booking_link_host_select_member on public.booking_link_host;
create policy booking_link_host_select_member on public.booking_link_host
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.booking_profile from anon, authenticated;
revoke all on table public.booking_link from anon, authenticated;
revoke all on table public.booking_link_host from anon, authenticated;
revoke all on table public.booking_link_attempt from anon, authenticated;
grant select on table public.booking_profile to authenticated;
grant select on table public.booking_link to authenticated;
grant select on table public.booking_link_host to authenticated;
grant all on table public.booking_profile to service_role;
grant all on table public.booking_link to service_role;
grant all on table public.booking_link_host to service_role;
grant all on table public.booking_link_attempt to service_role;
