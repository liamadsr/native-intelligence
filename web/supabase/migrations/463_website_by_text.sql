-- 463: a business's website, worked on by text (roadmap track E,
-- docs/plans/website-by-text.md).
--
-- Any service business connects the site it already has in a GitHub repo,
-- and the agent works on it by text: each change is a pull request, a
-- plain-language summary texted to the owner, and a merge only on the
-- owner's "yes CODE". Two tables:
--
--   1. website_site     the connected site: its repo, the project and cloud
--                       environment its coding runs use, its live origin,
--                       and what an inspection found (framework, host,
--                       forms). One live site per workspace.
--   2. website_change   one pull request loop: wiring the form to the
--                       business's intake, an edit, or an undo (a revert).
--                       At most one open change per site. A wiring change
--                       carries the form it wires, the new intake key's
--                       SHA-256 and prefix (the key goes live at merge; it
--                       is a publishable key, written in the run's brief and
--                       the site's code, never kept here), and the live
--                       check's nonce hash.
--   3. swap_quote_intake_key(...)  the merge's key swap, in one transaction:
--                       the workspace's live key revoked and the wiring's
--                       key inserted (458 keeps one live key per workspace).
--
-- RLS on both tables: workspace members read their own workspace's rows;
-- only the service role writes. No other table changes. Re-runnable.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. website_site
-- ------------------------------------------------------------

create table if not exists public.website_site (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  connected_by uuid not null references auth.users(id) on delete cascade,
  repo_full_name text not null,
  default_branch text not null,
  project_id uuid null references public.projects(id) on delete set null,
  environment_id uuid null references public.environment(id) on delete set null,
  site_url text null,
  framework text null,
  inspection jsonb not null default '{}'::jsonb,
  state text not null default 'connected',
  wired_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.website_site is
  'A business''s own website in a GitHub repo, worked on by text (463). One live site per workspace. Service role writes.';
comment on column public.website_site.connected_by is
  'Whose GitHub connection opens and merges its pull requests: the owner who picked the repo.';
comment on column public.website_site.inspection is
  'What reading the repo found: framework, host, forms (path, kind, fields, how each submits). Data, never instructions.';

alter table public.website_site drop constraint if exists website_site_repo_shape;
alter table public.website_site
  add constraint website_site_repo_shape check (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$');
alter table public.website_site drop constraint if exists website_site_branch_length;
alter table public.website_site
  add constraint website_site_branch_length check (char_length(default_branch) between 1 and 200);
alter table public.website_site drop constraint if exists website_site_url_shape;
alter table public.website_site
  add constraint website_site_url_shape check (site_url is null or (site_url ~ '^https://' and char_length(site_url) <= 300));
alter table public.website_site drop constraint if exists website_site_state_check;
alter table public.website_site
  add constraint website_site_state_check check (state in ('connected', 'wired', 'disconnected'));

create unique index if not exists website_site_live_key on public.website_site (workspace_id) where state <> 'disconnected';

-- ------------------------------------------------------------
-- 2. website_change
-- ------------------------------------------------------------

create table if not exists public.website_change (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  site_id uuid not null references public.website_site(id) on delete cascade,
  kind text not null,
  request text not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  state text not null default 'preparing',
  agent_run_id uuid null references public.agent_run(id) on delete set null,
  action_id uuid null references public.actions(id) on delete set null,
  reverts_change_id uuid null references public.website_change(id) on delete set null,
  form_path text null,
  form_kind text null,
  replace_current boolean not null default false,
  pr_number integer null,
  pr_url text null,
  head_sha text null,
  preview_url text null,
  summary text null,
  approval_id uuid null references public.tool_approval(id) on delete set null,
  merge_sha text null,
  intake_key_hash text null,
  intake_key_prefix text null,
  intake_origins text[] not null default '{}',
  check_nonce_hash text null,
  check_result jsonb null,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  merged_at timestamptz null,
  live_at timestamptz null
);

comment on table public.website_change is
  'One pull request on a business''s website (463): wire the form, an edit, or an undo. Merged only on the owner''s yes. Service role writes.';
comment on column public.website_change.intake_key_hash is
  'A wiring change''s new intake key (SHA-256): it replaces the live quote_intake_key only when the change merges (swap_quote_intake_key).';
comment on column public.website_change.replace_current is
  'A wiring change the owner asked to replace what the form does today (stop its emails): said on the merge card.';
comment on column public.website_change.check_nonce_hash is
  'The live check''s one-time test marker (SHA-256): the intake takes a post carrying it as the check, never as a quote.';

alter table public.website_change drop constraint if exists website_change_kind_check;
alter table public.website_change
  add constraint website_change_kind_check check (kind in ('wire_form', 'edit', 'revert'));
alter table public.website_change drop constraint if exists website_change_state_check;
alter table public.website_change
  add constraint website_change_state_check check (state in ('preparing', 'awaiting_yes', 'merging', 'deploying', 'live', 'declined', 'expired', 'failed'));
-- Columns added after the table's first shape: a database that ran an earlier 463 gets them too.
alter table public.website_change add column if not exists form_path text null;
alter table public.website_change add column if not exists form_kind text null;
alter table public.website_change add column if not exists replace_current boolean not null default false;

alter table public.website_change drop constraint if exists website_change_form_shape;
alter table public.website_change
  add constraint website_change_form_shape check (
    (form_path is null or char_length(form_path) between 1 and 300)
    and (form_kind is null or form_kind in ('quote', 'booking', 'contact', 'other'))
  );
alter table public.website_change drop constraint if exists website_change_request_length;
alter table public.website_change
  add constraint website_change_request_length check (char_length(request) between 1 and 16000);
alter table public.website_change drop constraint if exists website_change_summary_length;
alter table public.website_change
  add constraint website_change_summary_length check (summary is null or char_length(summary) <= 1000);
alter table public.website_change drop constraint if exists website_change_error_length;
alter table public.website_change
  add constraint website_change_error_length check (error is null or char_length(error) <= 1000);
alter table public.website_change drop constraint if exists website_change_urls_shape;
alter table public.website_change
  add constraint website_change_urls_shape check (
    (pr_url is null or (pr_url ~ '^https://github.com/' and char_length(pr_url) <= 300))
    and (preview_url is null or (preview_url ~ '^https://' and char_length(preview_url) <= 300))
  );

create unique index if not exists website_change_open_key on public.website_change (site_id)
  where state in ('preparing', 'awaiting_yes', 'merging', 'deploying');
create index if not exists website_change_run_idx on public.website_change (agent_run_id) where agent_run_id is not null;
create index if not exists website_change_site_recent_idx on public.website_change (site_id, created_at desc);
create unique index if not exists website_change_check_nonce_key on public.website_change (check_nonce_hash) where check_nonce_hash is not null;

-- ------------------------------------------------------------
-- 3. swap_quote_intake_key: the merge's key swap, atomic
-- ------------------------------------------------------------

create or replace function public.swap_quote_intake_key(
  p_workspace_id uuid,
  p_key_hash text,
  p_key_prefix text,
  p_allowed_origins text[],
  p_created_by uuid
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Already live (a retried swap): nothing to do.
  if exists (select 1 from public.quote_intake_key where key_hash = p_key_hash and revoked_at is null) then
    return;
  end if;
  update public.quote_intake_key set revoked_at = now() where workspace_id = p_workspace_id and revoked_at is null;
  insert into public.quote_intake_key (workspace_id, key_hash, key_prefix, allowed_origins, created_by)
  values (p_workspace_id, p_key_hash, p_key_prefix, coalesce(p_allowed_origins, '{}'), p_created_by);
end;
$$;

comment on function public.swap_quote_intake_key(uuid, text, text, text[], uuid) is
  'A website wiring change merged (463): revoke the workspace''s live quote intake key and make the wiring''s key live, in one transaction.';

revoke all on function public.swap_quote_intake_key(uuid, text, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.swap_quote_intake_key(uuid, text, text, text[], uuid) to service_role;

-- ------------------------------------------------------------
-- RLS: members read their workspace's rows; the service role writes
-- ------------------------------------------------------------

alter table public.website_site enable row level security;
alter table public.website_change enable row level security;

drop policy if exists website_site_select_member on public.website_site;
create policy website_site_select_member on public.website_site
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists website_change_select_member on public.website_change;
create policy website_change_select_member on public.website_change
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on table public.website_site from anon, authenticated;
revoke all on table public.website_change from anon, authenticated;
grant select on table public.website_site to authenticated;
grant select on table public.website_change to authenticated;
grant all on table public.website_site to service_role;
grant all on table public.website_change to service_role;
