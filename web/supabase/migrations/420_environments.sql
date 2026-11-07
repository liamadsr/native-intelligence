-- ============================================================
-- 420: Environments, one place where work runs: on your Mac or in the cloud
-- (docs/plans/environments.md §3 the model, §4 the data, §5 safety; phase E1).
--
-- Apply to DEV, then PROD, BEFORE the code that reads it, and deploy right
-- after: the backfill copies cloud_environment once, so an edit made on the
-- old Settings page between applying this and deploying is not carried over
-- (a second run skips rows it already copied). It is additive: three tables,
-- six nullable columns, the reference triggers, one merge step, and a
-- backfill that changes nothing about how any run behaves. The old
-- cloud_environment table and projects.cloud_env_id stay until E5 drops them
-- (after the code that stops reading them has deployed: the 418/419 split).
-- The new code clears projects.cloud_env_id wherever it writes
-- environment_id, so a second run can't bring back a link someone removed.
--
--   environment            kind 'mac': one per Mac (its person and device),
--                          named after the Mac, renameable. Its folders are the
--                          Mac's live grants (device_folder), read by a join.
--                          kind 'cloud': a workspace's settings for a fresh
--                          Vercel Sandbox per run (network level, env vars,
--                          setup script), shared with its members or only its
--                          creator's. A cloud environment holds no repos.
--   device_folder_setting  the two per-folder settings the web may change: a
--                          base branch for edit jobs (E3) and a linked repo.
--   environment_default    a person's default per workspace (project_id null)
--                          and per project ("run this project's work on my
--                          Mac", which may only name their own Mac).
--   new columns            workspace.default_cloud_environment_id, and
--                          environment_id on projects, chat_conversations,
--                          agent_run and local_agent_session (each job's, set
--                          when it starts and only then); user_device.removed_at;
--                          user_device.capabilities (what the Mac's app says it
--                          can do, E2); local_agent_session.base_branch (an
--                          edit job's base, E3).
--
-- "Remove this Mac" is a soft remove (user_device.removed_at): it deletes
-- nothing, so the Mac's sessions, transcripts, branches and pull requests,
-- its folders' ids and settings, and its environment's id all survive. The
-- server revokes its folders and archives its environment; its heartbeat is
-- refused (DEVICE_REMOVED) until the person adds a folder on that Mac again,
-- which clears removed_at (the heartbeat's rejoin, src/lib/local-agent).
--
-- Security. Every new table has SELECT policies only: writes go through
-- routes that run as the service role (src/lib/environments/*), like 410's.
--   * a Mac environment and its folder settings: the owner only;
--   * a cloud environment: workspace members when shared, else its creator,
--     and workspace admins always;
--   * environment_default: the person's own rows.
-- env_vars and setup_script are never selectable by a client. A column-level
-- REVOKE alone does nothing here: Supabase grants every new table to anon
-- and authenticated table-wide, and a table-level SELECT covers every column
-- whatever is revoked per column. So the table grant is revoked and SELECT
-- is granted back on every other column. The routes give the two columns in
-- full to the creator and to workspace admins, masked to other members.
--
-- What a reference may point at (one BEFORE INSERT OR UPDATE trigger per
-- column, re-checked by the code at every read and start):
--   projects.environment_id, workspace.default_cloud_environment_id
--       a shared, live cloud environment of the same workspace (never a Mac:
--       a project is shared, a Mac is one person's);
--   chat_conversations.environment_id
--       the chat owner's own Mac, or a live cloud environment of the chat's
--       workspace they can see (shared, or theirs);
--   environment_default.environment_id
--       the person's own Mac, or a live cloud environment of that workspace
--       they can see; with a project_id, only their own Mac;
--   agent_run.environment_id
--       a live cloud environment of the run's own workspace (agent_run_insert
--       lets any member insert a run). Its foreign key is NO ACTION, not SET
--       NULL: an environment a run started in can't vanish under it (a
--       workspace delete takes its runs in the same statement, so it still
--       goes), and a run whose environment was archived fails at its next
--       session instead of falling through to another one.
-- A refused reference raises 42501. A row that changes workspace with its
-- reference unchanged (the move engine's move_project) drops a reference that
-- is no longer valid there, as move_project already drops cloud_env_id, and a
-- moved project's personal defaults go (they named the old workspace).
-- Inside a workspace merge the checks step aside (_wsmerge_active, as the 402
-- guards do): _wsmerge_environments moves the cloud environments with the
-- rest, so every reference is valid again when the merge commits.
-- environment_guard keeps an environment's kind, owner, device and workspace
-- fixed (a merge aside), and refuses to make "only me", or to archive, a
-- cloud environment a project or a workspace default uses: the person moves
-- them off it first.
--
-- Backfill, in this order. The reference triggers are created after it, so it
-- is not checked by them; it is valid by construction:
--   1. a Mac environment per user_device, named after the device;
--   2. a cloud environment per cloud_environment: the same id, shared,
--      created_by kept, network_access coalesced to 'trusted' (the old
--      column's default), the name trimmed to the new 80-character check.
--      Env vars or a setup script over 64 KB (the new checks) fail the
--      migration rather than be cut: shorten them on the old page first;
--   3. projects.environment_id from cloud_env_id, where that environment is
--      the project's own workspace's and live (spec-rebuild only ever applied
--      those);
--   4. one "Default cloud" (trusted, the network those runs really got) per
--      workspace with a project that has a repo but no environment, or with
--      any flow, set as workspace.default_cloud_environment_id. A new cloud
--      environment still defaults to restricted (the routes).
-- device_folder_setting, chats and personal defaults start empty. The
-- updated_at triggers on projects and workspace are paused for steps 3 and 4,
-- so the backfill doesn't make every linked project look just edited.
-- Running the file twice changes nothing: steps 1 and 2 skip rows already
-- there; step 3 only fills a project with no environment (and the code
-- clears cloud_env_id when it unlinks one); step 4 skips a workspace with any
-- cloud environment this migration or the new code made (one not copied from
-- cloud_environment), archived ones included, so a cleared or replaced
-- default is never made again.
--
-- Workspace merge (402, 408, 417): every environment table is caught by the
-- generic re-stamp, but environment_default's (user, workspace, project)
-- uniqueness would collide there (P0008), and a folded default project still
-- has personal defaults pointing at it (408's _wsmerge_assert_no_refs). So
-- _wsmerge_environments (new) runs before _wsmerge_default_projects: it pins
-- each source project with no environment to the source's default cloud
-- environment (so its runs keep running where they did), moves the source's
-- cloud environments, archived ones too (renaming one whose name the
-- destination already uses), keeps the destination's default cloud
-- environment (taking the source's only when the destination has none),
-- drops the source's personal defaults the destination already has for the
-- same person and project, and moves the rest onto the destination's
-- projects. The source's loops have no project: they run in the
-- destination's default afterwards, and the preflight says so.
-- merge_workspace is 402's text with that one step added.
-- merge_workspace_preflight is 402's text with cloud_environments counted
-- from environment (every cloud one, as the merge moves them), what happens
-- to the default cloud environment (and so to the source's loops and
-- projects), and the personal defaults dropped. Neither reads
-- cloud_environment any more, so E5's drop no longer needs to redefine the
-- preflight (its export filter, 407, excludes every env_vars column by name
-- already).
--
-- No backslash anywhere in this file (one MCP transport decodes escapes):
-- the branch pattern says [.] for a literal dot, and the Mac-name trim names
-- its whitespace with chr().
--
-- Not applied by the builder: Liam applies it (DEV, then PROD), before the
-- deploy that ships with it.
-- ============================================================

-- The new columns take a brief exclusive lock on projects, workspace,
-- chat_conversations, agent_run and local_agent_session: fail fast rather
-- than queue every request behind a long transaction (as 392 does).
SET LOCAL lock_timeout = '5s';

-- ── environment ─────────────────────────────────────────────────────────────
create table if not exists public.environment (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('mac', 'cloud')),
  name           text not null check (char_length(name) between 1 and 80),
  -- mac: its person and Mac; one environment per Mac.
  owner_user_id  uuid references auth.users (id) on delete cascade,
  device_id      uuid,
  -- cloud: its workspace, who made it, who can use it, the sandbox settings.
  workspace_id   uuid references public.workspace (id) on delete cascade,
  created_by     uuid references auth.users (id) on delete set null,
  shared         boolean,
  network_access text check (network_access in ('trusted', 'restricted', 'isolated')),
  -- Not selectable by clients (below); at most 64 KB each
  -- (src/lib/environments/types.ts ENV_TEXT_MAX_BYTES). Plaintext until E4.
  env_vars       text check (octet_length(env_vars) <= 65536),
  setup_script   text check (octet_length(setup_script) <= 65536),
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint environment_device_fk foreign key (owner_user_id, device_id)
    references public.user_device (user_id, id) on delete cascade,
  -- One environment per Mac. A full constraint rather than a partial index on
  -- kind = 'mac': a cloud row has both columns NULL (the shape check), and
  -- NULLs are distinct, so this is the same rule, and a full constraint is
  -- what ON CONFLICT (owner_user_id, device_id) DO NOTHING can infer
  -- (PostgREST sends no index predicate; 410's event dedupe does the same).
  -- It also serves the composite foreign key's cascade.
  constraint environment_one_per_mac unique (owner_user_id, device_id),
  constraint environment_kind_shape check (
    (kind = 'mac' and owner_user_id is not null and device_id is not null and workspace_id is null
       and shared is null and network_access is null and env_vars is null and setup_script is null)
    or
    (kind = 'cloud' and owner_user_id is null and device_id is null and workspace_id is not null
       and shared is not null and network_access is not null)
  )
);

comment on table public.environment is
  'Environments (420): where an agent''s work runs. kind mac: one per Mac (owner_user_id, device_id), its folders are the Mac''s live grants. kind cloud: a workspace''s Vercel Sandbox settings, shared or only its creator''s. Clients SELECT (never env_vars or setup_script); only the service role writes.';

create index if not exists environment_workspace
  on public.environment (workspace_id) where kind = 'cloud';
-- The created_by foreign key's ON DELETE SET NULL.
create index if not exists environment_created_by_idx
  on public.environment (created_by) where created_by is not null;

drop trigger if exists environment_updated_at on public.environment;
create trigger environment_updated_at
  before update on public.environment
  for each row execute function public.update_updated_at();

alter table public.environment enable row level security;

drop policy if exists environment_mac_owner_select on public.environment;
create policy environment_mac_owner_select on public.environment
  for select to authenticated
  using (kind = 'mac' and owner_user_id = (select auth.uid()));

drop policy if exists environment_cloud_select on public.environment;
create policy environment_cloud_select on public.environment
  for select to authenticated
  using (
    kind = 'cloud' and (
      public.get_member_role(workspace_id) in ('owner', 'admin')
      or (public.is_workspace_member(workspace_id) and (shared or created_by = (select auth.uid())))
    )
  );

-- The two columns no client may read. The table-wide grant goes first (a
-- column revoke under it would change nothing), then SELECT comes back on
-- every other column. No client write privilege at all.
revoke all on public.environment from anon, authenticated;
grant select (id, kind, name, owner_user_id, device_id, workspace_id, created_by, shared,
              network_access, archived_at, created_at, updated_at)
  on public.environment to authenticated;
revoke select (env_vars, setup_script) on public.environment from anon, authenticated;

-- ── device_folder_setting ───────────────────────────────────────────────────
-- The two per-folder settings the web may change; everything else about a
-- folder (label, path, mode ceiling, is_git) stays the Mac's, in
-- device_folder. Keyed by the folder row, so they survive a revoke and
-- re-grant (the heartbeat clears revoked_at by grant id). The patterns are
-- the server's (src/lib/environments/types.ts) and, in E3, Rust's: never
-- HEAD or a refs/ name, never `..`, `//`, `@{`, or a `.lock`, `/` or `.` end.
create table if not exists public.device_folder_setting (
  device_folder_id uuid primary key references public.device_folder (id) on delete cascade,
  base_branch      text check (base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
                               and base_branch !~ '(^HEAD$|^refs/|[.][.]|//|@[{]|[.]lock$|/$|[.]$)'),
  repo_full_name   text check (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  updated_at       timestamptz not null default now()
);

comment on table public.device_folder_setting is
  'Environments (420): a Mac folder''s base branch (edit jobs, E3) and linked repo (the offline fallback). The folder''s owner reads it; only the service role writes.';

drop trigger if exists device_folder_setting_updated_at on public.device_folder_setting;
create trigger device_folder_setting_updated_at
  before update on public.device_folder_setting
  for each row execute function public.update_updated_at();

alter table public.device_folder_setting enable row level security;

drop policy if exists device_folder_setting_owner_select on public.device_folder_setting;
create policy device_folder_setting_owner_select on public.device_folder_setting
  for select to authenticated
  using (exists (
    select 1 from public.device_folder f
    where f.id = device_folder_id and f.user_id = (select auth.uid())
  ));

-- No write policy, and no write privilege either (defence in depth).
revoke insert, update, delete on public.device_folder_setting from anon, authenticated;

-- ── environment_default ─────────────────────────────────────────────────────
-- Your defaults: per workspace (project_id null), and per project ("run this
-- project's work on my Mac", which may only name your Mac). The id is not in
-- §4's sketch: the merge's snapshot export pages every workspace table by its
-- primary key (407), and refuses a table without one.
create table if not exists public.environment_default (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  workspace_id   uuid not null references public.workspace (id) on delete cascade,
  project_id     uuid references public.projects (id) on delete cascade,
  environment_id uuid not null references public.environment (id) on delete cascade,
  updated_at     timestamptz not null default now()
);

comment on table public.environment_default is
  'Environments (420): a person''s default environment per workspace (project_id null) and per project (their own Mac only). The person reads their own rows; only the service role writes.';

create unique index if not exists environment_default_one on public.environment_default
  (user_id, workspace_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- The foreign keys' cascades (a workspace, a project, an environment going).
create index if not exists environment_default_workspace_idx
  on public.environment_default (workspace_id);
create index if not exists environment_default_project_idx
  on public.environment_default (project_id) where project_id is not null;
create index if not exists environment_default_environment_idx
  on public.environment_default (environment_id);

drop trigger if exists environment_default_updated_at on public.environment_default;
create trigger environment_default_updated_at
  before update on public.environment_default
  for each row execute function public.update_updated_at();

alter table public.environment_default enable row level security;

drop policy if exists environment_default_own_select on public.environment_default;
create policy environment_default_own_select on public.environment_default
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- No write policy, and no write privilege either (defence in depth).
revoke insert, update, delete on public.environment_default from anon, authenticated;

-- ── The five references ─────────────────────────────────────────────────────
-- Named constraints, so a PostgREST embed can name its foreign key
-- (environment!projects_environment_id_fkey): environment_default also links
-- projects to environments, and an unnamed hint could read as that.
alter table public.workspace
  add column if not exists default_cloud_environment_id uuid
    constraint workspace_default_cloud_environment_id_fkey references public.environment (id) on delete set null;
alter table public.projects
  add column if not exists environment_id uuid
    constraint projects_environment_id_fkey references public.environment (id) on delete set null;
alter table public.chat_conversations
  add column if not exists environment_id uuid
    constraint chat_conversations_environment_id_fkey references public.environment (id) on delete set null;
-- NO ACTION (the header): a run's environment can't vanish under it.
alter table public.agent_run
  add column if not exists environment_id uuid
    constraint agent_run_environment_id_fkey references public.environment (id) on delete no action;
alter table public.local_agent_session
  add column if not exists environment_id uuid
    constraint local_agent_session_environment_id_fkey references public.environment (id) on delete set null;

comment on column public.workspace.default_cloud_environment_id is
  'Environments (420): where a run with no project environment runs (flows with no project). A shared cloud environment of this workspace.';
comment on column public.projects.environment_id is
  'Environments (420): the project''s shared cloud environment (replaces cloud_env_id, dropped in E5). Never a Mac.';
comment on column public.chat_conversations.environment_id is
  'Environments (420): where this chat sends work: the owner''s Mac, or a cloud environment of the chat''s workspace they can see. Null: the next default.';
comment on column public.agent_run.environment_id is
  'Environments (420): the environment the run started in. Written when it starts, and only then.';
comment on column public.local_agent_session.environment_id is
  'Environments (420): the Mac environment of the session''s device, written when it starts.';

-- "Remove this Mac", softly: the row and everything under it stay.
alter table public.user_device add column if not exists removed_at timestamptz;

comment on column public.user_device.removed_at is
  'Environments (420): "Remove this Mac". Its folders are revoked and its environment archived; its heartbeat is refused until a folder is added on that Mac again (the heartbeat''s rejoin clears this). Nothing is deleted.';

-- What the Mac's app says it can do, from its own heartbeat (E2): today only
-- 'baseBranch' (it resolves an edit job's base branch itself, plan §5). The
-- server stamps a base branch only on a job for a Mac that says so, so an
-- older app keeps branching from HEAD. The heartbeat writes only names it
-- knows (src/lib/local-agent/device.ts); a beat that sends none clears it.
alter table public.user_device
  add column if not exists capabilities text[] not null default '{}'
    constraint user_device_capabilities_check check (cardinality(capabilities) <= 16);

comment on column public.user_device.capabilities is
  'Environments (420, E2): what the Mac''s app can do, as its heartbeat says (today: baseBranch). Written by the heartbeat only.';

-- An edit job's base branch (E3): the folder's device_folder_setting.base_branch
-- when the job started, on a Mac whose app resolves one (capabilities). The
-- same pattern as device_folder_setting.base_branch, and only on an edit job;
-- the Mac checks it again and resolves only refs/heads/<name>. Null: HEAD.
alter table public.local_agent_session
  add column if not exists base_branch text
    constraint local_agent_session_base_branch_check check (
      base_branch is null or (
        mode = 'edit'
        and base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
        and base_branch !~ '(^HEAD$|^refs/|[.][.]|//|@[{]|[.]lock$|/$|[.]$)'
      )
    );

comment on column public.local_agent_session.base_branch is
  'Environments (420, E3): the local branch an edit job branches from, stamped when it started from its folder''s setting, only for a Mac whose app resolves one. Null: HEAD.';

-- The foreign keys' ON DELETE SET NULL, and "who uses this environment".
create index if not exists workspace_default_cloud_environment_idx
  on public.workspace (default_cloud_environment_id) where default_cloud_environment_id is not null;
create index if not exists projects_environment_idx
  on public.projects (environment_id) where environment_id is not null;
create index if not exists chat_conversations_environment_idx
  on public.chat_conversations (environment_id) where environment_id is not null;
create index if not exists agent_run_environment_idx
  on public.agent_run (environment_id) where environment_id is not null;
create index if not exists local_agent_session_environment_idx
  on public.local_agent_session (environment_id) where environment_id is not null;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- 1. A Mac environment per Mac, named after it (src/lib/environments/types.ts
--    macEnvironmentName is the same rule: the same six whitespace characters
--    trimmed, the same fallback, 80 characters).
insert into public.environment (kind, name, owner_user_id, device_id, created_at, updated_at)
select 'mac',
       left(coalesce(nullif(btrim(d.name, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)), ''), 'My Mac'), 80),
       d.user_id, d.id, d.created_at, d.created_at
from public.user_device d
on conflict (owner_user_id, device_id) do nothing;

-- 2. A cloud environment per cloud_environment: the same id, shared, its
--    creator kept (it may be null), every sandbox setting as it was.
insert into public.environment (
  id, kind, name, workspace_id, created_by, shared, network_access, env_vars, setup_script, created_at, updated_at
)
select c.id, 'cloud', left(coalesce(nullif(btrim(c.name), ''), 'Cloud environment'), 80), c.workspace_id,
       c.created_by, true, coalesce(c.network_access, 'trusted'), c.env_vars, c.setup_script, c.created_at, c.updated_at
from public.cloud_environment c
on conflict (id) do nothing;

-- 3 and 4 touch projects and workspace rows: their updated_at stays as it was.
alter table public.projects disable trigger project_updated_at;
alter table public.workspace disable trigger workspace_updated_at;

-- 3. The project's environment, where cloud_env_id names one of its own
--    workspace's (a cross-workspace link was never applied: spec-rebuild read
--    it scoped to the run's workspace, and the run got the defaults).
update public.projects p
set environment_id = p.cloud_env_id
from public.environment e
where e.id = p.cloud_env_id
  and e.kind = 'cloud'
  and e.workspace_id = p.workspace_id
  and e.archived_at is null
  and p.environment_id is null;

-- 4. "Default cloud" (trusted) where a run would otherwise get no
--    environment: a project with a repo and no environment, or any flow.
with made as (
  insert into public.environment (kind, name, workspace_id, created_by, shared, network_access)
  select 'cloud', 'Default cloud', w.id, null, true, 'trusted'
  from public.workspace w
  where w.default_cloud_environment_id is null
    -- A second run: this workspace already has a cloud environment that
    -- wasn't copied from cloud_environment (the first run's Default cloud, or
    -- one made since, archived or not). Nothing is made again.
    and not exists (
      select 1 from public.environment e
      where e.workspace_id = w.id and e.kind = 'cloud'
        and not exists (select 1 from public.cloud_environment c where c.id = e.id)
    )
    and (
      exists (
        select 1 from public.projects p
        where p.workspace_id = w.id and p.environment_id is null
          and nullif(btrim(p.github_repo), '') is not null
      )
      or exists (select 1 from public.flow f where f.workspace_id = w.id)
    )
  returning id, workspace_id
)
update public.workspace w
set default_cloud_environment_id = made.id
from made
where w.id = made.workspace_id;

alter table public.projects enable trigger project_updated_at;
alter table public.workspace enable trigger workspace_updated_at;

-- ── Reference checks ────────────────────────────────────────────────────────
-- p_env is something p_user may use in p_workspace: their own Mac (a Mac is
-- its person's, in every workspace), or, unless p_mac_only, a live cloud
-- environment of p_workspace they can see (shared, or theirs) while they are
-- a member there.
create or replace function public._environment_usable(p_env uuid, p_user uuid, p_workspace uuid, p_mac_only boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.environment e
    where e.id = p_env
      and e.archived_at is null
      and (
        (e.kind = 'mac' and e.owner_user_id = p_user)
        or (
          not p_mac_only
          and e.kind = 'cloud'
          and e.workspace_id = p_workspace
          and (e.shared or e.created_by = p_user)
          and exists (select 1 from public.member m where m.workspace_id = p_workspace and m.user_id = p_user)
        )
      )
  );
$$;

-- p_env is a shared, live cloud environment of p_workspace.
create or replace function public._environment_shared_in(p_env uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.environment e
    where e.id = p_env
      and e.kind = 'cloud'
      and e.shared
      and e.archived_at is null
      and e.workspace_id = p_workspace
  );
$$;

-- projects.environment_id: a shared cloud environment of the project's own
-- workspace. Checked when the reference or the workspace changes; a project
-- that moves workspace (move_project) drops one that isn't the new one's.
create or replace function public.environment_check_project_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.environment_id is null or public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.environment_id is not distinct from old.environment_id
     and new.workspace_id is not distinct from old.workspace_id then
    return new;
  end if;
  if public._environment_shared_in(new.environment_id, new.workspace_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.environment_id is not distinct from old.environment_id then
    new.environment_id := null;
    return new;
  end if;
  raise exception 'a project''s environment must be a shared cloud environment of its own workspace'
    using errcode = '42501';
end;
$$;

drop trigger if exists projects_environment_check on public.projects;
create trigger projects_environment_check
  before insert or update of environment_id, workspace_id on public.projects
  for each row execute function public.environment_check_project_ref();

-- workspace.default_cloud_environment_id: a shared cloud environment of that
-- workspace. A workspace never changes id, so only a new reference is checked.
create or replace function public.environment_check_workspace_default()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.default_cloud_environment_id is null or public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.default_cloud_environment_id is not distinct from old.default_cloud_environment_id then
    return new;
  end if;
  if public._environment_shared_in(new.default_cloud_environment_id, new.id) then
    return new;
  end if;
  raise exception 'a workspace''s default cloud environment must be a shared cloud environment of that workspace'
    using errcode = '42501';
end;
$$;

drop trigger if exists workspace_default_cloud_environment_check on public.workspace;
create trigger workspace_default_cloud_environment_check
  before insert or update of default_cloud_environment_id on public.workspace
  for each row execute function public.environment_check_workspace_default();

-- chat_conversations.environment_id: the chat owner's own Mac, or a cloud
-- environment of the chat's workspace they can see. A chat whose workspace or
-- owner changes drops a reference that is no longer theirs to use.
create or replace function public.environment_check_chat_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.environment_id is null or public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.environment_id is not distinct from old.environment_id
     and new.workspace_id is not distinct from old.workspace_id
     and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  if public._environment_usable(new.environment_id, new.user_id, new.workspace_id, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.environment_id is not distinct from old.environment_id then
    new.environment_id := null;
    return new;
  end if;
  raise exception 'a chat''s environment must be its owner''s Mac or a cloud environment of its workspace they can use'
    using errcode = '42501';
end;
$$;

drop trigger if exists chat_conversations_environment_check on public.chat_conversations;
create trigger chat_conversations_environment_check
  before insert or update of environment_id, workspace_id, user_id on public.chat_conversations
  for each row execute function public.environment_check_chat_ref();

-- environment_default.environment_id: the person's own Mac, or a cloud
-- environment of that workspace they can see. With a project_id, only their
-- own Mac, and the project is one of that workspace's.
create or replace function public.environment_check_default_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.environment_id is not distinct from old.environment_id
     and new.workspace_id is not distinct from old.workspace_id
     and new.user_id is not distinct from old.user_id
     and new.project_id is not distinct from old.project_id then
    return new;
  end if;
  if new.project_id is not null and not exists (
    select 1 from public.projects p where p.id = new.project_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'a project default must name a project of its workspace' using errcode = '42501';
  end if;
  if public._environment_usable(new.environment_id, new.user_id, new.workspace_id, new.project_id is not null) then
    return new;
  end if;
  raise exception 'a default environment must be your own Mac, or (for a workspace) a cloud environment of it you can use'
    using errcode = '42501';
end;
$$;

drop trigger if exists environment_default_check on public.environment_default;
create trigger environment_default_check
  before insert or update on public.environment_default
  for each row execute function public.environment_check_default_ref();

-- An environment's kind, owner, device and workspace never change (a merge
-- moves cloud environments, and steps aside here), and a cloud environment a
-- project or a workspace default uses stays shared and live: "only me" would
-- hand its env vars to every teammate's run in that project, and archiving it
-- would quietly move those runs somewhere else. The person moves them off it
-- first (archiveEnvironment answers 409 ENVIRONMENT_IN_USE).
create or replace function public.environment_guard_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._wsmerge_active() then
    return new;
  end if;
  if new.kind is distinct from old.kind
     or new.owner_user_id is distinct from old.owner_user_id
     or new.device_id is distinct from old.device_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'an environment''s kind, owner, Mac and workspace are fixed' using errcode = '42501';
  end if;
  if old.shared and not new.shared and (
    exists (select 1 from public.projects p where p.environment_id = old.id)
    or exists (select 1 from public.workspace w where w.default_cloud_environment_id = old.id)
  ) then
    raise exception 'a cloud environment a project or the workspace default uses must stay shared' using errcode = '42501';
  end if;
  if old.archived_at is null and new.archived_at is not null and (
    exists (select 1 from public.projects p where p.environment_id = old.id)
    or exists (select 1 from public.workspace w where w.default_cloud_environment_id = old.id)
  ) then
    raise exception 'a cloud environment a project or the workspace default uses can''t be archived' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists environment_guard on public.environment;
create trigger environment_guard
  before update of kind, owner_user_id, device_id, workspace_id, shared, archived_at on public.environment
  for each row execute function public.environment_guard_identity();

-- agent_run.environment_id: a live cloud environment of the run's own
-- workspace (a member may insert a run, agent_run_insert). Checked when the
-- reference changes; a run never changes workspace outside a merge.
create or replace function public.environment_check_run_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.environment_id is null or public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.environment_id is not distinct from old.environment_id then
    return new;
  end if;
  if exists (
    select 1 from public.environment e
    where e.id = new.environment_id and e.kind = 'cloud' and e.archived_at is null
      and e.workspace_id = new.workspace_id
  ) then
    return new;
  end if;
  raise exception 'a run''s environment must be a live cloud environment of its own workspace' using errcode = '42501';
end;
$$;

drop trigger if exists agent_run_environment_check on public.agent_run;
create trigger agent_run_environment_check
  before insert or update of environment_id on public.agent_run
  for each row execute function public.environment_check_run_ref();

-- A project that moves to another workspace (move_project) leaves its
-- personal defaults behind: they named the old workspace, and nothing reads
-- them there. A merge moves them itself (_wsmerge_environments).
create or replace function public.environment_drop_moved_project_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._wsmerge_active() or new.workspace_id is not distinct from old.workspace_id then
    return null;
  end if;
  delete from public.environment_default d
  where d.project_id = new.id and d.workspace_id is distinct from new.workspace_id;
  return null;
end;
$$;

drop trigger if exists projects_environment_defaults_moved on public.projects;
create trigger projects_environment_defaults_moved
  after update of workspace_id on public.projects
  for each row execute function public.environment_drop_moved_project_defaults();

-- Reached only through the triggers (and the merge): no client calls them,
-- and a security-definer lookup must not be an oracle for ids.
revoke all on function public._environment_usable(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public._environment_shared_in(uuid, uuid) from public, anon, authenticated;
revoke all on function public.environment_check_project_ref() from public, anon, authenticated;
revoke all on function public.environment_check_workspace_default() from public, anon, authenticated;
revoke all on function public.environment_check_chat_ref() from public, anon, authenticated;
revoke all on function public.environment_check_default_ref() from public, anon, authenticated;
revoke all on function public.environment_guard_identity() from public, anon, authenticated;
revoke all on function public.environment_check_run_ref() from public, anon, authenticated;
revoke all on function public.environment_drop_moved_project_defaults() from public, anon, authenticated;

-- ── Workspace merge: the environments step ──────────────────────────────────
-- Runs inside merge_workspace, after the maps and before
-- _wsmerge_default_projects. Rule: a source project with no environment is
-- pinned to the source's default cloud environment first, so its runs keep
-- running where they did; the source's cloud environments come over, archived
-- ones too (one whose name the destination already uses gets the source's
-- name after it); the destination keeps its default cloud environment and
-- takes the source's only when it has none (the source's loops, which have no
-- project, run in it afterwards: the preflight says so); a person's default
-- the destination already has (same person, same project after the default
-- projects fold) keeps the destination's, and the rest move. Agent runs, local
-- sessions and chats keep their environment ids: the ids don't change.
create or replace function public._wsmerge_environments(p_source uuid, p_dest uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_src_name text;
  v_renamed int := 0;
  v_moved int := 0;
  v_adopted int := 0;
  v_dropped int := 0;
  v_defaults int := 0;
  v_pinned int := 0;
begin
  select name into v_src_name from public.workspace where id = p_source;

  update public.projects p
  set environment_id = s.default_cloud_environment_id,
      cloud_env_id = null
  from public.workspace s
  where s.id = p_source and p.workspace_id = p_source
    and p.environment_id is null and s.default_cloud_environment_id is not null;
  get diagnostics v_pinned = row_count;

  update public.environment s
  set name = left(s.name || ' (' || coalesce(v_src_name, 'merged') || ')', 80)
  where s.workspace_id = p_source and s.kind = 'cloud'
    and exists (
      select 1 from public.environment d
      where d.workspace_id = p_dest and d.kind = 'cloud' and lower(d.name) = lower(s.name)
    );
  get diagnostics v_renamed = row_count;

  update public.environment set workspace_id = p_dest where workspace_id = p_source;
  get diagnostics v_moved = row_count;

  update public.workspace d
  set default_cloud_environment_id = s.default_cloud_environment_id
  from public.workspace s
  where d.id = p_dest and s.id = p_source
    and d.default_cloud_environment_id is null
    and s.default_cloud_environment_id is not null;
  get diagnostics v_adopted = row_count;

  delete from public.environment_default s
  where s.workspace_id = p_source
    and exists (
      select 1 from public.environment_default d
      where d.workspace_id = p_dest and d.user_id = s.user_id
        and d.project_id is not distinct from coalesce(
          (select m.dst from pg_temp._wsmerge_projects m where m.src = s.project_id), s.project_id)
    );
  get diagnostics v_dropped = row_count;

  update public.environment_default s
  set workspace_id = p_dest,
      project_id = coalesce((select m.dst from pg_temp._wsmerge_projects m where m.src = s.project_id), s.project_id)
  where s.workspace_id = p_source;
  get diagnostics v_defaults = row_count;

  return jsonb_build_object(
    'projects_pinned_to_source_default', v_pinned,
    'cloud_environments_moved', v_moved,
    'cloud_environments_renamed', v_renamed,
    'default_cloud_environment_adopted', v_adopted > 0,
    'environment_defaults_moved', v_defaults,
    'environment_defaults_dropped', v_dropped
  );
end;
$$;

revoke all on function public._wsmerge_environments(uuid, uuid) from public, anon, authenticated;

-- ── Workspace merge: the preflight ──────────────────────────────────────────
-- 402's text with two changes: integrations.cloud_environments counts this
-- workspace's live cloud environments in environment (not cloud_environment),
-- with what happens to its default cloud environment beside it
-- (none | source_adopted | destination_keeps); and singletons_dropped counts
-- the personal defaults the merge drops (environment_default). Nothing else
-- moves.
CREATE OR REPLACE FUNCTION public.merge_workspace_preflight(
  p_source uuid,
  p_destination uuid,
  p_actor uuid,
  p_plan jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_src public.workspace%ROWTYPE;
  v_dst public.workspace%ROWTYPE;
  v_plan jsonb;
  v_busy jsonb;
  v_drift_src jsonb; v_drift_dst jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_people jsonb; v_teams jsonb := '[]'::jsonb; v_labels jsonb; v_integrations jsonb; v_collisions jsonb;
  tm record;
  v_reprefixed bigint; v_renumbered bigint; v_states jsonb; v_cycle_conflict boolean;
BEGIN
  PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);
  SELECT * INTO v_src FROM public.workspace WHERE id = p_source;
  SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination;

  v_plan := public._wsmerge_plan(p_source, p_destination, COALESCE(p_plan, '{}'::jsonb));
  PERFORM public._wsmerge_build_maps(p_source, p_destination, v_plan);

  -- blockers: the source is busy, or either side fails the sweep
  v_busy := public._wsmerge_busy(p_source);
  IF jsonb_array_length(v_busy->'live_captures') > 0
     OR (v_busy->>'agent_runs')::int > 0 OR (v_busy->>'flow_runs')::int > 0 OR (v_busy->>'tracked_jobs')::int > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'source_busy', 'detail', v_busy);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('check', check_name, 'violations', violations)), '[]'::jsonb)
    INTO v_drift_src FROM public.workspace_integrity_sweep(p_source);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('check', check_name, 'violations', violations)), '[]'::jsonb)
    INTO v_drift_dst FROM public.workspace_integrity_sweep(p_destination);
  IF jsonb_array_length(v_drift_src) > 0 OR jsonb_array_length(v_drift_dst) > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'drift', 'source', v_drift_src, 'destination', v_drift_dst);
  END IF;

  -- people
  v_people := jsonb_build_object(
    'joining', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'member_id', m.id, 'user_id', m.user_id, 'display_name', m.display_name,
               'role', CASE WHEN m.role = 'owner' THEN 'admin' ELSE m.role END) ORDER BY m.created_at), '[]'::jsonb)
      FROM public.member m
      WHERE m.workspace_id = p_source AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_members x WHERE x.src = m.id)),
    'in_both', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id, 'display_name', d.display_name,
               'source_role', s.role, 'destination_role', d.role,
               'role_after', CASE WHEN d.role = 'owner' THEN 'owner'
                                  WHEN s.role = 'owner' THEN 'admin'
                                  WHEN public._wsmerge_role_rank(s.role) > public._wsmerge_role_rank(d.role) THEN s.role
                                  ELSE d.role END) ORDER BY d.created_at), '[]'::jsonb)
      FROM pg_temp._wsmerge_members x
      JOIN public.member s ON s.id = x.src
      JOIN public.member d ON d.id = x.dst),
    'destination_members', (SELECT count(*) FROM public.member WHERE workspace_id = p_destination),
    'invites_moving', (
      SELECT count(*) FROM public.invite i
      WHERE i.workspace_id = p_source AND i.accepted_at IS NULL AND i.expires_at > now()
        AND NOT EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
                        WHERE dm.workspace_id = p_destination AND lower(u.email) = lower(i.email))
        AND NOT EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_destination AND di.accepted_at IS NULL
                        AND di.expires_at > now() AND lower(di.email) = lower(i.email))),
    'invites_dropped', (
      SELECT count(*) FROM public.invite i
      WHERE i.workspace_id = p_source AND (
        i.accepted_at IS NOT NULL OR i.expires_at <= now()
        OR EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
                   WHERE dm.workspace_id = p_destination AND lower(u.email) = lower(i.email))
        OR EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_destination AND di.accepted_at IS NULL
                   AND di.expires_at > now() AND lower(di.email) = lower(i.email))))
  );

  -- teams: the plan's rows plus what each choice does to identifiers,
  -- states and cycles
  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams ORDER BY ord LOOP
    IF tm.mode = 'own' THEN
      SELECT count(*) FILTER (WHERE left(a.identifier, length(tm.old_prefix) + 1) = tm.old_prefix || '-' AND tm.new_prefix <> tm.old_prefix),
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.actions d WHERE d.workspace_id = p_destination
               AND d.identifier = CASE WHEN tm.new_prefix <> tm.old_prefix AND left(a.identifier, length(tm.old_prefix) + 1) = tm.old_prefix || '-'
                                       THEN tm.new_prefix || substring(a.identifier FROM length(tm.old_prefix) + 1)
                                       ELSE a.identifier END))
      INTO v_reprefixed, v_renumbered
      FROM public.actions a WHERE a.workspace_id = p_source AND a.team_id = tm.src;
      v_states := '[]'::jsonb;
      v_cycle_conflict := false;
    ELSE
      v_reprefixed := 0;
      SELECT count(*) INTO v_renumbered
      FROM public.actions a WHERE a.workspace_id = p_source AND a.team_id = tm.src
        AND EXISTS (SELECT 1 FROM public.actions d WHERE d.workspace_id = p_destination AND d.identifier = a.identifier);
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'from', s.name, 'to', d.name,
               'actions', (SELECT count(*) FROM public.actions a WHERE a.status_id = s.id AND a.workspace_id = p_source)
             ) ORDER BY s.sort_order), '[]'::jsonb)
      INTO v_states
      FROM pg_temp._wsmerge_states sm
      JOIN public.workflow_state s ON s.id = sm.src
      LEFT JOIN public.workflow_state d ON d.id = sm.dst
      WHERE s.team_id = tm.src AND (d.id IS NULL OR lower(d.name) <> lower(s.name));
      v_cycle_conflict := EXISTS (SELECT 1 FROM public.cycle c WHERE c.team_id = tm.src AND c.status = 'active')
                      AND EXISTS (SELECT 1 FROM public.cycle c WHERE c.team_id = tm.dst AND c.status = 'active');
    END IF;

    v_teams := v_teams || (
      (SELECT e.value FROM jsonb_array_elements(v_plan->'teams') e WHERE (e.value->>'source_team_id')::uuid = tm.src)
      || jsonb_build_object(
           'identifiers', jsonb_build_object('reprefixed', v_reprefixed, 'renumbered', v_renumbered),
           'states_remapped', v_states,
           'active_cycle_conflict', v_cycle_conflict,
           'destination_team', CASE WHEN tm.mode = 'fold'
             THEN (SELECT jsonb_build_object('id', d.id, 'name', d.name, 'prefix', d.issue_prefix) FROM public.team d WHERE d.id = tm.dst)
             ELSE NULL END));
  END LOOP;

  v_labels := jsonb_build_object(
    'matched', (SELECT count(*) FROM pg_temp._wsmerge_labels),
    'created', (SELECT count(*) FROM public.label l WHERE l.workspace_id = p_source
                AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_labels x WHERE x.src = l.id)));

  v_integrations := jsonb_build_object(
    'tasks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider', p.provider,
        'source', EXISTS (SELECT 1 FROM public.task_sync_state s WHERE s.workspace_id = p_source AND s.provider = p.provider),
        'destination', EXISTS (SELECT 1 FROM public.task_sync_state d WHERE d.workspace_id = p_destination AND d.provider = p.provider),
        'outcome', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'tasks' AND sp.provider = p.provider)
                        THEN 'destination_wins' ELSE 'moves' END,
        'links_severed', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'tasks' AND sp.provider = p.provider)
                              THEN (SELECT count(*) FROM public.action_external_task x WHERE x.workspace_id = p_source AND x.provider = p.provider)
                              ELSE 0 END) ORDER BY p.provider), '[]'::jsonb)
      FROM (SELECT provider FROM public.task_sync_state WHERE workspace_id IN (p_source, p_destination) GROUP BY provider) p),
    'crm', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider', p.provider,
        'source', EXISTS (SELECT 1 FROM public.crm_sync_state s WHERE s.workspace_id = p_source AND s.provider = p.provider),
        'destination', EXISTS (SELECT 1 FROM public.crm_sync_state d WHERE d.workspace_id = p_destination AND d.provider = p.provider),
        'outcome', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'crm' AND sp.provider = p.provider)
                        THEN 'destination_wins' ELSE 'moves' END,
        'provider_ids_cleared', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'crm' AND sp.provider = p.provider)
                                     THEN (SELECT count(*) FROM public.contact c WHERE c.workspace_id = p_source AND c.source_provider = p.provider AND c.provider_contact_id IS NOT NULL)
                                        + (SELECT count(*) FROM public.company c WHERE c.workspace_id = p_source AND c.source_provider = p.provider AND c.provider_company_id IS NOT NULL)
                                     ELSE 0 END) ORDER BY p.provider), '[]'::jsonb)
      FROM (SELECT provider FROM public.crm_sync_state WHERE workspace_id IN (p_source, p_destination) GROUP BY provider) p),
    'connected_accounts', (SELECT count(*) FROM public.connected_account a WHERE a.workspace_id = p_source),
    'account_links', (SELECT count(*) FROM public.connected_account_workspace j WHERE j.workspace_id = p_source),
    'mcp_servers', (SELECT count(*) FROM public.connected_mcp_server s WHERE s.workspace_id = p_source),
    'cloud_environments', (SELECT count(*) FROM public.environment e WHERE e.workspace_id = p_source AND e.kind = 'cloud'),
    'default_cloud_environment', jsonb_build_object(
      'outcome', CASE WHEN v_src.default_cloud_environment_id IS NULL THEN 'none'
                      WHEN v_dst.default_cloud_environment_id IS NULL THEN 'source_adopted'
                      ELSE 'destination_keeps' END,
      'source', (SELECT jsonb_build_object('name', e.name, 'network_access', e.network_access) FROM public.environment e WHERE e.id = v_src.default_cloud_environment_id),
      'destination', (SELECT jsonb_build_object('name', e.name, 'network_access', e.network_access) FROM public.environment e WHERE e.id = v_dst.default_cloud_environment_id),
      'source_loops', (SELECT count(*) FROM public.flow f WHERE f.workspace_id = p_source AND f.actions @> '[{"type": "run_agent"}]'::jsonb),
      'projects_pinned', CASE WHEN v_src.default_cloud_environment_id IS NULL THEN 0
                              ELSE (SELECT count(*) FROM public.projects p WHERE p.workspace_id = p_source AND p.environment_id IS NULL
                                    AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_projects m WHERE m.src = p.id)) END),
    'github_prs', (SELECT count(*) FROM public.action_github_pr x WHERE x.workspace_id = p_source));

  v_collisions := jsonb_build_object(
    'contacts_folded', (SELECT count(*) FROM pg_temp._wsmerge_contacts),
    'companies_folded', (SELECT count(*) FROM pg_temp._wsmerge_companies),
    'workspace_company_demoted', EXISTS (
      SELECT 1 FROM public.company s WHERE s.workspace_id = p_source AND s.is_workspace_company
        AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_companies x WHERE x.src = s.id)
        AND EXISTS (SELECT 1 FROM public.company d WHERE d.workspace_id = p_destination AND d.is_workspace_company)),
    'documents_canon_demoted', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'canon_key', s.canon_key) ORDER BY s.title), '[]'::jsonb)
      FROM public.document s
      WHERE s.workspace_id = p_source AND s.canon_key IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.document d WHERE d.workspace_id = p_destination AND d.canon_key = s.canon_key
          AND (s.canon_key !~ '^(person|content-brief):'
               OR d.created_by IS NOT DISTINCT FROM COALESCE((SELECT x.dst FROM pg_temp._wsmerge_members x WHERE x.src = s.created_by), s.created_by)))),
    'documents_reslugged', (SELECT count(*) FROM public.document s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                            AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'views_reslugged', (SELECT count(*) FROM public.view s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                        AND EXISTS (SELECT 1 FROM public.view d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'recipes_reslugged', (SELECT count(*) FROM public.recipe s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                          AND EXISTS (SELECT 1 FROM public.recipe d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'packages_reslugged', (SELECT count(*) FROM public.knowledge_package s WHERE s.workspace_id = p_source
                           AND EXISTS (SELECT 1 FROM public.knowledge_package d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'prospect_lists_renamed', (SELECT count(*) FROM public.prospect_list s WHERE s.workspace_id = p_source
                               AND EXISTS (SELECT 1 FROM public.prospect_list d WHERE d.workspace_id = p_destination AND lower(d.name) = lower(s.name))),
    'home_threads_demoted', (SELECT count(*) FROM public.chat_conversations s WHERE s.workspace_id = p_source AND s.is_home
                             AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.workspace_id = p_destination AND d.is_home AND d.user_id = s.user_id)),
    'teammate_threads_demoted', (SELECT count(*) FROM public.chat_conversations s JOIN pg_temp._wsmerge_teammates t ON t.src = s.ai_team_member_id
                                 WHERE s.workspace_id = p_source
                                 AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.user_id = s.user_id AND d.ai_team_member_id = t.dst)),
    'system_teammates_folded', (SELECT count(*) FROM pg_temp._wsmerge_teammates),
    'seeded_flows_dropped', (SELECT count(*) FROM pg_temp._wsmerge_flows),
    'default_projects_folded', (SELECT count(*) FROM pg_temp._wsmerge_projects),
    'thread_copies_folded', (SELECT count(*) FROM public.email_thread_index s WHERE s.workspace_id = p_source
                             AND EXISTS (SELECT 1 FROM public.email_thread_index d WHERE d.workspace_id = p_destination
                                         AND COALESCE(d.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                                         AND d.provider_thread_id = s.provider_thread_id)),
    'account_links_deduped', (SELECT count(*) FROM public.connected_account_workspace s WHERE s.workspace_id = p_source
                              AND EXISTS (SELECT 1 FROM public.connected_account_workspace d WHERE d.workspace_id = p_destination AND d.account_id = s.account_id)),
    'sequence_enrollments_exited', (
      SELECT count(*) FROM public.sequence_enrollment s WHERE s.workspace_id = p_source AND s.status = 'active'
        AND EXISTS (SELECT 1 FROM public.sequence_enrollment d WHERE d.workspace_id = p_destination AND d.status = 'active'
                    AND (d.contact_id = COALESCE((SELECT c.dst FROM pg_temp._wsmerge_contacts c WHERE c.src = s.contact_id), s.contact_id)
                         OR lower(d.contact_email) = lower(s.contact_email)))),
    'singletons_dropped', jsonb_build_object(
      'mail_review_activity', (SELECT count(*) FROM public.mail_review_activity s WHERE s.workspace_id = p_source
                               AND EXISTS (SELECT 1 FROM public.mail_review_activity d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id)),
      'meeting_goal', (SELECT count(*) FROM public.meeting_goal s WHERE s.workspace_id = p_source
                       AND EXISTS (SELECT 1 FROM public.meeting_goal d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id
                                   AND d.calendar_event_id = s.calendar_event_id AND d.starts_at = s.starts_at)),
      'agent_log', (SELECT count(*) FROM public.agent_log s WHERE s.workspace_id = p_source
                    AND EXISTS (SELECT 1 FROM public.agent_log d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'agent_event', (SELECT count(*) FROM public.agent_event s WHERE s.workspace_id = p_source
                      AND EXISTS (SELECT 1 FROM public.agent_event d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'eval_candidate', (SELECT count(*) FROM public.eval_candidate s WHERE s.workspace_id = p_source
                         AND EXISTS (SELECT 1 FROM public.eval_candidate d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'reminders', (SELECT count(*) FROM public.reminder s WHERE s.workspace_id = p_source AND s.delivered_at IS NULL
                    AND EXISTS (SELECT 1 FROM public.reminder d WHERE d.workspace_id = p_destination AND d.delivered_at IS NULL
                                AND d.user_id = s.user_id AND d.entity_type = s.entity_type AND d.entity_id = s.entity_id)),
      'environment_default', (SELECT count(*) FROM public.environment_default s WHERE s.workspace_id = p_source
                              AND EXISTS (SELECT 1 FROM public.environment_default d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id
                                          AND d.project_id IS NOT DISTINCT FROM COALESCE((SELECT m.dst FROM pg_temp._wsmerge_projects m WHERE m.src = s.project_id), s.project_id)))));

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'source', jsonb_build_object('id', v_src.id, 'name', v_src.name, 'slug', v_src.slug, 'created_at', v_src.created_at),
    'destination', jsonb_build_object('id', v_dst.id, 'name', v_dst.name, 'slug', v_dst.slug),
    'busy', v_busy,
    'drift', jsonb_build_object('source', v_drift_src, 'destination', v_drift_dst),
    'people', v_people,
    'teams', v_teams,
    'labels', v_labels,
    'integrations', v_integrations,
    'collisions', v_collisions,
    'counts', public._wsmerge_counts(p_source),
    'plan', v_plan
  );
END;
$$;

-- ── Workspace merge: the merge ──────────────────────────────────────────────
-- 402's text with one step added: _wsmerge_environments, before
-- _wsmerge_default_projects (whose assertion would find personal defaults
-- still naming a folded default project). Nothing else moves. Its grants (402
-- section 10) carry over: create or replace keeps them.
CREATE OR REPLACE FUNCTION public.merge_workspace(
  p_source uuid,
  p_destination uuid,
  p_actor uuid,
  p_plan jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_t0 timestamptz := clock_timestamp();
  v_src public.workspace%ROWTYPE;
  v_dst public.workspace%ROWTYPE;
  v_plan jsonb; v_busy jsonb; v_drift text; v_before jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_ms int;
BEGIN
  -- the merge setting: transaction-local, read by the guard exemptions
  PERFORM set_config('dial8.workspace_merge', v_id::text, true);

  PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);

  -- both workspace rows locked, lowest id first (serialises with chat
  -- admission's FOR NO KEY UPDATE and with a concurrent merge either way)
  IF p_source < p_destination THEN
    SELECT * INTO v_src FROM public.workspace WHERE id = p_source FOR UPDATE;
    SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination FOR UPDATE;
  ELSE
    SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination FOR UPDATE;
    SELECT * INTO v_src FROM public.workspace WHERE id = p_source FOR UPDATE;
  END IF;
  IF v_src.id IS NULL OR v_dst.id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  v_plan := public._wsmerge_plan(p_source, p_destination, COALESCE(p_plan, '{}'::jsonb));

  -- refusals: a busy source, drift on either side
  v_busy := public._wsmerge_busy(p_source);
  IF jsonb_array_length(v_busy->'live_captures') > 0
     OR (v_busy->>'agent_runs')::int > 0 OR (v_busy->>'flow_runs')::int > 0 OR (v_busy->>'tracked_jobs')::int > 0 THEN
    RAISE EXCEPTION 'the source workspace is busy: %', v_busy::text USING ERRCODE = 'P0007';
  END IF;
  SELECT string_agg(check_name || '=' || violations, ', ') INTO v_drift FROM public.workspace_integrity_sweep(p_source);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'the source workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009';
  END IF;
  SELECT string_agg(check_name || '=' || violations, ', ') INTO v_drift FROM public.workspace_integrity_sweep(p_destination);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'the destination workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009';
  END IF;

  v_before := public._wsmerge_counts(p_source);
  PERFORM public._wsmerge_build_maps(p_source, p_destination, v_plan);

  v_counts := v_counts || public._wsmerge_members(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_system_teammates(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_teams_begin(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_labels(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_integrations(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_environments(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_default_projects(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_actions(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_documents(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_captures(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_contacts(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_companies(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_mail(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_agents_flows(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_knowledge(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_chat(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_views(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_singletons(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_teams_finish(p_source, p_destination);
  v_counts := v_counts || jsonb_build_object('restamped', public._wsmerge_generic_restamp(p_source, p_destination));
  v_counts := v_counts || public._wsmerge_pointers(p_source, p_destination);

  PERFORM public._wsmerge_assert(p_source, p_destination);

  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int;
  INSERT INTO public.workspace_merge (
    id, source_workspace_id, source_name, source_slug, source_settings, source_created_at,
    destination_workspace_id, actor_user_id, plan, counts, snapshot, started_at, finished_at, duration_ms
  ) VALUES (
    v_id, v_src.id, v_src.name, v_src.slug, COALESCE(v_src.settings, '{}'::jsonb), v_src.created_at,
    p_destination, p_actor, v_plan - 'snapshot', v_counts || jsonb_build_object('rows_before', v_before),
    v_plan->'snapshot', v_t0, clock_timestamp(), v_ms
  );

  -- the empty shell; nothing cascades from it any more
  DELETE FROM public.workspace WHERE id = p_source;

  RETURN jsonb_build_object(
    'merge_id', v_id,
    'source', jsonb_build_object('id', v_src.id, 'name', v_src.name, 'slug', v_src.slug),
    'destination', jsonb_build_object('id', v_dst.id, 'name', v_dst.name, 'slug', v_dst.slug),
    'counts', v_counts,
    'rows_before', v_before,
    'duration_ms', v_ms
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
