-- ============================================================
-- 723: earned autonomy, phase 1 (docs/plans/earned-autonomy.md §8): the
-- track record per kind of work, and the person's decisions on each kind.
-- ============================================================
-- NUMBER: 723 is the first free number after main's newest (722) when this
-- was written. Re-list main's migrations before merging, and renumber (the
-- file, this line, src/lib/autonomy/__tests__/migration-723.test.ts) if main
-- took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- ORDER: either order. The code writes these tables only while
-- EARNED_AUTONOMY is set (empty is off), and a write that fails (the tables
-- not there yet) is logged and dropped: an approval never waits on it.
-- Applying it early is harmless: both tables start empty.
--
-- Additive only: two new tables, their indexes, RLS, one merge-fold trigger.
-- Nothing existing changes. Nothing here lets anything run without a card:
-- phase 1 only records (Liam, 11-27, roadmap #14: "The agent takes over
-- recurring work as it earns your trust"; nothing graduates silently).
--
--   autonomy_outcome   one row per settled card (and, from phase 3, per
--                      autonomous action): who (user_id, the approver), the
--                      kind (kind_key = tool|channel|audience, computed by
--                      code from the stored call, never from model text), the
--                      outcome, and edit_ratio for an approval after edits.
--                      Unique per (source, source_id, outcome): a retry never
--                      counts twice. The owner reads their own; only the
--                      service role writes.
--   autonomy_kind      one row per person, workspace and kind for the
--                      person's own decisions: level (ask | tell | quiet,
--                      default ask), pinned_ask ("Never"), granted_at,
--                      granted_card_id, demoted_at, offered_at,
--                      offer_declined_at. Nothing writes it in phase 1. The
--                      owner reads their own; only the service role writes
--                      (from the person's own click, from phase 2).
--
-- Workspace merge (402/707): autonomy_kind's key holds workspace_id, so the
-- moving row folds into the person's row for the same kind there, keeping
-- the SAFER of the two (the lower level, "Never" if either said it).
-- autonomy_outcome's key does not hold workspace_id (its rows just move).
--
-- This file holds no backslash anywhere.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.autonomy_outcome (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind_key text not null check (char_length(kind_key) between 3 and 400),
  tool text not null check (char_length(tool) between 1 and 200),
  channel text not null check (channel in ('email', 'text', 'calendar', 'customer', 'link', 'native', 'app', 'unknown')),
  audience text not null check (audience in ('none', 'one', 'few', 'many')),
  source text not null check (source in ('tool_approval', 'autonomy_action')),
  source_id uuid not null,
  outcome text not null check (outcome in ('approved', 'approved_edited', 'dismissed', 'expired', 'failed', 'ran', 'undone', 'complaint')),
  edit_ratio numeric check (edit_ratio is null or (edit_ratio >= 0 and edit_ratio <= 1)),
  created_at timestamptz not null default now()
);

comment on table public.autonomy_outcome is
  'Earned autonomy''s track record (723, docs/plans/earned-autonomy.md): one row per settled card or autonomous action, per person and kind. Written only by the service role; the owner reads their own.';

create unique index if not exists autonomy_outcome_source_key on public.autonomy_outcome (source, source_id, outcome);
create index if not exists autonomy_outcome_owner_kind_idx on public.autonomy_outcome (user_id, workspace_id, kind_key, created_at desc);

alter table public.autonomy_outcome enable row level security;

drop policy if exists autonomy_outcome_select_own on public.autonomy_outcome;
create policy autonomy_outcome_select_own on public.autonomy_outcome
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on table public.autonomy_outcome from public, anon, authenticated;
grant select on table public.autonomy_outcome to authenticated;
grant all on table public.autonomy_outcome to service_role;

create table if not exists public.autonomy_kind (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind_key text not null check (char_length(kind_key) between 3 and 400),
  level text not null default 'ask' check (level in ('ask', 'tell', 'quiet')),
  pinned_ask boolean not null default false,
  granted_at timestamptz,
  granted_card_id uuid,
  demoted_at timestamptz,
  offered_at timestamptz,
  offer_declined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.autonomy_kind is
  'Earned autonomy (723, docs/plans/earned-autonomy.md): the person''s own decisions on one kind of work (its level, Never, when granted or demoted). Written only by the service role from the person''s own click; the owner reads their own.';

create unique index if not exists autonomy_kind_owner_key on public.autonomy_kind (workspace_id, user_id, kind_key);

alter table public.autonomy_kind enable row level security;

drop policy if exists autonomy_kind_select_own on public.autonomy_kind;
create policy autonomy_kind_select_own on public.autonomy_kind
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on table public.autonomy_kind from public, anon, authenticated;
grant select on table public.autonomy_kind to authenticated;
grant all on table public.autonomy_kind to service_role;

-- During a workspace merge, the moving row folds into the person's row for the
-- same kind there: the lower level wins, and "Never" if either said it.
create or replace function public.autonomy_kind_merge_fold()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.autonomy_kind%rowtype;
begin
  if new.workspace_id is distinct from old.workspace_id and public._wsmerge_active() then
    select * into d from public.autonomy_kind
     where workspace_id = new.workspace_id and user_id = new.user_id and kind_key = new.kind_key and id <> old.id;
    if found then
      new.pinned_ask := new.pinned_ask or d.pinned_ask;
      if d.level = 'ask' or new.level = 'ask' then
        new.level := 'ask';
      elsif d.level = 'tell' or new.level = 'tell' then
        new.level := 'tell';
      end if;
      delete from public.autonomy_kind where id = d.id;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.autonomy_kind_merge_fold() from public, anon, authenticated;

drop trigger if exists autonomy_kind_merge_fold on public.autonomy_kind;
create trigger autonomy_kind_merge_fold
  before update of workspace_id on public.autonomy_kind
  for each row execute function public.autonomy_kind_merge_fold();

notify pgrst, 'reload schema';

commit;
