-- 303: the parked session of a loop's skill run (docs/plans/bots-v3.md, Phase 4).
--
-- Applied by hand, from this file: to DEV first. PROD only on Liam's word, and
-- BEFORE the PR whose code writes and reads this table merges (the migration-
-- before-merge gate): a server skill run that parks writes here
-- (src/lib/flows/skill-run-session.ts), and the loop-run chat route
-- (/api/account/activity/[id]/chat) reads here. Without the table the write is
-- logged and skipped (the run itself is unaffected) and the route answers
-- "no chat to continue", so the order matters for the feature, not for runs.
-- Everything here is additive.
--
-- What lands:
--   tracked_job_session   one row per ledger row whose skill run parked its eve
--                  session (conversation mode) when it finished, so Reply and
--                  Open in Dial8 on the loop's item continue THAT chat.
--     tracked_job_id  the ledger row (primary key; ON DELETE CASCADE).
--     workspace_id    the row's workspace, so every service read is fenced.
--     session_state   the eve cursor, agent_run.session_state's contract
--                     (migration 200): { sessionId, streamIndex,
--                     settleStreamIndex }.
--     run_facts       what a follow-up turn's fresh run token is minted from:
--                     { skillId, mode, hasCapture, outputContract, model,
--                     runAsUserId }.
--
-- Why a table of its own and NOT a column on tracked_job: tracked_job is in the
-- supabase_realtime publication with REPLICA IDENTITY FULL (migrations 272 and
-- 295), so a column there would broadcast the session handle to every
-- subscriber on each update. This table is NOT added to the publication.
--
-- Access, as agent_run.session_state (migration 200: service-role writes, never
-- returned by an account route): RLS on with NO policy, and no grant to anon
-- or authenticated. Only the service role reads or writes it, so the owner
-- can't read the raw session state from the browser. The browser learns one
-- boolean, tracked_job.source.run_chat, written by the server at park time.
--
-- Idempotent throughout (IF NOT EXISTS, DROP ... IF EXISTS + re-ADD).

create table if not exists public.tracked_job_session (
  tracked_job_id uuid primary key
    references public.tracked_job(id) on delete cascade,
  workspace_id uuid not null
    references public.workspace(id) on delete cascade,
  session_state jsonb not null,
  run_facts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tracked_job_session is
  'The parked eve session of a loop''s skill run (bots v3 Phase 4): the follow-up chat''s handle. Service role only (RLS on, no policy, no grants); never in supabase_realtime.';
comment on column public.tracked_job_session.session_state is
  'The eve cursor { sessionId, streamIndex, settleStreamIndex } (agent_run.session_state''s contract, migration 200). Server-only.';
comment on column public.tracked_job_session.run_facts is
  'What a follow-up turn''s run token is minted from: { skillId, mode, hasCapture, outputContract, model, runAsUserId }. Server-only.';

alter table public.tracked_job_session drop constraint if exists tracked_job_session_state_is_object;
alter table public.tracked_job_session
  add constraint tracked_job_session_state_is_object
  check (jsonb_typeof(session_state) = 'object');

alter table public.tracked_job_session drop constraint if exists tracked_job_session_run_facts_is_object;
alter table public.tracked_job_session
  add constraint tracked_job_session_run_facts_is_object
  check (jsonb_typeof(run_facts) = 'object');

create index if not exists tracked_job_session_workspace_idx
  on public.tracked_job_session (workspace_id);

alter table public.tracked_job_session enable row level security;

revoke all on table public.tracked_job_session from anon, authenticated;
grant all on table public.tracked_job_session to service_role;

-- Never in realtime: drop it from the publication if anything ever added it.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tracked_job_session'
  ) then
    alter publication supabase_realtime drop table public.tracked_job_session;
  end if;
end $$;
