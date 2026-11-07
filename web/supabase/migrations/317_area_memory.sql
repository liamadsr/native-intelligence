-- Migration 317: what Dial8 has learned, a short note per area and scope
-- (docs/plans/one-agent-and-chat-pages.md, Part 3 "Memory", Phase S2).
--
-- Each expertise pack carries what the agent has learned about the person in
-- its area: "You sign off with 'Best, Liam'", "We go after Series A fintech".
-- Open question 8 settled on a note per area and scope, not claims in the
-- knowledge graph: a note is small, loads whole and is easy to edit, and
-- claims suit facts about the world, not preferences.
--
-- What lands:
--   area_memory               one row per line of a note. A note is the
--                             lines of one (workspace, area, scope[, user]).
--     scope    personal       one person, in one workspace (user_id set);
--              workspace      the whole workspace (user_id null).
--     status   active         loads with the pack;
--              proposed       waits: a workspace line a member suggested, or
--                             a line the nightly pass learned. Never loads.
--     source   told           the person said it in chat (`remember`);
--              learned        the nightly pass proposed it (server only);
--              edited         typed or changed in "What Dial8 has learned".
--     created_by / updated_by who made the line and who last changed it
--                             (null: the nightly pass).
--   area_memory_learning_run  one row per person, area and day the nightly
--                             pass looked: the day key makes the pass
--                             idempotent, signal_until is the newest signal
--                             it read (the next pass runs only past it), and
--                             proposed is what it suggested, so a dismissed
--                             line is not suggested again. Server only.
--
-- Who may do what (open question 10: anyone proposes, owners and admins
-- accept), held here so no route can get it wrong:
--   personal lines   seen and written only by their own user, a member of
--                    the workspace;
--   workspace lines  read by every member. Only an owner or admin adds an
--                    active line, edits, accepts or deletes one. Any member
--                    may add a PROPOSED line, and withdraw their own proposal.
-- The policies decide which rows; area_memory_guard decides what a row may
-- say (identity never moves, `learned` is the server's, an accepted line
-- never goes back to waiting). Trusted callers skip the guard: the service
-- role, or no request at all (migrations, cron), as in 305 and 306. The
-- chat's `remember` tool runs on the service role and applies the same rules
-- itself (src/lib/packs/memory-write.ts).
--
-- The area list is AREA_KEYS in src/lib/packs/registry.ts, as in 316;
-- src/lib/packs/__tests__/migration-317.test.ts keeps them equal.
--
-- Idempotent: create if not exists, drop policy if exists, create or replace.

SET LOCAL lock_timeout = '5s';

create table if not exists public.area_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  area text not null check (
    area in ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library')
  ),
  scope text not null check (scope in ('personal', 'workspace')),
  user_id uuid references auth.users(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 300),
  status text not null default 'active' check (status in ('active', 'proposed')),
  source text not null check (source in ('told', 'learned', 'edited')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A personal line belongs to one user; a workspace line to nobody in particular.
  constraint area_memory_scope_owner check ((scope = 'personal') = (user_id is not null))
);

comment on table public.area_memory is
  'What Dial8 has learned (317): one line of a short note per area and scope (personal: one user in one workspace; workspace: everyone). Active lines load with the area''s expertise pack.';

-- The pack load: one workspace's active lines in some areas, the newest first.
create index if not exists area_memory_load_idx
  on public.area_memory (workspace_id, area, status, updated_at desc);
create index if not exists area_memory_user_idx
  on public.area_memory (user_id) where user_id is not null;

alter table public.area_memory enable row level security;

drop policy if exists "area_memory_select" on public.area_memory;
create policy "area_memory_select"
  on public.area_memory for select
  to authenticated
  using (
    (scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
    or (scope = 'workspace' and public.is_workspace_member(workspace_id))
  );

drop policy if exists "area_memory_insert" on public.area_memory;
create policy "area_memory_insert"
  on public.area_memory for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (
      (scope = 'personal' and user_id = (select auth.uid()))
      or (
        scope = 'workspace'
        and (status = 'proposed' or public.get_member_role(workspace_id) in ('owner', 'admin'))
      )
    )
  );

drop policy if exists "area_memory_update" on public.area_memory;
create policy "area_memory_update"
  on public.area_memory for update
  to authenticated
  using (
    (scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
    or (scope = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
  )
  with check (
    (scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
    or (scope = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
  );

drop policy if exists "area_memory_delete" on public.area_memory;
create policy "area_memory_delete"
  on public.area_memory for delete
  to authenticated
  using (
    (scope = 'personal' and user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
    or (scope = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
    -- A member withdraws their own proposal (the chip's Undo).
    or (
      scope = 'workspace'
      and status = 'proposed'
      and created_by = (select auth.uid())
      and public.is_workspace_member(workspace_id)
    )
  );

create or replace function public.area_memory_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The server: the service role, or no request at all.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Lines a person adds are theirs, told or typed. Learning is the server's.
    if new.created_by is distinct from auth.uid() or new.source = 'learned' then
      raise exception 'A line you add is yours (created_by), told or edited, never learned'
        using errcode = 'insufficient_privilege';
    end if;
    new.updated_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- A line never moves to another workspace, area, scope or person, and keeps
  -- who made it and when.
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.area is distinct from old.area
     or new.scope is distinct from old.scope
     or new.user_id is distinct from old.user_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'A memory line cannot move or change who made it: delete it and add a new one'
      using errcode = 'insufficient_privilege';
  end if;

  -- An accepted line can't go back to waiting, and a person's change is an edit.
  if old.status = 'active' and new.status = 'proposed' then
    raise exception 'An active memory line cannot go back to proposed'
      using errcode = 'check_violation';
  end if;
  if new.source is distinct from old.source and new.source <> 'edited' then
    raise exception 'A changed memory line is edited, never told or learned'
      using errcode = 'insufficient_privilege';
  end if;

  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.area_memory_guard() is
  'BEFORE INSERT OR UPDATE on area_memory (317). Unless the caller is the service role or has no request context: a new line is the caller''s (created_by) and never learned; a line never moves workspace, area, scope or user, keeps created_by/created_at, never goes from active back to proposed, and a changed source can only become edited.';

drop trigger if exists area_memory_guard on public.area_memory;
create trigger area_memory_guard
  before insert or update on public.area_memory
  for each row execute function public.area_memory_guard();

-- A trigger function, never called directly.
revoke execute on function public.area_memory_guard() from public, anon, authenticated;

-- ── The nightly pass's log ──────────────────────────────────────────────────

create table if not exists public.area_memory_learning_run (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  area text not null check (
    area in ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library')
  ),
  run_date date not null,
  -- The newest signal this pass read (a sent email's date): the next pass runs only past it.
  signal_until timestamptz,
  -- What it proposed, so a dismissed line is not proposed again.
  proposed text[] not null default '{}',
  outcome text not null default 'claimed' check (outcome in ('claimed', 'proposed', 'nothing', 'failed')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, area, run_date)
);

comment on table public.area_memory_learning_run is
  'The nightly memory pass (317): one row per person, area and day it looked. Idempotent per day; signal_until gates the next pass on new signal. Server only.';

alter table public.area_memory_learning_run enable row level security;
-- No policies: only the server (service role) reads or writes it.
revoke all on table public.area_memory_learning_run from anon, authenticated;
