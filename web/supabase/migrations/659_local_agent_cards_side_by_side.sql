-- ============================================================
-- 659: Cards side by side in one folder on a Mac
-- ============================================================
-- NUMBER: 659, right after 658 (the same change's; 658's columns first, though
-- this one needs nothing of 658's). It was written, and applied on the dev
-- database, as 647; the dev database holds it under the name
-- local_agent_cards_side_by_side.
--
-- ⛔ PROD ORDER: apply this BEFORE rolling out the code that ships with it,
-- after 658, and shortly before the roll-out, not hours earlier. That code
-- does run without it ("Before it is applied", below), but with one loss: a
-- chat start no longer ends a card's idle job in its folder, nor a card's
-- Start a chat's idle job, so 419's index refuses the start as FOLDER_BUSY
-- until the idle job is stopped or reaped. Older code
-- (before this branch) relies on 419's index to close its one-per-folder
-- race: never roll the app back past this branch while 659 is applied
-- without first putting 419's index back (the down note at the end).
--
-- What changes. Until now a folder ran ONE live job at a time (419's
-- local_agent_session_one_live_per_folder), so a second card (action) in the
-- same repository was refused, or ended the first card's idle job. On the
-- Mac every EDIT job already works in its own git worktree, so cards' edit
-- jobs can run side by side. The rule now:
--   * one live job per action (a card never has two);
--   * one live job per folder for everything that is NOT a card's edit job:
--     a chat's job, a loop's, and a card's READ job (a work card started in a
--     read-only folder works in the folder itself, not in a worktree), so
--     those keep today's one-at-a-time, with today's join, in their own lane;
--   * a card's edit job is in neither the folder's lane nor anyone's way.
-- The server enforces it too (src/lib/local-agent/store.ts claimFolder: a
-- card meets only its own jobs, a chat start never joins or ends a card's,
-- an idle card job is never ended for another start, and a Mac takes at
-- most 6 cards that run or wait for a slot); these indexes close the races.
--
--   local_agent_session.action_id  the action whose Start made the job
--     (a card's), or null. Set when it starts; the session's key has said
--     it until now (local-agent-action:<action>:start:<id>), and the backfill
--     reads it from there. ON DELETE SET NULL, as the table's other
--     references to rows it outlives (environment_id): a deleted card's job
--     keeps its transcript (and stays out of the folder's lane: its key).
--   local_agent_session.mac_queued_at  when the Mac first reported the job
--     waiting in ITS line for a free slot (it runs 3 at once and now holds
--     further starts in line instead of refusing them), or null. Written by
--     the heartbeat: set while the Mac lists the job `queued`, cleared when
--     it begins. The session stays `starting` meanwhile, its lease renewed
--     (the Mac reports it live), so it is never claimed or started twice; the
--     card and the run panel read "queued". After 6 hours in the Mac's line
--     the server asks it to stop, with a sentence.
--   local_agent_session_action_idx         the foreign key's delete and the
--                                          per-action reads.
--   local_agent_session_one_live_per_action  unique (action_id) over live jobs.
--   local_agent_session_one_live_per_folder_lane  unique (folder_id) over live
--     jobs that are not a card's edit job. A card's job is told by its KEY
--     here, not by action_id: a card deleted while its job lives sets
--     action_id null, and that must not move the job into the folder's lane
--     (where it would collide with a chat's job and refuse the delete).
--   local_agent_session_one_live_per_folder  (419's) dropped once both stand.
-- "Live" is 419's list: queued, starting, running, waiting, interrupted.
--
-- Locks, truthfully: production applies a migration in ONE transaction, so
-- every lock below is held until commit:
--   * ADD COLUMN (twice) takes ACCESS EXCLUSIVE on local_agent_session: its
--     reads wait too, not only its writes (no rewrite: nullable, no default);
--   * ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE on local_agent_session AND on
--     the busy actions table: writes to actions (every card edit, every
--     status move) wait until commit. Its check reads local_agent_session,
--     whose action_id is still all null then: no lookups;
--   * the explicit SHARE ROW EXCLUSIVE for the backfill and the index builds
--     (as 419 does) adds nothing to what is already held; the builds scan the
--     table (a row per job). Not CONCURRENTLY: that can't run in a transaction.
-- Mitigation: the table is small (well under a second here), the 5-second
-- lock timeout gives up rather than queue every request behind it, and it
-- should be applied at a quiet moment (no card being edited, no job starting).
--
-- If live rows already break the new rule (they can't under 419's index,
-- unless it was never built), the new unique indexes are not built and a
-- WARNING says so, and 419's index is kept: the server still enforces the
-- rule. Once those jobs end, run the DO block again BY HAND. Check after:
--   select indexname from pg_indexes where tablename = 'local_agent_session' and indexname like 'local_agent_session_one_live%';
--
-- Before it is applied, the code (which ships with it) works as follows: the
-- insert names action_id, PostgREST answers that it doesn't know the column
-- (PGRST204), and the code inserts again without it; 419's index refuses a
-- second card's job in a folder, which the code turns into today's
-- FOLDER_BUSY naming the first card. One more thing changes: an idle job in
-- the other lane (a card's edit job for a chat start, any other job for a
-- card's Start) is no longer ended to make room, so that start is refused
-- as FOLDER_BUSY too (PROD ORDER, above).
--
-- Checked by hand on 2026-11-14 (PGlite, a real Postgres engine, from a
-- scratch install outside the repo: it is in no lockfile here, so the
-- suite's test only reads this file): applied twice over a stub of the table
-- with 419's index in place; the backfill (a live card job gets its action, a
-- deleted action's stays null, a chat job none); 419's index gone and the
-- three new ones present; a second card's edit job in one folder allowed,
-- the same card twice refused, a chat job beside cards allowed, a second
-- chat job refused, a card's read job in the folder's lane refused, an ended
-- job never counting; deleting a card while its job and a chat job live
-- allowed (the job keeps its row, action_id null); the foreign key once;
-- mac_queued_at a nullable timestamp; and with two live chat jobs in one
-- folder (419's index never built), the warning branch: no new unique index
-- built, and the migration still commits.
--
-- Re-runnable: add column if not exists; the foreign key added only when
-- pg_constraint lacks it; create index if not exists; the backfill touches
-- only rows still without an action_id; drop index if exists.
--
-- Down (by hand, before rolling code back past this branch):
--   create unique index local_agent_session_one_live_per_folder on public.local_agent_session (folder_id)
--     where status in ('queued','starting','running','waiting','interrupted');   -- fails while cards share a folder
--   drop index local_agent_session_one_live_per_action; drop index local_agent_session_one_live_per_folder_lane;
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The card a job belongs to
-- ------------------------------------------------------------
alter table public.local_agent_session add column if not exists action_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'local_agent_session_action_id_fkey' and conrelid = 'public.local_agent_session'::regclass
  ) then
    alter table public.local_agent_session
      add constraint local_agent_session_action_id_fkey
      foreign key (action_id) references public.actions (id) on delete set null;
  end if;
end
$$;

alter table public.local_agent_session add column if not exists mac_queued_at timestamptz;

comment on column public.local_agent_session.mac_queued_at is
  'Cards side by side (659): when the Mac first reported this claimed job waiting in its own line for a free slot; null otherwise. Written by the heartbeat. The session stays starting meanwhile.';

comment on column public.local_agent_session.action_id is
  'Cards side by side (659): the action whose Start made this job, or null (a chat''s, a loop''s). Set when it starts. A card''s EDIT job works in its own worktree and may run beside other cards'' in one folder; one live job per action.';

-- ------------------------------------------------------------
-- 2. Backfill, the indexes, and 419's index dropped (under one lock)
-- ------------------------------------------------------------
do $$
declare
  dup_actions integer;
  dup_lanes integer;
begin
  lock table public.local_agent_session in share row exclusive mode;

  -- The action from the key, for jobs whose action still exists.
  update public.local_agent_session s
    set action_id = substring(s.idempotency_key from '^local-agent-action:([0-9a-fA-F-]{36}):start:')::uuid
    where s.action_id is null
      and s.idempotency_key ~ '^local-agent-action:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:start:'
      and exists (
        select 1 from public.actions a
        where a.id = substring(s.idempotency_key from '^local-agent-action:([0-9a-fA-F-]{36}):start:')::uuid
      );

  create index if not exists local_agent_session_action_idx
    on public.local_agent_session (action_id)
    where action_id is not null;

  select count(*) into dup_actions from (
    select action_id from public.local_agent_session
    where action_id is not null and status in ('queued', 'starting', 'running', 'waiting', 'interrupted')
    group by action_id having count(*) > 1
  ) d;
  select count(*) into dup_lanes from (
    select folder_id from public.local_agent_session
    where status in ('queued', 'starting', 'running', 'waiting', 'interrupted')
      and (mode <> 'edit' or idempotency_key is null or idempotency_key not like 'local-agent-action:%')
    group by folder_id having count(*) > 1
  ) d;

  if dup_actions > 0 or dup_lanes > 0 then
    raise warning '659: % action(s) and % folder lane(s) hold more than one live local agent, so the new indexes were NOT built and local_agent_session_one_live_per_folder was kept. The server still enforces the rule; once those jobs end, run this DO block again by hand.', dup_actions, dup_lanes;
  else
    create unique index if not exists local_agent_session_one_live_per_action
      on public.local_agent_session (action_id)
      where action_id is not null and status in ('queued', 'starting', 'running', 'waiting', 'interrupted');
    create unique index if not exists local_agent_session_one_live_per_folder_lane
      on public.local_agent_session (folder_id)
      where status in ('queued', 'starting', 'running', 'waiting', 'interrupted')
        and (mode <> 'edit' or idempotency_key is null or idempotency_key not like 'local-agent-action:%');
    drop index if exists public.local_agent_session_one_live_per_folder;
  end if;
end
$$;

-- The data API reads its schema again: the new columns are known at once.
notify pgrst, 'reload schema';
