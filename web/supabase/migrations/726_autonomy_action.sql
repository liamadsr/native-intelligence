-- ============================================================
-- 726: earned autonomy, phase 3 (docs/plans/earned-autonomy.md §5): the
-- audit trail of every action the agent took on its own.
-- ============================================================
-- NUMBER: 726 was assigned by the managing session (11-27), with 725 (this
-- branch's phase 1). Re-list main's migrations before merging, and renumber
-- (the file, this line, src/lib/autonomy/__tests__/migration-726.test.ts) if
-- main took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- ORDER: after 725, and before EARNED_AUTONOMY=graduate is set on the
-- server. Without this table a granted kind's call simply stays a card (the
-- scheduling write fails, and the hold falls back to asking).
--
-- Additive only: one new table, its indexes and RLS. Nothing existing
-- changes.
--
--   autonomy_action    one row per held call a granted kind runs on its own
--                      (Liam, 11-27, decision 1: the person's yes to "handle
--                      this kind yourself" is their final yes, with a
--                      5-minute undo window before each send; amends 10-26's
--                      "nothing reaches another person without the person's
--                      final yes"). Its approval (tool_approval, one each),
--                      its card, the kind, the level, who it reaches, when
--                      it runs (run_at, the end of the undo window), and how
--                      it ended: scheduled -> running -> ran | failed, or
--                      cancelled (a re-check sent it back to a card) or
--                      undone (the person stopped it in its window). The
--                      owner reads their own; only the service role writes.
--
-- Its key (approval_id) holds no workspace_id: a workspace merge just moves
-- its rows.
--
-- This file holds no backslash anywhere.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.autonomy_action (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  approval_id uuid not null references public.tool_approval(id) on delete cascade,
  card_id uuid,
  kind_key text not null check (char_length(kind_key) between 3 and 400),
  tool text not null check (char_length(tool) between 1 and 200),
  level text not null check (level in ('tell', 'quiet')),
  status text not null default 'scheduled' check (status in ('scheduled', 'running', 'ran', 'failed', 'cancelled', 'undone')),
  reason text check (reason is null or char_length(reason) <= 500),
  title text check (title is null or char_length(title) <= 500),
  recipients text[] not null default '{}',
  run_at timestamptz not null,
  ran_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.autonomy_action is
  'Earned autonomy''s audit trail (726, docs/plans/earned-autonomy.md): one row per held call a granted kind ran (or was going to run) on its own, after its undo window. Written only by the service role; the owner reads their own.';

create unique index if not exists autonomy_action_approval_key on public.autonomy_action (approval_id);
create index if not exists autonomy_action_owner_idx on public.autonomy_action (user_id, workspace_id, created_at desc);
create index if not exists autonomy_action_scheduled_idx on public.autonomy_action (run_at) where status = 'scheduled';

alter table public.autonomy_action enable row level security;

drop policy if exists autonomy_action_select_own on public.autonomy_action;
create policy autonomy_action_select_own on public.autonomy_action
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on table public.autonomy_action from public, anon, authenticated;
grant select on table public.autonomy_action to authenticated;
grant all on table public.autonomy_action to service_role;

notify pgrst, 'reload schema';

commit;
