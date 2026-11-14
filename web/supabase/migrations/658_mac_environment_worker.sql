-- ============================================================
-- 658: Who does the work on a Mac
-- ============================================================
-- NUMBER: 658 is the first free number after main's newest (657) when this
-- was merged. It was written, and applied on the dev database, as 646 before
-- main took that number; the dev database holds it under the name
-- mac_environment_worker. Its test: src/lib/environments/__tests__/migration-658.test.ts.
--
-- ⛔ PROD ORDER: apply this BEFORE rolling out the app code that reads
-- environment.worker and local_agent_session.worker. That code names the
-- column when it lists the person's Macs (src/lib/environments/store.ts
-- listMacs), which the Environments list, the composer's selector AND every
-- chat's environment lookup go through: without the column they all fail.
-- (A chat start reads the choice too, but treats a missing column as "no
-- choice"; the claim reads the session row whole.)
-- Applying it early is harmless: both columns start empty, and empty means
-- what happens today (Native Intelligence's own agent does the work).
--
-- On the person's Mac, the desktop app can run a job with the person's OWN
-- coding agent (their own subscription, on that Mac) instead of Native
-- Intelligence's agent. The person chooses that per Mac, in the toggle under
-- the chat's message box; the chat agent never chooses, the server fills it
-- in. A card's Start (the Actions board) runs on the person's own agent only
-- when the person picked one for that Start ("with" beside it); a Start that
-- names none runs on Native Intelligence's own agent, as before.
--
--   environment.worker          the choice, on the Mac's environment row.
--                               A Mac has exactly one environment
--                               (environment_one_per_mac, 420), so the row is
--                               the Mac's own and the choice follows it into
--                               every chat and workspace that uses that Mac.
--                               Null: Native Intelligence's own agent. Only a
--                               Mac row may carry one (a cloud environment's
--                               work runs in a sandbox, not on a Mac).
--   environment.offered_workers the coding agents that Mac offers, as its
--                               desktop app last reported them (its 60 s
--                               heartbeat): a JSON array of {id, label},
--                               at most 16, validated by the server before
--                               it is written. Null: not known (never
--                               reported, or an app that can't run coding
--                               agents). It lets a page that is NOT on that
--                               Mac (a browser tab, a phone) offer the
--                               choice, and the server refuses a choice the
--                               Mac didn't offer. Only Mac rows.
--   local_agent_session.worker  which agent a job ran with, stamped when it
--                               starts (a chat start: its Mac's choice; a
--                               card's Start: what the person picked for it)
--                               and never changed: a later change of mind
--                               moves no job. Null: our own agent. The claim
--                               hands it to the Mac, which runs that agent or
--                               refuses with its own sentence (never falls
--                               back to ours).
--
-- Both hold a worker id in the Mac's own shape: a lowercase letter, then up
-- to 31 lowercase letters, digits or '-' (the desktop's is_worker_id and
-- src/lib/environments/types.ts WORKER_ID_RE). The server checks only the
-- shape; which ids exist is the Mac's registry, which may change with an app
-- update, so it is not a list here.
--
-- Access, kept as the tables have it:
--   environment          RLS on; clients SELECT only, column by column (420
--                        revoked the table grant and granted each readable
--                        column back), so worker is granted back the same
--                        way. It is not a secret: the owner reads their own
--                        Mac's row (environment_mac_owner_select). No client
--                        write privilege: only the service role writes.
--   local_agent_session  RLS on, the owner's SELECT policy only (410); no
--                        write policy, so only the service role writes. No
--                        column grants there: nothing to add.
-- environment_guard (420) watches kind, owner, Mac, workspace, shared and
-- archived_at only, so changing worker passes it.
--
-- Each CHECK is added NOT VALID, then validated. Production applies a
-- migration in one transaction, so the ACCESS EXCLUSIVE lock the ADD takes
-- is held until commit whatever VALIDATE needs: on these small tables (a row
-- per Mac, a row per job) that is a moment, and the lock timeout caps the
-- wait for it.
--
-- Re-runnable, and a re-run is a no-op: add column if not exists; each CHECK
-- is added only when pg_constraint doesn't hold it yet, and VALIDATE does
-- nothing for a constraint already valid; grant and comment repeat
-- harmlessly. Takes its locks with a timeout.
--
-- ⚠️ The one case code cannot fix: rolled back to app code from before this
-- change, the server no longer reads environment.worker and no longer sends
-- `worker` with a claim, so saved choices are silently ignored and Native
-- Intelligence's own agent does the work (on our models). The columns and
-- the saved choices stay; rolling forward again honours them.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The choice, on the Mac's environment
-- ------------------------------------------------------------
alter table public.environment add column if not exists worker text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'environment_worker_check' and conrelid = 'public.environment'::regclass
  ) then
    alter table public.environment
      add constraint environment_worker_check check (
        worker is null or (kind = 'mac' and worker ~ '^[a-z][a-z0-9-]{0,31}$')
      ) not valid;
  end if;
end
$$;
alter table public.environment validate constraint environment_worker_check;

-- Readable by the clients that may read the row, like every other
-- non-secret column (420's column grants).
grant select (worker) on public.environment to authenticated;

-- The Mac's offered coding agents, as its app last reported them.
alter table public.environment add column if not exists offered_workers jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'environment_offered_workers_check' and conrelid = 'public.environment'::regclass
  ) then
    alter table public.environment
      add constraint environment_offered_workers_check check (
        offered_workers is null or (kind = 'mac' and jsonb_typeof(offered_workers) = 'array')
      ) not valid;
  end if;
end
$$;
alter table public.environment validate constraint environment_offered_workers_check;

grant select (offered_workers) on public.environment to authenticated;

comment on column public.environment.offered_workers is
  'The coding agents this Mac offers (658), as its desktop app last reported them in its heartbeat: a JSON array of {id, label}, at most 16, validated by the server. Null: not known. Mac rows only. Written by the service role only.';

comment on column public.environment.worker is
  'Who does the chat agent''s work on this Mac (658): a coding agent''s id from the Mac app''s registry (the person''s own account there), or null for Native Intelligence''s own agent. Mac rows only. Set by the person in the composer, written by the service role only. A card''s Start doesn''t read it: only what the person picked for that Start.';

-- ------------------------------------------------------------
-- 2. Which agent a job ran with
-- ------------------------------------------------------------
alter table public.local_agent_session add column if not exists worker text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'local_agent_session_worker_check' and conrelid = 'public.local_agent_session'::regclass
  ) then
    alter table public.local_agent_session
      add constraint local_agent_session_worker_check check (
        worker is null or worker ~ '^[a-z][a-z0-9-]{0,31}$'
      ) not valid;
  end if;
end
$$;
alter table public.local_agent_session validate constraint local_agent_session_worker_check;

comment on column public.local_agent_session.worker is
  'Which coding agent the job runs on (658): its Mac''s choice (environment.worker) when the chat agent started it, or what the person picked for a card''s Start, then fixed. Null: Native Intelligence''s own agent. The claim hands it to the Mac, which runs it or refuses, and never falls back.';

-- The data API reads its schema again: the new columns are known at once.
notify pgrst, 'reload schema';
