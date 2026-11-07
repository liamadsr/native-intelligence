-- Migration 305: what a bot may do on its own, and which skills it always
-- checks, held by the database too (docs/plans/bots-v4.md, Phase B1;
-- decisions 11 and 12).
--
-- WHY: the one agent editor's routes check who may change a bot's limits and
-- its skills, but nothing below them did. ai_team_member's RLS (migration 144)
-- lets owners, admins AND team leads update any column through PostgREST;
-- ai_team_member_skill's write policy follows the parent; and the
-- allowed_side_effects CHECK (migration 280) admits external-write,
-- automation-write and delete. So a team lead could set a bot's limits to an
-- outside write (narrowToTeammate then admits those tools in its chat and its
-- unattended runs), change its autonomy, role, tool allowlist or delegation,
-- turn it into a work bot or back, point an agent's work bot at another agent,
-- or write the skills of a bot on an agent they can't edit.
--
--   1. allowed_side_effects ⊆ {read, internal-write}: decision 12's two
--      choices, "Read only" and "Read, and change Dial8 records". Outside
--      writes are never a bot's own. Any row with more is narrowed first (none
--      on DEV; every seed writes {read} or {read, internal-write}).
--   2. A trigger on ai_team_member, in this order:
--      a. For everyone, the server included: a teammate's team is one of its
--         own workspace's teams. Nothing tied the two before, so a row could
--         say one workspace and sit on another's team.
--      b. The server (the service role: the app's routes, after their own
--         checks) and the database itself (no request at all: migrations,
--         the sign-up trigger, crons) pass. A request without a sign-in
--         (`anon`) is not trusted.
--      c. Anyone signed in may not move a teammate to another workspace, and
--         may add a system teammate only as seeding would make it: one of the
--         built-in four, on its loop's recipe. Without (c) a lead of a team in
--         workspace A who owns any workspace B (anyone signed in can make one)
--         could move a bot to B, where they are owner, change its limits, and
--         move it back.
--      d. A workspace owner or admin then passes.
--      e. Anyone else (a team lead) adds a teammate with the defaults only, and
--         changes none of the limits columns: allowed_side_effects, autonomy,
--         role, tool_allowlist, can_delegate_to, fronts_only, and a work bot's
--         agent_recipe_id. They still rename, re-face and move a teammate
--         within the workspace, and re-point a full one.
--   3. A bot's skills are written by the server only. The client write policy
--      on ai_team_member_skill goes; reads keep both policies' visibility.
--      replace_ai_member_skills(bot, skills) replaces one bot's list, in
--      order, at most five, each a skill of the bot's own workspace or a
--      system one, atomically and under a lock on the bot's row, so two saves
--      at once can't leave six. Service role only: the routes check the rule
--      first (the agent's, for a bot on an agent; the teammate rule for a
--      system teammate, which is its own agent).
--
-- Both functions run with an empty search_path and name every object by its
-- schema (public.get_member_role reads only schema-qualified names itself).
--
-- Rollback lever for the skills writes alone: re-creating migration 144's
-- "Manage AI team member skills via parent" policy (FOR ALL, owners, admins
-- and the team's leads) restores a client's direct writes.
--
-- Idempotent: constraints, policies, the trigger and the functions are
-- dropped by name and recreated.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. allowed_side_effects ⊆ {read, internal-write}
-- ═══════════════════════════════════════════════════════════════════════════

update public.ai_team_member
set allowed_side_effects = coalesce(
  (
    select array_agg(c order by array_position(array['read', 'internal-write']::text[], c))
    from unnest(allowed_side_effects) as c
    where c in ('read', 'internal-write')
  ),
  '{read}'::text[]
)
where not (allowed_side_effects <@ array['read', 'internal-write']::text[]);

alter table public.ai_team_member drop constraint if exists ai_team_member_allowed_side_effects_check;
alter table public.ai_team_member add constraint ai_team_member_allowed_side_effects_check
  check (allowed_side_effects <@ array['read', 'internal-write']::text[]);

comment on column public.ai_team_member.allowed_side_effects is
  'What this teammate may change on its own: {read} ("Read only", the default) or {read, internal-write} ("Read, and change Dial8 records"; what Attempt mode needs). Outside writes are never a teammate''s own (migration 305). Set by a workspace owner or admin only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The limits columns: owners, admins and the server only
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.ai_team_member_guard_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- (a) Everyone, the server included: a teammate's team is one of its
  -- workspace's teams.
  if not exists (
    select 1 from public.team t
    where t.id = new.team_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'a teammate''s team must be one of its workspace''s teams (ai_team_member %)', new.id
      using errcode = 'check_violation';
  end if;

  -- (b) The server (service role) and the database itself (no request) check
  -- who may first. A request with no sign-in ('anon') is not trusted.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    return new;
  end if;

  -- (c) Anyone signed in: a teammate stays in its workspace...
  if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
    raise exception 'a teammate stays in its workspace (ai_team_member %)', old.id
      using errcode = 'insufficient_privilege';
  end if;
  -- ...and a system teammate is only ever one seeding would make: one of the
  -- built-in four, on its loop's recipe (seed_system_teammates, migration
  -- 294). A workspace made by a signed-in user seeds them as that user.
  if tg_op = 'INSERT' and new.is_system and not (
    new.system_key in ('triage', 'extraction', 'email_drafts', 'reconciler')
    and exists (
      select 1 from public.recipe r
      where r.id = new.agent_recipe_id
        and r.slug = 'loop-' || replace(new.system_key, '_', '-')
        and r.workspace_id is null
        and r.category = 'agent'
    )
  ) then
    raise exception 'a system teammate is one of the built-in four, on its loop''s recipe (ai_team_member %)', new.id
      using errcode = 'insufficient_privilege';
  end if;

  -- (d) A workspace owner or admin.
  if public.get_member_role(new.workspace_id) in ('owner', 'admin') then
    return new;
  end if;

  -- (e) Anyone else adds a teammate with the defaults: it can only look.
  if tg_op = 'INSERT' then
    if new.allowed_side_effects is distinct from '{read}'::text[]
       or new.autonomy is distinct from 'propose'
       or new.role is not null
       or new.tool_allowlist is not null
       or new.can_delegate_to is distinct from '{}'::text[]
       or new.fronts_only then
      raise exception 'only a workspace owner or admin sets what a teammate may do on its own (ai_team_member)'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.allowed_side_effects is distinct from old.allowed_side_effects
     or new.autonomy is distinct from old.autonomy
     or new.role is distinct from old.role
     or new.tool_allowlist is distinct from old.tool_allowlist
     or new.can_delegate_to is distinct from old.can_delegate_to
     or new.fronts_only is distinct from old.fronts_only
     -- A work bot's persona: the agent it speaks for, or the loop anchor.
     or (old.fronts_only and new.agent_recipe_id is distinct from old.agent_recipe_id) then
    raise exception 'only a workspace owner or admin changes what a teammate may do on its own, or what a work bot speaks for (ai_team_member %)', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke execute on function public.ai_team_member_guard_limits() from public, anon, authenticated;

drop trigger if exists ai_team_member_guard_limits on public.ai_team_member;
create trigger ai_team_member_guard_limits
  before insert or update on public.ai_team_member
  for each row execute function public.ai_team_member_guard_limits();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. A bot's skills: written by the server only, one list at a time
-- ═══════════════════════════════════════════════════════════════════════════

-- The write policy goes. Its read half stays as a SELECT policy of its own, so
-- who can read a bot's skills doesn't change (owners, admins and the team's
-- leads, beside "View AI team member skills via parent").
drop policy if exists "Manage AI team member skills via parent" on public.ai_team_member_skill;
drop policy if exists "Managers can view AI team member skills" on public.ai_team_member_skill;
create policy "Managers can view AI team member skills"
  on public.ai_team_member_skill for select
  using (
    exists (
      select 1 from public.ai_team_member atm
      where atm.id = ai_team_member_id
        and (
          public.get_member_role(atm.workspace_id) in ('owner', 'admin')
          or exists (
            select 1 from public.team_member tm
            join public.member m on m.id = tm.member_id
            where tm.team_id = atm.team_id
              and tm.team_role = 'lead'
              and m.user_id = auth.uid()
          )
        )
    )
  );

create or replace function public.replace_ai_member_skills(p_member_id uuid, p_skill_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_workspace uuid;
begin
  -- In order, each once (its first place wins).
  select coalesce(array_agg(s.id order by s.first), '{}'::uuid[])
  into v_ids
  from (
    select x.id, min(x.ord) as first
    from unnest(coalesce(p_skill_ids, '{}'::uuid[])) with ordinality as x(id, ord)
    group by x.id
  ) s;

  if cardinality(v_ids) > 5 then
    raise exception 'a bot always checks at most five skills (got %)', cardinality(v_ids)
      using errcode = 'check_violation';
  end if;

  -- One save at a time per bot.
  select atm.workspace_id into v_workspace
  from public.ai_team_member atm
  where atm.id = p_member_id
  for update;
  if not found then
    raise exception 'ai_team_member % not found', p_member_id
      using errcode = 'no_data_found';
  end if;

  -- Each a skill of the bot's own workspace, or a system one.
  if exists (
    select 1 from unnest(v_ids) as x(id)
    where not exists (
      select 1 from public.recipe r
      where r.id = x.id
        and r.category = 'skill'
        and (r.is_system is true or r.workspace_id = v_workspace)
    )
  ) then
    raise exception 'every id must be a skill of the bot''s workspace, or a system skill'
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.ai_team_member_skill where ai_team_member_id = p_member_id;
  insert into public.ai_team_member_skill (ai_team_member_id, skill_recipe_id, sort_order)
  select p_member_id, x.id, x.ord - 1
  from unnest(v_ids) with ordinality as x(id, ord);
end;
$$;

revoke execute on function public.replace_ai_member_skills(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.replace_ai_member_skills(uuid, uuid[]) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Check (run after applying):
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'ai_team_member_allowed_side_effects_check';
--     → CHECK ((allowed_side_effects <@ ARRAY['read'::text, 'internal-write'::text]))
--   select tgenabled from pg_trigger where tgname = 'ai_team_member_guard_limits';  → 'O'
--   select policyname, cmd from pg_policies where tablename = 'ai_team_member_skill';
--     → the two SELECT policies, no other
--   select count(*) from public.ai_team_member
--   where not (allowed_side_effects <@ array['read', 'internal-write']::text[]);  → 0
-- ═══════════════════════════════════════════════════════════════════════════
