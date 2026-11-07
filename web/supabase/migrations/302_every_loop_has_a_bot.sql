-- 302: every loop has a bot (docs/plans/bots-v3.md, Phase 3).
--
-- Applied by hand, from this file: to DEV first. PROD only on Liam's word, and
-- BEFORE the PR whose code reads these columns merges (the migration-before-
-- merge gate): the flow routes, the dispatcher's flow reads and the teammate
-- chat's bounds select `flow.ai_team_member_id` / `ai_team_member.fronts_only`
-- and fail on a database without them. Everything here is additive.
--
-- What lands:
--   flow.ai_team_member_id   the teammate whose bot fronts the loop: its runs,
--                  cards and notices come through that bot. FK, ON DELETE SET
--                  NULL (a deleted bot never breaks the loop; the editor then
--                  asks for one), indexed. Nullable in the schema; the app
--                  always fills it (the editor can't clear it, the routes pick
--                  a default, scripts/backfill-loop-bots.ts fills old loops).
--   ai_team_member.fronts_only
--                  a WORK BOT: a teammate that speaks for work (loops, later
--                  custom agents) and takes no assignments. CHECK: role NULL
--                  (never routed) and not is_system. Every assignment,
--                  routing, delegation and auto-attempt read excludes it, as it
--                  excludes system teammates; every bot surface includes it.
--   recipe 'loop-work-bot'
--                  the ONE global identity anchor every work bot is bound to,
--                  the pattern of migration 283: workspace_id NULL, visibility
--                  'personal', created_by NULL, is_system false. Invisible to
--                  every session read (recipe_select_visibility), so it stays
--                  out of the ~15 persona lists, and it fails every
--                  "workspace-or-system agent" check, so no full teammate can be
--                  bound to it from the app. No run executes its prompt: a work
--                  bot speaks from the loops it fronts (teammate chat).
--   flow_check_ai_team_member (BEFORE INSERT OR UPDATE on flow)
--                  any workspace member may update any flow (107's policy), so
--                  no RLS policy can guard one column. When the column is set or
--                  changes (or the seed key does), the teammate must be:
--                    • in the flow's workspace;
--                    • not a system teammate with another job: only Triage and
--                      Reconciler front loops (a loop may point at Triage, never
--                      at Extraction or Email drafts), and a seeded loop's own
--                      system teammate is the only system one it may name;
--                    • reachable by the editor (auth.uid(), when a session makes
--                      the change): a system teammate, a team that isn't
--                      private, or a team they are on (callerCanReachTeammate);
--                    • reachable by the loop's run-as member (created_by's
--                      member, else the workspace owner: run-as-member.ts), the
--                      person its notices go to.
--                  startFlowWork re-checks the last point at run time and falls
--                  back when the run-as member can no longer reach the bot.
--                  A loop moved to another workspace with its bot unchanged
--                  drops the bot (NULL): a bot never fronts across workspaces.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS + re-ADD,
-- CREATE INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING, CREATE OR REPLACE).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. flow.ai_team_member_id
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.flow
  add column if not exists ai_team_member_id uuid null
    references public.ai_team_member(id) on delete set null;

comment on column public.flow.ai_team_member_id is
  'The teammate whose bot fronts this loop (bots v3): its runs, cards and notices come through that bot. Attribution only: the loop keeps its own actions and run-as member. ON DELETE SET NULL; the app always fills it.';

create index if not exists idx_flow_ai_team_member
  on public.flow (ai_team_member_id)
  where ai_team_member_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ai_team_member.fronts_only
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_team_member
  add column if not exists fronts_only boolean not null default false;

comment on column public.ai_team_member.fronts_only is
  'A work bot (bots v3): speaks for the loops (or agent) it fronts and takes no assignments. role NULL and not is_system (CHECK). Excluded from every assignment, routing, delegation and auto-attempt read; included on every bot surface.';

alter table public.ai_team_member drop constraint if exists ai_team_member_fronts_only_check;
alter table public.ai_team_member add constraint ai_team_member_fronts_only_check
  check (not fronts_only or (role is null and not is_system));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The work-bot identity anchor
-- ═══════════════════════════════════════════════════════════════════════════
-- Bare ON CONFLICT DO NOTHING, as 283: the system-slug partial index
-- (workspace_id IS NULL) is the one a re-run hits.

