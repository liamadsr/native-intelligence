-- 141_user_onboarding_demo_seed.sql
--
-- A per-USER (not per-workspace) onboarding record, so we can gate the
-- "demo capture" fixture to once-ever-per-user.
--
-- WHY a new table: all existing onboarding state lives on `member`
-- (onboarding_completed_at / onboarding_progress), which is UNIQUE(user_id,
-- workspace_id) — i.e. strictly per-workspace. A returning user who creates a
-- second workspace gets a brand-new member row with empty onboarding state, so
-- `member` cannot answer "has this PERSON seen the demo before?". This table is
-- keyed by user_id alone and survives any number of workspaces.
--
-- It deliberately holds only user-level, workspace-independent onboarding facts.
-- Today that's just `demo_seeded_at` (when we seeded their one demo capture).

create table if not exists public.user_onboarding (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  -- Set the first time we seed the demo capture for this user. Non-null = the
  -- user has already had their demo, so never seed again (incl. on new
  -- workspaces). Nullable so "never seeded" is representable.
  demo_seeded_at timestamptz,
  -- The workspace the demo was seeded into + the capture id, so teardown can
  -- find and remove it later without a metadata scan. Nullable: cleared on
  -- teardown (we keep demo_seeded_at set so it never re-seeds).
  demo_workspace_id uuid,
  demo_capture_id   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.user_onboarding is
  'Per-user (workspace-independent) onboarding state. Gates the once-ever demo capture fixture.';

-- RLS: a user sees and writes only their own row. All demo seeding/teardown
-- runs server-side under the user''s session, so these policies are sufficient;
-- service-role paths bypass RLS anyway.
alter table public.user_onboarding enable row level security;

drop policy if exists "user_onboarding_select_own" on public.user_onboarding;
create policy "user_onboarding_select_own"
  on public.user_onboarding for select
  using (auth.uid() = user_id);

drop policy if exists "user_onboarding_insert_own" on public.user_onboarding;
create policy "user_onboarding_insert_own"
  on public.user_onboarding for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_onboarding_update_own" on public.user_onboarding;
create policy "user_onboarding_update_own"
  on public.user_onboarding for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- keep updated_at fresh
create or replace function public.touch_user_onboarding_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_onboarding_updated_at on public.user_onboarding;
create trigger trg_user_onboarding_updated_at
  before update on public.user_onboarding
  for each row execute function public.touch_user_onboarding_updated_at();
