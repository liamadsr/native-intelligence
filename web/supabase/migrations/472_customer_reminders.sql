-- 472: reminders and confirmations (roadmap issue #11).
--
-- The day before a booked job, or a meeting with a customer, the business's
-- number texts that customer a reminder (src/lib/customers/reminders.ts).
-- Their answer is handled by their own agent (confirm, or move a booking to
-- another open time); STOP opts them out (src/lib/sms/inbound.ts).
--
--   1. customer_reminder          one row per reminder: claimed BEFORE the
--                                 text goes, one per subject (a booking, or a
--                                 calendar event) and phone, so a customer is
--                                 never texted twice for one booking. What
--                                 they answered (confirmed, moved, opted out)
--                                 is kept on it.
--   2. customer_booking           customer_confirmed_at: the customer said yes
--                                 (or picked the time it moved to).
--   3. business_profile           reminders: on unless the owner turns them
--                                 off (the owner's agent, update_business_profile).
--
-- RLS on; workspace members read their own workspace's reminders; only the
-- service role writes. Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: the booking and
-- profile reads select the two new columns.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. customer_reminder
-- ------------------------------------------------------------

create table if not exists public.customer_reminder (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  contact_id uuid null references public.contact(id) on delete set null,
  phone_e164 text not null,
  customer_name text not null,
  kind text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'claimed',
  answer text null,
  answered_at timestamptz null,
  moved_to timestamptz null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customer_reminder is
  'A reminder texted to a customer the day before a booked job or a meeting (472). Claimed before it is sent: one per subject and phone.';

alter table public.customer_reminder drop constraint if exists customer_reminder_subject_type_check;
alter table public.customer_reminder
  add constraint customer_reminder_subject_type_check check (subject_type in ('booking', 'meeting'));
alter table public.customer_reminder drop constraint if exists customer_reminder_status_check;
alter table public.customer_reminder
  add constraint customer_reminder_status_check check (status in ('claimed', 'sent', 'failed'));
alter table public.customer_reminder drop constraint if exists customer_reminder_answer_check;
alter table public.customer_reminder
  add constraint customer_reminder_answer_check check (answer is null or answer in ('confirmed', 'moved', 'opted_out'));
alter table public.customer_reminder drop constraint if exists customer_reminder_phone_shape;
alter table public.customer_reminder
  add constraint customer_reminder_phone_shape check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$');
alter table public.customer_reminder drop constraint if exists customer_reminder_times;
alter table public.customer_reminder
  add constraint customer_reminder_times check (ends_at > starts_at);
alter table public.customer_reminder drop constraint if exists customer_reminder_text_lengths;
alter table public.customer_reminder
  add constraint customer_reminder_text_lengths check (
    char_length(subject_id) between 1 and 1024
    and char_length(btrim(customer_name)) between 1 and 120
    and char_length(kind) between 1 and 40
  );

-- Never twice for one booking (or one meeting) and one phone.
create unique index if not exists customer_reminder_subject_key
  on public.customer_reminder (workspace_id, subject_type, subject_id, phone_e164);
-- A customer's open reminders, by the number they answer from.
create index if not exists customer_reminder_phone_idx
  on public.customer_reminder (workspace_id, phone_e164, starts_at);

-- ------------------------------------------------------------
-- 2. customer_booking: the customer's own yes
-- ------------------------------------------------------------

alter table public.customer_booking add column if not exists customer_confirmed_at timestamptz null;

comment on column public.customer_booking.customer_confirmed_at is
  'The customer confirmed the booking (a yes to its reminder, or the time they moved it to), 472.';

-- ------------------------------------------------------------
-- 3. business_profile: reminders on unless turned off
-- ------------------------------------------------------------

alter table public.business_profile add column if not exists reminders boolean not null default true;

comment on column public.business_profile.reminders is
  'Text customers a reminder the day before a booked job or meeting (472). On by default; the owner turns it off through their agent.';

-- ------------------------------------------------------------
-- 4. RLS and grants
-- ------------------------------------------------------------

alter table public.customer_reminder enable row level security;

drop policy if exists customer_reminder_select_member on public.customer_reminder;
create policy customer_reminder_select_member on public.customer_reminder
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.customer_reminder from anon, authenticated;
grant select on table public.customer_reminder to authenticated;
grant all on table public.customer_reminder to service_role;
