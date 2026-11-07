-- Migration 311: deleting a team never takes the workspace's system teammates
-- with it (docs/plans/bots-v4.md, "Work with no teammate": work with no bot you
-- can see is the Assistant's, so the Assistant must always be there).
--
-- WHY: ai_team_member.team_id is ON DELETE CASCADE (migration 144), and the
-- system teammates (triage, extraction, email_drafts, reconciler, assistant)
-- all sit on the workspace's oldest team (seed_system_teammates, migration
-- 310). 283's ai_team_member_protect_system only refuses deleting a system
-- row directly; a cascade from its team goes through. So deleting that team
-- silently deleted the Assistant and the other four. Writers re-seed on their
-- next miss (system-teammates.ts systemTeammateId), but readers don't, so the
-- work the Assistant stands for showed nowhere until some writer ran.
--
-- What lands: team_keep_system_teammates, a BEFORE DELETE trigger on `team`,
-- so every path is covered (the route, the service role, SQL), not just
-- DELETE /api/account/teams/[id]:
--   - the workspace is being deleted (its row is already gone when the
--     cascade reaches its teams): nothing to keep, the delete goes through,
--     and 283's guard lets the teammates' own cascade through as before;
--   - the team holds no system teammate: nothing to do;
--   - else its system teammates move to the workspace's oldest other team
--     (the seed's "default team" rule), before the row goes, so the cascade
--     finds none of them;
--   - no other team: the delete is refused (restrict_violation). The route
--     already refuses deleting a workspace's only team (409); this holds the
--     same line for every other path. Deleting every team in one statement is
--     refused the same way: each row's trigger sees the rows deleted before it.
--
-- SECURITY DEFINER: the move must see and update teammates and teams that RLS
-- hides from the deleting user (a private team they aren't on), and the
-- deleter is already allowed to delete the team (RLS "Admins can delete
-- teams"). The move changes team_id only: 305/310's guard (same workspace,
-- team in it) and 283's guard (is_system, system_key, agent fixed) both pass.
-- Non-system teammates on the team still go with it, as before.

-- Locks: wait at most 5 s for one (as 310 does). If a long transaction holds
-- `team`, this fails fast instead of queueing every reader of `team` behind
-- the trigger's DDL; re-run it then.
set local lock_timeout = '5s';

-- Back-fill first (it needs no trigger), so the DDL's ACCESS EXCLUSIVE lock on
-- `team` is taken last and held only until commit: any workspace that already
-- lost its system teammates to a team delete gets them back (idempotent on
-- (workspace_id, system_key)).
select public.seed_system_teammates(w.id)
from public.workspace w;

create or replace function public.team_keep_system_teammates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  -- The workspace is going (its cascade reached this team): let it.
  if not exists (select 1 from public.workspace w where w.id = old.workspace_id) then
    return old;
  end if;

  if not exists (
    select 1 from public.ai_team_member a
    where a.team_id = old.id and a.is_system
  ) then
    return old;
  end if;

  select t.id into v_target
  from public.team t
  where t.workspace_id = old.workspace_id
    and t.id <> old.id
  order by t.created_at asc, t.id asc
  limit 1;

  if v_target is null then
    raise exception 'a workspace keeps one team for its system teammates: create another team before deleting this one (team %)', old.id
      using errcode = 'restrict_violation',
            hint = 'Delete the workspace instead, or create another team first.';
  end if;

  update public.ai_team_member
  set team_id = v_target
  where team_id = old.id and is_system;

  return old;
end;
$$;

revoke execute on function public.team_keep_system_teammates() from public, anon, authenticated;

drop trigger if exists team_keep_system_teammates on public.team;
create trigger team_keep_system_teammates
  before delete on public.team
  for each row execute function public.team_keep_system_teammates();

-- ═══════════════════════════════════════════════════════════════════════════
-- Check, after applying:
--   select tgname from pg_trigger where tgrelid = 'public.team'::regclass
--     and tgname = 'team_keep_system_teammates';               -- one row
--   -- Workspaces with a team but missing a system teammate (expect none once
--   -- the seed above has run):
--   select w.id from public.workspace w
--   where exists (select 1 from public.team t where t.workspace_id = w.id)
--     and (select count(*) from public.ai_team_member a
--          where a.workspace_id = w.id and a.is_system) < 5;
-- ═══════════════════════════════════════════════════════════════════════════
