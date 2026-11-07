-- Migration 283: agent orchestration, Sequence row 4 — realtime + system
-- teammates (docs/plans/agent-orchestration-product.md Part 5 row 4; §1.2, §1.4).
--
-- What lands:
--   action_github_pr   joins the realtime publication (the action panel's PR
--                      list stops depending on its 5 s poll, §1.2)
--   recipe             four loop identity recipes (category 'agent'), one per
--                      built-in loop: Triage, Extraction, Email drafts, Reconciler
--   ai_team_member     system_key (which loop a system teammate stands for),
--                      a unique (workspace_id, system_key), two CHECKs, and the
--                      system-row guard rewritten (see §3 below for the bug it fixes)
--   seed_system_teammates(workspace_id)
--                      the ONE seeding statement: the backfill below, the new
--                      workspace trigger, and the app's self-heal all call it
--   backfill           every existing workspace gets its four system teammates
--
-- NOT in this migration, deliberately: the tracked_job SELECT widening to
-- workspace members (plan 1.3). Nothing in row 4 writes a ledger row without a
-- human owner (every stamped row keeps its run-as member_id), so nothing needs
-- it yet; it changes what every member sees in Activity, so it rides with the
-- surface that is built for it (row 7).
--
-- Idempotent throughout (guarded publication add, ON CONFLICT DO NOTHING,
-- ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS + re-ADD, CREATE OR REPLACE).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. action_github_pr → realtime (plan 1.2, "Action panel")
-- ═══════════════════════════════════════════════════════════════════════════
-- The panel binds `action_id=eq.<action>`; REPLICA IDENTITY FULL so an UPDATE
-- or DELETE payload carries the filter column (same as tracked_job, 272:111).
-- RLS is already member-scoped ("workspace members can view linked PRs").

alter table public.action_github_pr replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.action_github_pr;
exception
  when duplicate_object then null;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Loop identity recipes (plan 1.4)
