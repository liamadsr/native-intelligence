-- Extend connected_account to support GitHub as a provider and capability
alter table connected_account drop constraint if exists connected_account_provider_check;
alter table connected_account add constraint connected_account_provider_check
  check (provider in ('google', 'microsoft', 'github'));

alter table connected_account drop constraint if exists connected_account_capability_check;
alter table connected_account add constraint connected_account_capability_check
  check (capability in ('calendar', 'email', 'github'));

-- GitHub PR ↔ Action linking table
-- Tracks pull requests linked to action items, with status sync via webhooks.

create table action_github_pr (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  action_id uuid not null references actions(id) on delete cascade,
  pr_url text not null,
  repo_full_name text not null,        -- e.g. "acme/myapp"
  pr_number int not null,
  pr_title text,
  pr_state text not null default 'open',  -- open, closed, merged
  pr_draft boolean not null default false,
  checks_status text,                  -- pending, success, failure
  head_branch text,                    -- branch name
  created_by uuid references auth.users(id),
  linked_at timestamptz not null default now(),
  last_synced_at timestamptz,
  unique(action_id, repo_full_name, pr_number)
);

alter table action_github_pr enable row level security;

create policy "workspace members can view linked PRs"
  on action_github_pr for select
  using (is_workspace_member(workspace_id));

create policy "workspace members can link PRs"
  on action_github_pr for insert
  with check (is_workspace_member(workspace_id));

create policy "workspace members can update PR status"
  on action_github_pr for update
  using (is_workspace_member(workspace_id));

create policy "workspace members can unlink PRs"
  on action_github_pr for delete
  using (is_workspace_member(workspace_id));

create index idx_action_github_pr_action_id on action_github_pr(action_id);
create index idx_action_github_pr_workspace_id on action_github_pr(workspace_id);
create index idx_action_github_pr_repo on action_github_pr(repo_full_name);
