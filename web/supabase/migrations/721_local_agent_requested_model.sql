-- ============================================================
-- 721: The model and effort a coding chat was started with
-- ============================================================
-- NUMBER: 721 is the first free number after main's newest (720) when this
-- was written. Re-list main's migrations before merging, and renumber (the
-- file, this line and its test, src/lib/local-agent/__tests__/migration-721.test.ts)
-- if main took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1 --single-transaction`. It holds its own
-- begin/commit, so it runs the same with or without --single-transaction
-- (with it, psql warns that a transaction is already in progress, harmlessly).
-- It ends by telling the data API to reload its schema (the start route
-- writes these columns through it), so that row's second step is not needed.
--
-- ⛔ PROD ORDER: apply this BEFORE rolling out the app code that writes
-- these columns. That code writes them only for a start that names a model or
-- an effort, which a person can choose only when their Mac's app says its
-- coding agent takes one (the offer's `takesModel`, desktop builds after
-- 0.2.111): until such a build reaches a Mac, nothing writes them, so the
-- order matters only from then. Applying it early is harmless: both columns
-- start empty, and empty means what happens today (the coding agent's own
-- default model and effort).
--
-- When the person starts a coding chat with their own coding agent (Codex,
-- Claude Code) on their Mac, they may pick the model and the effort it runs
-- on (the composer's pickers, docs/plans/one-home.md "Model and effort").
-- The choices offered are the ones that Mac's app reports for that agent
-- (environment.offered_workers, 658: each offer's `models`), and the start
-- route refuses any other.
--
--   local_agent_session.requested_model   the model the person chose when
--                                         the job started, as the Mac named
--                                         it. Null: the agent's own default.
--   local_agent_session.requested_effort  the reasoning effort chosen with
--                                         it. Null: the agent's own default.
--
-- Stamped once when the job starts and never changed: the claim hands them
-- to the Mac on every launch of the job, and the agent runs on them. What it
-- actually runs on is still what the agent reports (the `model` event), which
-- the chat shows.
--
-- Both are short ids in a conservative shape: letters, digits and `.`, `-`,
-- `_`, `:`, `/`, 1 to 100 characters (the code's MODEL_CHOICE_RE,
-- src/lib/environments/types.ts). Which ids exist is the Mac's, so the CHECK
-- holds the shape only, never a list.
--
-- Access, kept as the table has it: RLS on, the owner's SELECT policy only
-- (410), no write policy and no column grants, so only the service role
-- writes (the start route, POST /api/local-agent/sessions, after checking
-- the Mac's offer). Nothing to grant or revoke.
--
-- Each CHECK is added NOT VALID, then validated: a row per job, so the lock
-- is a moment, and the lock timeout caps the wait for it.
--
-- Re-runnable, and a re-run is a no-op: add column if not exists; each CHECK
-- is added only when pg_constraint doesn't hold it yet, and VALIDATE does
-- nothing for a constraint already valid; comments repeat harmlessly.
--
-- ⚠️ The one case code cannot fix: rolled back to app code from before this
-- change, the server no longer hands the choice to the Mac, so a queued job
-- started with one runs on the agent's own default. The columns stay;
-- rolling forward again honours them for jobs not yet started.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

alter table public.local_agent_session add column if not exists requested_model text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'local_agent_session_requested_model_check' and conrelid = 'public.local_agent_session'::regclass
  ) then
    alter table public.local_agent_session
      add constraint local_agent_session_requested_model_check check (
        requested_model is null or requested_model ~ '^[A-Za-z0-9._:/-]{1,100}$'
      ) not valid;
  end if;
end
$$;
alter table public.local_agent_session validate constraint local_agent_session_requested_model_check;

alter table public.local_agent_session add column if not exists requested_effort text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'local_agent_session_requested_effort_check' and conrelid = 'public.local_agent_session'::regclass
  ) then
    alter table public.local_agent_session
      add constraint local_agent_session_requested_effort_check check (
        requested_effort is null or requested_effort ~ '^[A-Za-z0-9._:/-]{1,100}$'
      ) not valid;
  end if;
end
$$;
alter table public.local_agent_session validate constraint local_agent_session_requested_effort_check;

comment on column public.local_agent_session.requested_model is
  'The model the person chose for this coding job when it started (721), as their Mac''s app named it; null: the coding agent''s own default. Stamped once by the start route after checking the Mac''s offer; the claim hands it to the Mac. Written by the service role only.';

comment on column public.local_agent_session.requested_effort is
  'The reasoning effort the person chose for this coding job when it started (721), as their Mac''s app named it; null: the coding agent''s own default. Stamped once by the start route after checking the Mac''s offer; the claim hands it to the Mac. Written by the service role only.';

-- The data API (PostgREST) learns the new columns, delivered at commit.
notify pgrst, 'reload schema';

commit;
