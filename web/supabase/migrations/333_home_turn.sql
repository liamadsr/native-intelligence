-- ============================================================
-- 333: server-written turns in the home thread (A4 slice 5)
-- ============================================================
-- docs/plans/always-on-agent.md, section 2 ("A server-side turn writer"),
-- section 4 (background helpers report back into the home thread) and
-- decisions 1, 6 and 8. When a background helper's report lands in a home
-- thread (and later, when the router has an event for it), the server sends
-- ONE batched agent turn into that thread's eve session, reads it to its end
-- and writes the reply to chat_messages. The agent may stay quiet.
--
-- One row per server turn: the claim. It is inserted BEFORE anything is sent,
-- unique on (conversation_id, dedupe_key), so a retried Inngest run finds its
-- row and never sends twice (src/lib/chat/home-turn-server.ts).
--
-- Applied by hand, from this file: to DEV now, and to PROD only on the
-- owner's word, BEFORE the PR whose code writes the table merges to main.
-- Additive (one new table), idempotent (CREATE TABLE IF NOT EXISTS, each
-- constraint dropped and re-added, CREATE INDEX IF NOT EXISTS, the policy
-- dropped and re-created). This file holds no backslash anywhere: one MCP
-- transport decodes escapes, so the applied SQL would differ from the file.
--
-- Readers and writers, and what each does on a database without the table:
--   the home/turn.requested consumer (src/lib/inngest/home-turn.ts) claims,
--     moves and settles rows with the service role: the claim fails, so no
--     server turn is sent (the report row and the Teammate updates section
--     still deliver the report on the person's next message);
--   the Teammate updates section (src/lib/chat/teammate-report-context.ts)
--     reads which reports a home turn already delivered: it fails soft and
--     lists every report, as before.
--
-- What lands:
--   home_turn.reason          why the server spoke: 'helper_report' today;
--                             'event' and 'digest' are the router's (A6).
--   home_turn.work_item_ids   the work items (tracked_job ids) the turn is about.
--   home_turn.report_message_ids
--                             the teammate-report chat_messages ids the turn
--                             delivered to the agent, so the next turn's
--                             Teammate updates section leaves them out.
--   home_turn.dedupe_key      a hash of what the turn delivers, per reason.
--   home_turn.status          claimed (row in, nothing sent), sent (eve took
--                             the message), done (read to its end, the reply
--                             written or the agent stayed quiet), skipped
--                             (nothing sent: autonomy off, over the usage
--                             limit, no session) or failed (not sent, or the
--                             send could not be confirmed).
--   home_turn.eve_session_id, eve_turn_id, stream_position
--                             where the turn is read from: the session, eve's
--                             turn id once seen, and the stream index a
--                             re-attaching read continues from.
--   home_turn.message_written true when a reply was written to chat_messages
--                             (false for a quiet turn).
--
-- RLS: the person reads their own rows (user_id = auth.uid()); only the
-- service role writes. Not in the realtime publication: the reply itself is a
-- chat_messages row, which already is.
-- ============================================================

create table if not exists public.home_turn (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  reason text not null,
  work_item_ids uuid[] not null default '{}',
  report_message_ids text[] not null default '{}',
  dedupe_key text not null,
  status text not null default 'claimed',
  eve_session_id text null,
  eve_turn_id text null,
  stream_position integer null,
  message_written boolean not null default false,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.home_turn is
  'Server-written turns in a home thread (A4 slice 5): one row per batched background update the server sent into the thread''s eve session. The person reads their own rows; only the service role writes.';
comment on column public.home_turn.dedupe_key is
  'A hash of what the turn delivers (per reason). Unique per conversation: a retried run finds its row and never sends twice.';
comment on column public.home_turn.report_message_ids is
  'The teammate-report chat_messages ids this turn delivered to the agent; the Teammate updates section leaves them out once the turn is sent.';
comment on column public.home_turn.stream_position is
  'The eve stream index a re-attaching read continues from.';

alter table public.home_turn drop constraint if exists home_turn_conversation_id_fkey;
alter table public.home_turn
  add constraint home_turn_conversation_id_fkey
  foreign key (conversation_id) references public.chat_conversations(id) on delete cascade;

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest'));

alter table public.home_turn drop constraint if exists home_turn_status_check;
alter table public.home_turn
  add constraint home_turn_status_check check (status in ('claimed', 'sent', 'done', 'skipped', 'failed'));

alter table public.home_turn drop constraint if exists home_turn_dedupe_key_length;
alter table public.home_turn
  add constraint home_turn_dedupe_key_length check (char_length(dedupe_key) between 1 and 200);

alter table public.home_turn drop constraint if exists home_turn_work_items_cap;
alter table public.home_turn
  add constraint home_turn_work_items_cap check (cardinality(work_item_ids) <= 50);

alter table public.home_turn drop constraint if exists home_turn_reports_cap;
alter table public.home_turn
  add constraint home_turn_reports_cap check (cardinality(report_message_ids) <= 50);

alter table public.home_turn drop constraint if exists home_turn_stream_position_check;
alter table public.home_turn
  add constraint home_turn_stream_position_check check (stream_position is null or stream_position >= 0);

alter table public.home_turn drop constraint if exists home_turn_error_length;
alter table public.home_turn
  add constraint home_turn_error_length check (error is null or char_length(error) <= 1000);

create unique index if not exists home_turn_dedupe_key_key on public.home_turn (conversation_id, dedupe_key);
create index if not exists home_turn_conversation_created_idx on public.home_turn (conversation_id, created_at desc);

alter table public.home_turn enable row level security;

drop policy if exists home_turn_select_own on public.home_turn;
create policy home_turn_select_own on public.home_turn
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.home_turn from anon, authenticated;
grant select on table public.home_turn to authenticated;
grant all on table public.home_turn to service_role;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'home_turn'
  ) then
    alter publication supabase_realtime drop table public.home_turn;
  end if;
end $$;
