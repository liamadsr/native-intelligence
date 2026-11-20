-- DB-level test for migration 672 (actions.completed_at kept by a trigger;
-- the views' completed windows). The trigger on every way an action moves:
-- inserted open or finished (with and without a time given), finished from
-- open (with the iOS app's stamp, without one, over a stale stamp), Done to
-- Canceled (the finish time kept), a finished action's other edits (kept),
-- reopened (cleared, whatever the writer sent), an open action handed a stamp
-- (refused). Projects the same way, by status (active, completed, canceled,
-- paused). And view.completed_filter taking the windows and nothing else.
--
-- The TS test (src/lib/views/__tests__/migration-672.test.ts) pins the file's
-- text; this runs the SQL. The backfill is not re-run here: it ran once, when
-- the migration was applied (its NOTICE gives the counts).
--
-- Run against a database with 672 applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/672_action_completed_at.sql
-- Everything runs in one transaction that is rolled back. Made-up ids only.

begin;

do $probe$
declare
  ws uuid;
  tm uuid;
  uid uuid;
  s_open uuid := gen_random_uuid();
  s_done uuid := gen_random_uuid();
  s_cancel uuid := gen_random_uuid();
  a uuid;
  t timestamptz;
  ios constant timestamptz := '2026-11-01 09:00:00+00';
  ok boolean;
begin
  -- Any team with a member: its workspace and that member's user own the
  -- rows below (all rolled back). Three states of the categories that matter.
  select t.id, t.workspace_id, m.user_id into tm, ws, uid
    from public.team t
    join public.member m on m.workspace_id = t.workspace_id and m.user_id is not null
   limit 1;
  if tm is null then
    raise exception '672 test: needs one team with a member in the database';
  end if;
  insert into public.workflow_state (id, team_id, name, category) values
    (s_open, tm, 't672 Todo', 'unstarted'), (s_done, tm, 't672 Done', 'completed'), (s_cancel, tm, 't672 Canceled', 'canceled');

  -- The trigger alone is under test: the others on actions (identifier,
  -- team guard, activity log) need rows this probe does not make.
  alter table public.actions disable trigger user;
  alter table public.actions enable trigger action_completed_at;

  -- Inserted open: no finish time, even if one is sent.
  insert into public.actions (workspace_id, team_id, user_id, identifier, title, status_id, completed_at)
    values (ws, tm, uid, 'T672-' || gen_random_uuid(), 't672 open', s_open, ios) returning id into a;
  assert (select completed_at from public.actions where id = a) is null, 'insert open: null';

  -- Finished from open: now().
  update public.actions set status_id = s_done where id = a;
  t := (select completed_at from public.actions where id = a);
  assert t is not null and t >= now() - interval '1 minute', 'open -> done: now()';

  -- Another edit of a finished action: kept.
  update public.actions set title = 't672 renamed', status_id = s_done where id = a;
  assert (select completed_at from public.actions where id = a) = t, 'done, other edit: kept';

  -- Done to Canceled: still the time it was finished.
  update public.actions set status_id = s_cancel where id = a;
  assert (select completed_at from public.actions where id = a) = t, 'done -> canceled: kept';

  -- Reopened: cleared, even when the writer sends a stamp.
  update public.actions set status_id = s_open, completed_at = ios where id = a;
  assert (select completed_at from public.actions where id = a) is null, 'reopen: null';

  -- An open action handed a stamp on its own: refused.
  update public.actions set completed_at = ios where id = a;
  assert (select completed_at from public.actions where id = a) is null, 'open, stamp only: null';

  -- Finished with the iOS app's stamp: that time.
  update public.actions set status_id = s_done, completed_at = ios where id = a;
  assert (select completed_at from public.actions where id = a) = ios, 'open -> done with a stamp: the stamp';

  -- Inserted finished: now(), or the time given (an import).
  insert into public.actions (workspace_id, team_id, user_id, identifier, title, status_id) values (ws, tm, uid, 'T672-' || gen_random_uuid(), 't672 born done', s_done) returning id into a;
  assert (select completed_at from public.actions where id = a) >= now() - interval '1 minute', 'insert done: now()';
  insert into public.actions (workspace_id, team_id, user_id, identifier, title, status_id, completed_at) values (ws, tm, uid, 'T672-' || gen_random_uuid(), 't672 imported', s_done, ios) returning id into a;
  assert (select completed_at from public.actions where id = a) = ios, 'insert done with a time: kept';

  -- Finished over a stale stamp (written while the trigger was off): now(), not the stale one.
  alter table public.actions disable trigger action_completed_at;
  insert into public.actions (workspace_id, team_id, user_id, identifier, title, status_id, completed_at) values (ws, tm, uid, 'T672-' || gen_random_uuid(), 't672 stale', s_open, '2020-01-01') returning id into a;
  alter table public.actions enable trigger action_completed_at;
  update public.actions set status_id = s_done where id = a;
  assert (select completed_at from public.actions where id = a) >= now() - interval '1 minute', 'open (stale stamp) -> done: now()';

  -- Projects: the same, by status.
  alter table public.projects disable trigger user;
  alter table public.projects enable trigger project_completed_at;
  insert into public.projects (workspace_id, user_id, name, status, completed_at) values (ws, uid, 't672 project', 'active', ios) returning id into a;
  assert (select completed_at from public.projects where id = a) is null, 'project insert active: null';
  update public.projects set status = 'completed' where id = a;
  t := (select completed_at from public.projects where id = a);
  assert t >= now() - interval '1 minute', 'project active -> completed: now()';
  update public.projects set status = 'canceled' where id = a;
  assert (select completed_at from public.projects where id = a) = t, 'project completed -> canceled: kept';
  update public.projects set name = 't672 renamed', status = 'canceled' where id = a;
  assert (select completed_at from public.projects where id = a) = t, 'project, other edit: kept';
  update public.projects set status = 'paused', completed_at = ios where id = a;
  assert (select completed_at from public.projects where id = a) is null, 'project reopened (paused): null';
  update public.projects set status = 'completed', completed_at = ios where id = a;
  assert (select completed_at from public.projects where id = a) = ios, 'project completed with a time: the time';
  insert into public.projects (workspace_id, user_id, name, status) values (ws, uid, 't672 born done', 'completed') returning id into a;
  assert (select completed_at from public.projects where id = a) >= now() - interval '1 minute', 'project insert completed: now()';

  -- The views take the windows, and nothing else.
  ok := true;
  begin
    update public.view set completed_filter = 'not_a_window' where id = (select id from public.view limit 1);
    -- No view in the database: the constraint check below still runs.
    if not found then raise check_violation; end if;
    ok := false;
  exception when check_violation or not_null_violation then
    null;
  end;
  assert ok, 'view: an unknown completed_filter is refused';
  assert exists (
    select 1 from pg_constraint
     where conname = 'view_completed_filter_check'
       and pg_get_constraintdef(oid) like '%past_day%'
       and pg_get_constraintdef(oid) like '%past_week%'
       and pg_get_constraintdef(oid) like '%past_month%'
       and pg_get_constraintdef(oid) like '%past_year%'
       and pg_get_constraintdef(oid) like '%recent%'
  ), 'view: the check names the windows and recent';

  raise notice '672: all checks passed';
end;
$probe$;

rollback;
