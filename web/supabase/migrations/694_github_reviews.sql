-- ============================================================
-- 694: GitHub Reviews, phase 2 — actions that move with their pull requests.
-- ============================================================
-- docs/plans/github-reviews.md. This file has its own begin/commit.
--
-- What it adds:
--
--   github_identity        who a person is on GitHub: GitHub's numeric user
--                          id and login, as GitHub answered for the person's
--                          OWN token (on connect, and when they open Reviews).
--                          Written by the service role only; a person reads
--                          their own row. It goes when their last GitHub
--                          connection goes (trigger on connected_account).
--
--   workspace_github_repo  the repositories a workspace takes pull-request
--                          automation from. An owner or admin adds them. An
--                          identifier in a branch or pull request of a repo
--                          a workspace hasn't added moves nothing there, so
--                          two workspaces sharing a team prefix (ENG) never
--                          move each other's actions.
--
--   action_github_branch   a branch that named an action before any pull
--                          request came from it ("branch created → in
--                          progress"), with the state the action was in
--                          before (for "closed without merging → back").
--                          Read through the action (its team's visibility);
--                          written by the service role only.
--
--   action_github_pr       + additions, deletions, changed_files (the size the
--                          action shows), author_github_id, status_before_id,
--                          auto_moved_at, auto_step and pr_updated_at (the
--                          automation's own memory). A member's client may
--                          not write the automation's columns (guard below).
--
--   team.github_automation the per-team switch (default on). The team's
--                          update policy already limits writes to owners,
--                          admins and the team's leads, who change its other
--                          settings; nothing wider can flip it.
-- ============================================================

begin;

-- ── github_identity ───────────────────────────────────────────

create table if not exists public.github_identity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  login text not null,
  updated_at timestamptz not null default now(),
  -- Lower case (GitHub's logins are case-insensitive; a mention is matched against it).
  constraint github_identity_login check (login ~ '^[a-z0-9][a-z0-9-]{0,38}$' and login !~ '--' and login !~ '-$'),
  constraint github_identity_github_user_id_key unique (github_user_id)
);

alter table public.github_identity enable row level security;

drop policy if exists github_identity_select_own on public.github_identity;
create policy github_identity_select_own on public.github_identity
  for select using (user_id = auth.uid());

revoke insert, update, delete on table public.github_identity from authenticated, anon;
grant select on table public.github_identity to authenticated;
grant all on table public.github_identity to service_role;

-- A person's last GitHub connection gone: who they are on GitHub goes with it.
create or replace function public.github_identity_on_disconnect()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.provider = 'github' and not exists (
    select 1 from public.connected_account c
    where c.user_id = old.user_id and c.provider = 'github' and c.id <> old.id
  ) then
    delete from public.github_identity where user_id = old.user_id;
  end if;
  return old;
end;
$$;

revoke all on function public.github_identity_on_disconnect() from public, anon, authenticated;

drop trigger if exists github_identity_on_disconnect on public.connected_account;
create trigger github_identity_on_disconnect
  after delete on public.connected_account
  for each row execute function public.github_identity_on_disconnect();

-- ── workspace_github_repo ─────────────────────────────────────

create table if not exists public.workspace_github_repo (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  repo_full_name text not null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- GitHub's names are case-insensitive: kept lower case, so one row per repo
  -- however it was typed, and the webhook matches it exactly.
  constraint workspace_github_repo_name check (repo_full_name ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}$'),
  constraint workspace_github_repo_unique unique (workspace_id, repo_full_name)
);

create index if not exists workspace_github_repo_by_repo
  on public.workspace_github_repo (repo_full_name);

alter table public.workspace_github_repo enable row level security;

drop policy if exists workspace_github_repo_select on public.workspace_github_repo;
create policy workspace_github_repo_select on public.workspace_github_repo
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists workspace_github_repo_insert on public.workspace_github_repo;
create policy workspace_github_repo_insert on public.workspace_github_repo
  for insert with check (
    public.get_member_role(workspace_id) in ('owner', 'admin')
    and added_by = auth.uid()
  );

drop policy if exists workspace_github_repo_delete on public.workspace_github_repo;
create policy workspace_github_repo_delete on public.workspace_github_repo
  for delete using (public.get_member_role(workspace_id) in ('owner', 'admin'));

-- No update: a repo is added or removed, never renamed in place.
revoke update on table public.workspace_github_repo from authenticated, anon;
grant select, insert, delete on table public.workspace_github_repo to authenticated;
grant all on table public.workspace_github_repo to service_role;

-- ── action_github_branch ──────────────────────────────────────

create table if not exists public.action_github_branch (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  action_id uuid not null references public.actions(id) on delete cascade,
  repo_full_name text not null,
  branch text not null,
  status_before_id uuid references public.workflow_state(id) on delete set null,
  auto_moved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint action_github_branch_unique unique (action_id, repo_full_name, branch)
);

create index if not exists action_github_branch_by_branch
  on public.action_github_branch (lower(repo_full_name), branch);

alter table public.action_github_branch enable row level security;

-- Seen exactly as its action is (the actions' and teams' own policies run in
-- the subquery: a private team's action stays its members').
drop policy if exists action_github_branch_select on public.action_github_branch;
create policy action_github_branch_select on public.action_github_branch
  for select using (
    public.is_workspace_member(workspace_id)
    and exists (select 1 from public.actions a where a.id = action_id)
  );

revoke insert, update, delete on table public.action_github_branch from authenticated, anon;
grant select on table public.action_github_branch to authenticated;
grant all on table public.action_github_branch to service_role;

-- ── action_github_pr: size, and the automation's memory ───────

alter table public.action_github_pr
  add column if not exists additions integer,
  add column if not exists deletions integer,
  add column if not exists changed_files integer,
  add column if not exists author_github_id bigint,
  add column if not exists status_before_id uuid references public.workflow_state(id) on delete set null,
  add column if not exists auto_moved_at timestamptz,
  add column if not exists auto_step text,
  add column if not exists pr_updated_at timestamptz;

alter table public.action_github_pr drop constraint if exists action_github_pr_auto_step;
alter table public.action_github_pr add constraint action_github_pr_auto_step
  check (auto_step is null or auto_step in ('begin', 'review', 'done', 'back'));

create index if not exists action_github_pr_by_pr
  on public.action_github_pr (lower(repo_full_name), pr_number);

-- A member's client links and unlinks pull requests and refreshes a title or
-- state (the existing policies), but the automation's memory and the PR's
-- author are the server's: a client can't make the automation think it moved
-- an action from somewhere else, or that a stranger is a member. The service
-- role and a database owner are not held to this. Not a definer: current_user
-- must be the caller's role.
create or replace function public.action_github_pr_client_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.author_github_id := null;
    new.status_before_id := null;
    new.auto_moved_at := null;
    new.auto_step := null;
    new.pr_updated_at := null;
    return new;
  end if;
  if new.author_github_id is distinct from old.author_github_id
     or new.status_before_id is distinct from old.status_before_id
     or new.auto_moved_at is distinct from old.auto_moved_at
     or new.auto_step is distinct from old.auto_step
     or new.pr_updated_at is distinct from old.pr_updated_at
     or new.workspace_id is distinct from old.workspace_id
     or new.action_id is distinct from old.action_id then
    raise exception 'A linked pull request keeps its action, and the automation''s record is the server''s.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists action_github_pr_client_guard on public.action_github_pr;
create trigger action_github_pr_client_guard
  before insert or update on public.action_github_pr
  for each row execute function public.action_github_pr_client_guard();

-- ── team.github_automation ────────────────────────────────────

alter table public.team
  add column if not exists github_automation boolean not null default true;

comment on column public.team.github_automation is
  'Move this team''s actions when their pull requests move (docs/plans/github-reviews.md). Writable by whoever may update the team: owners, admins and its leads.';

notify pgrst, 'reload schema';

commit;
