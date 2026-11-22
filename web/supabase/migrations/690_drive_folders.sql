-- ============================================================
-- 690: Drive folders.
-- ============================================================
-- Why: the Create flow's "Create in <name>" (docs/plans/create-everything.md,
-- "Drive folders") had no folder to name: the app had no folder record. This
-- is the smallest one that works: a folder, and where a Drive record sits.
--
-- What lands, all of it new (no existing table, policy, function, constraint
-- or trigger is touched):
--   drive_folder        one row a folder: its workspace, its name, the folder
--                       it sits in (none: the top of Drive) and who made it.
--                       Every member but a guest sees and uses a workspace's
--                       folders: there are no private folders (a private
--                       record stays private inside one, see below).
--   drive_folder_item   which folder a Drive record sits in: a doc
--                       (document), a table (data_table), a spreadsheet or a
--                       canvas. One folder a record at most (its primary key
--                       is the record). A link table, not a column on each
--                       record's table, so no record's own rules (359, 369,
--                       520, 675, 676) are restated, and filing a record
--                       needs only that its filer can read it, not edit it.
--
-- The guards, in the 359/369/675 style (a before-write trigger, not a
-- definer; the service role and a database owner are not held to them):
--   drive_folder        its workspace, its maker and when it was made never
--                       change; a client's new folder is made as themself; a
--                       folder's parent is a folder of the same workspace
--                       that the caller can read, and never itself or one of
--                       its own subfolders (no cycle).
--   drive_folder_item   its workspace is always its folder's; a client files
--                       only a record they can read, of that workspace (read
--                       under their own row security), and as themself; a
--                       move changes the folder alone.
--
-- Who does what (row security on both tables, guests left out of all of it):
--   a folder            a member reads, makes (as themself), renames and
--                       moves it; its maker, or an owner or admin, deletes
--                       it. Deleting one deletes its subfolders, and the
--                       records in them are unfiled, never deleted.
--   a record's place    a member reads the rows (an id and a folder, never
--                       the record: a list joins the records under the
--                       reader's own row security, so a private record shows
--                       to no one else), files and moves a record they can
--                       read, and unfiles one.
--
-- A record deleted for good leaves its row behind until its folder goes: no
-- trigger is added to the records' tables. Lists skip a row whose record they
-- cannot read, so it shows nowhere.
--
-- No realtime publication. Re-runnable. Its own transaction (begin ...
-- commit), so it is all or nothing however it is applied. No backslashes
-- anywhere in this file.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Folders ──────────────────────────────────────────────────────────────

create table if not exists public.drive_folder (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  parent_id uuid references public.drive_folder(id) on delete cascade,
  created_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_folder_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint drive_folder_not_own_parent check (parent_id is distinct from id)
);

create index if not exists drive_folder_workspace_parent_idx
  on public.drive_folder (workspace_id, parent_id);

-- Is the caller a member of this workspace, other than a guest? (Definer, so
-- it reads the member row whatever member's own policies say; it answers only
-- for the caller.)
create or replace function public.drive_folder_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.member m
     where m.workspace_id = p_workspace_id
       and m.user_id = auth.uid()
       and m.role is distinct from 'guest'
  );
$$;

revoke all on function public.drive_folder_member(uuid) from public, anon;
grant execute on function public.drive_folder_member(uuid) to authenticated, service_role;

-- Before a write: the guard (see the header). Not a definer: current_user
-- must be the caller's role, and the parent is looked up under their own row
-- security.
create or replace function public.drive_folder_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_parent_ws uuid;
  v_at uuid;
  v_depth integer := 0;
begin
  if tg_op = 'UPDATE' then
    new.workspace_id := old.workspace_id;
    new.created_at := old.created_at;
    if current_user in ('authenticated', 'anon') and new.created_by is distinct from old.created_by then
      raise exception 'Who made a folder cannot be changed.' using errcode = '42501';
    end if;
  elsif current_user in ('authenticated', 'anon') then
    if new.created_by is distinct from public.current_member_id(new.workspace_id) or new.created_by is null then
      raise exception 'A folder is made as oneself.' using errcode = '42501';
    end if;
  end if;

  new.name := btrim(new.name);

  if new.parent_id is not null
     and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    select f.workspace_id into v_parent_ws from public.drive_folder f where f.id = new.parent_id;
    if v_parent_ws is null or v_parent_ws <> new.workspace_id then
      raise exception 'A folder sits in a folder of its own workspace.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      -- Walk up from the new parent: meeting this folder would make a loop.
      v_at := new.parent_id;
      while v_at is not null loop
        if v_at = new.id then
          raise exception 'A folder cannot sit inside itself.' using errcode = '23514';
        end if;
        v_depth := v_depth + 1;
        if v_depth > 64 then
          raise exception 'Folders nest at most 64 deep.' using errcode = '23514';
        end if;
        select f.parent_id into v_at from public.drive_folder f where f.id = v_at;
      end loop;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists drive_folder_before_write on public.drive_folder;
create trigger drive_folder_before_write
  before insert or update on public.drive_folder
  for each row execute function public.drive_folder_before_write();

