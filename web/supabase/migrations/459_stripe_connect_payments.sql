-- ============================================================
-- 459: Payments through the owner's own Stripe (roadmap track C)
-- ============================================================
-- A service business's customers pay straight into the owner's Stripe
-- account: Stripe Connect, with Dial8's Stripe account as the platform
-- (docs/plans/stripe-connect-payments.md). Dial8's own billing
-- (src/lib/billing/*, the stripe-webhook edge function) is untouched.
--
--   1. stripe_connect_account   the workspace's connected Stripe account, one
--                               per workspace: made by Dial8 (Accounts v2, full
--                               Dashboard, Stripe-owned fees and losses) or an
--                               existing account the owner linked by Stripe
--                               OAuth. Holds the optional platform fee
--                               (basis points + fixed cents, both default 0:
--                               pricing isn't decided, nothing depends on it).
--   2. stripe_connect_link      the texted onboarding link: single use, bound
--                               to one account (user + workspace), 15 minutes.
--                               Only the token's sha256 is stored. The same
--                               shape as track A's one_time_link (457); it
--                               folds into that table (purpose stripe_connect)
--                               once both are merged.
--   3. payment_request          a payment link the agent sent a customer for a
--                               quote or job: a Stripe Payment Link on the
--                               connected account (a direct charge, one
--                               completed checkout), what it is for, who got
--                               it, the to-do it closes, and what happened
--                               (paid, refunded, disputed).
--   4. stripe_connect_event     every Connect webhook event, once (the
--                               idempotency key), with what it touched. Refunds
--                               and disputes are logged here and on the
--                               payment request; nothing acts on them.
--   5. checks widened           agent_event.kind 'job.paid' (and track B's
--                               'quote.received', kept so either order of 458
--                               and 459 holds); contact_interaction's type
--                               'payment_requested', 'payment_received' and
--                               reference_type 'payment_request'.
--
-- Who reads and writes: workspace members read their workspace's connected
-- account and payment requests; only the service role writes anything (the
-- agent tool, the onboarding routes and the webhook all run server side). The
-- link and event tables have no client policy at all.
--
-- Applied by hand, from this file, to DEV first, then PROD, before the code
-- that reads it. Additive. Idempotent. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. stripe_connect_account
-- ------------------------------------------------------------
create table if not exists public.stripe_connect_account (
  workspace_id uuid primary key references public.workspace(id) on delete cascade,
  stripe_account_id text not null,
  linked_via text not null,
  livemode boolean not null default false,
  status text not null default 'onboarding',
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  connected_by uuid null references auth.users(id) on delete set null,
  application_fee_bps integer not null default 0,
  application_fee_cents integer not null default 0,
  ready_at timestamptz null,
  ready_notified_at timestamptz null,
  disconnected_at timestamptz null,
  synced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.stripe_connect_account is
  'The workspace''s connected Stripe account (459): customers pay into it by direct charges. Service role writes only.';
comment on column public.stripe_connect_account.linked_via is
  'created: Dial8 made it (Accounts v2, full Dashboard) and the owner onboarded on Stripe. oauth: an existing Stripe account the owner linked.';
comment on column public.stripe_connect_account.status is
  'onboarding (Stripe still needs details), ready (can take card payments), restricted (Stripe paused charges), disconnected (the owner removed Dial8).';
comment on column public.stripe_connect_account.application_fee_bps is
  'Dial8''s optional platform fee in basis points of each payment (459). Default 0: pricing isn''t decided. Set by Dial8 staff only.';
comment on column public.stripe_connect_account.application_fee_cents is
  'Dial8''s optional fixed platform fee per payment, in the payment''s currency minor unit (459). Default 0.';
comment on column public.stripe_connect_account.ready_notified_at is
  'When the owner was texted that payments are on: set once, so the confirmation goes out once.';

alter table public.stripe_connect_account drop constraint if exists stripe_connect_account_id_shape;
alter table public.stripe_connect_account
  add constraint stripe_connect_account_id_shape check (stripe_account_id ~ '^acct_[A-Za-z0-9]{6,64}$');
alter table public.stripe_connect_account drop constraint if exists stripe_connect_account_linked_via_check;
alter table public.stripe_connect_account
  add constraint stripe_connect_account_linked_via_check check (linked_via in ('created', 'oauth'));
alter table public.stripe_connect_account drop constraint if exists stripe_connect_account_status_check;
alter table public.stripe_connect_account
  add constraint stripe_connect_account_status_check check (status in ('onboarding', 'ready', 'restricted', 'disconnected'));
alter table public.stripe_connect_account drop constraint if exists stripe_connect_account_fee_range;
alter table public.stripe_connect_account
  add constraint stripe_connect_account_fee_range check (application_fee_bps between 0 and 2000 and application_fee_cents between 0 and 10000);

-- One workspace per live account: the webhook finds the workspace by the account.
create unique index if not exists stripe_connect_account_live_account_key
  on public.stripe_connect_account (stripe_account_id) where status <> 'disconnected';

-- ------------------------------------------------------------
-- 2. stripe_connect_link
-- ------------------------------------------------------------
create table if not exists public.stripe_connect_link (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  purpose text not null default 'stripe_connect',
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.stripe_connect_link is
  'The texted Stripe onboarding link (459): single use, bound to one account, 15 minutes; sha256 of the token only. Same shape as one_time_link (457), into which it folds. Service role only.';

create unique index if not exists stripe_connect_link_token_hash_key on public.stripe_connect_link (token_hash);
create index if not exists stripe_connect_link_workspace_created_idx on public.stripe_connect_link (workspace_id, created_at desc);

alter table public.stripe_connect_link drop constraint if exists stripe_connect_link_purpose_check;
alter table public.stripe_connect_link
  add constraint stripe_connect_link_purpose_check check (purpose in ('stripe_connect'));
alter table public.stripe_connect_link drop constraint if exists stripe_connect_link_token_hash_length;
alter table public.stripe_connect_link
  add constraint stripe_connect_link_token_hash_length check (char_length(token_hash) = 64);
alter table public.stripe_connect_link drop constraint if exists stripe_connect_link_payload_size;
alter table public.stripe_connect_link
  add constraint stripe_connect_link_payload_size check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 2048);

-- ------------------------------------------------------------
-- 3. payment_request
-- ------------------------------------------------------------
create table if not exists public.payment_request (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  contact_id uuid null references public.contact(id) on delete set null,
  subject_type text not null,
  subject_id text null,
  action_id uuid null references public.actions(id) on delete set null,
  description text not null,
  amount_cents integer not null,
  currency text not null default 'usd',
  application_fee_cents integer not null default 0,
  stripe_account_id text not null,
  livemode boolean not null default false,
  stripe_payment_link_id text null,
  url text null,
  status text not null default 'open',
  sent_to_phone text null,
  sent_to_email text null,
  sent_via text[] not null default '{}',
  sent_at timestamptz null,
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,
  amount_paid_cents integer null,
  paid_at timestamptz null,
  paid_followups_queued_at timestamptz null,
  amount_refunded_cents integer not null default 0,
  refunded_at timestamptz null,
  disputed_at timestamptz null,
  dispute_status text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payment_request is
  'A payment link sent to a customer for a quote or job (459): a Stripe Payment Link on the workspace''s connected account, and what happened to it. Service role writes only.';
comment on column public.payment_request.subject_type is
  'What it is for: quote (track B customer_quote), booking (customer_booking), action (a to-do) or job (anything else the owner named).';
comment on column public.payment_request.action_id is
  'The to-do this payment closes when it is paid.';
comment on column public.payment_request.paid_followups_queued_at is
  'When the paid follow-ups (close the to-do, CRM note, text the owner, job.paid) were queued. A webhook retry after a lost queue re-queues them; the queue dedupes on the request.';
comment on column public.payment_request.status is
  'open (sent, not paid), paid, refunded (in full; a partial refund keeps paid), disputed, cancelled (the link was switched off unpaid).';

alter table public.payment_request drop constraint if exists payment_request_subject_type_check;
alter table public.payment_request
  add constraint payment_request_subject_type_check check (subject_type in ('quote', 'booking', 'action', 'job'));
alter table public.payment_request drop constraint if exists payment_request_status_check;
alter table public.payment_request
  add constraint payment_request_status_check check (status in ('open', 'paid', 'refunded', 'disputed', 'cancelled'));
alter table public.payment_request drop constraint if exists payment_request_amount_range;
alter table public.payment_request
  add constraint payment_request_amount_range check (
    amount_cents between 50 and 5000000
    and application_fee_cents between 0 and amount_cents
    and (amount_paid_cents is null or amount_paid_cents >= 0)
    and amount_refunded_cents >= 0
  );
alter table public.payment_request drop constraint if exists payment_request_currency_shape;
alter table public.payment_request
  add constraint payment_request_currency_shape check (currency ~ '^[a-z]{3}$');
alter table public.payment_request drop constraint if exists payment_request_account_shape;
alter table public.payment_request
  add constraint payment_request_account_shape check (stripe_account_id ~ '^acct_[A-Za-z0-9]{6,64}$');
alter table public.payment_request drop constraint if exists payment_request_text_lengths;
alter table public.payment_request
  add constraint payment_request_text_lengths check (
    char_length(btrim(description)) between 1 and 200
    and (subject_id is null or char_length(subject_id) <= 64)
    and (url is null or char_length(url) <= 500)
    and (sent_to_phone is null or sent_to_phone ~ '^[+][1-9][0-9]{7,14}$')
    and (sent_to_email is null or char_length(sent_to_email) <= 254)
    and cardinality(sent_via) <= 2
    and (dispute_status is null or char_length(dispute_status) <= 40)
  );

create unique index if not exists payment_request_payment_link_key
  on public.payment_request (stripe_payment_link_id) where stripe_payment_link_id is not null;
create index if not exists payment_request_workspace_idx on public.payment_request (workspace_id, created_at desc);
create index if not exists payment_request_subject_idx on public.payment_request (workspace_id, subject_type, subject_id);
create index if not exists payment_request_intent_idx on public.payment_request (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists payment_request_contact_idx on public.payment_request (contact_id) where contact_id is not null;

-- ------------------------------------------------------------
-- 4. stripe_connect_event
-- ------------------------------------------------------------
create table if not exists public.stripe_connect_event (
  event_id text primary key,
  type text not null,
  stripe_account_id text null,
  livemode boolean not null default false,
  workspace_id uuid null references public.workspace(id) on delete set null,
  payment_request_id uuid null references public.payment_request(id) on delete set null,
  outcome text null,
  summary jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz null
);

comment on table public.stripe_connect_event is
  'Each Stripe Connect webhook event, once (459): the idempotency key, and the log of refunds and disputes (recorded, never acted on). Service role only.';

alter table public.stripe_connect_event drop constraint if exists stripe_connect_event_shape;
alter table public.stripe_connect_event
  add constraint stripe_connect_event_shape check (
    char_length(event_id) between 1 and 255
    and char_length(type) between 1 and 120
    and (outcome is null or char_length(outcome) <= 60)
    and jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 2048
  );

create index if not exists stripe_connect_event_request_idx on public.stripe_connect_event (payment_request_id) where payment_request_id is not null;
create index if not exists stripe_connect_event_workspace_idx on public.stripe_connect_event (workspace_id, received_at desc) where workspace_id is not null;

-- ------------------------------------------------------------
-- 5. Checks widened
-- ------------------------------------------------------------
-- 336's kinds through 451, track B's quote.received (458) and job.paid.
alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed', 'email.arrived', 'pr.changed', 'connection.needs_reconnect', 'quote.received', 'job.paid'));

alter table public.contact_interaction drop constraint if exists contact_interaction_interaction_type_check;
alter table public.contact_interaction
  add constraint contact_interaction_interaction_type_check check (interaction_type in ('capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added', 'payment_requested', 'payment_received'));
alter table public.contact_interaction drop constraint if exists contact_interaction_reference_type_check;
alter table public.contact_interaction
  add constraint contact_interaction_reference_type_check check (reference_type in ('capture', 'email_thread', 'action', 'document', 'payment_request'));

-- ------------------------------------------------------------
-- 6. RLS and grants
-- ------------------------------------------------------------
alter table public.stripe_connect_account enable row level security;
alter table public.stripe_connect_link enable row level security;
alter table public.payment_request enable row level security;
alter table public.stripe_connect_event enable row level security;

drop policy if exists stripe_connect_account_select_member on public.stripe_connect_account;
create policy stripe_connect_account_select_member on public.stripe_connect_account
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists payment_request_select_member on public.payment_request;
create policy payment_request_select_member on public.payment_request
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.stripe_connect_account from anon, authenticated, public;
revoke all on table public.stripe_connect_link from anon, authenticated, public;
revoke all on table public.payment_request from anon, authenticated, public;
revoke all on table public.stripe_connect_event from anon, authenticated, public;
grant select on table public.stripe_connect_account to authenticated;
grant select on table public.payment_request to authenticated;
grant all on table public.stripe_connect_account to service_role;
grant all on table public.stripe_connect_link to service_role;
grant all on table public.payment_request to service_role;
grant all on table public.stripe_connect_event to service_role;
