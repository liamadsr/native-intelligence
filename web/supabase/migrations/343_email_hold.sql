-- ============================================================
-- 343: the holding pattern (no stored mail, slice 1)
-- ============================================================
-- Decision, 2026-10-15 (Liam): Dial8 keeps no copy of the person's mail. The
-- ONE exception is a thread Dial8 drafted a reply to: its copy waits, beside
-- the draft, until the person sends or dismisses the draft, then it goes.
--   "we get the incoming message. We determine if it needs a reply or not. If
--    it doesn't need a reply, just like ignore it. And then if it needs a
--    reply, draft up a reply, and it goes into this holding pattern where I can
--    review the reply, make updates to it, and I can see the full chain so I
--    know what I'm responding to. And then once I sent it, then it's sent."
--
-- What lands:
--   email_hold             one row per held thread, for its mailbox owner:
--     user_id              the mailbox owner (auth.users). The ONLY reader.
--     workspace_id         the account's home workspace (where the draft is).
--     account_id           the connected mailbox; NULL for a legacy one.
--     provider, provider_thread_id   the thread, at the provider.
--     held_message_id      the newest message the copy reflects: a newer one
--                          refreshes the copy (src/lib/email/hold.ts).
--     subject              the thread's subject.
--     messages             the chain, oldest first, plain text only:
--                          [{message_id, from, to[], cc[], date, body_text,
--                            attachment_names[]}], at most 30 messages and
--                          20000 characters a body (the reply gate's limits).
--                          No HTML (tracking pixels), no attachment bytes.
--     trust                'injection' when email.trust marked the thread:
--                          a helper reading the hold runs read-only.
--     status               'held', or 'sending' while a send is in flight
--                          (back to 'held' when the send fails).
--     last_touched_at, expires_at   opening or editing the hold pushes
--                          expires_at out 14 days; past it the hourly
--                          email-hold-expiry job deletes the row (the
--                          provider draft stays in the mailbox: it is theirs).
--   email_draft.hold_id    the hold a reply draft answers; deleting the hold
--                          deletes its drafts (send, dismiss, expiry).
--   email_draft.stale      a new message arrived on the thread after the
--                          person edited the draft: their text is kept, the
--                          card says "New reply since this draft".
--
-- Who may do what: the mailbox owner reads their own holds (auth.uid() =
-- user_id), nobody else, not even a workspace admin. Only the service role
-- writes (insert, update, delete): the client never does.
--
-- A hold's workspace_id is the workspace the draft was written in. Relinking
-- the mailbox to another workspace (reconcile_email_thread_copies) moves the
-- thread copies, not the hold: it stays listed where it was drafted until it
-- is sent, dismissed or expires (14 days). The workspace move engine moves no
-- mail. The table is
-- NOT in the realtime publication (a hold carries mail text); the client
-- listens to email_draft, which changes whenever a hold does.
--
-- Applied by hand, from this file: to DEV, and to PROD only on the owner's
-- word, BEFORE the PR whose code writes holds (src/lib/email/hold.ts) merges.
-- Code deployed before it degrades, never fails: holdThread finds no table
-- and writes nothing, so a draft is saved without a hold (and without the
-- held chain in review); the draft reads that name hold_id or stale fall back
-- to the pre-343 columns (src/lib/email/hold.ts isPre343Error), so drafting,
-- send, dismiss, revise and get_email_drafts keep working; there is no To
-- review list, no stale mark and no re-draft on a new message until it lands.
--
-- Idempotent: create table if not exists, add column if not exists, drop
-- policy if exists + create, create index if not exists, drop constraint if
-- exists + add; REVOKE/GRANT restate the full privilege set. This file holds
-- no backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The hold ─────────────────────────────────────────────────────────────
create table if not exists public.email_hold (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  account_id uuid references public.connected_account (id) on delete cascade,
  provider text not null,
  provider_thread_id text not null,
  held_message_id text not null,
  subject text,
  messages jsonb not null default '[]'::jsonb,
  trust text,
  status text not null default 'held',
  last_touched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_hold drop constraint if exists email_hold_provider_check;
alter table public.email_hold
  add constraint email_hold_provider_check check (provider in ('google', 'microsoft'));

alter table public.email_hold drop constraint if exists email_hold_status_check;
alter table public.email_hold
  add constraint email_hold_status_check check (status in ('held', 'sending'));

alter table public.email_hold drop constraint if exists email_hold_trust_check;
alter table public.email_hold
  add constraint email_hold_trust_check check (trust is null or trust = 'injection');

alter table public.email_hold drop constraint if exists email_hold_messages_shape;
alter table public.email_hold
  add constraint email_hold_messages_shape
  check (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) <= 30);

-- One hold per thread per mailbox. NULLS NOT DISTINCT: a legacy mailbox
-- (account_id NULL) still holds a thread once.
alter table public.email_hold drop constraint if exists email_hold_thread_key;
alter table public.email_hold
  add constraint email_hold_thread_key unique nulls not distinct (user_id, account_id, provider_thread_id);

create index if not exists email_hold_expires_idx on public.email_hold (expires_at);
create index if not exists email_hold_owner_idx on public.email_hold (user_id, workspace_id, created_at desc);

comment on table public.email_hold is
  'The holding pattern (343): the only copy of received mail Dial8 keeps, for a thread it drafted a reply to, readable by the mailbox owner only. Deleted on send, dismiss, or 14 days untouched (src/lib/email/hold.ts).';

-- ── 2. Drafts hang off the hold ─────────────────────────────────────────────
alter table public.email_draft
  add column if not exists hold_id uuid references public.email_hold (id) on delete cascade;
alter table public.email_draft
  add column if not exists stale boolean not null default false;

create index if not exists email_draft_hold_idx on public.email_draft (hold_id) where hold_id is not null;

comment on column public.email_draft.hold_id is
  'The hold (343) this reply draft answers: deleting the hold deletes the draft. NULL for a draft of the person''s own words (compose, outreach), which quotes no received mail.';
comment on column public.email_draft.stale is
  'A new message arrived on the held thread after the person edited this draft (343): their text is kept and the card says so.';

-- ── 3. When the person last sent or dismissed a draft ───────────────────────
-- Sent and dismissed drafts are deleted now, and they were the signal a
-- mail-only workspace was in use (workspaceIsDormant). A small service-only
-- table keeps it: not member (coworkers read member rows, and member is in
-- the realtime publication, so every send would broadcast an update). RLS on
-- with no policy: neither anon nor authenticated reads or writes it.
create table if not exists public.mail_review_activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  last_review_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

create index if not exists mail_review_activity_workspace_idx
  on public.mail_review_activity (workspace_id, last_review_at desc);

comment on table public.mail_review_activity is
  'When each person last sent or dismissed a reply draft in a workspace (343): the durable activity signal dormancy reads, since those draft rows are deleted. Service role only.';

alter table public.mail_review_activity enable row level security;
revoke all on table public.mail_review_activity from anon, authenticated;
grant all on table public.mail_review_activity to service_role;

-- ── 4. Owner only ───────────────────────────────────────────────────────────
alter table public.email_hold enable row level security;

drop policy if exists "email_hold_select_own" on public.email_hold;
create policy "email_hold_select_own"
  on public.email_hold for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- The client only reads holds (Mail's To review list and counts, on the
-- person's own session); every write (hold, refresh, touch, send, dismiss,
-- expiry) is the service role's. So: no insert, update or delete policy, and
-- authenticated holds SELECT alone. Earlier drafts of this file had owner
-- update/delete policies: they are dropped if present.
drop policy if exists "email_hold_update_own" on public.email_hold;
drop policy if exists "email_hold_delete_own" on public.email_hold;
revoke all on table public.email_hold from anon, authenticated;
grant select on table public.email_hold to authenticated;
grant all on table public.email_hold to service_role;
