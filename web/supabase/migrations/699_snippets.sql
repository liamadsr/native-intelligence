-- ============================================================
-- 699: snippets, saved text typed in with `;`.
-- ============================================================
-- Why: a person saves pieces of text they write again and again (a signature,
-- a standard answer), gives each a short word, and types `;` and a few letters
-- in any editor to put one in (docs/plans/snippets.md). Personal, or shared
-- with the workspace.
--
-- No begin/commit of its own: applied with --single-transaction, as the other
-- migrations are.
--
-- What lands, all of it new (no existing table, policy, function, constraint
-- or trigger is restated or changed):
--   snippet                  one row a snippet. created_by is the maker's
--                            member row (current_member_id, as 675). body is
--                            markdown, as documents store it.
--   snippet_before_write     the guard for a client's own token (359, 369, 675).
--   snippet_drop_orphan      a personal snippet goes with its maker.
--   policies                 select / insert / update / delete, authenticated.
--
-- Who sees and changes what:
--   - a member reads the workspace's shared snippets and their own personal
--     ones; nobody else's personal one, ever (not owners, not admins);
--   - a member makes snippets as themself;
--   - a snippet is changed or deleted by its maker; a shared one also by the
--     workspace's owner or an admin; only its maker changes who sees it.
-- No entity_access grants: a snippet is never shared one by one, never in
-- search, mentions or the graph. Nothing here widens who sees any record.
--
-- When a member leaves (their member row is deleted): created_by is set null
-- (on delete set null, as 675's created_by). Their personal snippets are then
-- deleted by snippet_drop_orphan; their shared ones stay, managed by the
-- workspace's owners and admins. The referential action's UPDATE runs as the
-- table owner, not as a client, so the guard below never refuses it, and the
-- guard never puts created_by back.

create table if not exists public.snippet (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  created_by uuid references public.member(id) on delete set null,
  name text not null,
  shortcut text not null,
  body text not null,
  visibility text not null default 'personal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint snippet_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint snippet_shortcut_format check (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  constraint snippet_body_length check (char_length(body) between 1 and 20000),
  constraint snippet_visibility_check check (visibility in ('personal', 'workspace'))
);

comment on table public.snippet is
  'Saved text typed in with ; and its shortcut (docs/plans/snippets.md, 699). Personal (its maker only) or shared with the workspace.';

-- A shortcut is unique among the workspace's shared snippets, and among each
-- person's own. A personal and a shared one may share a word. (The app turns
-- a clash into words: "You already have a snippet ;intro.")
create unique index if not exists snippet_shared_shortcut_key
  on public.snippet (workspace_id, shortcut) where visibility = 'workspace';
create unique index if not exists snippet_personal_shortcut_key
  on public.snippet (workspace_id, created_by, shortcut) where visibility = 'personal';
create index if not exists snippet_workspace_idx on public.snippet (workspace_id);
create index if not exists snippet_created_by_idx on public.snippet (created_by);

-- ── The guard ───────────────────────────────────────────────────────────────
-- The update policy alone would let an admin editing a shared snippet write
-- created_by = themself, or visibility = 'personal', and take it from
-- everyone. So for a client (authenticated, anon):
--   - who made it never changes;
--   - only its maker changes who sees it.
-- For everyone: the workspace and created_at never change, updated_at is now.
-- The service role (the agent's tools, which check the person first), the
-- table owner (a referential action: a member leaving sets created_by null)
-- and a database owner are not held to the client rules, and nothing here
-- rewrites created_by, so removing a member never fails on it. Not a definer:
-- current_user must be the caller's role.
create or replace function public.snippet_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    new.workspace_id := old.workspace_id;
    new.created_at := old.created_at;
    if current_user in ('authenticated', 'anon') then
      if new.created_by is distinct from old.created_by then
        raise exception 'Who made a snippet cannot be changed.' using errcode = '42501';
      end if;
      if new.visibility is distinct from old.visibility
         and (old.created_by is null or old.created_by is distinct from public.current_member_id(old.workspace_id)) then
        raise exception 'Only the person who made a snippet changes who sees it.' using errcode = '42501';
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists snippet_before_write on public.snippet;
create trigger snippet_before_write
  before insert or update on public.snippet
  for each row execute function public.snippet_before_write();

-- A personal snippet whose maker left (created_by set null by the member
-- row's deletion) is nobody's: it goes. A definer, so it deletes whatever role
-- set it null; it deletes only that one row, and only when it is personal and
-- makerless.
create or replace function public.snippet_drop_orphan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.snippet
   where id = new.id
     and created_by is null
     and visibility = 'personal';
  return null;
end;
$$;

revoke all on function public.snippet_drop_orphan() from public, anon, authenticated;

drop trigger if exists snippet_drop_orphan on public.snippet;
create trigger snippet_drop_orphan
  after update of created_by on public.snippet
  for each row
  when (new.created_by is null and old.created_by is not null and new.visibility = 'personal')
  execute function public.snippet_drop_orphan();

-- ── Who reads and writes ────────────────────────────────────────────────────

alter table public.snippet enable row level security;

revoke all on table public.snippet from anon;
grant select, insert, update, delete on table public.snippet to authenticated;
grant all on table public.snippet to service_role;

-- A member reads the workspace's shared snippets and their own.
drop policy if exists snippet_select on public.snippet;
create policy snippet_select on public.snippet
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))
  );

-- Made as oneself.
drop policy if exists snippet_insert on public.snippet;
create policy snippet_insert on public.snippet
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by is not null
    and created_by = public.current_member_id(workspace_id)
  );

-- Its maker; a shared one also an owner or an admin. Afterwards the row must
-- still be one they could change (an admin cannot make a shared snippet their
-- own personal one: the guard refuses the visibility change besides).
drop policy if exists snippet_update on public.snippet;
create policy snippet_update on public.snippet
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = public.current_member_id(workspace_id)
      or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
    )
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (
      created_by = public.current_member_id(workspace_id)
      or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
    )
  );

drop policy if exists snippet_delete on public.snippet;
create policy snippet_delete on public.snippet
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = public.current_member_id(workspace_id)
      or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
    )
  );

notify pgrst, 'reload schema';
