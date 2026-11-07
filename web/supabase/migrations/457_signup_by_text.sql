-- ============================================================
-- 457: Sign up by text, and single-use links (roadmap track A)
-- ============================================================
-- A business owner signs up by texting the Dial8 number and connects their
-- accounts by tapping texted links (src/lib/sms/signup.ts,
-- src/lib/links/one-time.ts).
--
--   1. phone_signup_code: a pending sign-up code for a number nobody linked.
--      An unknown number texts the Dial8 number, gets a 6-digit code, and
--      replying with it creates the account with the number verified. Only
--      the code's HMAC is stored (keyed on the server's internal secret and
--      bound to the number). The rows are also the per-number send ledger the
--      rate limits count. Service role only.
--   2. one_time_link: a single-use link bound to one account, for one
--      purpose (today: an OAuth connect started from a text), that expires
--      (15 minutes by default). Only the token's sha256 is stored. Service
--      role only. Another purpose (Stripe Connect, track C) widens the check.
--   3. sms_message.kind: 454's list plus 'signup_code_miss' (in: a wrong
--      sign-up code, the daily guess cap counts them) and 'signup_code',
--      'connected' (out: a sign-up code, and the "Google is connected" text).
--      A later migration that replaces this check must keep them.
--   4. release_signup_number(phone): frees a number from an older account's
--      auth row (its `phone` and phone identity), when that account no longer
--      has the number verified (it unlinked it, or the number moved). Called
--      only after the person proved they hold the number with a code, so a
--      recycled number makes a fresh account instead of opening someone
--      else's. Returns the released accounts' ids: a phone-only account has
--      no other way in, so the app switches its connections off. Service
--      role only.
--
-- Idempotent: safe to re-apply.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. phone_signup_code
-- ------------------------------------------------------------
create table if not exists public.phone_signup_code (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.phone_signup_code is
  'A pending sign-up code for a number nobody linked (457): an HMAC of the code, attempts, expiry. Also the per-number send ledger. Service role only (no client policy on purpose).';

alter table public.phone_signup_code drop constraint if exists phone_signup_code_e164_format;
alter table public.phone_signup_code
  add constraint phone_signup_code_e164_format check (phone_e164 ~ '^[+][1-9][0-9]{6,14}$');

alter table public.phone_signup_code drop constraint if exists phone_signup_code_hash_length;
alter table public.phone_signup_code
  add constraint phone_signup_code_hash_length check (char_length(code_hash) = 64);

alter table public.phone_signup_code drop constraint if exists phone_signup_code_attempts_check;
alter table public.phone_signup_code
  add constraint phone_signup_code_attempts_check check (attempts between 0 and 50);

create index if not exists phone_signup_code_phone_created_idx
  on public.phone_signup_code (phone_e164, created_at desc);

-- One pending code per number: two texts at once can't both store one.
create unique index if not exists phone_signup_code_one_pending_key
  on public.phone_signup_code (phone_e164) where consumed_at is null;

alter table public.phone_signup_code enable row level security;
revoke all on table public.phone_signup_code from anon, authenticated;
grant all on table public.phone_signup_code to service_role;

-- ------------------------------------------------------------
-- 2. one_time_link
-- ------------------------------------------------------------
create table if not exists public.one_time_link (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  purpose text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.one_time_link is
  'A single-use link bound to one account and one purpose (457): sha256 of the token, expiry, consumed_at. Service role only (no client policy on purpose).';
comment on column public.one_time_link.purpose is
  'What the link does: oauth_connect (start a provider sign-in from a text). src/lib/links/purposes.ts.';

create unique index if not exists one_time_link_token_hash_key on public.one_time_link (token_hash);
create index if not exists one_time_link_user_created_idx on public.one_time_link (user_id, created_at desc);

alter table public.one_time_link drop constraint if exists one_time_link_purpose_check;
alter table public.one_time_link
  add constraint one_time_link_purpose_check check (purpose in ('oauth_connect'));

alter table public.one_time_link drop constraint if exists one_time_link_token_hash_length;
alter table public.one_time_link
  add constraint one_time_link_token_hash_length check (char_length(token_hash) = 64);

alter table public.one_time_link drop constraint if exists one_time_link_payload_size;
alter table public.one_time_link
  add constraint one_time_link_payload_size check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 4096);

alter table public.one_time_link enable row level security;
revoke all on table public.one_time_link from anon, authenticated;
grant all on table public.one_time_link to service_role;

-- ------------------------------------------------------------
-- 3. sms_message.kind: 454's list plus the sign-up kinds
-- ------------------------------------------------------------
alter table public.sms_message drop constraint if exists sms_message_kind_check;
alter table public.sms_message
  add constraint sms_message_kind_check check (
    kind in (
      'text', 'stop', 'start', 'help', 'unknown', 'limited', 'approval', 'code_miss',
      'guest_text', 'guest_invite', 'guest_join',
      'signup_code_miss',
      'verification', 'welcome', 'reply', 'notice', 'unknown_reply', 'auto_reply', 'needs_you', 'approval_result',
      'guest_reply', 'guest_welcome', 'guest_notice',
      'away',
      'signup_code', 'connected'
    )
  );

comment on column public.sms_message.kind is
  'in: text, stop, start, help, unknown, limited, approval, code_miss, guest_text, guest_invite, guest_join, signup_code_miss (457). out: verification, welcome, reply, notice, unknown_reply, auto_reply (HELP / START answers), needs_you, approval_result, guest_reply, guest_welcome, guest_notice, away (454), signup_code, connected (457).';

-- ------------------------------------------------------------
-- 4. release_signup_number
-- ------------------------------------------------------------
-- GoTrue stores auth.users.phone without the '+', and a phone user has a
-- 'phone' identity: both are freed (the identity by its user), or the new
-- account's identity could collide. An account that still has the number
-- verified in user_phone is never touched.
create or replace function public.release_signup_number(p_phone text)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bare text := ltrim(coalesce(p_phone, ''), '+');
  v_released uuid[];
begin
  if v_bare !~ '^[1-9][0-9]{6,14}$' then
    return '{}'::uuid[];
  end if;

  with holders as (
    select u.id
    from auth.users u
    where u.phone in (v_bare, '+' || v_bare)
      and not exists (
        select 1 from public.user_phone p
        where p.user_id = u.id
          and p.phone_e164 = '+' || v_bare
          and p.verified_at is not null
      )
  ),
  freed_identities as (
    delete from auth.identities i
    using holders h
    where i.user_id = h.id
      and i.provider = 'phone'
    returning i.user_id
  ),
  freed as (
    update auth.users u
    set phone = null, phone_confirmed_at = null, updated_at = now()
    from holders h
    where u.id = h.id
    returning u.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_released from freed;

  return v_released;
end;
$$;

comment on function public.release_signup_number(text) is
  'Frees a phone number from older auth accounts that no longer have it verified in user_phone (457), so a text sign-up that proved the number with a code can create a fresh account. Returns their ids. Service role only.';

revoke execute on function public.release_signup_number(text) from public, anon, authenticated;
grant execute on function public.release_signup_number(text) to service_role;