-- ═══════════════════════════════════════════════════════════════════════════
-- `ai_team_member.agent_recipe_id` is NOT NULL and must name an agent recipe,
-- so each system teammate needs one. These are identity anchors, not personas:
-- no run executes their prompt (each loop still runs its own skill recipe or
-- code path, unchanged).
--
-- DEVIATION from plan 1.4 ("is_system = true"): they are is_system = false,
-- workspace_id NULL, visibility 'personal', created_by NULL. That row is
-- invisible to every session-client read (recipe_select_visibility admits
-- is_system, public, or a member's own workspace row — none apply) and
-- unwritable by clients, so it stays out of the ~15 persona lists (library,
-- marketplace, chat persona picker, MCP/AI list tools, search, the teammate
-- agent picker) without touching any of them, and it fails every existing
-- "workspace-or-system agent" check, so it can never be bound as a persona
-- (flow run_agent, the ai-members routes). With is_system = true all of those
-- lists would show four un-runnable "agents".
--
-- Bare ON CONFLICT DO NOTHING: recipe carries overlapping partial slug indexes
-- (see 268's header); the system-slug index (workspace_id IS NULL) is the one
-- that fires on a re-run.

insert into public.recipe (
  name, slug, icon, color, description, system_prompt,
  category, is_system, visibility, sort_order, workspace_id, created_by
)
values
  ('Triage', 'loop-triage', '🧭', '#6366f1',
   'The Triage loop: after every processed capture it decides what each proposal becomes and surfaces what needs you.',
   'Identity anchor for the Triage loop''s system teammate. No run executes this prompt: the loop runs the triage skill.',
   'agent', false, 'personal', 900, null, null),
  ('Extraction', 'loop-extraction', '✨', '#0ea5e9',
   'The extraction pass: reads each processed capture and files or stages what was said.',
   'Identity anchor for the Extraction loop''s system teammate. No run executes this prompt: extraction is the capture pipeline.',
   'agent', false, 'personal', 901, null, null),
  ('Email drafts', 'loop-email-drafts', '✉️', '#f59e0b',
   'The email loop: drafts replies to threads that need one, for you to review.',
   'Identity anchor for the Email drafts loop''s system teammate. No run executes this prompt: the email-management cron drafts.',
   'agent', false, 'personal', 902, null, null),
  ('Reconciler', 'loop-reconciler', '🔁', '#10b981',
   'Keeps the proposal queue honest: re-triages captures the loop missed, runs the commitment reconciler, and ages out stale proposals.',
   'Identity anchor for the Reconciler loop''s system teammate. No run executes this prompt: the reconciler cron and loop run their own paths.',
   'agent', false, 'personal', 903, null, null)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ai_team_member — which loop, one per workspace, and a guard that holds
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_team_member
  add column if not exists system_key text null;

comment on column public.ai_team_member.system_key is
  'For a system teammate, the built-in loop it stands for (triage | extraction | email_drafts | reconciler); the ledger writers look it up by this key. NULL for every other teammate.';

alter table public.ai_team_member drop constraint if exists ai_team_member_system_key_check;
alter table public.ai_team_member add constraint ai_team_member_system_key_check
  check (
    system_key is null
    or (is_system and system_key in ('triage', 'extraction', 'email_drafts', 'reconciler'))
  );

-- A system teammate is attribution for a loop, never a routing target: the
-- auto-attempt gate and the (future) resolver pick teammates by role, so a NULL
-- role keeps every system row out of routing by construction.
alter table public.ai_team_member drop constraint if exists ai_team_member_system_not_routable;
alter table public.ai_team_member add constraint ai_team_member_system_not_routable
  check (not is_system or role is null);

-- One teammate per loop per workspace. NOT partial: NULLs are distinct in a
-- unique index, so every non-system row (system_key NULL) passes, and a
-- non-partial index can be an ON CONFLICT arbiter from PostgREST as well.
create unique index if not exists ai_team_member_workspace_system_key_uidx
  on public.ai_team_member (workspace_id, system_key);

-- The system-row guard, rewritten. 280's version refused EVERY delete of a
-- system row — including the cascade from deleting its team or its workspace,
-- so the first system teammate seeded would have made its workspace (and its
-- General team) undeletable. Nothing had seeded one yet, so the bug never fired.
-- Now:
--   DELETE  refused only while both parents still exist (a direct delete);
--           a cascade from the team or the workspace goes through.
--   UPDATE  is_system, system_key and a system row's agent_recipe_id are fixed
--           at insert: an admin could otherwise flip is_system off and then
--           delete, or rebind a loop's identity to a persona.
-- SECURITY DEFINER so the parent-existence checks see rows RLS would hide from
-- the deleting user (a private team they are not on).
create or replace function public.ai_team_member_protect_system()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system
       and exists (select 1 from public.workspace w where w.id = old.workspace_id)
       and exists (select 1 from public.team t where t.id = old.team_id) then
      raise exception 'system teammates cannot be deleted (ai_team_member %)', old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if new.is_system is distinct from old.is_system
     or new.system_key is distinct from old.system_key
     or (old.is_system and new.agent_recipe_id is distinct from old.agent_recipe_id) then
    raise exception 'is_system, system_key and a system teammate''s agent are fixed at insert (ai_team_member %)', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_team_member_protect_system on public.ai_team_member;
create trigger ai_team_member_protect_system
  before delete or update on public.ai_team_member
  for each row execute function public.ai_team_member_protect_system();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. seed_system_teammates — the one seeding statement
-- ═══════════════════════════════════════════════════════════════════════════
-- Four teammates on the workspace's default team (its oldest — the General
-- team every workspace gets from 015's trigger; 019 and getDefaultTeamId use
-- the same rule). A workspace with no team gets none (returns 0). Idempotent on
-- (workspace_id, system_key). role stays NULL (not routable) and autonomy /
-- allowed_side_effects keep their column defaults: nothing reads them for a
-- system row today, and this migration does not invent what they mean for one.
-- Returns how many rows it inserted.
--
-- Service role only: SECURITY DEFINER bypasses RLS, and an open RPC would let
-- any signed-in user write teammates into a workspace they are not in.
create or replace function public.seed_system_teammates(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
  v_count integer;
begin
  select t.id into v_team
  from public.team t
  where t.workspace_id = p_workspace_id
  order by t.created_at asc, t.id asc
  limit 1;
  if v_team is null then
    return 0;
  end if;

  insert into public.ai_team_member (workspace_id, team_id, name, agent_recipe_id, is_system, system_key)
  select p_workspace_id, v_team, s.name, r.id, true, s.system_key
  from (values
    ('triage', 'Triage', 'loop-triage', 1),
    ('extraction', 'Extraction', 'loop-extraction', 2),
    ('email_drafts', 'Email drafts', 'loop-email-drafts', 3),
    ('reconciler', 'Reconciler', 'loop-reconciler', 4)
  ) as s(system_key, name, slug, ord)
  join public.recipe r
    on r.slug = s.slug
   and r.workspace_id is null
   and r.category = 'agent'
  order by s.ord
  on conflict (workspace_id, system_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.seed_system_teammates(uuid) from public, anon, authenticated;
grant execute on function public.seed_system_teammates(uuid) to service_role;

-- New workspaces: seeded in the same transaction as the insert. The name sorts
-- after on_workspace_created_create_team (same event, triggers fire in name
-- order), so the General team exists when this runs.
create or replace function public.handle_new_workspace_system_teammates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_system_teammates(new.id);
  return new;
end;
$$;

drop trigger if exists on_workspace_created_seed_system_teammates on public.workspace;
create trigger on_workspace_created_seed_system_teammates
  after insert on public.workspace
  for each row execute function public.handle_new_workspace_system_teammates();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Backfill — every existing workspace
-- ═══════════════════════════════════════════════════════════════════════════
-- A behaviour change on existing workspaces, stated plainly: each one's default
-- team gains four teammates (the roster change row 4 is for). They are not
-- assignable (the workspace route and the action PATCH exclude them) and not
-- routable (role NULL, CHECK above).
select public.seed_system_teammates(w.id)
from public.workspace w;