-- ── B. Where a record sits ──────────────────────────────────────────────────

create table if not exists public.drive_folder_item (
  item_type text not null,
  item_id uuid not null,
  folder_id uuid not null references public.drive_folder(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  added_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (item_type, item_id),
  constraint drive_folder_item_type_check check (item_type in ('document', 'data_table', 'spreadsheet', 'canvas'))
);

create index if not exists drive_folder_item_folder_idx
  on public.drive_folder_item (folder_id);
create index if not exists drive_folder_item_workspace_idx
  on public.drive_folder_item (workspace_id);

-- Can the caller read this record, in this workspace? Under the caller's own
-- row security (not a definer), so a record they cannot open reads as absent.
create or replace function public.drive_folder_item_readable(p_type text, p_id uuid, p_workspace_id uuid)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_type = 'document' then
    return exists (select 1 from public.document d where d.id = p_id and d.workspace_id = p_workspace_id);
  elsif p_type = 'data_table' then
    return exists (select 1 from public.data_table t where t.id = p_id and t.workspace_id = p_workspace_id);
  elsif p_type = 'spreadsheet' then
    return exists (select 1 from public.spreadsheet s where s.id = p_id and s.workspace_id = p_workspace_id);
  elsif p_type = 'canvas' then
    return exists (select 1 from public.canvas c where c.id = p_id and c.workspace_id = p_workspace_id);
  end if;
  return false;
end;
$$;

revoke all on function public.drive_folder_item_readable(text, uuid, uuid) from public, anon;
grant execute on function public.drive_folder_item_readable(text, uuid, uuid) to authenticated, service_role;

create or replace function public.drive_folder_item_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
begin
  if tg_op = 'UPDATE' then
    if new.item_type is distinct from old.item_type or new.item_id is distinct from old.item_id then
      raise exception 'A filed record stays the same record; only its folder moves.' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  end if;

  -- Its workspace is its folder's, looked up under the caller's row security.
  select f.workspace_id into v_ws from public.drive_folder f where f.id = new.folder_id;
  if v_ws is null then
    raise exception 'No such folder.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and v_ws <> old.workspace_id then
    raise exception 'A record moves only between folders of its own workspace.' using errcode = '42501';
  end if;
  new.workspace_id := v_ws;

  if current_user in ('authenticated', 'anon') then
    if not public.drive_folder_item_readable(new.item_type, new.item_id, v_ws) then
      raise exception 'Only a record one can open is filed, in its own workspace.' using errcode = '42501';
    end if;
    new.added_by := public.current_member_id(v_ws);
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists drive_folder_item_before_write on public.drive_folder_item;
create trigger drive_folder_item_before_write
  before insert or update on public.drive_folder_item
  for each row execute function public.drive_folder_item_before_write();

-- ── C. Who reads and writes ─────────────────────────────────────────────────

alter table public.drive_folder enable row level security;
alter table public.drive_folder_item enable row level security;

drop policy if exists drive_folder_select on public.drive_folder;
create policy drive_folder_select on public.drive_folder
  for select to authenticated
  using (public.drive_folder_member(workspace_id));

drop policy if exists drive_folder_insert on public.drive_folder;
create policy drive_folder_insert on public.drive_folder
  for insert to authenticated
  with check (
    public.drive_folder_member(workspace_id)
    and created_by is not null
    and created_by = public.current_member_id(workspace_id)
  );

drop policy if exists drive_folder_update on public.drive_folder;
create policy drive_folder_update on public.drive_folder
  for update to authenticated
  using (public.drive_folder_member(workspace_id))
  with check (public.drive_folder_member(workspace_id));

drop policy if exists drive_folder_delete on public.drive_folder;
create policy drive_folder_delete on public.drive_folder
  for delete to authenticated
  using (
    public.drive_folder_member(workspace_id)
    and (
      created_by = public.current_member_id(workspace_id)
      or exists (
        select 1 from public.member m
         where m.workspace_id = drive_folder.workspace_id
           and m.user_id = (select auth.uid())
           and m.role in ('owner', 'admin')
      )
    )
  );

drop policy if exists drive_folder_item_select on public.drive_folder_item;
create policy drive_folder_item_select on public.drive_folder_item
  for select to authenticated
  using (public.drive_folder_member(workspace_id));

drop policy if exists drive_folder_item_insert on public.drive_folder_item;
create policy drive_folder_item_insert on public.drive_folder_item
  for insert to authenticated
  with check (public.drive_folder_member(workspace_id));

drop policy if exists drive_folder_item_update on public.drive_folder_item;
create policy drive_folder_item_update on public.drive_folder_item
  for update to authenticated
  using (public.drive_folder_member(workspace_id))
  with check (public.drive_folder_member(workspace_id));

drop policy if exists drive_folder_item_delete on public.drive_folder_item;
create policy drive_folder_item_delete on public.drive_folder_item
  for delete to authenticated
  using (public.drive_folder_member(workspace_id));

revoke all on public.drive_folder, public.drive_folder_item from anon;
grant select, insert, update, delete on public.drive_folder, public.drive_folder_item to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
