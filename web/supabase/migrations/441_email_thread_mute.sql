-- ============================================================
-- 441: muted mail threads (GEN-1166, the agent's inbox triage)
-- ============================================================
-- The agent can mute a thread (update_email_thread mute: true): it leaves the
-- inbox now, and every later message on it skips the inbox too. Neither
-- provider lets an app mute: Gmail's API has no mute, and Graph has no
-- "Ignore conversation". So Dial8 keeps the list, and the arrival triage
-- (src/lib/email/triage.ts) archives a muted thread again when a new message
-- lands on it, and keeps it out of drafting and the agent's news.
--
-- What lands:
--   email_thread_mute      one row per muted thread, for its mailbox owner:
--     user_id              the mailbox owner (auth.users). The ONLY reader.
--     account_id           the connected mailbox; NULL for a legacy one.
--     provider, provider_thread_id   the thread, at the provider.
-- No mail text: the thread's id only (no stored mail, 2026-10-15).
--
-- RLS: the owner reads their own rows; every write (mute, unmute) is the
-- service role's (src/lib/email/thread-triage.ts). Not in the realtime
-- publication.
--
-- Idempotent: create table if not exists, drop constraint if exists + add,
-- drop policy if exists + create, create index if not exists; REVOKE/GRANT
-- restate the full privilege set. This file holds no backslash anywhere: one
-- MCP transport decodes escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.email_thread_mute (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid references public.connected_account (id) on delete cascade,
  provider text not null,
  provider_thread_id text not null,
  created_at timestamptz not null default now()
);

alter table public.email_thread_mute drop constraint if exists email_thread_mute_provider_check;
alter table public.email_thread_mute
  add constraint email_thread_mute_provider_check check (provider in ('google', 'microsoft'));

-- One mute per thread per mailbox. NULLS NOT DISTINCT: a legacy mailbox
-- (account_id NULL) still mutes a thread once.
alter table public.email_thread_mute drop constraint if exists email_thread_mute_thread_key;
alter table public.email_thread_mute
  add constraint email_thread_mute_thread_key unique nulls not distinct (user_id, account_id, provider_thread_id);

create index if not exists email_thread_mute_owner_idx on public.email_thread_mute (user_id, provider_thread_id);

comment on table public.email_thread_mute is
  'Muted mail threads (441): a new message on one is archived again on arrival and kept out of drafting and the agent''s news (src/lib/email/triage.ts). Thread ids only, readable by the mailbox owner only; written by src/lib/email/thread-triage.ts.';

alter table public.email_thread_mute enable row level security;

drop policy if exists "email_thread_mute_select_own" on public.email_thread_mute;
create policy "email_thread_mute_select_own"
  on public.email_thread_mute for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.email_thread_mute from anon, authenticated;
grant select on table public.email_thread_mute to authenticated;
grant all on table public.email_thread_mute to service_role;
