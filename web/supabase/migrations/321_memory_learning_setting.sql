-- Migration 321: whether the nightly memory pass learns from a person's mail,
-- their own switch in Settings → Memory (docs/plans/one-agent-and-chat-pages.md,
-- Part 3 "Memory"). It replaces the MEMORY_LEARNING_ENABLED env flag.
--
-- The pass (src/lib/packs/memory-learning.ts) reads a person's recent sent mail
-- with a model and proposes what it learned in What Dial8 has learned. It runs
-- per person and workspace, so the switch is too, and it is off until they turn
-- it on: no row, or learn_from_mail false, means the pass never looks.
--
-- A person reads and writes only their own row, in a workspace they belong to.
-- The row goes with their membership (removed, or left), so rejoining starts
-- off again. The cron reads opted-in rows on the service role.
--
-- Idempotent: create if not exists, drop policy if exists.

SET LOCAL lock_timeout = '5s';

create table if not exists public.memory_learning_setting (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  learn_from_mail boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint memory_learning_setting_member_fkey
    foreign key (user_id, workspace_id) references public.member (user_id, workspace_id) on delete cascade
);

-- The cron's read: who has it on.
create index if not exists memory_learning_setting_on_idx
  on public.memory_learning_setting (workspace_id, user_id) where learn_from_mail;

alter table public.memory_learning_setting enable row level security;

drop policy if exists "memory_learning_setting_select" on public.memory_learning_setting;
create policy "memory_learning_setting_select"
  on public.memory_learning_setting for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "memory_learning_setting_insert" on public.memory_learning_setting;
create policy "memory_learning_setting_insert"
  on public.memory_learning_setting for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "memory_learning_setting_update" on public.memory_learning_setting;
create policy "memory_learning_setting_update"
  on public.memory_learning_setting for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on table public.memory_learning_setting from anon;
