-- ============================================================
-- 429: A guest's agent reaches the owner (guest access, PR3 of 5), and
-- per-tool Needs approval.
--
-- A guest's agent (agent_guest, 427) can now pass the owner a note, ask the
-- owner's own agent for something it can't do, and remember what the person
-- likes (agent_guest_memory, 427). The owner picks, per tool, Always allow,
-- Needs approval or Blocked (src/lib/guests/presets.ts).
--
--   agent_guest.ask_tools    the tools the guest holds that wait for the
--                            owner's yes on every call (Needs approval).
--                            Always a subset of tools; a tool not in tools is
--                            Blocked.
--   agent_guest_ask          one question a guest's agent asked the owner's
--                            agent (ask_owner_agent). A home turn with reason
--                            'guest_ask' carries it to the owner's agent in
--                            their home thread, which answers it
--                            (answer_guest: texted to the guest), declines
--                            it, or tells the owner.
--   home_turn.reason         may now be 'guest_ask'.
--   reach_notice.ref_type    may now be 'guest_message': an urgent note from a
--                            guest, pinged to the owner once per channel
--                            (the same daily caps as an approval's ping).
--
-- Who reads and writes: the owner reads their own asks (select only); every
-- write is the service role's.
--
-- Applied by hand, from this file, to DEV now and to PROD with 427 and 428
-- when the whole build ships. Additive. Idempotent. No backslashes anywhere
-- in this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── agent_guest.ask_tools: Needs approval ──────────────────────────────────

alter table public.agent_guest
  add column if not exists ask_tools text[] not null default '{}';

comment on column public.agent_guest.ask_tools is
  'The held tools (a subset of tools) whose every call waits for the owner''s yes: Needs approval (429). A tool in tools and not here is Always allow; a tool not in tools is Blocked.';

alter table public.agent_guest drop constraint if exists agent_guest_ask_tools_held;
alter table public.agent_guest
  add constraint agent_guest_ask_tools_held check (ask_tools <@ tools);

alter table public.agent_guest drop constraint if exists agent_guest_ask_tools_cap;
alter table public.agent_guest
  add constraint agent_guest_ask_tools_cap check (cardinality(ask_tools) <= 400);

-- ── agent_guest_ask ────────────────────────────────────────────────────────

create table if not exists public.agent_guest_ask (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references public.agent_guest(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- The guest's thread the answer goes back to.
  guest_conversation_id uuid null references public.chat_conversations(id) on delete set null,
  question text not null,
  status text not null default 'pending',
  answer text null,
  -- The home turn that carried it to the owner's agent, and when.
  home_turn_id uuid null references public.home_turn(id) on delete set null,
  delivered_at timestamptz null,
  answered_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.agent_guest_ask is
  'A question a guest''s agent asked the owner''s own agent (429). A guest_ask home turn carries it; answer_guest settles it. The owner reads their own rows; only the service role writes.';

alter table public.agent_guest_ask drop constraint if exists agent_guest_ask_status_check;
alter table public.agent_guest_ask
  add constraint agent_guest_ask_status_check check (status in ('pending', 'answered', 'declined', 'expired'));

alter table public.agent_guest_ask drop constraint if exists agent_guest_ask_question_length;
alter table public.agent_guest_ask
  add constraint agent_guest_ask_question_length check (char_length(btrim(question)) between 1 and 1000);

alter table public.agent_guest_ask drop constraint if exists agent_guest_ask_answer_length;
alter table public.agent_guest_ask
  add constraint agent_guest_ask_answer_length check (answer is null or char_length(answer) <= 1000);

alter table public.agent_guest_ask drop constraint if exists agent_guest_ask_settled;
alter table public.agent_guest_ask
  add constraint agent_guest_ask_settled check ((status = 'pending') = (answered_at is null));

create index if not exists agent_guest_ask_owner_pending_idx
  on public.agent_guest_ask (owner_user_id, workspace_id, created_at desc) where status = 'pending';
create index if not exists agent_guest_ask_guest_idx on public.agent_guest_ask (guest_id, created_at desc);

alter table public.agent_guest_ask enable row level security;

drop policy if exists agent_guest_ask_select_own on public.agent_guest_ask;
create policy agent_guest_ask_select_own on public.agent_guest_ask
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

revoke all on table public.agent_guest_ask from anon, authenticated;
grant select on table public.agent_guest_ask to authenticated;

-- ── home_turn.reason: 'guest_ask' ──────────────────────────────────────────

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask'));

-- ── reach_notice.ref_type: 'guest_message' ─────────────────────────────────

alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;
alter table public.reach_notice
  add constraint reach_notice_ref_type_check check (ref_type in ('tool_approval', 'guest_message'));

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it: the row read. One row reading (true, true, 0):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'agent_guest'
--               and column_name = 'ask_tools') as has_ask_tools,
--     to_regclass('public.agent_guest_ask') is not null as has_asks,
--     (select count(*) from public.agent_guest_ask) as asks;