insert into public.recipe (
  name, slug, icon, color, description, system_prompt,
  category, is_system, visibility, sort_order, workspace_id, created_by
)
values
  ('Work bot', 'loop-work-bot', '🤖', '#64748b',
   'A bot made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.',
   'Identity anchor for work bots (bots v3). No run executes this prompt: a work bot speaks from the loops it fronts.',
   'agent', false, 'personal', 904, null, null)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Who a loop may point at
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER so the checks see the teammate, its team and the team's
-- members even where RLS would hide them from the editing user (a private team
-- they are not on: exactly the case to refuse with a clear message, not a
-- silent "not found"). Raises check_violation (23514); the routes answer 400
-- with the message.

create or replace function public.flow_check_ai_team_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mate record;
  v_editor uuid := auth.uid();
  v_run_as uuid;
  v_seed_key text;
begin
  if new.ai_team_member_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- A loop moved to another workspace leaves its bot behind (never a
    -- pointer across workspaces): its editor there asks for one.
    if new.workspace_id is distinct from old.workspace_id
       and new.ai_team_member_id is not distinct from old.ai_team_member_id then
      new.ai_team_member_id := null;
      return new;
    end if;
    -- Nothing the checks read changed: the bot, the workspace, the seed key.
    if new.ai_team_member_id is not distinct from old.ai_team_member_id
       and new.seed_key is not distinct from old.seed_key then
      return new;
    end if;
  end if;

  select atm.workspace_id, atm.team_id, atm.is_system, atm.system_key, t.is_private
    into v_mate
  from public.ai_team_member atm
  left join public.team t on t.id = atm.team_id
  where atm.id = new.ai_team_member_id;
  if not found then
    -- The FK reports a missing row too; this only keeps the message readable.
    raise exception 'that bot no longer exists' using errcode = 'check_violation';
  end if;

  if v_mate.workspace_id is distinct from new.workspace_id then
    raise exception 'a loop''s bot must be one of its own workspace''s teammates'
      using errcode = 'check_violation';
  end if;

  if v_mate.is_system then
    if v_mate.system_key is null or v_mate.system_key not in ('triage', 'reconciler') then
      raise exception 'this built-in teammate does not front loops'
        using errcode = 'check_violation';
    end if;
    v_seed_key := case new.seed_key
      when 'seed:triage' then 'triage'
      when 'seed:reconcile' then 'reconciler'
    end;
    if v_seed_key is not null and v_seed_key <> v_mate.system_key then
      raise exception 'a built-in loop keeps its own teammate'
        using errcode = 'check_violation';
    end if;
    -- A system teammate is readable across private teams (280): everyone reaches it.
    return new;
  end if;

  -- Only an explicit false is public (callerCanReachTeammate's rule).
  if v_mate.is_private is false then
    return new;
  end if;

  if v_editor is not null and not exists (
    select 1
    from public.team_member tm
    join public.member m on m.id = tm.member_id
    where tm.team_id = v_mate.team_id
      and m.user_id = v_editor
      and m.workspace_id = new.workspace_id
  ) then
    raise exception 'that bot is on a private team you are not on'
      using errcode = 'check_violation';
  end if;

  -- The run-as member (run-as-member.ts): the creator while still a member,
  -- else the workspace owner.
  select m.id into v_run_as
  from public.member m
  where m.workspace_id = new.workspace_id
    and m.user_id = new.created_by
  limit 1;
  if v_run_as is null then
    select m.id into v_run_as
    from public.member m
    where m.workspace_id = new.workspace_id
      and m.role = 'owner'
    order by m.created_at asc
    limit 1;
  end if;
  if v_run_as is null or not exists (
    select 1 from public.team_member tm
    where tm.team_id = v_mate.team_id
      and tm.member_id = v_run_as
  ) then
    raise exception 'the person this loop runs as can''t see that bot (it is on a private team they are not on)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.flow_check_ai_team_member() from public, anon, authenticated;

drop trigger if exists flow_check_ai_team_member on public.flow;
create trigger flow_check_ai_team_member
  before insert or update on public.flow
  for each row execute function public.flow_check_ai_team_member();

-- ═══════════════════════════════════════════════════════════════════════════
-- Check (run after applying; expect one row each):
--   select count(*) from information_schema.columns
--    where table_name = 'flow' and column_name = 'ai_team_member_id';
--   select count(*) from information_schema.columns
--    where table_name = 'ai_team_member' and column_name = 'fronts_only';
--   select id from public.recipe where slug = 'loop-work-bot' and workspace_id is null;
--   select tgname from pg_trigger where tgname = 'flow_check_ai_team_member';
-- ═══════════════════════════════════════════════════════════════════════════
