-- ============================================================
-- 465: A person's agent's own number (src/lib/sms/agent-number.ts)
-- ============================================================
-- The agent panel's Phone tab gives a person's agent a phone number of its
-- own, on a button (never on sign-up): a Twilio number in Dial8's messaging
-- service, the sender pool of the approved 10DLC campaign. Their agent texts
-- them from it, and they text it to reach their agent.
--
--   1. agent_phone_number: who holds which number, one per person and one
--      person per number. The spares are not rows: every number in the
--      messaging service nobody holds is one (Twilio's pool is the
--      inventory). A row deleted (its person idle 30 days, or gone) puts the
--      number back in the pool, still registered. `dial8_until`: carriers
--      refused a text from it as not yet registered (30034 / 30035), so its
--      texts go from the Dial8 number until then.
--   2. sms_message.resend_of: the text a status callback resent from the
--      Dial8 number, once per refused text (the unique key is the claim).
--
-- RLS on; a person reads their own row; only the service role writes.
-- Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. agent_phone_number
-- ------------------------------------------------------------

create table if not exists public.agent_phone_number (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_e164 text not null,
  twilio_sid text not null,
  dial8_until timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.agent_phone_number is
  'A person''s agent''s own Twilio number, in Dial8''s messaging service (465). Numbers in the service nobody holds are the spares.';
comment on column public.agent_phone_number.dial8_until is
  'Carriers refused a text from the number as not yet registered: its texts go from the Dial8 number until then.';

alter table public.agent_phone_number drop constraint if exists agent_phone_number_phone_shape;
alter table public.agent_phone_number
  add constraint agent_phone_number_phone_shape check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$');
alter table public.agent_phone_number drop constraint if exists agent_phone_number_sid_shape;
alter table public.agent_phone_number
  add constraint agent_phone_number_sid_shape check (twilio_sid ~ '^PN[0-9a-fA-F]{32}$');

create unique index if not exists agent_phone_number_user_key on public.agent_phone_number (user_id);
create unique index if not exists agent_phone_number_phone_key on public.agent_phone_number (phone_e164);

alter table public.agent_phone_number enable row level security;

drop policy if exists agent_phone_number_select_own on public.agent_phone_number;
create policy agent_phone_number_select_own on public.agent_phone_number
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.agent_phone_number from anon, authenticated;
grant select on table public.agent_phone_number to authenticated;
grant all on table public.agent_phone_number to service_role;

-- ------------------------------------------------------------
-- 2. sms_message.resend_of
-- ------------------------------------------------------------

alter table public.sms_message add column if not exists resend_of text null;

comment on column public.sms_message.resend_of is
  'The MessageSid of a text carriers refused from an agent number, which this row resent from the Dial8 number (465).';

alter table public.sms_message drop constraint if exists sms_message_resend_of_length;
alter table public.sms_message
  add constraint sms_message_resend_of_length check (resend_of is null or char_length(resend_of) <= 64);

create unique index if not exists sms_message_resend_of_key on public.sms_message (resend_of) where resend_of is not null;
