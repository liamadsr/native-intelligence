-- ============================================================
-- 458: the customer front door (roadmap track B, docs/plans/customer-front-door.md)
-- ============================================================
-- A service business's customers reach its agent without the owner in the
-- way: a quote from the website's form, a text to the business's own number,
-- a slot booked on the owner's yes. In order:
--
--   1. business_profile        what customers may be told (services, prices,
--                              area, FAQ) and when jobs can be booked (days,
--                              hours, slot length, lead time); one per
--                              workspace, written by the owner's agent.
--   2. quote_intake_key        the secret in the website form's URL (only its
--                              SHA-256 is kept), one live key per workspace.
--   3. business_phone_number   the Twilio number customers text, one live
--                              number per workspace, unique across Dial8 (the
--                              inbound webhook decides by the `To` number).
--   4. customer_quote          a quote as the form (or a text) sent it: the
--                              items, sizes, price and dates asked for, linked
--                              to its CRM contact.
--   5. customer_booking        a job slot a customer asked for, confirmed only
--                              by the owner's yes; one live booking per start.
--   6. agent_guest             a customer is a guest row with preset
--                              'customer', scoped to the business's number
--                              (business_number_id) and its CRM contact. The
--                              one-phone-one-agent keys (427) now leave
--                              customers out: a person may be one owner's
--                              guest and any business's customer.
--   7. checks widened          agent_event.kind 'quote.received' (and
--                              track C's 'job.paid', so 458 and 459 apply
--                              in either order);
--                              flow.trigger_type 'quote_received';
--                              contact.source 'web_form', 'sms'.
--
-- Every new table: RLS on; workspace members read their own workspace's rows
-- (none for the intake key); only the service role writes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. business_profile
-- ------------------------------------------------------------

create table if not exists public.business_profile (
  workspace_id uuid primary key references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  customer_facts text null,
  time_zone text null,
  booking_days smallint[] not null default '{1,2,3,4,5}',
  booking_start text not null default '09:00',
  booking_end text not null default '17:00',
  slot_minutes integer not null default 60,
  lead_hours integer not null default 24,
  horizon_days integer not null default 14,
  booking_kind text not null default 'pickup',
  booking_slug text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.business_profile is
  'A service business''s public facts and booking rules (458). Customers'' agents read customer_facts and nothing else of the workspace.';
comment on column public.business_profile.customer_facts is
  'What a customer may be told: services, prices, service area, FAQ. The customer agent''s only knowledge of the business.';
comment on column public.business_profile.booking_days is
  'Weekdays jobs can be booked (0 Sunday .. 6 Saturday), in time_zone.';
comment on column public.business_profile.booking_slug is
  'The public booking link: /book/<slug>. Null: no link.';

alter table public.business_profile drop constraint if exists business_profile_name_length;
alter table public.business_profile
  add constraint business_profile_name_length check (char_length(btrim(business_name)) between 1 and 120);
alter table public.business_profile drop constraint if exists business_profile_facts_length;
alter table public.business_profile
  add constraint business_profile_facts_length check (customer_facts is null or char_length(customer_facts) <= 8000);
alter table public.business_profile drop constraint if exists business_profile_hours_shape;
alter table public.business_profile
  add constraint business_profile_hours_shape check (
    booking_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and booking_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and booking_start < booking_end
  );
alter table public.business_profile drop constraint if exists business_profile_days_shape;
alter table public.business_profile
  add constraint business_profile_days_shape check (booking_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]);
alter table public.business_profile drop constraint if exists business_profile_slot_range;
alter table public.business_profile
  add constraint business_profile_slot_range check (slot_minutes between 15 and 480 and lead_hours between 0 and 336 and horizon_days between 1 and 60);
alter table public.business_profile drop constraint if exists business_profile_kind_length;
alter table public.business_profile
  add constraint business_profile_kind_length check (char_length(btrim(booking_kind)) between 1 and 40);
