-- ============================================================
-- 309: the main agent's messages to the bots (bot_relay)
-- ============================================================
-- docs/plans/bots-v4.md, "The main agent talks to the bots", Phase A3 (and
-- A4, which needs no migration of its own). The plan numbered it 307; 305 went
-- to B1's limits guard, 306 to the member-role guard, 307 to Phase C's
-- chat_conversations.agent_teammate_id and 308 to B2's voice.
--
-- Applied by hand, from this file: to DEV now, and to PROD only on the
-- owner's word, BEFORE the PR whose code writes the table merges to main (the
-- migration-before-merge gate). Additive: one new table nothing deployed
-- today names. Without it the main chat's send_bot_message answers "could not
-- start" (the claim's insert fails) and wait_for_bot_reply finds nothing; no
-- other path reads or writes it.
--
-- What lands:
--   bot_relay   one row per send_bot_message call (the main chat's tool,
--               run by the chat tool route itself, src/lib/bots/bot-relay.ts):
--               the main agent passes the person's message to a bot, in the
--               chat of an item's run (A3) or in the bot's own thread (A4),
--               and keeps the bot's reply.
--     call_key            'relay:<conversation>:session:<s>:turn:<t>:call:<c>',
--                         eve's durable ids for the call (never model input).
--                         UNIQUE: the claim is an insert, so a retried call
--                         finds its row and never sends twice.
--     user_id             who asked (the main chat's person). The run's
--                         starter for a run chat: the relay refuses anyone else.
--     workspace_id        the item's (or the bot's) workspace.
--     conversation_id     the main-chat conversation that asked.
--     teammate_id         the bot that answers (ai_team_member): a work run's
--                         own teammate (none for a person's own run), a loop
--                         run's bot, or the bot whose thread it is.
--     target              'work_run' (an agent run's parked session),
--                         'loop_run' (a loop run's, tracked_job_session) or
--                         'thread' (the bot's own thread with the person, A4).
--     agent_run_id        a work run's run.
--     work_item_id        the item (tracked_job) the message is about.
--     thread_conversation_id   the bot's thread (A4).
--     message             what the main agent sent, at most 4,000 characters.
--     status              'running' (claimed; the bot's turn is on), 'done'
--                         (it replied), 'failed' (it didn't run, or failed),
--                         'timed_out' (still running at 270 seconds:
--                         cancelled; or still queued then: it may yet run).
--     reply               the bot's reply, fenced as teammate text and capped
--                         (4,000 characters inside the fence).
--     error               why it failed or didn't finish (generic copy).
--     created_at, updated_at, finished_at.
--
-- Access: RLS on. The person reads their own rows (SELECT where user_id =
-- auth.uid()); there is no INSERT, UPDATE or DELETE policy, and those grants
-- are revoked from anon and authenticated: only the server (service role)
-- writes. Not in supabase_realtime.
--
-- ON DELETE (retention): a relay row holds the person's words and the bot's
-- reply, so it goes with the conversations it belongs to. Deleting the person,
-- the workspace, the main-chat conversation that asked, or the bot's thread it
-- went to (A4) deletes the row (CASCADE). A deleted bot, run or item leaves it
-- (SET NULL): the record of who asked what stays with the conversation.
-- There is no time-based purge yet: rows otherwise live as long as their
-- conversation does.
--
-- Idempotent (IF NOT EXISTS, DROP ... IF EXISTS + re-ADD), so a second run
-- changes nothing.

create table if not exists public.bot_relay (
  id uuid primary key default gen_random_uuid(),
  call_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  conversation_id uuid null references public.chat_conversations(id) on delete cascade,
  teammate_id uuid null references public.ai_team_member(id) on delete set null,
  target text not null,
  agent_run_id uuid null references public.agent_run(id) on delete set null,
  work_item_id uuid null references public.tracked_job(id) on delete set null,
  thread_conversation_id uuid null references public.chat_conversations(id) on delete cascade,
  message text not null,
  status text not null default 'running',
  reply text null,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz null
);

comment on table public.bot_relay is
  'The main agent''s messages to the bots (bots v4 Phase A3/A4): one row per send_bot_message call, keyed by eve''s call ids, with the bot''s reply. The person reads their own rows; only the service role writes.';
comment on column public.bot_relay.call_key is
  'relay:<conversation>:session:<s>:turn:<t>:call:<c> (eve''s durable ids). Unique: a retried call finds its row and never sends twice.';
comment on column public.bot_relay.target is
  'work_run (an agent run''s parked session), loop_run (a loop run''s parked session) or thread (the bot''s own thread, A4).';
comment on column public.bot_relay.reply is
  'The bot''s reply, fenced as teammate text (data, never instructions) and capped at 4,000 characters inside the fence.';

-- The two conversation keys CASCADE (retention, above), on a table created
-- before this was decided too (DEV had them SET NULL): dropped and re-added.
alter table public.bot_relay drop constraint if exists bot_relay_conversation_id_fkey;
alter table public.bot_relay
  add constraint bot_relay_conversation_id_fkey
  foreign key (conversation_id) references public.chat_conversations(id) on delete cascade;
alter table public.bot_relay drop constraint if exists bot_relay_thread_conversation_id_fkey;
alter table public.bot_relay
  add constraint bot_relay_thread_conversation_id_fkey
  foreign key (thread_conversation_id) references public.chat_conversations(id) on delete cascade;

create unique index if not exists bot_relay_call_key_key on public.bot_relay (call_key);
-- The cascades' lookups (a conversation's delete finds its relay rows).
create index if not exists bot_relay_conversation_idx on public.bot_relay (conversation_id) where conversation_id is not null;
create index if not exists bot_relay_thread_idx on public.bot_relay (thread_conversation_id) where thread_conversation_id is not null;
create index if not exists bot_relay_user_created_idx on public.bot_relay (user_id, created_at desc);

alter table public.bot_relay drop constraint if exists bot_relay_target_check;
alter table public.bot_relay
  add constraint bot_relay_target_check check (target in ('work_run', 'loop_run', 'thread'));

alter table public.bot_relay drop constraint if exists bot_relay_status_check;
alter table public.bot_relay
  add constraint bot_relay_status_check check (status in ('running', 'done', 'failed', 'timed_out'));

alter table public.bot_relay drop constraint if exists bot_relay_call_key_length;
alter table public.bot_relay
  add constraint bot_relay_call_key_length check (char_length(call_key) between 1 and 1024);

alter table public.bot_relay drop constraint if exists bot_relay_message_length;
alter table public.bot_relay
  add constraint bot_relay_message_length check (char_length(message) between 1 and 4000);

alter table public.bot_relay drop constraint if exists bot_relay_reply_length;
alter table public.bot_relay
  add constraint bot_relay_reply_length check (reply is null or char_length(reply) <= 4100);

alter table public.bot_relay drop constraint if exists bot_relay_error_length;
alter table public.bot_relay
  add constraint bot_relay_error_length check (error is null or char_length(error) <= 1000);

alter table public.bot_relay enable row level security;

drop policy if exists bot_relay_select_own on public.bot_relay;
create policy bot_relay_select_own on public.bot_relay
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.bot_relay from anon, authenticated;
grant select on table public.bot_relay to authenticated;
grant all on table public.bot_relay to service_role;

-- Never in realtime: drop it from the publication if anything ever added it.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bot_relay'
  ) then
    alter publication supabase_realtime drop table public.bot_relay;
  end if;
end $$;

-- After applying, read back (expect: the table, RLS on, one SELECT policy, the
-- unique key and the three other indexes, both conversation keys CASCADE, no
-- rows):
--   select relrowsecurity from pg_class where oid = 'public.bot_relay'::regclass;
--   select policyname, cmd from pg_policies where tablename = 'bot_relay';
--   select indexname from pg_indexes where tablename = 'bot_relay';
--   select conname, confdeltype from pg_constraint where conrelid = 'public.bot_relay'::regclass and contype = 'f';
--   select count(*) from public.bot_relay;
