-- ============================================================
-- 671: when an action was finished (actions.completed_at), kept by the
-- database, and the views' "Completed issues" windows.
-- ============================================================
-- Why: an action list shows the finished actions of a time window (past day,
-- week or month: lib/views/completed-window.ts). Until now nothing recorded
-- WHEN an action was finished, so the window was measured on updated_at, and
-- any edit to an old finished action brought it back.
--
-- What lands:
--   1. actions.completed_at is kept by a trigger (the column already exists:
--      an older task model's, still stamped and cleared by the iOS app when
--      it completes or reopens an action, and never by the web app). On
--      every insert, and every update of status_id or completed_at:
--        - into a completed or canceled state from an open one (or inserted
--          finished): the time given, if the writer gave one (the iOS app
--          does, an import may), else now();
--        - between two finished states (Done to Canceled), or a finished
--          action's other edits: the finish time it had (or the one given);
--        - an open state: null, whatever the writer sent.
--      The category is read from the action's workflow_state, the same
--      vocabulary the views use (completed, canceled).
--   2. Backfill, for every action finished now with no completed_at:
--      the activity log's last move into a finished state (488's
--      status_changed rows, {from, to}, written by trigger for every writer
--      since 488; never a 516 backfilled row, which only copied completed_at),
--      else updated_at, the closest the data has. An action open now loses a
--      stale completed_at. The backfill does not bump updated_at (that
--      trigger is off for it) and does not touch the activity log (its
--      update trigger watches other columns). Counts are RAISEd as NOTICEs.
--   3. An index for the window: finished actions by workspace and time.
--   4. view.completed_filter takes the windows (past_day, past_week,
--      past_month) besides all, recent and none, and a window saved before
--      this (as 'recent' with metadata.completed_window) moves into the
--      column.
--
-- Order: apply this BEFORE rolling out the code that reads completed_at (the
-- commit "Actions: measure the completed window on completed_at"). The code
-- before that commit runs on this schema unchanged: it measures on
-- updated_at, and reads a window from the column or from metadata alike.
--
-- Readers of completed_at that change meaning with it (all for the better:
-- they meant "not finished" and saw "never stamped by the iOS app"):
-- lib/bots/manage-bots.ts (a bot's open actions), lib/flows/context-pack.ts
-- (a loop's open actions), lib/flows/verdict-apply.ts (a finished action is
-- touched: no revoke).
--
-- Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. The trigger ───────────────────────────────────────────────────────────

create or replace function public.action_completed_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_done boolean;
  old_done boolean;
begin
  select ws.category in ('completed', 'canceled') into new_done
    from public.workflow_state ws where ws.id = new.status_id;
  new_done := coalesce(new_done, false);

  if not new_done then
    new.completed_at := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.completed_at := coalesce(new.completed_at, now());
    return new;
  end if;

  if old.status_id is not distinct from new.status_id then
    -- Still the same finished state: keep its time, or the one given.
    new.completed_at := coalesce(new.completed_at, old.completed_at, now());
    return new;
  end if;

  select ws.category in ('completed', 'canceled') into old_done
    from public.workflow_state ws where ws.id = old.status_id;
  old_done := coalesce(old_done, false);

  if old_done then
    -- Done to Canceled (or back): it was finished then, and still is.
    new.completed_at := coalesce(new.completed_at, old.completed_at, now());
  elsif new.completed_at is distinct from old.completed_at and new.completed_at is not null then
    -- Finished now, at the time the writer gave (the iOS app stamps it).
    null;
  else
    -- Finished now. A stamp left from before (an open action's stale one) is not this one.
    new.completed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.action_completed_at() from public, anon, authenticated;

drop trigger if exists action_completed_at on public.actions;
create trigger action_completed_at
  before insert or update of status_id, completed_at on public.actions
  for each row execute function public.action_completed_at();

-- ── 2. Backfill ──────────────────────────────────────────────────────────────

-- The backfill writes completed_at only: updated_at stays as it was.
alter table public.actions disable trigger update_actions_updated_at;
alter table public.actions disable trigger action_completed_at;

do $backfill$
declare
  from_log integer;
  from_updated integer;
  cleared integer;
begin
  -- The activity log's last move into a finished state, from an open one.
  with finished as (
    select a.id
      from public.actions a
      join public.workflow_state ws on ws.id = a.status_id
     where ws.category in ('completed', 'canceled')
       and a.completed_at is null
  ), moved as (
    select distinct on (ea.entity_id) ea.entity_id, ea.created_at
      from public.entity_activity ea
      join finished f on f.id = ea.entity_id
      join public.workflow_state ws_to on ws_to.id::text = ea.detail ->> 'to'
      left join public.workflow_state ws_from on ws_from.id::text = ea.detail ->> 'from'
     where ea.entity_type = 'action'
       and ea.action = 'status_changed'
       and not ea.backfilled
       and ws_to.category in ('completed', 'canceled')
       and (ws_from.id is null or ws_from.category not in ('completed', 'canceled'))
     order by ea.entity_id, ea.created_at desc
  )
  update public.actions a
     set completed_at = m.created_at
    from moved m
   where a.id = m.entity_id;
  get diagnostics from_log = row_count;

  -- The rest: the last write, the closest the data has.
  update public.actions a
     set completed_at = coalesce(a.updated_at, a.created_at, now())
    from public.workflow_state ws
   where ws.id = a.status_id
     and ws.category in ('completed', 'canceled')
     and a.completed_at is null;
  get diagnostics from_updated = row_count;

  -- An open action carries no finish time.
  update public.actions a
     set completed_at = null
    from public.workflow_state ws
   where ws.id = a.status_id
     and ws.category not in ('completed', 'canceled')
     and a.completed_at is not null;
  get diagnostics cleared = row_count;

  raise notice '671 completed_at backfill: % from the activity log, % from updated_at, % open actions cleared',
    from_log, from_updated, cleared;
end;
$backfill$;

alter table public.actions enable trigger action_completed_at;
alter table public.actions enable trigger update_actions_updated_at;

-- ── 3. The window's index ────────────────────────────────────────────────────

create index if not exists actions_workspace_completed_at_idx
  on public.actions (workspace_id, completed_at desc)
  where completed_at is not null;

-- ── 4. The views' windows ────────────────────────────────────────────────────

alter table public.view drop constraint if exists view_completed_filter_check;
alter table public.view add constraint view_completed_filter_check
  check (completed_filter in ('all', 'recent', 'none', 'past_day', 'past_week', 'past_month'));

-- A window saved before this rode as 'recent' with the window in metadata.
update public.view
   set completed_filter = metadata ->> 'completed_window',
       metadata = metadata - 'completed_window'
 where completed_filter = 'recent'
   and metadata ->> 'completed_window' in ('past_day', 'past_week', 'past_month');