alter table public.business_profile drop constraint if exists business_profile_slug_shape;
alter table public.business_profile
  add constraint business_profile_slug_shape check (booking_slug is null or booking_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$');

create unique index if not exists business_profile_booking_slug_key
  on public.business_profile (booking_slug) where booking_slug is not null;

-- ------------------------------------------------------------
-- 2. quote_intake_key
-- ------------------------------------------------------------

create table if not exists public.quote_intake_key (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  key_hash text not null,
  key_prefix text not null,
  allowed_origins text[] not null default '{}',
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null
);

comment on table public.quote_intake_key is
  'The secret in a website quote form''s URL (458): only its SHA-256 is kept. Service role only.';
comment on column public.quote_intake_key.allowed_origins is
  'Browser origins allowed to post (CORS). Empty: no browser origin, only server-to-server posts.';

create unique index if not exists quote_intake_key_hash_key on public.quote_intake_key (key_hash);
create unique index if not exists quote_intake_key_live_key on public.quote_intake_key (workspace_id) where revoked_at is null;

-- ------------------------------------------------------------
-- 3. business_phone_number
-- ------------------------------------------------------------

create table if not exists public.business_phone_number (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  phone_e164 text not null,
  twilio_sid text null,
  state text not null default 'active',
  created_at timestamptz not null default now(),
  released_at timestamptz null
);

comment on table public.business_phone_number is
  'The Twilio number a business''s customers text (458). A text to it is a customer''s (src/lib/customers/texting.ts).';

alter table public.business_phone_number drop constraint if exists business_phone_number_phone_shape;
alter table public.business_phone_number
  add constraint business_phone_number_phone_shape check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$');
alter table public.business_phone_number drop constraint if exists business_phone_number_state_check;
alter table public.business_phone_number
  add constraint business_phone_number_state_check check (state in ('active', 'released'));

create unique index if not exists business_phone_number_live_phone_key
  on public.business_phone_number (phone_e164) where state = 'active';
create unique index if not exists business_phone_number_live_workspace_key
  on public.business_phone_number (workspace_id) where state = 'active';

-- ------------------------------------------------------------
-- 4. customer_quote
-- ------------------------------------------------------------

create table if not exists public.customer_quote (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  contact_id uuid null references public.contact(id) on delete set null,
  source text not null,
  external_id text null,
  status text not null default 'new',
  customer_name text null,
  customer_email text null,
  customer_phone text null,
  address text null,
  service text null,
  items jsonb not null default '[]'::jsonb,
  total_cents integer null,
  currency text not null default 'usd',
  requested_dates text[] not null default '{}',
  notes text null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customer_quote is
  'A quote a customer asked for (458): from the website form, a text or the owner. Free text in it is the customer''s, never instructions.';

alter table public.customer_quote drop constraint if exists customer_quote_source_check;
alter table public.customer_quote
  add constraint customer_quote_source_check check (source in ('web_form', 'sms', 'phone', 'owner'));
alter table public.customer_quote drop constraint if exists customer_quote_status_check;
alter table public.customer_quote
  add constraint customer_quote_status_check check (status in ('new', 'sent', 'accepted', 'declined', 'booked', 'done', 'cancelled'));
alter table public.customer_quote drop constraint if exists customer_quote_phone_shape;
alter table public.customer_quote
  add constraint customer_quote_phone_shape check (customer_phone is null or customer_phone ~ '^[+][1-9][0-9]{7,14}$');
alter table public.customer_quote drop constraint if exists customer_quote_total_range;
alter table public.customer_quote
  add constraint customer_quote_total_range check (total_cents is null or total_cents between 0 and 100000000);
alter table public.customer_quote drop constraint if exists customer_quote_items_shape;
alter table public.customer_quote
  add constraint customer_quote_items_shape check (case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) <= 50 else false end);
alter table public.customer_quote drop constraint if exists customer_quote_text_lengths;
alter table public.customer_quote
  add constraint customer_quote_text_lengths check (
    (customer_name is null or char_length(customer_name) <= 120)
    and (customer_email is null or char_length(customer_email) <= 254)
    and (address is null or char_length(address) <= 300)
    and (service is null or char_length(service) <= 120)
    and (notes is null or char_length(notes) <= 2000)
    and (external_id is null or char_length(external_id) <= 120)
    and cardinality(requested_dates) <= 10
  );

create unique index if not exists customer_quote_external_key
  on public.customer_quote (workspace_id, external_id) where external_id is not null;
create index if not exists customer_quote_workspace_idx on public.customer_quote (workspace_id, created_at desc);
create index if not exists customer_quote_phone_idx on public.customer_quote (workspace_id, customer_phone) where customer_phone is not null;
create index if not exists customer_quote_contact_idx on public.customer_quote (contact_id) where contact_id is not null;

-- ------------------------------------------------------------
-- 5. agent_guest: a business's customers (before customer_booking, which points at it)
-- ------------------------------------------------------------

alter table public.agent_guest add column if not exists business_number_id uuid null references public.business_phone_number(id) on delete set null;
alter table public.agent_guest add column if not exists contact_id uuid null references public.contact(id) on delete set null;

comment on column public.agent_guest.business_number_id is
  'A customer (preset customer, 458): the business number they texted. Their replies go out from it.';
comment on column public.agent_guest.contact_id is
  'A customer (458): their CRM contact, when one is known.';

alter table public.agent_guest drop constraint if exists agent_guest_preset_check;
alter table public.agent_guest
  add constraint agent_guest_preset_check check (preset in ('household', 'colleague', 'custom', 'customer'));

-- 427's keys, without customers: one Dial8 number, so a phone is active for one owner's guest at most.
drop index if exists public.agent_guest_active_phone_key;
create unique index if not exists agent_guest_active_phone_key
  on public.agent_guest (phone_e164) where state = 'active' and preset <> 'customer';
drop index if exists public.agent_guest_owner_phone_key;
create unique index if not exists agent_guest_owner_phone_key
  on public.agent_guest (owner_user_id, phone_e164) where state <> 'removed' and preset <> 'customer';
-- A customer once per business.
create unique index if not exists agent_guest_customer_phone_key
  on public.agent_guest (workspace_id, phone_e164) where state <> 'removed' and preset = 'customer';

-- ------------------------------------------------------------
-- 6. customer_booking
-- ------------------------------------------------------------

create table if not exists public.customer_booking (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  quote_id uuid null references public.customer_quote(id) on delete set null,
  contact_id uuid null references public.contact(id) on delete set null,
  guest_id uuid null references public.agent_guest(id) on delete set null,
  source text not null,
  kind text not null default 'pickup',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  customer_name text not null,
  customer_phone text null,
  address text null,
  note text null,
  state text not null default 'requested',
  approval_id uuid null references public.tool_approval(id) on delete set null,
  calendar_event_id text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customer_booking is
  'A job slot a customer asked for (458). Requested until the owner says yes on its approval; confirmed puts it on their calendar.';

alter table public.customer_booking drop constraint if exists customer_booking_source_check;
alter table public.customer_booking
  add constraint customer_booking_source_check check (source in ('sms', 'link', 'phone', 'owner'));
alter table public.customer_booking drop constraint if exists customer_booking_state_check;
alter table public.customer_booking
  add constraint customer_booking_state_check check (state in ('requested', 'confirmed', 'declined', 'expired', 'cancelled'));
alter table public.customer_booking drop constraint if exists customer_booking_times;
alter table public.customer_booking
  add constraint customer_booking_times check (ends_at > starts_at and ends_at - starts_at <= interval '1 day');
alter table public.customer_booking drop constraint if exists customer_booking_phone_shape;
alter table public.customer_booking
  add constraint customer_booking_phone_shape check (customer_phone is null or customer_phone ~ '^[+][1-9][0-9]{7,14}$');
alter table public.customer_booking drop constraint if exists customer_booking_text_lengths;
alter table public.customer_booking
  add constraint customer_booking_text_lengths check (
    char_length(btrim(customer_name)) between 1 and 120
    and (address is null or char_length(address) <= 300)
    and (note is null or char_length(note) <= 1000)
    and char_length(kind) <= 40
  );

-- One live booking per start: two customers can't both hold a slot.
create unique index if not exists customer_booking_live_slot_key
  on public.customer_booking (workspace_id, starts_at) where state in ('requested', 'confirmed');
create index if not exists customer_booking_workspace_idx on public.customer_booking (workspace_id, starts_at);
create index if not exists customer_booking_guest_idx on public.customer_booking (guest_id) where guest_id is not null;

-- ------------------------------------------------------------
-- 7. Checks widened
-- ------------------------------------------------------------

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed', 'email.arrived', 'pr.changed', 'connection.needs_reconnect', 'quote.received', 'job.paid'));

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received'));

alter table public.contact drop constraint if exists contact_source_check;
alter table public.contact
  add constraint contact_source_check check (source in ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'member', 'hubspot_sync', 'prospecting', 'web_form', 'sms'));

-- ------------------------------------------------------------
-- 8. RLS and grants
-- ------------------------------------------------------------

alter table public.business_profile enable row level security;
alter table public.quote_intake_key enable row level security;
alter table public.business_phone_number enable row level security;
alter table public.customer_quote enable row level security;
alter table public.customer_booking enable row level security;

drop policy if exists business_profile_select_member on public.business_profile;
create policy business_profile_select_member on public.business_profile
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists business_phone_number_select_member on public.business_phone_number;
create policy business_phone_number_select_member on public.business_phone_number
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists customer_quote_select_member on public.customer_quote;
create policy customer_quote_select_member on public.customer_quote
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists customer_booking_select_member on public.customer_booking;
create policy customer_booking_select_member on public.customer_booking
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.business_profile from anon, authenticated;
revoke all on table public.quote_intake_key from anon, authenticated;
revoke all on table public.business_phone_number from anon, authenticated;
revoke all on table public.customer_quote from anon, authenticated;
revoke all on table public.customer_booking from anon, authenticated;
grant select on table public.business_profile to authenticated;
grant select on table public.business_phone_number to authenticated;
grant select on table public.customer_quote to authenticated;
grant select on table public.customer_booking to authenticated;
grant all on table public.business_profile to service_role;
grant all on table public.quote_intake_key to service_role;
grant all on table public.business_phone_number to service_role;
grant all on table public.customer_quote to service_role;
grant all on table public.customer_booking to service_role;
