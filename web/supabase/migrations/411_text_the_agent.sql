-- ============================================================
-- 411: text the agent (Phase 1 of docs/plans/text-and-calling.md)
-- ============================================================
-- A person links their phone (Settings -> Phone: a 6-digit code we text),
-- then texts the Dial8 Twilio number. Each text becomes a turn in their home
-- thread on the chat-agent, written by the server (src/lib/chat/text-turn.ts,
-- src/lib/inngest/text-turn.ts), and the reply is texted back.
--
-- Applied by hand, from this file: to DEV, then to PROD only on the owner's
-- word, BEFORE the PR whose code reads these tables merges to main. Additive
-- (three new tables, two columns and a widened check on home_turn) and
-- idempotent (IF NOT EXISTS, each constraint dropped and re-added, each policy
-- dropped and re-created). This file holds no backslash anywhere: one MCP
-- transport decodes escapes, so the applied SQL would differ from the file.
--
-- What lands:
--   user_phone          one verified phone per person: the number (E.164),
--                       the workspace its texts go to, verified_at and
--                       opted_out_at (STOP). A number belongs to one person
--                       at a time (partial unique on phone_e164 where
--                       verified): a later successful verification by someone
--                       else takes it over (numbers get recycled; the code
--                       proves possession). The person reads and deletes
--                       their own row; inserts and updates go through
--                       /api/account/phone/verify and the Twilio webhook with
--                       the service role. consented_at + consent_version
--                       record the SMS consent the person ticked in
--                       Settings (US 10DLC: which words they agreed to, when),
--                       copied from their verification row.
--   phone_verification  a pending code: an HMAC of the code (never the code),
--                       attempts, expiry, consumed_at. NO client access at
--                       all, not even the owner's: a 6-digit code's HMAC is
--                       guessable offline only with the server key, but the
--                       row also says which number is pending, and nothing in
--                       the app needs to read it from the browser.
--   sms_message         a ledger of texts in and out (no bodies): the per-number
--                       rate limit, the per-person daily cap, the once-only
--                       "link this number" reply to an unknown sender, and
--                       STOP / START from a number no one linked. Service
--                       role only.
--   home_turn           a text turn is a home turn (reason 'text'): the same
--                       claim, lease, send, read and finish machinery
--                       (src/lib/chat/home-turn-server.ts), so a text never
--                       runs at the same time as a digest or a helper's report
--                       in one thread. Two columns: text_message_ids (the
--                       person's texts, chat_messages ids, the turn carried)
--                       and reply_sent_at (the reply SMS was claimed: a
--                       retried step never texts twice).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── user_phone ──────────────────────────────────────────────────────────────

create table if not exists public.user_phone (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  phone_e164 text not null,
  verified_at timestamptz null,
  opted_out_at timestamptz null,
  consented_at timestamptz not null,
  consent_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_phone is
  'A person''s linked phone for texting the agent (411). One per person; a verified number belongs to one person. The person reads and deletes their own row; only the service role writes.';
comment on column public.user_phone.workspace_id is
  'The workspace this number''s texts go to (the person''s home thread there).';
comment on column public.user_phone.consent_version is
  'Which SMS consent words the person agreed to in Settings (src/lib/sms/consent.ts SMS_CONSENT_VERSION), at consented_at.';
comment on column public.user_phone.opted_out_at is
  'Set when the number texted STOP (cleared by START or a new verification). Nothing is texted to it while set.';

alter table public.user_phone drop constraint if exists user_phone_consent_version_length;
alter table public.user_phone
  add constraint user_phone_consent_version_length check (char_length(consent_version) between 1 and 40);

alter table public.user_phone drop constraint if exists user_phone_e164_format;
alter table public.user_phone
  add constraint user_phone_e164_format check (phone_e164 ~ '^[+][1-9][0-9]{6,14}$');

create unique index if not exists user_phone_user_key on public.user_phone (user_id);
create unique index if not exists user_phone_verified_phone_key on public.user_phone (phone_e164) where verified_at is not null;
create index if not exists user_phone_workspace_idx on public.user_phone (workspace_id);

alter table public.user_phone enable row level security;

drop policy if exists user_phone_select_own on public.user_phone;
create policy user_phone_select_own on public.user_phone
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists user_phone_delete_own on public.user_phone;
create policy user_phone_delete_own on public.user_phone
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.user_phone from anon, authenticated;
grant select, delete on table public.user_phone to authenticated;
grant all on table public.user_phone to service_role;

-- ── phone_verification ──────────────────────────────────────────────────────

create table if not exists public.phone_verification (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  phone_e164 text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  consented_at timestamptz not null,
  consent_version text not null,
  created_at timestamptz not null default now()
);

comment on table public.phone_verification is
  'A pending phone verification code (411): an HMAC of the code, attempts, expiry. Service role only (no client policy on purpose).';

alter table public.phone_verification drop constraint if exists phone_verification_e164_format;
alter table public.phone_verification
  add constraint phone_verification_e164_format check (phone_e164 ~ '^[+][1-9][0-9]{6,14}$');

alter table public.phone_verification drop constraint if exists phone_verification_consent_version_length;
alter table public.phone_verification
  add constraint phone_verification_consent_version_length check (char_length(consent_version) between 1 and 40);

alter table public.phone_verification drop constraint if exists phone_verification_attempts_check;
alter table public.phone_verification
  add constraint phone_verification_attempts_check check (attempts >= 0 and attempts <= 100);

-- The verify route reads the person's newest pending code; the start route
-- counts recent codes per person and per number (its rate limit).
create index if not exists phone_verification_user_created_idx on public.phone_verification (user_id, created_at desc);
create index if not exists phone_verification_phone_created_idx on public.phone_verification (phone_e164, created_at desc);
create index if not exists phone_verification_workspace_idx on public.phone_verification (workspace_id);

alter table public.phone_verification enable row level security;
revoke all on table public.phone_verification from anon, authenticated;
grant all on table public.phone_verification to service_role;

-- ── sms_message ─────────────────────────────────────────────────────────────

create table if not exists public.sms_message (
  id uuid primary key default gen_random_uuid(),
  direction text not null,
  kind text not null,
  phone_e164 text not null,
  user_id uuid null references auth.users(id) on delete set null,
  twilio_sid text null,
  created_at timestamptz not null default now()
);

comment on table public.sms_message is
  'Texts in and out of the Dial8 number (411), without bodies: rate limits, the daily cap, the once-only unknown-sender reply, and STOP/START from unlinked numbers. Service role only.';
comment on column public.sms_message.kind is
  'in: text, stop, start, help, unknown, limited. out: verification, welcome, reply, notice, unknown_reply, auto_reply (HELP / START answers).';

alter table public.sms_message drop constraint if exists sms_message_direction_check;
alter table public.sms_message
  add constraint sms_message_direction_check check (direction in ('in', 'out'));

alter table public.sms_message drop constraint if exists sms_message_kind_check;
alter table public.sms_message
  add constraint sms_message_kind_check check (
    kind in ('text', 'stop', 'start', 'help', 'unknown', 'limited', 'verification', 'welcome', 'reply', 'notice', 'unknown_reply', 'auto_reply')
  );

alter table public.sms_message drop constraint if exists sms_message_sid_length;
alter table public.sms_message
  add constraint sms_message_sid_length check (twilio_sid is null or char_length(twilio_sid) <= 64);

-- Twilio retries a webhook with the same MessageSid: one row per inbound sid.
create unique index if not exists sms_message_inbound_sid_key on public.sms_message (twilio_sid) where direction = 'in' and twilio_sid is not null;
create index if not exists sms_message_phone_created_idx on public.sms_message (phone_e164, created_at desc);
-- The global hourly cap on replies to numbers nobody linked (unknown_reply, auto_reply).
create index if not exists sms_message_kind_created_idx on public.sms_message (kind, created_at desc);
create index if not exists sms_message_user_created_idx on public.sms_message (user_id, created_at desc) where user_id is not null;

alter table public.sms_message enable row level security;
revoke all on table public.sms_message from anon, authenticated;
grant all on table public.sms_message to service_role;

-- ── home_turn: the text turn ────────────────────────────────────────────────

alter table public.home_turn add column if not exists text_message_ids text[] not null default '{}';
alter table public.home_turn add column if not exists reply_sent_at timestamptz null;

comment on column public.home_turn.text_message_ids is
  'A text turn (reason text, 411): the person''s texts (chat_messages ids) it carried to the agent.';
comment on column public.home_turn.reply_sent_at is
  'A text turn: when its reply SMS was claimed. Set once, before the send, so a retried step never texts twice.';

-- 'slack' is the Slack channel's reason (its own migration, 413, lists 'text'
-- too): either can run last and keep both.
alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack'));

alter table public.home_turn drop constraint if exists home_turn_texts_cap;
alter table public.home_turn
  add constraint home_turn_texts_cap check (cardinality(text_message_ids) <= 20);
